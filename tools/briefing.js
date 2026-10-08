// Shows the research briefing(s) written by Autopilot (lib/briefing.js). Read-only.
const $ = (s) => document.querySelector(s);
let briefings = [];
let current = null;

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const inline = (t) =>
  esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1<i>$2</i>");

// Small Markdown renderer: headings, bullet/numbered lists, paragraphs, bold/italic/code.
function render(md) {
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush(); close();
      const n = Math.min(m[1].length, 3);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flush();
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      flush(); close();
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush(); close();
    } else {
      close();
      para.push(line.trim());
    }
  }
  flush(); close();
  return out.join("\n");
}

function show() {
  const b = briefings.find((x) => x.id === $("#pick").value) || briefings.at(-1);
  current = b || null;
  $("#download").disabled = $("#copy").disabled = !(b && b.status === "done");
  if (!b) $("#doc").innerHTML = `<p class="hint">No research briefing yet. Autopilot writes one after the research and your answers to its questions.</p>`;
  else if (b.status === "writing") $("#doc").innerHTML = `<p class="hint">Still writing the briefing for ${esc(b.siteUrl)}… this page updates by itself.</p>`;
  else if (b.status === "error") $("#doc").innerHTML = `<p class="hint">Couldn't write the briefing: ${esc(b.error || "unknown error")}. The build itself isn't affected.</p>`;
  else $("#doc").innerHTML = render(b.content);
}

async function load() {
  briefings = (await chrome.storage.local.get("briefings")).briefings || [];
  const want = new URLSearchParams(location.search).get("id");
  const keep = $("#pick").value || want;
  $("#pick").replaceChildren(
    ...briefings
      .slice()
      .reverse()
      .map((b) => Object.assign(document.createElement("option"), { value: b.id, textContent: `${new URL(b.siteUrl).host} — ${new Date(b.createdAt).toLocaleString()}${b.status === "writing" ? " (writing…)" : b.status === "error" ? " (failed)" : ""}` }))
  );
  if (keep && briefings.some((b) => b.id === keep)) $("#pick").value = keep;
  $("#pick").hidden = briefings.length < 2;
  show();
}

$("#pick").addEventListener("change", show);
$("#download").addEventListener("click", () => {
  if (!current?.content) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([current.content], { type: "text/markdown" }));
  a.download = `research-briefing-${new URL(current.siteUrl).host}-${new Date(current.createdAt).toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#copy").addEventListener("click", async () => {
  if (!current?.content) return;
  await navigator.clipboard.writeText(current.content).catch(() => {});
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy"), 1500);
});
chrome.storage.onChanged.addListener((changes) => changes.briefings && load());
load();
