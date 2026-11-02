// Control Center bridge: connects this extension to the ScramAutoBuild Control Center web app
// (built in Scram). The app never talks to the browser: it queues commands; this module polls
// for them every 5 s, runs them through the extension's own message handlers (exactly as the
// side panel does), and reports run state, log lines, documents and usage back.
// Opt-in: nothing here runs until the user connects in Settings → Control Center.
// Spec: CONTROL_CENTER_INTEGRATION.md (the app as built).

import * as store from "./storage.js";
import { runCommand, setHandlers } from "./bridge-commands.js";
import * as reporter from "./bridge-reporter.js";

export const DEFAULT_BASE_URL = "https://z07w3d61njwbx5lbgc5gzqk2.dev.scramapps.com/api/dataSource/oAC_003FG/";
const KEY = "bridge";
const POLL_MS = 5000;
const IDLE_POLLS = 5; // after an alarm wakes the worker while idle: ~25 s of polling
const ALARM = "bridge-poll";
const HANDLED_KEEP = 200;
const OUTBOX_MAX = 300;

// ------------------------------------------------------------------ config + state

export async function getBridge() {
  return { enabled: false, baseUrl: DEFAULT_BASE_URL, computerId: null, token: "", status: "disconnected", statusMessage: "Not connected", runIds: {}, pendingStartRunId: null, pendingStartAt: 0, logSent: {}, docHashes: {}, handledCommands: {}, outbox: [], ...(await store.get(KEY, {})) };
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
  if (json && json.ok === false && json.error === "unauthorised" && b.status !== "connecting") await disconnect("Disconnected — that connection ID and token aren't accepted any more. Re-pair in Settings → Control Center.", "error");
  return json || {};
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

export async function connect({ baseUrl, computerId, token }) {
  baseUrl = String(baseUrl || DEFAULT_BASE_URL).trim();
  // https only (plain http just for a Control Center running on this computer, for testing).
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(baseUrl)) throw new Error("The Base URL must start with https://");
  if (!baseUrl.endsWith("/")) baseUrl += "/";
  const id = Number(computerId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("The Connection ID must be a whole number (it's shown with the token in the Control Center).");
  token = String(token || "").trim();
  if (token.length < 16) throw new Error("Paste the pairing token from the Control Center (Extension page → Connect extension).");
  const b = await updateBridge((x) => ({ ...x, enabled: true, baseUrl, computerId: id, token, status: "connecting", statusMessage: "Connecting…" }));
  let res;
  try {
    res = await post("bridge_poll", { extension_version: chrome.runtime.getManifest().version }, b);
  } catch (e) {
    await updateBridge((x) => ({ ...x, status: "error", statusMessage: `Couldn't reach the Control Center: ${e.message}` }));
    throw new Error(`Couldn't reach the Control Center: ${e.message}`);
  }
  if (res.ok === false) {
    const msg = res.error === "unauthorised" ? "That Connection ID and token don't match — create a new connection in the Control Center (Extension page) and paste it again." : `The Control Center answered: ${res.error}`;
    await updateBridge((x) => ({ ...x, enabled: res.error !== "unauthorised", ...(res.error === "unauthorised" ? { token: "" } : {}), status: "error", statusMessage: msg }));
    throw new Error(msg);
  }
  await updateBridge((x) => ({ ...x, status: "connected", statusMessage: `Connected ✓ — last check ${new Date().toLocaleTimeString()}`, lastPollAt: Date.now() }));
  // Commands that came with this first poll are handled by the regular loop: don't lose them.
  if (Array.isArray(res.commands) && res.commands.length) await handleCommands(res.commands);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  kick();
  reporter.reportAllSoon(); // send the current run (if any) and the documents
  return { ok: true, commands: res.commands?.length || 0 };
}

export async function disconnect(message = "Disconnected", status = "disconnected") {
  await updateBridge((x) => ({ ...x, enabled: false, token: "", status, statusMessage: message }));
  await chrome.alarms.clear(ALARM).catch(() => {});
}

// ------------------------------------------------------------------ the poller

let looping = false;
let idleLeft = 0;

// Start (or extend) the poll loop. While a run is active it polls every 5 s; while idle it polls
// a few times after each wake-up (the alarm wakes the worker every 30 s).
export function kick() {
  idleLeft = IDLE_POLLS;
  if (!looping) loop();
}

async function runActive() {
  const a = await store.get("autopilot", null);
  return !!a && ["running", "waiting", "paused"].includes(a.status);
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
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    looping = false;
  }
}

async function pollOnce(b) {
  const a = await store.get("autopilot", null);
  const res = await post("bridge_poll", { extension_version: chrome.runtime.getManifest().version, ...(a?.startedAt ? { active_run: { extension_started_at: a.startedAt, status: a.status, phase: a.phase } } : {}) }, b);
  if (res.ok === false) return;
  await updateBridge((x) => ({ ...x, status: "connected", lastPollAt: Date.now(), statusMessage: `Connected ✓ — last check ${new Date().toLocaleTimeString()}` }));
  if (Array.isArray(res.commands) && res.commands.length) await handleCommands(res.commands);
}

// Run each command once, in order. The result is stored BEFORE it's posted, so a crash can't
// run a command twice; a command id seen again only gets its stored result re-sent.
async function handleCommands(commands) {
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
    const body = { command_id: Number(cmd.id), ok: !!result.ok, ...(result.data !== undefined ? { data: result.data } : {}), ...(result.ok ? {} : { error: result.error || "Failed" }) };
    try {
      const r = await post("bridge_command_result", body);
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
  chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && kick());
  chrome.runtime.onStartup?.addListener(() => kick());
  reporter.init();
  getBridge().then(async (b) => {
    if (!isConnected(b)) return;
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    kick();
    reporter.reportAllSoon();
  });
}

export async function status() {
  const b = await getBridge();
  return { enabled: b.enabled, baseUrl: b.baseUrl, computerId: b.computerId, connected: isConnected(b), status: b.status, statusMessage: b.statusMessage, lastPollAt: b.lastPollAt || null, outbox: b.outbox?.length || 0, tokenHint: b.token ? `…${b.token.slice(-4)}` : "" };
}
