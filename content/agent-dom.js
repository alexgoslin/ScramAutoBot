// Injected into tabs by the service worker (chrome.scripting, isolated world).
// Exposes window.__sabDom: read the page (snapshot / extract / text) and act on
// it (click / type / key / scroll) using stable data-sab-id handles.
// Everything returned must be JSON-serialisable.

(() => {
  if (window.__sabDom) return;

  let nextId = 1;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // The extension's own on-page UI (Autopilot status bar, build overlay) must never be read as
  // part of the site — e.g. its "Stop Autopilot" button looked like Scram's "Stop generating".
  const OUR_UI = "#scram-autobot-apbar, #scram-autobot-overlay";
  const isVisible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.closest?.(OUR_UI)) return false;
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

  // Navigation areas: sidebars, left rails, top bars, tab strips, nav menus. Single-page apps
  // often navigate with buttons there instead of links, so the crawler clicks them to find screens.
  const NAV_AREA = 'nav, aside, [role=navigation], [role=tablist], [role=menubar], header, [class*="sidebar" i], [class*="side-bar" i], [class*="sidenav" i], [class*="leftpane" i], [class*="left-pane" i], [class*="navigation" i], [class*="navbar" i], [class*="rail" i]';
  function inNavArea(el, r) {
    if (el.closest(NAV_AREA)) return true;
    // A narrow rail along the left edge, or a bar along the top.
    return (r.left < 300 && r.width < 300 && r.height < 90) || (r.top < 70 && r.height < 70);
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
      header: isHeaderControl(el) || undefined,
      nav: inNavArea(el, r) || undefined,
      submits: (el.tagName === "BUTTON" && el.form && el.type === "submit") || (el.tagName === "INPUT" && el.type === "submit") || undefined,
      editable: el.isContentEditable || ["INPUT", "TEXTAREA"].includes(el.tagName) || undefined,
      box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
    };
    return d;
  }

  function snapshot({ maxElements = 250, maxText = 4000, pointer = false } = {}) {
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
    // Optionally also div/span "buttons" (pointer cursor, short text) that aren't real controls —
    // apps like Scram build toggles, cards and tabs that way.
    if (pointer) {
      for (const el of document.body.querySelectorAll("div,span,li,p,h1,h2,h3,h4,label,svg")) {
        if (elements.length >= maxElements) break;
        if (seen.has(el) || el.closest(INTERACTIVE) || !isVisible(el) || !inViewportish(el)) continue;
        if (getComputedStyle(el).cursor !== "pointer") continue;
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue; // outermost only
        const text = labelOf(el);
        if (!text || text.length > 60) continue;
        seen.add(el);
        elements.push({ ...describe(el), role: el.getAttribute("role") || "clickable" });
      }
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
      // Clickable boxes that aren't real controls (pointer cursor), e.g. a single-page app's nav items.
      if (target.role === "clickable" || !target.role) {
        let best = null;
        for (const el of document.body.querySelectorAll("div,span,li,p,h1,h2,h3,h4,label,svg,a,button")) {
          if (el.closest(OUR_UI) || !isVisible(el) || labelOf(el) !== target.label) continue;
          if (getComputedStyle(el).cursor !== "pointer") continue;
          const r = el.getBoundingClientRect();
          if (!best || r.width * r.height < best.a) best = { el, a: r.width * r.height };
        }
        if (best) return best.el;
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
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
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
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly)
      // Scram's "What shall we build today? / Describe your project…" box (dashboard, and the
      // project description on the overview) is NOT the AI chat — never type a step there.
      .filter((el) => !/describe your project/i.test(`${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.dataset?.placeholder || ""} ${el.isContentEditable && el.innerText.length < 100 ? el.innerText : ""}`));
    if (!candidates.length) return null;
    const hint = /ask|message|describe|build|chat|prompt|what|type|tell|ai/i;
    const score = (el) => {
      const label = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.dataset?.placeholder || ""}`;
      return (hint.test(label) ? 10 : 0) + el.getBoundingClientRect().top / innerHeight;
    };
    return idOf(candidates.sort((a, b) => score(b) - score(a))[0]);
  }

  // The chat's send control. Often not a <button>: e.g. an arrow icon inside
  // <span aria-label="Send"> — so look at labelled elements and clickable icon wrappers too.
  function findSendButton(inputId) {
    const input = byId(inputId);
    if (!input) return null;
    let area = input;
    for (let i = 0; i < 5 && area.parentElement; i++) area = area.parentElement;
    const words = (el) => `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("data-testid") || ""} ${el.innerText || ""}`;
    const inArea = (sel) => Array.from(area.querySelectorAll(sel)).filter((el) => isVisible(el) && el !== input && !input.contains(el));

    const labelled = inArea("button,[role=button],[aria-label],[title],[data-testid]").find((el) => /\b(send|submit)\b/i.test(words(el)) && !/attach|upload|file/i.test(words(el)));
    if (labelled) return idOf(labelled);
    const submit = inArea("button[type=submit],input[type=submit]")[0];
    if (submit) return idOf(submit);

    // Clickable icon wrappers in the composer; skip attach/camera/settings/mic, take the last (send is usually rightmost).
    const NOT_SEND = /attach|upload|file|paper ?clip|camera|screenshot|capture|mic|voice|record|slider|setting|tune|emoji|model|stop/i;
    const clickable = [];
    for (const icon of inArea("svg,img,i[class]")) {
      let pick = null;
      for (let p = icon.parentElement, i = 0; p && i < 4 && area.contains(p); p = p.parentElement, i++) {
        if (p === input || p.contains(input)) break;
        if (p.matches("button,[role=button],a")) { pick = p; break; }
        if (getComputedStyle(p).cursor === "pointer") pick = p;
        else if (pick) break;
      }
      if (pick && !clickable.includes(pick)) clickable.push(pick);
    }
    const hint = (el) => `${words(el)} ${[el, ...el.querySelectorAll("svg,use,i,img")].map((n) => `${n.getAttribute("class") || ""} ${n.getAttribute("data-icon") || ""}`).join(" ")}`;
    const candidates = clickable.filter((el) => !NOT_SEND.test(hint(el)));
    const byIcon = candidates.find((el) => /send|arrow-up|arrow-right|paper-?plane/i.test(hint(el)));
    const btn = byIcon || candidates[candidates.length - 1] || inArea("button,[role=button]").filter((b) => !NOT_SEND.test(hint(b))).pop();
    return btn ? idOf(btn) : null;
  }

  // ---------------------------------------------------------------- file attachments (Scram)

  // All elements matching `sel`, including inside open shadow roots.
  function deepAll(sel, root = document) {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot) out.push(...deepAll(sel, el.shadowRoot));
    return out;
  }

  const ATTACH_HINT = /attach|upload|file|paperclip|clip|image|photo|media|document|add|\+/i;
  // Strict: only these may ever be clicked to open a file picker.
  const ATTACH_STRICT = /attach|upload|paper ?clip|add (a )?files?|add attachments?|insert (a )?file|choose files?|browse files?/i;
  const NEVER_CLICK = /create|new project|project|delete|remove|menu|setting|share|publish|deploy|invite|rename|duplicate|log ?out|sign ?out|billing|upgrade|run|edit|preview/i;

  // Describe everything upload-related around the chat, for the diagnostics report.
  function scanChat() {
    const inputId = findChatInput();
    const input = inputId ? byId(inputId) : null;
    const near = (el) => {
      for (let p = input?.parentElement, i = 0; p && i < 7; p = p.parentElement, i++) if (p.contains(el)) return i;
      return null;
    };
    const fileInputs = deepAll("input[type=file]").map((el) => ({
      id: idOf(el),
      accept: el.accept || "",
      multiple: el.multiple,
      visible: isVisible(el),
      inShadow: el.getRootNode() !== document,
      levelsFromChat: near(el),
    }));
    // Icon buttons are often plain <div>/<span> with a click handler: also collect the nearest
    // clickable (cursor:pointer) ancestor of each icon near the chat box.
    const clickables = new Set(deepAll("button,[role=button],label,[aria-haspopup]"));
    // Anything explicitly named for attaching, whatever its tag — e.g. Scram's paperclip is
    // <span aria-label="Attach files" class="TooltipReferenceWrapper…">.
    for (const el of deepAll("[aria-label],[title],[data-tooltip]")) {
      const name = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("data-tooltip") || ""}`;
      if (ATTACH_STRICT.test(name) && isVisible(el)) clickables.add(el);
    }
    for (const icon of deepAll("svg,img,i[class]")) {
      if (!input || near(icon) === null || near(icon) > 5 || icon.closest("svg") !== icon && icon.tagName.toLowerCase() !== "img" && icon.tagName.toLowerCase() !== "i") continue;
      // Climb to the OUTERMOST clickable wrapper (cursor:pointer is inherited, so the svg itself
      // also reports "pointer" — we want the div/span the page put the click handler on).
      let pick = null;
      for (let p = icon.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        if (p === input || p.contains(input)) break;
        if (p.matches?.("button,[role=button],label,a")) {
          pick = p;
          break;
        }
        if (getComputedStyle(p).cursor === "pointer") pick = p;
        else if (pick) break;
      }
      if (pick) clickables.add(pick);
    }
    // Words describing the icon itself (e.g. class "lucide-paperclip", data-icon="paperclip", <use href="#paperclip">).
    const iconHint = (b) =>
      [b, ...b.querySelectorAll("svg,img,i,use,[data-icon],[data-testid]")]
        .map((n) => `${n.getAttribute("class") || ""} ${n.getAttribute("data-icon") || ""} ${n.getAttribute("data-testid") || ""} ${n.getAttribute("href") || n.getAttribute("xlink:href") || ""} ${n.getAttribute("alt") || ""} ${(n.getAttribute("src") || "").split("/").pop()}`)
        .join(" ") + ` ${b.getAttribute("data-testid") || ""} ${b.getAttribute("data-icon") || ""}`;
    const NOT_ATTACH_ICON = /camera|screenshot|capture|mic|microphone|voice|record|slider|setting|tune|filter|adjust|emoji|send|arrow-up|stop/i;
    const buttons = [...clickables]
      .filter((b) => isVisible(b) && (near(b) !== null || ATTACH_HINT.test(`${labelOf(b)} ${b.title || ""} ${b.className || ""}`)))
      .map((b) => {
        const words = `${labelOf(b)} ${b.title || ""} ${b.getAttribute("aria-label") || ""}`;
        const hint = iconHint(b);
        return {
          id: idOf(b),
          label: labelOf(b),
          title: b.title || "",
          tag: b.tagName.toLowerCase(),
          icon: !!b.querySelector("svg,img,i"),
          iconHint: hint.replace(/\s+/g, " ").trim().slice(0, 120),
          levelsFromChat: near(b),
          looksLikeAttach: ATTACH_STRICT.test(`${words} ${String(b.className || "")} ${hint}`),
          neverClick: NEVER_CLICK.test(words) || NOT_ATTACH_ICON.test(`${words} ${hint}`),
        };
      })
      .sort((a, b) => (a.levelsFromChat ?? 99) - (b.levelsFromChat ?? 99))
      .slice(0, 40);
    // Heuristic: the project list (dashboard) rather than a project's editor.
    const allLabels = deepAll("button,[role=button],a").filter(isVisible).map(labelOf).join(" | ");
    const onDashboard = /project menu for|create (a )?(new )?project|new project/i.test(allLabels) && !/\b(edit|run|publish|deploy)\b/i.test(allLabels);
    const editorClass = input ? String(input.className || "") : "";
    return {
      url: location.href,
      title: document.title,
      onDashboard,
      chatInput: input
        ? {
            id: inputId,
            tag: input.tagName.toLowerCase(),
            contentEditable: input.isContentEditable,
            editor: /ProseMirror/.test(editorClass) ? "ProseMirror/Tiptap" : /lexical/i.test(editorClass) || input.dataset?.lexicalEditor ? "Lexical" : /ql-editor/.test(editorClass) ? "Quill" : input.tagName === "TEXTAREA" ? "textarea" : "other",
            placeholder: input.getAttribute("placeholder") || input.dataset?.placeholder || "",
            classes: editorClass.slice(0, 120),
          }
        : null,
      fileInputs,
      buttons,
    };
  }

  function makeTransfer(name, text, mime) {
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: mime }));
    return dt;
  }

  // Try ONE attach method in the page (no browser privileges needed):
  //   file-input      set .files on the file inputs near the chat (or anywhere) + input/change events
  //   drop-input      drag-and-drop the file onto the chat box
  //   drop-container  drag-and-drop onto the chat box's surrounding panels
  //   paste           paste the file into the chat box
  function attachVia(method, inputId, name, text, mime = "text/markdown") {
    const input = inputId ? byId(inputId) : null;
    if (method === "file-input") {
      const inputs = deepAll("input[type=file]");
      if (!inputs.length) return { ok: false, error: "no <input type=file> on the page" };
      const score = (el) => {
        for (let p = input?.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) if (p.contains(el)) return i;
        return 99;
      };
      const target = inputs.sort((a, b) => score(a) - score(b))[0];
      try {
        target.files = makeTransfer(name, text, mime).files;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: `set files on input ${idOf(target)}` };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    if (!input) return { ok: false, error: "no chat input found" };
    const fire = (el, types, extra = {}) => {
      const dt = makeTransfer(name, text, mime);
      for (const type of types) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...extra }));
    };
    if (method === "drop-input") {
      input.focus();
      fire(input, ["dragenter", "dragover", "drop"]);
      return { ok: true };
    }
    if (method === "drop-container") {
      const targets = [];
      for (let p = input.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) targets.push(p);
      // Many apps show a drop overlay on dragenter, then listen for drop on that overlay.
      document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: makeTransfer(name, text, mime) }));
      for (const t of targets) fire(t, ["dragenter", "dragover", "drop"]);
      return { ok: true, detail: `dropped on ${targets.length} containers` };
    }
    if (method === "paste") {
      input.focus();
      const dt = makeTransfer(name, text, mime);
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
      return { ok: true };
    }
    return { ok: false, error: `unknown method ${method}` };
  }

  // Did an attachment with this name show up in the UI (chip, list item, title…)?
  // Tolerates chips that shorten long names ("scram-upload-te….md").
  function fileShown(name) {
    const base = name.replace(/\.[^.]+$/, "");
    const prefix = base.slice(0, Math.min(12, base.length));
    const texts = [document.body?.innerText || ""];
    for (const el of deepAll("[title],[aria-label],[alt],[download]")) {
      for (const a of ["title", "aria-label", "alt", "download"]) texts.push(el.getAttribute(a) || "");
    }
    return texts.some((t) => t.includes(base) || (t.includes(prefix) && /…|\.\.\.|\.md\b/i.test(t)));
  }

  // The chat composer area (the chat box plus a few wrapping levels) — used to notice a new
  // attachment chip appearing even if it doesn't show the file name.
  function composerState(inputId) {
    const input = inputId ? byId(inputId) : findChatInput() && byId(findChatInput());
    if (!input) return null;
    let area = input;
    for (let i = 0; i < 4 && area.parentElement; i++) area = area.parentElement;
    const els = [...area.querySelectorAll("*")].filter(isVisible);
    return { count: els.length, imgs: area.querySelectorAll("img,svg").length, text: (area.innerText || "").slice(0, 2000) };
  }

  // Expand collapsed content in the chat (e.g. Scram's plan card "Read more") so the whole
  // plan/question can be read. Only clicks small, clearly "expand"-type controls.
  function expandCollapsed() {
    // Only inside the AI chat panel — never e.g. the editor toolbar's "More" (that opens the
    // project overview and hides the chat).
    const scope = chatPanel();
    if (!scope) return 0;
    // Only the latest messages: jump to the bottom first and skip anything scrolled out of
    // view, so old messages aren't expanded (that pushed the chat to the middle of its history).
    const scroller = scrollChatToBottom().scroller;
    const view = scroller ? scroller.getBoundingClientRect() : null;
    let n = 0;
    for (const el of deepAll("a,button,[role=button],span,div", scope)) {
      if (!isVisible(el) || el.children.length > 2) continue;
      if (view) {
        const r = el.getBoundingClientRect();
        if (r.bottom < view.top || r.top > view.bottom) continue;
      }
      const t = clean(el.innerText || el.textContent);
      if (/^(read more|show more|see more|expand|show full plan|view full plan|view plan|show all|more)\.{0,3}$/i.test(t) && el.getAttribute("aria-expanded") !== "true") {
        el.click();
        n++;
      }
    }
    if (n) setTimeout(() => scrollChatToBottom(), 400);
    return n;
  }

  // The scrolling message list of Scram's AI chat: a scrollable box inside the chat panel (not
  // the chat input itself). Prefer the one sitting directly above the chat box and lined up with
  // it (that's the message list), else the tallest.
  function chatScroller() {
    const panel = chatPanel();
    if (!panel) return null;
    const input = byId(findChatInput());
    const ir = input?.getBoundingClientRect();
    let best = null;
    let bestScore = -Infinity;
    for (const el of [panel, ...panel.querySelectorAll("*")]) {
      if (input && (el === input || input.contains(el))) continue; // the chat box's own scrolling
      if (el.scrollHeight - el.clientHeight < 8 || !isVisible(el)) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      const r = el.getBoundingClientRect();
      let score = r.height;
      if (ir) {
        const gap = ir.top - r.bottom; // message list ends just above the composer
        const lined = Math.min(r.right, ir.right) - Math.max(r.left, ir.left) > ir.width * 0.5;
        if (lined && gap > -40 && gap < 220) score += 10000;
      }
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // The editor's left column holding Scram's AI chat — found even when the chat box is replaced by
  // a question form ("Write my own answer" / Cancel): from the chat panel if there is one, else
  // from the "Page Structure" header that sits under the chat. { left, right, top, bottom, psTop }.
  function chatColumn() {
    const ps = findText("^page structure$", { maxLen: 20 }).map((d) => byId(d.id)).find((el) => el && el.getBoundingClientRect().left < innerWidth * 0.45);
    const psTop = ps ? ps.getBoundingClientRect().top : innerHeight;
    const p = chatPanel();
    if (p) {
      const r = p.getBoundingClientRect();
      if (r.width < innerWidth * 0.6) return { left: r.left, right: r.right, top: 0, bottom: innerHeight, psTop };
    }
    if (ps) {
      let el = ps;
      while (el.parentElement && el.parentElement !== document.body && el.parentElement.getBoundingClientRect().width < innerWidth * 0.45) el = el.parentElement;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: 0, bottom: innerHeight, psTop };
    }
    return { left: 0, right: innerWidth * 0.3, top: 0, bottom: innerHeight, psTop };
  }

  // Keep the chat on its newest message (Scram stops following new output once it's scrolled up,
  // and a page reload redraws the history from the top). Scrolls every scrolling area of the chat
  // column (message list, question/plan panes — not the Page Structure tree) to its bottom.
  // Works for normal and bottom-anchored (column-reverse) lists. Never scrolls up.
  function scrollChatToBottom() {
    const col = chatColumn();
    const toBottom = (el) => {
      const reversed = /column-reverse/.test(getComputedStyle(el).flexDirection);
      if (reversed) el.scrollTop = 0;
      else if (el.scrollTop < el.scrollHeight) el.scrollTop = el.scrollHeight;
    };
    const editable = (el) => el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "INPUT";
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight - el.clientHeight < 8 || editable(el)) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      const r = el.getBoundingClientRect();
      // inside the chat column, above the Page Structure tree, and not a wrapper around that tree
      if (r.height < 100 || r.left < col.left - 4 || r.right > col.right + 4 || r.top >= col.psTop - 4 || r.bottom > col.psTop + 4 || !isVisible(el)) continue;
      toBottom(el);
    }
    const scroller = chatScroller();
    if (!scroller) return { ok: true, scroller: null };
    const before = scroller.scrollTop;
    const reversed = /column-reverse/.test(getComputedStyle(scroller).flexDirection);
    scroller.scrollTop = reversed ? 0 : scroller.scrollHeight;
    const last = [...scroller.querySelectorAll("*")].reverse().find((el) => isVisible(el) && clean(el.textContent).length > 0 && el.children.length === 0);
    if (last && !reversed) {
      const lr = last.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      if (lr.bottom > sr.bottom + 2) scroller.scrollTop += lr.bottom - sr.bottom + 8; // only ever down
    }
    return { ok: true, scroller, moved: Math.abs(scroller.scrollTop - before) > 4 };
  }

  // The Run preview: the biggest visible iframe outside the chat panel. Reports its position (for
  // cropping a screenshot) and whether something (Plans panel, a popover…) is covering it.
  function previewFrame() {
    const panel = chatPanel();
    const frames = [...document.querySelectorAll("iframe")].filter((f) => isVisible(f) && !(panel && panel.contains(f)));
    let best = null;
    for (const f of frames) {
      const r = f.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue;
      if (!best || r.width * r.height > best.r.width * best.r.height) best = { f, r };
    }
    if (!best) return null;
    const { f, r } = best;
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top);
    const x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    let covered = 0;
    let coverLabel = "";
    const pts = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.5, 0.15], [0.5, 0.85]];
    for (const [fx, fy] of pts) {
      const hit = document.elementFromPoint(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
      if (hit && hit !== f && !f.contains(hit)) {
        covered++;
        if (!coverLabel) {
          const box = hit.closest("[role=dialog],[role=menu],[aria-modal],section,aside,div") || hit;
          coverLabel = clean(box.getAttribute("aria-label") || box.innerText || "").slice(0, 60);
        }
      }
    }
    return {
      rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      full: { x: r.left, y: r.top, w: r.width, h: r.height },
      dpr: devicePixelRatio || 1,
      vw: innerWidth,
      vh: innerHeight,
      src: f.src || "",
      covered: covered / pts.length,
      coverLabel,
    };
  }
  function chatAtBottom() {
    const s = chatScroller();
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 30;
  }

  // Viewport centre of an element (for trusted clicks via the debugger).
  function centerOf(target) {
    const el = find(target);
    if (!el) return null;
    // "nearest" only scrolls if it's off screen (so e.g. Scram's chat isn't pulled back up).
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    // Prefer a point where the element is actually on top (a panel may cover part of it).
    for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.25], [0.5, 0.75], [0.1, 0.5], [0.9, 0.5]]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { x, y, covered: false };
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, covered: true };
  }

  // Legacy single-shot helper kept for callers that just want "try the usual way".
  function attachFile(inputId, name, text, mime = "text/markdown") {
    const r = attachVia("file-input", inputId, name, text, mime);
    if (r.ok) return { ...r, method: "file-input" };
    return { ...attachVia("drop-input", inputId, name, text, mime), method: "drop-input" };
  }

  // The chat panel around the chat box (not the whole page): climb from the chat input while
  // the container stays narrow (a side panel), so preview/status changes elsewhere are ignored.
  function chatPanel() {
    const inputId = findChatInput();
    let el = inputId ? byId(inputId) : null;
    if (!el) return null;
    while (el.parentElement && el.parentElement !== document.body) {
      const r = el.parentElement.getBoundingClientRect();
      if (r.width > innerWidth * 0.6) break;
      el = el.parentElement;
    }
    return el;
  }

  function chatText() {
    const p = chatPanel();
    return p ? p.innerText : bodyText();
  }

  // Is Scram visibly waiting for the user? (plan approval, answer options, a question form)
  // Is Scram waiting on the user? Returns a short reason ("" if not). Looks at the whole page
  // (plans/questions can show up in a dialog outside the chat) and at the chat's last message.
  function awaitingUser() {
    const labels = [...document.querySelectorAll("button,[role=button],[role=option],[role=radio],a,input,textarea,[contenteditable=true]")]
      .filter(isVisible)
      .map((el) => `${labelOf(el)} ${el.getAttribute("placeholder") || ""}`);
    const hit = labels.find((l) => /approve( plan)?|accept plan|write my own answer|submit answers?|choose an option|select an option/i.test(l));
    if (hit) return `“${hit.trim().slice(0, 40)}” is on screen`;
    const p = chatPanel();
    if (p) {
      const lines = (p.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
      // The bot's latest message ends in a question (ignore the chat box's own placeholder text).
      const lastQ = lines.slice(-4).find((l) => /\?\s*$/.test(l) && l.length > 12 && !/^ask (claude|scram)/i.test(l));
      if (lastQ) return `the bot asked: “${lastQ.slice(0, 80)}”`;
    }
    return "";
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

  // ---------------------------------------------------------------- Scram controls
  // Many of Scram's controls are plain <div>/<span>s with a click handler (the "Create new
  // project" card, the Edit/Run toggle, the project name), so they aren't in INTERACTIVE.

  const pointer = (el) => getComputedStyle(el).cursor === "pointer";

  // The element to click for a piece of text: its closest real control, else the outermost
  // pointer-cursor wrapper that doesn't also hold much other text.
  function clickableFor(el) {
    const ctl = el.closest(INTERACTIVE);
    if (ctl && isVisible(ctl)) return ctl;
    let best = pointer(el) ? el : null;
    const len = clean(el.innerText).length;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (clean(p.innerText).length > len + 40) break;
      if (pointer(p)) best = p;
    }
    return best || el;
  }

  // Visible elements whose own text matches `pattern` (deepest match only), as clickable targets.
  function findText(pattern, { flags = "i", maxLen = 80 } = {}) {
    const re = new RegExp(pattern, flags);
    const hits = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (["SCRIPT", "STYLE", "SVG", "PATH"].includes(el.tagName.toUpperCase())) continue;
      const raw = el.textContent || "";
      if (!raw.trim() || raw.length > maxLen * 4) continue; // cheap pre-filter before innerText
      const t = clean(el.innerText);
      if (!t || t.length > maxLen || !re.test(t) || !isVisible(el)) continue;
      if ([...el.children].some((c) => re.test(clean(c.innerText)))) continue; // a child matches too — use it
      hits.push(el);
    }
    return hits.map((el) => {
      const c = clickableFor(el);
      return { ...describe(c), text: clean(el.innerText) };
    });
  }

  // Scram's Edit / Run toggle. active: true/false, or null if its state can't be told.
  function modeToggle() {
    const pick = (re) => findText(re, { maxLen: 12 }).map((d) => byId(d.id)).find((el) => el && !el.closest(LAYERS));
    const run = pick("^▷?\\s*run$");
    if (!run) return null;
    const edit = pick("^✎?\\s*edit$");
    const score = (el) => {
      if (!el) return 0;
      let s = 0;
      const on = (x) => x.getAttribute("aria-pressed") === "true" || x.getAttribute("aria-selected") === "true" || x.getAttribute("aria-checked") === "true" || x.getAttribute("data-state") === "on" || x.getAttribute("data-state") === "active" || x.getAttribute("data-active") === "true";
      if (on(el)) s += 10;
      if (/\b(active|selected|current|checked|is-?on)\b/i.test(el.className?.baseVal ?? el.className ?? "")) s += 5;
      const cs = getComputedStyle(el);
      if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) s += 2;
      if (cs.boxShadow && cs.boxShadow !== "none") s += 1;
      if (cs.borderStyle !== "none" && parseFloat(cs.borderWidth) > 0) s += 1;
      return s;
    };
    const r = score(run);
    const e = score(edit);
    return { id: idOf(run), label: labelOf(run), editId: edit ? idOf(edit) : null, active: !edit || r === e ? (r >= 10 ? true : null) : r > e };
  }

  // Where the AI chat panel is (page coordinates, like describe().box), so explorers can avoid it.
  function chatPanelBox() {
    const p = chatPanel();
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY };
  }

  // The editor's frontend tab (top left, just before "More" — named after the frontend, e.g.
  // "Frontend 1" or "Tasklane Web"): clicking it returns to the page view with the AI chat.
  function frontendTab() {
    const more = findText("^more$", { maxLen: 10 }).map((d) => byId(d.id)).find((el) => el && !el.closest(LAYERS));
    if (!more) return null;
    const mr = more.getBoundingClientRect();
    const midY = mr.top + mr.height / 2;
    const candidates = [...document.querySelectorAll(INTERACTIVE + ",div,span,a")]
      .filter((el) => isVisible(el) && el !== more && !el.contains(more) && !more.contains(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => r.right <= mr.left + 2 && Math.abs(r.top + r.height / 2 - midY) < 14 && clean(el.innerText).length > 1 && clean(el.innerText).length < 40 && !/^beta$/i.test(clean(el.innerText)))
      .filter(({ el }) => el.matches(INTERACTIVE) || pointer(el));
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.r.right - a.r.right); // the one right before "More"
    const target = clickableFor(candidates[0].el);
    return { ...describe(target), text: clean(target.innerText) };
  }

  // A "Back" control that leaves a sub-view of the editor (e.g. a workflow canvas, where the
  // Edit/Run toggle isn't shown). Never one inside the AI chat panel.
  function backTarget() {
    const panel = chatPanel();
    const outsideChat = (el) => el && !(panel && panel.contains(el)) && !el.closest(OUR_UI);
    const byText = findText("^(?:‹|<|←|〈)?\\s*back$", { maxLen: 8 }).map((d) => byId(d.id));
    const byLabel = [...document.querySelectorAll("[aria-label],[title]")].filter(
      (el) => isVisible(el) && /^(go )?back$/i.test((el.getAttribute("aria-label") || el.getAttribute("title") || "").trim())
    );
    const hits = [...byText, ...byLabel].filter(outsideChat);
    if (!hits.length) return null;
    hits.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return { ...describe(hits[0]), text: clean(hits[0].innerText) || labelOf(hits[0]) };
  }

  // Section headers of the editor's left column — the AI chat's title row ("…chat name…" with
  // its plans / + / history / ^ icons) and "Page Structure" with its chevron. Clicking them only
  // collapses sections or starts new chats, so nothing should click them.
  let headerCache = { t: 0, rows: [] };
  let computingHeaders = false;
  function headerRows() {
    if (computingHeaders) return []; // computeHeaderRows → findText → describe → here: don't recurse
    if (Date.now() - headerCache.t < 500) return headerCache.rows; // one scan per snapshot
    computingHeaders = true;
    try {
      headerCache = { t: Date.now(), rows: computeHeaderRows() };
    } finally {
      computingHeaders = false;
    }
    return headerCache.rows;
  }
  function computeHeaderRows() {
    const leftEdge = innerWidth * 0.4;
    const labels = [
      ...findText("^page structure$", { maxLen: 20 }),
      ...findText('^["“].{2,90}["”]$', { maxLen: 95 }),
    ]
      .map((d) => byId(d.id))
      .filter((el) => el && !el.closest(OUR_UI) && el.getBoundingClientRect().right <= leftEdge);
    return labels.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
  }
  function isHeaderControl(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.left > innerWidth * 0.4 || r.height > 60) return false;
    const mid = r.top + r.height / 2;
    return headerRows().some((y) => Math.abs(y - mid) < 16);
  }

  // Right edge of the editor's left column (AI chat + Page Structure). Falls back to 35% of the
  // viewport when the chat isn't found.
  function leftColumnRight() {
    const p = chatPanel();
    return p ? p.getBoundingClientRect().right : innerWidth * 0.35;
  }

  // The AI chat section was collapsed (its header's chevron): find the control that opens it again.
  // Prefer an explicit aria-expanded="false" toggle in the left column; otherwise the right-most
  // small icon on the top header row of the left column (where the chat title and its ^/⌄ sit).
  function chatExpandTarget() {
    const leftEdge = innerWidth * 0.4;
    const inLeft = (r) => r.right <= leftEdge && r.top > 30 && r.width > 0;
    const toggles = [...document.querySelectorAll("[aria-expanded='false']")]
      .filter((el) => isVisible(el) && inLeft(el.getBoundingClientRect()))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (toggles.length) return { ...describe(toggles[0]), how: "aria-expanded" };
    const icons = [...document.querySelectorAll("button,[role=button],svg,span,div")]
      .map((el) => (el.tagName.toLowerCase() === "svg" ? el.closest("button,[role=button]") || el.parentElement : el))
      .filter((el, i, arr) => el && arr.indexOf(el) === i && isVisible(el) && (el.matches("button,[role=button]") || pointer(el)))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => inLeft(r) && r.width <= 40 && r.height <= 40 && clean(el.innerText).length <= 1);
    if (!icons.length) return null;
    const topRow = Math.min(...icons.map((i) => i.r.top + i.r.height / 2));
    const row = icons.filter((i) => Math.abs(i.r.top + i.r.height / 2 - topRow) < 12).sort((a, b) => b.r.right - a.r.right);
    return { ...describe(row[0].el), how: "header chevron" };
  }

  // The close control of a side panel with this title (e.g. Scram's "Plans" panel, which can
  // cover the Edit/Run toggle). Its × is often an unlabeled icon, so besides "Close"/"×" labels
  // we take the right-most small clickable in the panel's header row.
  function panelCloseTarget(titlePattern) {
    // Only a real panel heading (big text, outside the AI chat column) — not e.g. a "Plans"
    // tooltip on the chat header's icon, whose row also holds the chat's collapse chevron.
    const chat = chatPanel();
    const title = findText(titlePattern, { maxLen: 20 })
      .map((d) => byId(d.id))
      .find((el) => {
        if (!el || el.closest(OUR_UI) || (chat && chat.contains(el))) return false;
        return parseFloat(getComputedStyle(el).fontSize) >= 15 && el.getBoundingClientRect().height >= 14;
      });
    if (!title) return null;
    const tr = title.getBoundingClientRect();
    for (let box = title.parentElement, i = 0; box && box !== document.body && i < 8; box = box.parentElement, i++) {
      if (chat && box.contains(chat)) break; // grew past the panel into the page around the chat
      const br = box.getBoundingClientRect();
      if (br.width < 300) continue;
      const clickables = [...box.querySelectorAll("button,[role=button],[aria-label],[title],svg,span,div,a")]
        .filter((el) => isVisible(el) && el !== title && !el.contains(title))
        .map((el) => (el.tagName.toLowerCase() === "svg" || el.closest("svg") ? el.closest("button,[role=button]") || el.closest("svg").parentElement : el))
        .filter((el, idx, arr) => el && arr.indexOf(el) === idx && box.contains(el))
        .filter((el) => el.matches("button,[role=button]") || pointer(el))
        .filter((el) => !el.hasAttribute("aria-expanded") && !/collapse|expand|minimi[sz]e/i.test(`${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`));
      const labelled = clickables.find((el) => /^(close|dismiss|close panel|hide)$/i.test((el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()) || /^[×✕✖xX]$/.test(clean(el.innerText)));
      if (labelled) return describe(labelled);
      // An icon-sized control on the title's row, right of it, furthest right.
      const icons = clickables
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width <= 48 && r.height <= 48 && r.left > tr.right && Math.abs(r.top + r.height / 2 - (tr.top + tr.height / 2)) < 24 && clean(el.innerText).length <= 1)
        .sort((a, b) => b.r.right - a.r.right);
      if (icons.length) return describe(icons[0].el);
    }
    return null;
  }
  // Kept for older callers: closes it with a script click.
  function closePanel(titlePattern) {
    const t = panelCloseTarget(titlePattern);
    if (!t) return false;
    byId(t.id)?.click();
    return true;
  }

  // The AI chat's title row: the chat's name (in quotes) and its icons left → right (plans list,
  // + new chat, chat history, ^ collapse). Used only to start a fresh chat.
  function chatHeaderInfo() {
    const leftEdge = innerWidth * 0.4;
    const title = findText('^["“].{2,90}["”]$', { maxLen: 95 })
      .map((d) => byId(d.id))
      .filter((el) => el && !el.closest(OUR_UI) && el.getBoundingClientRect().right <= leftEdge)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    if (!title) return null;
    const tr = title.getBoundingClientRect();
    const mid = tr.top + tr.height / 2;
    const icons = [...document.querySelectorAll("button,[role=button],[aria-label],[title],svg")]
      .map((el) => (el.tagName.toLowerCase() === "svg" || el.closest("svg") ? el.closest("button,[role=button]") || el.closest("svg").parentElement : el))
      .filter((el, i, arr) => el && arr.indexOf(el) === i && isVisible(el) && !el.contains(title) && !title.contains(el))
      .filter((el) => el.matches("button,[role=button]") || pointer(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => r.width <= 44 && r.height <= 44 && r.left >= tr.left && r.right <= leftEdge && Math.abs(r.top + r.height / 2 - mid) < 16 && clean(el.innerText).length <= 2)
      .sort((a, b) => a.r.left - b.r.left)
      .map(({ el }) => ({ ...describe(el), text: clean(el.innerText), hint: `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.getAttribute("data-tooltip") || ""}`.trim() }));
    return { title: clean(title.innerText), icons };
  }
  function newChatTarget() {
    const info = chatHeaderInfo();
    if (!info?.icons.length) return null;
    const named = info.icons.find((i) => /new (chat|conversation|thread)|start (a )?new/i.test(i.hint) || /^\+$/.test(i.text));
    if (named) return { ...named, how: "label", title: info.title };
    // No labels: the + is the second icon (plans, +, history, ^).
    const pick = info.icons.length >= 3 ? info.icons[1] : null;
    return pick ? { ...pick, how: "position", title: info.title } : null;
  }

  // ---------------------------------------------------------------- browser-use toolset helpers
  // An accessibility-tree view of the page with stable refs ("ref_N", never renumbered), like
  // the read_page / find tools Claude in Chrome uses.
  let nextRef = 1;
  let refPrefix = ""; // "app_" inside the Run preview frame, so its refs never clash with the editor's
  const refOf = (el) => {
    if (!el.dataset.sabRef) el.dataset.sabRef = `${refPrefix}ref_${nextRef++}`;
    return el.dataset.sabRef;
  };
  const setRefPrefix = (p) => {
    refPrefix = String(p || "");
    return true;
  };
  // Resolves once the page stops changing (no DOM mutations for quietMs), or after maxMs.
  function settle(quietMs = 350, maxMs = 2500) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve(true);
      };
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      });
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, quietMs);
      const cap = setTimeout(done, maxMs);
    });
  }
  const byRef = (ref) => document.querySelector(`[data-sab-ref="${CSS.escape(String(ref))}"]`);
  const IMPLICIT = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button", IMG: "img", IFRAME: "iframe", DIALOG: "dialog", NAV: "navigation", MAIN: "main", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading", LABEL: "label", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", UL: "list", OL: "list", LI: "listitem" };
  function roleOfEl(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.tagName === "INPUT") return { checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", search: "searchbox" }[el.type] || "textbox";
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return IMPLICIT[el.tagName] || "";
  }
  const pointerish = (el) => {
    try {
      return getComputedStyle(el).cursor === "pointer" && !(el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer");
    } catch {
      return false;
    }
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  function lineFor(el, allowHeader) {
    const interactive = el.matches(INTERACTIVE) || pointerish(el);
    let role = roleOfEl(el);
    let name = "";
    if (interactive) {
      role ||= "clickable";
      name = labelOf(el);
    } else if (/^(heading|img|iframe|dialog|alertdialog|menu|listbox|tooltip|navigation|main|tablist|columnheader|cell|label)$/.test(role)) {
      name = role === "img" ? clean(el.getAttribute("alt") || el.getAttribute("aria-label") || "") : role === "iframe" ? clean(el.getAttribute("title") || el.getAttribute("name") || el.src || "") : clean(el.getAttribute("aria-label") || (/heading|columnheader|cell|label/.test(role) ? el.innerText : "")).slice(0, 120);
    } else {
      const t = ownText(el);
      if (!t) return null;
      role = "text";
      name = t.slice(0, 200);
    }
    const bits = [];
    if (/^H[1-6]$/.test(el.tagName)) bits.push(`level=${el.tagName[1]}`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    const checked = el.type === "checkbox" || el.type === "radio" ? el.checked : el.getAttribute("aria-checked");
    if (checked != null && checked !== "") bits.push(`checked=${checked}`);
    if (el.getAttribute("aria-expanded")) bits.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) bits.push("selected");
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && el.type !== "password" && el.value) bits.push(`value="${clean(String(el.value)).slice(0, 80)}"`);
    if (el.getAttribute("placeholder") && !el.value) bits.push(`placeholder="${clean(el.getAttribute("placeholder")).slice(0, 60)}"`);
    if (el.tagName === "A" && hrefOf(el)) bits.push(`href="${hrefOf(el)}"`);
    if (interactive && isHeaderControl(el)) bits.push(allowHeader ? "chat title row" : "OFF-LIMITS section header");
    return `${role} "${name.replace(/"/g, "'")}" [${refOf(el)}]${bits.length ? ` (${bits.join(", ")})` : ""}`;
  }
  function a11yTree({ filter = "", ref = "", depth = 15, allowHeader = false, maxChars = 50000 } = {}) {
    const root = ref ? byRef(ref) : document.body;
    if (!root) return { error: `${ref} is stale or not found on the current page. Re-read the page to get fresh references.` };
    const out = [];
    let chars = 0;
    let truncated = false;
    const walk = (el, level) => {
      if (truncated || level > depth) return;
      if (el.closest?.(OUR_UI) || el.dataset?.sabSkip) return;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH"].includes(el.tagName?.toUpperCase())) {
        if (el.tagName.toUpperCase() !== "SVG" || !pointerish(el)) return;
      }
      const vis = isVisible(el);
      if (!vis) {
        try {
          if (getComputedStyle(el).display === "none") return;
        } catch {
          return;
        }
      }
      let next = level;
      if (vis && (filter === "all" || inView(el))) {
        const interactive = el.matches(INTERACTIVE) || pointerish(el);
        if (filter !== "interactive" || interactive) {
          const line = lineFor(el, allowHeader);
          if (line) {
            const s = `${"  ".repeat(level)}${line}`;
            if (chars + s.length > maxChars) {
              truncated = true;
              return;
            }
            out.push(s);
            chars += s.length + 1;
            next = level + 1;
            if (interactive && !["textbox", "combobox", "listbox", "menu", "dialog"].includes(roleOfEl(el))) {
              // A control's own text is in its name already: don't list its inner text nodes.
              for (const c of el.children) if (c.matches?.(INTERACTIVE) || pointerish(c)) walk(c, next);
              return;
            }
          }
        }
      }
      for (const c of el.children) walk(c, next);
    };
    walk(root, 0);
    return { text: out.join("\n") + (truncated ? `\n[Output truncated at ${maxChars} characters — use filter "interactive" or a container ref to narrow it.]` : ""), url: location.href, title: document.title };
  }
  function findRefs(query, { allowHeader = false } = {}) {
    const words = clean(query).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const lines = a11yTree({ filter: "all", allowHeader, maxChars: 400000 }).text.split("\n").map((l) => l.trim()).filter(Boolean);
    const scored = lines
      .map((l) => {
        const low = l.toLowerCase();
        const score = words.reduce((n, w) => n + (low.includes(w) ? (new RegExp(`\\b${w}\\b`).test(low) ? 2 : 1) : 0), 0) + (/^(button|link|textbox|tab|menuitem|clickable|combobox|checkbox|switch|option)/.test(low) ? 0.5 : 0);
        return { l, score };
      })
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    return { text: scored.map((x) => x.l).join("\n") };
  }
  // The element a ref points at, scrolled into view: its centre and what it is (for safety checks).
  function refTarget(ref) {
    const el = byRef(ref);
    if (!el || !isVisible(el)) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, ...guardInfo(el) };
  }
  function guardInfo(el) {
    const ctl = el.closest?.(INTERACTIVE) || el;
    const chatInput = findChatInput();
    const chatEl = chatInput ? byId(chatInput) : null;
    return { label: labelOf(ctl).slice(0, 120), role: roleOfEl(ctl), tag: ctl.tagName.toLowerCase(), header: isHeaderControl(ctl) || isHeaderControl(el) || false, chatBox: !!(chatEl && (chatEl === ctl || chatEl.contains(el) || el.contains?.(chatEl))), iframe: el.tagName === "IFRAME" };
  }
  function elementAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? guardInfo(el) : null;
  }
  function focusedInfo() {
    const el = document.activeElement;
    return el && el !== document.body ? guardInfo(el) : null;
  }
  function formInput(ref, value) {
    const el = byRef(ref);
    if (!el) return { error: `${ref} is stale or not found on the current page. Re-read the page to get fresh references.` };
    el.scrollIntoView({ block: "nearest" });
    if (el.tagName === "SELECT") {
      const opt = [...el.options].find((o) => o.value === String(value) || clean(o.text) === clean(String(value)));
      if (!opt) return { error: `No option "${value}" in ${ref}. Options: ${[...el.options].map((o) => clean(o.text)).join(", ")}` };
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, text: `Selected "${clean(opt.text)}" in ${ref}.` };
    }
    if (el.type === "checkbox" || el.type === "radio" || /checkbox|switch|radio/.test(el.getAttribute("role") || "")) {
      const want = value === true || value === "true";
      const now = el.type ? el.checked : el.getAttribute("aria-checked") === "true";
      if (now !== want) el.click();
      return { ok: true, text: `Set ${ref} to ${want}.` };
    }
    const r = typeText(idOf(el), String(value ?? ""));
    return r.ok ? { ok: true, text: `Set ${ref} to "${String(value).slice(0, 80)}".` } : { error: `Couldn't type into ${ref}.` };
  }
  function scrollToRef(ref) {
    const el = byRef(ref);
    if (!el) return { error: `${ref} is stale or not found on the current page. Re-read the page to get fresh references.` };
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return { ok: true };
  }
  const viewport = () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, url: location.href, title: document.title });

  // Scram project overview (after clicking "More"): the project's name, shown above
  // "Describe your project…". Returns a click target for it.
  function projectNameTarget() {
    const desc =
      findText("^describe your project", { maxLen: 120 }).map((d) => byId(d.id)).find(Boolean) ||
      [...document.querySelectorAll("[placeholder],[data-placeholder],[aria-placeholder]")].find(
        (el) => isVisible(el) && /^describe your project/i.test(el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("aria-placeholder") || "")
      );
    if (!desc) return null;
    for (let el = desc; el && el !== document.body; el = el.parentElement) {
      for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
        const t = clean(prev.innerText);
        if (t && t.length <= 80 && isVisible(prev)) {
          let leaf = prev;
          while (leaf.children.length === 1 && clean(leaf.children[0].innerText) === t) leaf = leaf.children[0];
          return { ...describe(leaf), text: t };
        }
      }
    }
    return null;
  }

  // Type into whatever has focus (e.g. the project name after clicking it), replacing its content.
  function typeActive(text) {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, error: "nothing is focused" };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return typeText(idOf(el), text);
    return { ok: false, error: `focused element is a ${el.tagName.toLowerCase()}, not a text field` };
  }

  window.__sabDom = {
    a11yTree, findRefs, refTarget, elementAt, focusedInfo, formInput, scrollToRef, viewport, setRefPrefix, settle,
    findText, modeToggle, closePanel, panelCloseTarget, projectNameTarget, typeActive, backTarget, frontendTab, chatPanelBox, chatExpandTarget, chatHeaderInfo, newChatTarget, isHeaderId: (id) => isHeaderControl(byId(id)),
    snapshot, describeTarget, click, typeText, pressKey, scroll, bodyText, signature, extract,
    findChatInput, findSendButton, inputValue, isGenerating, chatText, awaitingUser, attachFile, attachVia, scanChat, fileShown, composerState, centerOf, expandCollapsed, chatAtBottom, previewFrame, chatColumn,
    scrollChatToBottom: () => { const r = scrollChatToBottom(); return { ok: r.ok, moved: !!r.moved }; },
    ping: () => true,
  };
})();
