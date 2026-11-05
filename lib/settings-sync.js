// Settings on the RoboBuild site (CONTROL_CENTER_SETTINGS_SYNC.md): the extension describes its
// settings (schema + current values) with bridge_report_settings, the site draws them, and changes
// come back as updateSettings / runSettingsAction. The connection stays in the extension.
// The Anthropic API key is write-only: never sent, echoed, logged or put in any report.

import * as store from "./storage.js";
import { totalCost, formatCost } from "./pricing.js";
import { callClaude } from "./claude.js";

export const SCHEMA_VERSION = 1;
const MODELS = [
  { value: "claude-fable-5-1", label: "Claude Fable 5.1 (most capable, most expensive)" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fast, cheap)" },
];
const modelOptions = (saved) => (saved && !MODELS.some((m) => m.value === saved) ? [...MODELS, { value: saved, label: `${saved} (saved)` }] : MODELS);

// Where each field lives. kind: settings (the "settings" object), apiKey, lessons, prompt, readonly, action.
// Order of groups and fields is what the site shows.
function fieldDefs(s, extra) {
  const D = store.DEFAULT_SETTINGS;
  const set = (key, prop, field) => ({ key, kind: "settings", prop, default: D[prop], value: s[prop] ?? D[prop], ...field });
  return [
    {
      id: "claude",
      title: "Claude & models",
      description: "Your Anthropic API key and which Claude models RoboBuild uses",
      fields: [
        { key: "anthropic.apiKey", kind: "apiKey", label: "Anthropic API key", type: "secret", help: "Stored only in the extension (this browser). Sent only to api.anthropic.com — never back to this site." },
        set("claude.model", "model", { label: "Model", type: "select", options: modelOptions(s.model), help: "Used for planning, specs, step files, questions and Ask Autopilot answers" }),
        set("claude.operatorModel", "operatorModel", { label: "Operator model", type: "select", options: modelOptions(s.operatorModel), help: "The extension's own AI that works Scram for you: supervises Scram's AI, finds its way around the editor from screenshots, does the final review" }),
        set("claude.operatorEffort", "operatorEffort", { label: "Operator thinking effort", type: "select", options: [{ value: "medium", label: "Medium — faster, cheaper" }, { value: "high", label: "High (recommended)" }, { value: "xhigh", label: "Extra high — slower, most careful" }] }),
        set("claude.explorerModel", "explorerModel", { label: "Navigator model", type: "select", options: modelOptions(s.explorerModel), help: "Cheap model that plans each step of the crawl" }),
        set("claude.specMaxTokens", "specMaxTokens", { label: "Spec max tokens", type: "number", min: 1000, max: 64000, step: 1000, unit: "tokens" }),
        set("claude.handoffMaxTokens", "handoffMaxTokens", { label: "Handoff max tokens", type: "number", min: 1000, max: 128000, step: 1000, unit: "tokens" }),
        { key: "claude.testKey", kind: "action", label: "Test API key", type: "action", help: "Sends a one-word request to Claude with the saved key" },
      ],
    },
    {
      id: "autopilot",
      title: "Autopilot",
      description: "How a run researches the site and builds it",
      fields: [
        set("autopilot.explorationMode", "explorationMode", { label: "Exploration mode", type: "select", options: [{ value: "full", label: "Full interaction — click everything (undone afterwards), type into text boxes" }, { value: "safe", label: "Safe — read-only: menus, tabs, modals, links and search only" }], help: "In both modes Autopilot never logs out, deletes, pays, posts or submits what it types" }),
        set("autopilot.askQuestions", "askQuestions", { label: "Ask me questions before planning the build", type: "toggle" }),
        set("autopilot.coreFeaturesOnly", "coreFeaturesOnly", { label: "Core features only", type: "toggle", help: "Decide the site's core features first; crawl, spec and build only those" }),
        set("autopilot.productFocus", "productFocus", { label: "Product focus", type: "toggle", help: "Skip business, legal, marketing, help, ads, premium and developer pages" }),
        set("autopilot.autopilotBuild", "autopilotBuild", { label: "Build in Scram automatically after the steps are written", type: "toggle" }),
        set("autopilot.finalDesignReview", "finalDesignReview", { label: "Final review after the build", type: "toggle", help: "Tests the finished app in Run mode, then tells Scram's AI what to fix (up to 3 rounds)" }),
        set("autopilot.workInOwnWindow", "workInOwnWindow", { label: "Work in its own Chrome window", type: "toggle", help: "Keep that window on screen (not minimised): Scram pauses its AI when its tab is hidden" }),
        set("autopilot.maxPages", "maxPages", { label: "Max screens to explore", type: "number", min: 1, max: 100, step: 1, unit: "screens" }),
        set("autopilot.categoryPagesPerSite", "categoryPagesPerSite", { label: "Screens per site in a category run", type: "number", min: 1, max: 50, step: 1, unit: "screens" }),
        set("autopilot.maxInteractionsPerPage", "maxInteractionsPerPage", { label: "Max controls tried per screen", type: "number", min: 0, max: 50, step: 1, unit: "controls" }),
        set("autopilot.actionDelayMs", "actionDelayMs", { label: "Delay between actions", type: "number", min: 300, max: 20000, step: 100, unit: "ms" }),
        set("autopilot.searchQuery", "searchQuery", { label: "Text typed into search boxes while crawling", type: "text", placeholder: "test" }),
        set("autopilot.recordNetwork", "recordNetwork", { label: "Record network requests", type: "toggle", help: "Chrome shows a “debugging this browser” bar while exploring" }),
        set("autopilot.recordResponseBodies", "recordResponseBodies", { label: "Include response samples", type: "toggle", depends_on: { key: "autopilot.recordNetwork", equals: true }, help: "First 1,500 characters — shows data shapes, may include your account's data" }),
        set("autopilot.screenshots", "screenshots", { label: "Send a screenshot of each screen to Claude", type: "toggle" }),
        { key: "extension.devMode", kind: "readonly", label: "Dev mode", type: "readonly", value: extra.devMode ? "On — the toolbar icon opens the full side panel" : "Off — the toolbar icon opens the small popup", help: "Change in the extension" },
      ],
    },
    {
      id: "scram",
      title: "Scram",
      description: "How RoboBuild works Scram's editor and its AI",
      fields: [
        set("scram.operatorBrowserTools", "operatorBrowserTools", { label: "Navigate Scram like Claude in Chrome", type: "toggle", help: "The operator reads the page, looks at screenshots and clicks/types with real input in one continuous conversation" }),
        set("scram.supervisorSees", "supervisorSees", { label: "The supervisor sees the screen", type: "toggle", help: "A screenshot of the Scram tab each round (uses a little more Claude credit)" }),
        set("scram.scramSendAsFile", "scramSendAsFile", { label: "Give each step to Scram's AI as an attached .md file", type: "toggle", help: "Falls back to pasting the text if the chat has no upload" }),
        set("scram.scramIdleSeconds", "scramIdleSeconds", { label: "Scram's bot counts as finished after being quiet for", type: "number", min: 5, max: 600, step: 1, unit: "seconds" }),
        set("scram.maxTurnMinutes", "maxTurnMinutes", { label: "Longest wait for one reply from Scram's bot before nudging it", type: "number", min: 5, max: 120, step: 1, unit: "minutes" }),
        set("scram.autoSubmit", "autoSubmit", { label: "Auto-submit pasted steps (manual build only)", type: "toggle", help: "Only for the manual Build tab in the extension's Dev mode" }),
        { key: "scram.scramAttachMethod", kind: "readonly", label: "File upload method found to work on your Scram", type: "readonly", value: s.scramAttachMethod || "Not detected yet — found automatically on the first upload" },
        { key: "scram.forgetAttachMethod", kind: "action", label: "Forget it", type: "action", help: "RoboBuild tries every upload method again next time" },
      ],
    },
    {
      id: "steps",
      title: "Step files",
      description: "How the build steps given to Scram's AI are written (next time a handoff is generated)",
      fields: [
        set("steps.detailedSteps", "detailedSteps", { label: "Detailed steps", type: "toggle", help: "Each step spells out every screen, button, field and workflow exactly (slower, more Claude credit)" }),
        set("steps.slimContext", "slimContext", { label: "Slim context", type: "toggle", help: "After Setup, each step carries a short summary plus only what it uses" }),
        set("steps.stepSize", "stepSize", { label: "Step size", type: "select", options: [{ value: "standard", label: "Standard — up to 10 checklist items per step" }, { value: "small", label: "Small — up to 6 checklist items per step" }] }),
        set("steps.maxStepChars", "maxStepChars", { label: "Split steps longer than", type: "number", min: 2000, max: 60000, step: 500, unit: "characters" }),
      ],
    },
    {
      id: "learned",
      title: "What it learned",
      description: "Things Scram's AI can't do — Autopilot never asks for them again",
      fields: [{ key: "learned.lessons", kind: "lessons", label: "Lessons about Scram's bot", type: "textarea", value: extra.lessons.map((l) => l.text).join("\n"), default: "", placeholder: "One lesson per line", help: "One lesson per line. Delete a line to forget it, add a line to teach it." }],
    },
    {
      id: "prompts",
      title: "Prompts",
      description: "Leave blank to use the bundled prompts",
      fields: [
        { key: "prompts.specExtractor", kind: "prompt", prop: "specExtractor", label: "Site Screen Spec Extractor (system prompt override)", type: "textarea", value: extra.prompts.specExtractor || "", default: "", placeholder: "Blank = the bundled prompt" },
        { key: "prompts.handoffSplitter", kind: "prompt", prop: "handoffSplitter", label: "Phased Build Handoff Splitter (system prompt override)", type: "textarea", value: extra.prompts.handoffSplitter || "", default: "", placeholder: "Blank = the bundled prompt" },
        { key: "prompts.resetToBundled", kind: "action", label: "Use the bundled prompts again", type: "action", danger: true, help: "Clears both overrides" },
      ],
    },
    {
      id: "data",
      title: "Data & usage",
      description: "Usage totals and the data saved in the extension",
      fields: [
        { key: "data.usage", kind: "readonly", label: "All-time Claude usage", type: "readonly", value: extra.usageText },
        { key: "data.resetUsage", kind: "action", label: "Reset usage counter", type: "action", danger: true },
        { key: "data.wipeAll", kind: "action", label: "Delete all captured data", type: "action", danger: true, help: "Spec files, step files, build progress and research briefings. Your API key, settings and lessons are kept." },
      ],
    },
  ];
}

async function readAll() {
  const got = await chrome.storage.local.get(["apiKey", "promptOverrides", "uiDevMode", "usage"]);
  const settings = await store.getSettings();
  const lessons = await store.getLessons();
  const u = got.usage || { input: 0, output: 0, calls: 0 };
  const usageText = `${(u.calls || 0).toLocaleString()} Claude calls · ${(u.input || 0).toLocaleString()} input / ${(u.output || 0).toLocaleString()} output tokens · about ${u.costEstimated ? "≈" : ""}${formatCost(totalCost(u))}`;
  return { settings, apiKey: String(got.apiKey || ""), extra: { lessons, prompts: got.promptOverrides || {}, devMode: got.uiDevMode === true, usageText } };
}

// The report the site renders: internal bookkeeping (kind, prop) stripped; the key never included.
export async function buildReport() {
  const { settings, apiKey, extra } = await readAll();
  const groups = fieldDefs(settings, extra).map((g) => ({
    ...g,
    fields: g.fields.map(({ kind, prop, ...f }) => {
      if (kind === "apiKey") {
        const key = apiKey.trim();
        return { ...f, is_set: key.length > 0, ...(key.length >= 8 ? { hint: `…${key.slice(-4)}` } : {}) };
      }
      if (kind === "action") {
        const { value, default: _d, ...rest } = f;
        return rest;
      }
      return f;
    }),
  }));
  return { schema_version: SCHEMA_VERSION, groups };
}

// ------------------------------------------------------------------ validation + apply

function validate(f, v) {
  switch (f.type) {
    case "toggle":
      if (v === true || v === false) return v;
      if (v === "true" || v === "false") return v === "true";
      throw new Error("must be true or false");
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error("must be a number");
      if (f.min != null && n < f.min) throw new Error(`must be at least ${f.min}`);
      if (f.max != null && n > f.max) throw new Error(`must be at most ${f.max}`);
      if (Number.isInteger(f.step ?? 1) && !Number.isInteger(n)) throw new Error("must be a whole number");
      return n;
    }
    case "select":
      if (!f.options.some((o) => o.value === v)) throw new Error(`must be one of: ${f.options.map((o) => o.value).join(", ")}`);
      return v;
    case "text":
      if (typeof v !== "string") throw new Error("must be text");
      if (v.length > 500) throw new Error("is too long (500 characters at most)");
      return v.trim();
    case "textarea":
      if (typeof v !== "string") throw new Error("must be text");
      if (v.length > 100000) throw new Error("is too long");
      return v;
    case "secret":
      if (typeof v !== "string") throw new Error("must be text");
      if (v.trim().length > 300 || /\s/.test(v.trim())) throw new Error("doesn't look like an API key");
      return v.trim();
    case "readonly":
      throw new Error("is read-only (change it in the extension)");
    case "action":
      throw new Error("is a button — use runSettingsAction");
    default:
      throw new Error("can't be changed");
  }
}

// changes: { "<key>": value }. Valid ones are applied, invalid ones skipped with a reason.
// Rejection reasons never include the value (it may be the API key).
export async function applyChanges(changes) {
  const { settings, extra } = await readAll();
  const fields = new Map(fieldDefs(settings, extra).flatMap((g) => g.fields).map((f) => [f.key, f]));
  const applied = [];
  const rejected = [];
  const nextSettings = {};
  let apiKey;
  let lessons;
  const prompts = {};
  for (const [key, raw] of Object.entries(changes && typeof changes === "object" ? changes : {})) {
    const f = fields.get(key);
    try {
      if (!f) throw new Error("unknown setting");
      const v = validate(f, raw);
      if (f.kind === "settings") nextSettings[f.prop] = v;
      else if (f.kind === "apiKey") apiKey = v;
      else if (f.kind === "lessons") lessons = v;
      else if (f.kind === "prompt") prompts[f.prop] = v;
      applied.push(key);
    } catch (e) {
      rejected.push({ key, reason: e.message });
    }
  }
  if (Object.keys(nextSettings).length) {
    const saved = await store.get("settings", {});
    await store.set("settings", { ...saved, ...nextSettings, settingsVersion: 2 });
  }
  if (apiKey !== undefined) await chrome.storage.local.set({ apiKey });
  if (Object.keys(prompts).length) await chrome.storage.local.set({ promptOverrides: { ...extra.prompts, ...prompts } });
  if (lessons !== undefined) {
    // One lesson per line: keep the ones still there, add new lines, forget removed ones.
    const lines = [...new Set(lessons.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim().slice(0, 300)).filter(Boolean))].slice(-60);
    const byText = new Map(extra.lessons.map((l) => [l.text, l]));
    await store.set("scramLessons", lines.map((text) => byText.get(text) || { id: store.uid(), text, source: "added on the RoboBuild site", learnedAt: new Date().toISOString() }));
  }
  return { applied, rejected };
}

// Buttons. Returns a short message for the site.
export async function runAction(key, { wipeAllSites } = {}) {
  switch (key) {
    case "claude.testKey": {
      const [apiKey, settings] = await Promise.all([store.get("apiKey", ""), store.getSettings()]);
      if (!String(apiKey).trim()) return { ok: false, message: "No Anthropic API key is set." };
      try {
        const { text } = await callClaude({ apiKey, model: settings.model, system: "Reply with the single word: ok", userContent: "ping", maxTokens: 10 });
        return { ok: true, message: `Works ✓ — ${settings.model} replied “${String(text || "").trim().slice(0, 40)}”.` };
      } catch (e) {
        return { ok: false, message: `The key didn't work: ${String(e.message || e).replaceAll(apiKey, "…").slice(0, 300)}` };
      }
    }
    case "scram.forgetAttachMethod": {
      const settings = await store.get("settings", {});
      delete settings.scramAttachMethod;
      await store.set("settings", settings);
      return { ok: true, message: "Forgotten — RoboBuild will try every upload method again next time." };
    }
    case "prompts.resetToBundled":
      await chrome.storage.local.set({ promptOverrides: {} });
      return { ok: true, message: "Using the bundled prompts again." };
    case "data.resetUsage":
      await chrome.storage.local.set({ usage: { input: 0, output: 0, calls: 0, cost: 0 } });
      return { ok: true, message: "Usage counter reset to zero." };
    case "data.wipeAll":
      if (wipeAllSites) await wipeAllSites();
      else await store.wipeSiteData(null);
      return { ok: true, message: "All captured data deleted (spec files, step files, build progress, briefings). Your API key, settings and lessons are kept." };
    default:
      return { ok: false, message: `Unknown action: ${key}` };
  }
}

// Storage keys whose change means the settings report is out of date.
export const WATCHED_KEYS = ["settings", "apiKey", "scramLessons", "promptOverrides", "uiDevMode"];
