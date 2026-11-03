// Control Center reporter: watches chrome.storage and sends the run state (throttled), new log
// lines, new or changed documents and usage totals to the Control Center. A side channel only:
// errors here never touch the run; failed reports go to the bridge outbox and are retried.

import * as store from "./storage.js";
import { totalCost } from "./pricing.js";
import { getBridge, updateBridge, isConnected, post, enqueueOutbox } from "./bridge.js";
import { forWeb } from "./web-mode.js";

const STATE_THROTTLE_MS = 3000;
const USAGE_THROTTLE_MS = 10000;
const LOG_BATCH = 100;
const DOC_KEYS = ["specFiles", "handoffFiles", "designBriefs", "briefings", "categoryDocs"];
const RUN_ID_KEEP_MS = 7 * 24 * 3600 * 1000;
const FINAL = ["done", "stopped", "error"];

// ------------------------------------------------------------------ helpers

// One report at a time, in order (state before its log lines, and so on).
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
}

async function connected() {
  const b = await getBridge();
  return isConnected(b) ? b : null;
}

// POST a report; a transport failure or server_error goes to the outbox.
async function send(endpoint, body) {
  try {
    const res = await post(endpoint, body);
    if (res.ok === false && res.error === "server_error") await enqueueOutbox(endpoint, body);
    return res;
  } catch (e) {
    await enqueueOutbox(endpoint, body);
    return { ok: false, error: "transport", message: e.message };
  }
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "");
  } catch {
    return String(url || "");
  }
}

// ------------------------------------------------------------------ run state

// What the app gets as `state` (spec 7.1): the run without the log, notes, tab ids, build
// history (only its length), category digests and tribunal texts (those are documents).
export function trimState(a) {
  const ex = a.explore || {};
  const { tabId: _bt, history, ...build } = a.build || {};
  let category = null;
  if (a.category) {
    const { digests, tribunal, tabId: _ct, ...c } = a.category;
    category = {
      ...c,
      members: (c.members || []).map(({ explore, ...m }) => ({ ...m, screens: explore?.pages?.length || 0 })),
      digestsDone: Object.keys(digests || {}),
      tribunalParts: Object.keys(tribunal || {}),
    };
  }
  const state = {
    mode: a.mode || "site",
    status: a.status,
    phase: a.phase,
    siteUrl: a.siteUrl,
    startUrl: a.startUrl,
    startedAt: Number(a.startedAt),
    updatedAt: a.updatedAt || null,
    instructions: a.instructions || "",
    // The site shows these: say it's answered there, not in the side panel.
    message: a.message == null ? null : forWeb(a.message),
    pauseReason: forWeb(a.pauseReason) || null,
    buildOnly: !!a.buildOnly,
    scope: a.scope || null,
    explore: {
      pages: (ex.pages || []).map((p) => ({ url: p.url, name: p.name, type: p.type, specId: p.specId })),
      queue: (ex.queue || []).slice(0, 200),
      skipped: (ex.skipped || []).slice(-100),
      unsure: ex.unsure || [],
      awaitingLogin: ex.awaitingLogin || null,
    },
    qa: a.qa || null,
    designDone: a.designDone ?? null,
    build: { ...build, historyCount: (history || []).length },
    category,
    usageAtStart: a.usageAtStart || null,
    lessonsCount: a.lessonsCount ?? null,
  };
  if (a.overrides) state.overrides = a.overrides;
  return state;
}

function runIdFor(b, a) {
  const id = b.runIds?.[String(a.startedAt)];
  if (Number.isInteger(id)) return id;
  // A run started from the app: its id is known before its first report.
  if (Number.isInteger(b.pendingStartRunId) && a.startedAt >= (b.pendingStartAt || 0)) return b.pendingStartRunId;
  return null;
}

async function reportStateNow() {
  const b = await connected();
  if (!b) return;
  const a = await store.get("autopilot", null);
  if (!a?.startedAt) return;
  const state = trimState(a);
  state.lessonsCount = (await store.getLessons().catch(() => [])).length;
  let runId = runIdFor(b, a);
  let res = await send("bridge_report_state", { ...(runId ? { run_id: runId } : {}), state });
  if (res.ok === false && res.error === "run_not_found" && runId) {
    // The app no longer has that run: drop the mapping; the server matches (or creates) by startedAt.
    await updateBridge((x) => {
      delete x.runIds?.[String(a.startedAt)];
      if (x.pendingStartRunId === runId) x.pendingStartRunId = null;
    });
    runId = null;
    res = await send("bridge_report_state", { state });
  }
  if (res.ok && Number.isInteger(res.run_id)) {
    const now = Date.now();
    await updateBridge((x) => {
      x.runIds = Object.fromEntries(Object.entries(x.runIds || {}).filter(([k]) => now - Number(k) < RUN_ID_KEEP_MS));
      x.runIds[String(a.startedAt)] = res.run_id;
      if (x.pendingStartRunId === res.run_id) x.pendingStartRunId = null;
    });
    await reportLogNow(a, res.run_id);
  }
  lastSig = sigOf(a);
  lastStateAt = Date.now();
  if (FINAL.includes(a.status) && lastFinal !== a.startedAt) {
    lastFinal = a.startedAt;
    await reportUsageNow(); // a last usage report with the run's cost
  }
}

// Log lines are numbered when written (autopilot.js saveState → l.seq); send the ones not sent yet.
async function reportLogNow(a, runId) {
  const b = await getBridge();
  const key = String(a.startedAt);
  const sentUpTo = b.logSent?.[key] || 0;
  const lines = (a.log || []).filter((l) => typeof l.seq === "number" && l.seq > sentUpTo).sort((p, q) => p.seq - q.seq);
  for (let i = 0; i < lines.length; i += LOG_BATCH) {
    const batch = lines.slice(i, i + LOG_BATCH).map((l) => ({ seq: l.seq, t: Number(l.t) || Date.now(), msg: forWeb(String(l.msg ?? "")) }));
    const res = await send("bridge_report_log", { run_id: runId, lines: batch });
    if (res.ok === false && res.error !== "transport" && res.error !== "server_error") return; // run_not_found: the next state report re-links it
    const top = batch[batch.length - 1].seq;
    await updateBridge((x) => {
      x.logSent = Object.fromEntries(Object.entries(x.logSent || {}).filter(([k]) => Date.now() - Number(k) < RUN_ID_KEEP_MS));
      x.logSent[key] = Math.max(x.logSent[key] || 0, top);
    });
  }
}

// What makes a state change "important" (reported at once instead of throttled).
function sigOf(a) {
  if (!a) return "";
  const c = a.category || {};
  return JSON.stringify([a.startedAt, a.status, a.phase, a.pauseReason || null, a.qa?.questions?.length || 0, a.qa?.answeredAt || null, (c.sites || []).map((s) => [s.decision, s.url]), (c.members || []).map((m) => m.status), c.memberIndex, c.confirmIndex]);
}

let lastSig = "";
let lastStateAt = 0;
let lastFinal = null;
let stateTimer = null;

function scheduleState(a) {
  if (!a?.startedAt) return;
  if (sigOf(a) !== lastSig) {
    clearTimeout(stateTimer);
    stateTimer = null;
    serial(reportStateNow).catch(() => {});
    return;
  }
  if (stateTimer) return;
  const wait = Math.max(0, STATE_THROTTLE_MS - (Date.now() - lastStateAt));
  stateTimer = setTimeout(() => {
    stateTimer = null;
    serial(reportStateNow).catch(() => {});
  }, wait);
}

// ------------------------------------------------------------------ usage

async function reportUsageNow() {
  const b = await connected();
  if (!b) return;
  const u = await store.get("usage", null);
  if (!u) return;
  const cost = totalCost(u);
  const body = { totals: { input: Number(u.input) || 0, output: Number(u.output) || 0, calls: Number(u.calls) || 0, cost: Math.round(cost * 10000) / 10000 } };
  const a = await store.get("autopilot", null);
  const runId = a?.startedAt ? b.runIds?.[String(a.startedAt)] : null;
  if (Number.isInteger(runId)) body.run_cost = { run_id: runId, cost: Math.max(0, Math.round((cost - (a.usageAtStart?.cost || 0)) * 10000) / 10000) };
  lastUsageAt = Date.now();
  await send("bridge_report_usage", body);
}

let lastUsageAt = 0;
let usageTimer = null;
function scheduleUsage() {
  if (usageTimer) return;
  usageTimer = setTimeout(() => {
    usageTimer = null;
    serial(reportUsageNow).catch(() => {});
  }, Math.max(0, USAGE_THROTTLE_MS - (Date.now() - lastUsageAt)));
}

// ------------------------------------------------------------------ documents (spec 7.3)

function categoryName(key) {
  try {
    return new URL(key).hostname.replace(/\.category$/, "").replace(/-/g, " ");
  } catch {
    return "";
  }
}

export async function collectDocuments() {
  const got = await chrome.storage.local.get(DOC_KEYS);
  const docs = [];
  for (const s of got.specFiles || []) {
    if (!s?.content) continue;
    docs.push({ site_key: s.categoryKey || s.siteUrl, kind: "spec", external_id: String(s.id), title: s.pageTitle || pathOf(s.pageUrl) || "Screen spec", subtitle: pathOf(s.pageUrl), step_number: null, content: s.content, source_updated_at: s.capturedAt || s.createdAt });
  }
  for (const f of got.handoffFiles || []) {
    if (!f?.content) continue;
    const base = { site_key: f.siteUrl, external_id: String(f.id), content: f.content, source_updated_at: f.createdAt };
    if (f.fileType === "step") docs.push({ ...base, kind: "step", title: f.title || `Step ${f.stepNumber}`, subtitle: `Step ${f.stepNumber}`, step_number: Number(f.stepNumber) || 0 });
    else if (f.fileType === "manifest") docs.push({ ...base, kind: "manifest", title: f.title || "Build manifest", subtitle: f.summary || f.appName || "", step_number: null });
    else docs.push({ ...base, kind: "step", title: f.title || "All steps", subtitle: "Combined", step_number: 0 });
  }
  for (const [siteUrl, d] of Object.entries(got.designBriefs || {})) {
    if (!d?.content) continue;
    docs.push({ site_key: siteUrl, kind: "design_concept", external_id: "design", title: "Design concept", subtitle: d.concept || "", step_number: null, content: d.content, source_updated_at: d.createdAt });
  }
  for (const br of got.briefings || []) {
    if (!br?.content) continue;
    const when = br.finishedAt || br.createdAt;
    docs.push({ site_key: br.siteUrl, kind: "briefing", external_id: String(br.id), title: "Research briefing", subtitle: `${br.status || ""}${when ? ` · ${new Date(when).toLocaleDateString()}` : ""}`, step_number: null, content: br.content, source_updated_at: when ? new Date(when).toISOString() : "" });
  }
  for (const [key, list] of Object.entries(got.categoryDocs || {})) {
    for (const d of list || []) {
      if (!d?.content || !d.title) continue;
      const t = d.title;
      const digest = t.match(/^Digest — (.+)/);
      const kind = /your request/i.test(t) ? "request" : digest ? "digest" : /blueprint/i.test(t) ? "blueprint" : "tribunal";
      docs.push({ site_key: key, kind, external_id: t, title: t, subtitle: kind === "request" ? categoryName(key) : digest ? digest[1] : "", step_number: null, content: d.content, source_updated_at: d.savedAt });
    }
  }
  return docs.filter((d) => d.site_key);
}

const docKey = (d) => `${d.site_key}|${d.kind}|${d.external_id}`;

// Sends new/changed documents (all of them when force). Returns how many were sent.
async function reportDocsNow({ force = false } = {}) {
  const b = await connected();
  if (!b) return 0;
  const a = await store.get("autopilot", null);
  const runId = a?.startedAt ? runIdFor(b, a) : null;
  let n = 0;
  for (const d of await collectDocuments()) {
    const k = docKey(d);
    const h = await sha(`${d.title}\n${d.subtitle || ""}\n${d.content}`);
    if (!force && (await getBridge()).docHashes?.[k] === h) continue;
    const ts = new Date(d.source_updated_at || Date.now());
    const body = { ...d, source_updated_at: isNaN(ts) ? new Date().toISOString() : ts.toISOString(), ...(runId && a.siteUrl === d.site_key ? { run_id: runId } : {}) };
    const res = await send("bridge_report_document", body);
    if (res.ok === false && res.error === "unauthorised") return n;
    // Sent, or queued in the outbox for a retry: either way it's on its way.
    await updateBridge((x) => {
      x.docHashes = { ...(x.docHashes || {}), [k]: h };
    });
    n++;
  }
  return n;
}

let docsTimer = null;
function scheduleDocs() {
  clearTimeout(docsTimer);
  docsTimer = setTimeout(() => serial(() => reportDocsNow()).catch(() => {}), 1500);
}

// ------------------------------------------------------------------ public

export function init() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes.bridge) return; // our own bookkeeping
    getBridge().then((b) => {
      if (!isConnected(b)) return;
      if (changes.autopilot) scheduleState(changes.autopilot.newValue);
      if (changes.usage) scheduleUsage();
      if (DOC_KEYS.some((k) => changes[k])) scheduleDocs();
    });
  });
}

// Report the current state (and its new log lines) straight away, e.g. after a command.
export function flushNow() {
  clearTimeout(stateTimer);
  stateTimer = null;
  return serial(reportStateNow);
}

// After connecting / a restart: the current run, documents not sent yet, and usage.
export function reportAllSoon() {
  serial(async () => {
    await reportStateNow();
    await reportDocsNow();
    await reportUsageNow();
  }).catch(() => {});
}

// The app's "Sync now": state, every document (ignoring fingerprints) and usage.
export function syncAll() {
  return serial(async () => {
    await reportStateNow();
    const documents = await reportDocsNow({ force: true });
    await reportUsageNow();
    return { documents };
  });
}
