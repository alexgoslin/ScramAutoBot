// Settings on the RoboBuild site (CONTROL_CENTER_SETTINGS_SYNC.md): the extension describes its
// settings (schema + current values) with bridge_report_settings, the site draws them, and changes
// come back as updateSettings / runSettingsAction. The connection stays in the extension.
// The Anthropic API key is write-only: never sent, echoed, logged or put in any report.

import * as store from "./storage.js";
import { totalCost, formatCost } from "./pricing.js";
import { callClaude } from "./claude.js";

export const SCHEMA_VERSION = 1;
// Model lists show the raw model IDs (as the old Settings page did).
const MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ value: id, label: id }));
const modelOptions = (saved) => (saved && !MODELS.some((m) => m.value === saved) ? [...MODELS, { value: saved, label: saved }] : MODELS);

// Where each field lives. kind: settings (the "settings" object), apiKey, lessons, prompt, readonly, action.
// Labels and help are the extension's own wording, word for word. Order = what the site shows.
// Groups: Claude & models, Autopilot, Step files, What it learned, Prompts; Data & usage goes on
// the site's Usage page (placement: "usage").
function fieldDefs(s, extra) {
  const D = store.DEFAULT_SETTINGS;
  const set = (key, prop, field) => ({ key, kind: "settings", prop, default: D[prop], value: s[prop] ?? D[prop], ...field });
  const u = extra.usage;
  return [
    {
      id: "claude",
      title: "Claude & models",
      fields: [
        { key: "anthropic.apiKey", kind: "apiKey", label: "API key", type: "secret", placeholder: "sk-ant-...", help: "Stored only in this browser's chrome.storage.local and sent only to api.anthropic.com." },
        set("claude.model", "model", { label: "Model", type: "select", options: modelOptions(s.model) }),
        set("claude.operatorModel", "operatorModel", { label: "Operator model — the extension's own AI that works Scram for you (supervises Scram's AI, finds its way around the editor from screenshots, gets back to Run mode, does the final review)", type: "select", options: modelOptions(s.operatorModel), help: "Claude Fable 5.1 is the most capable (and most expensive: about 2.5× Opus 5.5 per token). Opus 5.5 is a good cheaper choice." }),
        set("claude.operatorEffort", "operatorEffort", { label: "Operator thinking effort — used for the decisions that matter (a step is complete, errors, the bot drifting to another step, pausing for you, your messages)", type: "select", options: [{ value: "medium", label: "Medium — faster, cheaper" }, { value: "high", label: "High (recommended)" }, { value: "xhigh", label: "Extra high — slower, most careful" }] }),
        set("claude.operatorRoutineEffort", "operatorRoutineEffort", { label: "Thinking effort for routine supervisor rounds — “carry on”, approving a plan, answering a simple question. Faster and cheaper; a “step complete”, “pause”, “new chat” or drift answer is always double-checked at the operator effort above.", type: "select", options: [{ value: "low", label: "Low — fastest" }, { value: "medium", label: "Medium (recommended)" }, { value: "same", label: "Same as the operator effort — slowest" }] }),
        set("scram.operatorBrowserTools", "operatorBrowserTools", { label: "Navigate Scram like Claude in Chrome — the operator uses Anthropic's browser tools (reads the page with element references, looks at screenshots, zooms, clicks and types with real mouse and keyboard input) in one continuous conversation, seeing the result of every action. Off = the older one-step-at-a-time navigator.", type: "toggle" }),
        set("scram.supervisorSees", "supervisorSees", { label: "The supervisor sees the screen — it gets a screenshot of the Scram tab at the start of each step and whenever something looks unusual (an error, a dialog or question form, no new output, the bot saying the app isn't running, a stuck step), and can send the navigator to look around Scram and the running app before deciding.", type: "toggle" }),
        set("claude.specMaxTokens", "specMaxTokens", { label: "Spec max tokens", type: "number", min: 1000, max: 200000, step: 1000, unit: "tokens" }),
        set("claude.handoffMaxTokens", "handoffMaxTokens", { label: "Handoff max tokens", type: "number", min: 1000, max: 200000, step: 1000, unit: "tokens" }),
        set("scram.autoSubmit", "autoSubmit", { label: "Auto-submit steps in the Scram chat after pasting (otherwise you press send)", type: "toggle" }),
        { key: "claude.testKey", kind: "action", label: "Test API key", type: "action" },
      ],
    },
    {
      id: "autopilot",
      title: "Autopilot",
      description: "In both modes Autopilot never logs out, deletes or deactivates, pays or upgrades, or posts/sends/invites/reports — and never submits what it types.",
      fields: [
        set("autopilot.explorationMode", "explorationMode", { label: "Exploration mode", type: "select", options: [{ value: "full", label: "Full interaction — click everything (likes, follows, toggles… undone afterwards), type into text boxes" }, { value: "safe", label: "Safe — read-only: menus, tabs, modals, links and search only" }] }),
        set("autopilot.workInOwnWindow", "workInOwnWindow", { label: "Work in its own Chrome window — Autopilot opens every tab it uses (exploration, sites to research, Scram) in a separate RoboBuild window, so it never takes over the window you're using. Keep that window on screen (it can sit behind others, just don't minimise it): Scram pauses its AI when its tab is hidden.", type: "toggle" }),
        set("autopilot.finalDesignReview", "finalDesignReview", { label: "Final review after the build — once every step is built, the extension tests the finished app itself in Run mode (crawls its pages, clicks its buttons and menus, checks the layout), then tells Scram's AI what to fix — up to 3 rounds. Nothing is tested by the extension during the build.", type: "toggle" }),
        set("autopilot.askQuestions", "askQuestions", { label: "Ask me questions before planning the build — after researching, Claude asks how you want unclear parts built in Scram (with recommended answers), and waits for you", type: "toggle" }),
        set("autopilot.coreFeaturesOnly", "coreFeaturesOnly", { label: "Core features only — before crawling, Claude decides the site's core features (what most users do there) and what's niche or rarely used; Autopilot then crawls, specs and builds only the core", type: "toggle" }),
        set("autopilot.productFocus", "productFocus", { label: "Product focus — crawl the product's features (posts, feeds, replies, media, profiles, messages…) and skip business, legal, marketing, help, ads, premium and developer pages and other subdomains", type: "toggle" }),
        set("autopilot.maxPages", "maxPages", { label: "Max screens to explore", type: "number", min: 1, max: 100, step: 1, unit: "screens" }),
        set("autopilot.maxInteractionsPerPage", "maxInteractionsPerPage", { label: "Max controls tried per screen", type: "number", min: 0, max: 50, step: 1, unit: "controls" }),
        set("autopilot.actionDelayMs", "actionDelayMs", { label: "Delay between actions (ms)", type: "number", min: 300, max: 20000, step: 100, unit: "ms" }),
        set("claude.explorerModel", "explorerModel", { label: "Navigator model (cheap)", type: "select", options: modelOptions(s.explorerModel) }),
        set("autopilot.recordNetwork", "recordNetwork", { label: "Record network requests (Chrome shows a “debugging this browser” bar while exploring)", type: "toggle" }),
        set("autopilot.recordResponseBodies", "recordResponseBodies", { label: "Include response samples (first 1,500 chars) — shows data shapes, may include your account's data", type: "toggle", depends_on: { key: "autopilot.recordNetwork", equals: true } }),
        set("autopilot.screenshots", "screenshots", { label: "Send a screenshot of each screen to Claude", type: "toggle" }),
        set("autopilot.autopilotBuild", "autopilotBuild", { label: "After generating the steps, build the app in Scram automatically", type: "toggle" }),
        set("scram.scramSendAsFile", "scramSendAsFile", { label: "Give each step to Scram's AI as an attached .md file (falls back to pasting the text if the chat has no upload)", type: "toggle" }),
        set("scram.scramIdleSeconds", "scramIdleSeconds", { label: "Scram bot “finished” after quiet for (s)", type: "number", min: 5, max: 600, step: 1, unit: "seconds" }),
        set("scram.maxTurnMinutes", "maxTurnMinutes", { label: "Longest wait for one reply from Scram's bot before nudging it (minutes)", type: "number", min: 5, max: 120, step: 1, unit: "minutes" }),
        set("autopilot.maxStuckRounds", "maxStuckRounds", { label: "Rounds without progress on a step before a fresh Scram chat (a round counts as progress only when a checklist item is newly verified; after the same number again, the run pauses and asks you what to do)", type: "number", min: 3, max: 100, step: 1, unit: "rounds" }),
        set("autopilot.categoryPagesPerSite", "categoryPagesPerSite", { label: "Screens to explore on each site of a category clone", type: "number", min: 1, max: 50, step: 1, unit: "screens" }),
        set("autopilot.searchQuery", "searchQuery", { label: "Text typed into search boxes while crawling", type: "text", placeholder: "test" }),
        { key: "scram.scramAttachMethod", kind: "readonly", label: "File upload method found to work on your Scram", type: "readonly", value: s.scramAttachMethod || "Not detected yet — found automatically on the first upload" },
        { key: "scram.forgetAttachMethod", kind: "action", label: "Forget it", type: "action", help: "RoboBuild tries every upload method again next time" },
        { key: "extension.devMode", kind: "readonly", label: "Dev mode", type: "readonly", value: extra.devMode ? "On — the toolbar icon opens the full side panel" : "Off — the toolbar icon opens the small popup", help: "Change in the extension" },
      ],
    },
    {
      id: "steps",
      title: "Step files",
      description: "How the build steps given to Scram's AI are written. Applies the next time you generate a handoff.",
      fields: [
        set("steps.detailedSteps", "detailedSteps", { label: "Detailed steps — after planning, each step gets its own pass that spells out every screen, button, field and workflow exactly (where it is, how it looks, what it does, which pipeline runs and why), using the crawled screen specs. Slower to generate and uses more Claude credit, but leaves Scram's AI far less to guess.", type: "toggle" }),
        set("steps.slimContext", "slimContext", { label: "Slim context — after Setup, each step gets a short project summary plus only the tables, screens and styles it uses (the rest already lives in the Scram project). Off = repeat the full context in every step.", type: "toggle" }),
        set("steps.stepSize", "stepSize", { label: "Step size", type: "select", options: [{ value: "standard", label: "Standard — up to 10 checklist items per step (recommended)" }, { value: "small", label: "Small — up to 6 checklist items per step (more, smaller steps)" }] }),
        set("steps.maxStepChars", "maxStepChars", { label: "Split steps longer than (characters)", type: "number", min: 2000, max: 60000, step: 500, unit: "characters", help: "Steps over the size or checklist limit are split automatically into smaller steps when the handoff is generated. If Scram's AI still struggles with a step during the build, Autopilot hands it that step in two halves." }),
      ],
    },
    {
      id: "learned",
      title: "What it has learned about Scram's AI",
      fields: [
        {
          key: "learned.lessons",
          kind: "lessons",
          label: "What it has learned about Scram's AI",
          type: "list",
          help: "When Scram's AI says it can't do something, Autopilot writes a lesson here and never asks for that again. It keeps these across runs. Delete any that are wrong, or add your own.",
          items: extra.lessons.map((l) => ({ id: l.id, text: l.text, meta: [l.source || "added", l.learnedAt ? new Date(l.learnedAt).toLocaleDateString("en-US") : ""].filter(Boolean).join(" · ") })),
          can_add: true,
          can_delete: true,
          can_edit: true,
        },
      ],
    },
    {
      id: "prompts",
      title: "Prompts",
      description: "The system prompts RoboBuild uses, shown in full. Edit one to customise it; Reset to bundled goes back to the prompt that ships with the extension.",
      fields: PROMPTS.map((pr) => {
        const custom = String(extra.prompts[pr.prop] || "");
        const bundled = extra.bundled[pr.prop] || "";
        return { key: pr.key, kind: "prompt", prop: pr.prop, label: pr.label, type: "prompt", value: custom.trim() ? custom : bundled, is_custom: !!custom.trim() && custom !== bundled, default: bundled };
      }).concat([{ key: "prompts.resetToBundled", kind: "action", label: "Use the bundled prompts again", type: "action", danger: true, help: "Clears both overrides" }]),
    },
    {
      id: "data",
      title: "Data & usage",
      placement: "usage",
      fields: [
        {
          key: "data.usage",
          kind: "readonly",
          label: "Extension usage (all time)",
          type: "readonly",
          value: `${(u.calls || 0).toLocaleString("en-US")} calls, ${(u.input || 0).toLocaleString("en-US")} input / ${(u.output || 0).toLocaleString("en-US")} output tokens — about ${u.costEstimated ? "≈" : ""}${formatCost(totalCost(u))} at list prices`,
          stats: { calls: u.calls || 0, inputTokens: u.input || 0, outputTokens: u.output || 0, costUsd: Math.round(totalCost(u) * 100) / 100 },
        },
        { key: "data.resetUsage", kind: "action", label: "Reset usage counter", type: "action", danger: true },
        { key: "data.exportAll", kind: "action", label: "Export all data (JSON)", type: "action", help: "Sent to the site as a download: sites, spec files, step files and build progress" },
        { key: "data.wipeAll", kind: "action", label: "Delete all captured data", type: "action", danger: true, help: "Spec files, handoff/step files, build progress and research briefings. Your API key, settings and what it learned about Scram are kept." },
      ],
    },
  ];
}

const PROMPTS = [
  { key: "prompts.specExtractor", prop: "specExtractor", file: "site-screen-spec-extractor.md", label: "Site Screen Spec Extractor (Job 1 system prompt)" },
  { key: "prompts.handoffSplitter", prop: "handoffSplitter", file: "scram-phased-handoff-splitter.md", label: "Phased Build Handoff Splitter (Job 2 system prompt)" },
];
const bundledCache = {};
async function bundledPrompts() {
  const out = {};
  for (const pr of PROMPTS) {
    bundledCache[pr.prop] ??= await fetch(chrome.runtime.getURL(`prompts/${pr.file}`)).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    out[pr.prop] = bundledCache[pr.prop];
  }
  return out;
}

async function readAll() {
  const got = await chrome.storage.local.get(["apiKey", "promptOverrides", "uiDevMode", "usage"]);
  const settings = await store.getSettings();
  const lessons = await store.getLessons();
  const usage = got.usage || { input: 0, output: 0, calls: 0, cost: 0 };
  return { settings, apiKey: String(got.apiKey || ""), extra: { lessons, prompts: got.promptOverrides || {}, bundled: await bundledPrompts(), devMode: got.uiDevMode === true, usage } };
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
    case "list": {
      if (!v || typeof v !== "object") throw new Error('must be a list operation: {"op":"add"|"delete"|"edit", …}');
      const op = String(v.op || "");
      if (!["add", "delete", "edit"].includes(op)) throw new Error("op must be add, delete or edit");
      const text = typeof v.text === "string" ? v.text.replace(/\s+/g, " ").trim().slice(0, 300) : "";
      if ((op === "add" || op === "edit") && !text) throw new Error("needs text");
      if ((op === "delete" || op === "edit") && !f.items.some((i) => i.id === v.id)) throw new Error(`there's no lesson with id ${v.id}`);
      return { op, id: v.id, text };
    }
    case "prompt":
      if (typeof v !== "string") throw new Error("must be text");
      if (v.length > 300000) throw new Error("is too long");
      return v;
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
      else if (f.kind === "lessons") (lessons ||= []).push(v);
      else if (f.kind === "prompt") prompts[f.prop] = v.trim() === String(f.default || "").trim() ? "" : v; // the bundled text = no override (future updates apply)
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
  if (lessons) {
    // List operations on the lessons: add / delete / edit (one per change, applied in order).
    let list = await store.getLessons();
    for (const o of lessons) {
      if (o.op === "add") list.push({ id: store.uid(), text: o.text, source: "added on the RoboBuild site", learnedAt: new Date().toISOString() });
      else if (o.op === "delete") list = list.filter((l) => l.id !== o.id);
      else if (o.op === "edit") list = list.map((l) => (l.id === o.id ? { ...l, text: o.text } : l));
    }
    await store.set("scramLessons", list.slice(-60));
  }
  return { applied, rejected };
}

// Buttons. Returns a short message for the site.
export async function runAction(key, { wipeAllSites, exportDoc } = {}) {
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
    case "data.exportAll": {
      if (!exportDoc) return { ok: false, message: "Not connected to the RoboBuild site." };
      const all = await chrome.storage.local.get(["sites", "specFiles", "handoffFiles", "buildProgress"]);
      const date = new Date().toISOString().slice(0, 10);
      await exportDoc({ site_key: "robobuild-export", kind: "export", external_id: `export-${new Date().toISOString()}`, title: `RoboBuild export ${date}`, subtitle: "All data (JSON)", step_number: null, content: JSON.stringify(all, null, 2), source_updated_at: new Date().toISOString() });
      return { ok: true, message: `Export sent — “RoboBuild export ${date}” (${(all.specFiles || []).length} spec files, ${(all.handoffFiles || []).length} step/handoff files).` };
    }
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
