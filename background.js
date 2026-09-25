import * as store from "./lib/storage.js";
import { generateSpec, generateHandoff } from "./lib/jobs.js";
import { dom } from "./lib/dom.js";
import * as autopilot from "./lib/autopilot.js";

const SCRAM_URL = "https://dashboard.buildwithscram.com/";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // Any job marked "running" from a previous browser session is dead.
  store.set("jobs", {});
  autopilot.tick();
});

// Keeps a long Autopilot run going: resumes the loop if Chrome restarted the worker.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "autopilot-keepalive") autopilot.tick();
});

// ---------------------------------------------------------------------------
// Job 1 (manual): capture the current page as-is and turn it into a spec.
// ---------------------------------------------------------------------------

async function capturePage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be captured (only http/https pages are supported).");

  const siteUrl = store.siteUrlFor(tab.url);
  const jobKey = `capture:${siteUrl}`;
  const startedAt = Date.now();
  await store.setJob(jobKey, { status: "running", message: `Analysing ${tab.title || tab.url}…`, startedAt });

  try {
    const page = await dom(tabId, "extract");
    const spec = await generateSpec({
      siteUrl,
      page,
      onProgress: (chars) => store.setJob(jobKey, { status: "running", message: `Writing spec for ${page.title || page.url} (${chars.toLocaleString()} chars)…`, startedAt }),
    });
    await store.setJob(jobKey, null);
    return spec;
  } catch (err) {
    await store.setJob(jobKey, { status: "error", message: err.message, startedAt: Date.now() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Job 3: drive the Scram build one step at a time.
// ---------------------------------------------------------------------------

async function findScramTab(progress) {
  if (progress?.scramTabId != null) {
    try {
      const tab = await chrome.tabs.get(progress.scramTabId);
      if (tab.url?.startsWith(SCRAM_URL)) return tab;
    } catch {
      /* tab closed */
    }
  }
  const [tab] = await chrome.tabs.query({ url: `${SCRAM_URL}*` });
  return tab || null;
}

async function startBuild(siteUrl) {
  const steps = await store.getSteps(siteUrl);
  if (!steps.length) throw new Error("Generate the handoff first.");
  const progress = await store.getProgress(siteUrl);
  const tab = await chrome.tabs.create({ url: SCRAM_URL, active: true });
  await store.setProgress({
    ...progress,
    currentStep: progress.completedSteps.length ? progress.currentStep : steps[0].stepNumber,
    scramTabId: tab.id,
    startedAt: new Date().toISOString(),
    autoProjectAttempted: false,
  });
  await store.set("activeBuild", siteUrl);
  return { tabId: tab.id };
}

async function buildState() {
  const siteUrl = await store.get("activeBuild", null);
  if (!siteUrl) return { active: false };
  const [steps, progress, settings] = await Promise.all([store.getSteps(siteUrl), store.getProgress(siteUrl), store.getSettings()]);
  const step = steps.find((s) => s.stepNumber === progress.currentStep) || null;
  return {
    active: true,
    siteUrl,
    step,
    totalSteps: steps.length,
    stepIndex: step ? steps.indexOf(step) : -1,
    progress,
    finished: steps.every((s) => progress.completedSteps.includes(s.stepNumber)),
    autoSubmit: settings.autoSubmit,
  };
}

async function notifyScram(siteUrl, message) {
  const progress = await store.getProgress(siteUrl);
  const tab = await findScramTab(progress);
  if (!tab) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch {
    return false;
  }
}

async function completeStep(siteUrl, stepNumber) {
  const steps = await store.getSteps(siteUrl);
  const progress = await store.getProgress(siteUrl);
  const completed = new Set(progress.completedSteps);
  completed.add(stepNumber);
  const next = steps.find((s) => !completed.has(s.stepNumber));
  const updated = { ...progress, completedSteps: [...completed].sort((a, b) => a - b), currentStep: next ? next.stepNumber : stepNumber };
  await store.setProgress(updated);
  if (next && (await store.get("activeBuild")) === siteUrl) {
    await notifyScram(siteUrl, { type: "scram:pasteStep" });
  }
  return updated;
}

async function sendStep(siteUrl, stepNumber) {
  const progress = await store.getProgress(siteUrl);
  await store.setProgress({ ...progress, currentStep: stepNumber });
  await store.set("activeBuild", siteUrl);
  const tab = await findScramTab(progress);
  if (!tab) {
    const created = await chrome.tabs.create({ url: SCRAM_URL, active: true });
    await store.setProgress({ ...(await store.getProgress(siteUrl)), scramTabId: created.id });
    return { opened: true };
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await store.setProgress({ ...(await store.getProgress(siteUrl)), scramTabId: tab.id });
  await notifyScram(siteUrl, { type: "scram:pasteStep" });
  return { opened: false };
}

async function resetBuild(siteUrl) {
  const steps = await store.getSteps(siteUrl);
  await store.setProgress({ siteUrl, currentStep: steps[0]?.stepNumber ?? 0, completedSteps: [] });
}

async function uncompleteStep(siteUrl, stepNumber) {
  const progress = await store.getProgress(siteUrl);
  await store.setProgress({ ...progress, completedSteps: progress.completedSteps.filter((n) => n !== stepNumber) });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const handlers = {
  ping: async () => "pong",
  capture: ({ tabId }) => capturePage(tabId),
  generateHandoff: ({ siteUrl }) => generateHandoff(siteUrl),
  startBuild: ({ siteUrl }) => startBuild(siteUrl),
  sendStep: ({ siteUrl, stepNumber }) => sendStep(siteUrl, stepNumber),
  completeStep: ({ siteUrl, stepNumber }) => completeStep(siteUrl, stepNumber),
  uncompleteStep: ({ siteUrl, stepNumber }) => uncompleteStep(siteUrl, stepNumber),
  resetBuild: ({ siteUrl }) => resetBuild(siteUrl),
  stopBuild: () => store.set("activeBuild", null),
  clearJob: ({ key }) => store.setJob(key, null),

  // Autopilot
  autopilotStart: ({ tabId }) => autopilot.start({ tabId }),
  autopilotStop: () => autopilot.stop(),
  autopilotResume: () => autopilot.resume(),
  autopilotReset: () => autopilot.reset(),

  // From the Scram content script.
  "scram:getState": () => buildState(),
  "scram:markProjectAttempted": async () => {
    const siteUrl = await store.get("activeBuild");
    if (siteUrl) await store.setProgress({ ...(await store.getProgress(siteUrl)), autoProjectAttempted: true });
  },
  "scram:completeCurrent": async () => {
    const state = await buildState();
    if (!state.active || !state.step) throw new Error("No active build step.");
    await completeStep(state.siteUrl, state.step.stepNumber);
    return buildState();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.error(msg.type, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // keep the channel open for the async response
});
