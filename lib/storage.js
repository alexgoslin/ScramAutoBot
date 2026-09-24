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
