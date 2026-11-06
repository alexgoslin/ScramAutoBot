// Control Center bridge: connects this extension to the RoboBuild Control Center web app
// (built in Scram). The app never talks to the browser: it queues commands; this module polls
// for them every 5 s, runs them through the extension's own message handlers (exactly as the
// side panel does), and reports run state, log lines, documents and usage back.
// Opt-in: nothing here runs until the user connects in Settings → Control Center.
// Spec: CONTROL_CENTER_INTEGRATION.md (the app as built).

import * as store from "./storage.js";
import { runCommand, setHandlers } from "./bridge-commands.js";
import * as reporter from "./bridge-reporter.js";
import { resumePending as resumeAsks } from "./ask-autopilot.js";

// Two Control Centers with separate databases (CONTROL_CENTER_LIVE_SITE_UPDATE.md). The endpoints
// are NOT on the custom domain: the website is robobuild.builtonscram.com, the bridge is on scramapps.com.
export const ENVS = {
  live: { label: "Live", baseUrl: "https://brownmoina242.scramapps.com/api/dataSource/oAC_003FG/", siteBase: "https://robobuild.builtonscram.com" },
  dev: { label: "Dev", baseUrl: "https://z07w3d61njwbx5lbgc5gzqk2.dev.scramapps.com/api/dataSource/oAC_003FG/", siteBase: "" },
};
export const DEFAULT_BASE_URL = ENVS.live.baseUrl;
// "bridge" holds the ACTIVE environment's record (everything else reads it); the other
// environment's record waits in "bridgeEnvs" until you switch. Nothing is shared between them:
// connection ID, token, run ids, log/document bookkeeping, handled commands and the outbox.
const KEY = "bridge";
const ENV_KEY = "bridgeEnv";
const ENVS_KEY = "bridgeEnvs";
const POLL_MS = 5000;
// Right after any activity from the site (a command or a chat message), check every second for a
// minute: follow-ups (Resume after Pause, a pause choice, the next question) are picked up at once.
const BURST_MS = 1000;
const BURST_FOR_MS = 60000;
let burstUntil = 0;
const IDLE_POLLS = 5; // after an alarm wakes the worker while idle: ~25 s of polling
const ALARM = "bridge-poll";
const HANDLED_KEEP = 200;
const OUTBOX_MAX = 300;

// ------------------------------------------------------------------ config + state

function freshRecord(env) {
  const e = ENVS[env] || ENVS.live;
  return {
    env,
    enabled: false,
    baseUrl: e.baseUrl,
    siteBase: e.siteBase,
    computerId: null,
    token: "",
    status: "disconnected",
    statusMessage: env === "live" ? "Not connected to the live Control Center — paste your connection from robobuild.builtonscram.com → Extension" : "Not connected to the dev Control Center",
    runIds: {},
    pendingStartRunId: null,
    pendingStartAt: 0,
    logSent: {},
    docHashes: {},
    handledCommands: {},
    outbox: [],
  };
}

export async function getBridge() {
  const { [KEY]: rec, [ENV_KEY]: env = "live" } = await chrome.storage.local.get([KEY, ENV_KEY]);
  return { ...freshRecord(env), ...(rec || {}), env };
}

// Serialised read-modify-write of the bridge record (the poller and the reporter both write it).
let queue = Promise.resolve();
export function updateBridge(fn) {
  const next = queue.then(async () => {
    const b = await getBridge();
    const out = (await fn(b)) ?? b;
    await store.set(KEY, out);
    return out;
  });
  queue = next.catch(() => {});
  return next;
}

export const isConnected = (b) => !!(b.enabled && b.token && Number.isFinite(Number(b.computerId)));

// ------------------------------------------------------------------ transport

// POST one endpoint. Returns the JSON reply ({ok, …}); throws only on transport failure
// (network error, non-2xx, invalid JSON). Workflow failures come back as 200 + {ok:false}.
export async function post(endpoint, body, b = null) {
  b ||= await getBridge();
  const res = await fetch(`${b.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({ computer_id: Number(b.computerId), token: b.token, ...body }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("the Control Center's reply wasn't valid JSON");
  }
  // (While connecting, connect() reports the refusal itself.)
  if (json && json.ok === false && json.error === "unauthorised" && b.status !== "connecting" && (await getBridge()).baseUrl === b.baseUrl) await disconnect(rePairMessage(b.env), "error");
  return json || {};
}

export function rePairMessage(env) {
  return env === "dev"
    ? "Disconnected — re-pair in the dev Control Center → Extension, then paste it in Settings → Control Center."
    : "Disconnected — re-pair at robobuild.builtonscram.com → Extension, then paste it in Settings → Control Center.";
}

// A report that failed in transport goes to the outbox and is retried on the next poll tick.
export async function enqueueOutbox(endpoint, body) {
  await updateBridge((b) => {
    b.outbox ||= [];
    // Only the latest state per run matters: collapse older state reports for the same run.
    if (endpoint === "bridge_report_state") {
      const key = body.state?.startedAt;
      b.outbox = b.outbox.filter((x) => !(x.endpoint === endpoint && x.body.state?.startedAt === key));
    }
    b.outbox.push({ endpoint, body, tries: 0, at: Date.now() });
    b.outbox = b.outbox.slice(-OUTBOX_MAX);
  });
}

const BACKOFF = [5000, 10000, 30000, 60000];
async function flushOutbox() {
  const b = await getBridge();
  if (!b.outbox?.length) return;
  const now = Date.now();
  const keep = [];
  for (const item of b.outbox) {
    if (now - item.at < BACKOFF[Math.min(item.tries, BACKOFF.length - 1)] * (item.tries ? 1 : 0)) {
      keep.push(item);
      continue;
    }
    if (item.tries >= 8) continue; // gave up: don't retry forever
    try {
      const res = await post(item.endpoint, item.body);
      if (res.ok === false && res.error === "server_error") keep.push({ ...item, tries: item.tries + 1, at: now });
      else if (res.ok === false && res.error === "run_not_found" && item.endpoint === "bridge_report_state") {
        const { run_id, ...rest } = item.body; // retry without the stale run id: the server matches by startedAt
        keep.push({ endpoint: item.endpoint, body: rest, tries: 0, at: now });
      }
    } catch {
      keep.push({ ...item, tries: item.tries + 1, at: now });
    }
  }
  await updateBridge((x) => {
    // Items added while flushing stay; the ones just handled are replaced by what's left.
    const added = (x.outbox || []).filter((o) => !b.outbox.includes(o) && !b.outbox.some((p) => p.at === o.at && p.endpoint === o.endpoint));
    x.outbox = [...keep, ...added].slice(-OUTBOX_MAX);
  });
}

// ------------------------------------------------------------------ connect / disconnect

export async function connect({ baseUrl, computerId, token, siteBase }) {
  baseUrl = String(baseUrl || (await getBridge()).baseUrl || DEFAULT_BASE_URL).trim();
  // https only (plain http just for a Control Center running on this computer, for testing).
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(baseUrl)) throw new Error("The Base URL must start with https://");
  if (!baseUrl.endsWith("/")) baseUrl += "/";
  const id = Number(computerId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("The Connection ID must be a whole number (it's shown with the token in the Control Center).");
  token = String(token || "").trim();
  if (token.length < 16) throw new Error("Paste the pairing token from the Control Center (Extension page → Connect extension).");
  const site = siteBase === undefined ? undefined : cleanSite(siteBase);
  const b = await updateBridge((x) => ({ ...x, enabled: true, baseUrl, computerId: id, token, ...(site !== undefined ? { siteBase: site } : {}), status: "connecting", statusMessage: "Connecting…" }));
  let res;
  try {
    res = await post("bridge_poll", { extension_version: chrome.runtime.getManifest().version, anthropic_key_set: await keySet() }, b);
  } catch (e) {
    await updateBridge((x) => ({ ...x, status: "error", statusMessage: `Couldn't reach the Control Center: ${e.message}` }));
    throw new Error(`Couldn't reach the Control Center: ${e.message}`);
  }
  if (res.ok === false) {
    const where = b.env === "dev" ? "the dev Control Center" : "robobuild.builtonscram.com";
    const msg = res.error === "unauthorised" ? `That Connection ID and token don't match ${b.env === "dev" ? "the Dev" : "the Live"} Control Center — create a new connection at ${where} → Extension and paste it again.` : `The Control Center answered: ${res.error}`;
    await updateBridge((x) => ({ ...x, enabled: res.error !== "unauthorised", ...(res.error === "unauthorised" ? { token: "" } : {}), status: "error", statusMessage: msg }));
    throw new Error(msg);
  }
  await updateBridge((x) => ({ ...x, status: "connected", statusMessage: `Connected ✓ — last check ${new Date().toLocaleTimeString()}`, lastPollAt: Date.now() }));
  if (!(await getBridge()).docsBaselined) await reporter.baselineDocs();
  // Commands that came with this first poll are handled by the regular loop: don't lose them.
  if (Array.isArray(res.commands) && res.commands.length) {
    burstUntil = Date.now() + BURST_FOR_MS;
    await handleCommands(res.commands, b);
    burstUntil = Date.now() + BURST_FOR_MS; // from the end of a long command, too
  }
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  kick();
  reporter.reportAllSoon(); // send the current run (if any) and the documents
  return { ok: true, commands: res.commands?.length || 0 };
}

export async function disconnect(message = "Disconnected", status = "disconnected") {
  await updateBridge((x) => ({ ...x, enabled: false, token: "", status, statusMessage: message }));
  await chrome.alarms.clear(ALARM).catch(() => {});
}

// Whether an Anthropic API key is saved — only true/false is ever sent, never the key or any part of it.
async function keySet() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

// ------------------------------------------------------------------ the poller

let looping = false;
let idleLeft = 0;

// Start (or extend) the poll loop. While a run is active it polls every 5 s; while idle it polls
// a few times after each wake-up (the alarm wakes the worker every 30 s).
let wake = null; // cuts the loop's 5-second wait short
export function kick(now = false) {
  idleLeft = IDLE_POLLS;
  if (!looping) loop();
  else if (now && wake) wake(); // poll right away (e.g. the API key was just saved or cleared)
}

// Poll every 5 s while a run is going, paused, waiting or in error, and for 15 minutes after any
// chat activity (so Ask Autopilot answers quickly); otherwise the 30-second alarm keeps checking.
async function runActive() {
  if (Date.now() < burstUntil) return true;
  const a = await store.get("autopilot", null);
  if (a && ["running", "waiting", "paused", "error"].includes(a.status)) return true;
  const b = await getBridge();
  return Date.now() - (b.lastChatAt || 0) < 15 * 60000;
}

async function loop() {
  looping = true;
  try {
    for (;;) {
      const b = await getBridge();
      if (!isConnected(b)) break;
      await pollOnce(b).catch((e) => updateBridge((x) => ({ ...x, statusMessage: `Last check failed (${e.message}) — retrying` })));
      await flushOutbox().catch(() => {});
      if (!(await runActive()) && --idleLeft <= 0) break;
      await new Promise((r) => {
        wake = r;
        setTimeout(r, Date.now() < burstUntil ? BURST_MS : POLL_MS);
      });
      wake = null;
    }
  } finally {
    looping = false;
  }
}

async function pollOnce(b) {
  const a = await store.get("autopilot", null);
  const res = await post("bridge_poll", { extension_version: chrome.runtime.getManifest().version, anthropic_key_set: await keySet(), ...(a?.startedAt ? { active_run: { extension_started_at: a.startedAt, status: a.status, phase: a.phase } } : {}) }, b);
  if (res.ok === false) return;
  await updateBridge((x) => (x.env === b.env ? { ...x, status: "connected", lastPollAt: Date.now(), statusMessage: `Connected ✓ — last check ${new Date().toLocaleTimeString()}` } : x));
  if (Array.isArray(res.commands) && res.commands.length) {
    burstUntil = Date.now() + BURST_FOR_MS;
    await handleCommands(res.commands, b);
    burstUntil = Date.now() + BURST_FOR_MS; // from the end of a long command, too
  }
}

// Run each command once, in order. The result is stored BEFORE it's posted, so a crash can't
// run a command twice; a command id seen again only gets its stored result re-sent.
async function handleCommands(commands, from) {
  for (const cmd of commands) {
    const seen = (await getBridge()).handledCommands?.[cmd.id];
    let result = seen?.result;
    if (!result) {
      result = await runCommand(cmd).catch((e) => ({ ok: false, error: e.message || String(e) }));
      await updateBridge((x) => {
        x.handledCommands ||= {};
        x.handledCommands[cmd.id] = { result, at: Date.now() };
        const ids = Object.keys(x.handledCommands);
        if (ids.length > HANDLED_KEEP) for (const id of ids.sort((p, q) => x.handledCommands[p].at - x.handledCommands[q].at).slice(0, ids.length - HANDLED_KEEP)) delete x.handledCommands[id];
      });
    }
    const body = { command_id: Number(cmd.id), ok: !!result.ok, ...(result.data !== undefined ? { data: result.data } : {}), ...(result.result !== undefined ? { result: result.result } : {}), ...(result.ok ? {} : { error: result.error || "Failed" }) };
    try {
      const r = await post("bridge_command_result", body, from);
      if (r.ok === false && r.error === "server_error") await enqueueOutbox("bridge_command_result", body);
    } catch {
      await enqueueOutbox("bridge_command_result", body);
    }
    await reporter.flushNow().catch(() => {}); // the run changed: report it straight away
  }
}

// ------------------------------------------------------------------ wiring (called from background.js)

export function init(handlers) {
  setHandlers(handlers);
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM) kick();
    if (a.name === "settings-daily") reporter.scheduleSettings(0); // once a day, as well as on every change
  });
  chrome.alarms.create("settings-daily", { periodInMinutes: 1440 });
  chrome.runtime.onStartup?.addListener(() => kick());
  // Key saved or cleared in Settings: tell the Control Center straight away (next poll, now).
  chrome.storage.onChanged.addListener((changes, area) => area === "local" && changes.apiKey && kick(true));
  reporter.init();
  migrate().then(getBridge).then(async (b) => {
    if (!isConnected(b)) return;
    resumeAsks().catch(() => {}); // questions that were being answered when the worker stopped
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    kick();
    reporter.reportAllSoon();
  });
}

export async function status() {
  const b = await getBridge();
  const { [ENVS_KEY]: envs = {} } = await chrome.storage.local.get(ENVS_KEY);
  const other = Object.fromEntries(Object.entries(envs).map(([k, r]) => [k, { connected: isConnected(r), computerId: r.computerId || null }]));
  return { env: b.env, envs: other, enabled: b.enabled, baseUrl: b.baseUrl, siteBase: b.siteBase || "", computerId: b.computerId, connected: isConnected(b), status: b.status, statusMessage: b.statusMessage, lastPollAt: b.lastPollAt || null, outbox: b.outbox?.length || 0, tokenHint: b.token ? `…${b.token.slice(-4)}` : "", docsUploadedAt: b.docsUploadedAt || null, uploadOffered: !!b.uploadOffered };
}

// ------------------------------------------------------------------ environments

function cleanSite(v) {
  v = String(v || "").trim().replace(/\/+$/, "");
  if (v && !/^https:\/\//i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(v)) throw new Error("The website address must start with https://");
  return v;
}

// Switch between Live and Dev: the current record is put away and the other one comes back,
// untouched. Polling and reporting carry on with whichever is active.
export async function switchEnv(env) {
  if (!ENVS[env]) throw new Error("Unknown environment.");
  // One write for the name and both records, inside the same queue as every other bridge write,
  // so nothing ever sees one environment's name with the other's credentials.
  const step = queue.then(async () => {
    const cur = await getBridge();
    if (cur.env === env) return cur;
    const { [ENVS_KEY]: envs = {} } = await chrome.storage.local.get(ENVS_KEY);
    envs[cur.env] = cur;
    const next = { ...freshRecord(env), ...(envs[env] || {}), env };
    delete envs[env];
    await chrome.storage.local.set({ [ENVS_KEY]: envs, [ENV_KEY]: env, [KEY]: next });
    return next;
  });
  queue = step.catch(() => {});
  const out = await step;
  if (isConnected(out)) {
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    kick();
    reporter.reportAllSoon();
  } else await chrome.alarms.clear(ALARM).catch(() => {});
  return status();
}

// A page of the Control Center website for the active environment: "run" = the current run's page
// (siteBase/runs/<id>) when known, else the Runs list; "extension" = its Extension page. Dev has
// no fixed website address (it changes with every build): then the Scram editor.
export const DEV_EDITOR_URL = "https://editor.buildwithscram.com/branch/z07w3d61njwbx5lbgc5gzqk2/";
export async function siteUrl(page = "run") {
  const b = await getBridge();
  const base = (b.siteBase || ENVS[b.env]?.siteBase || "").replace(/\/+$/, "");
  if (!base) return DEV_EDITOR_URL;
  if (page === "extension") return `${base}/extension`;
  const a = await store.get("autopilot", null);
  const id = a?.startedAt ? b.runIds?.[String(a.startedAt)] : null;
  return Number.isInteger(id) ? `${base}/runs/${id}` : `${base}/`;
}

// The website address for this environment (Advanced): what "Open Control Center" opens.
export async function setSiteBase(siteBase) {
  const v = cleanSite(siteBase);
  await updateBridge((x) => ({ ...x, siteBase: v || ENVS[x.env]?.siteBase || "" }));
  return status();
}

export async function markUploadOffered(uploaded) {
  await updateBridge((x) => ({ ...x, uploadOffered: true, ...(uploaded ? { docsUploadedAt: Date.now() } : {}) }));
}

// Once: before environments existed there was one (dev) connection. It becomes "dev"; Live is
// the default from now on and starts empty.
async function migrate() {
  const got = await chrome.storage.local.get([KEY, ENV_KEY, ENVS_KEY, "ccAppUrl"]);
  if (got[ENV_KEY]) return;
  const old = got[KEY];
  const envs = got[ENVS_KEY] || {};
  if (old && (old.token || old.computerId || old.baseUrl)) {
    const isLive = old.baseUrl === ENVS.live.baseUrl;
    // It has been sending documents already: no upload offer, keep its fingerprints.
    const rec = { ...freshRecord(isLive ? "live" : "dev"), ...old, env: isLive ? "live" : "dev", docsBaselined: true, uploadOffered: true };
    if (!isLive && got.ccAppUrl && !rec.siteBase && !/editor\.buildwithscram\.com/.test(got.ccAppUrl)) rec.siteBase = got.ccAppUrl.replace(/\/+$/, "");
    if (isLive) {
      await chrome.storage.local.set({ [ENV_KEY]: "live", [KEY]: rec });
      return;
    }
    envs.dev = rec;
  }
  await chrome.storage.local.set({ [ENV_KEY]: "live", [ENVS_KEY]: envs, [KEY]: freshRecord("live") });
  if (old?.enabled) await chrome.alarms.clear(ALARM).catch(() => {});
}
