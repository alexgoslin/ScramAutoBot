// Normal mode: the toolbar icon opens this small popup — what the run is doing, anything it
// needs from you, and shortcuts. The Control Center (website) runs everything else.
// Dev mode switches the icon back to the full side panel.
import { totalCost, formatCost } from "../lib/pricing.js";

const $ = (s) => document.querySelector(s);
const CC_APP_URL = "https://editor.buildwithscram.com/branch/z07w3d61njwbx5lbgc5gzqk2/";
let data = {};
let windowId = null;
chrome.windows.getCurrent().then((w) => (windowId = w.id));

const SITE_TRACK = [
  ["explore", "Researching the site"],
  ["qa", "Questions for you"],
  ["handoff", "Planning the build"],
  ["scram-setup", "Setting up Scram"],
  ["build", "Building in Scram"],
  ["finished", "Finished"],
];
const CATEGORY_TRACK = [
  ["cat-propose", "Choosing sites"],
  ["cat-confirm", "Confirm the sites"],
  ["cat-explore", "Researching the sites"],
  ["cat-digest", "Summarising each site"],
  ["qa", "Questions for you"],
  ["cat-tribunal", "The tribunal is deciding"],
  ["handoff", "Planning the build"],
  ["scram-setup", "Setting up Scram"],
  ["build", "Building in Scram"],
  ["finished", "Finished"],
];
const BUILD_TRACK = SITE_TRACK.slice(3);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function openSettings(page = "overview") {
  const url = chrome.runtime.getURL(`options/options.html#${page}`);
  const [tab] = await chrome.tabs.query({ url: chrome.runtime.getURL("options/options.html*") });
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  } else await chrome.tabs.create({ url });
  window.close();
}
// Opens the Control Center — on the current run's page when the app's address and the run are known.
function controlCenterUrl() {
  const runId = data.autopilot?.startedAt ? data.bridge?.runIds?.[String(data.autopilot.startedAt)] : null;
  if (data.ccAppUrl && Number.isInteger(runId)) {
    try {
      return new URL(`/runs/${runId}`, data.ccAppUrl).href;
    } catch {
      /* fall through */
    }
  }
  return data.ccAppUrl || CC_APP_URL;
}
const openControlCenter = async () => {
  await chrome.tabs.create({ url: controlCenterUrl() });
  window.close();
};
$("#needsMore").addEventListener("click", () => {
  $("#needsText").classList.toggle("open");
  render();
});
$("#settings").addEventListener("click", () => openSettings("overview"));
$("#ccSettings").addEventListener("click", () => openSettings("connection"));
$("#openCc").addEventListener("click", openControlCenter);
$("#needsGo").addEventListener("click", () => ($("#needsGo").textContent === "Connection settings" ? openSettings("connection") : openControlCenter()));
$("#devMode").addEventListener("click", () => {
  // Open the side panel first, while the click still counts as a user gesture.
  if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {});
  chrome.storage.local.set({ uiDevMode: true }).then(() => window.close());
});
const host = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u || "";
  }
};

// What the run needs from you, if anything: { title, text, error }. The popup only tells you;
// everything is done in the Control Center (one button takes you there).
function needsYou(ap) {
  if (!ap) return null;
  const c = ap.category;
  if (ap.status === "waiting" && ap.phase === "qa") {
    const n = ap.qa?.questions?.length || 0;
    return { title: `❓ ${n} question${n === 1 ? "" : "s"} for you`, text: "Answer them in the Control Center — the design vibe first, then a few build questions." };
  }
  if (ap.status === "waiting" && ap.phase === "cat-confirm") {
    const left = (c?.sites || []).filter((s) => !s.decision).length;
    return { title: "🗂 Confirm the suggested sites", text: `${left} site${left === 1 ? "" : "s"} to accept or skip in the Control Center.` };
  }
  if (ap.status === "waiting" && ap.phase === "cat-explore") {
    const m = c?.members?.[c.memberIndex];
    return { title: `🔑 Log in to ${m?.product || "the site"}`, text: "Log in (or sign up) in the tab ScramAutoBuild opened, then press “I'm logged in — continue” in the Control Center — or skip this site there." };
  }
  const reason = ap.pauseReason || ap.message || "";
  if (ap.status === "paused" && /log ?in|logged in|sign in/i.test(reason)) return { title: `🔑 Log in to ${host(ap.siteUrl)}`, text: `Log in in the tab ScramAutoBuild opened, then press “I'm logged in — continue” in the Control Center. (${reason})` };
  if (ap.status === "paused" && !/paused by you/i.test(reason)) return { title: "Autopilot paused", text: `${reason || "It needs you before it can carry on."} Resume it from the Control Center.` };
  if (ap.status === "error") return { title: "⚠️ Something went wrong", text: `${reason || "The run stopped with an error."} Try again from the Control Center.`, error: true };
  if (ap.status === "waiting") return { title: "⏳ Waiting for you", text: `${ap.message || ""} See the Control Center.`.trim() };
  return null;
}

function render() {
  const b = data.bridge || {};
  const connected = !!(b.enabled && b.token && b.computerId);
  const fresh = connected && b.lastPollAt && Date.now() - b.lastPollAt < 60000;
  $("#ccBadge").className = `badge ${connected ? (fresh || b.status === "connecting" ? "on" : "off") : ""}`;
  $("#ccBadge").textContent = connected ? (b.status === "connecting" ? "connecting…" : fresh ? "● connected" : "reconnecting…") : "not connected";
  $("#openCc").classList.toggle("primary", connected);

  const ap = data.autopilot;
  const need = needsYou(ap);
  $("#needs").classList.toggle("hidden", !need);
  $("#needs").classList.toggle("err", !!need?.error);
  if (need && !(connected && fresh)) {
    // Keep waiting for the website — never fall back to asking here (Dev mode is the way to do that).
    need.text = connected
      ? `Waiting for an answer on the Control Center (offline — reconnecting…). ${need.text}`
      : `${need.text} The Control Center isn't connected yet — connect it (Connection settings), or turn on Dev mode to answer in the side panel.`;
  }
  $("#needsGo").textContent = !connected && need ? "Connection settings" : "Open Control Center ↗";
  if (need) {
    $("#needsTitle").textContent = need.title;
    if ($("#needsText").textContent !== need.text) {
      $("#needsText").textContent = need.text;
      $("#needsText").classList.remove("open");
    }
    // Long reasons are clamped; "Show more" reveals the rest.
    const t = $("#needsText");
    $("#needsMore").classList.toggle("hidden", !t.classList.contains("open") && t.scrollHeight <= t.clientHeight + 2);
    $("#needsMore").textContent = t.classList.contains("open") ? "Show less" : "Show more";
  }

  $("#runEmpty").classList.toggle("hidden", !!ap);
  $("#run").classList.toggle("hidden", !ap);
  $("#runBadge").className = `badge ${ap?.status || ""}`;
  $("#runBadge").textContent = ap ? { running: "● working", waiting: "needs you", paused: "paused", stopped: "stopped", error: "error", done: "✓ done" }[ap.status] || ap.status : "idle";
  if (!ap) return;

  const track = ap.mode === "category" ? CATEGORY_TRACK : ap.buildOnly ? BUILD_TRACK : SITE_TRACK;
  const idx = Math.max(0, track.findIndex(([p]) => p === ap.phase));
  const finished = ap.phase === "finished" || ap.status === "done";
  $("#runName").textContent = ap.mode === "category" ? `🗂 ${ap.category?.name || host(ap.siteUrl)}` : `🌐 ${host(ap.siteUrl)}`;
  $("#track").replaceChildren(
    ...track.map((_, i) => {
      const s = document.createElement("span");
      s.className = finished || i < idx ? "done" : i === idx ? `now${["running"].includes(ap.status) ? "" : " stuck"}` : "";
      return s;
    })
  );
  $("#stage").textContent = finished ? "✓ Finished" : track[idx]?.[1] || ap.phase;
  $("#stageNo").textContent = finished ? `${track.length} of ${track.length}` : `Stage ${idx + 1} of ${track.length}`;
  $("#runMsg").textContent = need || finished ? "" : ap.status === "paused" ? "Paused — resume it from the Control Center." : ap.status === "stopped" ? "Stopped — start it again from the Control Center." : ap.message || "";

  const ex = ap.explore || {};
  const bd = ap.build || {};
  const cm = ap.category?.members || [];
  const stats = [];
  if (ap.mode === "category" && (cm.length || ap.category?.sites?.length)) stats.push([`${cm.filter((m) => m.status === "done").length}/${cm.length || ap.category.sites.length}`, "sites"]);
  if (ap.mode !== "category" && !ap.buildOnly) stats.push([String((ex.pages || []).length), "screens"]);
  if (bd.totalSteps) stats.push([`${Math.min((bd.step || 0) + 1, bd.totalSteps)}/${bd.totalSteps}`, "steps"]);
  // Time: while working, how long it's been going; once it stops for a while, when it started.
  const end = ["running", "waiting"].includes(ap.status) ? Date.now() : ap.updatedAt || Date.now();
  const mins = Math.max(0, Math.round((end - ap.startedAt) / 60000));
  if (mins < 24 * 60) stats.push([mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`, "running time"]);
  else stats.push([new Date(ap.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }), "started"]);
  stats.push([formatCost(Math.max(0, totalCost(data.usage) - totalCost(ap.usageAtStart || data.usage))), "spent"]);
  $("#runStats").replaceChildren(
    ...stats.slice(-3).map(([v, l]) => {
      const t = document.createElement("div");
      t.className = "stat";
      const bEl = document.createElement("b");
      bEl.textContent = v;
      const lEl = document.createElement("span");
      lEl.textContent = l;
      t.append(bEl, lEl);
      return t;
    })
  );
}

async function load() {
  data = await chrome.storage.local.get(["autopilot", "bridge", "usage", "ccAppUrl"]);
  render();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.autopilot || changes.bridge || changes.usage || changes.ccAppUrl)) load();
});
setInterval(render, 10000); // keeps the time and the connection badge current
load();
