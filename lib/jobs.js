// Claude-backed jobs shared by the manual flow and Autopilot:
// page → Screen Spec, specs → handoff steps, plus a usage-tracking ask() helper.

import * as store from "./storage.js";
import { callClaude, callMessages, extractJson } from "./claude.js";
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
export async function ask({ system, userContent, maxTokens, model, effort, onProgress }) {
  const [apiKey, settings] = await Promise.all([store.get("apiKey", ""), store.getSettings()]);
  const usedModel = model || settings.model;
  const res = await callClaude({ apiKey, model: usedModel, system, userContent, maxTokens, effort, onProgress });
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

// One turn of a tool-using conversation (see callMessages), tallied like ask().
export async function askTurn(opts) {
  const apiKey = await store.get("apiKey", "");
  const res = await callMessages({ apiKey, ...opts });
  const usage = await store.get("usage", { input: 0, output: 0, calls: 0, cost: 0 });
  if (typeof usage.cost !== "number") usage.cost = totalCost(usage);
  usage.input += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
  usage.output += res.usage?.output_tokens || 0;
  usage.calls += 1;
  usage.cost += costOf(res.model || opts.model, res.usage);
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
<the short, always-needed part of the Context Block, as bullet lines: project (one line), stack & architecture (a few lines), an INDEX listing by name only every database table, page/route and shared component. No testing standard (the extension adds the testing section) and no progress line.>
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
- NO WAFFLE (overrides your templates): keep every requirement, detail, rule and checklist item exactly as thorough as your templates ask; cut only repetition and filler: no restating the same rule in several places, no "repeated in full / do not rely on memory" notes, no motivational or filler sentences. Use short bullets. Use these plain headings: "## Context", "## Relevant details", "## Objective", "## Scope", "## Out of scope", "## Testing checklist".
- EXPLAIN THE WHY: Scram's AI builds better when it understands the intent. In every step, say why the important things are the way they are (inline "because …" on key behaviours, and the objective's purpose), using the reasoning from the screen specs' analysis (what users are trying to do, why the original site behaves that way), the human's decisions and Scram's limits. Real, specific reasons only.
- TESTABLE LOGIN: Scram's AI can't sign in with Google/social login while testing (popup). If the app uses social login, the step that builds login must ALSO build a temporary developer login (email + password with seeded test accounts, one per role, known password), clearly marked "DEV ONLY: remove before publishing", so every later step can be tested logged in. Put Google/social provider configuration (Client ID/Secret in Scram's Users settings) under a "## Needs the human" section in that step. It's the human's job, never the bot's.
- DESKTOP ONLY (overrides your templates): the app is built and tested at desktop size only. No tablet, mobile, phone-width, breakpoint or responsive-layout requirements or checks anywhere in the steps (layouts are described for desktop; ignore the specs' notes on other breakpoints).
- LIGHT TESTING (overrides your templates): the build should move quickly from step to step. A step's testing checklist is a few quick checks of that step's "Done means" outcomes, one line each, with no edge-case lists, no security/regression sweeps and no "test every use case" mandate. Don't put the "standing testing mandate" in the Context Block or anywhere else. The final regression step stays, as one short end-to-end pass over the core features.
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

const SLIM_NOTE = store.SHORT_PROJECT_NOTE;

// Expand {{CONTEXT_BLOCK}} in each step: core (+ full reference for Step 0, or for every step
// when slim context is off) plus a per-step progress ledger.
function expandContextBlocks({ core, reference }, steps, { slim = true } = {}) {
  return steps.map((step, i) => {
    const ledger = i === 0 ? "" : store.ledgerLine(steps.slice(0, i));
    const full = i === 0 || !slim;
    const block = [core.trim(), full ? reference.trim() : SLIM_NOTE, ledger].filter(Boolean).join("\n");
    const content = step.content.includes("{{CONTEXT_BLOCK}}")
      ? step.content.split("{{CONTEXT_BLOCK}}").join(block)
      : core.trim() && !step.content.includes(core.trim().slice(0, 60))
        ? `## Context\n${block}\n\n${step.content}` // model forgot the placeholder: still include it
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

// ---- Detail pass: expand each step into an exact work order for Scram's AI.
// The first pass writes every step at once, so each gets only a short description. Here each step
// gets its own call with the screen specs it touches, and comes back with every screen, control
// and workflow spelled out (where it is, what it looks like, what it does, which pipeline, why).

const STEP_DETAIL_SYSTEM = `You turn ONE step of a phased build plan into an exact, unambiguous work order for Scram's AI builder (it builds the app in Scram from this text alone, and builds better the more exact it is). You get the project's context, the step's current text, the screen specs captured from the original site for the screens this step touches, and the human's decisions.

Rewrite the step's content so nothing is left to guess, in this order (plain headings):
## Relevant details: keep the tables (with the columns it reads/writes), routes and shared components this step uses.
## Objective: keep it (what the feature is FOR) and its "Done means:" outcomes.
## Screens and controls: for EVERY screen, panel, modal and menu this step builds or changes:
- Layout: where everything sits (header/left/right/top/bottom, order, alignment), matching the original site's screen (rebranded). The LOOK comes from the design concept when one is given (its theme tokens, shape language, texture, signature element, motion and voice), not from the original site's styling; otherwise from the spec and the theme.
- EVERY interactive element, one bullet each, in reading order. Use this shape: **<type> "<exact label or icon>"**. Then: where it is · what it looks like (variant, icon, states: default / hover / disabled / loading / selected) · what happens when used (exact UI change; which workflow runs, by name; what it reads/writes, as table.columns; side effects such as activity log, notifications or email; where it navigates) · WHY it is this way: the user goal it serves AND the reason for its specific behaviour/look (e.g. "matches the original because users expect…", "confirms first because the action can't be undone", "disabled while saving so a double click can't create two records", "a Refresh button because Scram has no live updates") · validation, error and empty states with the exact text shown.
- Forms: every field: label, type, placeholder, default, required, validation rule, exact error message.
- Lists, tables and boards: columns/card contents, sort order, empty-state text, loading state, pagination/limits.
## Workflows: every workflow this step creates or changes: name · trigger · inputs · ordered actions (each Execute SQL described: what it selects/inserts/updates, with BEGIN/COMMIT where writes must succeed together) · outputs/result · failure handling and the message shown · why it is designed this way.
## Why it's built this way: 3–8 bullets explaining the step's key decisions (data model, flows, layout, rules, what's left out) and the reasoning behind each: the users' goal, what the analysis of the original site found and why the original works that way, the human's decisions, Scram's limits, data safety/security. Write it so the builder understands the intent well enough to make the right call on anything this file doesn't cover.
## Scope / ## Out of scope: keep them.
## Testing checklist: keep it ("- [ ] …" lines); you may make items more specific, but don't add many.

Rules:
- Reasons must be real and specific, taken from the screen specs' analysis (their purpose/behaviour/theorised-backend notes), the human's decisions, the context and Scram's limits — never generic ("for a better user experience" is not a reason).
- The screen specs are the source of truth for labels, positions, behaviour and copy (use the clone's brand name, not the original's). Where they don't say, decide sensibly and consistently with the context, and state it exactly. Never write "etc.", "and so on" or "as appropriate".
- Stay inside this step's scope. Don't re-specify things earlier steps built except where this step changes them.
- Desktop only: describe layouts at desktop size; no tablet, mobile, breakpoint or responsive requirements or checks.
- Keep the interaction model the plan/blueprint decides. For rich interactions (drag and drop, inline editing, live preview, keyboard shortcuts, undo) spell out every state: what can be grabbed and where the handle is, what follows the pointer, the drop indicator, what happens on drop, on Escape and on a drop outside, the keyboard alternative, and how it's built in Scram (a custom component using the HTML Element / Run Code JavaScript where standard components can't do it). Never downgrade one to a simpler interaction; a fallback is only for when Scram's AI reports it can't.
- No context block, no project overview, no testing mandate, no filler sentences.
- Output ONLY the step's markdown, starting with its "# " title line.`;

// Screen specs most relevant to a step: by overlap between the step text and each spec's title/path.
function specsForStep(step, specs, maxChars = 60000) {
  const text = step.content.toLowerCase();
  const words = (t) => [...new Set(String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))];
  const scored = specs
    .map((sp) => {
      const path = (() => { try { return new URL(sp.pageUrl).pathname; } catch { return ""; } })();
      const keys = [...words(sp.pageTitle), ...words(path)];
      const score = keys.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0) + (path.length > 1 && text.includes(path.toLowerCase()) ? 3 : 0);
      return { sp, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const picked = scored.length ? scored.map((x) => x.sp) : specs.slice(0, 2);
  const per = Math.floor(maxChars / Math.max(1, picked.length));
  return picked.map((sp) => `<!-- Screen spec: ${sp.pageTitle} (${sp.pageUrl}) -->\n${keySections(sp.content, per)}`).join("\n\n---\n\n");
}

// The parts of a screen spec a step needs most, in priority order, within a size budget: the
// per-screen detail, the workflow library and the design rationale ("why") first — they sit near
// the end of a spec, so a plain cut would lose the reasoning. Tokens/testing boilerplate last.
function keySections(content, budget) {
  const text = String(content || "");
  if (text.length <= budget) return text;
  const parts = text.split(/(?=^## )/m);
  const rank = (p) => {
    const h = (p.match(/^## (.*)$/m) || ["", ""])[1].toLowerCase();
    if (/per-screen|screen detail/.test(h)) return 0;
    if (/workflow library|feature workflow/.test(h)) return 1;
    if (/rationale|\bwhy\b/.test(h)) return 2;
    if (/component inventory/.test(h)) return 3;
    if (/layout|app shell|navigation/.test(h)) return 4;
    if (/backend/.test(h)) return 5;
    if (/meta|inventory/.test(h)) return 6;
    if (/design tokens|asset|open questions|testing|mandate/.test(h)) return 9;
    return 7;
  };
  const ordered = parts.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i);
  let out = "";
  for (const { p } of ordered) {
    if (out.length + p.length <= budget) out += p;
    else if (out.length < budget * 0.9) out += p.slice(0, budget - out.length) + "\n…\n";
  }
  return out;
}

async function detailOneStep(step, { core, specs, instructions, settings }) {
  const marker = "{{CONTEXT_BLOCK}}";
  const at = step.content.indexOf(marker);
  const head = at >= 0 ? step.content.slice(0, at + marker.length) : "";
  const body = at >= 0 ? step.content.slice(at + marker.length) : step.content;
  const title = (step.content.match(/^#\s+.*$/m) || [`# ${step.title}`])[0];
  const userContent = `PROJECT CONTEXT:\n${core}\n\n${instructions ? `THE HUMAN'S INSTRUCTIONS AND DECISIONS (follow them):\n${instructions}\n\n` : ""}SCREEN SPECS FROM THE ORIGINAL SITE (source of truth for labels, layout and behaviour):\n${specsForStep(step, specs)}\n\nTHE STEP TO EXPAND — "${step.title}":\n${title}\n${body}`;
  const { text, stopReason } = await ask({ system: STEP_DETAIL_SYSTEM, userContent, maxTokens: 16000, model: settings.model });
  let out = String(text || "").trim();
  if (!out || stopReason === "max_tokens" || !/^##\s+(objective|screens and controls)/im.test(out)) return step; // keep the original
  if (head) {
    // Re-attach the title + Context placeholder; drop a duplicate title line from the reply.
    out = out.replace(/^#\s+.*\n+/, "");
    return { ...step, content: `${head}\n\n${out}\n` };
  }
  return { ...step, content: out };
}

async function detailSteps(steps, opts, onProgress) {
  const out = steps.slice();
  const todo = steps.map((s, i) => i).filter((i) => i > 0); // Step 0 (Setup) already carries the full reference
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const i = todo.shift();
      out[i] = await detailOneStep(steps[i], opts).catch(() => steps[i]);
      done += 1;
      await onProgress?.(`Writing the detailed work order for each step (${done}/${steps.length - 1}): every screen, button and workflow spelled out…`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
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

// Category clones pass their own inputs: specs = one digest per researched site (main pass),
// detailSpecs = every crawled screen spec (detail pass), blueprint = the tribunal judge's decisions.
export async function generateHandoff(siteUrl, { instructions = "", specs: specsIn = null, detailSpecs = null, blueprint = "", design = undefined } = {}) {
  // The run's design concept (from the design questions), unless the caller passed one.
  if (design === undefined) design = (await store.get("designBriefs", {}))[siteUrl]?.content || "";
  const jobKey = `handoff:${siteUrl}`;
  const specs = (specsIn || (await store.get("specFiles", [])).filter((s) => s.siteUrl === siteUrl))
    .slice()
    .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
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
    const blueprintNote = blueprint
      ? `\n\nCATEGORY CLONE: this is ONE app combining the best of several products in a category. The tribunal's BLUEPRINT below is the source of truth (it overrides any single product): build exactly the features, screens, data model, workflows and design it decides, modelled on the products it names. Keep its product vision and interaction model intact in the steps: where it says something is dragged, edited in place, previewed live or has keyboard shortcuts, the steps build exactly that (with every state), never a simpler substitute such as menus or Move up/down buttons. Build the core experience early, so later steps build on it. The "specs" that follow are digests of each researched product, for detail and reasoning.\n<blueprint>\n${blueprint}\n</blueprint>`
      : "";
    const designNote = design
      ? `\n\nDESIGN CONCEPT (source of truth for the LOOK; it overrides the original site's visual styling and any "Design direction" in a blueprint): the specs give the layout, screens and functionality to clone; the design concept below gives how everything looks. Put its theme tokens (colours, fonts, type scale, radii, borders, shadows/texture, spacing, motion) into the project theme in the Setup step, with nothing hard-coded, and say in every step's screens how they use the concept (shape language, signature element, voice, empty/loading states). Repeat the CONCEPT line and the key tokens in the Context Block so every step keeps them.\n<design_concept>\n${design}\n</design_concept>`
      : "";
    const userContent = `${preamble}${focus}${userNote}${blueprintNote}${designNote}\n\nSite: ${siteUrl}\nNumber of per-page screen specs: ${specs.length}\n\n${combinedSpecs}\n\n---\n${handoffFormat(settings)}`;
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
    let ordered = sized.map((s, n) => ({ stepNumber: n, ...s }));
    const context = { core: String(parsed.contextCore || parsed.contextBlock || ""), reference: String(parsed.contextReference || "") };
    if (settings.detailedSteps !== false && ordered.length > 1) {
      const withBlueprint = blueprint ? `${instructions}\n\nTHE TRIBUNAL'S BLUEPRINT (source of truth for this category clone):\n${blueprint.slice(0, 40000)}` : instructions;
      const withDesign = design ? `${withBlueprint}\n\nTHE DESIGN CONCEPT (source of truth for the look — layout and behaviour come from the specs):\n${design.slice(0, 20000)}` : withBlueprint;
      ordered = await detailSteps(ordered, { core: context.core, specs: detailSpecs || specs, instructions: withDesign, settings }, (msg) => store.setJob(jobKey, { status: "running", message: msg, startedAt }));
    }
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
