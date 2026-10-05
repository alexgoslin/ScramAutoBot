import { handoffFileName } from "../lib/storage.js";
import { totalCost, formatCost } from "../lib/pricing.js";

const $ = (sel) => document.querySelector(sel);

function downloadMd(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let currentTab = null;
let data = { sites: [], specFiles: [], handoffFiles: [], buildProgress: {}, jobs: {}, apiKey: "", activeBuild: null };
let readerContent = "";
let keepAliveTimer = null;

// ---------------------------------------------------------------------------- utils

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "Unknown error"));
      resolve(res.data);
    });
  });
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function siteUrlOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

const host = (siteUrl) => new URL(siteUrl).hostname;
const fmtDate = (iso) => new Date(iso).toLocaleString();

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 1800);
}

async function copyText(text) {
  try {
    // writeText can stall (e.g. panel not focused); never let it block the caller.
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
    toast("Copied to clipboard");
    return true;
  } catch {
    toast("Copy failed");
    return false;
  }
}

function setStatus(node, job) {
  node.className = "status";
  node.replaceChildren();
  if (!job) return;
  if (job.status === "running") {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    node.classList.add("running");
    node.append(el("span", { class: "spinner" }), el("span", {}, `${job.message} ${secs}s`));
  } else if (job.status === "error") {
    node.classList.add("error");
    node.append(job.message);
  } else if (job.status === "ok") {
    node.classList.add("ok");
    node.append(job.message);
  }
}

// ---------------------------------------------------------------------------- reader

function openReader(title, meta, content) {
  readerContent = content;
  $("#readerTitle").textContent = title;
  $("#readerMeta").textContent = meta;
  $("#readerBody").textContent = content;
  $("#reader").classList.remove("hidden");
  $("#readerBody").scrollTop = 0;
}
$("#readerBack").addEventListener("click", () => $("#reader").classList.add("hidden"));
$("#readerCopy").addEventListener("click", () => copyText(readerContent));

// ---------------------------------------------------------------------------- tabs

document.querySelectorAll(".tabs button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
  })
);

const openOptions = (e) => {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
};
$("#openOptions").addEventListener("click", openOptions);
$("#bannerOptions").addEventListener("click", openOptions);

// ---------------------------------------------------------------------------- data

async function loadData() {
  data = {
    ...data,
    ...(await chrome.storage.local.get(["sites", "specFiles", "handoffFiles", "buildProgress", "jobs", "apiKey", "activeBuild", "autopilot", "usage"])),
  };
  data.sites ||= [];
  data.specFiles ||= [];
  data.handoffFiles ||= [];
  data.buildProgress ||= {};
  data.jobs ||= {};
  render();
  manageKeepAlive();
}

async function refreshCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  render();
}

chrome.storage.onChanged.addListener((_changes, area) => area === "local" && loadData());
chrome.tabs.onActivated.addListener(refreshCurrentTab);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (currentTab && tabId === currentTab.id && (info.url || info.title || info.status === "complete")) refreshCurrentTab();
});
chrome.windows?.onFocusChanged.addListener(refreshCurrentTab);

// Claude calls can take 10–30s+; ping the service worker so Chrome doesn't
// consider it idle while a job is in flight. Also re-renders the elapsed timer.
function manageKeepAlive() {
  const running = Object.values(data.jobs).some((j) => j.status === "running");
  if (running && !keepAliveTimer) {
    let ticks = 0;
    keepAliveTimer = setInterval(() => {
      if (ticks++ % 15 === 0) send("ping").catch(() => {});
      render();
    }, 1000);
  } else if (!running && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// ---------------------------------------------------------------------------- render

function render() {
  $("#apiKeyBanner").classList.toggle("hidden", !!data.apiKey);
  renderAutopilot();
  renderCapture();
  renderSiteSelects();
  renderFiles();
  renderHandoff();
  renderBuild();
}

function renderCapture() {
  const url = currentTab?.url || "";
  const siteUrl = siteUrlOf(url);
  $("#currentTitle").textContent = currentTab?.title || "—";
  $("#currentUrl").textContent = url || "—";
  $("#currentSite").textContent = siteUrl ? host(siteUrl) : "this site";

  const job = siteUrl ? data.jobs[`capture:${siteUrl}`] : null;
  const btn = $("#captureBtn");
  btn.disabled = !siteUrl || job?.status === "running";
  btn.textContent = job?.status === "running" ? "Analysing with Claude…" : "Capture this page";
  setStatus($("#captureStatus"), siteUrl ? job : { status: "error", message: "This tab can't be captured. Switch to a website tab (http/https) and the button will turn on." });

  const list = $("#siteSpecList");
  const specs = data.specFiles.filter((s) => s.siteUrl === siteUrl).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  list.replaceChildren(
    ...(specs.length ? specs.map(specItem) : [el("li", { class: "empty" }, "No pages captured for this site yet.")])
  );
}

function specItem(spec) {
  return el(
    "li",
    { class: "item" },
    el(
      "div",
      { class: "main", onclick: () => openReader(spec.pageTitle, `${spec.pageUrl} · ${fmtDate(spec.capturedAt)}`, spec.content) },
      el("div", { class: "title" }, spec.pageTitle),
      el("div", { class: "sub" }, `${new URL(spec.pageUrl).pathname} · ${fmtDate(spec.capturedAt)}`)
    ),
    el("button", { class: "small", title: "Copy", onclick: () => copyText(spec.content) }, "Copy"),
    el(
      "button",
      {
        class: "small ghost",
        title: "Delete",
        onclick: async () => {
          if (!confirm(`Delete spec for "${spec.pageTitle}"?`)) return;
          const specFiles = data.specFiles.filter((s) => s.id !== spec.id);
          await chrome.storage.local.set({ specFiles });
        },
      },
      "✕"
    )
  );
}

// ---- one site picker shared by Files, Handoff and Build. It opens on the most recently cloned
// site, and jumps to a newer one when you start cloning it; picking a site by hand sticks
// (in all three tabs) until another site becomes the most recent.
let selectedSite = null;
let lastMostRecent = null;

function sitesByRecency() {
  const latest = new Map();
  const bump = (site, when) => {
    if (!site || !when) return;
    const t = typeof when === "number" ? when : Date.parse(when) || 0;
    latest.set(site, Math.max(latest.get(site) || 0, t));
  };
  for (const s of data.specFiles) bump(s.siteUrl, s.capturedAt);
  for (const f of data.handoffFiles) bump(f.siteUrl, f.createdAt);
  for (const s of data.sites) bump(s.siteUrl, s.lastCapturedAt || s.firstCapturedAt);
  if (data.autopilot?.siteUrl) bump(data.autopilot.siteUrl, data.autopilot.startedAt);
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([site]) => site);
}

function renderSiteSelects() {
  const sites = sitesByRecency();
  const mostRecent = sites[0] || null;
  if (mostRecent !== lastMostRecent) {
    selectedSite = mostRecent; // a newer clone appeared (or the panel just opened)
    lastMostRecent = mostRecent;
  }
  if (!sites.includes(selectedSite)) selectedSite = mostRecent;
  const pages = (site) => data.specFiles.filter((s) => s.siteUrl === site).length;
  const steps = (site) => data.handoffFiles.filter((f) => f.siteUrl === site && f.fileType === "step").length;
  for (const select of document.querySelectorAll(".site-select")) {
    select.replaceChildren(
      ...(sites.length
        ? sites.map((site, i) =>
            el("option", { value: site }, `${host(site)}${i === 0 ? " (latest)" : ""} — ${pages(site)} page${pages(site) === 1 ? "" : "s"} · ${steps(site)} step${steps(site) === 1 ? "" : "s"}`)
          )
        : [el("option", { value: "" }, "No sites captured yet")])
    );
    select.value = selectedSite || "";
    select.disabled = !sites.length;
  }
}
document.querySelectorAll(".site-select").forEach((select) =>
  select.addEventListener("change", () => {
    selectedSite = select.value;
    render();
  })
);

function renderFiles() {
  const siteUrl = selectedSite;
  const specs = data.specFiles.filter((s) => s.siteUrl === siteUrl).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  $("#filesList").replaceChildren(
    specs.length
      ? el("ul", { class: "list" }, specs.map(specItem))
      : el("div", { class: "empty" }, siteUrl ? "No spec files for this site." : "No spec files yet. Capture a page from the Capture tab, or run Autopilot.")
  );
}

// "4.2k chars (~1.1k tokens) · 5 checks" — tokens are roughly chars / 4.
function sizeLabel(f) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const items = f.fileType === "step" ? f.checklistItems ?? (f.content.match(/^\s*[-*]\s*\[[ xX]\]/gm) || []).length : null;
  return `${k(f.content.length)} chars (~${k(Math.round(f.content.length / 4))} tokens)${items != null ? ` · ${items} check${items === 1 ? "" : "s"}` : ""}`;
}

function renderHandoff() {
  const siteUrl = selectedSite;
  const job = siteUrl ? data.jobs[`handoff:${siteUrl}`] : null;
  const count = data.specFiles.filter((s) => s.siteUrl === siteUrl).length;
  const btn = $("#generateBtn");
  btn.disabled = !siteUrl || !count || job?.status === "running";
  $("#downloadAllBtn").classList.toggle("hidden", !data.handoffFiles.some((f) => f.siteUrl === siteUrl && !f.raw));
  btn.textContent =
    job?.status === "running" ? "Generating handoff…" : siteUrl ? `Generate Handoff for ${host(siteUrl)} (${count} page${count === 1 ? "" : "s"})` : "Generate Handoff";
  setStatus($("#handoffStatus"), job);

  const files = data.handoffFiles.filter((f) => f.siteUrl === siteUrl);
  const order = { manifest: 0, combined: 1, step: 2 };
  files.sort((a, b) => order[a.fileType] - order[b.fileType] || (a.stepNumber ?? 0) - (b.stepNumber ?? 0));

  $("#handoffList").replaceChildren(
    ...(files.length
      ? files.map((f) => {
          const label = f.fileType === "step" ? `Step ${f.stepNumber}` : f.fileType === "manifest" ? "Manifest" : "Combined";
          return el(
            "li",
            { class: "item" },
            el("span", { class: "badge" }, label),
            el(
              "div",
              { class: "main", onclick: () => openReader(f.fileType === "step" ? `Step ${f.stepNumber}: ${f.title}` : f.title, `${host(f.siteUrl)} · ${fmtDate(f.createdAt)}`, f.content) },
              el("div", { class: "title" }, f.title),
              el("div", { class: "sub" }, sizeLabel(f))
            ),
            el("button", { class: "small", onclick: () => copyText(f.content) }, "Copy"),
            el("button", { class: "small ghost", title: `Download ${handoffFileName(f)}`, onclick: () => downloadMd(handoffFileName(f), f.content) }, "⬇ .md")
          );
        })
      : [el("li", { class: "empty" }, siteUrl ? "No handoff generated for this site yet." : "Capture some pages first.")])
  );
}

function renderBuild() {
  const siteUrl = selectedSite;
  const steps = data.handoffFiles.filter((f) => f.siteUrl === siteUrl && f.fileType === "step").sort((a, b) => a.stepNumber - b.stepNumber);
  const progress = data.buildProgress[siteUrl] || { currentStep: steps[0]?.stepNumber ?? 0, completedSteps: [] };
  const done = new Set(progress.completedSteps);
  const isActive = data.activeBuild === siteUrl;

  $("#buildBtn").disabled = !steps.length;
  $("#buildBtn").textContent = done.size && isActive ? "Re-open Scram & continue" : "Build in Scram";
  $("#resetBuildBtn").disabled = !steps.length;
  $("#stopBuildBtn").disabled = !isActive;

  const finished = steps.length && steps.every((s) => done.has(s.stepNumber));
  if (steps.length) {
    setStatus($("#buildStatus"), {
      status: "ok",
      message: finished ? `All ${steps.length} steps done 🎉` : `${done.size} of ${steps.length} steps done${isActive ? " · build active" : ""}`,
    });
  } else setStatus($("#buildStatus"), null);

  $("#buildList").replaceChildren(
    ...(steps.length
      ? steps.map((s) => {
          const isDone = done.has(s.stepNumber);
          const isCurrent = !isDone && s.stepNumber === progress.currentStep;
          return el(
            "li",
            { class: `item ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}` },
            el("span", { class: `badge ${isDone ? "done" : isCurrent ? "current" : ""}` }, isDone ? "✓" : s.stepNumber),
            el(
              "div",
              { class: "main", onclick: () => openReader(`Step ${s.stepNumber}: ${s.title}`, host(s.siteUrl), s.content) },
              el("div", { class: "title" }, s.title),
              el("div", { class: "sub" }, isDone ? "Done" : isCurrent ? "Current step" : "Queued")
            ),
            el(
              "button",
              {
                class: "small",
                title: "Copy to clipboard and paste into the Scram AI chat",
                onclick: async () => {
                  await copyText(s.content);
                  try {
                    const res = await send("sendStep", { siteUrl, stepNumber: s.stepNumber });
                    toast(res.opened ? "Opened Scram — step copied, it'll be pasted when the chat appears" : "Sent to Scram");
                  } catch (e) {
                    toast(e.message);
                  }
                },
              },
              "Send to Scram"
            ),
            isDone
              ? el("button", { class: "small ghost", title: "Mark not done", onclick: () => send("uncompleteStep", { siteUrl, stepNumber: s.stepNumber }) }, "↺")
              : el("button", { class: "small ok", title: "Mark done and send the next step", onclick: () => send("completeStep", { siteUrl, stepNumber: s.stepNumber }) }, "Done")
          );
        })
      : [el("li", { class: "empty" }, "Generate a handoff first (Handoff tab).")])
  );
}

// ---------------------------------------------------------------------------- actions

// ---------------------------------------------------------------------------- autopilot

const PHASES = {
  explore: "1/4 · Exploring the site",
  handoff: "2/4 · Generating build steps",
  "scram-setup": "3/4 · Setting up Scram",
  build: "4/4 · Building in Scram",
  finished: "Finished",
};

function renderAutopilot() {
  const ap = data.autopilot;
  const siteUrl = siteUrlOf(currentTab?.url || "");
  const active = ap && ["running", "paused"].includes(ap.status);
  const badge = $("#apBadge");
  badge.className = `badge ${ap?.status || ""}`;
  badge.textContent = ap?.status || "idle";

  $("#apStart").disabled = active || !siteUrl || !data.apiKey;
  $("#apStart").textContent = siteUrl ? `🚀 Autopilot ${host(siteUrl)}` : "🚀 Open a website to Autopilot it";
  $("#apStart").classList.toggle("hidden", !!active);
  $("#apInstructions").classList.toggle("hidden", !!active);
  $("#apInstructionsLabel").classList.toggle("hidden", !!active);
  $("#apIntro").classList.toggle("hidden", !!ap);
  $("#apRunInstructions").textContent = ap?.instructions ? `Your instructions: ${ap.instructions}` : "";
  // Cost: this run (since it started) and everything this extension has spent.
  const spent = totalCost(data.usage);
  $("#apCostTotal").textContent = `${data.usage?.costEstimated ? "≈" : ""}${formatCost(spent)}`;
  $("#apCostRun").textContent = ap ? formatCost(Math.max(0, spent - totalCost(ap.usageAtStart || data.usage))) : "—";
  $("#apStatus").classList.toggle("hidden", !ap);
  if (!ap) return;

  $("#apPhase").textContent = `${host(ap.siteUrl)} — ${PHASES[ap.phase] || ap.phase}`;
  $("#apMessage").textContent = ap.status === "paused" || ap.status === "error" ? `⚠️ ${ap.pauseReason || ap.message}` : ap.message || "";
  const ex = ap.explore || {};
  const b = ap.build || {};
  const mins = Math.round((Date.now() - ap.startedAt) / 60000);
  const now = data.usage || { input: 0, output: 0, calls: 0 };
  const base = ap.usageAtStart || now; // runs started before this field existed: count from here
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const usage = ` · this run: ${now.calls - (base.calls || 0)} Claude calls, ${k(now.input - base.input)} in / ${k(now.output - base.output)} out tokens`;
  const parts = [`${(ex.pages || []).length} screens explored, ${(ex.queue || []).length} queued`];
  if (b.totalSteps) parts.push(`step ${Math.min(b.step + 1, b.totalSteps)} of ${b.totalSteps}${b.rounds ? ` (round ${b.rounds})` : ""}`);
  $("#apCounters").textContent = `${parts.join(" · ")} · ${mins} min${usage}`;

  $("#apStop").classList.toggle("hidden", !active);
  $("#apResume").classList.toggle("hidden", !["paused", "stopped", "error"].includes(ap.status));
  $("#apReset").classList.toggle("hidden", !!active);

  const log = $("#apLog");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.replaceChildren(
    ...(ap.log || []).slice(-80).map((l) => {
      const kind = l.msg.startsWith("💬 You:") ? "you" : l.msg.startsWith("🤖 Autopilot:") ? "bot" : "";
      return el("li", kind ? { class: kind } : {}, `${new Date(l.t).toLocaleTimeString()} ${l.msg}`);
    })
  );
  if (!log.classList.contains("hidden") && atBottom) log.scrollTop = log.scrollHeight;
  // The chat box sits under the log and works while Autopilot is running or paused.
  $("#apChat").classList.toggle("hidden", log.classList.contains("hidden") || !active);
}

$("#apStart").addEventListener("click", async () => {
  if (!currentTab) return;
  const ok = confirm(
    `Autopilot will now, without asking again:\n\n` +
      `• explore ${host(siteUrlOf(currentTab.url))} in a new tab, clicking controls (including likes, follows, toggles — undone afterwards) and typing into text boxes without submitting. It never logs out, deletes, pays, or posts/sends content. Change this under Settings → Exploration mode.\n` +
      `• write a spec per screen, generate the build steps,\n` +
      `• open Scram, create the project, and drive its AI bot through every step — answering questions and approving plans.\n\n` +
      `It uses your Anthropic API credits and your Scram credits. Leave its tabs alone while it works; you can Stop at any time.`
  );
  if (!ok) return;
  try {
    await send("autopilotStart", { tabId: currentTab.id, instructions: $("#apInstructions").value.trim() });
  } catch (e) {
    toast(e.message);
  }
});
// Keep the instructions draft between panel openings.
chrome.storage.local.get("autopilotInstructions").then(({ autopilotInstructions }) => {
  if (autopilotInstructions && !$("#apInstructions").value) $("#apInstructions").value = autopilotInstructions;
});
$("#apInstructions").addEventListener("input", () => chrome.storage.local.set({ autopilotInstructions: $("#apInstructions").value }));

$("#apStop").addEventListener("click", () => send("autopilotStop").catch((e) => toast(e.message)));
$("#apResume").addEventListener("click", () => send("autopilotResume").catch((e) => toast(e.message)));
$("#apReset").addEventListener("click", () => send("autopilotReset").catch((e) => toast(e.message)));
$("#apLogToggle").addEventListener("click", () => {
  const log = $("#apLog");
  log.classList.toggle("hidden");
  $("#apLogToggle").textContent = log.classList.contains("hidden") ? "Show log" : "Hide log";
  log.scrollTop = log.scrollHeight;
  renderAutopilot();
  if (!log.classList.contains("hidden")) $("#apChatInput").focus();
});
$("#apChat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#apChatInput");
  const text = input.value.trim();
  if (!text) return;
  $("#apChatSend").disabled = true;
  try {
    await send("autopilotNote", { text });
    input.value = "";
    $("#apLog").scrollTop = $("#apLog").scrollHeight;
  } catch (err) {
    toast(err.message);
  } finally {
    $("#apChatSend").disabled = false;
    input.focus();
  }
});

$("#captureBtn").addEventListener("click", async () => {
  if (!currentTab) return;
  // Mark as running locally right away; the worker also writes job state to storage.
  const siteUrl = siteUrlOf(currentTab.url);
  data.jobs[`capture:${siteUrl}`] = { status: "running", message: "Reading page…", startedAt: Date.now() };
  render();
  manageKeepAlive();
  try {
    const spec = await send("capture", { tabId: currentTab.id });
    toast(`Captured “${spec.pageTitle}”`);
  } catch (e) {
    setStatus($("#captureStatus"), { status: "error", message: e.message });
  }
});

$("#generateBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  if (!siteUrl) return;
  data.jobs[`handoff:${siteUrl}`] = { status: "running", message: "Preparing specs…", startedAt: Date.now() };
  render();
  manageKeepAlive();
  try {
    const files = await send("generateHandoff", { siteUrl });
    toast(`Generated ${files.filter((f) => f.fileType === "step").length} steps`);
  } catch (e) {
    setStatus($("#handoffStatus"), { status: "error", message: e.message });
  }
});

$("#downloadAllBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  const files = data.handoffFiles.filter((f) => f.siteUrl === siteUrl && !f.raw);
  // Chrome may ask once to allow multiple downloads from the extension.
  for (const f of files) {
    downloadMd(handoffFileName(f), f.content);
    await new Promise((r) => setTimeout(r, 250));
  }
  toast(`Downloaded ${files.length} file(s)`);
});

$("#buildBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  if (!siteUrl) return;
  const steps = data.handoffFiles.filter((f) => f.siteUrl === siteUrl && f.fileType === "step").sort((a, b) => a.stepNumber - b.stepNumber);
  const progress = data.buildProgress[siteUrl];
  const current = steps.find((s) => s.stepNumber === progress?.currentStep && !progress.completedSteps.includes(s.stepNumber)) || steps[0];
  // Put the step on the clipboard too, so a manual paste always works.
  if (current) await copyText(current.content);
  try {
    await send("startBuild", { siteUrl });
  } catch (e) {
    setStatus($("#buildStatus"), { status: "error", message: e.message });
  }
});

$("#resetBuildBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  if (siteUrl && confirm("Mark all steps as not done?")) await send("resetBuild", { siteUrl });
});

$("#stopBuildBtn").addEventListener("click", () => send("stopBuild"));

// ---------------------------------------------------------------------------- init

refreshCurrentTab();
loadData();
