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

// Shared by every tribunal member. The tribunal used to cut things "because they're costly to
// build" and split every point down the middle, which gave a bare-minimum app with no coherent
// idea behind it. Building is Scram's AI's job, so effort is never a reason; the only hard limits
// are Scram's official ones.
const TRIBUNAL_GROUND_RULES = `Ground rules for everyone in the tribunal:
- We are making a product people would choose over the leaders, not a minimum viable clone. The bar is "feels as good as the best product in the category", with the leaders' friction removed.
- BUILD EFFORT IS NOT A REASON. Scram's AI builds everything; nobody here pays for complexity in time. Never cut or downgrade something because it is "costly", "a lot of work", "engine work" or "would need a custom component". Scram can build custom components and use the HTML Element and Run Code (JavaScript) for rich interactions (drag and drop, keyboard shortcuts, inline editing, live previews, client-side search and validation).
- The ONLY hard limits are Scram's official "can NOT do" list (given to you). Cut or simplify something only for that, or for a real user reason: it confuses people, clutters the screen, risks their data, or users of these products complain about it.
- Think like a user of these products. What do people coming from the leaders EXPECT to just work? (e.g. in a form builder: dragging fields onto the form and reordering them by dragging, like arranging blocks in Word or Notion.) Those expectations are non-negotiable unless Scram can't do them.
- Use what you know about these products, not just the crawl. The crawls are partial (some screens weren't reached); you may add well-known features or behaviours of these products, marked "(known, not crawled)".
- Coherence beats a pile of features: every choice should fit one clear idea of the product and its core interaction.`;

const ORGANISER_SYSTEM = `You organise a design tribunal. Several products in one software category were researched; you get a digest of each. We'll build ONE app for this category in Scram.

${TRIBUNAL_GROUND_RULES}

First, the PRODUCT VISION, so every later decision fits one idea:
- coreExperience: the one interaction the product lives or dies by (e.g. "building a form by dragging blocks onto a live canvas"), described concretely.
- expectations: 8–15 things a user arriving from the leading products will expect to just work, especially the interaction details (drag and drop, inline editing, keyboard shortcuts, undo, instant feedback, live preview, autosave…). Name which products set each expectation.
- signatureIdeas: 2–5 ways our app can be better than all of them for its users (from the complaints and weaknesses in the digests).

Then the POINTS OF DEBATE for three advocates and a judge: every place where the products differ or where we must choose. Cover EVERY part of the products: which features to include, HOW each feature feels to use (the interaction model: direct manipulation, drag and drop, inline vs panel editing, keyboard flow, feedback, undo), how it's presented and where it lives (layout, navigation, screen), the backend and data model, how actions are wired (workflows, validation, side effects), visual design. The first points must be the core experience and the interaction model of the main screen. 20–40 points. Each names the competing approaches with the products that use them.

Return ONLY JSON: {"appName":"<an original name for our app>","appIdea":"<one line>","vision":{"coreExperience":"...","expectations":["<expectation> (<products>)"],"signatureIdeas":["..."]},"points":[{"id":"P1","area":"experience|interaction|feature|presentation|navigation|architecture|workflow|design|scope","topic":"<short>","question":"<the decision to make>","approaches":[{"site":"<product>","how":"<how that product does it>"}],"stakes":"<why it matters to users>"}]}`;

const ROLE_SYSTEM = {
  for: `You are the advocate FOR in a design tribunal deciding how to build one app for a software category in Scram.

${TRIBUNAL_GROUND_RULES}

For EVERY point of debate, argue for the strongest, most delightful version: the best of the products combined, and better where the leaders have friction. Describe how it should FEEL to use (interactions, states, feedback), why users want it, and how Scram can build it (custom components, HTML Element, Run Code for rich interactions). Cite the products.`,
  impartial: `You are the impartial member of a design tribunal deciding how to build one app for a software category in Scram.

${TRIBUNAL_GROUND_RULES}

For EVERY point of debate, recommend what a best-in-class product would do for OUR users, weighing user value, how well it fits the product vision and the rest of the app, users' expectations from the leaders, complaints, and Scram's official limits. Not the middle option by default: if the rich version is right, say so. Describe the interaction concretely. Cite the products.`,
  against: `You are the advocate AGAINST in a design tribunal deciding how to build one app for a software category in Scram.

${TRIBUNAL_GROUND_RULES}

Your job is to stop the app becoming bloated or confusing, NOT to make it cheap. For EVERY point of debate, argue against what would hurt users: clutter, too many ways to do one thing, settings nobody needs, confusing flows, risks to their data or privacy, things users of these products complain about, and features Scram's official limits rule out. Never argue from build effort. If a rich version is clearly what users expect, say so and argue only against its excesses. Cite the products.`,
};
const ROLE_FORMAT = `Return ONLY JSON: {"arguments":[{"id":"<point id>","position":"<one line>","argument":"<3–6 sentences>"}]} with one entry per point, in order.`;

const BLUEPRINT_FORMAT = `Write Markdown:
# <app name> — blueprint
## Product: what it is, who it's for, the core job.
## Product vision: the core experience in a short paragraph; 4–6 experience principles (each one line, with what it means in practice); the signature interactions users will notice (each described concretely: what you do and what you see).
## First five minutes: a walk-through of a new user's first session, screen by screen and action by action, as they'd experience it.
## Decisions: one bullet per point: **P<n> <topic>: <decision>**, then why, in terms of the users and the products (what users expect, what the products show, which complaints it avoids, which Scram limit forces it). Never just "X won".
## Features to build: each feature: what it does, how it works step by step, the interaction in detail (what's draggable or editable in place and how, hover/selected/dragging/empty/loading/error states, keyboard shortcuts, undo, feedback such as toasts or inline confirmation), where it lives and how it's presented, and which product it's modelled on. For rich interactions, say how Scram builds them (custom component, HTML Element, Run Code) and the fallback only if Scram's AI reports it can't.
## Left out: features we deliberately don't build, and the user reason or the Scram limit for each. Never "too costly".
## Screens & navigation: every screen, what's on it, how users move between them.
## Data model: entities, fields, relations, permissions.
## Workflows: key actions, how they're wired (inputs, steps, side effects, validation, errors).
## Design direction: a distinctive, coherent look that suits this product and its users (not a generic clone of one product): palette, type, density, shapes, motion and feedback, layout patterns, key components and their states.
Be decisive and specific: no "consider", no "optionally".`;

const JUDGE_SYSTEM = `You are the judge of a design tribunal. Several products in one software category were researched (digests attached), an organiser set out the product vision and the points of debate, and three advocates argued each point (FOR, IMPARTIAL, AGAINST). Decide every point, then write the BLUEPRINT for the one app we'll build in Scram: it becomes the source of truth for writing the build steps.

${TRIBUNAL_GROUND_RULES}

How to decide:
- Start from the product vision and the users' expectations. Decide every point so it serves that one idea, and so all decisions fit together (one interaction model, one visual language, consistent patterns across screens).
- Pick on user value, not on who argued: no point is won by default, and the middle option is not automatically right. When users of the leading products expect something (e.g. drag and drop), keep it unless Scram's official limits rule it out.
- Use AGAINST to remove clutter and risk, not to strip the product down.

${BLUEPRINT_FORMAT}`;

const CRITIC_SYSTEM = `You are a demanding product critic reviewing a blueprint for a new app in a software category, to be built in Scram. You've used all the leading products in this category for years. You get the blueprint, the product vision, and digests of the leading products.

${TRIBUNAL_GROUND_RULES}

Find everything that would make a real user say "this feels cheap", "this is clunky" or "this doesn't hang together":
- BARE MINIMUM: features or interactions downgraded below what users of the leaders expect (e.g. Move up/down buttons where people expect to drag; a settings menu where people expect to edit in place; a page reload where an instant update is expected), or cut "for cost" rather than for a Scram limit or a user reason.
- MISSING EXPECTATIONS: things users take for granted in this category that the blueprint never mentions (interactions, shortcuts, states, feedback, undo, empty states, mobile).
- INCOHERENCE: decisions that contradict each other or the vision, mixed interaction models, screens that feel like they're from different products, odd or generic design choices.
- VAGUENESS: places the builder would have to guess (an interaction without its states, a screen without its layout).
- FALSE LIMITS: things ruled out as impossible in Scram that aren't on its official "can NOT do" list.

Return Markdown: # Critic's review, then ## Must fix (numbered, most important first: each names the blueprint section or point, what's wrong, and exactly what it should be instead), then ## Should improve (same format), then ## Keep (a few lines on what's strong). Be concrete; no generic advice.`;

const REVISE_SYSTEM = `You are the judge of a design tribunal. You wrote the blueprint below; a product critic has reviewed it. Rewrite the COMPLETE blueprint with every "Must fix" applied and every "Should improve" you agree with (if you reject one, it must be for a Scram limit or a clear user reason, said in the decision). Keep everything that's good. The result must read as one coherent product.

${TRIBUNAL_GROUND_RULES}

${BLUEPRINT_FORMAT}
Output ONLY the full revised blueprint.`;

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
  const v = res.vision || {};
  const vision = {
    coreExperience: String(v.coreExperience || "").trim(),
    expectations: (Array.isArray(v.expectations) ? v.expectations : []).map(String).filter(Boolean),
    signatureIdeas: (Array.isArray(v.signatureIdeas) ? v.signatureIdeas : []).map(String).filter(Boolean),
  };
  return { appName: String(res.appName || ""), appIdea: String(res.appIdea || ""), vision, points };
}

const visionText = (v) =>
  v && (v.coreExperience || v.expectations?.length)
    ? `Core experience: ${v.coreExperience || "?"}\nWhat users will expect:\n${(v.expectations || []).map((e) => `- ${e}`).join("\n")}\nWhere we can be better:\n${(v.signatureIdeas || []).map((e) => `- ${e}`).join("\n")}`
    : "";
const visionMarkdown = (v) =>
  v && (v.coreExperience || v.expectations?.length)
    ? `## Product vision\n**Core experience:** ${v.coreExperience || "?"}\n\n**What users will expect to just work:**\n${(v.expectations || []).map((e) => `- ${e}`).join("\n")}\n\n**Where we can be better than all of them:**\n${(v.signatureIdeas || []).map((e) => `- ${e}`).join("\n")}\n\n`
    : "";

export const pointsMarkdown = (t) =>
  `# Tribunal — points of debate\n\n${t.appName ? `**App:** ${t.appName}${t.appIdea ? ` — ${t.appIdea}` : ""}\n\n` : ""}${visionMarkdown(t.vision)}${t.points
    .map((p) => `## ${p.id} · ${p.topic} (${p.area})\n**Question:** ${p.question}\n${p.approaches.map((a) => `- **${a.site}:** ${a.how}`).join("\n")}${p.stakes ? `\n\n_Why it matters:_ ${p.stakes}` : ""}`)
    .join("\n\n")}`;

export async function argue(ctx, role, digests, points, limits, vision = null) {
  const userContent = `Scram's limits:\n${limits}\n\n${vision ? `PRODUCT VISION (from the organiser):\n${visionText(vision)}\n\n` : ""}Product digests:\n${digests.join("\n\n---\n\n")}\n\nPOINTS OF DEBATE:\n${JSON.stringify(points)}`;
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
  const userContent = `Category: ${c.name}. Proposed app: ${t.appName || "(name it)"} — ${t.appIdea || c.appIdea || ""}${c.instructions ? `\nThe human's instructions (they override the tribunal): ${c.instructions}` : ""}\n\nScram's limits:\n${limits}\n\n${t.vision ? `PRODUCT VISION (from the organiser):\n${visionText(t.vision)}\n\n` : ""}THE ARGUMENTS, POINT BY POINT:\n${byPoint}\n\nPRODUCT DIGESTS (evidence):\n${digests.join("\n\n---\n\n")}`;
  const op = { model: ctx.settings.operatorModel || ctx.settings.model, effort: ctx.settings.operatorEffort || "high" };
  const { text } = await ask({ system: JUDGE_SYSTEM, userContent, maxTokens: 32000, ...op });
  return String(text || "").trim();
}

const operatorOf = (ctx) => ({ model: ctx.settings.operatorModel || ctx.settings.model, effort: ctx.settings.operatorEffort || "high" });

// The critic reads the blueprint as a demanding user of the leading products would.
export async function critique(ctx, digests, t, blueprint, limits) {
  const c = ctx.state.category;
  const userContent = `Category: ${c.name}${c.instructions ? `\nThe human's instructions: ${c.instructions}` : ""}\n\nScram's limits:\n${limits}\n\n${t.vision ? `PRODUCT VISION:\n${visionText(t.vision)}\n\n` : ""}THE BLUEPRINT:\n${blueprint}\n\nPRODUCT DIGESTS (evidence):\n${digests.join("\n\n---\n\n").slice(0, 200000)}`;
  const { text } = await ask({ system: CRITIC_SYSTEM, userContent, maxTokens: 12000, ...operatorOf(ctx) });
  return String(text || "").trim();
}

// The judge rewrites the whole blueprint with the critic's fixes.
export async function revise(ctx, digests, t, blueprint, review, limits) {
  const c = ctx.state.category;
  const userContent = `Category: ${c.name}${c.instructions ? `\nThe human's instructions (they override the tribunal): ${c.instructions}` : ""}\n\nScram's limits:\n${limits}\n\n${t.vision ? `PRODUCT VISION:\n${visionText(t.vision)}\n\n` : ""}YOUR BLUEPRINT:\n${blueprint}\n\nTHE CRITIC'S REVIEW:\n${review}\n\nPRODUCT DIGESTS (evidence):\n${digests.join("\n\n---\n\n").slice(0, 160000)}`;
  const { text } = await ask({ system: REVISE_SYSTEM, userContent, maxTokens: 32000, ...operatorOf(ctx) });
  const out = String(text || "").trim();
  return out.length > blueprint.length * 0.5 ? out : blueprint; // a truncated rewrite never replaces the original
}

// The whole tribunal: organiser → FOR / impartial / AGAINST → judge → critic → judge's revision.
// t holds progress (so a resumed run carries on where it stopped); save() persists it.
export async function runTribunal(ctx, key, digests, t, { save = async () => {} } = {}) {
  const limits = await tribunalLimits();
  const log = (m) => ctx.log(m);
  if (!t.points) {
    await log(`⚖️ Tribunal: the organiser is reading all ${digests.length} digests, setting out the product vision and the points of debate…`);
    Object.assign(t, await organise(ctx, digests));
    await saveDoc(key, "Tribunal 1 — points of debate", pointsMarkdown(t));
    await save();
    if (t.vision?.coreExperience) await log(`⚖️ Core experience: ${t.vision.coreExperience.slice(0, 200)}`);
    await log(`⚖️ ${t.points.length} points of debate: ${t.points.slice(0, 6).map((p) => p.topic).join("; ")}${t.points.length > 6 ? "; …" : ""}.`);
  }
  t.args ||= {};
  const roles = ["for", "impartial", "against"].filter((r) => !t.args[r]);
  if (roles.length) {
    await log(`⚖️ The advocates are arguing every point (${roles.map((r) => (r === "for" ? "FOR" : r === "against" ? "AGAINST" : "impartial")).join(", ")})…`);
    const results = await Promise.all(roles.map((r) => argue(ctx, r, digests, t.points, limits, t.vision).then((a) => [r, a])));
    for (const [r, a] of results) {
      t.args[r] = a;
      await saveDoc(key, `Tribunal ${r === "for" ? "2 — the case FOR" : r === "impartial" ? "3 — the impartial view" : "4 — the case AGAINST"}`, argumentsMarkdown(r, a, t.points));
    }
    await save();
  }
  if (!t.draft) {
    await log("⚖️ The judge is weighing all three views and writing the blueprint…");
    t.draft = await judge(ctx, digests, t, t.args, limits);
    await saveDoc(key, "Tribunal 5 — the judge's first draft", t.draft);
    await save();
  }
  if (!t.review) {
    await log("🔎 A product critic is reviewing the blueprint as a demanding user of the leading products would…");
    t.review = await critique(ctx, digests, t, t.draft, limits);
    await saveDoc(key, "Tribunal 6 — the critic's review", t.review);
    await save();
  }
  if (!t.blueprint) {
    await log("⚖️ The judge is rewriting the blueprint with the critic's fixes…");
    t.blueprint = await revise(ctx, digests, t, t.draft, t.review, limits);
    await saveDoc(key, "Tribunal 7 — the final blueprint", t.blueprint);
    await save();
  }
  return t.blueprint;
}

// What the human asked for, saved with the docs so the tribunal can be re-run later.
export async function saveRequest(key, { name, instructions }) {
  await saveDoc(key, "Tribunal 0 — your request", `# Your request\n\n**Category:** ${name}\n\n**Instructions:** ${instructions || "(none)"}`);
}
function readRequest(key, docs) {
  const d = docs.find((x) => x.title === "Tribunal 0 — your request")?.content || "";
  const name = (d.match(/\*\*Category:\*\* (.+)/) || [])[1] || new URL(key).hostname.replace(/\.category$/, "").replace(/-/g, " ");
  const ins = (d.match(/\*\*Instructions:\*\* ([\s\S]+)$/) || [])[1] || "";
  return { name: name.trim(), instructions: ins.trim() === "(none)" ? "" : ins.trim() };
}

// Re-run the tribunal from the saved digests (no re-crawl). Returns the new blueprint.
export async function retribunal(key, { settings, log = async () => {}, instructions = null } = {}) {
  const docs = (await store.get("categoryDocs", {}))[key] || [];
  const digests = docs.filter((d) => /^Digest — /.test(d.title)).map((d) => d.content);
  if (!digests.length) throw new Error("This category has no saved digests — run the category clone first.");
  const req = readRequest(key, docs);
  // Start the tribunal afresh: keep only the digests and the request.
  const all = await store.get("categoryDocs", {});
  all[key] = docs.filter((d) => /^Digest — /.test(d.title) || d.title === "Tribunal 0 — your request");
  await store.set("categoryDocs", all);
  const ctx = { settings, log, state: { category: { name: req.name, instructions: instructions ?? req.instructions } } };
  return runTribunal(ctx, key, digests, {});
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
  const blueprint = (docs.find((d) => /final blueprint/i.test(d.title)) || docs.find((d) => /blueprint/i.test(d.title)))?.content || "";
  if (!blueprint) throw new Error("This category has no tribunal blueprint yet — run the category clone first.");
  const specs = docs
    .filter((d) => /^Digest — /.test(d.title))
    .map((d) => ({ siteUrl: key, pageUrl: key, pageTitle: d.title.replace(/^Digest — /, ""), content: d.content, capturedAt: d.savedAt }));
  const detailSpecs = (await store.get("specFiles", [])).filter((s) => s.categoryKey === key);
  return { blueprint, specs, detailSpecs };
}
