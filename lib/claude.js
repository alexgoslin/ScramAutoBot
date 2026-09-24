// Minimal Anthropic Messages API client for use from the service worker.

const API_URL = "https://api.anthropic.com/v1/messages";

export async function callClaude({ apiKey, model, system, userContent, maxTokens }) {
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
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Claude API error (${res.status}): ${msg}`);
  }

  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return { text, stopReason: body.stop_reason, usage: body.usage };
}

// Pull a JSON object out of a model response that may be wrapped in prose or ``` fences.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
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
