// Art direction for every clone: design questions in the Q&A, then a design concept (the
// "CONCEPT: …" line, theme tokens, signature element, motion, page composition) that the step
// files and the final review follow. The original site gives the layout and functionality;
// the concept gives the look. Rules: prompts/design-direction.md.

import * as store from "./storage.js";
import { ask, askJson, loadPrompt } from "./jobs.js";

const HISTORY_KEY = "designHistory"; // concept lines already used, so no two apps look alike
const BRIEFS_KEY = "designBriefs"; // { [siteUrl]: { concept, content, createdAt } }

const rules = () => loadPrompt("designDirection", "design-direction.md").catch(() => "");

export async function usedConcepts() {
  return (await store.get(HISTORY_KEY, [])).map((h) => h.concept).filter(Boolean);
}

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
  return (Array.isArray(res.questions) ? res.questions : [])
    .map((q, i) => {
      const options = (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 10);
      const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
      return { id: String(q.id || `d${i + 1}`), kind: "design", question: String(q.question || "").trim(), why: String(q.why || "").trim(), options, recommended: rec };
    })
    .filter((q) => q.question && q.options.length)
    .slice(0, 3);
}

const BRIEF_SYSTEM = `You are the art director for a new web app built in Scram (a no-code app builder with its own AI builder). The app clones the core features of an existing product; its layout and functionality come from the research, but its LOOK is yours to design, following the design rules and the human's answers. Write the design concept that Scram's AI will build from.

Follow the rules exactly: concept first, then a token system, then page composition. The human's chosen VIBE is the north star: every token, shape, texture and line of copy should express it. Their boldness choice sets how strong it is (subtle = understated and quiet; balanced = distinctive but calm; bold = strong colour and big type), and their must-haves and no-gos override your taste. If they chose "Stay close to the original site's look", keep the original's palette and type feel but still apply the rules' quality bar. Keep it tasteful and usable every day: distinctive, never a costume or a literal theme. Make it different from the concepts already used. This build targets desktop size only.

Write Markdown, specific enough to build from with no guessing:
VIBE: <the chosen vibe, and how bold> (the very first line, e.g. "VIBE: Cozy — balanced")
CONCEPT: <one line> (the second line)
## Why it suits this app: two sentences. Then "In three words: …".
## Theme tokens: a table or list with exact values for: background, surface(s), ink (text), muted text, 1–3 accents, borders/rules, success/warning/danger; each with hex and what it's for, and note the AA contrast of text on its backgrounds. Fonts: display, body and optional utility (Google Fonts names, weights) with a type scale (sizes for display, h1–h3, body, small, label). Radii, borders, shadows/texture values, spacing scale.
## Shape language: the one shape language and exactly how buttons, inputs, cards, chips, images and tags look (default / hover / focus / disabled).
## Texture & depth
## Signature element: what it is and where it repeats (at least 4 places across the app).
## Motion: the personality, durations and easing, the scroll reveal, hover states, page transitions; and the reduced-motion fallback.
## Composing the screens: the first screen / any public page (headline voice, the hero visual made from the real product), the logged-in shell (navigation, headers), lists and tables, detail views, forms and settings, empty states, loading states, the 404 page, toasts and dialogs: how each uses the concept.
## Voice: how copy sounds, with 3–5 example lines from this app (buttons, empty states, a headline).
## Never: the generic choices to avoid for this app specifically.`;

// Writes and saves the design concept for a run. answers: [{question, answer}]. Returns the saved brief.
export async function writeDesignBrief({ siteUrl, product, answers = [], settings }) {
  const used = await usedConcepts();
  const userContent = `DESIGN RULES:\n${await rules()}\n\n${used.length ? `Concepts already used for other apps (make this one clearly different):\n${used.slice(-20).map((c) => `- ${c}`).join("\n")}\n\n` : ""}THE HUMAN'S DESIGN ANSWERS:\n${answers.length ? answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n") : "(none given — pick the vibe that best fits the product, balanced)"}\n\nTHE PRODUCT (from the research):\n${String(product || "").slice(0, 40000)}`;
  const { text } = await ask({ system: BRIEF_SYSTEM, userContent, maxTokens: 10000, model: settings.operatorModel || settings.model, effort: settings.operatorEffort || "high" });
  const content = String(text || "").trim();
  if (!content) throw new Error("the design concept came back empty");
  const concept = (content.match(/^\s*CONCEPT:\s*(.+)$/m) || [])[1]?.trim() || content.split("\n")[0].slice(0, 200);
  const chosen = answers.find((a) => /vibe/i.test(a.question))?.answer;
  const boldness = answers.find((a) => /bold/i.test(a.question))?.answer;
  const vibe = (content.match(/^\s*VIBE:\s*(.+)$/m) || [])[1]?.trim() || [chosen, boldness].filter(Boolean).join(" — ") || "";
  const brief = { vibe, concept, content, createdAt: new Date().toISOString() };
  const all = await store.get(BRIEFS_KEY, {});
  all[siteUrl] = brief;
  await store.set(BRIEFS_KEY, all);
  const hist = (await store.get(HISTORY_KEY, [])).filter((h) => h.siteUrl !== siteUrl);
  hist.push({ siteUrl, concept, at: brief.createdAt });
  await store.set(HISTORY_KEY, hist.slice(-50));
  return brief;
}

// The design answers out of a run's Q&A.
export function designAnswers(state) {
  const qa = state?.qa;
  if (!qa?.answeredAt) return [];
  return qa.questions.filter((q) => q.kind === "design").map((q) => ({ question: q.question, answer: qa.answers[q.id] }));
}
