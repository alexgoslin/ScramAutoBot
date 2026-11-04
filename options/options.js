import { DEFAULT_SETTINGS, getSettings, getLessons, addLessons, removeLesson } from "../lib/storage.js";
import { callClaude } from "../lib/claude.js";
import { totalCost, formatCost } from "../lib/pricing.js";

const $ = (sel) => document.querySelector(sel);
const BUNDLED = { specPrompt: "site-screen-spec-extractor.md", handoffPrompt: "scram-phased-handoff-splitter.md" };

async function load() {
  const { apiKey = "", promptOverrides = {} } = await chrome.storage.local.get(["apiKey", "promptOverrides"]);
  const settings = await getSettings();
  $("#apiKey").value = apiKey;
  $("#model").value = settings.model;
  $("#operatorModel").value = settings.operatorModel || "";
  $("#operatorEffort").value = settings.operatorEffort || "high";
  $("#operatorBrowserTools").checked = settings.operatorBrowserTools !== false;
  $("#supervisorSees").checked = settings.supervisorSees !== false;
  $("#specMaxTokens").value = settings.specMaxTokens;
  $("#handoffMaxTokens").value = settings.handoffMaxTokens;
  $("#autoSubmit").checked = settings.autoSubmit;
  for (const k of ["explorationMode", "maxPages", "maxInteractionsPerPage", "actionDelayMs", "explorerModel", "scramIdleSeconds"]) $(`#${k}`).value = settings[k];
  for (const k of ["recordNetwork", "recordResponseBodies", "screenshots", "autopilotBuild", "productFocus", "scramSendAsFile", "coreFeaturesOnly", "askQuestions", "finalDesignReview"]) $(`#${k}`).checked = settings[k];
  $("#workInOwnWindow").checked = settings.workInOwnWindow !== false;
  $("#slimContext").checked = settings.slimContext !== false;
  $("#stepSize").value = settings.stepSize || "standard";
  $("#detailedSteps").checked = settings.detailedSteps !== false;
  $("#maxStepChars").value = settings.maxStepChars;
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
    operatorModel: $("#operatorModel").value.trim() || DEFAULT_SETTINGS.operatorModel,
    operatorEffort: ["medium", "high", "xhigh"].includes($("#operatorEffort").value) ? $("#operatorEffort").value : "high",
    operatorBrowserTools: $("#operatorBrowserTools").checked,
    supervisorSees: $("#supervisorSees").checked,
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
    scramSendAsFile: $("#scramSendAsFile").checked,
    scramIdleSeconds: int("#scramIdleSeconds", DEFAULT_SETTINGS.scramIdleSeconds),
    coreFeaturesOnly: $("#coreFeaturesOnly").checked,
    askQuestions: $("#askQuestions").checked,
    finalDesignReview: $("#finalDesignReview").checked,
    workInOwnWindow: $("#workInOwnWindow").checked,
    slimContext: $("#slimContext").checked,
    stepSize: $("#stepSize").value === "small" ? "small" : "standard",
    detailedSteps: $("#detailedSteps").checked,
    settingsVersion: 2,
    maxStepChars: Math.max(2000, int("#maxStepChars", DEFAULT_SETTINGS.maxStepChars)),
  };
}

async function save() {
  // Old errors (e.g. "No API key set") would otherwise stay visible in the side panel.
  const { jobs = {}, settings: existing = {} } = await chrome.storage.local.get(["jobs", "settings"]);
  const running = Object.fromEntries(Object.entries(jobs).filter(([, j]) => j.status === "running"));
  await chrome.storage.local.set({
    jobs: running,
    apiKey: $("#apiKey").value.trim(),
    // Merge, so values set elsewhere (e.g. the saved Scram upload method) survive.
    settings: { ...existing, ...readSettings() },
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
  if (!confirm("Delete all sites' data — spec files, handoff/step files, build progress and research briefings? Your API key, settings and what it learned about Scram are kept.")) return;
  const res = await chrome.runtime.sendMessage({ type: "wipeAllSites" });
  alert(res?.ok ? "All site data deleted." : res?.error || "Couldn't delete the data.");
});

async function showUsage() {
  const { usage = { input: 0, output: 0, calls: 0 } } = await chrome.storage.local.get("usage");
  $("#usageTotal").textContent = `All-time Claude usage from this extension: ${usage.calls} calls, ${usage.input.toLocaleString()} input / ${usage.output.toLocaleString()} output tokens — about ${usage.costEstimated ? "≈" : ""}${formatCost(totalCost(usage))} at list prices.`;
}
$("#resetUsage").addEventListener("click", async () => {
  await chrome.storage.local.set({ usage: { input: 0, output: 0, calls: 0, cost: 0 } });
  showUsage();
});
chrome.storage.onChanged.addListener((changes) => changes.usage && showUsage());
showUsage();


// ---- lessons learned about Scram's AI
async function renderLessons() {
  const list = $("#lessons");
  const lessons = await getLessons();
  list.replaceChildren(
    ...(lessons.length
      ? lessons.map((l) => {
          const li = document.createElement("li");
          const text = document.createElement("span");
          text.textContent = l.text;
          const meta = document.createElement("small");
          meta.className = "hint";
          meta.textContent = ` — ${l.source || "added"} · ${new Date(l.learnedAt).toLocaleDateString()}`;
          const del = document.createElement("button");
          del.type = "button";
          del.textContent = "Delete";
          del.addEventListener("click", async () => {
            await removeLesson(l.id);
            renderLessons();
          });
          li.append(text, meta, del);
          return li;
        })
      : [Object.assign(document.createElement("li"), { className: "hint", textContent: "Nothing learned yet." })])
  );
}
$("#addLesson").addEventListener("click", async () => {
  const text = $("#newLesson").value.trim();
  if (!text) return;
  await addLessons([text], "added by you");
  $("#newLesson").value = "";
  renderLessons();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.scramLessons) renderLessons();
});
renderLessons();

// ---- Control Center connection (lib/bridge.js; runs in the background worker)
const ENV_DEFAULTS = {
  live: { baseUrl: "https://brownmoina242.scramapps.com/api/dataSource/oAC_003FG/", siteBase: "https://robobuild.builtonscram.com" },
  dev: { baseUrl: "https://z07w3d61njwbx5lbgc5gzqk2.dev.scramapps.com/api/dataSource/oAC_003FG/", siteBase: "" },
};
let ccEnv = "live";
let ccWasConnected = null;
function ccRender(s) {
  if (!s) return;
  const envChanged = s.env !== ccEnv;
  ccEnv = s.env || "live";
  document.querySelectorAll(".cc-env-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.env === ccEnv)));
  // Fields belong to the selected environment: refill them when it changes.
  if (envChanged || !$("#ccBaseUrl").value) $("#ccBaseUrl").value = s.baseUrl || ENV_DEFAULTS[ccEnv].baseUrl;
  if (envChanged || document.activeElement !== $("#ccSiteBase")) $("#ccSiteBase").value = s.siteBase || "";
  $("#ccSiteBase").placeholder = ENV_DEFAULTS[ccEnv].siteBase || "https://editor.buildwithscram.com/branch/z07w3d61njwbx5lbgc5gzqk2/ (Scram editor)";
  if (envChanged) {
    $("#ccComputerId").value = s.computerId || "";
    $("#ccToken").value = "";
    $("#ccPaste").value = "";
  } else if (s.computerId && !$("#ccComputerId").value) $("#ccComputerId").value = s.computerId;
  $("#ccToken").placeholder = s.tokenHint ? `saved (${s.tokenHint})` : "";
  const name = ccEnv === "dev" ? "the dev Control Center" : "the live Control Center";
  const err = !s.connected && s.status === "error";
  $("#ccState").className = `cc-state ${s.connected ? "on" : err ? "err" : ""}`;
  $("#ccStateTitle").textContent = s.connected ? `Connected to ${name}` : err ? "Not connected — something went wrong" : s.status === "connecting" ? "Connecting…" : `Not connected to ${name} yet`;
  $("#ccStatus").textContent = s.connected
    ? `Connection #${s.computerId}${s.lastPollAt ? ` · last check ${new Date(s.lastPollAt).toLocaleTimeString()}` : ""}${s.outbox ? ` · ${s.outbox} report(s) waiting to retry` : ""}`
    : err
      ? s.statusMessage
      : ccEnv === "live"
        ? "Paste your connection from robobuild.builtonscram.com → Extension (steps below)."
        : "Paste your connection from the dev Control Center → Extension (steps below).";
  $("#ccDisconnect").classList.toggle("hidden", !s.connected);
  // One-time offer after connecting to a Control Center: upload what this extension already made.
  $("#ccUpload").classList.toggle("hidden", !(s.connected && !s.uploadOffered));
  // The how-to stays open until connected, then folds away (still there to connect again).
  if (ccWasConnected !== s.connected || envChanged) $("#ccHow").open = !s.connected;
  ccWasConnected = s.connected;
}
function ccMessage(text, isError = false) {
  $("#ccState").className = `cc-state ${isError ? "err" : ""}`;
  $("#ccStateTitle").textContent = isError ? "Not connected — something went wrong" : "Connecting…";
  $("#ccStatus").textContent = text;
}
async function ccRefresh(kick = false) {
  const res = await chrome.runtime.sendMessage({ type: "bridgeStatus", kick }).catch(() => null);
  if (res?.ok) ccRender(res.data);
}
$("#ccPaste").addEventListener("input", () => {
  const raw = $("#ccPaste").value.trim();
  if (!raw) return;
  try {
    const j = JSON.parse(raw);
    if (j.computer_id != null) $("#ccComputerId").value = j.computer_id;
    if (j.token) $("#ccToken").value = j.token;
    if (j.base_url || j.baseUrl) $("#ccBaseUrl").value = j.base_url || j.baseUrl;
    if (j.computer_id != null && j.token) ccConnect(); // pasted the whole thing: connect straight away
  } catch {
    ccMessage("That isn't what “Copy both” gives — it looks like {\"computer_id\": 3, \"token\": \"…\"}. Press Copy both in the Control Center and paste again.", true);
  }
});
let ccBusy = false;
async function ccConnect() {
  if (ccBusy) return;
  ccBusy = true;
  ccMessage("Connecting…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "bridgeConnect", baseUrl: $("#ccBaseUrl").value.trim(), computerId: $("#ccComputerId").value.trim(), token: $("#ccToken").value.trim(), siteBase: $("#ccSiteBase").value.trim() });
    if (!res?.ok) return ccMessage(res?.error || "Couldn't connect.", true);
    $("#ccToken").value = "";
    $("#ccPaste").value = "";
    ccRefresh(true);
  } finally {
    ccBusy = false;
  }
}
$("#ccConnect").addEventListener("click", ccConnect);
const siteFor = async () => (await chrome.runtime.sendMessage({ type: "bridgeStatus" }))?.data;
async function openSite(path = "") {
  const st = await siteFor();
  const base = (st?.siteBase || ENV_DEFAULTS[st?.env || "live"].siteBase || "").replace(/\/+$/, "");
  chrome.tabs.create({ url: base ? `${base}${path}` : "https://editor.buildwithscram.com/branch/z07w3d61njwbx5lbgc5gzqk2/" });
}
$("#ccOpenApp").addEventListener("click", () => openSite("/"));
$("#ccOpenApp2").addEventListener("click", () => openSite("/extension"));
document.querySelectorAll(".cc-env-btn").forEach((b) =>
  b.addEventListener("click", async () => {
    if (b.dataset.env === ccEnv) return;
    const res = await chrome.runtime.sendMessage({ type: "bridgeSwitchEnv", env: b.dataset.env });
    if (res?.ok) ccRender(res.data);
    else ccMessage(res?.error || "Couldn't switch.", true);
  })
);
$("#ccSiteBase").addEventListener("change", async () => {
  const res = await chrome.runtime.sendMessage({ type: "bridgeSetSite", siteBase: $("#ccSiteBase").value.trim() });
  if (!res?.ok) ccMessage(res?.error || "Couldn't save the website address.", true);
});
$("#ccUploadGo").addEventListener("click", async () => {
  $("#ccUploadGo").disabled = true;
  $("#ccUploadGo").textContent = "Uploading…";
  const res = await chrome.runtime.sendMessage({ type: "bridgeUploadDocs" });
  $("#ccUploadGo").disabled = false;
  $("#ccUploadGo").textContent = "Upload my existing documents";
  if (!res?.ok) return ccMessage(res?.error || "Couldn't upload them.", true);
  await ccRefresh();
  $("#ccStatus").textContent = `Uploaded ${res.data?.documents ?? 0} document(s) to the Control Center ✓`;
});
$("#ccUploadNo").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "bridgeDismissUpload" });
  ccRefresh();
});
$("#ccDisconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "bridgeDisconnect" });
  ccRefresh(true);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridge) ccRefresh(true);
});
ccRefresh(true);


// ---- Pages: one section at a time, chosen by the address (#connection, #autopilot…), so the
// side panel can link straight to a page.
const PAGES = [...document.querySelectorAll(".page")].map((x) => x.dataset.page);
function showPage() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  document.querySelectorAll(".page").forEach((x) => x.classList.toggle("active", x.dataset.page === page));
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  if (page === "overview") renderOverview();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showPage);

// Quick settings on the Overview mirror the real fields (which save automatically).
document.querySelectorAll("[data-mirror]").forEach((m) => {
  const real = $(`#${m.dataset.mirror}`);
  m.addEventListener(m.type === "checkbox" || m.tagName === "SELECT" ? "change" : "input", () => {
    if (m.type === "checkbox") real.checked = m.checked;
    else real.value = m.value;
  });
});
function syncMirrors() {
  document.querySelectorAll("[data-mirror]").forEach((m) => {
    const real = $(`#${m.dataset.mirror}`);
    if (m.type === "checkbox") m.checked = real.checked;
    else m.value = real.value;
  });
}

async function renderOverview() {
  syncMirrors();
  const { apiKey = "", usage = { input: 0, output: 0, calls: 0 }, bridge = {} } = await chrome.storage.local.get(["apiKey", "usage", "bridge"]);
  const connected = !!(bridge.enabled && bridge.token && bridge.computerId);
  $("#dCc").textContent = connected ? "● Connected" : "Not connected";
  $("#dCc").className = connected ? "ok" : "bad";
  $("#dCcSub").textContent = connected ? (bridge.lastPollAt ? `last check ${new Date(bridge.lastPollAt).toLocaleTimeString()}` : "") : "Connect to run everything from the website";
  $("#dKey").textContent = apiKey ? "Set ✓" : "Missing";
  $("#dKey").className = apiKey ? "ok" : "bad";
  $("#dKeySub").textContent = apiKey ? `model: ${$("#model").value || DEFAULT_SETTINGS.model}` : "Add your key to use Autopilot";
  $("#dCost").textContent = `${usage.costEstimated ? "≈" : ""}${formatCost(totalCost(usage))}`;
  $("#dCostSub").textContent = `${(usage.calls || 0).toLocaleString()} Claude calls, all time`;
  $("#dLessons").textContent = String((await getLessons()).length);
  $("#navCc").className = `dot ${connected ? "on" : ""}`;
  $("#navKey").className = `dot ${apiKey ? "" : "warn"}`;
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridge || changes.apiKey || changes.usage || changes.scramLessons) renderOverview();
});
load().then(showPage);

// API key status next to the field: shows at a glance whether a key is saved.
function renderKeyBadge(set) {
  const b = $("#keyBadge");
  b.className = `key-badge ${set ? "set" : "missing"}`;
  b.textContent = set ? "Set ✓" : "Not set — runs can't start";
}
chrome.storage.local.get("apiKey").then(({ apiKey }) => renderKeyBadge(!!String(apiKey || "").trim()));
chrome.storage.onChanged.addListener((changes) => {
  if (changes.apiKey) renderKeyBadge(!!String(changes.apiKey.newValue || "").trim());
});
