// Claude-backed jobs shared by the manual flow and Autopilot:
// page → Screen Spec, specs → handoff steps, plus a usage-tracking ask() helper.

import * as store from "./storage.js";
import { callClaude, extractJson } from "./claude.js";

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

// Claude call that reads the key/settings and tallies token usage.
export async function ask({ system, userContent, maxTokens, model, onProgress }) {
  const [apiKey, settings] = await Promise.all([store.get("apiKey", ""), store.getSettings()]);
  const res = await callClaude({ apiKey, model: model || settings.model, system, userContent, maxTokens, onProgress });
  const usage = await store.get("usage", { input: 0, output: 0, calls: 0 });
  usage.input += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
  usage.output += res.usage?.output_tokens || 0;
  usage.calls += 1;
  await store.set("usage", usage);
  return res;
}

export async function askJson(opts) {
  const { text } = await ask(opts);
  return extractJson(text);
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

const HANDOFF_FORMAT_INSTRUCTIONS = `
OUTPUT FORMAT — the extension parses your reply as JSON, so return a single JSON object and nothing else: no prose before or after, no markdown fences. Exactly this shape:

{
  "appName": "<an original product name for the clone — not the source site's brand>",
  "contextBlock": "<the Context Block, written ONCE, in full, as bullet lines: project, stack & architecture, design tokens, global data model, navigation map, and the standing testing mandate written out in full — but WITHOUT the progress line>",
  "manifest": "<the complete step-manifest.md, filled in per your template>",
  "steps": [
    { "stepNumber": 0, "title": "Setup", "summary": "<one line: what this step delivers>", "content": "<step-00-setup.md with the line {{CONTEXT_BLOCK}} where the Context Block goes>" },
    { "stepNumber": 1, "title": "Auth", "summary": "<one line>", "content": "<step-01-....md, same placeholder>" }
  ]
}

Rules:
- SAVE OUTPUT: do not write the Context Block inside the steps. In each step's content, keep your template's Context Block heading and put the single line {{CONTEXT_BLOCK}} under it. The extension replaces that line with "contextBlock" plus a progress ledger built from the earlier steps' "summary" lines, so every step file the builder receives still contains the full Context Block.
- Everything else in each step's content is exactly as your templates specify (scope, out of scope, testing checklist, completion/gate).
- "steps" holds every step file in build order, including the final regression step.
- stepNumber is an integer that starts at 0 and increases by 1 with no gaps. If you split a screen into an arc like "3a/3b/3c", give each its own consecutive integer and keep the arc label in the title (e.g. "Chat view (3b): edit/delete/react").
- Write densely: bullets over prose, no repetition beyond what your templates require.
- All string values must be valid JSON strings (escape newlines as \\n and double quotes as \\").`;

// Expand {{CONTEXT_BLOCK}} in each step with the shared block plus a per-step progress ledger.
function expandContextBlocks(contextBlock, steps) {
  return steps.map((step, i) => {
    const ledger = i === 0
      ? "- Progress so far: none — this is the first step."
      : `- Progress so far:\n${steps.slice(0, i).map((p) => `  - Step ${p.stepNumber} (${p.title}): ${p.summary || p.title} — done.`).join("\n")}`;
    const block = `${contextBlock.trim()}\n${ledger}`;
    const content = step.content.includes("{{CONTEXT_BLOCK}}")
      ? step.content.split("{{CONTEXT_BLOCK}}").join(block)
      : contextBlock.trim() && !step.content.includes(contextBlock.trim().slice(0, 60))
        ? `## Context Block\n${block}\n\n${step.content}` // model forgot the placeholder: still include it
        : step.content;
    return { ...step, content };
  });
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
    const guide = await loadPrompt("scramGuide", "scram-guide.md");
    const preamble = HANDOFF_PREAMBLE.replace("{{SCRAM_GUIDE}}", guide);
    const userNote = instructions
      ? `\n\nUSER INSTRUCTIONS FOR THIS CLONE (they override the specs: create no steps for areas they say to ignore, even if a spec mentions them; follow any focus or naming preferences):\n${instructions}`
      : "";
    const focus = (await store.getSettings()).productFocus !== false ? `\n\n${PRODUCT_FOCUS_HANDOFF}` : "";
    const userContent = `${preamble}${focus}${userNote}\n\nSite: ${siteUrl}\nNumber of per-page screen specs: ${specs.length}\n\n${combinedSpecs}\n\n---\n${HANDOFF_FORMAT_INSTRUCTIONS}`;

    const [settings, system] = await Promise.all([store.getSettings(), loadPrompt("handoffSplitter", "scram-phased-handoff-splitter.md")]);
    const { text, stopReason } = await ask({
      system,
      userContent,
      maxTokens: settings.handoffMaxTokens,
      onProgress: (chars) => store.setJob(jobKey, { status: "running", message: `Writing ${specs.length}-page handoff (${chars.toLocaleString()} chars)…`, startedAt }),
    });

    if (stopReason === "max_tokens") {
      throw new Error("Claude hit the max token limit before finishing the handoff JSON. Raise 'Handoff max tokens' in Options or capture fewer pages.");
    }

    const parsed = extractJson(text);
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error("Handoff JSON had no steps.");

    const now = new Date().toISOString();
    // Keep Claude's order, then renumber 0..n-1 so the build queue never has gaps or duplicates.
    const ordered = parsed.steps
      .map((s, i) => ({ s, order: Number.isFinite(Number(s.stepNumber)) ? Number(s.stepNumber) : i, i }))
      .sort((a, b) => a.order - b.order || a.i - b.i)
      .map(({ s }, n) => ({ stepNumber: n, title: String(s.title || `Step ${n}`), summary: String(s.summary || ""), content: String(s.content || "") }));
    const steps = expandContextBlocks(String(parsed.contextBlock || ""), ordered).map((s) => ({
      id: store.uid(),
      siteUrl,
      fileType: "step",
      stepNumber: s.stepNumber,
      title: s.title,
      summary: s.summary,
      content: s.content,
      createdAt: now,
    }));
    const manifest = String(parsed.manifest || "");
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
