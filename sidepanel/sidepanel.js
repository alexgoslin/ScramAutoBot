const $ = (sel) => document.querySelector(sel);

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
    ...(await chrome.storage.local.get(["sites", "specFiles", "handoffFiles", "buildProgress", "jobs", "apiKey", "activeBuild"])),
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
  renderCapture();
  renderFiles();
  renderSiteSelects();
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
  setStatus($("#captureStatus"), siteUrl ? job : { status: "error", message: "Only http(s) pages can be captured." });

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

function renderFiles() {
  const container = $("#filesList");
  const bySite = new Map();
  for (const s of data.specFiles) {
    if (!bySite.has(s.siteUrl)) bySite.set(s.siteUrl, []);
    bySite.get(s.siteUrl).push(s);
  }
  if (!bySite.size) {
    container.replaceChildren(el("div", { class: "empty" }, "No spec files yet. Capture a page from the Capture tab."));
    return;
  }
  container.replaceChildren(
    ...[...bySite.entries()]
      .sort(([a], [b]) => host(a).localeCompare(host(b)))
      .map(([siteUrl, specs]) =>
        el(
          "div",
          { class: "site-group" },
          el("h4", {}, el("span", {}, host(siteUrl)), el("span", { class: "muted" }, `${specs.length} page${specs.length === 1 ? "" : "s"}`)),
          el("ul", { class: "list" }, specs.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).map(specItem))
        )
      )
  );
}

function sitesWithSpecs() {
  return [...new Set(data.specFiles.map((s) => s.siteUrl))];
}
function sitesWithSteps() {
  return [...new Set(data.handoffFiles.filter((f) => f.fileType === "step").map((f) => f.siteUrl))];
}

function fillSelect(select, siteUrls, emptyLabel) {
  const prev = select.value;
  const current = siteUrlOf(currentTab?.url || "");
  const options = siteUrls.length
    ? siteUrls.map((s) => el("option", { value: s }, host(s)))
    : [el("option", { value: "" }, emptyLabel)];
  select.replaceChildren(...options);
  if (siteUrls.includes(prev)) select.value = prev;
  else if (select.id === "buildSite" && siteUrls.includes(data.activeBuild)) select.value = data.activeBuild;
  else if (siteUrls.includes(current)) select.value = current;
  select.disabled = !siteUrls.length;
}

function renderSiteSelects() {
  fillSelect($("#handoffSite"), sitesWithSpecs(), "No captured sites yet");
  fillSelect($("#buildSite"), sitesWithSteps(), "No handoffs generated yet");
}

function renderHandoff() {
  const siteUrl = $("#handoffSite").value;
  const job = siteUrl ? data.jobs[`handoff:${siteUrl}`] : null;
  const count = data.specFiles.filter((s) => s.siteUrl === siteUrl).length;
  const btn = $("#generateBtn");
  btn.disabled = !siteUrl || job?.status === "running";
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
              el("div", { class: "sub" }, `${f.content.length.toLocaleString()} chars`)
            ),
            el("button", { class: "small", onclick: () => copyText(f.content) }, "Copy")
          );
        })
      : [el("li", { class: "empty" }, siteUrl ? "No handoff generated for this site yet." : "Capture some pages first.")])
  );
}

function renderBuild() {
  const siteUrl = $("#buildSite").value;
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
  const siteUrl = $("#handoffSite").value;
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

$("#handoffSite").addEventListener("change", renderHandoff);
$("#buildSite").addEventListener("change", renderBuild);

$("#buildBtn").addEventListener("click", async () => {
  const siteUrl = $("#buildSite").value;
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
  const siteUrl = $("#buildSite").value;
  if (siteUrl && confirm("Mark all steps as not done?")) await send("resetBuild", { siteUrl });
});

$("#stopBuildBtn").addEventListener("click", () => send("stopBuild"));

// ---------------------------------------------------------------------------- init

refreshCurrentTab();
loadData();
