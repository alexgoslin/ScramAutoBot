// Category cloning: instead of one site, research a whole category (e.g. "forms and surveys"):
// pick representative sites from the bundled market dataset (the human confirms each), crawl every
// one of them (the human logs in / signs up first), digest each, then hold a tribunal — an
// organiser lists the points of debate, three advocates argue FOR, IMPARTIALLY and AGAINST, and a
// judge decides — and turn the judge's blueprint into build steps for one combined app.
// It runs inside Autopilot (phases cat-*), so Pause/Resume, chat and the Scram build all work as usual.

import * as store from "./storage.js";
import { ask, askJson, scramLimitations } from "./jobs.js";
import * as explorer from "./explorer.js";

const slug = (s) => String(s || "category").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "category";
// Category runs reuse everything keyed by a site address, so each category gets a pseudo address.
export const categoryKey = (name) => `https://${slug(name)}.category`;
export const isCategoryKey = (url) => {
  try {
    return new URL(url).hostname.endsWith(".category");
  } catch {
    return false;
  }
};

let dataset = null;
export async function loadDataset() {
  if (!dataset) dataset = await (await fetch(chrome.runtime.getURL("data/market-dataset.json"))).json();
  return dataset;
}

// ------------------------------------------------------------------ 1. propose sites

const PROPOSE_SYSTEM = `You pick the websites to research for a "category clone": the human wants one app for a whole software category, built in Scram (a no-code app builder) by learning from several leading products in that category. You get the human's request and a market dataset (products with category, website, essential scope, use cases, user complaints, scores and rank).

Pick the sites worth crawling and comparing, best first: the leaders users know, plus products that do the core job differently or notably better/worse, so the comparison is rich. Prefer products in the dataset (use their website exactly); you may add a well-known product that's missing (fromDataset false) only if the dataset has too few. Skip products the dataset marks "avoid" unless the human asks. Each "why" is one line: what this site adds to the comparison.

Return ONLY JSON: {"category":"<the dataset category, or your own name>","appIdea":"<one line: the app we're building>","sites":[{"product":"...","url":"https://…","why":"...","fromDataset":true}]}`;

export async function proposeSites(ctx) {
  const c = ctx.state.category;
  const ds = await loadDataset();
  const want = c.name.toLowerCase();
  const words = want.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const cats = [...new Set(ds.products.map((p) => p.category))];
  const matched = cats.filter((k) => words.some((w) => k.toLowerCase().includes(w)) || k.toLowerCase().includes(want));
  const pool = ds.products.filter((p) => matched.includes(p.category));
  const rows = (pool.length ? pool : ds.products)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 60)
    .map((p) => `- ${p.product} (${p.category}) — ${p.website || "?"} · score ${p.score ?? "?"} · rank ${p.rank ?? "?"}${p.avoid ? " · AVOID" : ""}${p.priority ? ` · priority ${p.priority}` : ""}\n  scope: ${p.essentialScope || "?"}\n  complaints: ${p.dissatisfaction || "?"}`)
    .join("\n");
  const userContent = `The human's category: "${c.name}"${c.instructions ? `\nTheir instructions: ${c.instructions}` : ""}
Number of sites they want to compare: about ${c.siteCount}.

All dataset categories: ${cats.join(", ")}

Products (${pool.length ? `in matching categories: ${matched.join(", ")}` : "no category matched — the whole dataset, best first"}):
${rows}`;
  const res = await askJson({ what: "Site picker", system: PROPOSE_SYSTEM, userContent, maxTokens: 4000 });
  const sites = (Array.isArray(res.sites) ? res.sites : [])
    .map((s) => ({ product: String(s.product || "").trim(), url: normalizeUrl(s.url), why: String(s.why || "").trim(), fromDataset: s.fromDataset !== false, decision: null }))
    .filter((s) => s.product && s.url)
    .slice(0, Math.max(2, Math.min(10, c.siteCount + 2)));
  return { category: String(res.category || c.name), appIdea: String(res.appIdea || ""), sites };
}

export function normalizeUrl(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(String(u)) ? String(u) : `https://${u}`);
    return url.origin;
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ 2. crawl each site
// Each site is crawled with the normal explorer, through a sub-context whose "state" is that
// site's own record (its address, crawl queue, scope), saved back into the category run.

export function memberCtx(ctx, m) {
  const c = ctx.state.category;
  const sub = {
    siteUrl: m.siteUrl,
    explore: m.explore,
    scope: m.scope || null,
    instructions: [
      `This crawl is one of several sites researched for a category clone ("${c.name}"). Focus on the core product features of this category${c.appIdea ? ` (${c.appIdea})` : ""}.`,
      c.instructions,
    ].filter(Boolean).join("\n"),
    notes: ctx.state.notes || [],
  };
  return {
    ...ctx,
    settings: { ...ctx.settings, maxPages: ctx.settings.categoryPagesPerSite || 10 },
    state: sub,
    async save(patch = {}) {
      Object.assign(sub, patch);
      m.explore = sub.explore;
      m.scope = sub.scope;
      await ctx.save({ category: c });
    },
  };
}

export async function crawlStep(ctx, m) {
  const more = await explorer.explorePage(memberCtx(ctx, m));
  if (more) return true;
  // Tag this site's specs with the category, so the category's Files/handoff can find them.
  const ids = new Set((m.explore.pages || []).map((p) => p.specId).filter(Boolean));
  const key = ctx.state.siteUrl;
  const all = await store.get("specFiles", []);
  await store.set("specFiles", all.map((s) => (ids.has(s.id) ? { ...s, categoryKey: key, categoryProduct: m.product } : s)));
  return false;
}

export async function memberSpecs(state) {
  const all = await store.get("specFiles", []);
  return all.filter((s) => s.categoryKey === state.siteUrl);
}

// ------------------------------------------------------------------ 3. digest each site

const DIGEST_SYSTEM = `You condense the crawl of ONE product (a set of per-screen specs written while exploring it) into a digest for a panel that will compare several products in the same category and decide how to build our own. Be concrete and complete; keep real labels, flows and numbers. Markdown with these sections:
## Product & users: what it is, who uses it, the main job it does.
## Features: every core feature: what it does, how it works step by step, how it's presented (screens, layout, controls).
## Navigation & information architecture: main areas, how screens connect.
## Visual design: look and feel, layout patterns, notable components.
## Data model & backend (theorised): main entities and relations, how key actions are wired (workflows, validation, side effects).
## Strengths: what this product does better than typical.
## Weaknesses: friction, missing pieces, user complaints (use the market notes).
## Notable details: anything distinctive worth copying or avoiding.`;

export async function digestSite(ctx, m, specs) {
  const ds = await loadDataset();
  const row = ds.products.find((p) => p.product.toLowerCase() === m.product.toLowerCase());
  const body = specs.map((s) => `<!-- ${s.pageTitle} (${s.pageUrl}) -->\n${s.content}`).join("\n\n---\n\n").slice(0, 180000);
  const market = row ? `Market notes for ${row.product}: scope: ${row.essentialScope || "?"}; use cases: ${row.useCases || "?"}; complaints: ${row.dissatisfaction || "?"}; hard features: ${row.hardFeatures || "?"}; integrations: ${row.integrations || "?"}` : "";
  const { text } = await ask({ system: DIGEST_SYSTEM, userContent: `Product: ${m.product} (${m.siteUrl})\n${market}\n\nScreen specs from the crawl:\n${body || "(no screens captured)"}`, maxTokens: 12000 });
  return `# ${m.product} — digest\n\n${String(text || "").trim()}`;
}

// ------------------------------------------------------------------ 4. the tribunal

const ORGANISER_SYSTEM = `You organise a design tribunal. Several products in one software category were researched; you get a digest of each. We'll build ONE app for this category in Scram. Turn everything into POINTS OF DEBATE for three advocates and a judge: every place where the products differ or where we must choose — which features to include, how each feature should work, how it's presented and where it lives (layout, navigation, which screen), the estimated backend architecture and data model, how actions are wired (workflows, validation, side effects), visual design. Cover EVERY part of the products; 15–35 points. Each point names the competing approaches with the products that use them.

Return ONLY JSON: {"appName":"<an original name for our app>","appIdea":"<one line>","points":[{"id":"P1","area":"feature|presentation|navigation|architecture|workflow|design|scope","topic":"<short>","question":"<the decision to make>","approaches":[{"site":"<product>","how":"<how that product does it>"}],"stakes":"<why it matters to users>"}]}`;

const ROLE_SYSTEM = {
  for: `You are the advocate FOR in a design tribunal deciding how to build one app for a software category in Scram. For EVERY point of debate, argue for including the feature/approach in its strongest, most complete form: the richest version among the products, and why users need it. Be specific and cite the products. Also note what Scram would need for it.`,
  impartial: `You are the impartial member of a design tribunal deciding how to build one app for a software category in Scram. For EVERY point of debate, weigh the approaches on their merits (user value, simplicity, consistency with the rest of the app, cost to build in Scram, Scram's limits) and give your own recommendation with reasons. Cite the products.`,
  against: `You are the advocate AGAINST in a design tribunal deciding how to build one app for a software category in Scram. For EVERY point of debate, argue against including the feature/approach, or for the simplest version: complexity, clutter, cost to build, Scram's limits, risk of bugs, what users actually complain about. Be specific and cite the products.`,
};
const ROLE_FORMAT = `Return ONLY JSON: {"arguments":[{"id":"<point id>","position":"<one line>","argument":"<2–5 sentences>"}]} with one entry per point, in order.`;

const JUDGE_SYSTEM = `You are the judge of a design tribunal. Several products in one software category were researched (digests attached), an organiser listed the points of debate, and three advocates argued each point (FOR, IMPARTIAL, AGAINST). Decide every point, weighing all three views, the products' evidence, user complaints and Scram's limits. Then write the BLUEPRINT for the one app we'll build in Scram: it becomes the source of truth for writing the build steps.

Write Markdown:
# <app name> — blueprint
## Product: what it is, who it's for, the core job.
## Decisions: one bullet per point: **P<n> <topic>: <decision>**, then why (which arguments won, which product it follows).
## Features to build: each feature: what it does, how it works step by step, where it lives and how it's presented, and which product it's modelled on.
## Left out: features we deliberately don't build, and why.
## Screens & navigation: every screen, what's on it, how users move between them.
## Data model: entities, fields, relations, permissions.
## Workflows: key actions, how they're wired (inputs, steps, side effects, validation, errors).
## Design direction: look and feel, layout patterns, components.
Be decisive and specific: no "consider", no "optionally".`;

export async function organise(ctx, digests) {
  const c = ctx.state.category;
  const userContent = `Category: ${c.name}${c.appIdea ? ` — ${c.appIdea}` : ""}${c.instructions ? `\nThe human's instructions: ${c.instructions}` : ""}\n\n${digests.join("\n\n---\n\n")}`;
  const res = await askJson({ what: "Tribunal organiser", system: ORGANISER_SYSTEM, userContent, maxTokens: 16000 });
  const points = (Array.isArray(res.points) ? res.points : [])
    .map((p, i) => ({
      id: String(p.id || `P${i + 1}`),
      area: String(p.area || ""),
      topic: String(p.topic || "").trim(),
      question: String(p.question || "").trim(),
      approaches: (Array.isArray(p.approaches) ? p.approaches : []).map((a) => ({ site: String(a.site || ""), how: String(a.how || "") })),
      stakes: String(p.stakes || ""),
    }))
    .filter((p) => p.question);
  if (!points.length) throw new Error("the organiser found no points of debate");
  return { appName: String(res.appName || ""), appIdea: String(res.appIdea || ""), points };
}

export const pointsMarkdown = (t) =>
  `# Tribunal — points of debate\n\n${t.appName ? `**App:** ${t.appName}${t.appIdea ? ` — ${t.appIdea}` : ""}\n\n` : ""}${t.points
    .map((p) => `## ${p.id} · ${p.topic} (${p.area})\n**Question:** ${p.question}\n${p.approaches.map((a) => `- **${a.site}:** ${a.how}`).join("\n")}${p.stakes ? `\n\n_Why it matters:_ ${p.stakes}` : ""}`)
    .join("\n\n")}`;

export async function argue(ctx, role, digests, points, limits) {
  const userContent = `Scram's limits:\n${limits}\n\nProduct digests:\n${digests.join("\n\n---\n\n")}\n\nPOINTS OF DEBATE:\n${JSON.stringify(points)}`;
  const res = await askJson({ what: `Tribunal ${role}`, system: `${ROLE_SYSTEM[role]}\n\n${ROLE_FORMAT}`, userContent, maxTokens: 24000 });
  return (Array.isArray(res.arguments) ? res.arguments : []).map((a) => ({ id: String(a.id || ""), position: String(a.position || ""), argument: String(a.argument || "") }));
}

export const argumentsMarkdown = (role, args, points) =>
  `# Tribunal — ${role === "for" ? "the case FOR" : role === "against" ? "the case AGAINST" : "the impartial view"}\n\n${args
    .map((a) => `## ${a.id} · ${points.find((p) => p.id === a.id)?.topic || ""}\n**${a.position}**\n\n${a.argument}`)
    .join("\n\n")}`;

export async function judge(ctx, digests, t, args, limits) {
  const byPoint = t.points
    .map((p) => {
      const get = (role) => args[role]?.find((a) => a.id === p.id);
      const line = (label, a) => (a ? `${label}: ${a.position} — ${a.argument}` : `${label}: (no argument)`);
      return `${p.id} · ${p.topic} — ${p.question}\nApproaches: ${p.approaches.map((a) => `${a.site}: ${a.how}`).join(" | ")}\n${line("FOR", get("for"))}\n${line("IMPARTIAL", get("impartial"))}\n${line("AGAINST", get("against"))}`;
    })
    .join("\n\n");
  const c = ctx.state.category;
  const userContent = `Category: ${c.name}. Proposed app: ${t.appName || "(name it)"} — ${t.appIdea || c.appIdea || ""}${c.instructions ? `\nThe human's instructions (they override the tribunal): ${c.instructions}` : ""}\n\nScram's limits:\n${limits}\n\nTHE ARGUMENTS, POINT BY POINT:\n${byPoint}\n\nPRODUCT DIGESTS (evidence):\n${digests.join("\n\n---\n\n")}`;
  const op = { model: ctx.settings.operatorModel || ctx.settings.model, effort: ctx.settings.operatorEffort || "high" };
  const { text } = await ask({ system: JUDGE_SYSTEM, userContent, maxTokens: 32000, ...op });
  return String(text || "").trim();
}

export async function tribunalLimits() {
  return scramLimitations().catch(() => "");
}

// Saved docs of a category run (digests, debate points, arguments, blueprint) for the Files tab.
export async function saveDoc(key, title, content) {
  const all = await store.get("categoryDocs", {});
  const docs = (all[key] || []).filter((d) => d.title !== title);
  docs.push({ title, content, savedAt: new Date().toISOString() });
  all[key] = docs;
  await store.set("categoryDocs", all);
}

// Inputs for (re)generating a category's build steps from what its run saved.
export async function handoffInputs(key) {
  const docs = (await store.get("categoryDocs", {}))[key] || [];
  const blueprint = docs.find((d) => /blueprint/i.test(d.title))?.content || "";
  if (!blueprint) throw new Error("This category has no tribunal blueprint yet — run the category clone first.");
  const specs = docs
    .filter((d) => /^Digest — /.test(d.title))
    .map((d) => ({ siteUrl: key, pageUrl: key, pageTitle: d.title.replace(/^Digest — /, ""), content: d.content, capturedAt: d.savedAt }));
  const detailSpecs = (await store.get("specFiles", [])).filter((s) => s.categoryKey === key);
  return { blueprint, specs, detailSpecs };
}
