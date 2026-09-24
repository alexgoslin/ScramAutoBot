// Runs on dashboard.buildwithscram.com. Shows a small build-queue overlay and,
// when a build is active, tries to open a new project and paste the current
// step into the Scram AI chat. Scram's DOM isn't a public API, so every
// automatic action is best-effort with a manual fallback (clipboard + buttons).

(() => {
  if (window.__scramAutoBotLoaded) return;
  window.__scramAutoBotLoaded = true;

  const INPUT_WAIT_MS = 5 * 60 * 1000;
  let state = null;
  let root = null;
  let waitingObserver = null;

  const send = (type, extra = {}) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...extra }, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: "No response" });
      });
    });

  // ------------------------------------------------------------------ DOM helpers

  const isVisible = (el) => {
    if (!el || root?.contains(el)) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };

  function findNewProjectButton() {
    const re = /^\s*(\+\s*)?(new|create)\s+(a\s+)?(new\s+)?(project|app)\b/i;
    return Array.from(document.querySelectorAll("button,a,[role=button]")).find(
      (el) => isVisible(el) && re.test((el.innerText || el.getAttribute("aria-label") || "").trim())
    );
  }

  function findChatInput() {
    const candidates = Array.from(
      document.querySelectorAll("textarea, [contenteditable='true'], [contenteditable=''], [role=textbox]")
    ).filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
    if (!candidates.length) return null;
    const hint = /ask|message|describe|build|chat|prompt|what|type|tell/i;
    const score = (el) => {
      const label = `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.dataset?.placeholder || ""}`;
      let s = hint.test(label) ? 10 : 0;
      // Chat inputs are usually in the lower part of the viewport.
      s += el.getBoundingClientRect().top / window.innerHeight;
      return s;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }

  function findSendButton(input) {
    const scope = input.closest("form") || input.parentElement?.parentElement?.parentElement || document;
    const buttons = Array.from(scope.querySelectorAll("button,[role=button]")).filter(isVisible);
    return (
      buttons.find((b) => /send|submit|run|build|generate/i.test(`${b.getAttribute("aria-label") || ""} ${b.innerText || ""} ${b.title || ""}`)) ||
      buttons.find((b) => b.type === "submit") ||
      null
    );
  }

  function insertText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // Use the native setter so React/Vue-controlled inputs see the change.
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === text;
    }
    // contenteditable editors (ProseMirror, Lexical, Tiptap...)
    const sel = window.getSelection();
    sel.selectAllChildren(el);
    if (document.execCommand("insertText", false, text) && el.innerText.trim().length > 0) return true;
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    return el.innerText.trim().length > 0;
  }

  async function copy(text) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ overlay

  function ensureOverlay() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "scram-autobot-overlay";
    root.innerHTML = `
      <div class="sab-head">
        <span class="sab-title">Scram AutoBot</span>
        <button class="sab-icon" data-act="min" title="Minimise">–</button>
      </div>
      <div class="sab-body">
        <div class="sab-step"></div>
        <div class="sab-status"></div>
        <div class="sab-actions">
          <button data-act="paste" class="sab-primary">Paste into chat</button>
          <button data-act="copy">Copy step</button>
          <button data-act="newproj">New project</button>
        </div>
        <button data-act="done" class="sab-done">✓ Step done — send next</button>
      </div>`;
    document.documentElement.appendChild(root);
    root.addEventListener("click", onClick);
    return root;
  }

  function setStatus(msg, kind = "") {
    const el = ensureOverlay().querySelector(".sab-status");
    el.textContent = msg;
    el.dataset.kind = kind;
  }

  function render() {
    if (!state?.active) {
      root?.remove();
      root = null;
      return;
    }
    ensureOverlay();
    const stepEl = root.querySelector(".sab-step");
    const doneBtn = root.querySelector("[data-act=done]");
    if (state.finished) {
      stepEl.innerHTML = `<strong>All ${state.totalSteps} steps done 🎉</strong>`;
      doneBtn.disabled = true;
      root.querySelector("[data-act=paste]").disabled = true;
      return;
    }
    const s = state.step;
    stepEl.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = `Step ${s.stepNumber}: ${s.title}`;
    const small = document.createElement("small");
    small.textContent = ` (${state.stepIndex + 1} of ${state.totalSteps}) · ${new URL(state.siteUrl).hostname}`;
    stepEl.append(strong, small);
    doneBtn.disabled = false;
    root.querySelector("[data-act=paste]").disabled = false;
  }

  async function onClick(e) {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "min") return root.classList.toggle("sab-min");
    if (act === "copy" && state?.step) {
      setStatus((await copy(state.step.content)) ? "Copied to clipboard." : "Couldn't copy — click the page first.", "");
    }
    if (act === "paste") pasteCurrent({ manual: true });
    if (act === "newproj") {
      const btn = findNewProjectButton();
      if (btn) {
        btn.click();
        setStatus("Clicked “New project”. Finish creating it, then paste.");
        waitForInputAndPaste();
      } else setStatus("Couldn't find a “New project” button — create one manually.", "warn");
    }
    if (act === "done") {
      const res = await send("scram:completeCurrent");
      if (!res.ok) return setStatus(res.error, "error");
      state = res.data;
      render();
      // The background worker sends "scram:pasteStep" for the next step.
      if (state.finished) setStatus("Build queue complete.", "ok");
    }
  }

  // ------------------------------------------------------------------ paste flow

  function pastedKey() {
    return `scramAutoBot:pasted:${state.siteUrl}:${state.step.stepNumber}:${state.progress.startedAt || ""}`;
  }

  async function pasteCurrent({ manual }) {
    if (!state?.active || !state.step) return;
    await copy(state.step.content);
    const input = findChatInput();
    if (!input) {
      setStatus("Waiting for the Scram chat box… (step copied to clipboard — you can paste with Ctrl/Cmd+V)", "warn");
      waitForInputAndPaste();
      return;
    }
    const ok = insertText(input, state.step.content);
    if (!ok) {
      setStatus("Couldn't type into the chat automatically. The step is on your clipboard — paste it with Ctrl/Cmd+V.", "warn");
      return;
    }
    sessionStorage.setItem(pastedKey(), "1");
    if (state.autoSubmit) {
      setTimeout(() => {
        const btn = findSendButton(input);
        if (btn && !btn.disabled) btn.click();
        else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        setStatus(`Sent step ${state.step.stepNumber}. When Scram finishes, click “Step done”.`, "ok");
      }, 300);
    } else {
      setStatus(`Step ${state.step.stepNumber} pasted${manual ? "" : " automatically"}. Review it and hit send in Scram, then click “Step done” when it's built.`, "ok");
    }
  }

  function waitForInputAndPaste() {
    if (waitingObserver) return;
    const started = Date.now();
    waitingObserver = new MutationObserver(() => {
      if (Date.now() - started > INPUT_WAIT_MS) return stopWaiting();
      if (findChatInput()) {
        stopWaiting();
        // Give the editor a moment to finish mounting.
        setTimeout(() => pasteCurrent({}), 600);
      }
    });
    waitingObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopWaiting() {
    waitingObserver?.disconnect();
    waitingObserver = null;
  }

  async function refresh({ autoRun }) {
    const res = await send("scram:getState");
    if (!res.ok) return;
    state = res.data;
    render();
    if (!state.active || state.finished || !autoRun) return;

    if (!state.progress.autoProjectAttempted && state.step && !state.progress.completedSteps.length) {
      await send("scram:markProjectAttempted");
      const btn = findNewProjectButton();
      if (btn) {
        btn.click();
        setStatus("Opened a new Scram project — waiting for the chat box…");
      } else {
        setStatus("Create a new project in Scram. Step 0 will be pasted into the chat once it appears.", "warn");
      }
      waitForInputAndPaste();
      return;
    }
    if (!sessionStorage.getItem(pastedKey())) waitForInputAndPaste();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "scram:pasteStep") {
      refresh({ autoRun: false }).then(() => pasteCurrent({}));
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.activeBuild || changes.buildProgress) refresh({ autoRun: false });
  });

  refresh({ autoRun: true });
})();
