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
    let n = 0;
    for (const el of deepAll("a,button,[role=button],span,div", scope)) {
      if (!isVisible(el) || el.children.length > 2) continue;
      const t = clean(el.innerText || el.textContent);
      if (/^(read more|show more|see more|expand|show full plan|view full plan|view plan|show all|more)\.{0,3}$/i.test(t) && el.getAttribute("aria-expanded") !== "true") {
        el.click();
        n++;
      }
    }
    return n;
  }

  // Viewport centre of an element (for trusted clicks via the debugger).
  function centerOf(target) {
    const el = find(target);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
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

  // Close a side panel with this title (e.g. Scram's "Plans" panel, which hides the Edit/Run toggle).
  function closePanel(titlePattern) {
    const title = findText(titlePattern, { maxLen: 20 }).map((d) => byId(d.id)).find(Boolean);
    if (!title) return false;
    for (let box = title.parentElement, i = 0; box && box !== document.body && i < 6; box = box.parentElement, i++) {
      const close = [...box.querySelectorAll("button,[role=button],[aria-label],span,div")].find(
        (el) => isVisible(el) && (/^(close|dismiss)$/i.test(el.getAttribute("aria-label") || "") || /^[×✕✖x]$/i.test(clean(el.innerText)))
      );
      if (close) {
        close.click();
        return true;
      }
    }
    return false;
  }

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
    findText, modeToggle, closePanel, projectNameTarget, typeActive, backTarget, frontendTab, chatPanelBox,
    snapshot, describeTarget, click, typeText, pressKey, scroll, bodyText, signature, extract,
    findChatInput, findSendButton, inputValue, isGenerating, chatText, awaitingUser, attachFile, attachVia, scanChat, fileShown, composerState, centerOf, expandCollapsed,
    ping: () => true,
  };
})();
