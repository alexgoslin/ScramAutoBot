import { handoffFileName } from "../lib/storage.js";
import { totalCost, formatCost } from "../lib/pricing.js";

// ---- Two areas: "site" (single-site cloning, as before) and "category" (category cloning).
const isCategoryKey = (u) => {
  try {
    return new URL(u).hostname.endsWith(".category");
  } catch {
    return false;
  }
};
let uiMode = "site";
try {
  uiMode = localStorage.getItem("uiMode") === "category" ? "category" : "site";
} catch {
  /* storage unavailable: default */
}

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

// confirm() popups don't work in Chrome's side panel (they return "cancel" without showing),
// so ask inside the panel instead. Resolves true/false.
function askConfirm(message, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const box = $("#confirmBox");
    $("#confirmText").textContent = message;
    $("#confirmYes").textContent = ok;
    $("#confirmYes").classList.toggle("danger-confirm", danger);
    box.classList.remove("hidden");
    const done = (v) => {
      box.classList.add("hidden");
      $("#confirmYes").onclick = $("#confirmNo").onclick = box.onclick = document.onkeydown = null;
      resolve(v);
    };
    $("#confirmYes").onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
    box.onclick = (e) => e.target === box && done(false);
    document.onkeydown = (e) => e.key === "Escape" && done(false);
    $("#confirmYes").focus();
  });
}

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
  const keys = ["sites", "specFiles", "handoffFiles", "buildProgress", "jobs", "apiKey", "activeBuild", "autopilot", "usage", "briefings", "categoryDocs", "designBriefs"];
  const got = await chrome.storage.local.get(keys);
  // Keys that were removed (e.g. a wiped Autopilot run) must not linger from the last load.
  data = { ...data, ...Object.fromEntries(keys.map((k) => [k, got[k] ?? null])) };
  data.sites ||= [];
  data.specFiles ||= [];
  data.handoffFiles ||= [];
  data.buildProgress ||= {};
  data.jobs ||= {};
  data.briefings ||= [];
  data.apiKey ||= "";
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
  applyMode(); // after renderAutopilot: it decides which single-site controls show
  renderCategory();
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
          if (!(await askConfirm(`Delete the spec file for "${spec.pageTitle}"?`, { ok: "Delete", danger: true }))) return;
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
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([site]) => site)
    .filter((site) => (uiMode === "category") === isCategoryKey(site)); // each area lists only its own
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

// The run's design concept (from the design questions), shown at the top of Files.
function designItem(siteUrl) {
  const d = data.designBriefs?.[siteUrl];
  if (!d) return [];
  return [
    el("h3", { class: "section-title" }, "Design"),
    el("ul", { class: "list" }, [
      el("li", { class: "item" },
        el("div", { class: "main", onclick: () => openReader("🎨 Design concept", fmtDate(d.createdAt), d.content) }, el("div", { class: "title" }, "🎨 Design concept"), el("div", { class: "sub" }, d.concept)),
        el("button", { class: "small", title: "Copy", onclick: () => copyText(d.content) }, "Copy")),
    ]),
  ];
}

function renderFiles() {
  const siteUrl = selectedSite;
  if (siteUrl && isCategoryKey(siteUrl)) {
    // Category: its research & tribunal documents, then every crawled screen grouped by site.
    const docs = (data.categoryDocs?.[siteUrl] || []).slice().sort((a, b) => a.title.localeCompare(b.title));
    const specs = data.specFiles.filter((x) => x.categoryKey === siteUrl);
    const bySite = {};
    for (const x of specs) (bySite[x.categoryProduct || x.siteUrl] ||= []).push(x);
    const docItem = (d) =>
      el("li", { class: "item" }, el("div", { class: "main", onclick: () => openReader(d.title, fmtDate(d.savedAt), d.content) }, el("div", { class: "title" }, d.title), el("div", { class: "sub" }, `${Math.round(d.content.length / 100) / 10}k chars`)), el("button", { class: "small", title: "Copy", onclick: () => copyText(d.content) }, "Copy"));
    $("#filesList").replaceChildren(
      ...designItem(siteUrl),
      ...(docs.length ? [el("h3", { class: "section-title" }, "Research & tribunal"), el("ul", { class: "list" }, docs.map(docItem))] : []),
      ...Object.entries(bySite).flatMap(([name, list]) => [el("h3", { class: "section-title" }, `${name} — ${list.length} screen(s)`), el("ul", { class: "list" }, list.map(specItem))]),
      ...(!docs.length && !specs.length ? [el("div", { class: "empty" }, "Nothing researched for this category yet.")] : [])
    );
    return;
  }
  const specs = data.specFiles.filter((s) => s.siteUrl === siteUrl).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  $("#filesList").replaceChildren(
    ...designItem(siteUrl),
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
  const count = isCategoryKey(siteUrl || "")
    ? (data.categoryDocs?.[siteUrl] || []).filter((d) => /blueprint/i.test(d.title)).length
    : data.specFiles.filter((s) => s.siteUrl === siteUrl).length;
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

  const apBusy = data.autopilot && ["running", "paused", "waiting"].includes(data.autopilot.status);
  $("#buildBtn").disabled = !steps.length || apBusy;
  $("#buildBtn").title = apBusy ? "Autopilot is busy with another run — Stop (and Clear) it on the Capture tab first." : "";
  $("#manualBuildBtn").disabled = !steps.length;
  $("#manualBuildBtn").textContent = done.size && isActive ? "Re-open Scram & continue (manual)" : "Manual build (paste steps yourself)";
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
  explore: "1/5 · Exploring the site",
  qa: "2/5 · Questions for you",
  handoff: "3/5 · Generating build steps",
  "scram-setup": "4/5 · Setting up Scram",
  build: "5/5 · Building in Scram",
  finished: "Finished",
};

function renderAutopilot() {
  const ap = data.autopilot;
  const siteUrl = siteUrlOf(currentTab?.url || "");
  const active = ap && ["running", "paused", "waiting"].includes(ap.status);
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

  const sc = ap.scope;
  $("#apScope").textContent = sc?.core?.length
    ? `🎯 Cloning the core: ${sc.core.map((f) => f.name).join(", ")}${sc.skip?.length ? ` · skipping: ${sc.skip.map((f) => f.name).join(", ")}` : ""}`
    : "";
  $("#apPhase").textContent = `${host(ap.siteUrl)} — ${PHASES[ap.phase] || ap.phase}`;
  $("#apMessage").textContent = ap.status === "paused" || ap.status === "error" ? `⚠️ ${ap.pauseReason || ap.message}` : ap.message || "";
  const ex = ap.explore || {};
  const b = ap.build || {};
  const mins = Math.round((Date.now() - ap.startedAt) / 60000);
  const now = data.usage || { input: 0, output: 0, calls: 0 };
  const base = ap.usageAtStart || now; // runs started before this field existed: count from here
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const usage = ` · this run: ${now.calls - (base.calls || 0)} Claude calls, ${k(now.input - base.input)} in / ${k(now.output - base.output)} out tokens`;
  const cm = ap.category?.members || [];
  const parts =
    ap.mode === "category"
      ? [`${cm.filter((m) => m.status === "done").length}/${cm.length || ap.category?.sites?.length || 0} sites explored, ${cm.reduce((n, m) => n + (m.explore?.pages?.length || 0), 0)} screens`]
      : [`${(ex.pages || []).length} screens explored, ${(ex.queue || []).length} queued`];
  if (b.totalSteps) parts.push(`step ${Math.min(b.step + 1, b.totalSteps)} of ${b.totalSteps}${b.rounds ? ` (round ${b.rounds})` : ""}`);
  $("#apCounters").textContent = `${parts.join(" · ")} · ${mins} min${usage}`;

  // The research briefing for this run (written after the Q&A; just for reading).
  const brief = (data.briefings || []).find((x) => x.id === String(ap.startedAt));
  $("#apBriefing").classList.toggle("hidden", !brief);
  if (brief) {
    $("#apBriefingOpen").disabled = brief.status !== "done";
    $("#apBriefingState").textContent =
      brief.status === "done" ? "what I researched and what I'll build" : brief.status === "writing" ? "writing…" : `couldn't write it (${brief.error || "error"})`;
  }

  renderQA(ap);
  $("#apStop").classList.toggle("hidden", !active);
  $("#apPause").classList.toggle("hidden", ap.status !== "running");
  $("#apResume").classList.toggle("hidden", !["paused", "stopped", "error"].includes(ap.status));
  $("#apReset").classList.toggle("hidden", !!active);

  const log = $("#apLog");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.replaceChildren(
    ...(ap.log || []).slice(-80).map((l) => {
      const kind = l.msg.startsWith("💬 You:") ? "you" : l.msg.startsWith("🤖 Autopilot:") ? "bot" : "";
      return el("li", kind ? { class: kind } : {}, `${new Date(l.t).toLocaleTimeString()} ${l.msg}`);
    }),
    ...(ap.replying && Date.now() - ap.replying < 180000 ? [el("li", { class: "bot typing" }, "🤖 Autopilot is thinking…")] : [])
  );
  if (atBottom) log.scrollTop = log.scrollHeight;
  // The log and the chat box under it are always shown: message Autopilot while it works, or
  // pause it and talk it through (it answers you here), then Resume.
  $("#apChat").classList.remove("hidden");
  $("#apChatInput").placeholder =
    ap.status === "running" ? "Message Autopilot… e.g. tell Scram to use blue buttons" : ap.status === "done" ? "Ask Autopilot about this run…" : "Ask Autopilot anything, or tell it what to change before you Resume…";
}

// ---- Q&A form (built once per set of questions, so choices survive re-renders)
let qaKey = null;
function renderQA(ap) {
  const waiting = ap?.status === "waiting" && ap.phase === "qa" && ap.qa?.questions?.length;
  $("#apQA").classList.toggle("hidden", !waiting);
  if (!waiting) {
    qaKey = null;
    return;
  }
  const key = `${ap.startedAt}:${ap.qa.askedAt}`;
  if (key === qaKey) return;
  qaKey = key;
  $("#apQAList").replaceChildren(
    ...ap.qa.questions.map((q) =>
      el(
        "fieldset",
        { class: "qa-q", "data-id": q.id },
        el("legend", {}, q.kind === "design" ? `🎨 ${q.question}` : q.question),
        q.why ? el("div", { class: "muted small-text" }, q.why) : null,
        q.from ? el("div", { class: "qa-from small-text" }, `📍 Noticed while crawling: ${q.from}`) : null,
        ...q.options.map((o, i) =>
          el("label", { class: "qa-opt" }, el("input", { type: "radio", name: `qa-${q.id}`, value: o, ...(i === q.recommended ? { checked: "checked" } : {}) }), ` ${o}${i === q.recommended ? " ⭐" : ""}`)
        ),
        el("input", { type: "text", class: "qa-other", placeholder: "Or type your own answer…" })
      )
    )
  );
}
function collectAnswers() {
  const answers = {};
  for (const fs of document.querySelectorAll("#apQAList .qa-q")) {
    const typed = fs.querySelector(".qa-other").value.trim();
    answers[fs.dataset.id] = typed || fs.querySelector("input[type=radio]:checked")?.value || "";
  }
  return answers;
}
$("#apBriefingOpen").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL(`tools/briefing.html?id=${encodeURIComponent(String(data.autopilot?.startedAt || ""))}`) })
);
$("#apQASubmit").addEventListener("click", () => send("autopilotAnswer", { answers: collectAnswers() }).catch((e) => toast(e.message)));
$("#apQARecommended").addEventListener("click", () => send("autopilotAnswer", { answers: {} }).catch((e) => toast(e.message)));

$("#apStart").addEventListener("click", async () => {
  if (!currentTab) return;
  const ok = await askConfirm(
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
$("#apPause").addEventListener("click", () => send("autopilotPause").catch((e) => toast(e.message)));
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

// Autopilot build from the existing step files (no crawl / questions / new steps).
$("#buildBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  if (!siteUrl) return;
  const n = data.handoffFiles.filter((f) => f.siteUrl === siteUrl && f.fileType === "step").length;
  const ok = await askConfirm(
    `Autopilot will build ${host(siteUrl)} in Scram from its ${n} existing step files:\n\n` +
      `• open Scram and create a new project,\n• switch on Run mode and drive Scram's AI through every step (answering its questions, keeping it testing),\n• then test the finished app itself and send Scram's AI a fix list.\n\n` +
      `No new crawl, questions or step files. It uses your Anthropic API and Scram credits. Follow it, pause it or chat with it in the Autopilot card on the Capture tab.`,
    { ok: "Start building" }
  );
  if (!ok) return;
  try {
    await send("autopilotBuildFrom", { siteUrl, instructions: $("#apInstructions").value.trim() });
    document.querySelector('[role=tab][data-tab="capture"]')?.click(); // show the Autopilot card
    toast("Autopilot is building — follow it here.");
  } catch (e) {
    setStatus($("#buildStatus"), { status: "error", message: e.message });
  }
});

// The old manual build: open Scram and paste each step yourself.
$("#manualBuildBtn").addEventListener("click", async () => {
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
  if (siteUrl && (await askConfirm("Mark all steps as not done?"))) await send("resetBuild", { siteUrl });
});

$("#stopBuildBtn").addEventListener("click", () => send("stopBuild"));

// ---------------------------------------------------------------------------- init

refreshCurrentTab();
loadData();

// ---- wipe stored data for a site (or all sites)
$("#wipeSiteBtn").addEventListener("click", async () => {
  const siteUrl = selectedSite;
  if (!siteUrl) return toast("No site selected.");
  const specs = data.specFiles.filter((s) => s.siteUrl === siteUrl).length;
  const steps = data.handoffFiles.filter((f) => f.siteUrl === siteUrl).length;
  if (!(await askConfirm(`Wipe everything saved for ${host(siteUrl)}?\n\n${specs} spec file(s), ${steps} handoff/step file(s), its build progress, research briefings and its Autopilot run. This can't be undone.`, { ok: "Wipe", danger: true }))) return;
  try {
    await send("wipeSite", { siteUrl });
    selectedSite = null;
    toast(`Wiped ${host(siteUrl)}.`);
  } catch (e) {
    toast(e.message);
  }
});
$("#wipeAllBtn").addEventListener("click", async () => {
  const n = sitesByRecency().length;
  if (!(await askConfirm(`Wipe the data for ALL ${n} site(s)?\n\nEvery spec file, handoff/step file, build progress, research briefing and finished Autopilot run. Your API key, settings, cost totals and what it learned about Scram are kept. This can't be undone.`, { ok: "Wipe all", danger: true }))) return;
  try {
    await send("wipeAllSites");
    selectedSite = null;
    toast("Wiped all site data.");
  } catch (e) {
    toast(e.message);
  }
});

// ---------------------------------------------------------------------------- category clone area

const CAT_PHASES = {
  "cat-propose": "Finding sites to research",
  "cat-confirm": "Confirm the sites",
  "cat-explore": "Exploring the sites",
  "cat-digest": "Digesting each site",
  "cat-tribunal": "Tribunal",
};
Object.assign(PHASES, CAT_PHASES);

function applyMode() {
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === uiMode));
  const cat = uiMode === "category";
  const capBtn = document.querySelector('[role=tab][data-tab="capture"]');
  const catBtn = document.querySelector('[role=tab][data-tab="category"]');
  capBtn.classList.toggle("hidden", cat);
  catBtn.classList.toggle("hidden", !cat);
  const active = document.querySelector(".tabs button.active");
  if (active?.classList.contains("hidden")) (cat ? catBtn : capBtn).click();
  // The Autopilot card (status, log, chat, Pause/Resume) lives in whichever area is showing.
  const card = $("#apCard");
  const home = cat ? $("#catApSlot") : $("#tab-capture");
  if (card.parentElement !== home) home.prepend(card);
  // Single-site start controls only in the site area.
  for (const id of ["#apStart", "#apInstructions", "#apInstructionsLabel", "#apIntro"]) if (cat) $(id).classList.add("hidden");
}

document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    uiMode = b.dataset.mode;
    try {
      localStorage.setItem("uiMode", uiMode);
    } catch {
      /* ignore */
    }
    selectedSite = null;
    lastMostRecent = undefined;
    render();
  })
);

let catSiteKey = null;
function renderCategory() {
  const ap = data.autopilot;
  const run = ap?.mode === "category" ? ap : null;
  const c = run?.category;
  const busy = ap && ["running", "paused", "waiting"].includes(ap.status);
  $("#catStart").disabled = !!busy || !data.apiKey;
  $("#catStart").title = busy ? "Autopilot is busy — Stop (and Clear) its current run first." : "";
  $("#catStartCard").classList.toggle("hidden", !!(run && busy));

  // Confirm the suggested sites one at a time.
  const confirming = run && run.phase === "cat-confirm" && run.status === "waiting" && c.confirmIndex >= 0;
  $("#catConfirm").classList.toggle("hidden", !confirming);
  if (confirming) {
    const site = c.sites[c.confirmIndex];
    $("#catConfirmCount").textContent = `(${c.confirmIndex + 1} of ${c.sites.length})`;
    $("#catSiteName").textContent = site.product + (site.fromDataset ? "" : " (not in the dataset)");
    $("#catSiteWhy").textContent = site.why || "";
    const key = `${run.startedAt}:${c.confirmIndex}`;
    if (catSiteKey !== key) {
      catSiteKey = key;
      $("#catSiteUrl").value = site.url;
    }
    $("#catSiteList").replaceChildren(
      ...c.sites.map((x, i) => el("li", { class: x.decision === "yes" ? "yes" : x.decision === "no" ? "no" : i === c.confirmIndex ? "current" : "" }, `${x.product} — ${x.url}`))
    );
  }

  // Log in / sign up on the current site, then explore it.
  const m = run?.phase === "cat-explore" ? c.members[c.memberIndex] : null;
  const login = !!(m && m.status === "login" && run.status === "waiting");
  $("#catLogin").classList.toggle("hidden", !login);
  if (login) $("#catLoginName").textContent = `${m.product} (${c.memberIndex + 1} of ${c.members.length})`;

  // Research & tribunal documents for the category shown in the Files tab or the current run.
  const key = run?.siteUrl || (isCategoryKey(selectedSite || "") ? selectedSite : null);
  const docs = (key && data.categoryDocs?.[key]) || [];
  $("#catDocsCard").classList.toggle("hidden", !docs.length);
  $("#catDocs").replaceChildren(
    ...docs
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((d) => el("li", { class: "item" }, el("div", { class: "main", onclick: () => openReader(d.title, `${new URL(key).hostname} · ${fmtDate(d.savedAt)}`, d.content) }, el("div", { class: "title" }, d.title), el("div", { class: "sub" }, `${Math.round(d.content.length / 100) / 10}k chars`)), el("button", { class: "small", title: "Copy", onclick: () => copyText(d.content) }, "Copy")))
  );
  // Re-run the tribunal on the saved research — not while a run is busy with this category.
  const job = key ? data.jobs[`handoff:${key}`] : null;
  const keyBusy = !!run && run.siteUrl === key && ["running", "paused", "waiting"].includes(run.status);
  const canRetry = docs.some((d) => /^Digest — /.test(d.title));
  $("#catRetribunal").classList.toggle("hidden", !canRetry || keyBusy);
  $("#catRetribunal").disabled = job?.status === "running";
  $("#catRetribunal").textContent = job?.status === "running" ? "⚖️ Tribunal running…" : "⚖️ Re-run the tribunal";
  $("#catRetribunal").dataset.key = key || "";
  setStatus($("#catRetribStatus"), canRetry && !keyBusy ? job : null);
}

$("#catRetribunal").addEventListener("click", async () => {
  const key = $("#catRetribunal").dataset.key;
  if (!key) return;
  const ok = await askConfirm(
    "Re-run the tribunal on the research already saved (no re-crawl)?\n\n• The organiser sets out the product vision and points of debate, the three advocates argue, the judge writes a blueprint, a product critic reviews it, and the judge revises it.\n• Then the build steps are rewritten from the new blueprint (the old tribunal documents and steps are replaced).\n\nIt uses a fair amount of Anthropic API credit.",
    { ok: "Re-run" }
  );
  if (!ok) return;
  data.jobs[`handoff:${key}`] = { status: "running", message: "Re-running the tribunal…", startedAt: Date.now() };
  render();
  manageKeepAlive();
  try {
    const files = await send("categoryRetribunal", { siteUrl: key });
    toast(`New blueprint — ${files.filter((f) => f.fileType === "step").length} steps written`);
  } catch (e) {
    toast(e.message);
  }
});
$("#catStart").addEventListener("click", async () => {
  const name = $("#catName").value.trim();
  if (!name) return toast("Type a category first, e.g. “forms and surveys”.");
  const ok = await askConfirm(
    `Category clone: “${name}”.\n\n• I'll suggest about ${$("#catCount").value} leading sites from the market dataset — you confirm each one.\n• For each site I open it, you log in / sign up, then I explore it (clicking and typing without submitting, like the single-site Autopilot).\n• Then a tribunal compares them all and a judge writes the blueprint, and I build that app in Scram.\n\nIt uses your Anthropic API credits (a lot more than one site) and your Scram credits.`,
    { ok: "Start" }
  );
  if (!ok) return;
  try {
    await send("categoryStart", { name, instructions: $("#catInstructions").value.trim(), siteCount: Number($("#catCount").value) });
  } catch (e) {
    toast(e.message);
  }
});
$("#catAccept").addEventListener("click", () => send("categoryDecide", { index: data.autopilot?.category?.confirmIndex, accept: true, url: $("#catSiteUrl").value.trim() }).catch((e) => toast(e.message)));
$("#catSkip").addEventListener("click", () => send("categoryDecide", { index: data.autopilot?.category?.confirmIndex, accept: false }).catch((e) => toast(e.message)));
$("#catLoggedIn").addEventListener("click", () => send("categoryLoggedIn").catch((e) => toast(e.message)));
$("#catSkipSite").addEventListener("click", () => send("categorySkipSite").catch((e) => toast(e.message)));
