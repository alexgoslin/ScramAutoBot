// Attach a generated .md file to Scram's AI chat. Tries methods in order until the file
// visibly appears in the chat, and remembers the one that worked (settings.scramAttachMethod).
//
// In-page methods (content script, no privileges): file-input, drop-input, drop-container, paste.
// Browser-level methods (chrome.debugger — needed because browsers only open a file picker
// after a REAL click, and give a trusted change event only when the browser sets the files):
//   cdp-file-input  save the file to Downloads/ScramAutoBot/, then set it on the page's
//                   <input type=file> through DevTools (like choosing it in the picker)
//   native-picker   save the file, then really click the chat's attach/paperclip/+ button,
//                   intercept the file-chooser dialog and hand it the saved file

import { dom, sleep } from "./dom.js";
import * as store from "./storage.js";

export const PAGE_METHODS = ["file-input", "drop-input", "drop-container", "paste"];
export const BROWSER_METHODS = ["cdp-file-input", "native-picker"];
export const ALL_METHODS = [...PAGE_METHODS, ...BROWSER_METHODS];

const ATTACH_WORDS = /attach|upload|file|paperclip|clip|document|add|\+/i;
const MENU_ITEM_WORDS = /upload|file|attach|computer|device|document|browse|from your/i;

// ------------------------------------------------------------------ helpers

function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Save the file to Downloads/ScramAutoBot/<name> and return its absolute path.
async function saveToDisk(name, text) {
  const id = await chrome.downloads.download({
    url: `data:text/markdown;base64,${b64(text)}`,
    filename: `ScramAutoBot/${name}`,
    conflictAction: "overwrite",
    saveAs: false,
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (item?.state === "complete" && item.filename) return item.filename;
    if (item?.state === "interrupted") throw new Error(`saving ${name} failed (${item.error})`);
    if (Date.now() > deadline) throw new Error(`saving ${name} timed out`);
    await sleep(200);
  }
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  let attachedHere = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attachedHere = true;
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw new Error(`can't use the browser debugger on this tab (${e.message})`);
  }
  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  try {
    return await fn(send);
  } finally {
    if (attachedHere) await chrome.debugger.detach(target).catch(() => {});
  }
}

// A real (trusted) mouse click at an element's centre, so the page may open a file picker.
async function trustedClick(send, tabId, target) {
  const c = await dom(tabId, "centerOf", target);
  if (!c) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
  return true;
}

async function cdpFileInput(tabId, path, scan) {
  if (!scan.fileInputs.length) return { ok: false, error: "no <input type=file> on the page" };
  const best = [...scan.fileInputs].sort((a, b) => (a.levelsFromChat ?? 99) - (b.levelsFromChat ?? 99))[0];
  return withDebugger(tabId, async (send) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const q = (r) => { const el = r.querySelector('[data-sab-id="${best.id}"]'); if (el) return el; for (const n of r.querySelectorAll('*')) if (n.shadowRoot) { const f = q(n.shadowRoot); if (f) return f; } return null; }; return q(document); })()`,
    });
    if (!result?.objectId) return { ok: false, error: "couldn't reach the file input" };
    await send("DOM.enable");
    await send("DOM.setFileInputFiles", { files: [path], objectId: result.objectId });
    return { ok: true, detail: `set via DevTools on input ${best.id}` };
  });
}

// Put a generated file into a specific <input type=file> from the page's own context
// (works even for inputs the page created on the fly and never added to the DOM).
const SET_FILES_FN = `function (name, text) {
  const dt = new DataTransfer();
  dt.items.add(new File([text], name, { type: "text/markdown" }));
  this.files = dt.files;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return this.files.length;
}`;

async function nativePicker(tabId, name, text, scan, getPath) {
  const candidates = [...scan.buttons]
    .filter((b) => b.looksLikeAttach || (b.icon && b.levelsFromChat !== null && b.levelsFromChat <= 4))
    .sort((a, b) => Number(b.looksLikeAttach) - Number(a.looksLikeAttach) || (a.levelsFromChat ?? 99) - (b.levelsFromChat ?? 99))
    .slice(0, 6);
  if (!candidates.length) return { ok: false, error: "no attach/paperclip/+ button found near the chat" };

  return withDebugger(tabId, async (send) => {
    let chooser = null;
    const onEvent = (src, method, params) => {
      if (src.tabId === tabId && method === "Page.fileChooserOpened") chooser = params;
    };
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      await send("Page.enable");
      await send("DOM.enable");
      await send("Page.setInterceptFileChooserDialog", { enabled: true });
      const waitChooser = async (ms) => {
        const end = Date.now() + ms;
        while (!chooser && Date.now() < end) await sleep(100);
        return chooser;
      };
      const tried = [];
      for (const btn of candidates) {
        tried.push(btn.label || btn.title || btn.id);
        await trustedClick(send, tabId, { id: btn.id, label: btn.label });
        if (await waitChooser(2500)) break;
        // The button may have opened a menu ("Upload file", "From computer"…) — click that item for real.
        const snap = await dom(tabId, "snapshot", { maxElements: 120, maxText: 0 });
        const item = snap.elements.find((e) => e.inLayer && MENU_ITEM_WORDS.test(e.label || ""));
        if (item) {
          tried.push(`→ ${item.label}`);
          await trustedClick(send, tabId, { id: item.id, label: item.label, role: item.role });
          if (await waitChooser(2500)) break;
        }
        await dom(tabId, "pressKey", "Escape").catch(() => {});
      }
      if (!chooser) return { ok: false, error: `no file picker opened after clicking: ${tried.join(", ")}` };
      const clicked = tried[tried.length - 1];
      // 1st choice: hand the generated file straight to the picker's input (exact name, no disk).
      const { object } = await send("DOM.resolveNode", { backendNodeId: chooser.backendNodeId });
      await send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: SET_FILES_FN,
        arguments: [{ value: name }, { value: text }],
      });
      await sleep(2000);
      if (await dom(tabId, "fileShown", name)) return { ok: true, detail: `clicked ${clicked} and gave the picker the file` };
      // 2nd choice: a real file from disk, set the way the picker itself would (trusted change event).
      const path = await getPath();
      await send("DOM.setFileInputFiles", { files: [path], backendNodeId: chooser.backendNodeId });
      return { ok: true, detail: `clicked ${clicked} and chose the saved file ${path}` };
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      await send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  });
}

// ------------------------------------------------------------------ main

export async function scan(tabId) {
  return dom(tabId, "scanChat");
}

// Try methods until the file shows up in the chat. `only` restricts to specific methods.
// Returns { ok, method, log[] }.
export async function attachToScram(tabId, name, text, { preferred, only, waitMs = 2500 } = {}) {
  const log = [];
  let methods = only || (preferred ? [preferred, ...ALL_METHODS.filter((m) => m !== preferred)] : ALL_METHODS);
  const s = await scan(tabId);
  if (!s?.chatInput) log.push("⚠️ Couldn't find Scram's chat input on this page — open a project with the AI chat visible.");
  if (await dom(tabId, "fileShown", name)) log.push(`note: "${name}" was already visible before attaching.`);
  let path = null;

  for (const method of methods) {
    let r;
    try {
      if (PAGE_METHODS.includes(method)) {
        r = await dom(tabId, "attachVia", method, s?.chatInput?.id || null, name, text);
      } else {
        const getPath = async () => (path ||= await saveToDisk(name, text));
        r = method === "cdp-file-input" ? await cdpFileInput(tabId, await getPath(), s) : await nativePicker(tabId, name, text, s, getPath);
      }
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (!r?.ok) {
      log.push(`❌ ${method}: ${r?.error || "failed"}`);
      continue;
    }
    await sleep(waitMs);
    if (await dom(tabId, "fileShown", name)) {
      log.push(`✅ ${method}: "${name}" appeared in the chat${r.detail ? ` (${r.detail})` : ""}`);
      return { ok: true, method, log, scan: s };
    }
    log.push(`❌ ${method}: ran${r.detail ? ` (${r.detail})` : ""}, but "${name}" never appeared in the chat`);
  }
  return { ok: false, method: null, log, scan: s };
}

export async function rememberMethod(method) {
  const settings = await store.get("settings", {});
  await store.set("settings", { ...settings, scramAttachMethod: method });
}
