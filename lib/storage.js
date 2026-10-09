// Thin wrapper around chrome.storage.local.
//
// Keys:
//   apiKey          string
//   settings        { model, specMaxTokens, handoffMaxTokens, autoSubmit }
//   promptOverrides { specExtractor, handoffSplitter }   (optional, from Options)
//   sites           [{ siteUrl, domain, firstCapturedAt, lastCapturedAt }]
//   specFiles       [{ id, siteUrl, pageUrl, pageTitle, content, capturedAt }]
//   handoffFiles    [{ id, siteUrl, fileType, stepNumber, title, content, createdAt }]
//   buildProgress   { [siteUrl]: { siteUrl, currentStep, completedSteps[], scramTabId, startedAt } }
//   activeBuild     siteUrl | null
//   jobs            { [key]: { status: "running" | "error", message, startedAt } }

export const DEFAULT_SETTINGS = {
  model: "claude-opus-5-5",
  specMaxTokens: 8000,
  handoffMaxTokens: 16000,
  autoSubmit: false,
  // Autopilot
  explorationMode: "full", // "full" | "safe"
  productFocus: true, // skip business/legal/marketing/help pages; prioritise product features
  coreFeaturesOnly: true,
  askQuestions: true, // Q&A step between research and planning the build // ask Claude for the site's core features first; crawl + build only those
  explorerModel: "claude-haiku-4-5-20251001",
  maxPages: 20,
  maxInteractionsPerPage: 12,
  actionDelayMs: 1500,
  recordNetwork: true,
  recordResponseBodies: true,
  screenshots: true,
  searchQuery: "test",
  autopilotBuild: true,
  scramSendAsFile: true, // attach each step to Scram's chat as a .md file (falls back to pasting)
  scramIdleSeconds: 25,
  maxTurnMinutes: 30,
  // Step files
  slimContext: true, // after Setup, steps carry a short context + only the details they use
  stepSize: "small", // "small" (≤6 checklist items per step) | "standard" (≤10)
  maxStepChars: 6000, // longer steps are split automatically when the handoff is generated
};

export async function get(key, fallback) {
  const res = await chrome.storage.local.get(key);
  return res[key] === undefined ? fallback : res[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  const saved = await get("settings", {});
  delete saved.maxRoundsPerStep; // removed: steps have no round limit any more
  // Sonnet 5 was the old default model; settings saved with it pick up the new default (Opus 5.5).
  if (saved.model === "claude-sonnet-5") delete saved.model;
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function uid() {
  return crypto.randomUUID();
}

// Scram lives on several hosts: dashboard.buildwithscram.com (project list) and
// editor.buildwithscram.com (a project's editor with the AI chat).
export const SCRAM_HOME = "https://dashboard.buildwithscram.com/";
export const SCRAM_TAB_PATTERN = "https://*.buildwithscram.com/*";
export const isScramUrl = (url) => /^https:\/\/([a-z0-9-]+\.)*buildwithscram\.com(\/|$)/i.test(url || "");
export const isScramEditorUrl = (url) => /^https:\/\/editor\.buildwithscram\.com\//i.test(url || "");

// Scram tabs, project editors first (most recently used first).
export async function scramTabs() {
  const tabs = await chrome.tabs.query({ url: SCRAM_TAB_PATTERN });
  return tabs.sort((a, b) => Number(isScramEditorUrl(b.url)) - Number(isScramEditorUrl(a.url)) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

// File name for a handoff file, e.g. step-03-timeline-and-composer.md
// Every step file ends with this short check, so Scram's bot tests its own work once, quickly.
// It can only use the running app in Run mode, which the extension keeps on during the build.
const TESTING_HEADING = "## Quick check in Run mode (required)";
// The long section older step files were saved with — replaced by the short one when sent.
const OLD_TESTING_SECTION = /\n*## Test it yourself in Run mode \(required\)[\s\S]*?(?=\n## |$)/;
export const TESTING_SECTION = `${TESTING_HEADING}
Scram stays in **Run mode** (I keep it on for you). When this step is built, do ONE quick pass in the running app, like a user:
- Try the main thing this step is for (its "Objective") once, end to end.
- Give each item in this step's testing checklist one quick try. No exhaustive edge-case hunting.
- Fix anything that fails and re-check just that item.
- Other screen sizes only if the checklist asks for them: say which size you need and I'll switch the preview for you (you can't). Don't re-test earlier steps unless this step clearly broke them.
- Nothing hardcoded: data from the database, styles from the theme.

Then report back in a few short lines: is the objective achieved, what (if anything) failed and was fixed, and "nothing hardcoded". Keep it brief and move on.`;

// ---- Lessons: things Scram's bot has said it can't do, so the supervisor stops asking.
// Kept across runs (chrome.storage "scramLessons"); viewable/deletable in Settings.
const lessonWords = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
export function similarity(a, b) {
  const A = lessonWords(a);
  const B = lessonWords(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size);
}

export async function getLessons() {
  return get("scramLessons", []);
}

export async function addLessons(texts, source = "") {
  const lessons = await getLessons();
  const added = [];
  for (const raw of [].concat(texts || [])) {
    const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (text.length < 12) continue;
    if (lessons.some((l) => similarity(l.text, text) >= 0.7)) continue; // already known
    const lesson = { id: uid(), text, source, learnedAt: new Date().toISOString() };
    lessons.push(lesson);
    added.push(lesson);
  }
  if (added.length) await set("scramLessons", lessons.slice(-60));
  return added;
}

export async function removeLesson(id) {
  await set("scramLessons", (await getLessons()).filter((l) => l.id !== id));
}

// The run's instructions plus every message you sent Autopilot while it was running.
export function runInstructions(state) {
  const base = String(state?.instructions || "").trim();
  const notes = (state?.notes || []).map((n) => `- ${n.text}`).join("\n");
  const sc = state?.scope;
  const scope = sc?.core?.length
    ? `CORE SCOPE — clone ONLY these core features of ${sc.product || "the product"}: ${sc.core.map((f) => f.name).join("; ")}.${sc.skip.length ? ` Do NOT crawl, spec or create build steps for: ${sc.skip.map((f) => f.name).join("; ")} — they're niche or rarely used.` : ""} Where a core screen links to a skipped feature, a visibly inert placeholder is enough.`
    : "";
  const qa = state?.qa?.answeredAt
    ? `DECISIONS — the human answered these before the build was planned (follow them):\n${state.qa.questions.map((q) => `- ${q.question} → ${state.qa.answers[q.id]}`).join("\n")}`
    : "";
  return [base, scope, qa, notes && `Messages you sent while it was running (newest last; later ones win):\n${notes}`].filter(Boolean).join("\n\n");
}

// Trim the waffle step files tend to carry (works on new and already-saved files):
// - wordy template headings ("Context Block (repeated in full — …)", "… complete ALL of these …");
// - the "Testing standard" line inside the context (the short check at the end replaces it);
// - the per-step "Progress so far" history, collapsed to one line of step names;
// - the long "everything is already in the project" note.
export const SHORT_PROJECT_NOTE = "- Everything earlier steps built (theme, database + security, routes, components) is already in this Scram project: look things up there, don't re-create them.";
export function streamlineStep(content) {
  let t = String(content || "");
  t = t.replace(/^(#{1,3})\s*Context Block\b[^\n]*$/gim, "$1 Context");
  t = t.replace(/^(#{1,3})\s*Testing checklist\b[^\n]*$/gim, "$1 Testing checklist");
  t = t.replace(/^(#{1,3})\s*Your scope for this step(?: ONLY)?\s*$/gim, "$1 Scope");
  t = t.replace(/^(#{1,3})\s*Explicitly out of scope for this step\s*$/gim, "$1 Out of scope");
  t = t.replace(/^[ \t]*[-*][ \t]*\**(?:the )?(?:standing )?testing (?:standard|mandate)\b[^\n]*\n?/gim, "");
  t = t.replace(/^- Built in Step 0 and stored in this Scram project:[^\n]*$/gm, SHORT_PROJECT_NOTE);
  t = t.replace(/^- Progress so far:[ \t]*\n((?:[ \t]+- Step \d+[^\n]*\n?)+)/gm, (_, lines) => {
    const done = [...lines.matchAll(/- Step (\d+) \(([^)]+)\):\s*(.*?)\s*(?:—\s*done\.?)?\s*$/gm)].map((m) => ({ stepNumber: m[1], title: m[2], summary: m[3] }));
    return done.length ? `${ledgerLine(done)}\n` : lines;
  });
  t = t.replace(/^- Progress so far: none[^\n]*\n?/gm, "");
  return t.replace(/\n{3,}/g, "\n\n");
}

// The one testing section every step ends with (older step files' long version is swapped for
// the short one). Older step files also carry the template's
// own gate paragraph ("Do not request the next step file until…") — drop that, so the
// testing rules are stated once.
const GATE_PARAGRAPH = /^(?:Do not request the next step(?: file)? until|Delivery rule:)[^\n]*(?:\n(?!\s*\n|#)[^\n]*)*\n?/gim;
export function withTestingSection(content) {
  let text = streamlineStep(content);
  if (text.includes(TESTING_HEADING)) return text;
  text = text.replace(OLD_TESTING_SECTION, "").replace(GATE_PARAGRAPH, "").replace(/\n{3,}/g, "\n\n");
  return `${text.trimEnd()}\n\n${TESTING_SECTION}\n`;
}

export function handoffFileName(f) {
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "file";
  if (f.fileType === "step") return `step-${String(f.stepNumber).padStart(2, "0")}-${slug(f.title)}.md`;
  if (f.fileType === "manifest") return "step-manifest.md";
  return `${slug(f.title)}.md`;
}

export function siteUrlFor(pageUrl) {
  return new URL(pageUrl).origin;
}

export async function upsertSite(siteUrl) {
  const sites = await get("sites", []);
  const now = new Date().toISOString();
  const existing = sites.find((s) => s.siteUrl === siteUrl);
  if (existing) {
    existing.lastCapturedAt = now;
  } else {
    sites.push({ siteUrl, domain: new URL(siteUrl).hostname, firstCapturedAt: now, lastCapturedAt: now });
  }
  await set("sites", sites);
}

export async function addSpecFile(spec) {
  const specs = await get("specFiles", []);
  specs.push(spec);
  await set("specFiles", specs);
  await upsertSite(spec.siteUrl);
}

export async function deleteSpecFile(id) {
  const specs = await get("specFiles", []);
  await set("specFiles", specs.filter((s) => s.id !== id));
}

export async function replaceHandoffFiles(siteUrl, files) {
  const all = await get("handoffFiles", []);
  await set("handoffFiles", [...all.filter((f) => f.siteUrl !== siteUrl), ...files]);
}

export async function getSteps(siteUrl) {
  const all = await get("handoffFiles", []);
  return all
    .filter((f) => f.siteUrl === siteUrl && f.fileType === "step")
    .sort((a, b) => a.stepNumber - b.stepNumber);
}

export async function getProgress(siteUrl) {
  const all = await get("buildProgress", {});
  return all[siteUrl] || { siteUrl, currentStep: 0, completedSteps: [] };
}

export async function setProgress(progress) {
  const all = await get("buildProgress", {});
  all[progress.siteUrl] = progress;
  await set("buildProgress", all);
}

export async function setJob(key, job) {
  const jobs = await get("jobs", {});
  if (job) jobs[key] = job;
  else delete jobs[key];
  await set("jobs", jobs);
}

// Delete everything saved for one website (or every website when siteUrl is null): captured
// spec files, handoff/step files, build progress, research briefings, pending jobs, and a
// finished/stopped Autopilot run for it. Your API key, settings, usage totals and what the
// extension learned about Scram (lessons, Scram guide) are kept.
export async function wipeSiteData(siteUrl = null) {
  const all = await chrome.storage.local.get(["sites", "specFiles", "handoffFiles", "buildProgress", "briefings", "jobs", "activeBuild", "autopilot"]);
  const ap = all.autopilot;
  if (ap && ["running", "paused", "waiting"].includes(ap.status) && (!siteUrl || ap.siteUrl === siteUrl)) {
    throw new Error(`Autopilot is ${ap.status === "running" ? "working on" : `${ap.status} on`} ${new URL(ap.siteUrl).host} — press Stop (and Clear) first, then wipe.`);
  }
  const keep = (x) => siteUrl && x?.siteUrl !== siteUrl;
  const jobs = Object.fromEntries(Object.entries(all.jobs || {}).filter(([k]) => siteUrl && !k.endsWith(`:${siteUrl}`)));
  const progress = Object.fromEntries(Object.entries(all.buildProgress || {}).filter(([k]) => siteUrl && k !== siteUrl));
  const counts = {
    specs: (all.specFiles || []).filter((x) => !keep(x)).length,
    handoff: (all.handoffFiles || []).filter((x) => !keep(x)).length,
  };
  await chrome.storage.local.set({
    sites: (all.sites || []).filter(keep),
    specFiles: (all.specFiles || []).filter(keep),
    handoffFiles: (all.handoffFiles || []).filter(keep),
    briefings: (all.briefings || []).filter(keep),
    buildProgress: progress,
    jobs,
    activeBuild: !siteUrl || all.activeBuild === siteUrl ? null : all.activeBuild,
  });
  if (ap && (!siteUrl || ap.siteUrl === siteUrl)) await chrome.storage.local.remove("autopilot");
  return counts;
}

// The progress part of the Context Block: every earlier step by name, plus a one-line summary of
// the last few (the full history grew by a line per step; the details are in the Scram project).
export function ledgerLine(done, recent = 3) {
  if (!done.length) return "";
  const older = done.slice(0, -recent);
  const last = done.slice(-recent);
  return [
    `- Already built (Steps ${done[0].stepNumber}–${done.at(-1).stepNumber}):${older.length ? ` ${older.map((p) => p.title).join(", ")};` : ""} most recently:`,
    ...last.map((p) => `  - Step ${p.stepNumber} (${p.title})${p.summary && p.summary !== p.title ? `: ${p.summary}` : ""}`),
  ].join("\n");
}

// One-off tidy of saved step files (run when the extension is installed/updated).
export async function streamlineSavedSteps() {
  const files = await get("handoffFiles", []);
  let changed = 0;
  const next = files.map((f) => {
    if (f.fileType !== "step" || f.raw) return f;
    const content = withTestingSection(f.content);
    if (content === f.content) return f;
    changed++;
    return { ...f, content };
  });
  if (changed) await set("handoffFiles", next);
  return changed;
}
