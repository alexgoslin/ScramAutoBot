// Attach a generated .md file to Scram's AI chat. Tries methods in order until the file
// visibly appears in the chat, and remembers the one that worked (settings.scramAttachMethod).
//
// In-page methods (content script, no privileges): file-input, drop-input, drop-container, paste.
// Browser-level methods (chrome.debugger), for pages the content script can't reach:
//   cdp-file-input  put the file into the page's <input type=file> from the page's own
//                   JavaScript context (e.g. inputs inside closed components)
//   native-picker   really click the chat's attach/paperclip button, intercept the file
//                   chooser Chrome opens, and hand its input the file
// Every method uses the file generated in memory — nothing is ever saved to disk.

import { dom, sleep } from "./dom.js";
import * as store from "./storage.js";

export const PAGE_METHODS = ["file-input", "drop-input", "drop-container", "paste"];
export const BROWSER_METHODS = ["cdp-file-input", "native-picker"];
export const ALL_METHODS = [...PAGE_METHODS, ...BROWSER_METHODS];

const MENU_ITEM_WORDS = /upload|file|attach|computer|device|document|browse|from your/i;

// ------------------------------------------------------------------ helpers

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

async function cdpFileInput(tabId, name, text, scan) {
  if (!scan.fileInputs.length) return { ok: false, error: "no <input type=file> on the page" };
  const best = [...scan.fileInputs].sort((a, b) => (a.levelsFromChat ?? 99) - (b.levelsFromChat ?? 99))[0];
  return withDebugger(tabId, async (send) => {
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const q = (r) => { const el = r.querySelector('[data-sab-id="${best.id}"]'); if (el) return el; for (const n of r.querySelectorAll('*')) if (n.shadowRoot) { const f = q(n.shadowRoot); if (f) return f; } return null; }; return q(document); })()`,
    });
    if (!result?.objectId) return { ok: false, error: "couldn't reach the file input" };
    await send("Runtime.callFunctionOn", { objectId: result.objectId, functionDeclaration: SET_FILES_FN, arguments: [{ value: name }, { value: text }] });
    return { ok: true, detail: `set from the page's own context on input ${best.id}` };
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

async function nativePicker(tabId, name, text, scan) {
  // Only buttons that clearly say attach/upload, or an unlabelled icon button right inside the
  // chat composer. Never anything that could create/delete/navigate (neverClick).
  const candidates = [...scan.buttons]
    .filter((b) => !b.neverClick)
    .filter((b) => b.looksLikeAttach || (b.icon && !b.label.trim() && b.levelsFromChat !== null && b.levelsFromChat <= 3))
    .sort((a, b) => Number(b.looksLikeAttach) - Number(a.looksLikeAttach) || (a.levelsFromChat ?? 99) - (b.levelsFromChat ?? 99))
    .slice(0, 4);
  if (!candidates.length) return { ok: false, error: "no attach / upload / paperclip button found in the chat box" };

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
      // Hand the generated file straight to the picker's input (exact name, nothing on disk).
      const { object } = await send("DOM.resolveNode", { backendNodeId: chooser.backendNodeId });
      await send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: SET_FILES_FN,
        arguments: [{ value: name }, { value: text }],
      });
      return { ok: true, detail: `clicked ${clicked} and gave the picker the file` };
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      await send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  });
}

// A genuine (trusted) click on an element — for controls that ignore script clicks.
export async function realClick(tabId, target) {
  return withDebugger(tabId, (send) => trustedClick(send, tabId, target));
}

// A genuine (trusted) Enter key press in an element — many chat boxes only send on a real Enter.
export async function realEnter(tabId, target) {
  await dom(tabId, "centerOf", target); // scroll into view
  await dom(tabId, "click", target); // focus it
  return withDebugger(tabId, async (send) => {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return true;
  });
}

// ------------------------------------------------------------------ main

export async function scan(tabId) {
  return dom(tabId, "scanChat");
}

// Try methods until the file shows up in the chat. `only` restricts to specific methods.
// Returns { ok, method, log[] }.
export async function attachToScram(tabId, name, text, { preferred, only, waitMs = 2500, onTry } = {}) {
  const log = [];
  let methods = only || (preferred ? [preferred, ...ALL_METHODS.filter((m) => m !== preferred)] : ALL_METHODS);
  const s = await scan(tabId);
  if (s?.onDashboard) {
    log.push("⚠️ This tab is showing Scram's project list, not a project. Open a project so its AI chat box is visible, then try again. (Nothing was attempted.)");
    return { ok: false, method: null, log, scan: s };
  }
  if (!s?.chatInput) {
    log.push("⚠️ Couldn't find Scram's AI chat box in this tab — open a project with the AI chat visible, then try again. (Nothing was attempted.)");
    return { ok: false, method: null, log, scan: s };
  }
  log.push(`Chat box detected: ${s.chatInput.tag} (${s.chatInput.editor})${s.chatInput.placeholder ? ` — placeholder “${s.chatInput.placeholder}”` : ""}`);
  if (await dom(tabId, "fileShown", name)) log.push(`note: "${name}" was already visible before attaching.`);

  for (const method of methods) {
    await onTry?.(method);
    const before = await dom(tabId, "composerState", s.chatInput.id).catch(() => null);
    let r;
    try {
      if (PAGE_METHODS.includes(method)) r = await dom(tabId, "attachVia", method, s.chatInput.id, name, text);
      else if (method === "cdp-file-input") r = await cdpFileInput(tabId, name, text, s);
      else r = await nativePicker(tabId, name, text, s);
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
    // The chip may not show the file name at all — but if something new appeared in the chat box,
    // the file is almost certainly attached; stop here so it isn't attached twice.
    const after = await dom(tabId, "composerState", s.chatInput.id).catch(() => null);
    if (before && after && (after.count >= before.count + 2 || after.imgs > before.imgs || (after.count > before.count && after.text !== before.text))) {
      log.push(`✅ ${method}: a new attachment appeared in the chat box (its name isn't displayed, so this is a best guess)${r.detail ? ` (${r.detail})` : ""}`);
      return { ok: true, method, log, scan: s, unverified: true };
    }
    log.push(`❌ ${method}: ran${r.detail ? ` (${r.detail})` : ""}, but nothing appeared in the chat box`);
  }
  return { ok: false, method: null, log, scan: s };
}

export async function rememberMethod(method) {
  const settings = await store.get("settings", {});
  await store.set("settings", { ...settings, scramAttachMethod: method });
}
