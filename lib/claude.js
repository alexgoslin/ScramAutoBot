// Minimal Anthropic Messages API client for use from the service worker.
// Streams the response so long generations don't hit idle-connection timeouts
// and so callers can show progress.

const API_URL = "https://api.anthropic.com/v1/messages";

export async function callClaude({ apiKey, model, system, userContent, maxTokens, onProgress }) {
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
      max_tokens: maxTokens,
      // The big system prompts (extractor, splitter, Scram guide) repeat on every call:
      // mark them cacheable so repeat calls read them at a fraction of the input price.
      // Prompts under the model's minimum cacheable size are simply not cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
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

// Pull a JSON object out of a model response that may be wrapped in prose or ``` fences.
export function extractJson(text) {
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*)```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* try next */
    }
  }
  throw new Error("Claude's handoff response was not valid JSON.");
}
