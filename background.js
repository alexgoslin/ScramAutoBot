import * as store from "./lib/storage.js";
import { callClaude, extractJson } from "./lib/claude.js";

const SCRAM_URL = "https://dashboard.buildwithscram.com/";
const MAX_PAGE_CHARS = 120000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // Any job marked "running" from a previous browser session is dead.
  store.set("jobs", {});
});

// ---------------------------------------------------------------------------
// Prompts: Options-page override wins, otherwise the bundled prompts/*.md file.
// ---------------------------------------------------------------------------

async function loadPrompt(name, file) {
  const overrides = await store.get("promptOverrides", {});
  if (overrides[name]?.trim()) return overrides[name];
  const res = await fetch(chrome.runtime.getURL(`prompts/${file}`));
  return res.text();
}

// ---------------------------------------------------------------------------
// Job 1: capture a page and turn it into a spec.
// ---------------------------------------------------------------------------

// Runs inside the target page via chrome.scripting.executeScript.
function extractPage() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const take = (sel, map, limit = 80) =>
    Array.from(document.querySelectorAll(sel)).slice(0, limit).map(map).filter(Boolean);

  const headings = take("h1,h2,h3,h4", (h) => `${h.tagName}: ${clean(h.innerText)}`, 120);
  const landmarks = take(
    "header,nav,main,aside,footer,[role=navigation],[role=main],[role=dialog],[role=tablist]",
    (el) => `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : ""}`,
    40
  );
  const buttons = take("button,[role=button],input[type=submit]", (b) => clean(b.innerText || b.value || b.getAttribute("aria-label")), 120);
  const links = take("a[href]", (a) => {
    const t = clean(a.innerText || a.getAttribute("aria-label"));
    return t ? `${t} -> ${a.getAttribute("href")}` : null;
  }, 150);
  const forms = take("form", (f) => {
    const fields = Array.from(f.querySelectorAll("input,select,textarea"))
      .map((i) => `${i.tagName.toLowerCase()}[${i.type || ""}] ${i.name || i.id || i.placeholder || i.getAttribute("aria-label") || ""}`.trim());
    return `form: ${fields.join(", ")}`;
  }, 20);
  const standaloneInputs = take("input:not(form input),textarea:not(form textarea),select:not(form select)", (i) =>
    `${i.tagName.toLowerCase()}[${i.type || ""}] ${i.placeholder || i.name || i.getAttribute("aria-label") || ""}`.trim(), 40);

  return {
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : "",
    structure: { headings, landmarks, buttons, links, forms, standaloneInputs },
  };
}

function formatStructure(s) {
  const section = (name, items) => (items.length ? `### ${name}\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return [
    section("Landmarks", s.landmarks),
    section("Headings", s.headings),
    section("Buttons", [...new Set(s.buttons)]),
    section("Links", s.links),
    section("Forms", s.forms),
    section("Inputs outside forms", s.standaloneInputs),
  ].filter(Boolean).join("\n\n");
}

async function capturePage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be captured (only http/https pages are supported).");

  const siteUrl = store.siteUrlFor(tab.url);
  const jobKey = `capture:${siteUrl}`;
  await store.setJob(jobKey, { status: "running", message: `Analysing ${tab.title || tab.url}…`, startedAt: Date.now() });

  try {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
    let text = page.text || "";
    const truncated = text.length > MAX_PAGE_CHARS;
    if (truncated) text = text.slice(0, MAX_PAGE_CHARS);

    const userContent = [
      `# Page to analyse`,
      `URL: ${page.url}`,
      `Title: ${page.title}`,
      ``,
      `## Page structure (auto-extracted)`,
      formatStructure(page.structure),
      ``,
      `## Visible text${truncated ? " (truncated)" : ""}`,
      "```",
      text,
      "```",
    ].join("\n");

    const [apiKey, settings, system] = await Promise.all([
      store.get("apiKey", ""),
      store.getSettings(),
      loadPrompt("specExtractor", "site-screen-spec-extractor.md"),
    ]);

    const { text: content, stopReason } = await callClaude({
      apiKey,
      model: settings.model,
      system,
      userContent,
      maxTokens: settings.specMaxTokens,
    });

    const spec = {
      id: store.uid(),
      siteUrl,
      pageUrl: page.url,
      pageTitle: page.title || page.url,
      content: stopReason === "max_tokens" ? `${content}\n\n> ⚠️ Output was cut off at the max token limit.` : content,
      capturedAt: new Date().toISOString(),
    };
    await store.addSpecFile(spec);
    await store.setJob(jobKey, null);
    return spec;
  } catch (err) {
    await store.setJob(jobKey, { status: "error", message: err.message, startedAt: Date.now() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Job 2: split all specs for a site into handoff step files.
// ---------------------------------------------------------------------------

const HANDOFF_FORMAT_INSTRUCTIONS = `
Return your answer as a single JSON object and nothing else — no prose before or after, no markdown fences.
The JSON must have exactly this shape:

{
  "manifest": "<markdown manifest listing every step in order, with a one-line summary each>",
  "combinedDoc": "<the full combined handoff document in markdown>",
  "steps": [
    { "stepNumber": 0, "title": "Setup", "content": "<markdown for this step>" },
    { "stepNumber": 1, "title": "Auth", "content": "<markdown for this step>" }
  ]
}

Rules:
- stepNumber starts at 0 and increases by 1 with no gaps.
- Step 0 is project setup. Step 1 is auth (if the app has any). Later steps are one screen or feature each (e.g. "Screen: Home Feed").
- Every step's content must be self-contained enough to paste directly into an AI coding agent's chat.
- All string values must be valid JSON strings (escape newlines as \\n and quotes as \\").`;

async function generateHandoff(siteUrl) {
  const jobKey = `handoff:${siteUrl}`;
  const specs = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === siteUrl)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  if (!specs.length) throw new Error(`No captured pages for ${siteUrl} yet.`);

  await store.setJob(jobKey, { status: "running", message: `Splitting ${specs.length} spec file(s) into build steps…`, startedAt: Date.now() });

  try {
    const combinedSpecs = specs
      .map((s, i) => `<!-- Spec ${i + 1} of ${specs.length}: ${s.pageTitle} (${s.pageUrl}) -->\n\n${s.content}`)
      .join("\n\n---\n\n");

    const userContent = `Site: ${siteUrl}\nNumber of screen specs: ${specs.length}\n\n${combinedSpecs}\n\n---\n${HANDOFF_FORMAT_INSTRUCTIONS}`;

    const [apiKey, settings, system] = await Promise.all([
      store.get("apiKey", ""),
      store.getSettings(),
      loadPrompt("handoffSplitter", "scram-phased-handoff-splitter.md"),
    ]);

    const { text, stopReason } = await callClaude({
      apiKey,
      model: settings.model,
      system,
      userContent,
      maxTokens: settings.handoffMaxTokens,
    });

    if (stopReason === "max_tokens") {
      throw new Error("Claude hit the max token limit before finishing the handoff JSON. Raise 'Handoff max tokens' in Options or capture fewer pages.");
    }

    const parsed = extractJson(text);
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error("Handoff JSON had no steps.");

    const now = new Date().toISOString();
    const files = [
      { id: store.uid(), siteUrl, fileType: "manifest", stepNumber: null, title: "Manifest", content: String(parsed.manifest || ""), createdAt: now },
      { id: store.uid(), siteUrl, fileType: "combined", stepNumber: null, title: "Combined Handoff", content: String(parsed.combinedDoc || ""), createdAt: now },
      ...parsed.steps
        .map((s, i) => ({
          id: store.uid(),
          siteUrl,
          fileType: "step",
          stepNumber: Number.isFinite(Number(s.stepNumber)) ? Number(s.stepNumber) : i,
          title: String(s.title || `Step ${i}`),
          content: String(s.content || ""),
          createdAt: now,
        }))
        .sort((a, b) => a.stepNumber - b.stepNumber),
    ];

    await store.replaceHandoffFiles(siteUrl, files);
    // New steps invalidate any previous build progress for this site.
    await store.setProgress({ siteUrl, currentStep: files.find((f) => f.fileType === "step").stepNumber, completedSteps: [] });
    await store.setJob(jobKey, null);
    return files;
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
