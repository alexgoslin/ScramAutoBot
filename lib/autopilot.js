// Autopilot: explore a site → write specs → generate handoff → build it in Scram,
// with no clicks from the user. State lives in chrome.storage ("autopilot") so the
// run survives service-worker restarts; an alarm resumes it if the worker was killed.

import * as store from "./storage.js";
import { generateHandoff } from "./jobs.js";
import * as explorer from "./explorer.js";
import * as pilot from "./scram-pilot.js";

import { PauseError, StopError } from "./errors.js";

export { PauseError, StopError };

const ALARM = "autopilot-keepalive";
let running = false;
let stopRequested = false;

export async function getState() {
  return store.get("autopilot", null);
}

async function saveState(state) {
  state.updatedAt = Date.now();
  await store.set("autopilot", state);
}

function notify(title, message) {
  chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message: message.slice(0, 250) }, () => void chrome.runtime.lastError);
}

function makeCtx(state, settings) {
  const ctx = {
    state,
    settings,
    async save(patch = {}) {
      // Never let an in-flight step overwrite a Stop the user just pressed.
      if (stopRequested) throw new StopError("Stopped");
      Object.assign(state, patch);
      await saveState(state);
    },
    async log(msg) {
      if (stopRequested) throw new StopError("Stopped");
      state.log = [...(state.log || []), { t: Date.now(), msg }].slice(-300);
      state.message = msg;
      await saveState(state);
    },
    checkStop() {
      if (stopRequested) throw new StopError("Stopped");
    },
    notify,
  };
  return ctx;
}

export async function start({ tabId }) {
  if (running) throw new Error("Autopilot is already running.");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || "")) throw new Error("Open the website you want to clone first.");
  const siteUrl = store.siteUrlFor(tab.url);
  const state = {
    status: "running",
    phase: "explore",
    siteUrl,
    startUrl: tab.url,
    startedAt: Date.now(),
    message: "Starting…",
    log: [],
    explore: { tabId: null, queue: [tab.url], visited: [], queued: [explorer.pattern(tab.url)], pages: [], skipped: [] },
    build: { tabId: null, step: 0, sentStep: null, rounds: 0, history: [], projectReady: false, modelChecked: false },
  };
  await saveState(state);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
  return state;
}

export async function stop() {
  stopRequested = true;
  const state = await getState();
  if (state && ["running", "paused"].includes(state.status)) {
    state.status = "stopped";
    state.message = "Stopped by you.";
    await saveState(state);
  }
  await explorer.release();
  await chrome.alarms.clear(ALARM);
}

export async function resume() {
  const state = await getState();
  if (!state) throw new Error("Nothing to resume.");
  if (state.status === "done") throw new Error("This run already finished.");
  state.status = "running";
  state.pauseReason = null;
  await saveState(state);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
}

export async function reset() {
  await stop();
  await store.set("autopilot", null);
}

// Called by the keepalive alarm: restart the loop if the worker was restarted mid-run.
export async function tick() {
  const state = await getState();
  if (state?.status === "running" && !running) run();
  if (!state || !["running", "paused"].includes(state.status)) await chrome.alarms.clear(ALARM);
}

async function run() {
  if (running) return;
  running = true;
  stopRequested = false;
  const settings = await store.getSettings();
  let state = await getState();
  const ctx = makeCtx(state, settings);
  try {
    while (!stopRequested) {
      state = ctx.state;
      if (state.status !== "running") break;

      if (state.phase === "explore") {
        const more = await explorer.explorePage(ctx);
        if (!more) {
          await explorer.release();
          await ctx.log(`Exploration finished: ${state.explore.pages.length} screen(s) written up.`);
          await ctx.save({ phase: "handoff" });
        }
      } else if (state.phase === "handoff") {
        await ctx.log("Generating the handoff step files…");
        const files = await generateHandoff(state.siteUrl);
        const appName = files.find((f) => f.fileType === "manifest")?.appName;
        const steps = files.filter((f) => f.fileType === "step").length;
        await ctx.save({ phase: settings.autopilotBuild ? "scram-setup" : "finished", build: { ...state.build, appName, step: 0, sentStep: null, totalSteps: steps } });
        await ctx.log(`Handoff ready: ${steps} steps for “${appName}”.`);
      } else if (state.phase === "scram-setup") {
        await pilot.setup(ctx);
        await ctx.save({ phase: "build" });
      } else if (state.phase === "build") {
        const more = await pilot.buildRound(ctx);
        if (!more) await ctx.save({ phase: "finished" });
      } else if (state.phase === "finished") {
        await ctx.save({ status: "done" });
        await ctx.log(settings.autopilotBuild ? "All steps built and confirmed in Scram. 🎉" : "Handoff generated. Building in Scram is turned off in Options.");
        notify("Autopilot finished", ctx.state.message);
        break;
      }
    }
  } catch (err) {
    if (err instanceof StopError) {
      // already marked stopped
    } else if (err instanceof PauseError) {
      await ctx.save({ status: "paused", pauseReason: err.message });
      await ctx.log(`Paused — needs you: ${err.message}`);
      notify("Autopilot needs you", err.message);
    } else {
      console.error(err);
      await ctx.save({ status: "error", pauseReason: err.message });
      await ctx.log(`Error: ${err.message}`);
      notify("Autopilot error", err.message);
    }
  } finally {
    running = false;
  }
}
