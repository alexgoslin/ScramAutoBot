// Control Center command adapter: maps the app's command types onto the extension's own message
// handlers (the same functions the side panel reaches), so behaviour is identical. Payloads are
// untrusted input: validated, clamped and truncated here. Every result is {ok, data} or {ok:false, error}.

import * as store from "./storage.js";
import { openWorkTab, closeWorkTab } from "./work-window.js";
import * as autopilot from "./autopilot.js";
import { updateBridge } from "./bridge.js";
import * as reporter from "./bridge-reporter.js";

let handlers = {};
export function setHandlers(h) {
  handlers = h || {};
}

async function call(type, msg = {}) {
  const h = handlers[type];
  if (!h) throw new Error(`Unknown command: ${type}`);
  return h({ type, ...msg }, { id: chrome.runtime.id, bridge: true });
}

const str = (v, max = 4000) => String(v ?? "").trim().slice(0, max);
const isHttp = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

async function activeRun() {
  const a = await store.get("autopilot", null);
  return a && ["running", "waiting", "paused"].includes(a.status) ? a : null;
}

// Opens the URL in a new tab (in RoboBuild's own window) and waits until it has loaded,
// redirects included. Checks the tab every 250 ms rather than relying on catching the load event
// (a brand-new window can finish loading before a listener is in place).
async function openAndWait(url, timeoutMs = 45000) {
  const tab = await openWorkTab(url);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (!t) throw new Error("The page's tab was closed before it finished loading.");
    if (t.status === "complete" && /^https?:/.test(t.url || "")) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  await closeWorkTab(tab.id);
  throw new Error("The page didn't finish loading.");
}

// A start command: remember the app's run id until the new run's startedAt is known.
async function startRun(cmd, startFn) {
  await updateBridge((b) => ({ ...b, pendingStartRunId: Number.isInteger(cmd.run_id) ? cmd.run_id : null, pendingStartAt: Date.now() }));
  let state;
  try {
    state = await startFn();
  } catch (e) {
    await updateBridge((b) => ({ ...b, pendingStartRunId: null }));
    throw e;
  }
  const startedAt = Number(state?.startedAt) || (await store.get("autopilot", null))?.startedAt;
  if (!Number.isFinite(startedAt)) throw new Error("The run started but has no start time.");
  if (Number.isInteger(cmd.run_id)) await updateBridge((b) => ({ ...b, runIds: { ...(b.runIds || {}), [String(startedAt)]: cmd.run_id }, pendingStartRunId: null }));
  return { startedAt };
}

const COMMANDS = {
  async autopilotStartUrl(p, cmd) {
    const url = str(p.url, 2000);
    if (!isHttp(url)) throw new Error("That address isn't a web page (it must start with http:// or https://).");
    if (await activeRun()) throw new Error("A run is already active — stop it first.");
    const overrides = autopilot.overridesFrom(p.options || {});
    return startRun(cmd, async () => {
      const tab = await openAndWait(url);
      try {
        return await autopilot.start({ tabId: tab.id, instructions: str(p.instructions), overrides });
      } finally {
        // Autopilot crawls in its own exploration tab; this one only resolved the address (and redirects).
        closeWorkTab(tab.id);
      }
    });
  },
  categoryStart: (p, cmd) =>
    startRun(cmd, () => call("categoryStart", { name: str(p.name, 200), instructions: str(p.instructions), siteCount: Math.max(2, Math.min(8, Math.round(Number(p.siteCount)) || 4)) })),
  autopilotBuildFrom: (p, cmd) => startRun(cmd, () => call("autopilotBuildFrom", { siteUrl: str(p.siteUrl, 2000), instructions: str(p.instructions) })),
  autopilotPause: () => call("autopilotPause"),
  autopilotResume: () => call("autopilotResume"),
  autopilotStop: () => call("autopilotStop"),
  async autopilotReset() {
    // The app should see the run end: report a final "stopped" state before it's cleared.
    await call("autopilotStop");
    await reporter.flushNow().catch(() => {});
    return call("autopilotReset");
  },
  autopilotNote: (p) => call("autopilotNote", { text: str(p.text, 2000) }),
  autopilotAnswer: (p) => {
    const answers = {};
    for (const [k, v] of Object.entries(p.answers && typeof p.answers === "object" ? p.answers : {})) answers[str(k, 40)] = str(v, 2000);
    return call("autopilotAnswer", { answers });
  },
  categoryDecide: (p) => {
    const index = Number(p.index);
    if (!Number.isInteger(index) || index < 0) throw new Error("That site isn't in the list.");
    const url = p.url ? str(p.url, 2000) : "";
    if (url && !isHttp(url) && !isHttp(`https://${url}`)) throw new Error("That address isn't a web page.");
    return call("categoryDecide", { index, accept: !!p.accept, url });
  },
  categoryLoggedIn: () => call("categoryLoggedIn"),
  categorySkipSite: () => call("categorySkipSite"),
  generateHandoff: (p) => call("generateHandoff", { siteUrl: str(p.siteUrl, 2000) }).then(() => ({ ok: true })),
  categoryRetribunal: (p) => call("categoryRetribunal", { siteUrl: str(p.siteUrl, 2000) }).then(() => ({ ok: true })),
  wipeSite: (p) => call("wipeSite", { siteUrl: str(p.siteUrl, 2000) }).then(() => ({ ok: true })),
  wipeAllSites: () => call("wipeAllSites").then(() => ({ ok: true })),
  syncAll: () => reporter.syncAll(),
};

// Long jobs (handoff, tribunal) shouldn't block the poller: they run in the background and the
// command reports "started"; their documents arrive through the reporter when they're written.
const BACKGROUND = new Set(["generateHandoff", "categoryRetribunal"]);

export async function runCommand(cmd) {
  const type = String(cmd?.type || "");
  const fn = Object.hasOwn(COMMANDS, type) ? COMMANDS[type] : null;
  if (!fn) return { ok: false, error: `Unknown command: ${type || "(none)"}` };
  const payload = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};
  try {
    if (BACKGROUND.has(type)) {
      fn(payload, cmd).catch((e) => console.warn("Control Center command", type, e));
      return { ok: true, data: { started: true } };
    }
    const data = await fn(payload, cmd);
    return { ok: true, data: data && typeof data === "object" ? JSON.parse(JSON.stringify(data)) : data ?? null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
