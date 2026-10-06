// Claude-backed jobs shared by the manual flow and Autopilot:
// page → Screen Spec, specs → handoff steps, plus a usage-tracking ask() helper.

import * as store from "./storage.js";
import { callClaude, extractJson } from "./claude.js";
import { costOf, totalCost } from "./pricing.js";

export const MAX_PAGE_CHARS = 120000;

// ---------------------------------------------------------------------------
// Prompts: Options-page override wins, otherwise the bundled prompts/*.md file.
// ---------------------------------------------------------------------------

export async function loadPrompt(name, file) {
  const overrides = await store.get("promptOverrides", {});
  if (overrides[name]?.trim()) return overrides[name];
  const res = await fetch(chrome.runtime.getURL(`prompts/${file}`));
  return res.text();
}

// The build guide plus the platform facts from Scram's docs (what Scram can and can't build).
// Used wherever Claude plans or judges Scram work: handoff, Q&A, scope and the build supervisor.
export async function loadScramGuide() {
  const [guide, platform] = await Promise.all([
    loadPrompt("scramGuide", "scram-guide.md"),
    loadPrompt("scramPlatform", "scram-platform.md").catch(() => ""),
  ]);
  return platform ? `${guide}\n\n---\n\n${platform}` : guide;
}

// Just the "can NOT do yet" list from the platform facts.
export async function scramLimitations() {
  const platform = await loadPrompt("scramPlatform", "scram-platform.md").catch(() => "");
  const m = platform.match(/## What Scram can NOT do[\s\S]*?(?=\n## |$)/);
  return m ? m[0].trim() : "";
}

// Claude call that reads the key/settings and tallies token usage.
export async function ask({ system, userContent, maxTokens, model, onProgress }) {
  const [apiKey, settings] = await Promise.all([store.get("apiKey", ""), store.getSettings()]);
  const usedModel = model || settings.model;
  const res = await callClaude({ apiKey, model: usedModel, system, userContent, maxTokens, onProgress });
  const usage = await store.get("usage", { input: 0, output: 0, calls: 0, cost: 0 });
  if (typeof usage.cost !== "number") {
    usage.cost = totalCost(usage); // totals from before cost tracking: start from an estimate
    usage.costEstimated = usage.input + usage.output > 0;
  }
  usage.input += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
  usage.output += res.usage?.output_tokens || 0;
  usage.calls += 1;
  usage.cost += costOf(usedModel, res.usage); // estimated dollars at list prices
  await store.set("usage", usage);
  return res;
}

// Ask for a JSON object. Tolerates prose/fences/raw newlines (see extractJson); if the reply
// still can't be read (or was cut off), asks once more for only the JSON.
// `what` names the caller in errors, e.g. "Scram supervisor".
export async function askJson({ what = "Claude", ...opts }) {
  const first = await ask(opts);
  try {
    if (first.stopReason === "max_tokens") throw new Error("cut off");
    return extractJson(first.text, what);
  } catch {
    const note = `\n\nIMPORTANT: your previous reply could not be parsed${first.stopReason === "max_tokens" ? " (it was cut off — keep it shorter)" : ""}. Reply with ONLY the JSON object — no prose, no code fence — with every string on one line (write line breaks inside strings as \\n).`;
    const userContent = typeof opts.userContent === "string" ? opts.userContent + note : [...opts.userContent, { type: "text", text: note }];
    const second = await ask({ ...opts, userContent, maxTokens: Math.max(opts.maxTokens || 0, 2000) });
    return extractJson(second.text, what);
  }
}

// ---------------------------------------------------------------------------
// Job 1: page capture → Screen Spec
// ---------------------------------------------------------------------------

export function formatCapture(page) {
  const list = (items) => (items && items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none observed)");
  const section = (name, body) => `### ${name}\n${body}`;
  return [
    section("Viewport at capture", `- ${page.viewport}\n- Browser colour scheme: ${page.colorScheme}`),
    section("Layout skeleton (nested regions: size @ position [display, position, scroll, z-index, background])", page.skeleton.length ? page.skeleton.join("\n") : "- (none detected)"),
    section("Typography by role (computed)", list(page.typography)),
    section("Most-used text colours (computed)", list(page.tokens.textColors)),
    section("Most-used background colours (computed)", list(page.tokens.backgrounds)),
    section("Borders", list(page.tokens.borders)),
    section("Font usage (family size/line-height weight)", list(page.tokens.fonts)),
    section("Border radii", list(page.tokens.radii)),
    section("Shadows", list(page.tokens.shadows)),
    section("Spacing values (padding/margin/gap)", list(page.tokens.spacing)),
    section("Headings", list(page.structure.headings)),
    section("Buttons & controls {state hints}", list([...new Set(page.structure.buttons)])),
    section("Links", list(page.structure.links)),
    section("Forms", list(page.structure.forms)),
    section("Inputs outside forms", list(page.structure.standaloneInputs)),
    section("Images / icons", list(page.structure.images)),
    section("Client storage key names (values deliberately not captured)", `- localStorage: ${page.storage.localStorage.join(", ") || "(none)"}\n- sessionStorage: ${page.storage.sessionStorage.join(", ") || "(none)"}\n- cookies readable by JS: ${page.storage.cookies.join(", ") || "(none)"}`),
    section("Third-party script hosts", list(page.thirdPartyScriptHosts)),
  ].join("\n\n");
}

// The extractor prompt is written for Claude in Chrome with browsing tools; these
// explain what this capture does and doesn't contain.
const STATIC_PREAMBLE = `You are being run from a Chrome extension, not with browsing tools. You cannot navigate, click, resize, screenshot, or open devtools. You have received a single automated capture of ONE screen, containing: URL, title, viewport, a nested layout skeleton with real pixel sizes, computed styles (colours, fonts, radii, shadows, spacing), every visible heading/control/link/form/input with state hints, client-storage key names, third-party script hosts, and the visible text.

How to apply your procedure to this capture:
- Skip Step 0 (autonomous discovery loop) and screenshot capture. Treat this as Step 1 pointed at exactly this one screen, and produce the full Screen Spec Format (all 13 sections) for it. Other pages of the same site are captured separately and merged later, so do not invent screens you cannot see — list same-site links you see as candidate screens in Open Questions instead.
- Values in the capture's computed-style sections count as OBSERVED (computed style), not inferred. Only the one captured breakpoint (the viewport width shown) is observed; describe other breakpoints as inferred.
- There is no network trace. Every Section 9/10 workflow is evidence tier "inferred from static evidence" unless the capture itself proves more (e.g. storage key names, script hosts, form action/method).
- Section 7 Asset Manifest: state that no screenshots were captured by this tool.
- The page may belong to a logged-in account. Replace personal data (names, handles, emails, message bodies, avatars) with realistic placeholders of the same shape; keep structural and UI copy.
- Output ONLY the filled-in markdown Screen Spec, starting with "# Screen Spec:".`;

const EXPLORED_PREAMBLE = `You are being run from a Chrome extension's Autopilot, which has already done the browsing for you on ONE screen of an autonomous site crawl (it is running the Step 0 loop; you are writing up the current screen). It captured: a screenshot (attached image), URL, title, viewport, a nested layout skeleton with real pixel sizes, computed styles, every visible control/link/form/input with state hints, client-storage key names, third-party script hosts, the visible text, a NETWORK TRACE of the API calls made while the page loaded and scrolled, and an INTERACTION LOG: for each control it clicked or text box it typed into, what visibly changed (dialogs/menus opened, control state, new text, buttons enabling) and which requests fired.

How to apply your procedure to this capture:
- Produce the full Screen Spec Format (all 13 sections) for this one screen, including the transient states revealed by the interaction log (open menus, modals, tabs) as sub-screens/states of it. Other screens are captured separately and merged later; list unvisited same-site links as candidate screens in Open Questions.
- Evidence tiers: computed-style values and the screenshot are OBSERVED; workflows backed by a request in the network trace or interaction log are "observed via network trace" or "observed via UI timing"; everything else stays "inferred from static evidence". Use the real endpoint shapes, methods, payload/response shapes, status codes and WebSocket frames from the trace in Sections 9 and 10. Never paste auth tokens or IDs verbatim; describe their shape.
- {{MODE_NOTE}}
- Only one breakpoint (the viewport shown) was observed; describe others as inferred. Section 7: list this screen's single screenshot as "<screen-name>_<viewport width>.png (captured by Autopilot, not saved to disk)".
- The page belongs to a logged-in account. Replace personal data (names, handles, emails, message bodies, avatars, follower counts of real people) with realistic placeholders of the same shape; keep structural and UI copy.
- Output ONLY the filled-in markdown Screen Spec, starting with "# Screen Spec:".`;

const MODE_NOTES = {
  full: `The Autopilot interacted fully: it clicked data-changing controls too (likes, follows, bookmarks, toggles, composers…) and clicked toggles again to undo them, so the interaction log shows their real requests and UI changes — treat those as observed. It typed test text into text boxes but NEVER submitted. It never clicked log out, delete/deactivate, anything costing money, or anything that sends content to other people (post, reply, send, invite, report); theorize those from static evidence and related requests, labelled "inferred, unverified — not clicked", and list them in Open Questions.`,
  safe: `The Autopilot ran read-only: it never clicked controls that create, change or delete data or affect the account (post, like, follow, send, save, delete, settings toggles, submit, log out, pay…). Theorize those workflows from static evidence and the related read requests, labelled "inferred, unverified — not clicked for safety", and list them in Open Questions.`,
};

// Product focus (Settings, on by default): document and build the product, not the company around it.
const PRODUCT_FOCUS_SPEC = `PRODUCT FOCUS: document the product's functionality in depth — content creation, feeds, detail views, replies/threads, reposts, reactions, media, profiles, messaging, notifications, search, and the user's product settings. Business/corporate/marketing/legal/help/monetisation elements on this screen (footer links, about/careers/press, ads/business tools, privacy/terms/cookie policies, help centre, developer docs, premium/pricing upsells, app-download banners, links to other subdomains) get ONE line in Section 1/5 saying they exist as static links — no components, workflows or backend theory for them.`;

const PRODUCT_FOCUS_HANDOFF = `PRODUCT FOCUS: build the product, not the company around it. Create no steps for business/corporate/marketing/legal/help/monetisation areas (about, careers, press, advertising/business tools, help centre, developer docs, privacy/terms/cookie pages, premium/pricing upsells, app downloads). Where the product's UI links to them, the step may render the link as a visibly inert placeholder. Spend the steps on core product functionality.`;

// Output tokens are the expensive part. Every screen's spec is merged with the others
// later, so site-wide sections only need writing in full once per site.
function concisenessNote(priorScreens) {
  const common = `OUTPUT LENGTH: write densely — terse bullets and compact tables, no filler prose, no restating the capture data verbatim (summarise link/control lists by group rather than copying them), no repeating the same fact in several sections.`;
  if (!priorScreens.length) return common;
  return `${common}
Other screens of this site are already specced (${priorScreens.slice(0, 30).join("; ")}), and all specs are merged later, so for this screen: Section 3 (Design Tokens), Section 9 (Theorized Backend Architecture), Section 11 (Design Rationale) and Section 13 (Testing Mandate) contain ONLY what is new or different on this screen — otherwise write "Same as the site-wide spec; nothing new on this screen." Put the effort into Sections 1, 2, 4, 5, 10 for what is specific to this screen.`;
}

// page: result of __sabDom.extract(). Optional explored = { screenshot (base64 jpeg), interactions (markdown), network (markdown), mode }.
export async function generateSpec({ siteUrl, page, explored, onProgress }) {
  let text = page.text || "";
  const truncated = text.length > MAX_PAGE_CHARS;
  if (truncated) text = text.slice(0, MAX_PAGE_CHARS);
  const settings = await store.getSettings();
  const priorScreens = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === siteUrl && s.pageUrl !== page.url)
    .map((s) => `${s.pageTitle} (${new URL(s.pageUrl).pathname})`);

  const body = [
    explored ? EXPLORED_PREAMBLE.replace("{{MODE_NOTE}}", MODE_NOTES[explored.mode] || MODE_NOTES.safe) : STATIC_PREAMBLE,
    concisenessNote(priorScreens),
    ...(settings.productFocus !== false ? [PRODUCT_FOCUS_SPEC] : []),
    ...(explored?.instructions ? [``, `USER INSTRUCTIONS FOR THIS CLONE (follow them; leave out any area they say to ignore, even if it is visible in the capture):`, explored.instructions] : []),
    ``,
    `# Captured screen`,
    `URL: ${page.url}`,
    `Title: ${page.title}`,
    `Captured at: ${new Date().toISOString()}`,
    ``,
    `## Automated capture`,
    formatCapture(page),
    ...(explored
      ? [``, `## Network trace — page load and scroll`, explored.network || "- (not recorded)", ``, `## Interaction log`, explored.interactions || "- (no safe interactions found)"]
      : []),
    ``,
    `## Visible text${truncated ? " (truncated)" : ""}`,
    "```",
    text,
    "```",
  ].join("\n");

  const userContent = explored?.screenshot
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: explored.screenshot } },
        { type: "text", text: body },
      ]
    : body;

  const system = await loadPrompt("specExtractor", "site-screen-spec-extractor.md");
  const { text: content, stopReason } = await ask({ system, userContent, maxTokens: settings.specMaxTokens, onProgress });

  const spec = {
    id: store.uid(),
    siteUrl,
    pageUrl: page.url,
    pageTitle: page.title || page.url,
    content: stopReason === "max_tokens" ? `${content}\n\n> ⚠️ Output was cut off at the max token limit.` : content,
    capturedAt: new Date().toISOString(),
    explored: !!explored,
  };
  await store.addSpecFile(spec);
  return spec;
}

// ---------------------------------------------------------------------------
// Job 2: specs → handoff step files
// ---------------------------------------------------------------------------

// The splitter prompt expects one merged screen-spec.md and writes files; this
// adapts it to several per-page specs and a JSON response the extension can store.
const HANDOFF_PREAMBLE = `The input below is not one merged screen-spec.md. It is several Screen Specs of the SAME site, one per captured page, each produced by the Site → Screen Spec Extractor from a single-page capture. Before planning steps, merge them as if they were one screen-spec.md: union the Section 1 inventories; deduplicate Section 3 tokens and Section 4 components; merge Sections 9 and 11 into one coherent global architecture and rationale (resolve conflicts, prefer observed over inferred); merge Section 10 workflows (one entry per workflow, even if several pages trigger it); combine Sections 8/12 open questions. Then follow your procedure exactly (build order, Context Block in every step file — written once and inserted by the extension, see OUTPUT FORMAT — Step 0 = Setup only, final regression step, templates filled in exactly).

The builder is Scram's AI bot. The Scram guide below describes Scram's features (database with security rules, workflows, theme editor, roles, storage, Run mode, server logs). Where it helps, phrase step instructions and checklists in terms of those features (e.g. "define these colours in the Theme editor", "create these tables with these security rules", "test in Run mode"). Clone structure and behaviour, not the brand: use the new app name you choose (appName) everywhere instead of the original brand name.

<scram_guide>
{{SCRAM_GUIDE}}
</scram_guide>`;

// Step size presets: the most checklist items one step may carry before it's split.
export const STEP_CAPS = { small: 6, standard: 10 };

// Plain markdown between marker lines: no escaping needed, so long markdown with quotes,
// code fences and newlines can't break parsing the way JSON strings did.
function handoffFormat(settings) {
  const cap = STEP_CAPS[settings.stepSize] || STEP_CAPS.small;
  const slim = settings.slimContext !== false;
  return `
OUTPUT FORMAT — the extension splits your reply on marker lines. Write plain markdown (NOT JSON, no code fence around the whole reply) in exactly this layout, each marker alone on its own line:

<<<APP_NAME>>>
<an original product name for the clone — not the source site's brand; one line>
<<<CONTEXT_CORE>>>
<the short, always-needed part of the Context Block, as bullet lines: project (one line), stack & architecture (a few lines), an INDEX listing by name only every database table, page/route and shared component, and the testing standard in ONE line. No progress line.>
<<<CONTEXT_REFERENCE>>>
<the detailed part of the Context Block: design tokens with values, the global data model (every table, its columns and security rules), the full navigation map, shared components. Write it ONCE here.>
<<<MANIFEST>>>
<the complete step-manifest.md, filled in per your template>
<<<STEP 0 | Setup | one line: what this step delivers>>>
<step-00-setup.md, with the line {{CONTEXT_BLOCK}} where the Context Block goes>
<<<STEP 1 | Auth | one line: what this step delivers>>>
<step-01-....md, same placeholder>
… one <<<STEP n | title | summary>>> section per step file …
<<<END>>>

Rules:
- CONTEXT: never write the Context Block inside the steps. In each step file keep your template's Context Block heading and put the single line {{CONTEXT_BLOCK}} under it. The extension replaces it with ${slim ? "the CONTEXT_CORE plus a progress ledger — and, for Step 0 only, the full CONTEXT_REFERENCE too (Setup builds it all, after which it lives in the Scram project itself)" : "the CONTEXT_CORE, the CONTEXT_REFERENCE and a progress ledger"}.${slim ? `
- RELEVANT DETAILS: every step after Step 0 gets a section "## Relevant details for this step" right after the Context Block, restating ONLY the parts of the reference this step actually uses — the tables (with the columns it reads/writes), routes, components and design tokens it touches. Nothing else from the reference.` : ""}
- OBJECTIVE FIRST: every step file starts its own content (right after the Context Block${slim ? " and Relevant details" : ""}) with "## Objective": 1–3 lines on what this feature is FOR — the user goal it serves — then "Done means:" bullets, each an observable outcome from a user's point of view (e.g. "a user writes a post and it appears at the top of their feed and on their profile, and is still there after a refresh"). Testing checklist items check those outcomes end to end ("As a user, I can … and then …"), not just that elements exist.
- SMALL STEPS: one screen or one workflow per step, and at most ${cap} items in a step's testing checklist (write them as "- [ ] …" lines). If a screen needs more, split it into consecutive steps (e.g. "Chat view (3a): list + send", "Chat view (3b): edit/delete"). Prefer more, smaller steps over fewer large ones.
- NO REPEATED TESTING TEXT: do not write the gate/delivery paragraph ("Do not request the next step file until…", "Delivery rule…") or restate the testing mandate inside step files — the extension appends one standard testing section to every step. Each step ends with its own checklist.
- Everything else in each step file follows your templates (scope, out of scope, testing checklist).
- Include every step file in build order, including the final regression step, then <<<END>>>.
- Step numbers are integers starting at 0 and increasing by 1 with no gaps. Don't use "|" inside titles.
- Never start any other line with "<<<".
- Write densely: bullets over prose, no repetition.`;
}

// Parse the marker format; falls back to JSON (older format, or if the model sends JSON anyway).
export function parseHandoff(text) {
  const markers = [...text.matchAll(/^[ \t]*<<<\s*(.+?)\s*>>>[ \t]*$/gm)];
  if (markers.some((m) => /^STEP\b/i.test(m[1]))) {
    const out = { appName: "", contextBlock: "", contextCore: "", contextReference: "", manifest: "", steps: [] };
    markers.forEach((m, i) => {
      const body = text.slice(m.index + m[0].length, i + 1 < markers.length ? markers[i + 1].index : text.length).replace(/^\r?\n/, "").trimEnd();
      const tag = m[1];
      if (/^APP[_ ]?NAME$/i.test(tag)) out.appName = body.split("\n")[0].trim();
      else if (/^CONTEXT[_ ]?BLOCK$/i.test(tag)) out.contextBlock = body;
      else if (/^CONTEXT[_ ]?CORE$/i.test(tag)) out.contextCore = body;
      else if (/^CONTEXT[_ ]?REFERENCE$/i.test(tag)) out.contextReference = body;
      else if (/^MANIFEST$/i.test(tag)) out.manifest = body;
      else if (/^STEP\b/i.test(tag)) {
        const [head, title = "", ...rest] = tag.split("|").map((x) => x.trim());
        const n = parseInt(head.replace(/^STEP\s*/i, ""), 10);
        out.steps.push({ stepNumber: Number.isFinite(n) ? n : out.steps.length, title, summary: rest.join(" | "), content: body });
      }
    });
    // Older single-block format: the whole Context Block is the "core".
    if (!out.contextCore && out.contextBlock) out.contextCore = out.contextBlock;
    return out;
  }
  try {
    return extractJson(text, "handoff");
  } catch {
    throw new Error("Claude's handoff reply wasn't in the expected format.");
  }
}

const SLIM_NOTE = "- Built in Step 0 and stored in this Scram project: the full design system (Theme editor), every database table with its security rules, and the page routes. For anything not restated in this file, look it up in the project — don't guess or re-create it.";

// Expand {{CONTEXT_BLOCK}} in each step: core (+ full reference for Step 0, or for every step
// when slim context is off) plus a per-step progress ledger.
function expandContextBlocks({ core, reference }, steps, { slim = true } = {}) {
  return steps.map((step, i) => {
    const ledger = i === 0
      ? "- Progress so far: none — this is the first step."
      : `- Progress so far:\n${steps.slice(0, i).map((p) => `  - Step ${p.stepNumber} (${p.title}): ${p.summary || p.title} — done.`).join("\n")}`;
    const full = i === 0 || !slim;
    const block = [core.trim(), full ? reference.trim() : SLIM_NOTE, ledger].filter(Boolean).join("\n");
    const content = step.content.includes("{{CONTEXT_BLOCK}}")
      ? step.content.split("{{CONTEXT_BLOCK}}").join(block)
      : core.trim() && !step.content.includes(core.trim().slice(0, 60))
        ? `## Context Block\n${block}\n\n${step.content}` // model forgot the placeholder: still include it
        : step.content;
    return { ...step, content };
  });
}

// ---- automatic size check: split steps that are too long or carry too many checklist items.

export function checklistCount(content) {
  const boxes = (content.match(/^\s*[-*]\s*\[[ xX]\]/gm) || []).length;
  if (boxes) return boxes;
  // No checkboxes: count list items under a "Testing checklist" heading, up to the next heading.
  const lines = content.split("\n");
  const start = lines.findIndex((l) => /^#+\s*testing checklist/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^#+\s/.test(l)) break;
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(l)) n++;
  }
  return n;
}

function tooBig(step, settings) {
  const cap = STEP_CAPS[settings.stepSize] || STEP_CAPS.small;
  const chars = step.content.length;
  const items = checklistCount(step.content);
  const reasons = [];
  if (chars > (settings.maxStepChars || 6000)) reasons.push(`${chars.toLocaleString()} characters (limit ${(settings.maxStepChars || 6000).toLocaleString()})`);
  if (items > cap) reasons.push(`${items} checklist items (limit ${cap})`);
  return reasons;
}

async function splitStep(step, reasons, settings, system) {
  const cap = STEP_CAPS[settings.stepSize] || STEP_CAPS.small;
  const slim = settings.slimContext !== false;
  const userContent = `One step file of a phased Scram build is too big for the builder to handle well: ${reasons.join(" and ")}.

Split it into 2–3 consecutive, smaller step files that together cover EXACTLY the same scope (nothing added, nothing dropped), each buildable and testable on its own in this order. Keep the same template headings as the original. Each piece:
- keeps the line {{CONTEXT_BLOCK}} under its Context Block heading (exactly as in the original);${slim ? `
- has its own "## Relevant details for this step" with only what that piece uses;` : ""}
- has its own "## Objective" (what that piece is for, and "Done means:" user-visible outcomes — take them from the original's objective for the part it covers);
- has its own scope / out-of-scope and its own testing checklist of at most ${cap} "- [ ] …" items that check those outcomes end to end;
- does NOT include any gate/delivery paragraph or restate the testing mandate (the extension adds one).
Keep each piece well under ${(settings.maxStepChars || 6000).toLocaleString()} characters. Write densely.

Output ONLY marker sections, in order, then <<<END>>>:
<<<STEP 1 | <title> | <one-line summary>>>
<step file>
<<<STEP 2 | <title> | <one-line summary>>>
<step file>
<<<END>>>

Original step: "${step.title}" — ${step.summary || ""}
<original_step>
${step.content}
</original_step>`;
  const { text } = await ask({ system, userContent, maxTokens: Math.min(settings.handoffMaxTokens || 16000, 16000) });
  const pieces = parseHandoff(text).steps.filter((p) => p.content.trim());
  if (pieces.length < 2) throw new Error("split returned fewer than 2 pieces");
  return pieces.map((p) => ({ title: p.title || step.title, summary: p.summary || "", content: p.content }));
}

// Splits oversize steps (raw step text, before the Context Block is inserted). Max 2 levels deep.
async function autoSplitSteps(steps, settings, system, onProgress) {
  const out = [];
  let splits = 0;
  const visit = async (step, depth) => {
    const reasons = tooBig(step, settings);
    if (!reasons.length || depth >= 2 || splits >= 15) return out.push(step);
    splits += 1;
    await onProgress?.(`Step “${step.title}” is too big (${reasons.join(", ")}) — splitting it…`);
    let pieces;
    try {
      pieces = await splitStep(step, reasons, settings, system);
    } catch {
      return out.push(step); // keep the original if the split fails
    }
    for (const p of pieces) await visit(p, depth + 1);
  };
  for (const s of steps) await visit(s, 0);
  return { steps: out, splits };
}

export async function generateHandoff(siteUrl, { instructions = "" } = {}) {
  const jobKey = `handoff:${siteUrl}`;
  const specs = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === siteUrl)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  if (!specs.length) throw new Error(`No captured pages for ${siteUrl} yet.`);

  const startedAt = Date.now();
  await store.setJob(jobKey, { status: "running", message: `Splitting ${specs.length} spec file(s) into build steps…`, startedAt });

  try {
    const combinedSpecs = specs
      .map((s, i) => `<!-- Spec ${i + 1} of ${specs.length}: ${s.pageTitle} (${s.pageUrl}) -->\n\n${s.content}`)
      .join("\n\n---\n\n");
    const guide = await loadScramGuide();
    const preamble = HANDOFF_PREAMBLE.replace("{{SCRAM_GUIDE}}", guide);
    const userNote = instructions
      ? `\n\nUSER INSTRUCTIONS FOR THIS CLONE (they override the specs: create no steps for areas they say to ignore, even if a spec mentions them; follow any focus or naming preferences):\n${instructions}`
      : "";
    const focus = (await store.getSettings()).productFocus !== false ? `\n\n${PRODUCT_FOCUS_HANDOFF}` : "";
    const [settings, system] = await Promise.all([store.getSettings(), loadPrompt("handoffSplitter", "scram-phased-handoff-splitter.md")]);
    const userContent = `${preamble}${focus}${userNote}\n\nSite: ${siteUrl}\nNumber of per-page screen specs: ${specs.length}\n\n${combinedSpecs}\n\n---\n${handoffFormat(settings)}`;
    const { text, stopReason } = await ask({
      system,
      userContent,
      maxTokens: settings.handoffMaxTokens,
      onProgress: (chars) => store.setJob(jobKey, { status: "running", message: `Writing ${specs.length}-page handoff (${chars.toLocaleString()} chars)…`, startedAt }),
    });

    // If the reply can't be used, keep what was paid for: save it as a readable file.
    // Added next to any earlier handoff for this site (replacing only a previous raw file).
    const saveRaw = async (why) => {
      const all = await store.get("handoffFiles", []);
      const kept = all.filter((f) => !(f.siteUrl === siteUrl && f.raw));
      kept.push({ id: store.uid(), siteUrl, fileType: "combined", raw: true, stepNumber: null, title: `Raw Claude output (${why})`, content: text, createdAt: new Date().toISOString() });
      await store.set("handoffFiles", kept);
    };

    if (stopReason === "max_tokens") {
      await saveRaw("cut off at max tokens");
      throw new Error("Claude hit the max token limit before finishing the handoff. Its partial output is saved in the Handoff tab. Raise 'Handoff max tokens' in Settings (e.g. 32000–64000) and generate again.");
    }

    let parsed;
    try {
      parsed = parseHandoff(text);
      if (!Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error("Claude's handoff reply contained no steps.");
    } catch (e) {
      await saveRaw("couldn't be split into steps");
      throw new Error(`${e.message} The raw output is saved in the Handoff tab — try Generate again.`);
    }

    const now = new Date().toISOString();
    // Keep Claude's order, then renumber 0..n-1 so the build queue never has gaps or duplicates.
    const sorted = parsed.steps
      .map((s, i) => ({ s, order: Number.isFinite(Number(s.stepNumber)) ? Number(s.stepNumber) : i, i }))
      .sort((a, b) => a.order - b.order || a.i - b.i)
      .map(({ s }) => ({ title: String(s.title || "Step"), summary: String(s.summary || ""), content: String(s.content || "") }));
    // Automatic size check: split any step that's too long or has too many checklist items.
    const { steps: sized, splits } = await autoSplitSteps(sorted, settings, system, (msg) => store.setJob(jobKey, { status: "running", message: msg, startedAt }));
    const ordered = sized.map((s, n) => ({ stepNumber: n, ...s }));
    const context = { core: String(parsed.contextCore || parsed.contextBlock || ""), reference: String(parsed.contextReference || "") };
    const steps = expandContextBlocks(context, ordered, { slim: settings.slimContext !== false }).map((s) => ({
      id: store.uid(),
      siteUrl,
      fileType: "step",
      stepNumber: s.stepNumber,
      title: s.title,
      summary: s.summary,
      content: store.withTestingSection(s.content),
      checklistItems: checklistCount(s.content),
      createdAt: now,
    }));
    let manifest = String(parsed.manifest || "");
    if (splits) {
      // The model's manifest numbers no longer match after splitting: append the final order.
      manifest += `\n\n## Final step order (after the extension split ${splits} oversize step${splits === 1 ? "" : "s"})\n${steps.map((s) => `- Step ${s.stepNumber}: ${s.title}${s.summary ? ` — ${s.summary}` : ""}`).join("\n")}`;
    }
    const appName = String(parsed.appName || "").trim() || `${new URL(siteUrl).hostname.split(".").slice(-2, -1)[0] || "App"} Clone`;
    const combinedDoc = [manifest, ...steps.map((s) => s.content)].filter(Boolean).join("\n\n---\n\n");
    const files = [
      { id: store.uid(), siteUrl, fileType: "manifest", stepNumber: null, title: "Step Manifest", content: manifest, appName, createdAt: now },
      { id: store.uid(), siteUrl, fileType: "combined", stepNumber: null, title: "Combined Handoff", content: combinedDoc, createdAt: now },
      ...steps,
    ];

    await store.replaceHandoffFiles(siteUrl, files);
    // New steps invalidate any previous build progress for this site.
    await store.setProgress({ siteUrl, currentStep: 0, completedSteps: [] });
    await store.setJob(jobKey, null);
    return files;
  } catch (err) {
    await store.setJob(jobKey, { status: "error", message: err.message, startedAt: Date.now() });
    throw err;
  }
}
