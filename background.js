import * as store from "./lib/storage.js";
import { generateSpec, generateHandoff } from "./lib/jobs.js";
import { dom } from "./lib/dom.js";
import * as autopilot from "./lib/autopilot.js";
import * as scramAttach from "./lib/scram-attach.js";
import * as chatTest from "./lib/scram-chat-test.js";
import * as skillsTest from "./lib/skills-test.js";
import * as scramExplorer from "./lib/scram-explorer.js";

const SCRAM_URL = store.SCRAM_HOME;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // Tidy step files saved by older versions (shorter context, short quick check at the end).
  store.streamlineSavedSteps().catch(console.error);
  // After an update/reload, carry on with a running Autopilot from where it left off
  // (its state is saved in storage, which reloading keeps).
  autopilot.tick();
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
      if (store.isScramUrl(tab.url)) return tab;
    } catch {
      /* tab closed */
    }
  }
  const [tab] = await store.scramTabs();
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

// Click Scram's Run toggle for real (script clicks don't take) unless it's already on Run.
async function switchToRunMode(tabId) {
  let t = await dom(tabId, "modeToggle");
  if (!t || (await dom(tabId, "centerOf", { id: t.id }))?.covered) {
    const x = await dom(tabId, "panelCloseTarget", "^plans$");
    if (x) {
      await scramAttach.realClick(tabId, { id: x.id, label: x.label }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }
    t = await dom(tabId, "modeToggle");
  }
  if (!t || t.active === true) return;
  await scramAttach.realClick(tabId, { id: t.id, label: t.label });
  await new Promise((r) => setTimeout(r, 2000));
}

// Paste the current step into the Scram tab's AI chat (only inside a project editor — never the
// dashboard's "What shall we build today?" box). Sends it too if "auto-submit" is on.
async function pasteCurrentStep(siteUrl) {
  const progress = await store.getProgress(siteUrl);
  const tab = await findScramTab(progress);
  if (!tab || !store.isScramEditorUrl(tab.url)) return false;
  const step = (await store.getSteps(siteUrl)).find((s) => s.stepNumber === progress.currentStep);
  if (!step) return false;
  try {
    // Scram's bot can't switch to Run mode itself, and it needs Run mode to test — so we do it.
    await switchToRunMode(tab.id).catch(() => {});
    const inputId = await dom(tab.id, "findChatInput");
    if (!inputId) return false;
    const typed = await dom(tab.id, "typeText", inputId, store.withTestingSection(step.content));
    if (typed?.ok && (await store.getSettings()).autoSubmit) {
      const sendId = await dom(tab.id, "findSendButton", inputId);
      if (sendId) await dom(tab.id, "click", sendId);
      else await dom(tab.id, "pressKey", "Enter", inputId);
    }
    return !!typed?.ok;
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
    await pasteCurrentStep(siteUrl);
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
  await pasteCurrentStep(siteUrl);
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
  wipeSite: ({ siteUrl }) => (siteUrl ? store.wipeSiteData(siteUrl) : Promise.reject(new Error("No site chosen."))),
  wipeAllSites: () => store.wipeSiteData(null),

  // Scram upload test page
  attachTestFindTab: async () => {
    const tabs = await store.scramTabs();
    return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, editor: store.isScramEditorUrl(t.url) }));
  },
  attachTestScan: ({ tabId }) => scramAttach.scan(tabId),
  attachTestRun: async ({ tabId, methods, send }) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `scram-upload-test-${stamp}.md`;
    const text = `# Scram upload test\n\nThis small file was generated by the Scram Site Analysis & Handoff extension at ${new Date().toLocaleString()} to check that it can attach markdown files to Scram's AI chat.\n\n- If you can read this, file attachments work.\n- Reply with the words "upload test received".\n`;
    const res = await scramAttach.attachToScram(tabId, name, text, methods?.length ? { only: methods } : {});
    if (res.ok) await scramAttach.rememberMethod(res.method);
    if (res.ok && send) {
      const input = await dom(tabId, "findChatInput");
      if (input) {
        await dom(tabId, "typeText", input, `Attached: ${name}. Please read it and reply as it asks.`);
        await new Promise((r) => setTimeout(r, 600));
        const btn = await dom(tabId, "findSendButton", input);
        if (btn) await dom(tabId, "click", btn);
        else await dom(tabId, "pressKey", "Enter", input);
        res.log.push("✉️ Sent a short message asking Scram's AI to confirm it can read the file.");
      }
    }
    return { ...res, name };
  },
  attachTestForget: () => scramAttach.rememberMethod(null),

  // Scram chat test page (plans + questions)
  chatTestStart: ({ tabId, mode, dryRun, maxRounds }) => chatTest.start({ tabId, mode, dryRun, maxRounds }),
  chatTestStop: () => chatTest.stop(),
  skillsTestStart: ({ mode, tabId, skills }) => skillsTest.start({ mode, tabId, skills }),
  skillsTestStop: () => skillsTest.stop(),
  scramExploreStart: ({ mode, tabId, maxActions }) => scramExplorer.start({ mode, tabId, maxActions }),
  scramExploreStop: () => scramExplorer.stop(),

  // Autopilot
  autopilotStart: ({ tabId, instructions }) => autopilot.start({ tabId, instructions }),
  autopilotStop: () => autopilot.stop(),
  autopilotPause: () => autopilot.pause(),
  autopilotResume: () => autopilot.resume(),
  autopilotReset: () => autopilot.reset(),
  autopilotAnswer: ({ answers }) => autopilot.answerQuestions(answers),
  autopilotNote: ({ text }) => autopilot.addNote(text),

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
