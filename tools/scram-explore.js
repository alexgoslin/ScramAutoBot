const $ = (sel) => document.querySelector(sel);
const opt = (value, text) => Object.assign(document.createElement("option"), { value, textContent: text });

function send(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "Unknown error"));
      resolve(res.data);
    });
  });
}

const mode = () => document.querySelector("input[name=mode]:checked").value;

async function loadTabs() {
  const tabs = (await send("attachTestFindTab")).filter((t) => t.editor);
  $("#tab").replaceChildren(...(tabs.length ? tabs.map((t) => opt(t.id, `✏️ ${t.title} — ${t.url}`)) : [opt("", "No Scram project editor open — open a project, then press ↻")]));
}

function syncMode() {
  $("#tabRow").style.display = mode() === "existing" ? "" : "none";
}

let lastExplore = null;
function render(st) {
  if (!st) return;
  lastExplore = st;
  const labels = { running: "⏳ Exploring… watch the Scram tab", done: "✅ Finished — guide saved", stopped: "⏹ Stopped", error: "❌ Error" };
  $("#status").textContent = `${labels[st.status] || st.status}${st.views?.length ? ` · ${st.views.length} views, ${st.notes?.length || 0} actions, ${Object.values(st.tried || {}).reduce((n, l) => n + l.length, 0)} controls tried` : ""}`;
  $("#status").className = `big ${st.status === "error" ? "bad" : st.status === "done" ? "ok" : ""}`;
  $("#log").textContent = (st.log || []).map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`).join("\n") || "(nothing yet)";
  $("#log").scrollTop = $("#log").scrollHeight;
  $("#run").disabled = st.status === "running";
}

async function renderGuide() {
  const { scramKnowledge: k } = await chrome.storage.local.get("scramKnowledge");
  $("#guide").textContent = k?.text || "(no guide saved yet — run an exploration)";
  $("#guideMeta").textContent = k?.updatedAt ? `— saved ${new Date(k.updatedAt).toLocaleString()}, used by Autopilot` : "";
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncMode));
$("#refresh").addEventListener("click", loadTabs);
$("#run").addEventListener("click", async () => {
  const tabId = Number($("#tab").value) || null;
  if (mode() === "existing" && !tabId) return alert("Pick the project tab first.");
  if (mode() === "create" && !confirm("This opens Scram in a new tab, creates a test project and lets Claude click around it. Continue?")) return;
  try {
    render(await send("scramExploreStart", { mode: mode(), tabId, maxActions: Number($("#actions").value) }));
  } catch (e) {
    $("#status").textContent = `❌ ${e.message}`;
    $("#status").className = "big bad";
  }
});
$("#stop").addEventListener("click", () => send("scramExploreStop").catch(() => {}));
function fullReport() {
  const st = lastExplore || {};
  const notes = (st.notes || []).map((n) => `${n.i}. [${n.view}] ${n.action}\n   ${n.observation}`).join("\n");
  const tried = Object.entries(st.tried || {}).map(([v, ls]) => `- **${v}**: ${ls.join(" · ")}`).join("\n");
  return `# Scram exploration report\n\n_${new Date(st.startedAt || Date.now()).toLocaleString()} · ${st.views?.length || 0} views · ${st.notes?.length || 0} actions_\n\n# Manual\n\n${$("#guide").textContent}\n\n# Views seen\n${(st.views || []).map((v) => `- ${v}`).join("\n")}\n\n# Controls tried per view\n${tried}\n\n# Every action and what it showed\n${notes}\n`;
}
$("#download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([fullReport()], { type: "text/markdown" }));
  Object.assign(document.createElement("a"), { href: url, download: `scram-exploration-${new Date().toISOString().slice(0, 10)}.md` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
// Long runs: keep the extension's background worker awake while this page is open.
setInterval(() => {
  if (lastExplore?.status === "running") send("ping").catch(() => {});
}, 20000);
$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(fullReport()).catch(() => {});
  $("#copy").textContent = "Copied ✓";
  setTimeout(() => ($("#copy").textContent = "Copy guide + notes"), 1500);
});
$("#clear").addEventListener("click", async () => {
  if (!confirm("Forget the saved Scram guide? Autopilot will stop using it.")) return;
  await chrome.storage.local.remove("scramKnowledge");
  renderGuide();
});

chrome.storage.onChanged.addListener((c) => {
  if (c.scramExplore) render(c.scramExplore.newValue);
  if (c.scramKnowledge) renderGuide();
});
chrome.storage.local.get("scramExplore").then(({ scramExplore }) => render(scramExplore));
renderGuide();
syncMode();
loadTabs();
