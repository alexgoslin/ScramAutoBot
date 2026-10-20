// Minimal Anthropic Messages API client for use from the service worker.
// Streams the response so long generations don't hit idle-connection timeouts
// and so callers can show progress.

const API_URL = "https://api.anthropic.com/v1/messages";
const ALWAYS_THINKS = /^claude-(opus-5|fable|mythos|sonnet-5-5)/i;

export async function callClaude({ apiKey, model, system, userContent, maxTokens, effort, onProgress }) {
  if (!apiKey) throw new Error("No Anthropic API key set. Open the extension Options page to add one.");

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
      // Models that always think (Opus 5.5, Fable, Sonnet 5.5…) count thinking toward max_tokens,
      // so give short calls room — only tokens actually used are billed.
      max_tokens: ALWAYS_THINKS.test(model || "") ? Math.max(maxTokens || 0, 8000) : maxTokens,
      // The big system prompts (extractor, splitter, Scram guide) repeat on every call:
      // mark them cacheable so repeat calls read them at a fraction of the input price.
      // Prompts under the model's minimum cacheable size are simply not cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
      // How hard to think (current models only; e.g. "high" for the operator agents).
      ...(effort && ALWAYS_THINKS.test(model || "") ? { output_config: { effort } } : {}),
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Claude API error (${res.status}): ${msg}`);
  }

  let text = "";
  let stopReason = null;
  let usage = {};
  let lastProgress = 0;

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
        throw new Error(`Claude API error: ${evt.error?.message || "stream error"}`);
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

  return { text, stopReason, usage };
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
      max_tokens: maxTokens,
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

// Pull a JSON object out of a model response that may be wrapped in prose or ``` fences.
// `what` names the caller in the error, e.g. "Scram supervisor".
export function extractJson(text, what = "Claude") {
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const c of candidates) {
    for (const attempt of [c.trim(), repairJson(c.trim())]) {
      try {
        const v = JSON.parse(attempt);
        if (v && typeof v === "object") return v;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(`${what} reply wasn't valid JSON.`);
}
