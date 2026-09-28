import { getSettings } from "../lib/storage.js";

const $ = (sel) => document.querySelector(sel);
let lastScan = null;
let lastRun = null;

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "Unknown error"));
      resolve(res.data);
    });
  });
}

async function loadTabs() {
  const tabs = await send("attachTestFindTab");
  const sel = $("#tab");
  sel.replaceChildren(
    ...(tabs.length
      ? tabs.map((t) => Object.assign(document.createElement("option"), { value: t.id, textContent: `${t.editor ? "✏️ PROJECT EDITOR · " : "📋 project list · "}${t.title} — ${t.url}` }))
      : [Object.assign(document.createElement("option"), { value: "", textContent: "No Scram tab open — open Scram, then press ↻" })])
  );
}

async function showCurrent() {
  const s = await getSettings();
  $("#current").textContent = s.scramAttachMethod
    ? `Saved method: “${s.scramAttachMethod}”. Autopilot tries this first, then the others, and pastes the text if none work.`
    : "No method saved yet — Autopilot tries every method in turn, and pastes the text if none work.";
}

function renderReport() {
  const lines = [
    "SCRAM UPLOAD TEST REPORT",
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `Time: ${new Date().toISOString()}`,
    "",
  ];
  if (lastRun) lines.push("RESULT:", lastRun.ok ? `worked with ${lastRun.method}` : "no method worked", ...lastRun.log, "");
  const s = lastRun?.scan || lastScan;
  if (s) {
    lines.push(`Page: ${s.title} — ${s.url}`);
    lines.push(`Chat input: ${s.chatInput ? JSON.stringify(s.chatInput) : "NOT FOUND"}`);
    lines.push(`File inputs (${s.fileInputs.length}):`, ...s.fileInputs.map((f) => `  ${JSON.stringify(f)}`));
    lines.push(`Buttons near the chat / upload-looking (${s.buttons.length}):`, ...s.buttons.map((b) => `  ${JSON.stringify(b)}`));
  }
  $("#report").value = lines.join("\n");
}

$("#refresh").addEventListener("click", loadTabs);

$("#scan").addEventListener("click", async () => {
  const tabId = Number($("#tab").value);
  if (!tabId) return;
  try {
    lastScan = await send("attachTestScan", { tabId });
    $("#log").textContent = [
      lastScan.chatInput ? `Chat input found: ${lastScan.chatInput.tag} (${lastScan.chatInput.editor})` : "⚠️ Chat input NOT found — is a project with the AI chat open?",
      `File inputs on the page: ${lastScan.fileInputs.length}`,
      `Buttons near the chat / that look like upload: ${lastScan.buttons.map((b) => b.label || b.title || "(icon)").join(", ") || "none"}`,
    ].join("\n");
    renderReport();
  } catch (e) {
    $("#log").textContent = `Error: ${e.message}`;
  }
});

$("#run").addEventListener("click", async () => {
  const tabId = Number($("#tab").value);
  if (!tabId) return;
  $("#run").disabled = true;
  $("#result").textContent = "Running… watch the Scram tab.";
  $("#result").className = "big";
  $("#log").textContent = "";
  try {
    lastRun = await send("attachTestRun", { tabId, send: $("#send").checked });
    $("#result").textContent = lastRun.ok
      ? `✅ Upload works — method “${lastRun.method}” saved for Autopilot.`
      : "❌ No method could attach the file. Copy the report below and send it to Claude.";
    $("#result").className = `big ${lastRun.ok ? "ok" : "bad"}`;
    $("#log").textContent = lastRun.log.join("\n");
    renderReport();
    showCurrent();
  } catch (e) {
    $("#result").textContent = `Error: ${e.message}`;
    $("#result").className = "big bad";
  } finally {
    $("#run").disabled = false;
  }
});

$("#forget").addEventListener("click", async () => {
  await send("attachTestForget");
  showCurrent();
});

$("#copy").addEventListener("click", async () => {
  if (!$("#report").value) renderReport();
  await navigator.clipboard.writeText($("#report").value).catch(() => {});
  $("#copy").textContent = "Copied ✓";
  setTimeout(() => ($("#copy").textContent = "Copy report"), 1500);
});

loadTabs();
showCurrent();
