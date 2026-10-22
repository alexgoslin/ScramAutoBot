// The extension's Scram navigator, built the way Claude in Chrome works: Anthropic's browser use
// toolset (browser_toolset_20260801) in one continuous conversation. The model reads the page as
// an accessibility tree with refs (read_page / find), looks at screenshots, clicks by ref or by
// screen position, types, presses keys, scrolls and zooms, and sees the result of every action
// before choosing the next. This file is the executor: it carries out each tool call in the
// Scram tab (real mouse and keyboard input through chrome.debugger) and returns what happened.

import { dom, sleep, waitForLoad, captureTab } from "./dom.js";
import { ask, askTurn, loadPrompt } from "./jobs.js";
import { previewFrameId } from "./ui-audit.js";
import * as store from "./storage.js";

const TOOLSET = {
  type: "browser_toolset_20260801",
  // New tabs and closing tabs aren't needed in Scram (and could lose the project tab).
  configs: { new_tab: { enabled: false }, close_tab: { enabled: false }, hold_key: { enabled: false } },
};
const MAX_IMAGE_SIDE = 1456; // screenshots stay well inside the model's image limits

// Controls the navigator must never use, whatever the task (same list as the Scram UI guide).
const FORBIDDEN = /^\W*(publish|deploy|delete|remove|log ?out|sign ?out|cookie preferences|reset pane layout|new savepoint|upgrade|buy|purchase|billing|invite|bug report|add (page|frontend|integration|workflow|tables?|user)|generate token|change favicon|dashboard)\b/i;
const ALLOWED_HOST = /(^|\.)buildwithscram\.com$/i;

const SYSTEM = `You operate Scram (a no-code app builder) in a Chrome tab on the user's behalf, using the browser tools. Work like a careful person at the screen: look first, act, then check what happened.

How to work:
- Start with read_page (filter "interactive" is usually enough) and/or a screenshot. Prefer clicking by ref from read_page/find; use coordinates for things without a usable ref (canvas, the running app's preview iframe, icons). Take a screenshot after anything that changes the screen, and zoom when small icons or text matter.
- Batch only actions whose outcome you're sure of (e.g. click a field, type, press Enter), then observe.
- If something didn't work, look at the screen again and try a different way; don't repeat the same action.
- Refs go stale when the page changes: re-read the page when told a ref is stale.
- After actions that change the screen, a screenshot of the result is attached to the last action's result: check it before going on.
- The running app (Scram's Run preview) is a separate frame: read_page lists what's inside it under "Inside the running app", with refs starting app_, and you can click those refs.

When the task is finished, stop calling tools and reply with one line starting "DONE:" and what you see that proves it. If it can't be done (or needs the human: login, payment, credentials), reply with one line starting "FAILED:" and why. If you discovered something about Scram's editor that would have made this faster (where a control lives, what a confusing screen is, a trick that worked), add a line "LEARNED: <one sentence>" after it.

Never: publish to Live or deploy, delete anything, log out, buy/upgrade/change billing, invite people, change account settings, open Cookie Preferences (it froze the editor before), or type into or send anything with the AI chat box ("Ask Claude…") unless the task explicitly says to. The extension refuses these actions anyway.`;

// ------------------------------------------------------------------ chrome.debugger session

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    return true;
  } catch (e) {
    if (/already attached/i.test(e.message)) return false;
    throw new Error(`can't use the browser debugger on this tab (${e.message})`);
  }
}
const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };
const modBits = (mods) => String(mods || "").toLowerCase().split(/[+\s]+/).filter(Boolean).reduce((n, m) => n | (MOD_BITS[m] || 0), 0);

const KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], return: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32, " "], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34], arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38],
  arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
};
function keyDef(name) {
  const k = KEYS[name.toLowerCase()];
  if (k) return { key: k[0], code: k[1], vk: k[2], text: k[3] };
  if (/^f([1-9]|1[0-2])$/i.test(name)) return { key: name.toUpperCase(), code: name.toUpperCase(), vk: 111 + Number(name.slice(1)) };
  if (name.length === 1) {
    const up = name.toUpperCase();
    return { key: name, code: /[a-z]/i.test(name) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : "", vk: up.charCodeAt(0), text: name };
  }
  return null;
}
async function pressChord(tabId, chord) {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const main = parts.pop();
  const mods = modBits(parts.join("+"));
  const k = keyDef(main || "");
  if (!k) throw new Error(`Unknown key "${chord}".`);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods };
  const text = mods & 6 ? undefined : k.text; // no text with ctrl/meta chords
  await cdp(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function mouse(tabId, type, x, y, extra = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}
async function clickAt(tabId, x, y, { button = "left", count = 1, mods = 0 } = {}) {
  await mouse(tabId, "mouseMoved", x, y, { modifiers: mods });
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, "mousePressed", x, y, { button, clickCount: i, modifiers: mods });
    await mouse(tabId, "mouseReleased", x, y, { button, clickCount: i, modifiers: mods });
  }
}

// ------------------------------------------------------------------ screenshots

async function capture(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(250);
  }
  const vp = (await dom(tabId, "viewport").catch(() => null)) || { w: tab.width || 1280, h: tab.height || 800 };
  const dataUrl = await captureTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  return { bmp, vp };
}
async function encode(canvas) {
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
const imageBlock = (data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });

// Like dom(), in one frame of the tab (used for the Run preview, a cross-origin frame).
async function frameDom(tabId, frameId, method, ...args) {
  const run = async () => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (m, a) => (typeof window.__sabDom?.[m] === "function" ? window.__sabDom[m](...a) : "__sab_missing__"),
      args: [method, args],
    });
    return res?.result;
  };
  let result = await run();
  if (result === "__sab_missing__") {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content/agent-dom.js"] });
    result = await run();
  }
  return result;
}

const LESSONS_KEY = "navigatorLessons";
async function lessonsText() {
  const l = await store.get(LESSONS_KEY, []);
  return l.length ? `Lessons you learned on earlier tasks in Scram (use them):\n${l.slice(-30).map((x) => `- ${x.text}`).join("\n")}` : "";
}
async function saveLessons(text) {
  const found = [...String(text || "").matchAll(/LEARNED:\s*(.+)/gi)].map((m) => m[1].trim().slice(0, 300)).filter(Boolean);
  if (!found.length) return [];
  const all = await store.get(LESSONS_KEY, []);
  const fresh = found.filter((t) => !all.some((x) => store.similarity(x.text, t) >= 0.7));
  if (fresh.length) await store.set(LESSONS_KEY, [...all, ...fresh.map((t) => ({ text: t, at: new Date().toISOString() }))].slice(-40));
  return fresh;
}

// ------------------------------------------------------------------ the executor

class Executor {
  constructor(ctx, tabId, { allowHeader = false, allowChat = false, getTabId, readOnly = false } = {}) {
    this.ctx = ctx;
    this.readOnly = readOnly;
    this.tabId = tabId;
    this.allowHeader = allowHeader;
    this.allowChat = allowChat;
    this.getTabId = getTabId;
    this.scale = null; // image px per CSS px, fixed after the first screenshot
    this.attached = new Set();
  }
  // Attach chrome.debugger once per tab for the whole task (real mouse/keyboard input), and
  // detach at the end only if we attached it.
  async ensureDebugger() {
    if (this.ready?.has(this.tabId)) return;
    (this.ready ||= new Set()).add(this.tabId);
    if (await attach(this.tabId)) this.attached.add(this.tabId);
  }
  async release() {
    for (const id of this.attached) await chrome.debugger.detach({ tabId: id }).catch(() => {});
    this.attached.clear();
    this.ready?.clear();
  }
  // The Run preview (the running app) is a cross-origin frame: find it so the model can read and
  // click inside it. Its refs start with "app_". Cached until the page changes.
  async appFrame() {
    const f = await dom(this.tabId, "previewFrame").catch(() => null);
    if (!f?.full) return null;
    const key = `${f.src}|${Math.round(f.full.x)}|${Math.round(f.full.y)}|${Math.round(f.full.w)}`;
    if (this.app?.key === key && this.app.tabId === this.tabId) return this.app;
    const frameId = await previewFrameId(this.tabId, f).catch(() => null);
    if (frameId == null) return null;
    await frameDom(this.tabId, frameId, "setRefPrefix", "app_").catch(() => null);
    const vp = await frameDom(this.tabId, frameId, "viewport").catch(() => null);
    if (!vp?.w) return null;
    this.app = { key, tabId: this.tabId, frameId, full: f.full, scale: f.full.w / vp.w };
    return this.app;
  }
  isAppRef = (ref) => /^app_/.test(String(ref || ""));
  async appTree(opts) {
    const a = await this.appFrame();
    if (!a) return "";
    const r = await frameDom(this.tabId, a.frameId, "a11yTree", opts).catch(() => null);
    return r?.text ? `\n--- Inside the running app (the Run preview; refs start with app_; URL ${r.url}) ---\n${r.text}` : "";
  }
  toCss(x, y) {
    const s = this.scale || 1;
    return [x / s, y / s];
  }
  async screenshot() {
    const { bmp, vp } = await capture(this.tabId);
    if (!this.scale) this.scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(vp.w, vp.h));
    const w = Math.round(vp.w * this.scale);
    const h = Math.round(vp.h * this.scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    return encode(canvas);
  }
  async zoom(region) {
    const [x0, y0, x1, y1] = (region || []).map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error("zoom needs region [x0, y0, x1, y1] with x1 > x0 and y1 > y0.");
    const { bmp, vp } = await capture(this.tabId);
    if (!this.scale) this.scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(vp.w, vp.h));
    const dev = bmp.width / vp.w; // device px per CSS px
    const [cx0, cy0] = this.toCss(x0, y0);
    const [cx1, cy1] = this.toCss(x1, y1);
    const sw = (cx1 - cx0) * dev;
    const sh = (cy1 - cy0) * dev;
    const up = Math.min(MAX_IMAGE_SIDE / sw, MAX_IMAGE_SIDE / sh, 4);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw * up)), Math.max(1, Math.round(sh * up)));
    canvas.getContext("2d").drawImage(bmp, cx0 * dev, cy0 * dev, sw, sh, 0, 0, canvas.width, canvas.height);
    return encode(canvas);
  }
  // Where a pointer target lands (CSS px) and what's there, refusing off-limits controls.
  async resolve(target, { pointerOnly = false } = {}) {
    if (!target || !target.type) throw new Error("Missing target.");
    let x;
    let y;
    let info;
    if (target.type === "ref" && this.isAppRef(target.ref)) {
      if (pointerOnly) throw new Error("This action needs a coordinate target.");
      const a = await this.appFrame();
      const t = a && (await frameDom(this.tabId, a.frameId, "refTarget", target.ref).catch(() => null));
      if (!t) throw new Error(`${target.ref} is stale or not found in the running app. Re-read the page to get fresh references.`);
      // The app's own controls are the user's Dev build: no editor guard applies inside it.
      return { x: a.full.x + t.x * a.scale, y: a.full.y + t.y * a.scale, info: { ...t, header: false, app: true } };
    }
    if (target.type === "ref") {
      if (pointerOnly) throw new Error("This action needs a coordinate target.");
      const t = await dom(this.tabId, "refTarget", target.ref);
      if (!t) throw new Error(`${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
      ({ x, y } = t);
      info = t;
    } else {
      [x, y] = this.toCss(Number(target.x), Number(target.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Coordinate target needs numeric x and y.");
      info = await dom(this.tabId, "elementAt", x, y).catch(() => null);
    }
    this.guard(info);
    return { x, y, info };
  }
  guard(info) {
    if (!info || info.app) return;
    if (info.header && !this.allowHeader) throw new Error(`Refused: "${info.label || "that control"}" is in a left-column section header (the AI chat's title row or Page Structure). Those only collapse sections or start chats; don't use them for this task.`);
    if (FORBIDDEN.test(info.label || "")) throw new Error(`Refused: "${info.label}" is never used by the extension (publishing, deleting, logging out, billing, invites and similar are for the human).`);
  }
  async afterAction() {
    await sleep(150);
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    if (tab?.status === "loading") await waitForLoad(this.tabId);
    await dom(this.tabId, "settle", 350, 2500).catch(() => sleep(400)); // wait for the page to stop changing
    const next = this.getTabId ? await this.getTabId() : null;
    if (next && next !== this.tabId) {
      this.tabId = next;
      return `Note: Scram opened a new tab; now working in it (${(await chrome.tabs.get(next)).url}).`;
    }
    return "";
  }
  async browserState() {
    const tabs = await store.scramTabs().catch(() => []);
    const list = tabs.length ? tabs : [await chrome.tabs.get(this.tabId)];
    if (!list.some((t) => t.id === this.tabId)) list.push(await chrome.tabs.get(this.tabId));
    const clip = (s) => String(s || "").replace(/[\u0000-\u001f\u2028\u2029]/g, " ").slice(0, 4000);
    return { type: "browser_state", tabs: list.slice(0, 100).map((t) => ({ tab_id: `tab-${t.id}`, title: clip(t.title) || "(untitled)", url: clip(t.url) || "about:blank", ...(t.id === this.tabId ? { active: true } : {}) })) };
  }

  // Natural-language element search, like Claude in Chrome's find: a quick model picks the
  // matching lines from the page's tree (falls back to keyword matching).
  async find(query) {
    const main = (await dom(this.tabId, "a11yTree", { filter: "all", allowHeader: this.allowHeader, maxChars: 60000 }).catch(() => null))?.text || "";
    const app = await this.appTree({ filter: "all", maxChars: 20000 });
    const lines = `${main}${app}`.split("\n").map((l) => l.trim()).filter((l) => /\[(app_)?ref_\d+\]/.test(l));
    if (!lines.length) return "The page has no elements to search. Take a screenshot instead.";
    try {
      const settings = this.ctx.settings || (await store.getSettings());
      const { text: picked } = await ask({
        system: "You find elements on a web page. You get a list of elements (one per line, each ending with its [ref]) and a description. Reply with ONLY the lines that match the description, most likely first, at most 20, copied exactly. If none match, reply NONE.",
        userContent: `Description: ${query}\n\nElements:\n${lines.join("\n").slice(0, 80000)}`,
        maxTokens: 2000,
        model: settings.explorerModel || "claude-haiku-4-5",
      });
      const refs = [...String(picked).matchAll(/\[((?:app_)?ref_\d+)\]/g)].map((m) => m[1]);
      const out = [...new Set(refs)].map((r) => lines.find((l) => l.includes(`[${r}]`))).filter(Boolean).slice(0, 20);
      if (out.length) return out.join("\n");
      if (/NONE/.test(picked)) return `No elements matched "${query}". Try read_page or a screenshot.`;
    } catch {
      /* keyword matching below */
    }
    const r = await dom(this.tabId, "findRefs", query, { allowHeader: this.allowHeader }).catch(() => null);
    return r?.text || `No elements matched "${query}". Try read_page or a screenshot.`;
  }

  // Runs one member call. Returns the tool_result content (array of blocks) or throws.
  async run(name, input = {}) {
    if (input.__invalid) throw new Error("The tool input wasn't valid JSON.");
    if (input.tab_id && input.tab_id !== `tab-${this.tabId}` && !["switch_tab", "list_tabs"].includes(name)) {
      throw new Error(`Only the active Scram tab (tab-${this.tabId}) can be used; switch_tab to change it.`);
    }
    const text = (t) => [{ type: "text", text: t }];
    const allowHeader = this.allowHeader;
    if (this.readOnly) {
      const keysOk = name === "key" && String(input.text || "").split(/\s+/).every((k) => /^(escape|esc|tab|shift\+tab|arrow(up|down|left|right)|up|down|left|right|pageup|pagedown|home|end)$/i.test(k));
      if (["type", "form_input", "left_click_drag", "left_mouse_down", "left_mouse_up", "navigate"].includes(name) || (name === "key" && !keysOk)) {
        throw new Error(`Refused: this is a look-only task — ${name} could change something. Only open/close panels, switch tabs, scroll and read.`);
      }
    }
    switch (name) {
      case "screenshot":
        return [imageBlock(await this.screenshot())];
      case "zoom":
        return [imageBlock(await this.zoom(input.region))];
      case "read_page": {
        const opts = { filter: input.filter || "", ref: input.ref || "", depth: Number(input.depth) || 15, allowHeader };
        if (this.isAppRef(input.ref)) {
          const a = await this.appFrame();
          const r = a && (await frameDom(this.tabId, a.frameId, "a11yTree", opts).catch(() => null));
          if (!r || r.error) throw new Error(r?.error || `${input.ref} is stale or not found in the running app.`);
          return text(`Inside the running app (${r.url}):\n${r.text || "(nothing visible)"}`);
        }
        const r = await dom(this.tabId, "a11yTree", opts);
        if (r?.error) throw new Error(r.error);
        const app = input.ref ? "" : await this.appTree({ ...opts, ref: "", maxChars: 20000 });
        return text(`URL: ${r.url}\nTitle: ${r.title}\n${r.text || "(nothing visible)"}${app}`);
      }
      case "find":
        return text(await this.find(String(input.query || "")));
      case "get_page_text": {
        const main = String((await dom(this.tabId, "bodyText")) || "").slice(0, 30000);
        const a = await this.appFrame();
        const appText = a ? String((await frameDom(this.tabId, a.frameId, "bodyText").catch(() => "")) || "").slice(0, 10000) : "";
        return text(`${main || "(no text)"}${appText ? `\n\n--- Text inside the running app (Run preview) ---\n${appText}` : ""}`);
      }
      case "navigate": {
        const u = String(input.url || "").trim();
        if (u === "back") await chrome.tabs.goBack(this.tabId);
        else if (u === "forward") await chrome.tabs.goForward(this.tabId);
        else if (u === "reload") await chrome.tabs.reload(this.tabId);
        else {
          let url;
          try {
            url = new URL(/^[a-z]+:/i.test(u) ? u : `https://${u}`);
          } catch {
            throw new Error("Navigation refused: that isn't a valid URL.");
          }
          if (!/^https?:$/.test(url.protocol)) throw new Error("Navigation refused. Only http and https URLs are allowed.");
          if (!ALLOWED_HOST.test(url.hostname)) throw new Error(`Navigation refused: only Scram (buildwithscram.com) pages can be opened, not ${url.hostname}.`);
          await chrome.tabs.update(this.tabId, { url: url.href });
        }
        await sleep(500);
        await waitForLoad(this.tabId);
        await sleep(1500);
        const tab = await chrome.tabs.get(this.tabId);
        return text(`Navigated. Now at ${tab.url}`);
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        await this.ensureDebugger();
        const { x, y, info } = await this.resolve(input.target);
        const button = name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left";
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await clickAt(this.tabId, x, y, { button, count, mods: modBits(input.modifiers) });
        const note = await this.afterAction();
        return text(`${name.replace("_", " ")} on ${input.target.type === "ref" ? input.target.ref : `(${input.target.x}, ${input.target.y})`}${info?.label ? ` — "${info.label}"` : ""}.${note ? ` ${note}` : ""}`);
      }
      case "hover": {
        await this.ensureDebugger();
        const { x, y } = await this.resolve(input.target);
        await mouse(this.tabId, "mouseMoved", x, y);
        await sleep(300);
        return text("Hovered.");
      }
      case "mouse_move":
      case "left_mouse_down":
      case "left_mouse_up": {
        await this.ensureDebugger();
        const { x, y } = await this.resolve(input.target, { pointerOnly: true });
        const type = name === "mouse_move" ? "mouseMoved" : name === "left_mouse_down" ? "mousePressed" : "mouseReleased";
        await mouse(this.tabId, type, x, y, type === "mouseMoved" ? {} : { button: "left", clickCount: 1 });
        return text("OK.");
      }
      case "left_click_drag": {
        await this.ensureDebugger();
        const a = await this.resolve(input.from, { pointerOnly: true });
        const b = await this.resolve(input.target, { pointerOnly: true });
        await mouse(this.tabId, "mouseMoved", a.x, a.y);
        await mouse(this.tabId, "mousePressed", a.x, a.y, { button: "left", clickCount: 1 });
        for (let i = 1; i <= 8; i++) {
          await mouse(this.tabId, "mouseMoved", a.x + ((b.x - a.x) * i) / 8, a.y + ((b.y - a.y) * i) / 8, { button: "left", buttons: 1 });
          await sleep(30);
        }
        await mouse(this.tabId, "mouseReleased", b.x, b.y, { button: "left", clickCount: 1 });
        await this.afterAction();
        return text("Dragged.");
      }
      case "scroll": {
        await this.ensureDebugger();
        const [x, y] = this.toCss(Number(input.target?.x), Number(input.target?.y));
        const n = Math.max(1, Math.min(10, Number(input.scroll_amount) || 3)) * 100;
        const d = String(input.scroll_direction || "down");
        await mouse(this.tabId, "mouseWheel", x, y, { deltaX: d === "left" ? -n : d === "right" ? n : 0, deltaY: d === "up" ? -n : d === "down" ? n : 0 });
        await sleep(300);
        return text(`Scrolled ${d}.`);
      }
      case "scroll_to": {
        const a = this.isAppRef(input.target?.ref) ? await this.appFrame() : null;
        const r = a ? await frameDom(this.tabId, a.frameId, "scrollToRef", input.target.ref) : await dom(this.tabId, "scrollToRef", input.target?.ref);
        if (r?.error) throw new Error(r.error);
        return text(`Scrolled ${input.target.ref} into view.`);
      }
      case "type": {
        const f = await dom(this.tabId, "focusedInfo").catch(() => null);
        if (f?.chatBox && !this.allowChat) throw new Error("Refused: the focus is in Scram's AI chat box, and this task must not type in it.");
        await this.ensureDebugger();
        await cdp(this.tabId, "Input.insertText", { text: String(input.text ?? "") });
        return text("Typed.");
      }
      case "key": {
        await this.ensureDebugger();
        const seq = String(input.text || "").split(/\s+/).filter(Boolean);
        if (!seq.length) throw new Error("key needs text, e.g. \"Enter\".");
        const f = await dom(this.tabId, "focusedInfo").catch(() => null);
        if (f?.chatBox && !this.allowChat && seq.some((k) => /^enter$|^return$/i.test(k))) throw new Error("Refused: Enter in Scram's AI chat box would send a message, and this task must not.");
        const times = Math.max(1, Math.min(100, Number(input.repeat) || 1));
        for (let i = 0; i < times; i++) for (const k of seq) await pressChord(this.tabId, k);
        const note = await this.afterAction();
        return text(`Pressed ${seq.join(" ")}${times > 1 ? ` ×${times}` : ""}.${note ? ` ${note}` : ""}`);
      }
      case "wait":
        await sleep(Math.max(0, Math.min(30, Number(input.duration) || 1)) * 1000);
        return text("Waited.");
      case "form_input": {
        if (this.isAppRef(input.target?.ref)) {
          const a = await this.appFrame();
          const r = a ? await frameDom(this.tabId, a.frameId, "formInput", input.target.ref, input.value) : { error: "The running app isn't showing." };
          if (r?.error) throw new Error(r.error);
          await this.afterAction();
          return text(r.text || "OK.");
        }
        const t = await dom(this.tabId, "refTarget", input.target?.ref);
        if (!t) throw new Error(`${input.target?.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
        this.guard(t);
        if (t.chatBox && !this.allowChat) throw new Error("Refused: that's Scram's AI chat box, and this task must not type in it.");
        const r = await dom(this.tabId, "formInput", input.target.ref, input.value);
        if (r?.error) throw new Error(r.error);
        return text(r.text || "OK.");
      }
      case "list_tabs":
        return [await this.browserState()];
      case "switch_tab": {
        const id = Number(String(input.tab_id || "").replace(/^tab-/, ""));
        const tabs = await store.scramTabs().catch(() => []);
        if (!tabs.some((t) => t.id === id)) throw new Error("Only Scram tabs can be used.");
        this.tabId = id;
        await chrome.tabs.update(id, { active: true });
        return [await this.browserState()];
      }
      default:
        throw new Error(`${name} is not enabled in this environment.`);
    }
  }
}

// ------------------------------------------------------------------ the loop

// Runs the navigator until it reports DONE (and verify agrees) or FAILED, or turns run out.
// Returns { ok, reason, tabId }.
export async function browserAgent(ctx, tabId, goal, { maxTurns = 20, verify = null, allowHeader = false, allowChat = false, getTabId = null, guide = "", readOnly = false, log = (m) => ctx.log(m) } = {}) {
  const settings = ctx.settings || (await store.getSettings());
  const model = settings.operatorModel || settings.model;
  const effort = settings.operatorEffort || "high";
  const updates = /^claude-(fable-5|opus-5-5|sonnet-5-5)/i.test(model);
  const betas = [...(updates ? ["thinking-display-updates-2026-08-18"] : []), ...(/^claude-(fable-5-1|opus-5-5|opus-5$)/i.test(model) ? ["server-side-fallback-2026-07-01"] : [])];
  const ex = new Executor(ctx, tabId, { allowHeader, allowChat, getTabId, readOnly });
  if (!guide) guide = await loadPrompt("scramUiGuide", "scram-ui-guide.md").catch(() => "");
  const lessons = await lessonsText();
  const system = [SYSTEM, guide && `Scram editor guide (built in — trust it):\n${guide}`, lessons].filter(Boolean).join("\n\n");
  const first = [];
  try {
    first.push(imageBlock(await ex.screenshot()));
  } catch {
    /* the model can take one itself */
  }
  const tab = await chrome.tabs.get(tabId);
  first.push({ type: "text", text: `TASK: ${goal}\n\nThe Scram tab is at ${tab.url} (title "${tab.title}"). A screenshot of it is attached.${allowHeader ? "\nFor this task you MAY use the AI chat's title-row icons." : ""}` });
  const messages = [{ role: "user", content: first }];
  let nudges = 0;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      ctx.checkStop?.();
      const res = await askTurn({
        model,
        system,
        messages,
        tools: [TOOLSET],
        maxTokens: 16000,
        effort,
        betas,
        ...(updates ? { thinking: { type: "adaptive", display: "updates" } } : {}),
        extra: betas.includes("server-side-fallback-2026-07-01") ? { fallbacks: "default" } : {},
      });
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "thinking" && b.thinking?.trim()) await log(`Scram UI 💭 ${b.thinking.trim().slice(0, 240)}`);
      if (res.stopReason === "refusal") return { ok: false, reason: "the model declined this request", tabId: ex.tabId };
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (res.stopReason !== "tool_use" || !calls.length) {
        const said = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        for (const l of await saveLessons(said).catch(() => [])) await log(`📘 Navigator learned: ${l}`);
        if (/^\W*DONE\b/i.test(said) || (/\bDONE:/i.test(said) && !/\bFAILED:/i.test(said))) {
          await log(`Scram UI ✓ ${said.replace(/^\W*DONE:?\s*/i, "").slice(0, 240)}`);
          if (!verify || (await verify().catch(() => false))) return { ok: true, reason: said, tabId: ex.tabId };
          messages.push({ role: "user", content: "I checked the screen: the task isn't done yet. Look again (screenshot or read_page) and keep going, or reply FAILED: if it can't be done." });
          continue;
        }
        if (/FAILED/i.test(said)) {
          await log(`Scram UI ✗ ${said.replace(/^\W*FAILED:?\s*/i, "").slice(0, 240)}`);
          return { ok: false, reason: said.replace(/^\W*FAILED:?\s*/i, ""), tabId: ex.tabId };
        }
        if (++nudges > 2) return { ok: false, reason: said || "stopped without finishing", tabId: ex.tabId };
        messages.push({ role: "user", content: res.stopReason === "max_tokens" ? "You were cut off. Carry on." : 'Carry on with the task. When it\'s finished, reply "DONE: …"; if it can\'t be done, reply "FAILED: …".' });
        continue;
      }
      // Run every call in order; after a failure, the rest of the batch isn't executed.
      const results = [];
      let failed = false;
      for (const call of calls) {
        const base = { type: "tool_result", tool_use_id: call.id, ...(call.toolset_name ? { toolset_name: call.toolset_name } : {}) };
        if (failed) {
          results.push({ ...base, content: "Not executed: an earlier action in this turn failed.", is_error: true });
          continue;
        }
        const desc = describeCall(call);
        try {
          const content = await ex.run(call.name, call.input || {});
          results.push({ ...base, content });
          const said = /click|navigate|key/.test(call.name) && content?.[0]?.text ? content[0].text : desc;
          if (!["screenshot", "zoom", "read_page", "find", "get_page_text", "list_tabs", "wait"].includes(call.name)) await log(`Scram UI: ${said}`);
        } catch (e) {
          failed = true;
          results.push({ ...base, content: `Error: ${e.message || e}`, is_error: true });
          await log(`Scram UI: ${desc} — ${e.message || e}`);
        }
      }
      // Like Claude in Chrome: after actions that change the screen, show the result right away.
      const OBSERVE = ["screenshot", "zoom", "read_page", "find", "get_page_text", "list_tabs", "switch_tab"];
      const lastAct = [...calls].reverse().find((c) => !OBSERVE.includes(c.name));
      const lastObs = calls[calls.length - 1];
      if (lastAct && !OBSERVE.includes(lastObs.name)) {
        const r = results.find((x) => x.tool_use_id === lastAct.id);
        if (r && !r.is_error && Array.isArray(r.content)) {
          try {
            r.content.push(imageBlock(await ex.screenshot()));
          } catch {
            /* no screenshot this time */
          }
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { ok: false, reason: `ran out of steps (${maxTurns} turns)`, tabId: ex.tabId };
  } finally {
    await ex.release();
  }
}

function describeCall(call) {
  const i = call.input || {};
  const t = i.target ? (i.target.type === "ref" ? i.target.ref : `(${i.target.x}, ${i.target.y})`) : "";
  switch (call.name) {
    case "type":
      return `type “${String(i.text || "").slice(0, 60)}”`;
    case "key":
      return `key ${i.text}`;
    case "navigate":
      return `go to ${i.url}`;
    case "form_input":
      return `set ${t} to “${String(i.value).slice(0, 60)}”`;
    case "scroll":
      return `scroll ${i.scroll_direction}`;
    default:
      return `${call.name.replace(/_/g, " ")} ${t}`.trim();
  }
}
