// Art direction for every clone: design questions in the Q&A, then a design concept (the
// "CONCEPT: …" line, theme tokens, signature element, motion, page composition) that the step
// files and the final review follow. The original site gives the layout and functionality;
// the concept gives the look. Rules: prompts/design-direction.md.

import * as store from "./storage.js";
import { ask, askJson, loadPrompt } from "./jobs.js";
import { checkTheme, themeFromConcept, themeSummary } from "./scram-theme.js";

const HISTORY_KEY = "designHistory"; // concept lines already used, so no two apps look alike
const BRIEFS_KEY = "designBriefs"; // { [siteUrl]: { concept, content, createdAt } }

const rules = () => loadPrompt("designDirection", "design-direction.md").catch(() => "");

export async function usedConcepts() {
  return (await store.get(HISTORY_KEY, [])).filter((h) => !h.houseStyle).map((h) => h.concept).filter(Boolean);
}
// Fonts and palettes earlier apps' themes used (so a new app picks different ones).
async function usedThemes() {
  return (await store.get(HISTORY_KEY, [])).filter((h) => !h.houseStyle && h.theme).map((h) => h.theme);
}

// Scram's house style, for internal Scram tools only. It's pasted in on the site (Settings →
// Prompts) rather than bundled, so the internal brand rules don't ship inside the extension.
// When it's set, the vibe question offers it.
export const HOUSE_STYLE_OPTION = "Scram house style — for internal Scram tools only (looks like Scram's other internal tools)";
export async function houseStyle() {
  return String((await store.get("promptOverrides", {}))?.scramHouseStyle || "").trim();
}
const rulesFile = (name, file) => loadPrompt(name, file).catch(() => "");

export async function getDesignBrief(siteUrl) {
  return (await store.get(BRIEFS_KEY, {}))[siteUrl] || null;
}

const DESIGN_Q_SYSTEM = `You are the designer for a new web app that will be built in Scram (a no-code app builder). The app clones the core features of an existing product, but gets its own look. Before the design is written, you ask the human what vibe they want — in plain, everyday terms, not quirky themes.

Read the product (who uses it, what it's for) and ask exactly these, in this order (each one line, options short):
1. id "d1" — "What vibe should the app have?": 8 vibes that could suit THIS product, each written "Vibe — a few plain words on how it looks and feels" (e.g. "Cozy — warm colours, soft corners, friendly type", "Modern — clean, crisp, lots of space", "Rough and raw — gritty textures, bold blocky type", "Calm and minimal", "Playful", "Premium", "Bold and energetic", "Retro", "Techy and precise", "Natural and organic", "Friendly and approachable"), choosing the 8 that make most sense for this product, plus a 9th option "Stay close to the original site's look". Recommend the vibe that best fits the product. Never offer literal themes or costumes (a construction site, a kitchen order ticket, a casino, a spaceship).
2. id "d2" — "How bold should the design be?": exactly "Subtle — understated, lets the content lead", "Balanced — distinctive but calm", "Bold — strong colour and big type". Recommend "Balanced — distinctive but calm".
3. id "d3" — "Any must-haves or no-gos for the look?": "No preference — your call", "Light background", "Dark background", "Use my brand colours / fonts (write them in)". Recommend "No preference — your call".

Return ONLY JSON: {"questions":[{"id":"d1","question":"...","why":"<one line: what it changes>","options":["..."],"recommended":<index>}]}`;

// The design questions for the Q&A (marked kind "design"). product: a short description plus,
// when available, excerpts of the specs.
export async function makeDesignQuestions({ product, settings }) {
  const userContent = `THE PRODUCT:\n${String(product || "").slice(0, 30000)}`;
  const res = await askJson({ what: "Design questions", system: DESIGN_Q_SYSTEM, userContent, maxTokens: 2500, model: settings.model });
  const questions = (Array.isArray(res.questions) ? res.questions : [])
    .map((q, i) => {
      const options = (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 10);
      const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
      return { id: String(q.id || `d${i + 1}`), kind: "design", question: String(q.question || "").trim(), why: String(q.why || "").trim(), options, recommended: rec };
    })
    .filter((q) => q.question && q.options.length)
    .slice(0, 3);
  // Scram's house style is one more choice for the vibe (never the recommended one).
  if (!(await houseStyle())) return questions;
  return questions.map((q) => (q.id === "d1" ? { ...q, options: [...q.options, HOUSE_STYLE_OPTION] } : q));
}

const BRIEF_SYSTEM = `You are the art director for a new web app built in Scram (a no-code app builder with its own AI builder). The app clones the core features of an existing product; its layout and functionality come from the research, but its LOOK is yours to design, following the design rules and the human's answers. Write the design concept that Scram's AI will build from.

Follow the rules exactly: concept first, then a token system, then page composition. The human's chosen VIBE is the north star: every token, shape, texture and line of copy should express it. Their boldness choice sets how strong it is (subtle = understated and quiet; balanced = distinctive but calm; bold = strong colour and big type), and their must-haves and no-gos override your taste. If they chose "Stay close to the original site's look", keep the original's palette and type feel but still apply the rules' quality bar. Keep it tasteful and usable every day: distinctive, never a costume or a literal theme. Make it different from the concepts, font pairs and palettes already used (listed in the message). The app must work at desktop, tablet and phone widths.

The look has to survive Scram's theme system (SCRAM THEME RULES in the message): a Scram theme holds colour roles (generated 50–950 scales; only pinned shades are exact), two Google Fonts, spacing / text-size / roundness / border / size STEPS and an icon library. Express every colour as a role and shade, pin the exact hexes the concept depends on, and put what a theme can't hold (shadows, uppercase or letter-spaced headings, a third font, focus rings, textures, gradients) in the page styling rules. A dark look is colorSchemeMode "dark-only" (or "switchable" for both), never dark hexes. The STRUCTURE RULES in the message hold no look: the concept must leave room for them (one shared component per job, one row height per row type, visible focus, empty / loading / error states).

Write Markdown, specific enough to build from with no guessing:
VIBE: <the chosen vibe, and how bold> (the very first line, e.g. "VIBE: Cozy — balanced")
CONCEPT: <one line> (the second line)
## Why it suits this app: two sentences. Then "In three words: …".
## Theme tokens: each token with its exact hex, its Scram role and shade, and what it's for — page background (neutral 50), cards / nav / inputs (neutral 100), borders (neutral 200), muted text (neutral 600), text (neutral 900), the solid button fill and label (primary 800 / primary 50), 1–3 accents (secondary 500, custom1–custom5 at 500), success / alert / error; note the AA contrast of text on its backgrounds. Fonts: heading and body (Google Fonts names, weights) with a type scale. Corner, border, spacing and size as Scram steps (with the px they give).
## Scram theme: ONE \`\`\`json code block holding the createTheme object for Scram's manageThemes tool, exactly per SCRAM THEME RULES — id, themeName (an original name for this app's theme), description, baseColors (all six), colorShadeOverrides (only the pins the concept depends on), fonts, spacing, textSize, border, roundness, size, iconLibrary, colorSchemeMode, reasoning. Its pins must match the hexes in Theme tokens.
## Page styling (not in the theme): short rules for what the theme can't hold, each naming the shared component it goes on (e.g. "Card: shadow 0 2px 8px rgba(…)", "Headings: uppercase, letter-spacing 0.02em", "Ids and code: JetBrains Mono").
## Shape language: the one shape language and exactly how buttons, inputs, cards, chips, images and tags look (default / hover / focus / disabled).
## Texture & depth
## Signature element: what it is and where it repeats (at least 4 places across the app).
## Motion: the personality, durations and easing, hover states; scroll reveals and page transitions on public pages only (the logged-in app gets short feedback only); and the reduced-motion fallback.
## Composing the screens: the first screen / any public page (headline voice, the hero visual made from the real product), the logged-in shell (navigation, headers), lists and tables, detail views, forms and settings, empty states, loading states, the 404 page, toasts and dialogs: how each uses the concept, at desktop, tablet and phone widths.
## Voice: how copy sounds, with 3–5 example lines from this app (buttons, empty states, a headline).
## Never: the generic choices to avoid for this app specifically.`;

// Scram's house style instead of a vibe: the internal brand rules are followed exactly, and the
// app is meant to look like the other internal tools (no "make it different").
const HOUSE_NOTE = `THE HUMAN CHOSE SCRAM'S HOUSE STYLE (an internal Scram tool). Ignore the vibe and the "make it different" rules: follow the house style below exactly — its colours, fonts, corners, sizes, elevation and colour roles — translated into a Scram theme (pins for its exact hexes) and page styling rules for what a theme can't hold. VIBE line: "VIBE: Scram house style". CONCEPT line: "CONCEPT: Scram house style — <one line on this tool>".\n\nTHE HOUSE STYLE:\n`;

const THEME_FIX_SYSTEM = `You fix a Scram theme payload (the createTheme object for Scram's manageThemes tool) so it follows SCRAM THEME RULES exactly, changing as little as possible and keeping the design's intent (same colours, fonts and feel). Return ONLY the corrected createTheme JSON object.`;

// Writes and saves the design concept for a run. answers: [{question, answer}]. Returns the saved
// brief: { vibe, concept, content, theme (a checked createTheme object, or null), themeErrors }.
export async function writeDesignBrief({ siteUrl, product, answers = [], settings }) {
  const house = answers.some((a) => a.answer === HOUSE_STYLE_OPTION) ? await houseStyle() : "";
  const [used, usedTh, rules, themeRules, consistency, craft] = await Promise.all([
    usedConcepts(),
    usedThemes(),
    rulesFile("designDirection", "design-direction.md"),
    rulesFile("scramThemes", "scram-themes.md"),
    rulesFile("uiConsistency", "ui-consistency.md"),
    rulesFile("appCraft", "app-craft.md"),
  ]);
  const variety = house
    ? ""
    : `${used.length ? `Concepts already used for other apps (make this one clearly different):\n${used.slice(-20).map((c) => `- ${c}`).join("\n")}\n\n` : ""}${usedTh.length ? `Font pairs and palettes earlier apps' themes used (pick different ones):\n${usedTh.slice(-20).map((t) => `- ${t}`).join("\n")}\n\n` : ""}`;
  const userContent = `${house ? `${HOUSE_NOTE}${house.slice(0, 20000)}\n\n` : `DESIGN RULES:\n${rules}\n\n`}SCRAM THEME RULES:\n${themeRules}\n\nSTRUCTURE RULES (they hold no look):\n${consistency}\n\n${craft}\n\n${variety}THE HUMAN'S DESIGN ANSWERS:\n${answers.length ? answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n") : "(none given — pick the vibe that best fits the product, balanced)"}\n\nTHE PRODUCT (from the research):\n${String(product || "").slice(0, 40000)}`;
  const { text } = await ask({ system: BRIEF_SYSTEM, userContent, maxTokens: 12000, model: settings.operatorModel || settings.model, effort: settings.operatorEffort || "high" });
  let content = String(text || "").trim();
  if (!content) throw new Error("the design concept came back empty");
  const concept = (content.match(/^\s*CONCEPT:\s*(.+)$/m) || [])[1]?.trim() || content.split("\n")[0].slice(0, 200);
  const chosen = answers.find((a) => /vibe/i.test(a.question))?.answer;
  const boldness = answers.find((a) => /bold/i.test(a.question))?.answer;
  const vibe = (content.match(/^\s*VIBE:\s*(.+)$/m) || [])[1]?.trim() || [chosen, boldness].filter(Boolean).join(" — ") || "";

  // The Scram theme: checked against Scram's schema; one repair round if it breaks the rules,
  // then anything still invalid is dropped or clamped (the checked copy is always valid).
  let raw = themeFromConcept(content);
  let checked = raw ? checkTheme(raw) : null;
  if (checked && !checked.ok) {
    const fixed = await askJson({
      what: "Scram theme fix",
      system: THEME_FIX_SYSTEM,
      userContent: `SCRAM THEME RULES:\n${themeRules}\n\nTHE THEME:\n${JSON.stringify(raw, null, 2)}\n\nWHAT'S WRONG:\n${checked.errors.map((e) => `- ${e}`).join("\n")}`,
      maxTokens: 3000,
      model: settings.model,
    }).catch(() => null);
    const again = fixed ? checkTheme(fixed?.createTheme || fixed) : null;
    if (again && again.errors.length < checked.errors.length) checked = again;
  }
  const theme = checked?.theme || null;
  if (theme) content = replaceThemeBlock(content, theme); // the concept shows the theme as it will be sent
  const brief = { vibe, concept, content, theme, themeErrors: checked?.errors || (raw ? [] : ["the concept had no Scram theme block"]), houseStyle: !!house, createdAt: new Date().toISOString() };
  const all = await store.get(BRIEFS_KEY, {});
  all[siteUrl] = brief;
  await store.set(BRIEFS_KEY, all);
  const hist = (await store.get(HISTORY_KEY, [])).filter((h) => h.siteUrl !== siteUrl);
  hist.push({ siteUrl, concept, ...(theme ? { theme: themeSummary(theme) } : {}), ...(house ? { houseStyle: true } : {}), at: brief.createdAt });
  await store.set(HISTORY_KEY, hist.slice(-50));
  return brief;
}

// Put the checked theme back into the concept's "## Scram theme" section (or add the section).
function replaceThemeBlock(content, theme) {
  const block = `## Scram theme\n\`\`\`json\n${JSON.stringify(theme, null, 2)}\n\`\`\``;
  return /##\s*Scram theme[^\n]*\n[\s\S]*?(?=\n##\s|$)/i.test(content)
    ? content.replace(/##\s*Scram theme[^\n]*\n[\s\S]*?(?=\n##\s|$)/i, block)
    : `${content.trimEnd()}\n\n${block}`;
}

// The concept's page styling rules (what the Scram theme can't hold).
export function pageStyling(brief) {
  return (String(brief?.content || "").match(/##\s*Page styling[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "").trim();
}

// The design answers out of a run's Q&A.
export function designAnswers(state) {
  const qa = state?.qa;
  if (!qa?.answeredAt) return [];
  return qa.questions.filter((q) => q.kind === "design").map((q) => ({ question: q.question, answer: qa.answers[q.id] }));
}
