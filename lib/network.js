// Records a tab's API traffic via chrome.debugger (Chrome DevTools Protocol), so
// specs can describe observed requests instead of guessing. Chrome shows a
// "started debugging this browser" bar while this is attached.

const KEEP_TYPES = new Set(["XHR", "Fetch", "Document", "EventSource", "WebSocket", "Other"]);
const NOISE = /google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.(io|com)|sentry|datadog|newrelic|mixpanel|amplitude|clarity\.ms|optimizely|intercom|fullstory|\/beacon|\/collect\b|\/log(ging)?\b|\/metrics|\/telemetry|\/jot\b/i;

export class NetworkRecorder {
  constructor(tabId, { bodies = true } = {}) {
    this.tabId = tabId;
    this.bodies = bodies;
    this.entries = [];
    this.byId = new Map();
    this.pending = new Set();
    this.attached = false;
    this.onEvent = this.onEvent.bind(this);
    this.onDetach = this.onDetach.bind(this);
  }

  async start() {
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw e;
    }
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
    await chrome.debugger.sendCommand({ tabId: this.tabId }, "Network.enable", { maxPostDataSize: 4000 });
    this.attached = true;
  }

  async stop() {
    chrome.debugger.onEvent.removeListener(this.onEvent);
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (this.attached) await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
    this.attached = false;
  }

  onDetach(source) {
    if (source.tabId === this.tabId) this.attached = false;
  }

  mark() {
    return this.entries.length;
  }

  since(mark) {
    return this.entries.slice(mark);
  }

  get inFlight() {
    return this.pending.size;
  }

  onEvent(source, method, p) {
    if (source.tabId !== this.tabId) return;
    switch (method) {
      case "Network.requestWillBeSent": {
        if (!KEEP_TYPES.has(p.type) || NOISE.test(p.request.url) || /^data:/.test(p.request.url)) return;
        if (p.type === "Other" && p.request.method === "GET") return;
        const e = { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type, postData: p.request.postData?.slice(0, 1500) };
        this.entries.push(e);
        this.byId.set(p.requestId, e);
        this.pending.add(p.requestId);
        break;
      }
      case "Network.responseReceived": {
        const e = this.byId.get(p.requestId);
        if (e) Object.assign(e, { status: p.response.status, mime: p.response.mimeType });
        break;
      }
      case "Network.loadingFinished": {
        const e = this.byId.get(p.requestId);
        this.pending.delete(p.requestId);
        if (e && this.bodies && e.type !== "Document" && /json|text\/plain|graphql/i.test(e.mime || "")) {
          chrome.debugger
            .sendCommand({ tabId: this.tabId }, "Network.getResponseBody", { requestId: p.requestId })
            .then((r) => (e.body = (r.base64Encoded ? "(binary)" : r.body || "").slice(0, 1500)))
            .catch(() => {});
        }
        break;
      }
      case "Network.loadingFailed":
        this.pending.delete(p.requestId);
        if (this.byId.get(p.requestId)) this.byId.get(p.requestId).failed = p.errorText;
        break;
      case "Network.webSocketCreated":
        this.entries.push({ id: p.requestId, method: "WS", url: p.url, type: "WebSocket", frames: [] });
        this.byId.set(p.requestId, this.entries[this.entries.length - 1]);
        break;
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived": {
        const e = this.byId.get(p.requestId);
        if (e?.frames && e.frames.length < 6) e.frames.push(`${method.endsWith("Sent") ? "→" : "←"} ${String(p.response.payloadData).slice(0, 300)}`);
        break;
      }
    }
  }

  // Wait until no tracked request is in flight for `quietMs`, up to `maxMs`.
  async settle(quietMs = 600, maxMs = 6000) {
    const start = Date.now();
    let quietSince = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 150));
      if (this.pending.size) quietSince = Date.now();
      else if (Date.now() - quietSince >= quietMs) return;
    }
  }
}

export function summarizeNetwork(entries, pageOrigin, limit = 30) {
  const seen = new Set();
  const lines = [];
  for (const e of entries) {
    let u;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    const query = [...u.searchParams.keys()].slice(0, 8).map((k) => `${k}=…`).join("&");
    const where = `${u.origin === pageOrigin ? "" : u.host}${u.pathname}${query ? `?${query}` : ""}`;
    const key = `${e.method} ${where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let line = `- ${e.method} ${where} [${e.type}] → ${e.failed ? `FAILED ${e.failed}` : e.status ?? "pending"}${e.mime ? ` ${e.mime}` : ""}`;
    if (e.postData) line += `\n  request body: ${e.postData.replace(/\s+/g, " ").slice(0, 600)}`;
    if (e.body) line += `\n  response (truncated): ${e.body.replace(/\s+/g, " ").slice(0, 600)}`;
    if (e.frames?.length) line += `\n  frames: ${e.frames.join(" | ")}`;
    lines.push(line);
    if (lines.length >= limit) break;
  }
  return lines.length ? lines.join("\n") : "- (no API requests observed)";
}
