// Injected into tabs by the service worker (chrome.scripting, isolated world).
// Exposes window.__sabDom: read the page (snapshot / extract / text) and act on
// it (click / type / key / scroll) using stable data-sab-id handles.
// Everything returned must be JSON-serialisable.

(() => {
  if (window.__sabDom) return;

  let nextId = 1;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  };
  const inViewportish = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > -innerHeight && r.top < innerHeight * 3;
  };

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]",
    "[role=option]", "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=searchbox]",
    "[role=textbox]", "[aria-haspopup]", "[aria-expanded]", "[contenteditable=true]", "[contenteditable='']",
  ].join(",");
  const LAYERS = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tooltip],dialog[open],[aria-modal=true]";

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (clean(t)) return clean(t);
    }
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 120);
    if (el.value && el.type !== "password") return clean(String(el.value)).slice(0, 60);
    const other = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") ||
      el.querySelector?.("img[alt]")?.getAttribute("alt") || el.querySelector?.("svg title")?.textContent ||
      el.getAttribute("data-testid") || el.getAttribute("name");
    return clean(other).slice(0, 120);
  }

  const idOf = (el) => {
    if (!el.dataset.sabId) el.dataset.sabId = `s${nextId++}`;
    return el.dataset.sabId;
  };
  const byId = (id) => document.querySelector(`[data-sab-id="${CSS.escape(id)}"]`);

  function hrefOf(el) {
    if (el.tagName !== "A" || !el.href) return undefined;
    try {
      const u = new URL(el.href);
      if (u.protocol === "javascript:") return undefined;
      return u.origin === location.origin ? u.pathname + u.search : u.href;
    } catch {
      return undefined;
    }
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const d = {
      id: idOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      label: labelOf(el),
      href: hrefOf(el),
      type: el.type && el.tagName !== "BUTTON" ? el.type : undefined,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true" || undefined,
      expanded: el.getAttribute("aria-expanded") ?? undefined,
      haspopup: el.getAttribute("aria-haspopup") ?? undefined,
      selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current") ? true : undefined,
      pressed: el.getAttribute("aria-pressed") ?? (el.getAttribute("aria-checked") ?? undefined),
      inLayer: el.closest(LAYERS) ? true : undefined,
      submits: (el.tagName === "BUTTON" && el.form && el.type === "submit") || (el.tagName === "INPUT" && el.type === "submit") || undefined,
      editable: el.isContentEditable || ["INPUT", "TEXTAREA"].includes(el.tagName) || undefined,
      box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
    };
    return d;
  }

  function snapshot({ maxElements = 250, maxText = 4000 } = {}) {
    const seen = new Set();
    const elements = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (elements.length >= maxElements) break;
      if (!isVisible(el) || !inViewportish(el)) continue;
      // Skip an interactive element nested directly in another with the same label.
      const parent = el.parentElement?.closest(INTERACTIVE);
      if (parent && seen.has(parent) && labelOf(parent) === labelOf(el)) continue;
      seen.add(el);
      elements.push(describe(el));
    }
    const layers = Array.from(document.querySelectorAll(LAYERS)).filter(isVisible).map((l) => ({
      role: l.getAttribute("role") || l.tagName.toLowerCase(),
      label: clean(l.getAttribute("aria-label") || ""),
      text: clean(l.innerText).slice(0, 1200),
    }));
    return {
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText.slice(0, maxText) : "",
      layers,
      elements,
      hasPassword: !!Array.from(document.querySelectorAll("input[type=password]")).find(isVisible),
    };
  }

  function find(target) {
    if (typeof target === "string") return byId(target);
    if (target?.id) {
      const el = byId(target.id);
      if (el && isVisible(el)) return el;
    }
    // Fallback: re-find by label + role after a re-render dropped our attribute.
    if (target?.label) {
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!isVisible(el)) continue;
        if (labelOf(el) === target.label && (el.getAttribute("role") || undefined) === target.role) return el;
      }
    }
    return null;
  }

  // Current state of one element (label/pressed/expanded), e.g. to detect a toggle.
  function describeTarget(target) {
    const el = find(target);
    return el ? describe(el) : null;
  }

  function click(target) {
    const el = find(target);
    if (!el) return { ok: false, error: "element not found" };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
    return { ok: true };
  }

  function typeText(target, text) {
    const el = find(target);
    if (!el) return { ok: false, error: "element not found" };
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // Native setter so React/Vue-controlled inputs see the change.
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: el.value === text };
    }
    const sel = getSelection();
    sel.selectAllChildren(el);
    if (text === "") {
      document.execCommand("delete");
      return { ok: true };
    }
    if (document.execCommand("insertText", false, text) && clean(el.innerText)) return { ok: true };
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { ok: !!clean(el.innerText) };
  }

  const KEYS = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
  function pressKey(key, target) {
    const el = (target && find(target)) || document.activeElement || document.body;
    const init = { key, code: key, keyCode: KEYS[key] || 0, which: KEYS[key] || 0, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (key === "Enter") el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    return { ok: true };
  }

  function scroll(to) {
    if (to === "top") scrollTo(0, 0);
    else scrollBy(0, innerHeight * (to || 1));
    return { y: scrollY, height: document.documentElement.scrollHeight };
  }

  const bodyText = () => (document.body ? document.body.innerText : "");

  // A cheap fingerprint of what's interactable/visible, for before/after diffs.
  function signature() {
    const labels = Array.from(document.querySelectorAll(INTERACTIVE)).filter(isVisible).map(labelOf).filter(Boolean);
    const layers = Array.from(document.querySelectorAll(LAYERS)).filter(isVisible).length;
    return { url: location.href, labels: [...new Set(labels)].slice(0, 400), layers };
  }

  // ---------------------------------------------------------------- chat helpers (Scram)

  function findChatInput() {
    const candidates = Array.from(document.querySelectorAll("textarea, [contenteditable=true], [contenteditable=''], [role=textbox]"))
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
    if (!candidates.length) return null;
    const hint = /ask|message|describe|build|chat|prompt|what|type|tell|ai/i;
    const score = (el) => {
      const label = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.dataset?.placeholder || ""}`;
      return (hint.test(label) ? 10 : 0) + el.getBoundingClientRect().top / innerHeight;
    };
    return idOf(candidates.sort((a, b) => score(b) - score(a))[0]);
  }

  function findSendButton(inputId) {
    const input = byId(inputId);
    if (!input) return null;
    let scope = input.closest("form");
    for (let p = input.parentElement, i = 0; !scope && p && i < 5; p = p.parentElement, i++) {
      if (p.querySelectorAll("button,[role=button]").length) scope = p;
    }
    const buttons = Array.from((scope || document).querySelectorAll("button,[role=button]")).filter(isVisible);
    const btn =
      buttons.find((b) => /send|submit/i.test(`${b.getAttribute("aria-label") || ""} ${b.innerText || ""} ${b.title || ""}`)) ||
      buttons.find((b) => b.type === "submit") ||
      buttons[buttons.length - 1];
    return btn ? idOf(btn) : null;
  }

  function inputValue(id) {
    const el = byId(id);
    if (!el) return null;
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText;
  }

  function isGenerating() {
    return Array.from(document.querySelectorAll("button,[role=button]")).some(
      (b) => isVisible(b) && /^(stop|stop generating|stop response|cancel generation)$/i.test(labelOf(b))
    );
  }

  // ---------------------------------------------------------------- full page capture

  function toHex(c) {
    const m = c && c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const hex = "#" + [m[1], m[2], m[3]].map((n) => Math.round(+n).toString(16).padStart(2, "0")).join("");
    return m[4] !== undefined && parseFloat(m[4]) < 1 ? `${hex} @ ${parseFloat(m[4])} alpha` : hex;
  }

  function extract() {
    const take = (sel, map, limit = 80) => Array.from(document.querySelectorAll(sel)).filter(isVisible).slice(0, limit).map(map).filter(Boolean);
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}×${Math.round(r.height)} @ (${Math.round(r.left + scrollX)}, ${Math.round(r.top + scrollY)})`;
    };
    const label = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const role = el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "";
      const aria = el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : "";
      return `${el.tagName.toLowerCase()}${id}${role}${aria}`;
    };

    const LANDMARK = "header,nav,main,aside,footer,section,form,dialog,[role=navigation],[role=main],[role=banner],[role=complementary],[role=dialog],[role=list],[role=feed],[role=tablist],[role=region]";
    const vw = innerWidth, vh = innerHeight;
    const skeleton = [];
    const walk = (el, depth) => {
      if (skeleton.length > 120 || depth > 8) return;
      for (const child of el.children) {
        if (!isVisible(child)) continue;
        const cs = getComputedStyle(child);
        const r = child.getBoundingClientRect();
        const significant = child.matches(LANDMARK) || ((cs.position === "fixed" || cs.position === "sticky") && r.width * r.height > 2000) ||
          (r.width > vw * 0.15 && r.height > vh * 0.3 && (cs.display.includes("flex") || cs.display.includes("grid") || /auto|scroll/.test(cs.overflowY)));
        if (significant) {
          const bits = [cs.display, cs.position !== "static" ? cs.position : "", /auto|scroll/.test(cs.overflowY) ? "scrolls-y" : "",
            cs.zIndex !== "auto" ? `z=${cs.zIndex}` : "", `bg ${toHex(cs.backgroundColor) || "transparent"}`].filter(Boolean);
          skeleton.push(`${"  ".repeat(depth)}- ${label(child)} ${box(child)} [${bits.join(", ")}]`);
          walk(child, depth + 1);
        } else walk(child, depth);
      }
    };
    if (document.body) walk(document.body, 0);

    const counts = { text: {}, bg: {}, border: {}, font: {}, radius: {}, shadow: {}, spacing: {} };
    const bump = (bucket, key) => key && (counts[bucket][key] = (counts[bucket][key] || 0) + 1);
    for (const el of Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 4000)) {
      if (!isVisible(el)) continue;
      const cs = getComputedStyle(el);
      if (Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
        bump("text", toHex(cs.color));
        bump("font", `${cs.fontFamily.split(",")[0].replace(/["']/g, "")} ${cs.fontSize}/${cs.lineHeight} w${cs.fontWeight}`);
      }
      bump("bg", toHex(cs.backgroundColor));
      if (parseFloat(cs.borderTopWidth) > 0) bump("border", `${cs.borderTopWidth} ${toHex(cs.borderTopColor)}`);
      if (cs.borderRadius !== "0px") bump("radius", `${cs.borderRadius} (${el.tagName.toLowerCase()})`);
      if (cs.boxShadow !== "none") bump("shadow", cs.boxShadow);
      for (const v of [cs.paddingTop, cs.paddingLeft, cs.marginTop, cs.gap]) if (v && v !== "0px" && v !== "normal" && v !== "auto") bump("spacing", v);
    }
    const top = (bucket, n) => Object.entries(counts[bucket]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} (×${c})`);

    const roleStyle = (sel) => {
      const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return `${sel}: ${cs.fontFamily} | ${cs.fontSize} | w${cs.fontWeight} | lh ${cs.lineHeight} | ${toHex(cs.color)}`;
    };

    const controlState = (el) => [el.disabled ? "disabled" : "", el.getAttribute("aria-pressed") === "true" ? "pressed" : "",
      el.getAttribute("aria-selected") === "true" ? "selected" : "", el.getAttribute("aria-expanded") ? `expanded=${el.getAttribute("aria-expanded")}` : "",
      el.getAttribute("aria-current") ? "current" : ""].filter(Boolean).join(",");
    const fieldDesc = (i) => {
      const st = [i.required ? "required" : "", i.disabled ? "disabled" : "", i.maxLength > 0 ? `maxlength=${i.maxLength}` : "", i.pattern ? `pattern=${i.pattern}` : ""].filter(Boolean).join(",");
      return `${i.tagName.toLowerCase()}[${i.type || (i.isContentEditable ? "contenteditable" : "")}] ${i.name || i.id || i.placeholder || i.getAttribute("aria-label") || ""}${st ? ` {${st}}` : ""}`.trim();
    };
    const keys = (s) => { try { return Object.keys(s).slice(0, 60); } catch { return []; } };

    return {
      url: location.href,
      title: document.title,
      text: bodyText(),
      viewport: `${vw}×${vh} (devicePixelRatio ${devicePixelRatio}), page height ${document.documentElement.scrollHeight}px`,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      skeleton,
      tokens: {
        textColors: top("text", 12), backgrounds: top("bg", 12), borders: top("border", 8), fonts: top("font", 14),
        radii: top("radius", 10), shadows: top("shadow", 6), spacing: top("spacing", 14),
      },
      typography: ["h1", "h2", "h3", "p", "a", "button", "input", "small", "label"].map(roleStyle).filter(Boolean),
      structure: {
        headings: take("h1,h2,h3,h4", (h) => `${h.tagName}: ${clean(h.innerText).slice(0, 120)}`, 120),
        buttons: take("button,[role=button],input[type=submit],[role=tab],[role=menuitem],[role=switch],[role=checkbox]", (b) => {
          const t = labelOf(b);
          if (!t) return null;
          const st = controlState(b);
          return `${t}${b.getAttribute("role") ? ` [${b.getAttribute("role")}]` : ""}${st ? ` {${st}}` : ""}`;
        }, 150),
        links: take("a[href]", (a) => {
          const t = labelOf(a);
          if (!t) return null;
          const h = hrefOf(a);
          return h ? `${t.slice(0, 80)} -> ${h}${a.getAttribute("aria-current") ? " {current}" : ""}` : null;
        }, 150),
        forms: take("form", (f) => `form${f.getAttribute("method") ? ` method=${f.getAttribute("method")}` : ""}${f.getAttribute("action") ? ` action=${f.getAttribute("action")}` : ""}: ${Array.from(f.querySelectorAll("input,select,textarea")).filter((i) => i.type !== "hidden").map(fieldDesc).join(", ")}`, 20),
        standaloneInputs: take("input:not(form input):not([type=hidden]),textarea:not(form textarea),select:not(form select),[contenteditable=true]", fieldDesc, 40),
        images: take("img,svg[role=img],[role=img]", (i) => `${i.tagName.toLowerCase()} ${clean(i.getAttribute("alt") || i.getAttribute("aria-label") || "")} ${box(i)}`.trim(), 40),
      },
      storage: {
        localStorage: keys(localStorage),
        sessionStorage: keys(sessionStorage),
        cookies: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).slice(0, 60),
      },
      thirdPartyScriptHosts: [...new Set(Array.from(document.scripts).map((s) => { try { return new URL(s.src).host; } catch { return null; } }).filter(Boolean))]
        .filter((h) => h !== location.host).slice(0, 40),
    };
  }

  window.__sabDom = {
    snapshot, describeTarget, click, typeText, pressKey, scroll, bodyText, signature, extract,
    findChatInput, findSendButton, inputValue, isGenerating,
    ping: () => true,
  };
})();
