import { DEFAULT_SETTINGS, getSettings } from "../lib/storage.js";
import { callClaude } from "../lib/claude.js";

const $ = (sel) => document.querySelector(sel);
const BUNDLED = { specPrompt: "site-screen-spec-extractor.md", handoffPrompt: "scram-phased-handoff-splitter.md" };

async function load() {
  const { apiKey = "", promptOverrides = {} } = await chrome.storage.local.get(["apiKey", "promptOverrides"]);
  const settings = await getSettings();
  $("#apiKey").value = apiKey;
  $("#model").value = settings.model;
  $("#specMaxTokens").value = settings.specMaxTokens;
  $("#handoffMaxTokens").value = settings.handoffMaxTokens;
  $("#autoSubmit").checked = settings.autoSubmit;
  for (const k of ["explorationMode", "maxPages", "maxInteractionsPerPage", "actionDelayMs", "explorerModel", "scramIdleSeconds", "maxRoundsPerStep"]) $(`#${k}`).value = settings[k];
  for (const k of ["recordNetwork", "recordResponseBodies", "screenshots", "autopilotBuild", "productFocus"]) $(`#${k}`).checked = settings[k];
  $("#specPrompt").value = promptOverrides.specExtractor || "";
  $("#handoffPrompt").value = promptOverrides.handoffSplitter || "";
}

function readSettings() {
  const int = (id, fallback) => {
    const n = parseInt($(id).value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    model: $("#model").value.trim() || DEFAULT_SETTINGS.model,
    specMaxTokens: int("#specMaxTokens", DEFAULT_SETTINGS.specMaxTokens),
    handoffMaxTokens: int("#handoffMaxTokens", DEFAULT_SETTINGS.handoffMaxTokens),
    autoSubmit: $("#autoSubmit").checked,
    explorationMode: $("#explorationMode").value === "safe" ? "safe" : "full",
    productFocus: $("#productFocus").checked,
    maxPages: int("#maxPages", DEFAULT_SETTINGS.maxPages),
    maxInteractionsPerPage: int("#maxInteractionsPerPage", DEFAULT_SETTINGS.maxInteractionsPerPage),
    actionDelayMs: Math.max(300, int("#actionDelayMs", DEFAULT_SETTINGS.actionDelayMs)),
    explorerModel: $("#explorerModel").value.trim() || DEFAULT_SETTINGS.explorerModel,
    recordNetwork: $("#recordNetwork").checked,
    recordResponseBodies: $("#recordResponseBodies").checked,
    screenshots: $("#screenshots").checked,
    autopilotBuild: $("#autopilotBuild").checked,
    scramIdleSeconds: int("#scramIdleSeconds", DEFAULT_SETTINGS.scramIdleSeconds),
    maxRoundsPerStep: int("#maxRoundsPerStep", DEFAULT_SETTINGS.maxRoundsPerStep),
  };
}

async function save() {
  // Old errors (e.g. "No API key set") would otherwise stay visible in the side panel.
  const { jobs = {} } = await chrome.storage.local.get("jobs");
  const running = Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.status === "running"));
  await chrome.storage.local.set({
    jobs: running,
    apiKey: $("#apiKey").value.trim(),
    settings: readSettings(),
    promptOverrides: { specExtractor: $("#specPrompt").value, handoffSplitter: $("#handoffPrompt").value },
  });
  $("#saved").textContent = "Saved ✓";
  clearTimeout(save._t);
  save._t = setTimeout(() => ($("#saved").textContent = ""), 2000);
}

$("#save").addEventListener("click", save);

// Save automatically as settings change, so nothing is lost if the Save button is missed.
let autoSaveTimer = null;
document.querySelectorAll("input, textarea, select").forEach((el) =>
  el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(save, 400);
  })
);

$("#testKey").addEventListener("click", async () => {
  const out = $("#testResult");
  out.textContent = "Testing…";
  try {
    const { text } = await callClaude({
      apiKey: $("#apiKey").value.trim(),
      model: readSettings().model,
      system: "Reply with the single word: ok",
      userContent: "ping",
      maxTokens: 10,
    });
    await save();
    out.textContent = `Works ✓ (model replied “${text.trim()}”) — key saved`;
  } catch (e) {
    out.textContent = e.message;
  }
});

document.querySelectorAll("[data-load]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const id = btn.dataset.load;
    const res = await fetch(chrome.runtime.getURL(`prompts/${BUNDLED[id]}`));
    $(`#${id}`).value = await res.text();
  })
);

$("#exportData").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(["sites", "specFiles", "handoffFiles", "buildProgress"]);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `site-handoff-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#clearData").addEventListener("click", async () => {
  if (!confirm("Delete all sites, spec files, handoff files and build progress? Your API key and settings are kept.")) return;
  await chrome.storage.local.remove(["sites", "specFiles", "handoffFiles", "buildProgress", "activeBuild", "jobs"]);
  alert("All captured data deleted.");
});

async function showUsage() {
  const { usage = { input: 0, output: 0, calls: 0 } } = await chrome.storage.local.get("usage");
  $("#usageTotal").textContent = `All-time Claude usage from this extension: ${usage.calls} calls, ${usage.input.toLocaleString()} input / ${usage.output.toLocaleString()} output tokens.`;
}
$("#resetUsage").addEventListener("click", async () => {
  await chrome.storage.local.set({ usage: { input: 0, output: 0, calls: 0 } });
  showUsage();
});
chrome.storage.onChanged.addListener((changes) => changes.usage && showUsage());
showUsage();

load();
