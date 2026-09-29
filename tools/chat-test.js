const $ = (sel) => document.querySelector(sel);

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
  $("#tab").replaceChildren(
    ...(tabs.length
      ? tabs.map((t) => Object.assign(document.createElement("option"), { value: t.id, textContent: `✏️ ${t.title} — ${t.url}` }))
      : [Object.assign(document.createElement("option"), { value: "", textContent: "No Scram project editor open — open a project, then press ↻" })])
  );
}

function syncDry() {
  // A full test has to send the task, so it always runs for real.
  const full = mode() === "full";
  $("#dry").disabled = full;
  if (full) $("#dry").checked = false;
}

function render(st) {
  if (!st) return;
  const labels = { running: "⏳ Running… watch the Scram tab", done: "✅ Finished", stopped: "⏹ Stopped", error: "❌ Error" };
  $("#status").textContent = `${labels[st.status] || st.status}${st.dryRun ? " (dry run)" : ""}`;
  $("#status").className = `big ${st.status === "error" ? "bad" : st.status === "done" ? "ok" : ""}`;
  $("#log").textContent = (st.log || []).map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`).join("\n") || "(nothing yet)";
  $("#log").scrollTop = $("#log").scrollHeight;
  $("#run").disabled = st.status === "running";
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncDry));
$("#refresh").addEventListener("click", loadTabs);

$("#run").addEventListener("click", async () => {
  const tabId = Number($("#tab").value);
  if (!tabId) return;
  if (mode() === "full" && !confirm("This sends Scram a tiny test task in that project (uses a little Scram credit and adds a heading to its Home Page). Continue?")) return;
  try {
    render(await send("chatTestStart", { tabId, mode: mode(), dryRun: $("#dry").checked, maxRounds: Number($("#rounds").value) }));
  } catch (e) {
    $("#status").textContent = `❌ ${e.message}`;
    $("#status").className = "big bad";
  }
});

$("#stop").addEventListener("click", () => send("chatTestStop").catch(() => {}));

$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#log").textContent).catch(() => {});
  $("#copy").textContent = "Copied ✓";
  setTimeout(() => ($("#copy").textContent = "Copy log"), 1500);
});

chrome.storage.onChanged.addListener((changes) => changes.chatTest && render(changes.chatTest.newValue));
chrome.storage.local.get("chatTest").then(({ chatTest }) => render(chatTest));
syncDry();
loadTabs();
