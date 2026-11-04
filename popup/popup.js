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
// The Control Center website for the active environment (Live: robobuild.builtonscram.com).
// "Open Control Center" goes to its Extension page; a run that needs you opens on its own page.
const LIVE_SITE = "https://robobuild.builtonscram.com";
function siteBase() {
  const b = data.bridge || {};
  return (b.siteBase || (b.env === "dev" ? "" : LIVE_SITE)).replace(/\/+$/, "");
}
function controlCenterUrl(page = "extension") {
  const base = siteBase();
  if (!base) return CC_APP_URL; // Dev without a website address: the Scram editor
  if (page === "run") {
    const runId = data.autopilot?.startedAt ? data.bridge?.runIds?.[String(data.autopilot.startedAt)] : null;
    return Number.isInteger(runId) ? `${base}/runs/${runId}` : `${base}/`;
  }
  return `${base}/extension`;
}
const openControlCenter = async (page = "extension") => {
  await chrome.tabs.create({ url: controlCenterUrl(page) });
  window.close();
};
$("#needsMore").addEventListener("click", () => {
  $("#needsText").classList.toggle("open");
  render();
});
$("#settings").addEventListener("click", () => openSettings("overview"));
$("#keyAdd").addEventListener("click", () => openSettings("claude"));
$("#ccSettings").addEventListener("click", () => openSettings("connection"));
$("#openCc").addEventListener("click", () => openControlCenter("extension"));
$("#needsGo").addEventListener("click", () => ($("#needsGo").textContent === "Connection settings" ? openSettings("connection") : openControlCenter("run")));
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

// Quick fixes: small things (a login, Scram credits, a closed tab) can be done right here with
// one button. Questions and choosing sites are only answered on the Control Center.
async function act(type) {
  const res = await chrome.runtime.sendMessage({ type });
  if (!res?.ok) throw new Error(res?.error || "Something went wrong.");
}
async function showTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true, state: "normal" }).catch(() => chrome.windows.update(tab.windowId, { focused: true }));
    window.close();
  } catch {
    toast("That tab was closed.");
  }
}
function button(label, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick();
    } catch (e) {
      toast(e.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

// What the run needs from you, if anything: { key, title, text, quick: [buttons], error }.
function needsYou(ap) {
  if (!ap) return null;
  const c = ap.category;
  if (ap.status === "waiting" && ap.phase === "qa") {
    const n = ap.qa?.questions?.length || 0;
    return { key: "qa", title: `❓ ${n} question${n === 1 ? "" : "s"} for you`, text: "Answer them on the Control Center — the design vibe first, then a few build questions." };
  }
  if (ap.status === "waiting" && ap.phase === "cat-confirm") {
    const left = (c?.sites || []).filter((s) => !s.decision).length;
    return { key: "confirm", title: "🗂 Confirm the suggested sites", text: `${left} site${left === 1 ? "" : "s"} to accept or skip on the Control Center.` };
  }
  if (ap.status === "waiting" && ap.phase === "cat-explore") {
    const m = c?.members?.[c.memberIndex];
    return {
      key: `catlogin:${c?.memberIndex}`,
      title: `🔑 Log in to ${m?.product || "the site"}`,
      text: "Log in (or sign up) in RoboBuild's window and open the app's main screen, then press “I'm logged in”.",
      quick: [
        button("I'm logged in", () => act("categoryLoggedIn"), "primary"),
        ...(c?.tabId != null ? [button("Show the window", () => showTab(c.tabId))] : []),
        button("Skip this site", () => act("categorySkipSite")),
      ],
    };
  }
  const reason = ap.pauseReason || ap.message || "";
  if (ap.status === "paused" && /log ?in|logged in|sign in/i.test(reason)) {
    const scram = /log in to Scram|Scram needs you to log in/i.test(reason);
    const tabId = scram ? ap.build?.tabId : ap.explore?.tabId;
    return {
      key: `login:${reason}`,
      title: scram ? "🔑 Log in to Scram" : `🔑 Log in to ${host(ap.siteUrl)}`,
      text: reason,
      quick: [button("I'm logged in", () => act("autopilotResume"), "primary"), ...(tabId != null ? [button("Show the window", () => showTab(tabId))] : [])],
    };
  }
  if (ap.status === "paused" && /No Anthropic API key set/i.test(reason))
    return { key: "nokey", title: "🔑 Add your Anthropic API key", text: "The run is paused because no Anthropic API key is set. Add it in Settings → Claude & models, then press Resume (here or on the RoboBuild site).", quick: [button("Add your API key", () => openSettings("claude"), "primary"), button("Resume", () => act("autopilotResume"))] };
  if (ap.status === "paused" && !/paused by you/i.test(reason)) return { key: `pause:${reason}`, title: "Autopilot paused", text: reason || "It needs you before it can carry on.", quick: [button("Done — continue", () => act("autopilotResume"), "primary")] };
  if (ap.status === "error") return { key: `error:${reason}`, title: "⚠️ Something went wrong", text: reason || "The run stopped with an error.", quick: [button("Try again", () => act("autopilotResume"), "primary")], error: true };
  if (ap.status === "waiting") return { key: `wait:${ap.message}`, title: "⏳ Waiting for you", text: `${ap.message || ""} See the Control Center.`.trim() };
  return null;
}

function render() {
  const b = data.bridge || {};
  const connected = !!(b.enabled && b.token && b.computerId);
  const fresh = connected && b.lastPollAt && Date.now() - b.lastPollAt < 60000;
  $("#ccBadge").className = `badge ${connected ? (fresh || b.status === "connecting" ? "on" : "off") : ""}`;
  $("#ccBadge").textContent = connected ? (b.status === "connecting" ? "connecting…" : fresh ? "● connected" : "reconnecting…") : "not connected";
  $("#openCc").classList.toggle("primary", connected);

  $("#keyWarn").classList.toggle("hidden", !!data.keySet);
  $("#keyLine").className = `key-line${data.keySet ? "" : " missing"}`;
  $("#keyLine").innerHTML = data.keySet ? "Anthropic API key: <b>Set ✓</b>" : "Anthropic API key: <b>Not set</b>";

  const ap = data.autopilot;
  const need = needsYou(ap);
  $("#needs").classList.toggle("hidden", !need);
  $("#needs").classList.toggle("err", !!need?.error);
  if (need && !need.quick && !(connected && fresh)) {
    // Keep waiting for the website — never fall back to asking here (Dev mode is the way to do that).
    need.text = connected
      ? `Waiting for an answer on the Control Center (offline — reconnecting…). ${need.text}`
      : `${need.text} The Control Center isn't connected yet — connect it (Connection settings), or turn on Dev mode to answer in the side panel.`;
  }
  $("#needsGo").textContent = !connected && need && !need.quick ? "Connection settings" : "Open Control Center ↗";
  $("#needsGo").className = need?.quick ? "" : "primary";
  // Rebuild the quick-fix buttons only when the situation changes (re-renders mustn't eat a click).
  const qk = need?.quick ? need.key : "";
  if ($("#needsQuick").dataset.key !== qk) {
    $("#needsQuick").replaceChildren(...(need?.quick || []));
    $("#needsQuick").dataset.key = qk;
  }
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
  const got = await chrome.storage.local.get(["autopilot", "bridge", "usage", "apiKey"]);
  // Only whether a key is saved — the key itself isn't kept in the popup.
  data = { autopilot: got.autopilot, bridge: got.bridge, usage: got.usage, keySet: typeof got.apiKey === "string" && got.apiKey.trim().length > 0 };
  render();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.autopilot || changes.bridge || changes.usage || changes.apiKey)) load();
});
setInterval(render, 10000); // keeps the time and the connection badge current
load();
