import { SKILLS } from "../lib/skills-test.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

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
      ? tabs.map((t) => el("option", { value: t.id, textContent: `✏️ ${t.title} — ${t.url}` }))
      : [el("option", { value: "", textContent: "No Scram project editor open — open a project, then press ↻" })])
  );
}

function renderSkills() {
  $("#skills").replaceChildren(
    ...SKILLS.filter((s) => !(s.createOnly && mode() !== "create")).map((s) => {
      const box = el("input", { type: "checkbox", checked: true, value: s.id });
      return el("label", {}, box, el("span", { textContent: s.id === "open" && mode() === "existing" ? "Use the project tab you picked" : s.label }));
    })
  );
  $("#tabRow").style.display = mode() === "existing" ? "" : "none";
}

const ICON = { pending: "⏳", running: "▶️", pass: "✅", fail: "❌", skip: "⏭" };

function render(st) {
  if (!st) return;
  const labels = { running: "⏳ Running… watch the Scram tab", done: "Finished", stopped: "⏹ Stopped", error: "❌ Error" };
  const passed = (st.steps || []).filter((s) => s.status === "pass").length;
  const failed = (st.steps || []).filter((s) => s.status === "fail").length;
  $("#status").textContent = st.status === "done" ? `${failed ? "⚠️" : "✅"} Finished — ${passed} passed, ${failed} failed` : labels[st.status] || st.status;
  $("#status").className = `big ${st.status === "error" || failed ? "bad" : st.status === "done" ? "ok" : ""}`;
  $("#results").replaceChildren(
    ...(st.steps || []).map((s) =>
      el("li", { className: s.status }, el("span", { className: "icon", textContent: ICON[s.status] || "•" }), el("div", {}, el("div", { textContent: s.label }), el("div", { className: "detail", textContent: s.detail || "" })))
    )
  );
  $("#log").textContent = (st.log || []).map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`).join("\n") || "(nothing yet)";
  $("#log").scrollTop = $("#log").scrollHeight;
  $("#run").disabled = st.status === "running";
}

document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", renderSkills));
$("#refresh").addEventListener("click", loadTabs);

$("#run").addEventListener("click", async () => {
  const skills = [...document.querySelectorAll("#skills input:checked")].map((i) => i.value);
  const tabId = Number($("#tab").value) || null;
  if (mode() === "existing" && !tabId) return alert("Pick the project tab first (open a project in Scram, then press ↻).");
  if (!skills.length) return alert("Tick at least one skill.");
  if (mode() === "create" && !confirm("This opens Scram in a new tab and creates a test project there. Continue?")) return;
  try {
    render(await send("skillsTestStart", { mode: mode(), tabId, skills }));
  } catch (e) {
    $("#status").textContent = `❌ ${e.message}`;
    $("#status").className = "big bad";
  }
});

$("#stop").addEventListener("click", () => send("skillsTestStop").catch(() => {}));

$("#copy").addEventListener("click", async () => {
  const lines = [...document.querySelectorAll("#results li")].map((li) => li.innerText.replace(/\n/g, " — "));
  await navigator.clipboard.writeText(`${$("#status").textContent}\n${lines.join("\n")}\n\n${$("#log").textContent}`).catch(() => {});
  $("#copy").textContent = "Copied ✓";
  setTimeout(() => ($("#copy").textContent = "Copy results"), 1500);
});

chrome.storage.onChanged.addListener((changes) => changes.skillsTest && render(changes.skillsTest.newValue));
chrome.storage.local.get("skillsTest").then(({ skillsTest }) => render(skillsTest));
renderSkills();
loadTabs();
