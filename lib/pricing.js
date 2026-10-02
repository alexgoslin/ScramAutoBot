// Estimated cost of Claude API calls, from Anthropic's published list prices (USD per
// million tokens, first-party API). Cache writes are billed at 1.25× the input price
// (5-minute cache) and cache reads at the listed read price. These are estimates — your
// Anthropic Console billing is the source of truth.

const M = 1_000_000;

// Longest matching prefix wins, so dated IDs (claude-haiku-4-5-20251001) match too.
const PRICES = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1.0 }],
  ["claude-mythos", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-4", { input: 1, output: 5, cacheRead: 0.1 }],
];

// Unknown IDs: fall back on the family name.
const FAMILY = [
  [/fable|mythos/i, { input: 10, output: 50, cacheRead: 1.0 }],
  [/opus/i, { input: 5, output: 25, cacheRead: 0.5 }],
  [/sonnet/i, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku/i, { input: 1, output: 5, cacheRead: 0.1 }],
];

export function priceFor(model) {
  const id = String(model || "").toLowerCase();
  const hit = PRICES.filter(([prefix]) => id.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0];
  if (hit) return hit[1];
  return (FAMILY.find(([re]) => re.test(id)) || FAMILY[2])[1];
}

// Dollars for one response's `usage` block.
export function costOf(model, usage = {}) {
  const p = priceFor(model);
  return (
    ((usage.input_tokens || 0) * p.input +
      (usage.cache_creation_input_tokens || 0) * p.input * 1.25 +
      (usage.cache_read_input_tokens || 0) * p.cacheRead +
      (usage.output_tokens || 0) * p.output) /
    M
  );
}

export function formatCost(dollars) {
  const d = Number(dollars) || 0;
  if (d === 0) return "$0.00";
  if (d < 0.01) return "<$0.01";
  return `$${d.toFixed(d < 10 ? 2 : d < 1000 ? 2 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// Usage totals saved before cost tracking existed have tokens but no dollars: estimate those
// at the default model's (Claude Sonnet 5) prices, without cache discounts.
export function totalCost(usage) {
  if (!usage) return 0;
  if (typeof usage.cost === "number") return usage.cost;
  return ((usage.input || 0) * 2 + (usage.output || 0) * 10) / M;
}
