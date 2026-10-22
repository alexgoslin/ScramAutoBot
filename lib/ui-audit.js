// Looking at the Scram app the way a human would: a screenshot of the Run preview plus an
// automatic layout check run inside the preview itself (menus off screen, things repeated that
// shouldn't be, overlapping / cut-off text, broken images, unreadable text, sideways scrolling).

import { sleep, captureTab } from "./dom.js";

// Runs INSIDE each frame of the Scram tab (serialised by chrome.scripting): must be self-contained.
export function auditLayout() {
  const W = innerWidth;
  const H = innerHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
  };
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const label = (el) => {
    const t = text(el).slice(0, 50);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    return `${role || tag}${t ? ` “${t}”` : ""}`;
  };
  const issues = [];
  const add = (kind, detail) => issues.length < 40 && issues.push({ kind, detail });
  const all = [...document.body.querySelectorAll("*")].filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|META|LINK|TEMPLATE)$/.test(el.tagName));
  const shown = all.filter(vis);
  const bodyText = text(document.body);

  if (bodyText.length < 15 && !document.querySelector("img,svg,canvas,video")) add("blank", "the page shows (almost) nothing");

  // Sideways scrolling: the page is wider than the screen.
  const sw = document.documentElement.scrollWidth;
  if (sw > W + 4) {
    const wide = shown.filter((el) => el.getBoundingClientRect().right > W + 4).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    add("sideways-scroll", `page is ${sw}px wide on a ${W}px screen${wide ? ` (widest: ${label(wide)})` : ""}`);
  }

  // Floating things (menus, dropdowns, popovers, dialogs, tooltips) that go off the screen.
  const docH = Math.max(document.documentElement.scrollHeight, H);
  for (const el of shown) {
    const cs = getComputedStyle(el);
    const role = el.getAttribute("role") || "";
    const floating = cs.position === "fixed" || cs.position === "absolute" || /menu|listbox|dialog|tooltip/.test(role);
    if (!floating) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 16) continue;
    const limitB = cs.position === "fixed" ? H : docH - scrollY;
    const off = [];
    if (r.right > W + 2) off.push(`${Math.round(r.right - W)}px past the right edge`);
    if (r.left < -2) off.push(`${Math.round(-r.left)}px past the left edge`);
    if (r.bottom > limitB + 2) off.push(`${Math.round(r.bottom - limitB)}px below the ${cs.position === "fixed" ? "screen" : "page"}`);
    if (cs.position === "fixed" && r.top < -2) off.push(`${Math.round(-r.top)}px above the screen`);
    if (off.length && text(el)) add("off-screen", `${label(el)} goes ${off.join(" and ")}`);
  }

  // Things repeated that shouldn't be.
  const outerOnly = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  const banners = outerOnly(shown.filter((el) => el.tagName === "HEADER" || el.getAttribute("role") === "banner"));
  if (banners.length > 1) add("duplicate", `${banners.length} page headers/top bars (${banners.map(label).join("; ")})`);
  const footers = outerOnly(shown.filter((el) => el.tagName === "FOOTER" || el.getAttribute("role") === "contentinfo"));
  if (footers.length > 1) add("duplicate", `${footers.length} page footers`);
  const navs = outerOnly(shown.filter((el) => el.tagName === "NAV" || el.getAttribute("role") === "navigation"));
  const navTexts = navs.map(text).filter((t) => t.length > 8);
  const dupNav = navTexts.find((t, i) => navTexts.indexOf(t) !== i);
  if (dupNav) add("duplicate", `the same navigation appears twice (“${dupNav.slice(0, 50)}”)`);
  const heads = new Map();
  for (const h of shown.filter((el) => /^H[1-3]$/.test(el.tagName))) {
    const t = text(h);
    if (t.length > 2) heads.set(`${h.tagName}:${t}`, (heads.get(`${h.tagName}:${t}`) || 0) + 1);
  }
  for (const [k, n] of heads) if (n > 1) add("duplicate", `heading ${k.split(":")[0]} “${k.slice(3, 60)}” appears ${n} times`);
  // Identical neighbours (a section, button or card rendered twice in a row).
  let twins = 0;
  for (const el of shown) {
    const prev = el.previousElementSibling;
    if (!prev || prev.tagName !== el.tagName || prev.className !== el.className || !vis(prev)) continue;
    const t = text(el);
    if (t.length < 3 || t !== text(prev)) continue;
    if (/^(LI|TD|TR|OPTION)$/.test(el.tagName) && t.length < 12) continue; // short repeated list cells are often fine
    if (++twins <= 6) add("duplicate", `${label(el)} appears twice in a row`);
  }
  // Big identical blocks anywhere (a whole section repeated).
  const blocks = new Map();
  for (const el of outerOnly(shown.filter((el) => el.getBoundingClientRect().height > 120))) {
    const t = text(el);
    if (t.length > 40) blocks.set(t, [...(blocks.get(t) || []), el]);
  }
  for (const [t, els] of blocks) if (els.length > 1) add("duplicate", `a block (“${t.slice(0, 50)}”) is shown ${els.length} times`);

  // Text that overlaps other text, or is cut off.
  const leaves = shown
    .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1))
    .slice(0, 300);
  let overlaps = 0;
  for (let i = 0; i < leaves.length && overlaps < 5; i++) {
    const a = leaves[i].getBoundingClientRect();
    for (let j = i + 1; j < leaves.length; j++) {
      if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
      const b = leaves[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w <= 0 || h <= 0) continue;
      if (w * h > 0.3 * Math.min(a.width * a.height, b.width * b.height)) {
        overlaps++;
        add("overlap", `${label(leaves[i])} overlaps ${label(leaves[j])}`);
        break;
      }
    }
  }
  let clipped = 0;
  for (const el of leaves) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow === "ellipsis") continue;
    if ((cs.overflow === "hidden" || cs.overflowX === "hidden") && el.scrollWidth > el.clientWidth + 3 && ++clipped <= 4) add("cut-off", `${label(el)} is cut off`);
  }

  // Broken images.
  const broken = shown.filter((el) => el.tagName === "IMG" && el.complete && el.naturalWidth === 0);
  if (broken.length) add("broken-image", `${broken.length} image(s) failed to load${broken[0].alt ? ` (e.g. “${broken[0].alt}”)` : ""}`);

  // Text that's hard to read (low contrast against its background).
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = rgb(getComputedStyle(e).backgroundColor);
      if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c;
      if (getComputedStyle(e).backgroundImage !== "none") return null; // over an image: can't tell
    }
    return [255, 255, 255];
  };
  let lowContrast = 0;
  const lowEx = [];
  for (const el of leaves) {
    const fg = rgb(getComputedStyle(el).color);
    const bg = bgOf(el);
    if (!bg || fg.length < 3) continue;
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    if ((l1 + 0.05) / (l2 + 0.05) < 2.5) {
      lowContrast++;
      if (lowEx.length < 3) lowEx.push(label(el));
    }
  }
  if (lowContrast) add("low-contrast", `${lowContrast} text element(s) are hard to read against their background (e.g. ${lowEx.join("; ")})`);

  return { viewport: { w: W, h: H }, url: location.href, top: window === window.top, textLength: bodyText.length, issues };
}

// Run the check in every frame of the tab and keep the one that is the Run preview (its viewport
// matches the preview iframe's size). Returns null if the preview can't be reached.
export async function auditPreview(tabId, frame) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: auditLayout });
  } catch {
    return null;
  }
  const cands = results.map((r) => r.result).filter((r) => r && !r.top);
  if (!cands.length) return null;
  if (!frame) return cands.sort((a, b) => b.textLength - a.textLength)[0];
  const dist = (r) => Math.abs(r.viewport.w - frame.rect.w) + Math.abs(r.viewport.h - frame.rect.h);
  return cands.sort((a, b) => dist(a) - dist(b))[0];
}

// Screenshot of just the Run preview (cropped from the visible tab), as base64 JPEG.
export async function capturePreview(tabId, frame, maxWidth = 1100) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await sleep(300);
  const dataUrl = await captureTab(tab.windowId, { format: "jpeg", quality: 80 });
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  // Screenshot pixels per CSS pixel (covers screen scaling and browser zoom).
  const dpr = bmp.width / (frame?.vw || tab.width || bmp.width) || frame?.dpr || 1;
  let box = frame?.rect ? { x: frame.rect.x * dpr, y: frame.rect.y * dpr, w: frame.rect.w * dpr, h: frame.rect.h * dpr } : { x: 0, y: 0, w: bmp.width, h: bmp.height };
  box = { ...box, w: Math.max(1, Math.min(box.w, bmp.width - box.x)), h: Math.max(1, Math.min(box.h, bmp.height - box.y)) }; // stay inside the capture
  const scale = Math.min(1, maxWidth / box.w);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(box.w * scale)), Math.max(1, Math.round(box.h * scale)));
  canvas.getContext("2d").drawImage(bmp, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function describeIssues(audit) {
  if (!audit) return "(the automatic layout check couldn't reach the preview)";
  if (!audit.issues.length) return `No layout problems found automatically (${audit.viewport.w}×${audit.viewport.h} preview).`;
  return `${audit.issues.length} possible problem(s) found automatically in the ${audit.viewport.w}×${audit.viewport.h} preview (check each against the screenshot — some can be false alarms):\n${audit.issues.map((i) => `- [${i.kind}] ${i.detail}`).join("\n")}`;
}


// ---- final design review helpers: work inside the Run preview frame itself.

// The Chrome frameId of the Run preview (the frame whose viewport matches the preview iframe).
export async function previewFrameId(tabId, frame) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => ({ w: innerWidth, h: innerHeight, top: window === window.top }) });
  } catch {
    return null;
  }
  const cands = results.filter((r) => r.result && !r.result.top);
  if (!cands.length) return null;
  const dist = (r) => (frame ? Math.abs(r.result.w - frame.rect.w) + Math.abs(r.result.h - frame.rect.h) : -r.result.w * r.result.h);
  return cands.sort((a, b) => dist(a) - dist(b))[0].frameId;
}

// Pages of the running app worth looking at: the current one plus its in-app links (no logout,
// delete or external links). Returns absolute URLs.
export async function previewLinks(tabId, frameId, max = 5) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: (max) => {
      const seen = new Set([location.origin + location.pathname]);
      const out = [location.href];
      for (const a of document.querySelectorAll("a[href]")) {
        const r = a.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        let u;
        try {
          u = new URL(a.getAttribute("href"), location.href);
        } catch {
          continue;
        }
        if (u.origin !== location.origin || /log ?out|sign ?out|delete|remove|unsubscribe/i.test(`${u.pathname} ${a.textContent}`)) continue;
        const key = u.origin + u.pathname;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(u.href);
        if (out.length >= max) break;
      }
      return out;
    },
    args: [max],
  });
  return res?.result || [];
}

export async function navigatePreview(tabId, frameId, url) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: (u) => location.assign(u), args: [url] }).catch(() => {});
  await sleep(3000);
}

export async function auditFrame(tabId, frameId) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: auditLayout });
    return res?.result || null;
  } catch {
    return null;
  }
}

// ---- trying the app like a user: click its buttons and menus one at a time and watch what happens.
// One function, run inside the preview frame, so the control list is the same in every mode:
//   "list"    → the controls worth trying on this page (never destructive or submitting ones)
//   "click"   → click control i and report what visibly happened (and any problems it caused)
//   "restore" → close whatever is open (Escape, a close button, history.back for in-app routes)
export function probeControl(mode, i, startUrl) {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
  };
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const labelOf = (el) => (el.getAttribute("aria-label") || text(el) || el.getAttribute("title") || el.getAttribute("placeholder") || "").slice(0, 60);
  const RISKY = /delete|remove|destroy|log ?out|sign ?out|archive|leave|close account|deactivate|unsubscribe|pay|buy|purchase|checkout|upgrade|subscribe|send|submit|save|publish|invite|confirm|discard|reset|clear all|block|report/i;
  const candidates = () =>
    [...document.querySelectorAll("button, [role=button], [aria-haspopup], summary, [role=tab], [role=switch]")]
      .filter((el) => vis(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.closest("a[href]"))
      .filter((el) => !(el.tagName === "BUTTON" && el.type === "submit" && el.form))
      .filter((el) => !RISKY.test(labelOf(el)));
  const floating = () =>
    [...document.querySelectorAll("body *")].filter((el) => {
      if (!vis(el)) return false;
      const cs = getComputedStyle(el);
      const role = el.getAttribute("role") || "";
      return cs.position === "fixed" || /menu|listbox|dialog|tooltip/.test(role) || (cs.position === "absolute" && el.getBoundingClientRect().height > 40);
    });

  if (mode === "list") return candidates().map((el, n) => ({ i: n, label: labelOf(el) || el.tagName.toLowerCase() })).slice(0, 40);

  if (mode === "restore") {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    const close = [...document.querySelectorAll("[aria-label], button")].find((el) => vis(el) && /^(close|dismiss|cancel|×|✕|x)$/i.test(labelOf(el).trim()) && el.closest("[role=dialog],[aria-modal]"));
    if (close) close.click();
    if (startUrl && location.href !== startUrl && new URL(startUrl).origin === location.origin) history.back();
    return { url: location.href };
  }

  // mode === "click"
  return new Promise((resolve) => {
    const el = candidates()[i];
    if (!el) return resolve({ label: "?", effect: "gone" });
    const label = labelOf(el) || el.tagName.toLowerCase();
    const beforeUrl = location.href;
    const beforeFloat = new Set(floating());
    const beforeText = text(document.body);
    let mutations = 0;
    const mo = new MutationObserver((list) => (mutations += list.length));
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const errors = [];
    const onErr = (e) => errors.push(String(e.message || e.reason || "error").slice(0, 120));
    addEventListener("error", onErr);
    addEventListener("unhandledrejection", onErr);
    try {
      el.click();
    } catch (e) {
      errors.push(String(e.message).slice(0, 120));
    }
    setTimeout(() => {
      mo.disconnect();
      removeEventListener("error", onErr);
      removeEventListener("unhandledrejection", onErr);
      const issues = [];
      const W = innerWidth, H = innerHeight;
      const opened = floating().filter((f) => !beforeFloat.has(f) && !beforeFloat.has(f.parentElement));
      for (const f of opened) {
        const r = f.getBoundingClientRect();
        const off = [];
        if (r.right > W + 2) off.push(`${Math.round(r.right - W)}px past the right edge`);
        if (r.left < -2) off.push(`${Math.round(-r.left)}px past the left edge`);
        if (r.bottom > H + 2) off.push(`${Math.round(r.bottom - H)}px below the screen`);
        if (r.top < -2) off.push(`${Math.round(-r.top)}px above the screen`);
        if (off.length && text(f)) issues.push(`what “${label}” opens (${text(f).slice(0, 40)}) goes ${off.join(" and ")}`);
      }
      const afterText = text(document.body);
      const bad = (afterText.match(/\b(undefined|NaN|null|\[object Object\]|lorem ipsum|TODO|FIXME)\b/gi) || []).length - (beforeText.match(/\b(undefined|NaN|null|\[object Object\]|lorem ipsum|TODO|FIXME)\b/gi) || []).length;
      if (bad > 0) issues.push(`after clicking “${label}”, placeholder/broken text appears (e.g. undefined, NaN, null, lorem ipsum)`);
      if (/something went wrong|an error occurred|unexpected error|failed to load|error:/i.test(afterText) && !/something went wrong|an error occurred|unexpected error|failed to load|error:/i.test(beforeText)) issues.push(`clicking “${label}” shows an error message`);
      if (errors.length) issues.push(`clicking “${label}” throws a script error (${errors[0]})`);
      const navigated = location.href !== beforeUrl;
      let effect;
      if (navigated) effect = `went to ${location.pathname}`;
      else if (opened.length) effect = `opened ${opened.map((f) => f.getAttribute("role") || "a panel").slice(0, 2).join(" + ")}${text(opened[0]) ? ` (“${text(opened[0]).slice(0, 40)}”)` : ""}`;
      else if (mutations > 0) effect = "changed something on the page";
      else {
        effect = "nothing visible happened";
        issues.push(`the button “${label}” does nothing when clicked`);
      }
      resolve({ label, effect, issues, opened: opened.length > 0 });
    }, 900);
  });
}

export async function runProbe(tabId, frameId, mode, i = 0, startUrl = "") {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: probeControl, args: [mode, i, startUrl] });
    return res?.result ?? null;
  } catch {
    return null; // e.g. the click navigated the whole frame away
  }
}
