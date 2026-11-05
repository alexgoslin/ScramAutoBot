// Minimal Anthropic Messages API client for use from the service worker.
// Streams the response so long generations don't hit idle-connection timeouts
// and so callers can show progress.

const API_URL = "https://api.anthropic.com/v1/messages";
const ALWAYS_THINKS = /^claude-(opus-5|fable|mythos|sonnet-5-5|haiku-5)/i;
// Quick helper calls on Haiku (the crawler's navigator, element search) think only a little.
const QUICK = /^claude-haiku-5/i;

// max_tokens caps thinking AND the reply together. Models that always think can spend a small
// budget entirely on thinking and stop (stop_reason "max_tokens") before writing any text — an
// empty reply. So the floor depends on the thinking effort, with room left for the answer.
// Only tokens actually used are billed.
const EFFORT_FLOOR = { low: 16000, medium: 32000, high: 64000, xhigh: 96000, max: 128000 };
export function outputBudget(model, maxTokens, effort) {
  if (!ALWAYS_THINKS.test(model || "")) return maxTokens;
  const floor = EFFORT_FLOOR[effort || (QUICK.test(model || "") ? "low" : "medium")] || 32000;
  return Math.min(128000, Math.max((maxTokens || 0) + 8000, floor));
}

// A failed or empty call, with everything needed to see why (kept in the run's error record).
export class ClaudeCallError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
    this.status = details?.status ?? null;
  }
}

export async function callClaude({ apiKey, model, system, userContent, maxTokens, effort, onProgress }) {
  if (!apiKey) throw new Error("No Anthropic API key set. Open the extension Options page to add one.");
  const max_tokens = outputBudget(model, maxTokens, effort);
  const inputChars = (system || "").length + (typeof userContent === "string" ? userContent.length : (userContent || []).reduce((n, b) => n + (b.text ? b.text.length : 0), 0));
  const details = { model, effort: effort || null, max_tokens, inputChars };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for requests that originate from a browser context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens,
      // The big system prompts (extractor, splitter, Scram guide) repeat on every call:
      // mark them cacheable so repeat calls read them at a fraction of the input price.
      // Prompts under the model's minimum cacheable size are simply not cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
      // How hard to think (current models only; e.g. "high" for the operator agents).
      ...((effort || QUICK.test(model || "")) && ALWAYS_THINKS.test(model || "") ? { output_config: { effort: effort || "low" } } : {}),
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new ClaudeCallError(`Claude API error (${res.status}): ${msg}`, { ...details, status: res.status, apiError: body?.error ? { type: body.error.type, message: body.error.message } : null });
  }

  let text = "";
  let stopReason = null;
  let usage = {};
  let lastProgress = 0;
  const blockTypes = [];

  const handleEvent = (data) => {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    switch (evt.type) {
      case "message_start":
        usage = { ...evt.message?.usage };
        break;
      case "content_block_start":
        blockTypes.push(evt.content_block?.type || "unknown");
        break;
      case "content_block_delta":
        if (evt.delta?.type === "text_delta") {
          text += evt.delta.text;
          if (onProgress && Date.now() - lastProgress > 1000) {
            lastProgress = Date.now();
            onProgress(text.length);
          }
        }
        break;
      case "message_delta":
        stopReason = evt.delta?.stop_reason ?? stopReason;
        usage = { ...usage, ...evt.usage };
        break;
      case "error":
        throw new ClaudeCallError(`Claude API error: ${evt.error?.message || "stream error"}`, { ...details, status: 200, apiError: { type: evt.error?.type || "stream_error", message: evt.error?.message || "" } });
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    // SSE events are separated by a blank line; each has "event:" and "data:" lines.
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) handleEvent(data);
    }
    if (done) break;
  }

  return { text, stopReason, usage, blockTypes, details: { ...details, status: res.status, stop_reason: stopReason, input_tokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), output_tokens: usage.output_tokens || 0, blocks: blockTypes } };
}

// One turn of a multi-turn, tool-using conversation (e.g. the browser use toolset). Streams the
// response and rebuilds its content blocks exactly (text, thinking with signatures, tool_use
// with toolset_name) so they can be passed back unchanged on the next turn.
export async function callMessages({ apiKey, model, system, messages, tools, maxTokens = 16000, effort, betas = [], thinking, extra = {} }) {
  if (!apiKey) throw new Error("No Anthropic API key set. Open the extension Options page to add one.");
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: outputBudget(model, maxTokens, effort), // room for thinking + the reply
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools,
      // Caches the growing conversation, so each turn only pays full price for what's new.
      cache_control: { type: "ephemeral" },
      ...(thinking ? { thinking } : {}),
      ...(effort && ALWAYS_THINKS.test(model || "") ? { output_config: { effort } } : {}),
      ...extra,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Claude API error (${res.status}): ${body?.error?.message || `HTTP ${res.status}`}`);
  }
  const blocks = [];
  const json = {};
  let stopReason = null;
  let usage = {};
  let servedModel = model;
  const handleEvent = (data) => {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    switch (evt.type) {
      case "message_start":
        usage = { ...evt.message?.usage };
        servedModel = evt.message?.model || model;
        break;
      case "content_block_start":
        blocks[evt.index] = { ...evt.content_block };
        if (blocks[evt.index].type === "tool_use") json[evt.index] = "";
        break;
      case "content_block_delta": {
        const b = blocks[evt.index];
        const d = evt.delta || {};
        if (!b) break;
        if (d.type === "text_delta") b.text = (b.text || "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
        else if (d.type === "input_json_delta") json[evt.index] = (json[evt.index] || "") + d.partial_json;
        break;
      }
      case "content_block_stop": {
        const b = blocks[evt.index];
        if (b?.type === "tool_use" && json[evt.index]) {
          try {
            b.input = JSON.parse(json[evt.index]);
          } catch {
            b.input = { __invalid: json[evt.index] };
          }
        }
        break;
      }
      case "message_delta":
        stopReason = evt.delta?.stop_reason ?? stopReason;
        usage = { ...usage, ...evt.usage };
        break;
      case "error":
        throw new Error(`Claude API error: ${evt.error?.message || "stream error"}`);
    }
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const data = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) handleEvent(data);
    }
    if (done) break;
  }
  return { content: blocks.filter(Boolean), stopReason, usage, model: servedModel };
}

// Fix the mistakes models typically make in JSON: raw newlines/tabs/control characters
// inside strings (e.g. a multi-line message) and trailing commas.
function repairJson(s) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (ch < " ") out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      else out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

// Every top-level balanced {…} object in a text, in order (braces inside strings ignored).
export function balancedObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) out.push({ start, end: i + 1, text: text.slice(start, i + 1) });
    }
  }
  return out;
}

// Pull a JSON object out of a model response that may be wrapped in prose or ``` fences:
// fenced blocks first, then each balanced {…} object, then the whole text.
// `what` names the caller in the error, e.g. "Scram supervisor".
export function extractJson(text, what = "Claude") {
  text = String(text || "");
  const candidates = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  for (const o of balancedObjects(text)) candidates.push(o.text);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  let parseError = "";
  for (const c of candidates) {
    for (const attempt of [c.trim(), repairJson(c.trim())]) {
      try {
        const v = JSON.parse(attempt);
        if (v && typeof v === "object") return v;
      } catch (e) {
        parseError ||= e.message; // the first (most telling) parse error, with its position
      }
    }
  }
  const err = new Error(text.trim() ? `${what} reply wasn't valid JSON.` : `${what} reply was empty.`);
  err.raw = text; // the actual reply, for Ask Autopilot / the run's error record
  err.parseError = parseError || "no JSON object found in the reply";
  throw err;
}
