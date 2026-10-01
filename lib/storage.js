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
  model: "claude-sonnet-5",
  specMaxTokens: 8000,
  handoffMaxTokens: 16000,
  autoSubmit: false,
  // Autopilot
  explorationMode: "full", // "full" | "safe"
  productFocus: true, // skip business/legal/marketing/help pages; prioritise product features
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
  maxRoundsPerStep: 30,
};

export async function get(key, fallback) {
  const res = await chrome.storage.local.get(key);
  return res[key] === undefined ? fallback : res[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get("settings", {})) };
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
// Every step file ends with this, so Scram's bot always tests its own work. It can only use
// the running app in Run mode, which the extension keeps on during the build.
const TESTING_HEADING = "## Test it yourself in Run mode (required)";
export const TESTING_SECTION = `${TESTING_HEADING}
- Scram stays in **Run mode** for the whole build — that's how you test: use the running app yourself, like a real user would.
- After building, test **every** item of this step's testing checklist yourself in the running app. Be thorough:
  - click through every screen, button, link, menu and form this step touched;
  - create, edit and delete real records, and check each change shows up everywhere it should;
  - try empty, invalid and edge-case input, and check the error and empty states;
  - refresh and check the data persisted;
  - check security rules: a different user must not be able to see or change what isn't theirs;
  - re-check anything earlier steps built that this step could have affected.
- Screen sizes: you can't change the preview size yourself, and that's fine — I switch Scram's preview between Desktop, Tablet and Mobile for you. Test at the current size first; I'll tell you when I've switched it and what to check at the new size.
- Fix every problem you find, then test again until everything passes.
- Nothing hardcoded: data comes from the database, colours/fonts/spacing from the theme.
- When you report back, go item by item: what you tested, how you tested it, and the result.`;

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
  return [base, notes && `Messages you sent while it was running (newest last; later ones win):\n${notes}`].filter(Boolean).join("\n\n");
}

export function withTestingSection(content) {
  const text = String(content || "");
  return text.includes(TESTING_HEADING) ? text : `${text.trimEnd()}\n\n${TESTING_SECTION}\n`;
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
