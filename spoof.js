// Runs in the page's own JavaScript world (MAIN) before any of Scram's scripts, so Scram only ever
// sees the patched APIs. Makes a background Scram tab look and behave like the tab you're looking at:
//   1. The page always reports itself visible and focused, and never hears that it was hidden.
//   2. requestAnimationFrame keeps firing (Chrome stops it completely in hidden tabs).
//   3. setTimeout / setInterval keep their real timing (Chrome slows them to once a second in hidden
//      tabs, and to once a minute after 5 minutes).
// 2 and 3 move to a Web Worker's clock while the tab is really hidden; Chrome doesn't throttle workers.
(() => {
  if (window.__scramKeepAlive) return;
  window.__scramKeepAlive = true;

  // How often requestAnimationFrame fires while the tab is hidden. Nobody sees these frames, so
  // this only needs to be fast enough to keep the app's logic moving, not smooth.
  const BACKGROUND_FRAME_MS = 50;

  const docProto = Document.prototype;
  const realHiddenGetter = Object.getOwnPropertyDescriptor(docProto, "hidden").get;
  const reallyHidden = () => realHiddenGetter.call(document);

  // --- 1. Visibility and focus ---------------------------------------------------------------

  const define = (name, value) => {
    try {
      Object.defineProperty(docProto, name, { get: () => value, configurable: true, enumerable: true });
    } catch {
      /* not defined in this browser */
    }
  };
  define("hidden", false);
  define("webkitHidden", false);
  define("visibilityState", "visible");
  define("webkitVisibilityState", "visible");
  docProto.hasFocus = function hasFocus() {
    return true;
  };

  // A window-level capture listener added before any of the page's runs first for events on the
  // document and on window itself, so stopping it here means the page never sees them. Only
  // window-level blur/focus are blocked: blurs of inputs and buttons inside the page still happen.
  // The real visibility change is still seen here first, to switch clocks (set up further down).
  let onRealVisibility = () => {};
  const swallow = (e) => e.stopImmediatePropagation();
  window.addEventListener("visibilitychange", (e) => {
    swallow(e);
    onRealVisibility();
  }, true);
  for (const type of ["webkitvisibilitychange", "freeze"]) window.addEventListener(type, swallow, true);
  for (const type of ["blur", "focusout"]) {
    window.addEventListener(type, (e) => {
      if (e.target === window || e.target === document) e.stopImmediatePropagation();
    }, true);
  }

  // --- Worker clock ------------------------------------------------------------------------------

  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeRAF = window.requestAnimationFrame.bind(window);

  let worker = null;
  try {
    const src = `
      const timers = new Map();
      let frameTimer = null;
      onmessage = ({ data: m }) => {
        if (m.op === "set") timers.set(m.key, setTimeout(() => { timers.delete(m.key); postMessage({ t: "timer", key: m.key }); }, m.delay));
        else if (m.op === "clear") { clearTimeout(timers.get(m.key)); timers.delete(m.key); }
        else if (m.op === "frames-on" && frameTimer === null) frameTimer = setInterval(() => postMessage({ t: "frame" }), m.every);
        else if (m.op === "frames-off") { clearInterval(frameTimer); frameTimer = null; }
      };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    worker = new Worker(url, { name: "scram-keep-alive" });
    URL.revokeObjectURL(url);
  } catch {
    // The page's security policy blocks blob workers: visibility spoofing still works, but
    // timers and frames fall back to Chrome's normal (throttled) background behaviour.
    worker = null;
  }

  // --- 3. Timers -----------------------------------------------------------------------------------

  // id -> { cb, args, delay, repeat, due, gen, nativeHandle }
  const timers = new Map();
  let nextTimerId = 1;

  const schedule = (id, rec) => {
    rec.gen++;
    const wait = Math.max(0, rec.due - performance.now());
    if (worker && reallyHidden()) {
      rec.nativeHandle = null;
      worker.postMessage({ op: "set", key: `${id}:${rec.gen}`, delay: wait });
    } else {
      const gen = rec.gen;
      rec.nativeHandle = nativeSetTimeout(() => fire(id, gen), wait);
    }
  };

  const unschedule = (id, rec) => {
    if (rec.nativeHandle != null) nativeClearTimeout(rec.nativeHandle);
    else if (worker) worker.postMessage({ op: "clear", key: `${id}:${rec.gen}` });
    rec.nativeHandle = null;
  };

  const fire = (id, gen) => {
    const rec = timers.get(id);
    if (!rec || rec.gen !== gen) return; // cleared, or moved to the other clock since
    if (rec.repeat) {
      const now = performance.now();
      rec.due = Math.max(rec.due + rec.delay, now);
      schedule(id, rec);
    } else {
      timers.delete(id);
    }
    try {
      rec.cb.apply(window, rec.args);
    } catch (err) {
      reportError(err);
    }
  };

  const addTimer = (repeat) => function (cb, delay, ...args) {
    // String callbacks are rare and need eval; leave them to Chrome.
    if (typeof cb !== "function") return (repeat ? nativeSetInterval : nativeSetTimeout)(cb, delay, ...args);
    const ms = Math.max(Number(delay) || 0, repeat ? 4 : 0);
    const id = nextTimerId++;
    const rec = { cb, args, delay: ms, repeat, due: performance.now() + ms, gen: 0, nativeHandle: null };
    timers.set(id, rec);
    schedule(id, rec);
    return id;
  };
  const clearTimer = function (id) {
    const rec = timers.get(id);
    if (!rec) return nativeClearTimeout(id); // a string-callback timer handed to Chrome
    unschedule(id, rec);
    timers.delete(id);
  };

  // --- 2. Animation frames -----------------------------------------------------------------------

  // id -> callback, waiting for the next frame from either Chrome (visible) or the worker (hidden).
  let frameQueue = new Map();
  let nextFrameId = 1;
  let nativeFramePending = false;

  const runFrames = (time) => {
    const batch = frameQueue;
    frameQueue = new Map(); // callbacks queued during this frame run on the next one
    for (const cb of batch.values()) {
      try {
        cb(time);
      } catch (err) {
        reportError(err);
      }
    }
  };

  const raf = function requestAnimationFrame(cb) {
    const id = nextFrameId++;
    frameQueue.set(id, cb);
    if (!nativeFramePending) {
      nativeFramePending = true;
      nativeRAF((t) => {
        nativeFramePending = false;
        runFrames(t);
      });
    }
    return id;
  };
  const caf = function cancelAnimationFrame(id) {
    frameQueue.delete(id);
  };

  // --- Wire it up --------------------------------------------------------------------------------

  if (worker) {
    worker.onmessage = ({ data: m }) => {
      if (m.t === "timer") {
        const [id, gen] = m.key.split(":").map(Number);
        fire(id, gen);
      } else if (m.t === "frame" && frameQueue.size) {
        runFrames(performance.now());
      }
    };

    window.setTimeout = addTimer(false);
    window.setInterval = addTimer(true);
    window.clearTimeout = clearTimer;
    window.clearInterval = clearTimer;
    window.requestAnimationFrame = raf;
    window.cancelAnimationFrame = caf;

    // When the tab really hides or shows, move every pending timer to the clock that won't be
    // throttled, and start or stop the worker's frame tick.
    onRealVisibility = () => {
      for (const [id, rec] of timers) {
        unschedule(id, rec);
        schedule(id, rec);
      }
      worker.postMessage(reallyHidden() ? { op: "frames-on", every: BACKGROUND_FRAME_MS } : { op: "frames-off" });
    };
    if (reallyHidden()) onRealVisibility(); // opened straight into a background tab
  }
})();
