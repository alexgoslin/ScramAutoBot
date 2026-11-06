// Autopilot phases 3–4: open Scram, get a project open with the AI chat visible,
// then feed the step files one at a time — reading the Scram bot's replies and
// answering questions / approving plans / pushing for testing, until each step is
// confirmed done. Scram's DOM isn't a public API, so UI navigation is done by a
// small Claude-driven agent that reads the page's controls and picks actions.

import * as store from "./storage.js";
import { openWorkTab } from "./work-window.js";
import { isWebMode } from "./web-mode.js";
import { askJson, keepWarm, loadPrompt, loadScramGuide } from "./jobs.js";
import { dom, sleep, waitForLoad, screenshot } from "./dom.js";
import { PauseError, pauseOptions } from "./errors.js";
import { auditPreview, capturePreview, describeIssues, previewFrameId, previewLinks, navigatePreview, auditFrame, runProbe } from "./ui-audit.js";
import { attachToScram, rememberMethod, ALL_METHODS, realClick, realEnter } from "./scram-attach.js";
import { browserAgent } from "./browser-agent.js";

const SCRAM_URL = store.SCRAM_HOME;

// ------------------------------------------------------------------ tab

// TAB LOCK: Autopilot only ever uses the Scram tab it opened itself (b.tabId), plus a tab that
// tab opens (followNewScramTab). It never picks up your other Scram tabs. If its tab is closed
// or leaves Scram, it pauses; Resume opens a fresh tab and reopens the build's project.
export async function ensureScramTab(ctx) {
  const b = ctx.state.build;
  if (b.tabId != null) {
    const t = await chrome.tabs.get(b.tabId).catch(() => null);
    if (t && store.isScramUrl(t.url)) return b.tabId;
    b.tabId = null;
    b.projectReady = false; // Resume reopens the project (b.projectUrl) in a new tab of our own
    await ctx.save({ build: b });
    throw new PauseError(
      t
        ? "Autopilot's Scram tab navigated away from Scram. It won't use any of your other tabs — press Resume and it will open its own Scram tab again."
        : "Autopilot's Scram tab was closed. It won't use any of your other tabs — press Resume and it will open its own Scram tab again."
    );
  }
  const tab = await openWorkTab(SCRAM_URL); // RoboBuild's own window
  await waitForLoad(tab.id);
  await sleep(3000);
  b.tabId = tab.id;
  b.projectReady = false; // a fresh tab needs the project opened again
  await ctx.save({ build: b });
  await ctx.log("Opened Scram.");
  return tab.id;
}

export async function waitForLogin(ctx, tabId) {
  let warned = false;
  // It carries on by itself as soon as you're logged in. If you aren't after a while it pauses
  // (no error) so the Control Center can show it as needing you; Resume checks again. In web mode
  // that happens after 3 minutes, so the site shows it promptly.
  const deadline = Date.now() + ((await isWebMode()) ? 3 : 30) * 60 * 1000;
  for (;;) {
    ctx.checkStop();
    const snap = await dom(tabId, "snapshot", { maxElements: 40, maxText: 800 }).catch(() => null);
    const loginLike = snap && (snap.hasPassword || /log ?in|sign ?in/i.test(snap.title) || /\/(login|signin|sign-in|auth)\b/i.test(snap.url));
    if (snap && !loginLike) return;
    if (!warned) {
      warned = true;
      await ctx.log("Scram needs you to log in — log in in the Scram tab on this computer and Autopilot will carry on by itself.");
      ctx.notify("Log in to Scram", "Autopilot is waiting for you to log in to Scram in the tab it opened.");
    }
    if (Date.now() > deadline) throw new PauseError("Scram needs you to log in. Log in to Scram in the Scram tab on this computer, then press Resume.");
    await sleep(5000);
  }
}

// ------------------------------------------------------------------ UI agent

const UI_AGENT_SYSTEM = `You operate a web app (Scram, a no-code app builder) on the user's behalf by choosing ONE action at a time. You see the page's URL, title, visible text, open dialogs/menus, and a list of interactive elements with ids.

Actions (return ONLY one JSON object):
{"action":"click","id":"<element id>","reason":"..."}
{"action":"type","id":"<element id>","text":"...","reason":"..."}   (replaces the field's content)
{"action":"key","key":"Enter"|"Escape"|"Tab","id":"<optional element id>","reason":"..."}
{"action":"wait","seconds":<1-20>,"reason":"..."}
{"action":"done","reason":"..."}     (the goal is achieved, as visible on the page now)
{"action":"fail","reason":"..."}     (impossible, or needs the human: login, payment, credentials)

Scram's editor: the normal page view shows the page with "Edit" / "▷ Run" buttons at its top right and a "Frontend …" tab top left. Opening a workflow, data type or other sub-view replaces it with a canvas that has a "‹ Back" button and a breadcrumb at its top left — click "Back" (repeatedly if nested) to return to the page view. "More" (top left) opens the project overview. Never click the section headers in the left column or anything in them — the AI chat's title row (with its plans / + / history / ^ icons) and "Page Structure" with its chevron: they only collapse sections or start new chats (only a goal that explicitly says to start a new chat may use the + there). Never re-open old chats from the chat history list.

Never open workflows, data types or other canvases (e.g. a workflow listed in the right panel's Logic tab, like "Send invites · 5 actions") unless the task is about that workflow — they replace the page view and Run mode; if one opens, click "‹ Back".
Rules: never publish to Live, deploy to production, delete anything, buy/upgrade/change billing, invite people, or change account settings. Pick the most direct path. If a dialog blocks progress, handle it or close it. Don't repeat an action that didn't work — try something else.`;

// The UI agent's instructions, plus the navigation guide written by "Explore Scram" (if any).
async function uiAgentSystem() {
  const guide = await loadPrompt("scramUiGuide", "scram-ui-guide.md").catch(() => "");
  const k = await store.get("scramKnowledge", null);
  return [
    UI_AGENT_SYSTEM,
    guide && `Scram editor guide (built in — trust it):\n${guide}`,
    k?.text && `More notes from your own exploration of Scram:\n${k.text.slice(0, 6000)}`,
  ].filter(Boolean).join("\n\n");
}

// Scram opens projects on editor.buildwithscram.com — sometimes in a NEW tab. If our own tab
// opened a new Scram tab, switch to it (and remember it for the rest of the run). Tabs we
// didn't open (e.g. your own Scram tabs) are never touched.
async function followNewScramTab(ctx, knownIds) {
  const ours = ctx.state.build.tabId;
  const fresh = (await store.scramTabs()).filter((t) => !knownIds.has(t.id) && ours != null && t.openerTabId === ours);
  if (!fresh.length) return null;
  const tab = fresh.find((t) => store.isScramEditorUrl(t.url)) || fresh[0];
  knownIds.add(tab.id);
  if (tab.status === "loading") await waitForLoad(tab.id);
  await chrome.tabs.update(tab.id, { active: true });
  ctx.state.build.tabId = tab.id;
  await ctx.save({ build: ctx.state.build });
  await ctx.log(`Scram opened ${new URL(tab.url).host} in a new tab — following it.`);
  await sleep(2000);
  return tab.id;
}

// The extension's own operator AI (supervisor, UI agent, final review): its own model setting,
// the most capable one by default, thinking hard.
const operator = (ctx) => ({ model: ctx.settings.operatorModel || ctx.settings.model, effort: ctx.settings.operatorEffort || "high" });

// verify: optional async check run when the agent says "done" — if it fails, the agent is told the
// goal isn't met yet and keeps going (it can't just claim success).
export async function uiAgent(ctx, startTabId, goal, opts = {}) {
  // Default: the browser use toolset, the way Claude in Chrome navigates (see browser-agent.js).
  if (ctx.settings?.operatorBrowserTools !== false) return browserUiAgent(ctx, startTabId, goal, opts);
  return classicUiAgent(ctx, startTabId, goal, opts);
}

async function browserUiAgent(ctx, startTabId, goal, { maxSteps = 20, optional = false, verify = null, allowHeader = false } = {}) {
  const knownIds = new Set((await store.scramTabs()).map((t) => t.id));
  const guide = await loadPrompt("scramUiGuide", "scram-ui-guide.md").catch(() => "");
  const k = await store.get("scramKnowledge", null);
  const res = await browserAgent(ctx, ctx.state.build?.tabId || startTabId, goal, {
    maxTurns: Math.max(8, maxSteps) + 4,
    verify,
    allowHeader,
    guide: [guide, k?.text && `More notes from the extension's own exploration of Scram:\n${k.text.slice(0, 6000)}`].filter(Boolean).join("\n\n"),
    getTabId: async () => (await followNewScramTab(ctx, knownIds)) || ctx.state.build?.tabId || null,
  });
  if (res.tabId && ctx.state.build && res.tabId !== ctx.state.build.tabId) {
    ctx.state.build.tabId = res.tabId;
    await ctx.save?.({ build: ctx.state.build });
  }
  if (res.ok) return true;
  if (optional) return false;
  throw new PauseError(`Couldn't do this in Scram: ${goal.split(".")[0]} — ${res.reason}`);
}

async function classicUiAgent(ctx, startTabId, goal, { maxSteps = 20, optional = false, verify = null, allowHeader = false } = {}) {
  const history = [];
  let tabId = startTabId;
  const knownIds = new Set((await store.scramTabs()).map((t) => t.id));
  for (let i = 0; i < maxSteps; i++) {
    ctx.checkStop();
    tabId = (await followNewScramTab(ctx, knownIds)) || ctx.state.build.tabId || tabId;
    const snap = await dom(tabId, "snapshot", { maxElements: 220, maxText: 2500, pointer: true });
    const lines = snap.elements.map((e) =>
      [e.id, e.role || e.tag, JSON.stringify(e.label || ""), e.box ? `at x=${e.box[0]},y=${e.box[1]} ${e.box[2]}×${e.box[3]}` : "", e.editable ? "editable" : "", e.disabled ? "disabled" : "", e.inLayer ? "in-dialog" : "", e.href ? `href=${e.href}` : "", e.header ? (allowHeader ? "chat/section title row" : "BLOCKED(section header — don't click)") : ""].filter(Boolean).join(" | ")
    );
    // A screenshot of what's actually on screen, so it can reason about where it is.
    const shot = await screenshot(tabId, 1280).catch(() => null);
    const userContent = `GOAL: ${goal}

Actions so far:
${history.map((h, n) => `${n + 1}. ${h}`).join("\n") || "(none)"}

URL: ${snap.url}
Title: ${snap.title}
Open dialogs/menus: ${snap.layers.map((l) => `[${l.role}] ${l.text.slice(0, 400)}`).join(" || ") || "(none)"}

Visible text (start):
${snap.text}

Interactive elements (id | role | label | position in CSS px | flags):
${lines.join("\n")}${shot ? "\n\nA screenshot of the Scram tab right now is attached: look at it to work out where you are and what's in the way." : ""}`;
    const content = shot ? [{ type: "text", text: userContent }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot } }] : userContent;
    const act = await askJson({ what: "Scram UI agent", system: await uiAgentSystem(), userContent: content, maxTokens: 4000, ...operator(ctx) });
    const target = snap.elements.find((e) => e.id === act.id);
    const desc = `${act.action}${target ? ` "${target.label}"` : ""}${act.text ? ` ← "${String(act.text).slice(0, 60)}"` : ""}${act.key ? ` ${act.key}` : ""} — ${act.reason || ""}`;
    history.push(desc);
    await ctx.log(`Scram UI: ${desc}`);

    if (act.action === "done") {
      if (!verify || (await verify().catch(() => false))) return true;
      history[history.length - 1] += " — NOT DONE YET: checked the screen and the goal isn't met; look again and keep going";
      continue;
    }
    if (act.action === "fail") {
      if (optional) return false;
      throw new PauseError(`Couldn't do this in Scram: ${goal.split(".")[0]} — ${act.reason}`);
    }
    // Real (trusted) clicks: many of Scram's controls ignore script clicks.
    if (act.action === "click" && target?.header && !allowHeader) {
      history[history.length - 1] += " — refused: section-header controls are never clicked";
    } else if (act.action === "click" && target) await realClick(tabId, { id: target.id, label: target.label }).catch(() => dom(tabId, "click", { id: target.id, label: target.label, role: target.role }));
    else if (act.action === "type" && target) await dom(tabId, "typeText", { id: target.id, label: target.label, role: target.role }, String(act.text ?? ""));
    else if (act.action === "key") await dom(tabId, "pressKey", act.key || "Enter", target ? { id: target.id, label: target.label, role: target.role } : undefined);
    else if (act.action === "wait") await sleep(Math.min(20, Math.max(1, Number(act.seconds) || 3)) * 1000);
    await sleep(1500);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading") await waitForLoad(tabId);
    await followNewScramTab(ctx, knownIds);
  }
  if (optional) return false;
  throw new PauseError(`Couldn't finish in Scram after ${maxSteps} actions: ${goal.split(".")[0]}`);
}

// ------------------------------------------------------------------ setup

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Wait until the build tab (or a tab Scram just opened) is inside a project editor with its chat box.
async function waitForEditor(ctx, knownIds, ms) {
  const end = Date.now() + ms;
  let said = false;
  while (Date.now() < end) {
    ctx.checkStop();
    await followNewScramTab(ctx, knownIds);
    const tabId = ctx.state.build.tabId;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && store.isScramEditorUrl(tab.url)) {
      if (tab.status === "loading") await waitForLoad(tabId);
      if (await dom(tabId, "findChatInput").catch(() => null)) return tabId;
    }
    if (!said && Date.now() > end - ms + 15000) {
      said = true;
      await ctx.log("Waiting for Scram to finish creating the project and open its editor…");
    }
    await sleep(2000);
  }
  return null;
}

// Get the build's project open in the editor. Reopens it if we made it before; otherwise
// clicks the dashboard's "Create new project" card (NOT the "What shall we build today?" box,
// which would start a project from a prompt) and waits for Scram to open the new editor.
export async function openOrCreateProject(ctx, name) {
  const b = ctx.state.build;
  const knownIds = new Set((await store.scramTabs()).map((t) => t.id));
  let tab = await chrome.tabs.get(b.tabId);
  if (store.isScramEditorUrl(tab.url) && b.projectUrl && tab.url.split("/page/")[0] === b.projectUrl.split("/page/")[0]) return;

  if (b.projectUrl) {
    await ctx.log(`Reopening the Scram project “${name}”…`);
    await chrome.tabs.update(b.tabId, { url: b.projectUrl, active: true });
    await waitForLoad(b.tabId);
    if (await waitForEditor(ctx, knownIds, 60000)) return;
  }

  // On the dashboard (project list).
  tab = await chrome.tabs.get(b.tabId);
  if (store.isScramEditorUrl(tab.url) || !store.isScramUrl(tab.url)) {
    await chrome.tabs.update(b.tabId, { url: SCRAM_URL, active: true });
    await waitForLoad(b.tabId);
    await sleep(3000);
  }
  let card = null;
  for (let i = 0; i < 10 && !card; i++) {
    card = (await dom(b.tabId, "findText", "create (a )?new project").catch(() => []))[0] || null;
    if (!card) await sleep(1500);
  }
  if (!card) throw new PauseError("Couldn't find Scram's “Create new project” button on the project list.");
  await ctx.log("Creating a new Scram project (clicking “Create new project”)…");
  await realClick(b.tabId, { id: card.id, label: card.label }).catch(() => dom(b.tabId, "click", { id: card.id, label: card.label }));
  // Scram takes ~20s to create the project, then opens its editor by itself.
  const tabId = await waitForEditor(ctx, knownIds, 150000);
  if (!tabId) throw new PauseError("Clicked “Create new project”, but Scram didn't open the new project's editor within 2½ minutes. Open it yourself, then press Resume.");
  b.projectUrl = (await chrome.tabs.get(tabId)).url;
  b.projectNamed = false;
  await ctx.save({ build: b });
  await ctx.log("New Scram project is open.");
}

// Rename the project: "More" (top left) → click the project name above "Describe your project…"
// → type the new name. Then go back to the Frontend view (where the chat, page and Run toggle are).
export async function renameProject(ctx, tabId, name) {
  const title = (await chrome.tabs.get(tabId)).title || "";
  if (new RegExp(`^${escapeRe(name)}\\b`, "i").test(title)) return true;
  await ctx.log(`Renaming the project to “${name}” (More → project name)…`);
  let ok = false;
  // The "Plans" panel can cover the project name — close it first.
  if (await closePlansPanel(ctx, tabId)) await sleep(500);
  try {
    const more = (await dom(tabId, "findText", "^more$", { maxLen: 10 }))[0];
    if (more) {
      await realClick(tabId, { id: more.id, label: more.label });
      await sleep(2000);
      await dom(tabId, "pressKey", "Escape").catch(() => {}); // "More" also pops open the section menu
      await sleep(400);
      const nameEl = await dom(tabId, "projectNameTarget");
      if (nameEl) {
        await realClick(tabId, { id: nameEl.id, label: nameEl.label });
        await sleep(1000);
        let typed = await dom(tabId, "typeActive", name);
        if (!typed?.ok) {
          // Clicking may have swapped the name for an input that isn't focused yet.
          const snap = await dom(tabId, "snapshot", { maxElements: 200, maxText: 0 });
          const field = snap.elements.find((e) => e.editable && !/ask claude|describe your project/i.test(e.label || "") && (e.label || "").trim() === nameEl.text);
          if (field) typed = await dom(tabId, "typeText", { id: field.id, label: field.label, role: field.role }, name);
        }
        if (typed?.ok) {
          await dom(tabId, "pressKey", "Enter").catch(() => {});
          await sleep(1500);
          const now = await dom(tabId, "projectNameTarget").catch(() => null);
          ok = now?.text === name || new RegExp(`^${escapeRe(name)}\\b`, "i").test((await chrome.tabs.get(tabId)).title || "");
        }
      }
    }
  } catch {
    /* fall through to the UI agent */
  }
  if (!ok) {
    ok = await uiAgent(
      ctx,
      tabId,
      `Rename this Scram project to "${name}". How: click "More" in the top-left toolbar; the project overview shows the project's current name as a big heading above "Describe your project to start building..."; click that name, replace it with "${name}", and press Enter. Don't change the description, don't type in the chat, and don't create anything. Finish with done once the heading shows "${name}".`,
      { maxSteps: 10, optional: true }
    );
  }
  await ctx.log(ok ? `Project renamed to “${name}”.` : `Couldn't rename the project — it keeps Scram's default name (you can rename it via More → the name).`);
  // Back to the page view (the frontend tab next to "More").
  await clickFrontendTab(tabId);
  return ok;
}

export async function setup(ctx) {
  const b = ctx.state.build;
  await ensureScramTab(ctx);
  await waitForLogin(ctx, b.tabId);

  if (!b.projectReady) {
    const name = b.appName || "Cloned App";
    await openOrCreateProject(ctx, name);
    if (!b.projectNamed) {
      await renameProject(ctx, b.tabId, name);
      b.projectNamed = true;
      await ctx.save({ build: b });
    }
    if (!(await dom(b.tabId, "findChatInput"))) await showEditorHome(ctx, b.tabId);
    if (!(await dom(b.tabId, "findChatInput"))) {
      await uiAgent(ctx, b.tabId, "Open the AI chat panel (the \"Chat\" panel on the left of the project editor) so its \"Ask Claude...\" message box is visible. Do not type or send anything.", { maxSteps: 8 });
    }
    b.projectReady = true;
    await ctx.save({ build: b });
  }
  await ensureRunMode(ctx, b.tabId).catch(() => {});

  if (!b.modelChecked) {
    // Scram guide: run the bot on Claude Sonnet with low thinking — other options are too expensive.
    await uiAgent(
      ctx,
      b.tabId,
      "In the AI chat panel, if there is a model and/or thinking-level selector, set the model to a Claude Sonnet model and the thinking level to low. If it is already set that way, or there is no such selector, or you cannot find it within a few actions, finish with done. Do not send any message.",
      { maxSteps: 8, optional: true }
    );
    b.modelChecked = true;
    await ctx.save({ build: b });
  }
}

// ------------------------------------------------------------------ chat I/O

const norm = (t) => (t || "").replace(/\d+/g, "#");

// Lines in `after` beyond those already in `before` (counted, so a line the bot
// repeats verbatim still shows up as new), minus the message we sent ourselves.
function newLines(before, after, exclude = "") {
  const count = new Map();
  for (const l of (before || "").split("\n")) {
    const t = l.trim();
    if (t) count.set(t, (count.get(t) || 0) + 1);
  }
  const excl = new Set(exclude.split("\n").map((l) => l.trim()).filter((l) => l.length > 3));
  const out = [];
  for (const l of after.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    const n = count.get(t) || 0;
    if (n > 0) count.set(t, n - 1);
    else if (!excl.has(t)) out.push(t);
  }
  return out.join("\n");
}

// Only ever type into a project editor's AI chat — never the dashboard's "What shall we build
// today?" box (that would start a whole new project from our message).
async function assertInEditor(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !store.isScramEditorUrl(tab.url)) {
    throw new PauseError(`Not sending anything: the Scram tab isn't inside a project editor (it's on ${tab ? new URL(tab.url).host + new URL(tab.url).pathname : "a closed tab"}). Open the project, then press Resume.`);
  }
}

// Messages longer than this go to Scram's AI as an attached .md file with a one-line message.
export const LONG_MESSAGE = 1500;

export async function sendMessage(ctx, tabId, text, { allowAttach = true, pointerFor = null } = {}) {
  await assertInEditor(tabId);
  const fixed = stripRunAsks(text);
  if (fixed.changed) {
    await ensureRunMode(ctx, tabId, { force: true }).catch(() => {});
    text = `${RUN_ON_NOTE} ${fixed.text}`;
    await ctx.log("Removed a request for Scram's AI to open Run mode from the message (only the extension can) — switched Run on myself instead.");
  }
  if (!(await dom(tabId, "findChatInput"))) await showEditorHome(ctx, tabId);
  let inputId = await dom(tabId, "findChatInput");
  if (!inputId) {
    await uiAgent(ctx, tabId, "Open the AI chat panel (the \"Chat\" panel on the left of the project editor) so its \"Ask Claude...\" message box is visible. Do not send anything.", { maxSteps: 8 });
    tabId = ctx.state.build.tabId || tabId;
    inputId = await dom(tabId, "findChatInput");
    if (!inputId) {
      const form = await dom(tabId, "awaitingUser").catch(() => "");
      throw new PauseError(`Couldn't find Scram's AI chat box${form ? ` — Scram is showing a question (${form}); its chat box usually comes back once that's answered` : ""}. Answer it in the Scram tab, then press Resume.`);
    }
  }
  // Long messages are attached as a .md file (typing thousands of characters is slow and fragile).
  if (allowAttach && text.length > LONG_MESSAGE && (await sendAsFile(ctx, tabId, text))) return;
  let typed = await dom(tabId, "typeChat", inputId, text);
  if (!typed?.ok) {
    // The whole text didn't get into the box (e.g. only its first line): never send part of it.
    await dom(tabId, "typeText", inputId, "").catch(() => {});
    const form = await dom(tabId, "awaitingUser").catch(() => "");
    const why = `the chat box took ${typed?.got ?? 0} of ${typed?.want ?? text.length} characters${form ? ` (Scram is showing a question: ${form})` : ""}`;
    if (pointerFor) {
      // The note that goes with an attached file: the file alone is the message — send it as it is.
      await ctx.log(`⚠️ Couldn't type the note for ${pointerFor} (${why}) — sending the attached file on its own.`);
      await sendComposer(tabId, inputId);
      return;
    }
    if (allowAttach && (await sendAsFile(ctx, tabId, text, why))) return;
    // Last resort: the same text on one line (nothing in it can act as Enter).
    const flat = text.replace(/\s*\n\s*/g, " / ").replace(/\s{2,}/g, " ").trim();
    typed = flat !== text ? await dom(tabId, "typeChat", inputId, flat) : typed;
    if (!typed?.ok) throw new PauseError(`Couldn't type into Scram's AI chat box: ${why}. Check the Scram tab (answer any question the bot is showing), then press Resume.`);
    await ctx.log("⚠️ Scram's chat box didn't take the multi-line message — sent it on one line instead.");
    text = flat;
  }
  await sleep(700);

  const stillThere = async () => {
    const v = await dom(tabId, "inputValue", inputId);
    const sq = (t) => String(t || "").replace(/\s+/g, " ").trim();
    return v != null && sq(v).length > 0 && sq(text).startsWith(sq(v).slice(0, 40));
  };
  // Escalate until the box empties: script click on send → script Enter → real click on
  // send → real Enter key (via DevTools) → let the UI agent find a way.
  const sendId = await dom(tabId, "findSendButton", inputId);
  const attempts = [
    ["click send", () => sendId && dom(tabId, "click", sendId)],
    ["Enter", () => dom(tabId, "pressKey", "Enter", inputId)],
    ["real click on send", () => sendId && realClick(tabId, { id: sendId })],
    ["real Enter key", () => realEnter(tabId, { id: inputId })],
  ];
  for (const [, attempt] of attempts) {
    if (!(await stillThere())) break;
    await Promise.resolve(attempt()).catch(() => {});
    await sleep(1500);
  }
  if (await stillThere()) {
    await uiAgent(ctx, tabId, "A message is already typed in the AI chat input. Send it (click the chat's send button). Do not change the text.", { maxSteps: 4 });
  }
  await dom(tabId, "scrollChatToBottom").catch(() => {});
  // Remembered so the supervisor can't send the same request twice in a step (loop guard).
  const bs = ctx.state.build;
  if (bs) bs.sentMessages = [...(bs.sentMessages || []), String(text).slice(0, 1500)].slice(-10);
}

// Press the chat's send control (an attached file with no text): send button, else Enter.
async function sendComposer(tabId, inputId) {
  const sendId = await dom(tabId, "findSendButton", inputId).catch(() => null);
  if (sendId) await realClick(tabId, { id: sendId }).catch(() => dom(tabId, "click", sendId));
  else await realEnter(tabId, { id: inputId }).catch(() => dom(tabId, "pressKey", "Enter", inputId));
  await sleep(1500);
}

// A long message as an attached .md file plus a one-line pointer. False if attaching failed.
async function sendAsFile(ctx, tabId, text, why = "") {
  const name = `robobuild-message-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.md`;
  const preferred = ctx.settings.scramAttachMethod || null;
  const res = await attachToScram(tabId, name, text, preferred ? { only: [preferred, ...ALL_METHODS.filter((m) => m !== preferred)] } : {}).catch(() => ({ ok: false }));
  if (!res.ok) return false;
  await ctx.log(`Sent a ${text.length.toLocaleString("en-US")}-character message to Scram's AI as an attached file (${name})${why ? ` — ${why}` : ""}.`);
  await sendMessage(ctx, tabId, `Attached: ${name} — my full message to you. Read all of it and follow it.`, { allowAttach: false, pointerFor: name });
  const bs = ctx.state.build;
  if (bs) bs.sentMessages = [...(bs.sentMessages || []), String(text).slice(0, 1500)].slice(-10);
  return true;
}

// Wait until Scram's bot has finished replying. Watches only the CHAT PANEL (other parts of
// Scram's page — preview, status indicators — keep changing and would make it wait forever),
// and returns quickly when Scram is visibly waiting on us (Approve plan, answer options…).
// While waiting: if the tab is on a page in Edit mode (no preview=run) after Run was switched on
// for this build, switch it back to Run. At most once every 30s (dry runs never set wantRun).
// The place the build should always be: the page view with the running app (Run preview) on
// screen. Scram's AI often opens other screens while it works — a workflow canvas ("‹ Back" +
// breadcrumb), a data type, the Overview — where there's no preview. Get back by itself:
// Escape → "‹ Back" (up to 3 levels) → Run on → the last page address where Run was showing.
// Remembers that address (b.runUrl) whenever the Run preview is visible.
const onRunView = async (tabId) => {
  const pf = await dom(tabId, "previewFrame").catch(() => null);
  if (pf && pf.rect.w > 200 && pf.rect.h > 150) return pf;
  // No embedded preview found: the page view still shows Scram's Edit/Run toggle, while a
  // workflow / data canvas shows "‹ Back" and no toggle.
  const toggle = await dom(tabId, "modeToggle").catch(() => null);
  const back = toggle ? await dom(tabId, "backTarget").catch(() => null) : null;
  return toggle && !back ? { toggle } : null;
};
async function rememberRunUrl(ctx, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && /\/page\//.test(tab.url || "") && /[?&]preview=run\b/.test(tab.url) && ctx.state.build) ctx.state.build.runUrl = tab.url;
}
const RUN_VIEW_GOAL = `Get Scram's editor back to the PAGE VIEW with the RUNNING APP in RUN MODE. That means: the AI chat on the left, the Edit / ▷ Run toggle at the top right of the canvas with Run selected, and the running app showing in the middle. Look at the screenshot to work out where you are first. Typical ways back: Escape to close a menu or dialog; "‹ Back" (top left) on a workflow, data or component canvas; close a panel covering the canvas (its × or ✕); the frontend tab in the top bar → pick a page in its page list (not "Add Page"); then click "▷ Run". Don't open workflows, don't type in the AI chat, don't publish or delete anything. Choose "done" only when Run is on and the running app is visible.`;

export async function ensureRunView(ctx, tabId) {
  if (await onRunView(tabId)) {
    await rememberRunUrl(ctx, tabId);
    return true;
  }
  const b = ctx.state.build || {};
  await ctx.log("Not on the page view with the running app (e.g. Scram's AI opened a workflow canvas) — going back to Run mode…");
  await dom(tabId, "pressKey", "Escape").catch(() => {});
  await sleep(400);
  for (let i = 0; i < 3 && !(await onRunView(tabId)); i++) {
    const back = await dom(tabId, "backTarget").catch(() => null);
    if (!back) break;
    await realClick(tabId, { id: back.id, label: back.label }).catch(() => dom(tabId, "click", { id: back.id, label: back.label }));
    await sleep(1800);
  }
  if (!(await dom(tabId, "findChatInput").catch(() => null))) await showEditorHome(ctx, tabId).catch(() => {});
  await ensureRunMode(ctx, tabId, { force: true }).catch(() => {});
  if (!(await onRunView(tabId)) && Date.now() - (b.aiNavAt || 0) > 180000) {
    // The usual moves didn't work: let the operator AI look at the screen and find its own way
    // (at most every 3 minutes, so a screen it can't recognise doesn't eat Claude credit).
    b.aiNavAt = Date.now();
    await ctx.log("The usual way back didn't work — looking at the screen to find my own way back to Run mode…");
    await uiAgent(ctx, tabId, RUN_VIEW_GOAL, { maxSteps: 8, optional: true, verify: async () => !!(await onRunView(tabId)) }).catch(() => false);
  }
  if (!(await onRunView(tabId))) {
    // Last resort: open the page where Run mode was last showing (or the project's page) directly.
    const fallback = b.runUrl || (b.projectUrl && /\/page\//.test(b.projectUrl) ? b.projectUrl : null);
    if (fallback) {
      const u = new URL(fallback);
      u.searchParams.set("preview", "run");
      await chrome.tabs.update(tabId, { url: u.href });
      await waitForLoad(tabId).catch(() => {});
      await sleep(4000);
      await ctx.log("Opened the page with Run mode on directly (its address) to get back to the running app.");
    }
  }
  await dom(tabId, "scrollChatToBottom").catch(() => {});
  const ok = !!(await onRunView(tabId));
  if (ok) {
    await rememberRunUrl(ctx, tabId);
    await ctx.log("Back on the page view with the running app in Run mode.");
  } else await ctx.log("Couldn't get back to the running app on my own yet — I'll keep trying.");
  return ok;
}

async function keepRunMode(ctx, tabId) {
  const b = ctx.state.build;
  if (!b?.wantRun) return; // set once the extension has put Run on for this build
  if (Date.now() - (b.runRestoredAt || 0) < 30000) return;
  // Off the page view altogether (workflow canvas, Overview…): go back to the running app.
  if (!(await onRunView(tabId))) {
    b.runRestoredAt = Date.now();
    await ensureRunView(ctx, tabId);
    return;
  }
  await rememberRunUrl(ctx, tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/\/page\//.test(tab.url || "")) return;
  const inRun = /[?&]preview=run\b/.test(tab.url) || (await dom(tabId, "modeToggle").catch(() => null))?.active === true;
  if (!inRun) {
    b.runRestoredAt = Date.now();
    await ctx.log("Scram dropped back to Edit mode while its AI was working — switching Run mode back on.");
    await ensureRunMode(ctx, tabId, { force: true });
    await dom(tabId, "scrollChatToBottom").catch(() => {});
    return;
  }
  // In Run mode: keep the running app in view (e.g. the Plans panel opened over it).
  const pf = await dom(tabId, "previewFrame").catch(() => null);
  if (pf && pf.covered >= 0.4) {
    b.runRestoredAt = Date.now();
    // (each of these logs what it closed)
    if (!(await closePlansPanel(ctx, tabId).catch(() => false))) await closeKnownPanels(ctx, tabId).catch(() => false);
  }
}

// Look at the running app like a human would: make sure the Run preview is on and uncovered,
// then take a screenshot of it and run the automatic layout check inside it.
export async function inspectRun(ctx, tabId) {
  await ensureRunMode(ctx, tabId).catch(() => {});
  let pf = await dom(tabId, "previewFrame").catch(() => null);
  if (pf && pf.covered >= 0.3) {
    await closePlansPanel(ctx, tabId).catch(() => {});
    await closeKnownPanels(ctx, tabId).catch(() => {});
    await sleep(800);
    pf = await dom(tabId, "previewFrame").catch(() => null);
  }
  if (!pf) return null;
  const audit = await auditPreview(tabId, pf).catch(() => null);
  const image = await capturePreview(tabId, pf).catch(() => null);
  await dom(tabId, "scrollChatToBottom").catch(() => {});
  return { audit, image, covered: pf.covered >= 0.3 ? pf.coverLabel || "something" : "", size: await previewSizeNow(tabId).catch(() => null) };
}


async function waitForIdle(ctx, tabId, baseline) {
  const epochAtStart = ctx.state.build?.steerEpoch || 0;
  const s = ctx.settings;
  const start = Date.now();
  // Watch the whole page AND the chat panel. The page is the main signal, but some parts of
  // Scram (preview, status text) can keep changing forever, so once the chat itself has been
  // quiet for a while we stop waiting on the rest of the page after a grace period.
  const startChat = norm((await dom(tabId, "chatText").catch(() => "")) || "");
  const startPage = norm((await dom(tabId, "bodyText").catch(() => "")) || "");
  let lastChat = null;
  let lastPage = null;
  let chatStableSince = Date.now();
  let pageStableSince = Date.now();
  // Scram may already have replied between our last action and now — count that as new output.
  let changed = !!baseline && norm(baseline) !== startPage;
  let lastReport = Date.now();
  let announced = "";
  let lastRunCheck = Date.now();
  let sawGenerating = false;
  for (;;) {
    ctx.checkStop();
    await sleep(3000);
    // The supervisor's prompt cache would expire while the bot works: keep it warm.
    await keepWarmIfDue(ctx).catch(() => {});
    // Keep Scram's chat on its newest message (it stops following new output when scrolled up).
    await dom(tabId, "scrollChatToBottom").catch(() => {});
    // Scram can drop back to Edit while its AI works (e.g. it opens a page's settings). Its AI
    // can't switch back and can't test in Edit, so put Run back on as soon as we notice.
    if (Date.now() - lastRunCheck > 15000) {
      lastRunCheck = Date.now();
      await keepRunMode(ctx, tabId).catch(() => {});
    }
    const chat = norm((await dom(tabId, "chatText").catch(() => "")) || "");
    const pageText = (await dom(tabId, "bodyText").catch(() => "")) || "";
    const page = norm(pageText);
    const generating = await dom(tabId, "isGenerating").catch(() => false);
    if (generating) sawGenerating = true;
    const reason = generating ? "" : (await dom(tabId, "awaitingUser").catch(() => "")) || "";
    // A question in the chat only counts once the chat has changed (so our own message doesn't trigger it);
    // an Approve / answer button on screen always counts.
    const waitingOnUs = reason && (reason.startsWith("“") || chat !== startChat) ? reason : "";
    if (chat !== startChat || page !== startPage || waitingOnUs) changed = true;
    if (chat !== lastChat || generating) {
      lastChat = chat;
      chatStableSince = Date.now();
    }
    if (page !== lastPage || generating) {
      lastPage = page;
      pageStableSince = Date.now();
    }
    const chatQuiet = (Date.now() - chatStableSince) / 1000;
    const pageQuiet = (Date.now() - pageStableSince) / 1000;
    const done = () => ({ text: pageText, timedOut: false, quietMs: Date.now() - chatStableSince });
    // You sent Autopilot a message: stop waiting and let the supervisor act on it now.
    if ((ctx.state.notes || []).some((n) => !n.seen)) return done();
    // Steered from the chat to another step (skip / jump / redo / insert): stop waiting.
    if ((ctx.state.build?.steerEpoch || 0) !== epochAtStart) return done();
    if (Date.now() - lastReport > 60000) {
      lastReport = Date.now();
      await ctx.log(`Still waiting for Scram's bot — ${Math.round((Date.now() - start) / 1000)}s so far; ${generating ? "it's still generating" : changed ? `chat quiet ${Math.round(chatQuiet)}s, page quiet ${Math.round(pageQuiet)}s` : "no reply yet"}.`);
    }
    // Scram is waiting for a plan approval / an answer: act as soon as the chat settles briefly.
    if (waitingOnUs && chatQuiet >= Math.min(6, s.scramIdleSeconds)) {
      if (waitingOnUs !== announced) await ctx.log(`Scram is waiting on us — ${waitingOnUs}.`);
      announced = waitingOnUs;
      return done();
    }
    if (!changed) {
      if (Date.now() - start > 120000) return { text: pageText, timedOut: true }; // nothing happened at all
      if (Date.now() - start > s.maxTurnMinutes * 60000) return { text: pageText, timedOut: true };
      continue;
    }
    // Fast finish: we saw Scram's AI working (its Stop control) and it has stopped — the reply is
    // complete, so act after a few quiet seconds instead of waiting for the whole page to settle.
    if (sawGenerating && !generating && chatQuiet >= 6) return done();
    // Normal finish: the whole page (chat included) has gone quiet.
    if (chatQuiet >= s.scramIdleSeconds && pageQuiet >= s.scramIdleSeconds) return done();
    // The chat is done but the page keeps changing (in Run mode the running app always does) —
    // the chat is what matters, so don't wait much longer on the rest.
    if (!generating && chatQuiet >= s.scramIdleSeconds + 10) return done();
    if (Date.now() - start > s.maxTurnMinutes * 60000) return { text: pageText, timedOut: true };
  }
}

// Close Scram's "Plans" panel (its × is an unlabeled icon) with a real click. True if it closed.
export async function closePlansPanel(ctx, tabId) {
  for (let i = 0; i < 2; i++) {
    const x = await dom(tabId, "panelCloseTarget", "^plans$").catch(() => null);
    if (!x) return i > 0;
    await realClick(tabId, { id: x.id, label: x.label }).catch(() => dom(tabId, "click", { id: x.id, label: x.label }));
    await sleep(900);
    if (!(await dom(tabId, "panelCloseTarget", "^plans$").catch(() => null))) {
      await ctx?.log?.("Closed Scram's Plans panel (it was in the way).");
      return true;
    }
  }
  return false;
}

// Click the editor's frontend tab (next to "More"), which shows the page view and the AI chat.
async function clickFrontendTab(tabId) {
  const fe =
    (await dom(tabId, "frontendTab").catch(() => null)) ||
    (await dom(tabId, "findText", "^frontend\\b", { maxLen: 30 }).catch(() => []))[0];
  if (!fe) return null;
  await realClick(tabId, { id: fe.id, label: fe.label }).catch(() => dom(tabId, "click", { id: fe.id, label: fe.label }));
  await sleep(1800);
  return fe.text || fe.label || "frontend tab";
}

// Re-open a collapsed AI chat section (clicking its header chevron again). If a click doesn't
// bring the chat box back, it's undone so nothing else is left toggled.
async function expandChat(ctx, tabId) {
  for (let i = 0; i < 2; i++) {
    const t = await dom(tabId, "chatExpandTarget").catch(() => null);
    if (!t) return false;
    await realClick(tabId, { id: t.id, label: t.label }).catch(() => dom(tabId, "click", { id: t.id, label: t.label }));
    await sleep(1000);
    if (await dom(tabId, "findChatInput").catch(() => null)) {
      await ctx.log("Scram's AI chat was collapsed — expanded it again.");
      return true;
    }
    if (t.how === "header chevron") {
      await realClick(tabId, { id: t.id, label: t.label }).catch(() => {}); // undo
      await sleep(600);
      return false;
    }
  }
  return false;
}

// Close things that cover the editor (from the Scram exploration): the History panel, the theme
// panel, the Run-mode Activity panel, and Warnings/Errors dialogs (those close by clicking their
// own button again — Escape doesn't).
export async function closeKnownPanels(ctx, tabId) {
  // pointer: the warnings/errors buttons are plain clickable divs, not real buttons
  const snap = await dom(tabId, "snapshot", { maxElements: 300, maxText: 3000, pointer: true }).catch(() => null);
  if (!snap) return 0;
  let n = 0;
  const click = async (e) => {
    await realClick(tabId, { id: e.id, label: e.label }).catch(() => dom(tabId, "click", { id: e.id, label: e.label }));
    await sleep(700);
    n++;
  };
  for (const e of snap.elements.filter((e) => /^(close history|close theme panel)$/i.test((e.label || "").trim()))) await click(e);
  for (const l of snap.layers.filter((l) => /^(warnings|errors)\b/i.test(l.text || ""))) {
    const btn = snap.elements.find((e) => (e.label || "").toLowerCase() === (/^warnings/i.test(l.text) ? "warnings-button" : "errors-button"));
    if (btn) await click(btn);
  }
  if (/\bActivity\b/.test(snap.text || "")) {
    const x = (await dom(tabId, "panelCloseTarget", "^activity$").catch(() => null)) || snap.elements.find((e) => /^[✕×]$/.test((e.label || "").trim()));
    if (x) await click(x);
  }
  if (n) await ctx?.log?.(`Closed ${n} Scram panel(s)/dialog(s) that were in the way.`);
  return n;
}

// On Configure Frontend (or anywhere without a page open): open the page list and pick a page.
export async function goToPage(ctx, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || /\/page\//.test(tab.url) || !store.isScramEditorUrl(tab.url)) return false;
  const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 }).catch(() => null);
  const picker = snap?.elements.find((e) => /^current page:/i.test(e.label || ""));
  if (!picker) return false;
  await realClick(tabId, { id: picker.id, label: picker.label }).catch(() => {});
  await sleep(900);
  const page = (await dom(tabId, "findText", "^\\S.{0,60}\\s/\\S*$", { maxLen: 70 }).catch(() => [])).find((d) => !/^current page/i.test(d.text || ""));
  if (!page) {
    await dom(tabId, "pressKey", "Escape").catch(() => {});
    return false;
  }
  await realClick(tabId, { id: page.id, label: page.label }).catch(() => {});
  await sleep(2000);
  const ok = /\/page\//.test((await chrome.tabs.get(tabId)).url);
  if (ok) await ctx?.log?.(`Opened the page “${page.text}” from Scram's page list (was on the frontend settings).`);
  return ok;
}

// Get back to the editor's page view with the AI chat visible: Escape any dialog, leave
// sub-views (Back), or click the frontend tab (e.g. from More → Overview).
export async function showEditorHome(ctx, tabId) {
  if (await dom(tabId, "findChatInput").catch(() => null)) return true;
  // The AI chat section may just be collapsed (the ^ chevron on its header): open it again.
  if (await expandChat(ctx, tabId)) return true;
  await dom(tabId, "pressKey", "Escape").catch(() => {});
  await sleep(500);
  if (await dom(tabId, "findChatInput").catch(() => null)) return true;
  if (await closeKnownPanels(ctx, tabId)) {
    if (await dom(tabId, "findChatInput").catch(() => null)) return true;
  }
  for (let i = 0; i < 3; i++) {
    const back = await dom(tabId, "backTarget").catch(() => null);
    if (!back) break;
    await realClick(tabId, { id: back.id, label: back.label }).catch(() => {});
    await sleep(1500);
    if (await dom(tabId, "findChatInput").catch(() => null)) {
      await ctx.log("Clicked “Back” to get back to the page view with the AI chat.");
      return true;
    }
  }
  const name = await clickFrontendTab(tabId);
  if (name) await goToPage(ctx, tabId).catch(() => {}); // the tab can land on Configure Frontend
  if (name && (await dom(tabId, "findChatInput").catch(() => null))) {
    await ctx.log(`Clicked the “${name}” tab to get back to the page view with the AI chat.`);
    return true;
  }
  return false;
}

// Find the Edit / Run toggle, getting out of whatever is hiding it first: the "Plans" panel
// covering the toolbar, or a sub-view such as a workflow canvas (only "‹ Back" is shown
// there) — click Back (up to 3 levels), then fall back to the "Frontend" tab.
async function findModeToggle(ctx, tabId) {
  const visible = async () => {
    const t = await dom(tabId, "modeToggle").catch(() => null);
    if (!t) return null;
    const c = await dom(tabId, "centerOf", { id: t.id }).catch(() => null);
    return c?.covered ? null : t;
  };
  let t = await visible();
  if (t) return t;
  if (await closePlansPanel(ctx, tabId)) {
    await sleep(1200);
    if ((t = await visible())) return t;
  }
  if (await closeKnownPanels(ctx, tabId)) {
    if ((t = await visible())) return t;
  }
  if (await goToPage(ctx, tabId)) {
    if ((t = await visible())) return t;
  }
  for (let i = 0; i < 3; i++) {
    const back = await dom(tabId, "backTarget").catch(() => null);
    if (!back) break;
    await realClick(tabId, { id: back.id, label: back.label }).catch(() => dom(tabId, "click", { id: back.id, label: back.label }));
    await sleep(1500);
    if ((t = await visible())) {
      await ctx.log(`Left a sub-view of Scram's editor (clicked “Back”${i ? ` ${i + 1}×` : ""}) to get to the Run button.`);
      return t;
    }
  }
  const name = await clickFrontendTab(tabId);
  if (name) await goToPage(ctx, tabId).catch(() => {});
  if (name && (t = await visible())) {
    await ctx.log(`Clicked the “${name}” tab to get back to the page view and its Run button.`);
    return t;
  }
  return await dom(tabId, "modeToggle").catch(() => null);
}

// Scram's editor has an Edit / Run toggle (top right of the page view). The bot needs Run mode to
// test, and building still happens in Run mode — so keep it on Run for the whole build. Scram's
// bot can't press it itself, so the extension always does (with a real, trusted click).
// force: click Run even if we can't tell its state (e.g. the bot just asked for Run mode).
export async function ensureRunMode(ctx, tabId, { force = false } = {}) {
  const b = ctx.state.build || {};
  b.wantRun = true; // from now on, keep Run on while waiting for Scram's AI
  let t = await findModeToggle(ctx, tabId);
  if (!t) {
    // Last resort (once per step, or when asked): Run mode is the page URL's preview=run.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && /\/page\//.test(tab.url) && !/[?&]preview=run\b/.test(tab.url) && (force || b.urlRunFor !== (b.step ?? 0))) {
      b.urlRunFor = b.step ?? 0;
      const u = new URL(tab.url);
      u.searchParams.set("preview", "run");
      await chrome.tabs.update(tabId, { url: u.href });
      await waitForLoad(tabId).catch(() => {});
      await sleep(4000);
      await dom(tabId, "scrollChatToBottom").catch(() => {}); // the reload redraws the chat from the top
      await ctx.log("Couldn't reach the Run button, so opened the page with Run mode on (preview=run in its address).");
      return true;
    }
    if (tab && /[?&]preview=run\b/.test(tab.url || "")) return true; // already in Run mode
    if (force) await ctx.log("Couldn't find Scram's Run button on screen (is the page view showing?).");
    return false;
  }
  if (t.active === true) return true;
  // State unknown: click at most once per step unless asked, so we don't keep restarting the app.
  if (t.active === null && !force && b.runClickedFor === b.step) return true;
  await realClick(tabId, { id: t.id, label: t.label }).catch(() => dom(tabId, "click", { id: t.id, label: t.label }));
  b.runClickedFor = b.step;
  await sleep(2500);
  const after = await dom(tabId, "modeToggle").catch(() => null);
  await ctx.log(after?.active === false ? "Clicked Scram's Run button, but it still looks like Edit mode." : "Switched Scram to Run mode.");
  return after?.active !== false;
}

// Scram's AI says the app isn't running (or asks for Run): believe it. Get back to the page view,
// and if the toggle already claims Run, restart it (Edit → Run) so the app really runs again;
// if that still doesn't show the running app, reload the page with Run on.
export async function restartRunMode(ctx, tabId) {
  const b = ctx.state.build || {};
  if (Date.now() - (b.runRestartAt || 0) < 120000) return !!(await onRunView(tabId)); // at most every 2 min
  b.runRestartAt = Date.now();
  await ctx.log("Scram's AI says the app isn't running / asked for Run mode — believing it and (re)starting Run mode…");
  await ensureRunView(ctx, tabId).catch(() => {});
  const t = await dom(tabId, "modeToggle").catch(() => null);
  if (t?.active === true) {
    const edit = await dom(tabId, "findText", "^\\W*edit$", { maxLen: 10 }).catch(() => []);
    if (edit?.[0]) {
      await realClick(tabId, { id: edit[0].id, label: edit[0].label }).catch(() => {});
      await sleep(1500);
    }
  }
  await ensureRunMode(ctx, tabId, { force: true }).catch(() => {});
  if (!(await onRunView(tabId))) await ensureRunView(ctx, tabId).catch(() => {});
  const ok = !!(await onRunView(tabId));
  await dom(tabId, "scrollChatToBottom").catch(() => {});
  await ctx.log(ok ? "Run mode is on and the running app is showing." : "Tried to restart Run mode, but couldn't confirm the running app is showing.");
  return ok;
}

// Scram's preview-size button (next to Edit/Run: Desktop / Tablet / Mobile). Scram's bot can't
// resize the preview itself, so the extension switches it and then tells the bot which size is on.
const SIZES = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };
const isPreviewSizeControl = (label) => /preview size|^\W*(desktop|tablet|mobile)\W*$/i.test((label || "").trim());

export async function previewSizeNow(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const m = (tab?.url || "").match(/[?&]breakpoint=(\w+)/i);
  if (m) return m[1].toLowerCase();
  const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 }).catch(() => null);
  const trig = snap?.elements.find((e) => !e.inLayer && /preview size,?\s*(desktop|tablet|mobile)/i.test(e.label || ""));
  return trig ? trig.label.match(/(desktop|tablet|mobile)/i)[1].toLowerCase() : null;
}

// Each step starts with the preview at desktop size (the supervisor switches sizes when a check needs it).
async function keepDesktop(ctx, tabId) {
  const now = await previewSizeNow(tabId).catch(() => null);
  if (now && now !== "desktop") await setPreviewSize(ctx, tabId, "desktop").catch(() => {});
}

export async function setPreviewSize(ctx, tabId, size) {
  size = String(size || "").toLowerCase();
  if (!SIZES[size]) return false;
  if ((await previewSizeNow(tabId)) === size) return true;
  await ensureRunMode(ctx, tabId).catch(() => {});
  const pick = async () => {
    // The size option itself (in the open menu), by aria-label ("Preview size, Tablet") or its text ("Tablet").
    const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 });
    const opt = snap.elements.find((e) => (e.inLayer || /menuitem|option|radio/.test(e.role || "")) && new RegExp(`(^|preview size,?\\s*)${size}$`, "i").test((e.label || "").trim()));
    if (opt) return opt;
    const byText = (await dom(tabId, "findText", `^${SIZES[size]}$`, { maxLen: 12 }).catch(() => [])).filter((d) => !d.editable);
    return byText.length ? byText[byText.length - 1] : null;
  };
  // Open the preview-size menu (the device icon), then choose the size.
  const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 });
  const trigger = snap.elements.find((e) => !e.inLayer && /^preview size/i.test((e.label || "").trim()));
  if (trigger) {
    await realClick(tabId, { id: trigger.id, label: trigger.label }).catch(() => dom(tabId, "click", { id: trigger.id, label: trigger.label }));
    await sleep(900);
  }
  const opt = await pick();
  if (!opt) {
    await dom(tabId, "pressKey", "Escape").catch(() => {});
    await ctx.log(`Couldn't find Scram's preview-size option “${SIZES[size]}”.`);
    return false;
  }
  await realClick(tabId, { id: opt.id, label: opt.label }).catch(() => dom(tabId, "click", { id: opt.id, label: opt.label }));
  await sleep(1500);
  const now = await previewSizeNow(tabId);
  if (now && now !== size) {
    await ctx.log(`Tried to switch Scram's preview to ${SIZES[size]}, but it still shows ${SIZES[now] || now}.`);
    return false;
  }
  await dom(tabId, "pressKey", "Escape").catch(() => {}); // close the menu if it stayed open
  await ctx.log(`Switched Scram's preview to ${SIZES[size]}.`);
  return true;
}

// ---- Scram's AI can't open/switch Run mode — only the extension can. Never ask it to.
const RUN_ASK_PHRASE = /(?:\b(?:please\s+)?(?:try\s+(?:again\s+)?to\s+)?|\b)(?:re-?open|open|switch(?:\s+(?:it|back|over))?\s+(?:to|into)|turn\s+on|enter|go\s+(?:in)?to|put\s+(?:it|the\s+app|scram)\s+(?:in|into)|launch|start|click|press|toggle(?:\s+on)?|use)\s+(?:the\s+)?(?:"|“|')?run(?:"|”|')?(?:\s+(?:mode|button|view|preview))?(?:\s+(?:again|yourself|first|now))?(?:\s*(?:,|and|then|—|-)\s*)?/gi;
// Answer options that would have Scram's AI open Run itself (e.g. "Open Run and let me test it").
// Answer options saying the USER opens Run / it's already open ("I'll open Run myself · go ahead
// when it's up"): once the extension has switched Run on, that's the right answer — click it.
const GO_AHEAD_OPTION = /\b(i['’]?ll open (run|it)|i['’]?ve opened run|go ahead when|when it['’]?s (up|on|open|ready)|run is (on|open|up)|it['’]?s (on|open|up) now|already (open|on|running))\b/i;
const RUN_ASK_OPTION = /\b(open|switch|turn on|enter|launch|start|go to|use)\b[^.]{0,20}\brun\b|^\W*run(\s+mode)?\W*$/i;
const RUN_ON_NOTE = "Scram is in Run mode now (I switched it for you — you can't, and don't need to).";

// Remove any request for the bot to open/switch Run mode from a message. Returns { text, changed }.
export function stripRunAsks(text) {
  const original = String(text || "");
  let out = original.replace(RUN_ASK_PHRASE, (m) => (/please/i.test(m) ? "Please " : ""));
  if (out === original) return { text: original, changed: false };
  out = out
    .replace(/\bPlease\s+Please\b/g, "Please")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .trim();
  return { text: out, changed: true };
}

// Did the bot ask the user to press Run / switch to Run mode?
// Scram's AI saying the app isn't running / it can't drive it (it's usually right, even when the
// toggle looks like Run is on).
const SAYS_NOT_RUNNING = /\b(left the run (view|mode)|not (in )?run mode|isn['’]?t running|is not running|not running|edit[- ]mode|back on the editing canvas|app (is )?not drivable|can['’]?t (reach|drive|interact with) the (running )?app|failed to interact with the run|preview (is )?(blank|not loading|outdated|stale))\b/i;
const ASKS_FOR_RUN = /\b(click|press|hit|tap|switch|put|turn|toggle|enable|activate|launch|start)\b[^.\n]{0,60}\brun\b|\brun mode\b[^.\n]{0,40}\b(active|on|enabled|needed|required)\b|\bin run mode\b[^.\n]{0,30}\?/i;

// ------------------------------------------------------------------ supervisor

const SUPERVISOR_RULES = `You are the human user of Scram, driving Scram's AI bot through ONE step file of a phased build. The real human is away and has asked you to act for them: answer the bot's questions, approve its plans, and keep it working until the step is genuinely finished. Be decisive and concise.

Each turn you get: the current step file, what the bot has said/done since your last message, and the controls on screen (buttons, options, and any form fields the bot is asking you to fill). Return ONLY a JSON object — either one action:
{"action":"reply","message":"<what to type into the Scram chat box>","reason":"..."}
{"action":"click","elementId":"<id>","reason":"..."}             (e.g. "Approve plan", an answer option, Continue, "let the AI fix it")
{"action":"type","elementId":"<id>","text":"...","reason":"..."}  (fill a form field the bot showed — NOT the main chat box; use reply for that)
{"action":"do_it_myself","task":"<one concrete thing to do in Scram's editor UI>","message":"<what to tell the bot once it's done>","reason":"..."}  (the EXTENSION does it itself with real clicks/typing in Scram's editor, then sends your message; if it can't, it tells the bot to skip that part)
{"action":"new_chat","note":"<for the new chat: what the old chat already built and what's left>","reason":"..."}  (the EXTENSION starts a fresh Scram chat with the + in the chat's title row and re-sends this step file there with your note)
{"action":"look","question":"<what to check in Scram or in the running app>","reason":"..."}  (the EXTENSION's navigator looks around Scram itself — opens panels, reads the running app, checks Server Logs or the database view, without changing anything — and reports back to you this round; use it when you're unsure what's really going on instead of guessing or asking the bot)
{"action":"step_complete","summary":"<one line of what was built>","reason":"..."}
{"action":"wait","reason":"..."}                                  (only if the bot is clearly still working)
{"action":"need_human","reason":"..."}
{"action":"preview_size","size":"desktop|tablet|mobile","message":"<what to tell the bot once the preview is at that size>","reason":"..."}  (the EXTENSION switches Scram's Run preview size — the bot can't — then sends your message)
EVERY reply also carries, at the top level:
  "progress":["<checklist item from the step file that the bot reported as built AND verified for the first time in what appeared since your last message>", …]  ([] if none — don't repeat items already listed as verified);
  "drift":null — or, when the bot's latest work is NOT this step's scope but another step's from the plan (e.g. it's building the Settings screen while the current step is the Keyboard), {"step":<that step's number in the plan>,"title":"<its title>"}.
Any reply may also carry "learned":["<short lesson>", …] — see LEARNING below — and "to_human":"<one or two sentences>" — see MESSAGES FROM THE HUMAN.
— or several in order, for question forms: {"actions":[{"action":"click","elementId":"s12"},{"action":"type","elementId":"s14","text":"..."},{"action":"click","elementId":"s15"}],"reason":"..."}

How to decide:
- PLANS: Scram often shows a plan card (e.g. "Review plan" … "Approve plan") and will not build until it is approved. If an "Approve plan" / "Approve" / "Accept" / "Build it" / "Proceed" button is visible, CLICK IT — that is the normal path. Only if the plan clearly misses part of the step's scope or adds something out of scope, reply with precise corrections instead (the bot then revises; approve the revised plan next round). If a plan is presented in plain text with no button, reply "Approved — go ahead."
- QUESTIONS: the bot will not continue until they are answered. Answer every question concretely from the step file and its Context Block, making sensible product/design decisions yourself, consistent with the spec — never defer ordinary choices to the human. If the bot shows answer options or a small form, pick/fill them (use "actions" for several) and click its submit/continue button; if it asks in plain text, reply in the chat box answering each question in order.
- TESTING IS ASKED FOR ONCE — IN THE STEP FILE: every step file already ends with "Quick check in Run mode (required)", telling the bot to do one quick pass in Run mode (which the extension keeps on) and report back in a few lines. The build should move fast from step to step. So NEVER ask the bot to test, re-test, check, verify or double-check its work again — not when approving a plan, not after it reports, not "just to be sure". Asking twice wastes a whole round of building time.
- Bot says it has finished and reports what it tested: TRUST ITS REPORT, even a short one. If it says the objective is achieved and nothing is failing, choose step_complete straight away. Don't ask for more proof, more detail, an item-by-item list, or another pass.
- Only send the bot back if its own report shows a real gap: (a) it says something FAILED or is broken and it hasn't fixed it → ask it to fix exactly that (it re-checks just that item as part of fixing); (b) it says it skipped or couldn't build part of the step → ask it to do that specific part; (c) it finished building but its message has NO testing report at all → reply once: "Please do the testing section at the end of the step file and report back." Never more than that, and never for items it already reported as passing.
- step_complete when the bot reports the step built and tested (per the step file's testing section) with nothing failing. The extension then sends the next step file itself — never ask the bot to start the next step.
- Bot stopped mid-work, output looks cut off, or nothing new appeared (timed out): reply "Please continue where you left off." (the Scram guide says it sometimes stops randomly).
- Same problem for 2+ rounds: tell it to switch component or find another approach rather than forcing the same method (per the Scram guide).
- NEW CHAT: when the chat itself is broken — it shows no conversation (it reset, or only a list of past chats is visible), the bot keeps stopping mid-reply after nudges, it's confused or going in circles after a different approach was tried, or the human asks for a new chat — use {"action":"new_chat","note":"..."}. The extension opens a fresh chat with the + and re-sends the step file. NEVER ask to re-open an old chat from the chat history list, and never use do_it_myself for anything to do with chats (new, old or history) — new_chat is the only way. Don't use it more than once in a row unless the new chat breaks too.
- Error visible (red cross, failed deployment, error banner): click the "let the AI solve it" control if visible, otherwise reply asking the bot to diagnose and fix it (it can check Server Logs / run SQL in dev).
- NEVER pause (need_human) because a step is taking long, has had many rounds/messages, or the bot keeps going: there is no round or time limit. Keep it working (nudge, re-explain, try another approach).
- need_human ONLY for: Scram saying you're out of credits / usage limit reached, credentials/API keys/accounts you don't have, payments or plan upgrades, publishing to Live, deleting the project or data, or the same blocker persisting after several different attempts. Give a short, plain reason the human can act on (e.g. "Scram is out of credits — top up, then press Resume").
- TEST BLOCKERS (top priority): if the bot couldn't test something it built (it can't sign in, Google/social login needs setting up, an API key/credential/external account is missing, a "## Needs the human" item isn't done), the step is NOT complete. If it's a login problem and the temporary dev login doesn't exist yet, reply once asking the bot to add it (email + password test accounts per role, marked DEV ONLY) and test with it. If it needs something only the human can provide (Google Client ID/Secret, API keys, accounts), choose need_human with a reason that says exactly what to set up and where. For Google: "Set up Google sign-in: in Scram open More → Users → Add Provider → Google and copy the Dev and Live callback URLs; in Google Cloud Console create an OAuth 2.0 Client ID (Web application) with those as redirect URIs; paste the Client ID and Secret back into Scram's Users panel and save; then press Resume." Never let untested work pass as done.
- FINAL REVIEW: after every step is built, the extension tests the finished app itself (crawling and clicking it in Run mode) and sends the bot one list of fixes as a final step ("Final review fixes"). In that step, accept (step_complete) once the bot reports each listed problem fixed; don't add new requests of your own. In normal steps, don't make design requests unless something is plainly broken in what the bot reports.
- STAY ON THIS STEP (check every round): compare what the bot is building with the CURRENT step's scope and the plan. If it has moved on to another step's work (a screen, feature or workflow that a different step in the plan owns), set "drift" to that step and reply telling it plainly to stop, go back to the current step and not build the other step yet. The extension also sends that correction itself when you set "drift".
- SCREEN SIZES: build and check the sizes the step file asks for (e.g. 1440px desktop, 768px tablet, 375px mobile). The bot can't resize Scram's preview: when a check needs another size, use preview_size (the extension switches it), then tell the bot what to check at that size. Don't invent size checks the step file doesn't ask for.
- NEVER ask the bot to open, switch to, enter or "try again to open" Run mode, in any wording, and never pick an answer option like "Open Run and let me test it" — Scram's AI cannot do that; the extension already keeps Run on (the extension will remove such requests anyway). Just ask it to test.
- RUN MODE: the extension itself keeps Scram's Edit/Run toggle on Run for the whole build — neither you nor the bot can press it, so never ask the bot to switch to Run mode, and never click Run/Edit yourself. If the bot asks you to click Run or put the app in Run mode, the extension has already done it: reply "Run mode is on now — please carry on." If it asks in a question form with an option like "I'll open Run myself / go ahead when it's up", click that option instead (the chat box may not work while a question form is open).
- Never approve or request publishing to Live, deleting the project, purchases/upgrades, or inviting people.
- MESSAGES FROM THE HUMAN: the real human can message you while you work (listed each turn; ⭐ NEW = not acted on yet). They override the step file and your defaults. Act on new ones right away: relay what's needed to the bot (reply), change what you approve or ask for, skip or add something, or need_human if they ask you to pause. Always answer each new message in "to_human" (what you'll do, or the answer to their question) — that goes to the human, not the bot. If a message is just information, use it and say so.
- DO IT YOURSELF: when the bot says it can't do something that is really an action in Scram's editor UI (a toggle, button, setting, panel, menu, selecting something in the editor, switching a view, uploading something you have), don't ask it again and don't give up — use {"action":"do_it_myself","task":"<exact UI action, e.g. 'Turn on the Dark mode toggle in the editor toolbar'>","message":"<tell the bot it's done and what to do next>"}. (Run mode is automatic; for the preview size use preview_size.) Never use it for publishing, deleting, payments, account settings, inviting people or anything needing credentials — those are need_human. If the extension already tried a task and couldn't (see your earlier actions), don't try it again: tell the bot to skip it and carry on.
- LOOK BEFORE GUESSING: you get the latest part of the chat every round, and a screenshot of the Scram tab at the start of a step and whenever something looks unusual (an error, a dialog or form, no new output, the bot stuck or saying the app isn't running). When you still can't tell what's really going on (did the bot actually build it? is the app showing an error? what's in Server Logs? is the page it mentions really there?), use {"action":"look","question":"..."}: the extension's navigator checks it in Scram and the running app and tells you, this round. Don't use it for things the bot just reported clearly, and don't look at the same thing twice.
- LEARNING — don't go in circles: if the bot says it can't do something (its tools don't allow it, it has no way to, "you'll need to do this yourself"…), believe it. Add a short, general lesson to "learned" (e.g. "Scram's bot can't resize the preview viewport — the extension switches preview size") and NEVER ask it for that again, in any wording. Instead: do it yourself with an extension action if one fits (Run mode is automatic), ask for a different check it CAN do that covers the same item, or treat that item as out of its reach and move on. Never argue, insist, or re-send the same request. The "Known limits" list in each turn holds everything learned so far — obey it.

Scram guide for reference:
<scram_guide>
{{GUIDE}}
</scram_guide>`;

// The bot saying it couldn't test (part of) what it built — e.g. it can't sign in.
const UNTESTED = /\b(untested|not (been |yet )?tested|couldn['’]?t (be )?test|could not (be )?test|unable to test|can['’]?t test|cannot test|wasn['’]?t able to test|(couldn['’]?t|could not|can['’]?t|cannot|unable to) (sign|log) ?in|(sign|log)[- ]?in (popup|pop-up|window) (is )?blocked|google (sign[- ]?in|login|oauth) (isn['’]?t|is not|not) (set ?up|configured)|needs? (a )?(client id|client secret|api key|credentials))\b/i;

// The bot telling us it can't do something we asked.
const REFUSAL = /\b(i (can(no|['’])t|am unable to|['’]m unable to|am not able to|['’]m not able to|don['’]t have (a|an|the|any)\b[^.\n]{0,40}\b(tool|ability|action|access|way))|there['’]?s no way for me|no way for me to|my (testing |interaction )?tools (can(no|['’])t|don['’]t|do not)|(isn['’]t|is not) something i can|outside (of )?what i can|you['’]ll need to (do|check|test|verify|click|resize)|beyond my (capabilities|tools)|not possible for me)/i;

// The Scram chat as the supervisor reads it: at most `budget` characters, newest first — the new
// lines since our last message, then the latest part of the chat — and a one-line-per-message
// summary of what was cut ("earlier messages summarised:"). Thought blocks are already removed.
export const CHAT_BUDGET = 20000;
export function chatForSupervisor(output, chatTail, budget = CHAT_BUDGET) {
  output = String(output || "");
  chatTail = String(chatTail || "");
  const outPart = output.length > budget * 0.6 ? output.slice(-Math.round(budget * 0.6)) : output;
  const room = Math.max(0, budget - outPart.length);
  const tailPart = chatTail.length > room ? chatTail.slice(-room) : chatTail;
  // What didn't fit: the first line of each cut paragraph (up to 12), so the supervisor knows roughly what came before.
  const cut = output.slice(0, output.length - outPart.length) + "\n" + chatTail.slice(0, chatTail.length - tailPart.length);
  const heads = cut.split(/\n\s*\n|\n(?=[A-Z#*-])/).map((p) => p.trim().split("\n")[0]).filter((l) => l && l.length > 20);
  const summary = cut.trim()
    ? `earlier messages summarised: ${cut.trim().length.toLocaleString("en-US")} earlier characters left out${heads.length ? ` — they began:\n${heads.slice(-12).map((h) => `- ${h.slice(0, 120)}`).join("\n")}` : "."}`
    : "";
  return { output: outPart, chatTail: tailPart, summary, chars: outPart.length + tailPart.length };
}

// ---- speed: effort per round, the round's timing line, prompt-cache keep-alive, screenshots

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
// The operator's model and two efforts: `full` for decisions that matter, `routine` for the rest
// (never higher than full; "same" = no routine tier).
export function supervisorEfforts(ctx) {
  let { model, effort: full } = operator(ctx);
  // This step's content was declined by the operator model's safety check: the model that
  // answered instead supervises the rest of the step (efforts it supports: up to high).
  const b = ctx.state?.build;
  if (b?.modelFor && b.modelFor.step === b.step) {
    model = b.modelFor.model;
    if (!["low", "medium", "high"].includes(full)) full = "high";
  }
  const r = ctx.settings.operatorRoutineEffort || "medium";
  const routine = r === "same" || !(r in EFFORT_RANK) || !(full in EFFORT_RANK) || EFFORT_RANK[r] >= EFFORT_RANK[full] ? full : r;
  return { model, full, routine };
}

// An error in the bot's latest output — not "no errors", "error message" or "error state", which
// are what a passing report or a step file talks about.
export function hasError(text) {
  const t = String(text || "").replace(/\b(no|zero|0|without( any)?|free of)\s+(console |server |new |build )?(errors?|failures?|exceptions?)\b|\berror[- ]free\b|\berror (handling|states?|messages?|banners?|toasts?|text|copy|case)\b|\b(an|the) error (is|appears|shows)\b/gi, "");
  return /\b(errors?|failed|failing|fails|exception|crash(ed|es)?|broken|not working|doesn['’]t work|isn['’]t working|stack trace|cannot read|is not defined|undefined is not|500 internal|status 500)\b/i.test(t);
}
// The bot reporting the step (or this part) finished / its test results.
const COMPLETION_HINT = /\b(step (\d+ )?(is )?(now )?(complete|completed|done|finished)|all (the )?(checklist )?(items|checks|tests)( are| have)? (pass|passed|passing|done|complete|working|verified)|everything (works|is working|passes|passed)|quick check|test(ing)? (report|results|summary)|objective (is )?achieved|ready for the next step|nothing hardcoded)\b|✅|☑|✔/i;

// Rounds without progress after which a step counts as struggling (half the stuck limit, so 6 by
// default): from then on the supervisor thinks at full effort and gets a screenshot now and then.
// (Rounds without a newly verified item are normal while the bot builds, so not sooner.)
export function strugglingAfter(settings = {}) {
  return Math.max(3, Math.ceil((Math.round(Number(settings.maxStuckRounds)) || 12) / 2));
}

// Why this round needs the full effort (null = routine).
export function hardRoundReason({ output, notes = [], note = "", refusal = "", inspection = null, b = {}, settings = {} }) {
  const tail = String(output || "").slice(-4000);
  if (notes.some((n) => !n.seen)) return "your message";
  if (inspection) return "final review";
  if (/YOU ASKED THE NAVIGATOR TO LOOK/.test(note)) return "after looking";
  if (COMPLETION_HINT.test(tail)) return "the bot reports results";
  if (hasError(tail)) return "an error";
  if (refusal || UNTESTED.test(tail)) return "the bot can't do or test something";
  if ((b.noProgress || 0) >= strugglingAfter(settings)) return "no progress for a while";
  return null;
}

// Answers worth a second look at full effort before acting on them.
function consequential(d, step, totalSteps) {
  return ["step_complete", "need_human", "new_chat"].includes(d?.action) || (Array.isArray(d?.actions) && d.actions.some((a) => a.action === "new_chat")) || !!driftOf(d, step, totalSteps);
}

// Each supervisor call, for the round's timing line.
function noteCall(ctx, res, o) {
  const r = ctx.round;
  if (!r) return;
  const u = res?.usage || {};
  r.calls += 1;
  r.efforts.push(o?.effort || "default");
  r.cacheRead += u.cache_read_input_tokens || 0;
  r.inputAll += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

export function startRoundTiming(ctx) {
  ctx.round = { start: Date.now(), waitMs: 0, quietMs: 0, readMs: 0, supMs: 0, actMs: 0, calls: 0, efforts: [], cacheRead: 0, inputAll: 0, shot: null, chatChars: 0, why: null, quick: null };
}
const dur = (ms) => {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
};
// One line per round: where the time went.
export async function logRoundTiming(ctx, step) {
  const r = ctx.round;
  if (!r) return;
  ctx.round = null;
  const total = Date.now() - r.start;
  const other = Math.max(0, total - r.waitMs - r.readMs - r.supMs - r.actMs);
  const efforts = [...new Set(r.efforts)].join("+");
  const cached = r.inputAll ? `, ${Math.round((r.cacheRead / r.inputAll) * 100)}% of input from cache` : "";
  const sup = r.calls ? `supervisor ${dur(r.supMs)} (${efforts}${r.calls > 1 ? `, ${r.calls} calls` : ""}${cached}${r.why ? `; full effort: ${r.why}` : ""})` : `supervisor — (${r.quick || "no call needed"})`;
  const parts = [
    `bot ${dur(r.waitMs)}${r.quietMs ? ` (incl. ${dur(r.quietMs)} quiet)` : ""}`,
    `reading ${dur(r.readMs)}`,
    sup,
    `acting ${dur(r.actMs)}`,
    other >= 1000 ? `other ${dur(other)}` : null,
    `total ${dur(total)}`,
  ].filter(Boolean);
  const extra = [r.chatChars ? `chat ${r.chatChars.toLocaleString("en-US")} chars` : null, r.shot ? `screenshot: ${r.shot}` : null].filter(Boolean).join(" · ");
  await ctx.log(`⏱ Step ${step.stepNumber + 1}, round ${ctx.state.build?.rounds || 0}: ${parts.join(" · ")}${extra ? ` · ${extra}` : ""}`);
}

// While Scram's bot works, keep the supervisor's prompt cache from expiring (5 minutes after the
// last call): a max_tokens 0 request just under 5 minutes in, for each effort used in the last
// 30 minutes of this step. Costs a cache read, no output.
const WARM_AFTER_MS = 4 * 60000;
export async function keepWarmIfDue(ctx) {
  const b = ctx.state.build;
  for (const [k, w] of Object.entries(ctx.warm || {})) {
    if (!w || w.step !== b?.step || Date.now() - w.usedAt > 30 * 60000) {
      delete ctx.warm[k];
      continue;
    }
    if (Date.now() - w.at < (globalThis.__rbWarmAfterMs ?? WARM_AFTER_MS)) continue; // (tests shorten it)
    w.at = Date.now();
    await keepWarm(w).catch(() => null);
  }
}

// Whether the supervisor gets a screenshot this round, and why: at the start of a step (and of a
// fresh chat), and whenever something looks unusual. Null = no screenshot.
export function screenshotReason(ctx, { output, timedOut, controls = [], chatInputId, runNote, blocked }) {
  const b = ctx.state.build;
  if (ctx.settings.supervisorSees === false) return null;
  const tail = String(output || "").slice(-4000);
  if (b.shotFor !== `${b.step}:${b.newChats || 0}`) return "start of the step";
  if (!tail.trim()) return "nothing new in the chat";
  if (timedOut) return "the bot went quiet";
  if (hasError(tail)) return "an error";
  if (runNote) return "Run mode trouble";
  if (blocked) return "untested work";
  if (REFUSAL.test(tail)) return "the bot says it can't";
  if (controls.some((e) => e.inLayer || (e.editable && e.id !== chatInputId))) return "a dialog or form is open";
  const half = strugglingAfter(ctx.settings);
  const np = b.noProgress || 0;
  if (np >= half && (np - half) % 3 === 0) return "no progress for a while";
  if (b.driftedAt === `${b.step}:${b.rounds}`) return "the bot drifted last round";
  return null;
}

async function supervise(ctx, { step, totalSteps, output, buttons, timedOut, chatInputId, note = "", inspection = null, screen = null, chatTail = "" }) {
  const b = ctx.state.build;
  const lessons = await store.getLessons();
  const limits = lessons.length
    ? `Known limits of Scram's bot (learned earlier — NEVER ask it to do any of these; work around them):\n${lessons.map((l) => `- ${l.text}`).join("\n")}\n\n`
    : "";
  const halves = b.chunk
    ? `NOTE: this step is being done in two halves. The bot is on PART ${b.chunk.part} of 2 — only these checklist items count right now:\n${b.chunk.parts[b.chunk.part - 1].map((t) => `  - ${t}`).join("\n")}\nWhen the bot has built and tested exactly these, choose step_complete (the extension then hands it ${b.chunk.part === 1 ? "part 2" : "nothing more — the step is done"}). Don't ask for the other half's items yet.\n`
    : "";
  const refusal = REFUSAL.test(output.slice(-4000))
    ? "NOTE: the bot seems to be saying it CAN'T do something. Don't ask again — put a short general lesson in \"learned\" and take a different route: if it's an action in Scram's editor UI, do it yourself (do_it_myself); otherwise ask for a check it CAN do, or skip it.\n"
    : "";
  const guide = await loadScramGuide();
  const uiGuide = await loadPrompt("scramUiGuide", "scram-ui-guide.md").catch(() => "");
  const system = SUPERVISOR_RULES.replace("{{GUIDE}}", guide) + (uiGuide ? `\n\nScram editor guide (what the screens and controls are — use it to word do_it_myself tasks):\n<scram_ui_guide>\n${uiGuide}\n</scram_ui_guide>` : "");
  const baseInstr = store.runInstructions({ ...ctx.state, notes: [] });
  const instructions = baseInstr
    ? `The human's instructions and the clone's scope (respect them in every answer — e.g. don't let the bot build areas that are out of scope):\n${baseInstr}\n\n`
    : "";
  const notes = (ctx.state.notes || []).filter((n) => n.step == null || n.step === b.step);
  const messages = notes.length
    ? `Messages from the human during this run (oldest first):\n${notes.slice(-15).map((n) => `- ${n.seen ? "" : "⭐ NEW: "}${n.text}`).join("\n")}\n\n`
    : "";
  // The whole plan's step titles, so drift to another step's work can be recognised.
  const plan = (await store.getSteps(ctx.state.siteUrl).catch(() => [])).map((x, i) => `${i + 1}. ${x.title}${i === b.step ? "   ← CURRENT STEP" : ""}`).join("\n");
  const verified = (b.verified || []).length ? `Checklist items already verified on this step (don't count them again in "progress"):\n${b.verified.map((v) => `- ${v}`).join("\n")}\n\n` : "";
  // What stays the same for every round of this step (instructions, plan, step file) goes first,
  // in its own block marked cacheable: rounds after the first read it (with the system prompt)
  // from Claude's prompt cache instead of processing it again — faster and cheaper.
  const stableText = (scale) => `${instructions}The build plan (for spotting drift — only the CURRENT step may be built now):
${plan || "(not available)"}

Current step: ${step.stepNumber + 1} of ${totalSteps} — "${step.title}"

<step_file>
${step.content.slice(0, Math.round(40000 * scale))}
</step_file>`;
  const stableBlock = { type: "text", text: stableText(1), cache_control: { type: "ephemeral" } };
  const compose = (scale = 1, extra = "") => {
    const chat = chatForSupervisor(output, chatTail, Math.round(CHAT_BUDGET * scale));
    const text = `${messages}${limits}${verified}Your earlier actions on this step (a short summary of earlier rounds):
${(b.history || []).slice(scale < 1 ? -5 : -8).map((h) => `- ${h}`).join("\n") || "(none yet — the step file was just sent)"}

${timedOut ? "NOTE: the bot produced no new output for a long time (timed out waiting).\n" : ""}${note}${halves}${refusal}What appeared in Scram since your last message (the bot's visible replies — its collapsed Thought blocks and tool steps are left out — new lines only, most recent last):
<scram_output>
${chat.output || "(nothing new)"}
</scram_output>

Controls visible (id | kind | label | state):
${buttons
  .map((e) => {
    const kind = e.editable ? `field${e.type ? `:${e.type}` : ""}` : e.role || e.tag;
    const state = [e.disabled ? "disabled" : "", e.selected ? "selected" : "", e.pressed ? `checked=${e.pressed}` : "", e.inLayer ? "in-dialog" : "", e.id === chatInputId ? "MAIN CHAT BOX (use reply)" : ""].filter(Boolean).join(", ");
    return `${e.id} | ${kind} | ${JSON.stringify(e.label || "")}${state ? ` | ${state}` : ""}`;
  })
  .join("\n") || "(none)"}`;
    const look = inspection
      ? `\n\nWHAT THE RUNNING APP LOOKS LIKE RIGHT NOW (the extension looked at Scram's Run preview${inspection.size ? ` at ${inspection.size} size` : ""}${inspection.image ? "; screenshot attached" : ""}):\n${inspection.covered ? `Note: part of the preview was covered by “${inspection.covered}”.\n` : ""}${describeIssues(inspection.audit)}\nDesign-fix requests already made on this step: ${b.designAsks || 0} (max 2).`
      : "";
    // The supervisor sees the chat as it is (not only the new lines), and a screenshot of the
    // Scram tab when one was taken this round (start of a step, or something looks unusual).
    const shot = scale >= 1 ? screen : null; // reduced context: no screenshot
    const seen = `${chat.chatTail ? `\n\nTHE LATEST PART OF SCRAM'S AI CHAT, as shown on screen right now (for context; "What appeared since your last message" above is what's new):\n<scram_chat>\n${chat.summary ? `${chat.summary}\n…\n` : ""}${chat.chatTail}\n</scram_chat>` : chat.summary ? `\n\n${chat.summary}` : ""}${shot ? "\n\nA screenshot of the Scram tab right now is attached: use it to understand what's going on (what the bot is doing, what's on screen, whether something looks wrong)." : "\n\n(No screenshot this round — nothing looked unusual. If you need to see the screen, use look.)"}`;
    const images = [inspection?.image, shot].filter(Boolean).map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } }));
    const roundText = { type: "text", text: text + look + seen + extra };
    // Reduced context (retry ladder): one plain block, nothing cached.
    const content = scale >= 1 ? [stableBlock, roundText, ...images] : [{ type: "text", text: `${stableText(scale)}\n\n${roundText.text}` }, ...images];
    return { content, chars: chat.chars };
  };
  const first = compose(1);
  if (ctx.round) ctx.round.chatChars = first.chars;

  // Effort: routine rounds think less (faster, cheaper); rounds that matter use the operator
  // effort, and a consequential answer from a routine round is double-checked at that effort.
  const eff = supervisorEfforts(ctx);
  const hardWhy = hardRoundReason({ output, notes, note, refusal, inspection, b, settings: ctx.settings });
  const ladder = { reduce: async (scale) => compose(scale).content, onRetry: (m) => ctx.log(`⚠️ ${m}`) };
  const ask = async (effort, content) => {
    const t0 = Date.now();
    const seen = [];
    // The model as of now: an earlier call this round may have switched it (see below).
    const cur = supervisorEfforts(ctx);
    if (cur.model !== eff.model && !["low", "medium", "high"].includes(effort)) effort = "high";
    try {
      const d = await askJson({
        what: "Scram supervisor",
        system,
        userContent: content,
        maxTokens: 3000,
        model: cur.model,
        effort,
        ...ladder,
        onCall: (res, o) => {
          noteCall(ctx, res, o);
          seen.push({ refusal: res.details?.stop_reason === "refusal", model: res.model || o.model || cur.model, servedBy: res.details?.servedBy || null, category: res.details?.refusal?.category || null });
        },
      });
      // Declined by the safety check and answered by another model (our retry, or the API's own
      // fallback): stay on that model for the rest of this step — the step's content would keep
      // tripping the check, and every declined call costs a round trip.
      const last = seen[seen.length - 1];
      const refusal = seen.find((x) => x.refusal);
      if (last && last.model !== cur.model && (refusal || last.servedBy)) {
        b.modelFor = { step: b.step, model: last.model, from: cur.model, category: refusal?.category || null };
        await ctx.log(`⚠️ ${cur.model}'s safety check declined the supervisor's request on this step${refusal?.category ? ` (category: ${refusal.category})` : ""} — ${last.model} answered, so it supervises the rest of step ${step.stepNumber + 1}. (These checks sometimes flag ordinary build content by mistake.)`);
      }
      // Keep this effort's prompt cache warm while Scram's bot works (see keepWarmIfDue).
      ctx.warm = { ...(ctx.warm || {}), [effort]: { model: last?.model || cur.model, effort, system, cachedBlocks: [stableBlock], at: t0, usedAt: t0, step: b.step } };
      return d;
    } finally {
      if (ctx.round) ctx.round.supMs += Date.now() - t0;
    }
  };
  let effort = hardWhy ? eff.full : eff.routine;
  let decision = await ask(effort, first.content);
  if (effort !== eff.full && consequential(decision, step, totalSteps)) {
    const what = decision.action === "step_complete" ? "step complete" : decision.action === "need_human" ? "pause for you" : driftOf(decision, step, totalSteps) ? "drift" : "new chat";
    await ctx.log(`Double-checking “${what}” at ${eff.full} effort before acting on it…`);
    const sure = await ask(eff.full, first.content).catch(() => null);
    if (sure) {
      if (sure.action !== decision.action) await ctx.log(`At ${eff.full} effort the supervisor chose “${sure.action || "several actions"}” instead.`);
      decision = sure;
      effort = eff.full;
    }
  }
  if (ctx.round) ctx.round.why ||= hardWhy;
  const lessonsOf = (d) => [].concat(d?.learned || []).concat(...(Array.isArray(d?.actions) ? d.actions.map((x) => x.learned || []) : []));
  const learned = lessonsOf(decision);

  // Loop guard: about to send (nearly) the same message as one we already sent this step?
  const outgoing = [decision.message, ...(Array.isArray(decision.actions) ? decision.actions.map((a) => a.message) : [])].filter(Boolean).join(" ");
  const sent = (b.sentMessages || []).slice(-6);
  const generic = /^\s*(please )?(continue|carry on|go ahead|approved)\b/i.test(outgoing) && outgoing.length < 120; // fine to repeat
  // A preview_size switch is a new request each time (different size), even if the wording matches.
  const isSizeSwitch = decision.action === "preview_size" || (Array.isArray(decision.actions) && decision.actions.some((x) => x.action === "preview_size"));
  const repeat = outgoing && !generic && !isSizeSwitch && sent.find((m) => store.similarity(m, outgoing) >= 0.75);
  if (repeat) {
    await ctx.log("Supervisor was about to repeat an earlier request — asking it for a different approach.");
    const retry = await ask(
      eff.full,
      compose(1, `\n\nIMPORTANT: you already sent the bot this, and it didn't work:\n"${repeat.slice(0, 600)}"\nDo NOT send that again in any wording. If the bot said it can't do it, add a lesson to "learned". Choose a different action: an extension action, a different request it can do, accept what it reported (step_complete if everything it CAN check passes), or need_human.`).content
    ).catch(() => null);
    if (retry) {
      decision = retry;
      learned.push(...lessonsOf(retry)); // keep lessons from both answers
    }
  }

  // The human's new messages have now been read: answer them in the log.
  const fresh = notes.filter((n) => !n.seen);
  if (fresh.length) {
    for (const n of fresh) n.seen = true;
    // Instructions passed on by Ask Autopilot were already answered there.
    if (fresh.some((n) => !n.fromAsk)) await ctx.log(`🤖 Autopilot: ${String(decision.to_human || "Got it — I'm taking that into account.").slice(0, 600)}`);
  }

  if (learned.length) {
    const added = await store.addLessons(learned, `step ${step.stepNumber + 1}: ${step.title}`);
    for (const l of added) await ctx.log(`📘 Learned: ${l.text}`);
  }
  return decision;
}

// ------------------------------------------------------------------ build loop

const STEP_SUFFIX = `

---
No need to show me a plan or wait for approval — build it straight away. The file explains WHY things work the way they do: follow that intent, and when something isn't specified, choose what best serves it. Then do the quick check at the end of the file and report back in a few lines.`;

// Send a step to Scram's bot. Preferred: attach it as a .md file (Scram's bot works well
// with markdown files) plus a short pointer message. If the chat has no working upload
// (the file name never shows up), fall back to pasting the full text.
// continuing: set when the step is re-sent in a fresh chat partway through — tells Scram's AI
// what the old chat already did so it checks the project and doesn't rebuild or duplicate.
// What the user said in the RoboBuild chat that every step must follow (standing instructions,
// spec changes), plus why a step is being redone.
function steeringFor(ctx, step) {
  const st = ctx.state;
  const steer = (st.steering || []).map((s) => `- ${s.text}`).join("\n");
  const amend = (st.specAmendments || []).map((a) => `- [${a.section}] ${a.text}`).join("\n");
  const redo = st.build?.redo?.stepNumber === step.stepNumber ? st.build.redo.reason : "";
  return [
    redo && `\n\n## Redo this step\nThis step was built before; the user asked for it to be redone: ${redo}\nLook at what's already in the project for this step and change it as needed — don't duplicate anything.`,
    amend && `\n\n## Spec changes from the user (override this file where they conflict)\n${amend}`,
    steer && `\n\n## User instructions (must follow)\n${steer}`,
  ].filter(Boolean).join("");
}

async function sendStep(ctx, tabId, step, total, { continuing = "" } = {}) {
  const resume = continuing
    ? `\n\nThis is a NEW chat picking up step ${step.stepNumber + 1} partway through: the previous chat already built part of it. ${continuing}\nBefore building, look at what's already in the project (pages, components, workflows, tables) and continue from there — don't rebuild or duplicate anything that's already done.`
    : "";
  step = { ...step, content: stripRunAsks(store.withTestingSection(step.content)).text + steeringFor(ctx, step) }; // older handoffs lack the testing section
  const name = store.handoffFileName(step);
  await assertInEditor(tabId);
  if (!(await dom(tabId, "findChatInput"))) await showEditorHome(ctx, tabId);
  if (ctx.settings.scramSendAsFile !== false) {
    let inputId = await dom(tabId, "findChatInput");
    if (!inputId) {
      await uiAgent(ctx, tabId, "Open the AI chat panel (the \"Chat\" panel on the left of the project editor) so its \"Ask Claude...\" message box is visible. Do not send anything.", { maxSteps: 8 });
    tabId = ctx.state.build.tabId || tabId;
      inputId = await dom(tabId, "findChatInput");
    }
    const preferred = ctx.settings.scramAttachMethod || null;
    const res = await attachToScram(tabId, name, step.content, {
      ...(preferred ? { only: [preferred, ...ALL_METHODS.filter((m) => m !== preferred)] } : {}),
      onTry: (m) => ctx.log(`Attaching ${name} to Scram's chat — trying “${m}”…`),
    });
    if (res.ok) {
      if (res.method !== preferred) await rememberMethod(res.method);
      ctx.settings.scramAttachMethod = res.method;
      await ctx.log(`Attached ${name} to Scram's chat (${res.method}).`);
      const message = `Attached: ${name} — the complete work order for step ${step.stepNumber + 1} of ${total} ("${step.title}"). Read the whole file before doing anything, and follow it exactly.${resume}${STEP_SUFFIX}`;
      await sendMessage(ctx, tabId, message, { allowAttach: false, pointerFor: name });
      return message;
    }
    await ctx.log(`Couldn't attach ${name} in Scram's chat (${res.log.filter((l) => l.startsWith("❌")).length} methods tried — run Settings → “Test file upload to Scram” for details). Pasting the step text instead.`);
  }
  const message = step.content + resume + STEP_SUFFIX;
  await sendMessage(ctx, tabId, message, { allowAttach: false }); // attaching just failed
  return message;
}

// ---- new chat: when Scram's chat is broken or stuck (reset, stops mid-reply, goes in circles),
// start a fresh chat with the + in the chat's title row and re-send the current step there.
// Old chats are never re-opened from the history list.
const NEW_CHAT_GOAL = `Start a NEW, empty AI chat in Scram's editor. The AI chat is the left column; its title row shows the current chat's name in quotes followed by small icons: a plans list, a "+" (new chat), a chat-history icon and a "^" collapse chevron. Click the "+" in that title row. If a list of past chats or a search box opens instead, close it with Escape (don't open any old chat) and click the "+" itself. Finish with done once an empty chat with its "Ask Claude…" box is showing. Don't type or send anything, and don't click anything else in the title row.`;

export async function startNewChat(ctx, tabId) {
  await dom(tabId, "pressKey", "Escape").catch(() => {});
  const before = {
    title: (await dom(tabId, "chatHeaderInfo").catch(() => null))?.title || "",
    len: String((await dom(tabId, "chatText").catch(() => "")) || "").length,
  };
  // Fresh = the chat box is there, and the chat's name changed or its history is gone.
  const fresh = async () => {
    if (!(await dom(tabId, "findChatInput").catch(() => null))) return false;
    const title = (await dom(tabId, "chatHeaderInfo").catch(() => null))?.title || "";
    const len = String((await dom(tabId, "chatText").catch(() => "")) || "").length;
    return (title && title !== before.title) || len < before.len * 0.5;
  };
  const t = await dom(tabId, "newChatTarget").catch(() => null);
  if (t) {
    await realClick(tabId, { id: t.id, label: t.label }).catch(() => dom(tabId, "click", { id: t.id, label: t.label }));
    await sleep(2500);
    if (await fresh()) return true;
    // The + may open a small menu: take its "New chat" item, never an old chat.
    const snap = await dom(tabId, "snapshot", { maxElements: 200, maxText: 0 }).catch(() => null);
    const item = snap?.elements.find((e) => e.inLayer && /^\W*new (chat|conversation)$/i.test((e.label || "").trim()));
    if (item) {
      await realClick(tabId, { id: item.id, label: item.label }).catch(() => dom(tabId, "click", { id: item.id, label: item.label }));
      await sleep(2500);
      if (await fresh()) return true;
    }
    await dom(tabId, "pressKey", "Escape").catch(() => {});
    if (await fresh()) return true;
  }
  return uiAgent(ctx, tabId, NEW_CHAT_GOAL, { maxSteps: 8, optional: true, allowHeader: true, verify: fresh }).catch(() => false);
}

async function resendInNewChat(ctx, tabId, step, total, note) {
  const b = ctx.state.build;
  await ctx.log("Starting a new Scram chat (the + in the chat's title row) and re-sending this step there…");
  const ok = await startNewChat(ctx, tabId);
  await ctx.log(ok ? "New chat open — re-sending the step file." : "Couldn't open a new chat — re-sending the step file in the current chat instead.");
  b.newChats = (b.newChats || 0) + 1;
  b.baseline = (await dom(tabId, "bodyText").catch(() => "")) || "";
  const message = await sendStep(ctx, tabId, step, total, { continuing: String(note || "").slice(0, 1500) || "Check what's done and finish the rest." });
  b.sentText = message;
  b.nudges = 0;
  b.history.push(`${ok ? "started a new chat" : "couldn't start a new chat"} and re-sent the step file`);
  return ok;
}

const goAheadOption = (controls, chatInputId) => controls.find((e) => !e.editable && !e.disabled && e.id !== chatInputId && GO_AHEAD_OPTION.test(e.label || ""));

// Scram's AI offered "Open Run and let me test it" (or similar): it can't open Run itself, so
// switch Run on ourselves and answer through the question's own "write my own answer" box when
// there is one, else in the chat.
async function answerRunOption(ctx, tabId, controls, option, chatInputId) {
  await ensureRunMode(ctx, tabId, { force: true }).catch(() => {});
  // The question offers "I'll open Run myself / go ahead when it's up": Run is on now, so pick that.
  const goAhead = goAheadOption(controls, chatInputId);
  if (goAhead) {
    await ctx.log(`Run mode is on — answering Scram's question with “${goAhead.label}”.`);
    await realClick(tabId, { id: goAhead.id, label: goAhead.label }).catch(() => dom(tabId, "click", { id: goAhead.id, label: goAhead.label, role: goAhead.role }));
    ctx.state.build.sentText = goAhead.label;
    return;
  }
  const answer = "Run mode is on now — I switched it for you. Please carry on.";
  await ctx.log(`Not picking “${option.label}” (Scram's AI can't open Run) — switched Run on myself and answering instead.`);
  const own = controls.find((e) => e.editable && e.id !== chatInputId && /write (my|your) own|own answer|other/i.test(e.label || ""));
  if (own) {
    await dom(tabId, "typeText", { id: own.id, label: own.label, role: own.role }, answer);
    await sleep(400);
    await realEnter(tabId, { id: own.id }).catch(() => dom(tabId, "pressKey", "Enter", { id: own.id }));
    await sleep(1200);
    // Submit button for the form, if the Enter didn't do it.
    const submit = controls.find((e) => !e.editable && !e.disabled && /^(submit|send|submit answers?|continue|done)$/i.test((e.label || "").trim()) && e.id !== chatInputId);
    if (submit && (await dom(tabId, "inputValue", own.id).catch(() => ""))) await dom(tabId, "click", { id: submit.id, label: submit.label, role: submit.role });
  } else {
    await sendMessage(ctx, tabId, answer);
  }
  ctx.state.build.sentText = answer;
}

// Rounds whose answer is obvious, so the build doesn't wait 20–60s on the supervisor for them:
// - Scram's AI is still generating → keep waiting;
// - a plan card is waiting for approval (and no question form is showing) → approve it;
// - nothing new appeared for a long time → nudge it to continue.
// Never when you've sent Autopilot a message (the supervisor must answer you).
async function quickDecision(ctx, tabId, { output, timedOut, controls, approveBtn, chatInputId }) {
  const b = ctx.state.build;
  if ((ctx.state.notes || []).some((n) => !n.seen)) return null;
  if (await dom(tabId, "isGenerating").catch(() => false)) return { action: "wait", reason: "Scram's AI is still working" };
  const form = controls.some((e) => (e.editable && e.id !== chatInputId) || /write (my|your) own|submit answers?|choose an option|select an option/i.test(e.label || ""));
  if (approveBtn && !form && b.autoApproved !== `${b.step}:${approveBtn.label}:${b.rounds}`) {
    b.autoApproved = `${b.step}:${approveBtn.label}:${b.rounds + 1}`; // don't click the same button two rounds running
    return { action: "click", elementId: approveBtn.id, reason: `approving Scram's plan (“${approveBtn.label}”)` };
  }
  if (timedOut && !String(output || "").trim()) return { action: "reply", message: "Please continue where you left off.", reason: "nothing new for a long time — nudging Scram's AI" };
  return null;
}

// The supervisor's "drift" field, checked: a different step number within the plan.
export function driftOf(decision, step, totalSteps) {
  const d = decision?.drift;
  if (!d || typeof d !== "object") return null;
  const n = Math.round(Number(d.step));
  if (!Number.isInteger(n) || n < 1 || (totalSteps && n > totalSteps) || n === step.stepNumber + 1) return null;
  if (decision.action === "step_complete") return null; // finished this step: the next one is fine
  return { step: n, title: String(d.title || "").slice(0, 120) };
}

// One supervisor round: wait for Scram's bot to go quiet, read what's new (expanding
// collapsed plans), let the supervisor decide, and carry out click/type/reply/form answers.
// With dryRun, nothing is clicked or typed — the decision is only logged ("Would …").
// Returns { decision, text }; step_complete / need_human / wait are left to the caller.
export async function superviseRound(ctx, tabId, step, totalSteps, { dryRun = false } = {}) {
  const b = ctx.state.build;
  if (!dryRun) await dom(tabId, "scrollChatToBottom").catch(() => {});
  // Scram's AI chat must be on screen (the bot or a click may have left it on Overview, a
  // workflow canvas, etc.).
  if (!dryRun && !(await dom(tabId, "findChatInput").catch(() => null))) await showEditorHome(ctx, tabId);
  if (!dryRun && ctx.state.build?.wantRun) await ensureRunView(ctx, tabId).catch(() => {});
  if (!dryRun) await closePlansPanel(ctx, tabId).catch(() => {});
  // Scram pauses its AI when its tab isn't the one being looked at.
  const page = (await dom(tabId, "bodyText").catch(() => "")) || "";
  if (/AI paused by the browser|AI paused/i.test(page) && !b.warnedPaused) {
    b.warnedPaused = true;
    await ctx.log("⚠️ Scram says its AI was paused by the browser — it pauses when the Scram tab isn't the one on screen. Keep RoboBuild's window on screen (not minimised; it can sit behind your other windows) while Autopilot builds.");
    ctx.notify("Keep RoboBuild's window on screen", "Scram pauses its AI when its tab is hidden. Don't minimise RoboBuild's window while it builds.");
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
  const epoch = b.steerEpoch || 0;
  const tWait = Date.now();
  let { text, timedOut, quietMs } = await waitForIdle(ctx, tabId, b.baseline);
  if (ctx.round) {
    ctx.round.waitMs += Date.now() - tWait;
    ctx.round.quietMs = quietMs || 0;
  }
  const tRead = Date.now();
  // Steered to another step from the chat while waiting: this round's step no longer applies.
  if ((ctx.state.build?.steerEpoch || 0) !== epoch) return { decision: { action: "reply", reason: "steered from the RoboBuild chat" }, text };
  // "Send this to Scram now" from the chat: now that the bot's reply has finished, send it.
  if (!dryRun && b.sendNow?.length) {
    const queued = b.sendNow.splice(0);
    for (const msg of queued) {
      await sendMessage(ctx, tabId, msg);
      b.sentMessages = [...(b.sentMessages || []), msg].slice(-12);
      b.history.push(`sent the user's message from the chat: ${msg}`.slice(0, 200));
      await ctx.log(`🧭 Steering from chat: sent to Scram's AI — “${msg.slice(0, 300)}”`);
    }
    b.baseline = text;
    await ctx.save({ build: b });
    return { decision: { action: "reply", reason: "sent the user's message" }, text };
  }
  if (!dryRun) await dom(tabId, "scrollChatToBottom").catch(() => {});
  // Plan cards are collapsed ("Read more") — expand so the whole plan / question is read.
  if (await dom(tabId, "expandCollapsed").catch(() => 0)) {
    await sleep(800);
    text = (await dom(tabId, "bodyText")) || text;
  }
  // The chat as the human sees it: the bot's collapsed Thought blocks and tool-step lists are left
  // out of both the new lines and the chat tail the supervisor reads.
  const readable = (await dom(tabId, "chatReadable").catch(() => null)) || { text: "", hidden: [] };
  const hidden = new Set(readable.hidden || []);
  const output = newLines(b.baseline, text, b.sentText || "").split("\n").filter((l) => !hidden.has(l.trim())).join("\n");
  // Scram's bot can't press Run itself — if it asks for Run mode, the extension switches it.
  let runNote = "";
  if (ASKS_FOR_RUN.test(output.slice(-3000)) || SAYS_NOT_RUNNING.test(output.slice(-3000))) {
    if (dryRun) await ctx.log("DRY RUN — the bot asked for Run mode; would click Scram's Run button.");
    else if (await restartRunMode(ctx, tabId)) runNote = "NOTE: the bot said the app wasn't running / asked for Run mode — the extension believed it and has just (re)started Run mode itself and checked the running app is showing. Tell the bot Run mode is on now and to carry on (its step file already tells it to test — don't ask again); do NOT ask it to switch modes.\n";
  } else if (!dryRun) {
    await ensureRunMode(ctx, tabId).catch(() => {});
  }
  const snap = await dom(tabId, "snapshot", { maxElements: 220, maxText: 0 });
  const chatInputId = await dom(tabId, "findChatInput").catch(() => null);
  // Buttons/options, plus any form fields the bot is asking us to fill (not links).
  // Header controls (chat title row, Page Structure) are never offered: they only collapse
  // sections or start new chats.
  // Only the AI chat's own controls (plan cards, answer options, its forms) and pop-up dialogs are
  // offered: never the editor around it — e.g. a workflow in the right panel's Logic tab opens a
  // workflow canvas and leaves Run mode.
  const col = await dom(tabId, "chatColumn").catch(() => null);
  const inChat = (e) => !col || !e.box || (e.box[0] + e.box[2] / 2 >= col.left - 2 && e.box[0] + e.box[2] / 2 <= col.right + 2);
  const controls = snap.elements.filter((e) => !e.href && !e.header && (e.label || e.editable) && (e.inLayer || inChat(e))).slice(0, 140);
  const approveBtn = controls.find((e) => !e.editable && !e.disabled && /^(approve( plan)?|accept( plan)?|approve (and|&) build|build it|proceed)$/i.test((e.label || "").trim()));

  // Obvious situations are handled without a (slow) Claude call; anything else goes to the supervisor.
  let decision = dryRun ? null : await quickDecision(ctx, tabId, { output, timedOut, controls, approveBtn, chatInputId });
  if (decision) {
    await ctx.log(`Quick decision (no Claude call needed): ${decision.reason}`);
    if (ctx.round) ctx.round.quick = decision.reason;
  }
  let inspection = null; // set only by the final design review (see reviewRound)
  const blocked = UNTESTED.test(output.slice(-4000));
  if (blocked) runNote += "NOTE: the bot says some of its work is UNTESTED or it can't sign in / is missing something to test with — apply TEST BLOCKERS: don't step_complete; get the temporary dev login added, or need_human for credentials only the human can provide.\n";
  try {
    // A screenshot only when it helps (start of a step, or something looks unusual).
    const shotWhy = decision ? null : screenshotReason(ctx, { output, timedOut, controls, chatInputId, runNote, blocked });
    const screen = shotWhy ? await screenshot(tabId, 1280).catch(() => null) : null;
    if (screen) {
      b.shotFor = `${b.step}:${b.newChats || 0}`;
      if (ctx.round) ctx.round.shot = shotWhy;
    }
    const chatTail = String(readable.text || (await dom(tabId, "chatText").catch(() => "")) || "").slice(-CHAT_BUDGET);
    if (ctx.round) ctx.round.readMs += Date.now() - tRead;
    decision ||= await supervise(ctx, { step, totalSteps, output, buttons: controls, timedOut, chatInputId, note: runNote, inspection, screen, chatTail });
    // "look": the navigator checks something in Scram itself (read only), then the supervisor decides.
    if (decision.action === "look" && decision.question) {
      const q = String(decision.question).slice(0, 500);
      await ctx.log(`👀 Looking for myself: ${q}${decision.reason ? ` — ${decision.reason}` : ""}`);
      const tLook = Date.now();
      const found = await browserAgent(ctx, tabId, `Find out, by looking around Scram's editor and the running app, and WITHOUT changing anything (no typing, no edits, no toggles; only open/close panels, switch tabs, scroll and read): ${q}\nWhen you know, reply "DONE: <the answer, with the specifics you saw>". Leave the editor on the page view in Run mode when you finish.`, {
        maxTurns: 14,
        readOnly: true,
        getTabId: async () => ctx.state.build?.tabId || null,
      }).catch((e) => ({ ok: false, reason: e.message }));
      if (ctx.round) ctx.round.readMs += Date.now() - tLook; // the navigator looking counts as reading
      const answer = String(found.reason || "").replace(/^\W*(DONE|FAILED):?\s*/i, "").slice(0, 1500);
      b.history.push(`looked: ${q.slice(0, 120)} → ${answer.slice(0, 160)}`);
      await ensureRunView(ctx, tabId).catch(() => {});
      const after = await screenshot(tabId, 1280).catch(() => null);
      decision = await supervise(ctx, { step, totalSteps, output, buttons: controls, timedOut, chatInputId, note: `${runNote}YOU ASKED THE NAVIGATOR TO LOOK: ${q}\nWHAT IT FOUND: ${found.ok ? answer : `couldn't find out (${answer || "no answer"})`}\nNow decide (don't ask to look at the same thing again).\n`, inspection, screen: after, chatTail });
      if (decision.action === "look") decision = { action: "wait", reason: "already looked this round" };
    }
    // Guard: never pause just because a step is long-running — there's no round/time limit.
    const longRunning = /\b(\d+\+?\s*(rounds?|attempts?|tries|messages|turns|iterations)|too many (rounds|attempts|tries|messages|turns)|taking (too )?long|long time|over \d+|more than \d+|for (a )?while|still (not )?(going|working|running))\b/i;
    const realBlocker = /credit|usage limit|credential|api key|client (id|secret)|google|oauth|sign[- ]?in|log ?in|account|payment|billing|upgrade|publish|delete|permission|access/i;
    if (decision.action === "need_human" && longRunning.test(decision.reason || "") && !realBlocker.test(decision.reason || "")) {
      await ctx.log("Not pausing just because the step is taking a while — there's no round limit. Nudging Scram's AI to carry on instead.");
      decision = { action: "reply", message: "Please continue where you left off and finish this step. If something isn't working, try a different approach.", reason: "keep going (no round limit)" };
    }
    // Guard: never accept a step the bot itself says it couldn't test. Ask once for the dev login /
    // what's missing; after that, the supervisor's own choice stands (normally need_human).
    if (blocked && decision.action === "step_complete" && !b.blockerAsked) {
      b.blockerAsked = true;
      await ctx.log("Not accepting the step yet: Scram's AI says some of it is untested (or it can't sign in).");
      decision = {
        action: "reply",
        message: "You said some of this is untested. If that's because you can't sign in (e.g. Google sign-in), add a temporary developer login now: email + password sign-in with seeded test accounts for each role and a known password, clearly marked DEV ONLY (remove before publishing), then log in with it and test the untested items. If you need something only I can provide (e.g. a Google Client ID/Secret or an API key), tell me exactly what and where it goes in Scram.",
        reason: "untested work",
      };
    }
  } catch (e) {
    // If the supervisor can't answer but a plan is waiting for approval, approve it rather than stall.
    if (!approveBtn) {
      if (!e.attempts && !e.apiError) throw e;
      // The retry ladder ran out: pause with choices (a fresh chat usually helps — smaller input).
      const refused = (e.attempts || []).some((a) => a.stop_reason === "refusal");
      const pe = new PauseError(
        refused
          ? `${e.message} Claude's safety checks sometimes flag ordinary build content by mistake. Choose what to do — a fresh Scram chat (much less old chat to read) usually gets past it; otherwise skip or redo the step.`
          : `${e.message} Choose what to do — starting a fresh Scram chat for this step is recommended (it shrinks what the supervisor has to read).`,
        { options: pauseOptions("fresh_chat") }
      );
      Object.assign(pe, { raw: e.raw, parseError: e.parseError, attempts: e.attempts });
      throw pe;
    }
    await ctx.log(`Supervisor unavailable (${e.message}) — approving the plan that's waiting.`);
    decision = { action: "click", elementId: approveBtn.id, reason: "fallback: plan waiting for approval" };
  }
  // Drift: the bot is doing another step's work — send it back (the round counts as no progress).
  const drift = driftOf(decision, step, totalSteps);
  if (drift && !dryRun) {
    b.driftedAt = `${b.step}:${(b.rounds || 0) + 1}`; // the next round gets a screenshot
    const where = `step ${drift.step}${drift.title ? ` (${drift.title})` : ""}`;
    await ctx.log(`⚠️ Scram's AI drifted to ${where} — sent it back to step ${step.stepNumber + 1}.`);
    b.drifts = (b.drifts || 0) + 1;
    const keep = decision;
    decision = {
      action: "reply",
      message: `Stop — that's ${where}, which comes later in the plan. Go back to step ${step.stepNumber + 1} ("${step.title}") and finish only what its step file asks for. Don't build ${where} yet; leave what you already started for it as it is, and we'll get to it in its own step.`,
      reason: `drift to ${where}`,
      drift,
      progress: [],
      learned: keep.learned,
    };
  }
  decision.progress = drift ? [] : [].concat(decision.progress || []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 300));
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  b.rounds += 1;
  const tAct = Date.now();
  const label = (id) => controls.find((e) => e.id === id)?.label || id;
  if (dryRun) {
    const what = Array.isArray(decision.actions) && decision.actions.length
      ? decision.actions.map((x) => `${x.action}${x.text ? ` “${String(x.text).slice(0, 60)}”` : ""}${x.message ? ` “${String(x.message).slice(0, 80)}”` : ""}${x.elementId ? ` [${label(x.elementId)}]` : ""}`).join(" → ")
      : `${decision.action}${decision.elementId ? ` [${label(decision.elementId)}]` : ""}${decision.message ? ` “${String(decision.message).slice(0, 160)}”` : ""}${decision.text ? ` “${String(decision.text).slice(0, 80)}”` : ""}${decision.summary ? ` (${decision.summary})` : ""}`;
    await ctx.log(`DRY RUN — would ${what}${reason}`);
    return { decision, text, dryRun: true };
  }

  // Multi-action answers (question forms): click options / fill fields / submit, in order.
  if (Array.isArray(decision.actions) && decision.actions.length) {
    for (const a of decision.actions.slice(0, 12)) {
      const el = controls.find((e) => e.id === a.elementId);
      if (a.action === "reply") {
        await sendMessage(ctx, tabId, String(a.message || ""));
        b.sentText = String(a.message || "");
      } else if (el && a.action === "type" && el.id !== chatInputId) {
        await dom(tabId, "typeText", { id: el.id, label: el.label, role: el.role }, String(a.text ?? ""));
      } else if (a.action === "new_chat") {
        await resendInNewChat(ctx, tabId, step, totalSteps, a.note || a.message);
        break; // the old chat's controls are gone
      } else if (a.action === "do_it_myself" && a.task) {
        const ok = await uiAgent(ctx, tabId, `In Scram's project editor, do exactly this: ${String(a.task).slice(0, 400)}. Use the editor's own controls. Do NOT type in or send anything with the AI chat box. Never publish, deploy, delete, pay, invite people or change account settings. Finish with done when it's visibly done, or fail if it isn't possible.`, { maxSteps: 12, optional: true }).catch(() => false);
        await ctx.log(ok ? `Done it myself: ${a.task}` : `Tried to do it myself but couldn't — giving up on: ${a.task}`);
      } else if (a.action === "preview_size") {
        const ok = await setPreviewSize(ctx, tabId, a.size).catch(() => false);
        await ctx.log(ok ? `Switched Scram's preview to ${a.size}.` : `Couldn't switch Scram's preview to ${a.size || "that size"}.`);
      } else if (el && a.action === "click" && !el.editable && RUN_ASK_OPTION.test((el.label || "").trim()) && !GO_AHEAD_OPTION.test(el.label || "") && !/^\W*(run|edit)$/i.test((el.label || "").trim())) {
        await answerRunOption(ctx, tabId, controls, el, chatInputId);
      } else if (el && a.action === "click" && isPreviewSizeControl(el.label)) {
        const size = (el.label.match(/desktop|tablet|mobile/i) || [])[0];
        if (size) await setPreviewSize(ctx, tabId, size.toLowerCase()).catch(() => false);
        else await dom(tabId, "click", { id: el.id, label: el.label, role: el.role });
      } else if (el && a.action === "click" && /^\W*(run|edit)$/i.test((el.label || "").trim())) {
        await ensureRunMode(ctx, tabId, { force: true });
      } else if (el && a.action === "click") {
        await dom(tabId, "click", { id: el.id, label: el.label, role: el.role });
      }
      await sleep(600);
    }
    const summary = decision.actions.map((a) => `${a.action}${a.text ? ` “${String(a.text).slice(0, 40)}”` : ""}${a.elementId ? ` ${controls.find((e) => e.id === a.elementId)?.label || a.elementId}` : ""}`).join(", ");
    await ctx.log(`Answering Scram's form: ${summary}${reason}`);
    b.history.push(`answered form: ${summary.slice(0, 200)}`);
    if (!decision.actions.some((a) => a.action === "new_chat")) b.baseline = text; // a new chat set its own
    decision.action = "multi";
  }

  switch (decision.action) {
    case "reply": {
      const msg = String(decision.message || "Please continue where you left off.");
      // Scram is waiting on a question form about Run, and the reply only says Run is on: answer
      // through the form ("go ahead when it's up") — the chat box may not work while it's open.
      const goAhead = goAheadOption(controls, chatInputId);
      if (goAhead && /\brun\b/i.test(msg)) {
        await ensureRunMode(ctx, tabId, { force: true }).catch(() => {});
        await ctx.log(`Scram is asking about Run mode — Run is on, so answering its question with “${goAhead.label}” instead of typing${reason}`);
        await realClick(tabId, { id: goAhead.id, label: goAhead.label }).catch(() => dom(tabId, "click", { id: goAhead.id, label: goAhead.label, role: goAhead.role }));
        b.history.push(`answered Scram's Run question: ${goAhead.label}`);
        b.baseline = text;
        b.sentText = goAhead.label;
        decision.action = "click";
        break;
      }
      if (/continue where (you|it) left off|carry on where/i.test(msg)) b.nudges = (b.nudges || 0) + 1;
      await ctx.log(`Replying to Scram: “${msg.slice(0, 140)}”${reason}`);
      b.history.push(`replied: ${msg.slice(0, 200)}`);
      b.baseline = text;
      b.sentText = msg;
      await sendMessage(ctx, tabId, msg);
      break;
    }
    case "type": {
      const el = controls.find((e) => e.id === decision.elementId);
      if (el && el.id !== chatInputId) await dom(tabId, "typeText", { id: el.id, label: el.label, role: el.role }, String(decision.text ?? ""));
      await ctx.log(`Filling “${el?.label || decision.elementId}” in Scram${reason}`);
      b.history.push(`typed into ${el?.label || decision.elementId}: ${String(decision.text ?? "").slice(0, 80)}`);
      b.baseline = text;
      break;
    }
    case "do_it_myself": {
      const task = String(decision.task || "").trim().slice(0, 400);
      if (/\b(chat|conversation)s?\b[^.]{0,60}\b(history|list|re-?open|open|new|switch|previous|earlier)\b|\b(history|re-?open|new)\b[^.]{0,40}\bchat/i.test(task)) {
        // Chats are handled one way only: a fresh chat with the +, then the step re-sent.
        await resendInNewChat(ctx, tabId, step, totalSteps, decision.message);
        decision.action = "reply";
        break;
      }
      decision.action = "reply";
      b.baseline = text;
      if (!task) break;
      b.selfTasks ||= [];
      const tried = b.selfTasks.find((t) => store.similarity(t.task, task) >= 0.7);
      let ok = false;
      if (!tried || tried.ok) { // only a task that already failed is skipped; one that worked is simply done again
        await ctx.log(`Scram's AI can't do this, so I'll try it myself: ${task}${reason}`);
        ok = await uiAgent(
          ctx,
          tabId,
          `In Scram's project editor, do exactly this: ${task}. Use the editor's own controls (buttons, toggles, menus, panels, the preview). Do NOT type in or send anything with the AI chat box ("Ask Claude…"), and don't change anything else. Never publish, deploy, delete, pay, invite people or change account settings. Finish with done as soon as it's visibly done; if it isn't possible after a few tries, finish with fail.`,
          { maxSteps: 12, optional: true }
        ).catch(() => false);
        if (tried) tried.ok = ok;
        else b.selfTasks.push({ task, ok });
        if (!tried) await store.addLessons(
          [ok ? `Scram's bot can't do this itself, but the extension can (do_it_myself): ${task}` : `Neither Scram's bot nor the extension could do this — skip it: ${task}`],
          `step ${step.stepNumber + 1}: ${step.title}`
        );
        await ctx.log(ok ? `Done it myself: ${task}` : `Tried to do it myself but couldn't — giving up on: ${task}`);
      }
      const msg = ok
        ? String(decision.message || `I've done that for you in the editor (${task}). Please carry on.`)
        : `That can't be done from here (${task}), so skip that part and carry on with the rest of this step. Tell me what you could and couldn't verify.`;
      b.history.push(`${ok ? "did it myself" : "couldn't do it myself"}: ${task.slice(0, 120)}; replied: ${msg.slice(0, 120)}`);
      b.sentText = msg;
      await ctx.log(`Replying to Scram: “${msg.slice(0, 140)}”`);
      await sendMessage(ctx, tabId, msg);
      break;
    }
    case "new_chat": {
      await resendInNewChat(ctx, tabId, step, totalSteps, decision.note || decision.message);
      decision.action = "reply";
      break;
    }
    case "preview_size": {
      // Scram's AI can't resize the preview: the extension switches it, then passes the message on.
      const size = String(decision.size || "").toLowerCase();
      const ok = await setPreviewSize(ctx, tabId, size).catch(() => false);
      const msg = ok
        ? String(decision.message || `The preview is now at ${size} size — check this step's items at this size and report back.`)
        : `I couldn't switch the preview to ${size || "that size"}, so skip that size check for now and carry on with the rest of the step.`;
      b.history.push(`${ok ? `switched the preview to ${size}` : `couldn't switch the preview to ${size}`}; replied: ${msg.slice(0, 120)}`);
      b.baseline = text;
      b.sentText = msg;
      await ctx.log(`${ok ? `Switched Scram's preview to ${size}` : `Couldn't switch Scram's preview to ${size}`}. Replying to Scram: “${msg.slice(0, 140)}”`);
      await sendMessage(ctx, tabId, msg);
      decision.action = "reply";
      break;
    }
    case "click": {
      const el = controls.find((e) => e.id === decision.elementId);
      if (el && !el.editable && RUN_ASK_OPTION.test((el.label || "").trim()) && !GO_AHEAD_OPTION.test(el.label || "") && !/^\W*(run|edit)$/i.test((el.label || "").trim())) {
        await answerRunOption(ctx, tabId, controls, el, chatInputId);
        b.history.push(`didn't pick “${el.label}” (Scram's AI can't open Run) — switched Run on myself and told it to test`);
        b.baseline = text;
        decision.action = "reply";
        break;
      }
      if (el && isPreviewSizeControl(el.label)) {
        // The size menu needs real clicks: switch it the reliable way.
        const size = (el.label.match(/desktop|tablet|mobile/i) || [])[0];
        const ok = size ? await setPreviewSize(ctx, tabId, size.toLowerCase()).catch(() => false) : false;
        if (!size) await dom(tabId, "click", { id: el.id, label: el.label, role: el.role });
        b.history.push(size ? `${ok ? "switched" : "couldn't switch"} the preview to ${size}` : `clicked: ${el.label}`);
        b.baseline = text;
        break;
      }
      if (/^\W*(run|edit)$/i.test((el?.label || "").trim())) {
        // The Edit/Run toggle is ours to manage (a script click doesn't work on it anyway).
        await ensureRunMode(ctx, tabId, { force: true });
        const msg = "Run mode is on now — please carry on.";
        await ctx.log(`Replying to Scram: “${msg}”`);
        b.history.push(`switched Scram to Run mode; replied: ${msg}`);
        b.baseline = text;
        b.sentText = msg;
        await sendMessage(ctx, tabId, msg);
        decision.action = "reply";
        break;
      }
      await ctx.log(`Clicking “${el?.label || decision.elementId}” in Scram${reason}`);
      b.history.push(`clicked: ${el?.label || decision.elementId}`);
      b.baseline = text;
      if (el) await dom(tabId, "click", { id: el.id, label: el.label, role: el.role });
      break;
    }
    default:
      break;
  }
  if (ctx.round) ctx.round.actMs += Date.now() - tAct;
  return { decision, text };
}

// ---- halves: when the bot struggles with a step, hand it the checklist in two parts.
const checklistItems = (content) => [...String(content).matchAll(/^\s*[-*]\s*\[[ xX]\]\s*(.+)$/gm)].map((m) => m[1].trim());

function struggling(ctx) {
  const b = ctx.state.build;
  // No limit on rounds per step (a step runs until it's confirmed); a long step only gets its
  // checklist handed over in two halves.
  return b.rounds >= 13 || (b.nudges || 0) >= 2;
}

async function startHalves(ctx, tabId, step) {
  const b = ctx.state.build;
  const items = checklistItems(step.content);
  if (items.length < 4) return false;
  const mid = Math.ceil(items.length / 2);
  b.chunk = { part: 1, parts: [items.slice(0, mid), items.slice(mid)] };
  const msg = `This step is a lot at once, so let's do it in two halves. For now, build and test ONLY these items, then report back on each:\n${b.chunk.parts[0].map((t, i) => `${i + 1}. ${t}`).join("\n")}\nI'll give you the rest once these work.`;
  await ctx.log(`Scram's AI is struggling with this step — splitting it into two halves (part 1: ${b.chunk.parts[0].length} items).`);
  b.history.push(`split the step into halves; sent part 1 (${b.chunk.parts[0].length} items)`);
  b.sentText = msg;
  await sendMessage(ctx, tabId, msg);
  return true;
}

async function nextHalf(ctx, tabId) {
  const b = ctx.state.build;
  b.chunk.part = 2;
  const msg = `Great — part 1 is done. Now build and test the rest of this step, then report back on each:\n${b.chunk.parts[1].map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
  await ctx.log(`Part 1 confirmed — sending part 2 (${b.chunk.parts[1].length} items).`);
  b.history.push(`part 1 confirmed; sent part 2 (${b.chunk.parts[1].length} items)`);
  b.sentText = msg;
  await sendMessage(ctx, tabId, msg);
}

// Progress per step: a round counts as progress only when a checklist item is newly verified
// (the supervisor's "progress" field). Drift and everything else count as no progress — except
// waiting while Scram's AI is visibly still generating. After maxStuckRounds rounds without
// progress: a fresh Scram chat with the step file re-sent; after as many again: pause with choices.
// Returns true when it took over the round (fresh chat sent).
async function trackProgress(ctx, tabId, step, total, decision) {
  const b = ctx.state.build;
  const seen = new Set((b.verified || []).map((v) => v.toLowerCase()));
  const fresh = (decision.progress || []).filter((p) => !seen.has(p.toLowerCase()));
  const stillWorking = decision.action === "wait" && /still (working|generating)/i.test(decision.reason || "");
  if (fresh.length && !decision.drift) {
    b.verified = [...(b.verified || []), ...fresh].slice(-60);
    b.noProgress = 0;
    await ctx.log(`✔ Verified on step ${step.stepNumber + 1}: ${fresh.join("; ").slice(0, 400)}`);
    return false;
  }
  if (stillWorking) return false;
  b.noProgress = (b.noProgress || 0) + 1;
  const max = Math.max(3, Math.round(Number(ctx.settings.maxStuckRounds)) || 12);
  if (b.noProgress < max) return false;
  b.noProgress = 0;
  if (!b.stuckFreshChat) {
    b.stuckFreshChat = true;
    await ctx.log(`⚠️ Step ${step.stepNumber + 1} has gone ${max} rounds without a newly verified checklist item — starting a fresh Scram chat and re-sending the full step file.`);
    ctx.notify("Fresh Scram chat", `Step ${step.stepNumber + 1} was stuck for ${max} rounds, so RoboBuild started a fresh Scram chat for it.`);
    const done = (b.verified || []).length ? `Already verified in the old chat: ${b.verified.join("; ")}.` : "Nothing on the checklist was verified in the old chat.";
    await resendInNewChat(ctx, tabId, step, total, `The old chat went ${max} rounds without progress. ${done}`);
    await ctx.save({ build: b });
    return true;
  }
  await ctx.save({ build: b });
  throw new PauseError(
    `Step ${step.stepNumber + 1} (${step.title}) is stuck: ${max * 2} rounds without a newly verified checklist item, even after a fresh Scram chat. Choose what to do.`,
    { options: pauseOptions("fresh_chat") }
  );
}

// One round of the conversation. Returns false when every step is done.
export async function buildRound(ctx) {
  const b = ctx.state.build;
  const steps = await store.getSteps(ctx.state.siteUrl);
  b.totalSteps = steps.length;
  // Steps skipped from the RoboBuild chat.
  while (b.step < steps.length && (b.skipSteps || []).includes(steps[b.step].stepNumber)) {
    await ctx.log(`🧭 Steering from chat: skipping step ${b.step + 1} (${steps[b.step].title}).`);
    b.step += 1;
    b.sentStep = null;
  }
  if (b.step >= steps.length) return reviewRound(ctx, steps); // all steps built: final design review
  if (!b.socialLoginNoticed) {
    b.socialLoginNoticed = true;
    const social = steps.find((x) => /\b(google|social|oauth)\b[^.\n]{0,40}\b(sign[- ]?in|log ?in|login|auth|provider)\b|\blogin with social provider\b/i.test(x.content));
    if (social) {
      const msg = `This app uses Google/social sign-in (step ${social.stepNumber + 1}: ${social.title}). Scram's AI can't sign in with Google while testing, so a temporary dev login is built for testing, but Google itself must be set up by you. When you can: in Scram open More → Users → Add Provider → Google, copy the Dev and Live callback URLs, create an OAuth 2.0 Client ID (Web application) in Google Cloud Console with those redirect URIs, then paste the Client ID and Secret back into Scram's Users panel. I'll pause and ask you if testing gets blocked on it.`;
      await ctx.log(`🔑 ${msg}`);
      ctx.notify("Google sign-in needs you", "This app uses Google sign-in, which only you can set up in Scram (Users → Add Provider → Google). See the Autopilot log for the steps.");
    }
  }
  const step = steps[b.step];

  const tabId = await ensureScramTab(ctx);
  if (!b.projectReady) {
    await ctx.save({ phase: "scram-setup" });
    return true;
  }

  // "Start a fresh Scram chat" (a pause choice): a new chat, then the step file again.
  if (b.freshChat) {
    b.freshChat = false;
    b.noProgress = 0;
    if (b.sentStep === b.step) {
      await resendInNewChat(ctx, tabId, step, steps.length, "You chose a fresh chat for this step.");
      await ctx.save({ build: b });
      return true;
    }
    await ctx.log("Starting a fresh Scram chat for this step (your choice)…");
    await startNewChat(ctx, tabId).catch(() => false);
  }

  startRoundTiming(ctx);
  if (b.sentStep !== b.step) {
    await ensureRunMode(ctx, tabId).catch(() => {});
    await keepDesktop(ctx, tabId);
    await ctx.log(`Sending step ${step.stepNumber + 1}/${steps.length}: ${step.title}`);
    b.baseline = (await dom(tabId, "bodyText")) || "";
    const message = await sendStep(ctx, tabId, step, steps.length);
    b.sentStep = b.step;
    b.sentText = message;
    b.rounds = 0;
    b.history = [];
    b.selfTasks = [];
    b.sentMessages = [];
    b.chunk = null;
    b.nudges = 0;
    b.inspectedRound = null;
    b.designAsks = 0;
    b.blockerAsked = false;
    b.noProgress = 0;
    b.verified = [];
    b.stuckFreshChat = false;
    b.drifts = 0;
    await ctx.save({ build: b });
    const p = await store.getProgress(ctx.state.siteUrl);
    await store.setProgress({ ...p, currentStep: step.stepNumber });
  }

  if (!b.chunk && b.rounds > 0 && struggling(ctx)) await startHalves(ctx, tabId, step);
  await ctx.log(`Waiting for Scram's bot (step ${step.stepNumber + 1}, round ${b.rounds + 1})…`);
  const epoch = b.steerEpoch || 0;
  const { decision, text } = await superviseRound(ctx, tabId, step, steps.length);
  await logRoundTiming(ctx, step).catch(() => {});
  // Steered to another step while this round ran: its result belongs to the old step.
  if ((b.steerEpoch || 0) !== epoch) {
    b.baseline = text;
    await ctx.save({ build: b });
    return true;
  }
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  if (decision.action !== "step_complete" && (await trackProgress(ctx, tabId, step, steps.length, decision))) return true;

  switch (decision.action) {
    case "reply":
    case "click":
    case "type":
    case "multi":
      break; // already carried out by superviseRound
    case "step_complete": {
      if (b.chunk?.part === 1 && b.chunk.parts[1].length) {
        b.baseline = text;
        await nextHalf(ctx, tabId);
        break;
      }
      b.chunk = null;
      const p = await store.getProgress(ctx.state.siteUrl);
      const completed = [...new Set([...(p.completedSteps || []), step.stepNumber])].sort((x, y) => x - y);
      await store.setProgress({ ...p, completedSteps: completed, currentStep: step.stepNumber + 1 });
      await ctx.log(`✓ Step ${step.stepNumber + 1} confirmed: ${decision.summary || step.title}`);
      // Leave the preview at Desktop for the next step.
      if (["tablet", "mobile"].includes(await previewSizeNow(tabId).catch(() => null))) await setPreviewSize(ctx, tabId, "desktop").catch(() => {});
      // A step redone (or inserted) from the chat: go back to where the build was.
      if (b.returnTo != null) {
        b.step = b.returnTo;
        b.returnTo = null;
        b.redo = null;
      } else b.step += 1;
      b.sentStep = null;
      b.baseline = text;
      break;
    }
    case "need_human":
      // After Resume, only react to what appears from now on (not the old "out of credits" line).
      b.baseline = text;
      b.history.push(`paused for the human: ${decision.reason || ""}`.slice(0, 200));
      await ctx.save({ build: b });
      throw new PauseError(`Scram step ${step.stepNumber + 1}: ${decision.reason || "needs your input"}`);
    case "wait":
    default:
      await ctx.log(`Letting Scram keep working${reason}`);
      b.history.push("waited");
      for (let i = 0; i < 3 && !(ctx.state.notes || []).some((n) => !n.seen); i++) await sleep(1000);
  }

  await ctx.save({ build: b });
  return true;
}

// ------------------------------------------------------------------ final review (after the build)
// After the last step the EXTENSION itself tests the finished app in Run mode like a picky human:
// it crawls the app's pages, clicks its buttons and menus and watches what happens, screenshots
// each page (plus a phone-width pass) and runs a layout check. Claude nitpicks all of that into
// one fix list for Scram's AI; once it reports the fixes done, the extension tests again.
// Nothing here runs during the build itself.

const REVIEW_PASSES = 3;
const MAX_PAGES = 8;
const CLICKS_PER_PAGE = 8;

const DESIGN_REVIEW_SYSTEM = `You are a picky, experienced UI designer and QA tester reviewing a web app that an AI builder has just finished making (a clone of another site's core features, built in Scram). You tested it yourself in its running preview: you get screenshots of its pages (at desktop size) and of things that opened when clicked, an automatic layout check per page, and a log of what happened when each button/menu was clicked. Judge it as a demanding human user would: does it work, is it pleasant and clear to look at, consistent, and does everything look intentional? Nitpick, but only about real problems.

Functional problems count too: buttons that do nothing, clicks that show errors or broken text (undefined, NaN, null, lorem ipsum), menus/popovers that open off screen, links that go to blank or broken pages, missing pages a core feature needs.

Look for real problems: menus/dropdowns/popovers running off the screen or page; things shown twice that shouldn't be (two headers or nav bars, a repeated section, button, card, list item or title); overlapping or cut-off text; broken images; hard-to-read text (contrast); cramped, uneven or misaligned spacing; inconsistent styling (fonts, colours, button styles, corner radius) between pages; elements that look unfinished, placeholder or off-brand; empty or blank areas; layouts that break at desktop size (sideways scrolling, squashed or overflowing content). The screenshots are at desktop size, so judge the desktop layout; don't guess about other sizes. The automatic findings can be false alarms: confirm each against the screenshots and drop the ones that aren't real.

Return ONLY JSON: {"verdict":"good"|"fix","summary":"<one line>","issues":[{"page":"<page name or path>","problem":"<what is wrong, specifically, where>","fix":"<what it should look like instead>"}]}
List at most 12 issues, most important first, each specific enough for the builder to find and fix (page, element, what's wrong, what it should do/look like). If everything works and looks good, return verdict "good" and no issues.`;

async function lookAtApp(ctx, tabId) {
  await ensureRunMode(ctx, tabId).catch(() => {});
  if ((await previewSizeNow(tabId).catch(() => null)) !== "desktop") await setPreviewSize(ctx, tabId, "desktop").catch(() => {});
  let pf = await dom(tabId, "previewFrame").catch(() => null);
  if (pf && pf.covered >= 0.3) {
    await closePlansPanel(ctx, tabId).catch(() => {});
    await closeKnownPanels(ctx, tabId).catch(() => {});
    await sleep(800);
    pf = await dom(tabId, "previewFrame").catch(() => null);
  }
  if (!pf) return null;
  const fid = await previewFrameId(tabId, pf);
  const views = []; // { label, audit, image, clicks: [{label, effect, issues}], extraImages: [] }
  const shot = async () => capturePreview(tabId, (await dom(tabId, "previewFrame").catch(() => null)) || pf).catch(() => null);
  if (fid == null) {
    views.push({ label: "current page (desktop)", audit: await auditPreview(tabId, pf), image: await shot(), clicks: [] });
    return views;
  }
  // Crawl the app's pages (breadth-first over its in-app links).
  const start = (await previewLinks(tabId, fid, 1).catch(() => []))[0];
  const queue = start ? [start] : [];
  const seen = new Set(queue.map((u) => u.split("#")[0]));
  const tried = new Set(); // control labels already tried (headers/nav repeat on every page)
  while (queue.length && views.length < MAX_PAGES) {
    ctx.checkStop();
    const url = queue.shift();
    await navigatePreview(tabId, fid, url);
    const audit = await auditFrame(tabId, fid);
    const page = audit?.url ? new URL(audit.url).pathname : url;
    await ctx.log(`🧪 Testing the app: ${page}`);
    const view = { label: `${page} (desktop)`, audit, image: await shot(), clicks: [], extraImages: [] };
    for (const link of await previewLinks(tabId, fid, 12).catch(() => [])) {
      const key = link.split("#")[0];
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(link);
      }
    }
    // Use it: click its buttons and menus one by one, and watch what happens.
    const controls = ((await runProbe(tabId, fid, "list")) || []).filter((c) => c.label && !tried.has(c.label));
    for (const c of controls.slice(0, CLICKS_PER_PAGE)) {
      ctx.checkStop();
      tried.add(c.label);
      const fresh = (await runProbe(tabId, fid, "list")) || [];
      const idx = fresh.findIndex((x) => x.label === c.label);
      if (idx < 0) continue;
      const res = await runProbe(tabId, fid, "click", idx);
      if (!res) {
        view.clicks.push({ label: c.label, effect: "left the app page (full navigation)", issues: [] });
      } else {
        view.clicks.push(res);
        if ((res.issues?.length || res.opened) && view.extraImages.length < 2 && res.issues?.length) {
          const img = await shot();
          if (img) view.extraImages.push({ label: `${page} after clicking “${res.label}”`, image: img });
        }
      }
      await runProbe(tabId, fid, "restore", 0, url);
      await sleep(400);
      const now = await auditFrame(tabId, fid);
      if (now?.url && now.url.split("#")[0] !== url.split("#")[0]) await navigatePreview(tabId, fid, url);
    }
    views.push(view);
  }
  if (start) await navigatePreview(tabId, fid, start);
  await dom(tabId, "scrollChatToBottom").catch(() => {});
  return views;
}

async function designReview(ctx, tabId) {
  const views = await lookAtApp(ctx, tabId);
  if (!views?.length) {
    await ctx.log("🧪 Couldn't see the running app (is the page view showing?) — skipping the final review.");
    return null;
  }
  const clicks = views.reduce((n, v) => n + v.clicks.length, 0);
  const found = views.reduce((n, v) => n + (v.audit?.issues?.length || 0) + v.clicks.reduce((m, c) => m + (c.issues?.length || 0), 0), 0);
  await ctx.log(`🧪 Tested ${views.length} view(s) of the app and clicked ${clicks} button(s)/menu(s): ${found} automatic finding(s). Reviewing it all like a picky user…`);
  const sc = ctx.state.scope;
  const images = [];
  for (const v of views) {
    if (v.image) images.push({ label: v.label, image: v.image });
    for (const x of v.extraImages || []) images.push(x);
  }
  const used = images.slice(0, 12);
  const brief = (await store.get("designBriefs", {}))[ctx.state.siteUrl];
  const designNote = brief
    ? `THE DESIGN CONCEPT the app must follow (check it does: palette, fonts, shape language, signature element, voice; report screens that look generic or off-concept, e.g. default white background, default blue buttons, plain cards):\n${brief.content.slice(0, 8000)}\n\n`
    : "";
  const content = [
    {
      type: "text",
      text: `App being tested: a clone of ${ctx.state.siteUrl}${sc?.core?.length ? ` (core features: ${sc.core.map((f) => f.name).join(", ")})` : ""}.\n\n${designNote}${views
        .map((v, i) => `VIEW ${i + 1}: ${v.label}\nLayout check: ${describeIssues(v.audit)}\n${v.clicks.length ? `What happened when I used it:\n${v.clicks.map((c) => `- clicked “${c.label}”: ${c.effect}${c.issues?.length ? ` — PROBLEM: ${c.issues.join("; ")}` : ""}`).join("\n")}` : "(no buttons tried here)"}`)
        .join("\n\n")}\n\nScreenshots follow, in this order: ${used.map((x, i) => `${i + 1}) ${x.label}`).join("; ")}.`,
    },
    ...used.map((x) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: x.image } })),
  ];
  return askJson({ what: "Final review", system: DESIGN_REVIEW_SYSTEM, userContent: content, maxTokens: 9000, ...operator(ctx) });
}

async function reviewRound(ctx, steps) {
  const b = ctx.state.build;
  const r = (b.review ||= { pass: 0, fixing: false, done: false });
  if (r.done || ctx.settings.finalDesignReview === false) return false;
  const tabId = await ensureScramTab(ctx);
  if (!r.fixing) {
    if (r.pass >= REVIEW_PASSES) {
      r.done = true;
      await ctx.save({ build: b });
      return false;
    }
    r.pass += 1;
    await ctx.log(`🧪 Final review (round ${r.pass} of ${REVIEW_PASSES}): every step is built — I'm testing the finished app myself in Run mode, like a picky user…`);
    const found = await designReview(ctx, tabId).catch(async (e) => {
      await ctx.log(`🧪 Final review failed (${e.message}) — finishing without it.`);
      return null;
    });
    const issues = Array.isArray(found?.issues) ? found.issues.filter((i) => i?.problem).slice(0, 10) : [];
    if (!issues.length || found?.verdict === "good") {
      if (found) await ctx.log(`🧪 ${found.summary || "The app works and looks good"} — nothing left to fix.`);
      r.done = true;
      await ctx.save({ build: b });
      return false;
    }
    const list = issues.map((i, n) => `${n + 1}. ${i.page ? `[${i.page}] ` : ""}${i.problem}${i.fix ? ` → ${i.fix}` : ""}`).join("\n");
    await ctx.log(`🧪 Found ${issues.length} thing(s) to fix: ${issues.slice(0, 3).map((i) => i.problem).join("; ")}${issues.length > 3 ? "; …" : ""}. Telling Scram's AI what's wrong and asking it to fix them.`);
    r.step = {
      stepNumber: steps.length,
      title: "Final review fixes",
      content: `# Final review fixes\n\n## Objective\nThe whole app is built. Fix these problems I found by using the running app myself, without breaking or changing anything else.\n\n## Testing checklist\n${issues.map((i) => `- [ ] ${i.page ? `[${i.page}] ` : ""}${i.problem}`).join("\n")}`,
    };
    b.baseline = (await dom(tabId, "bodyText").catch(() => "")) || "";
    const message = `Final review: the whole app is built, and I've been through the running app myself, clicking around it like a user. These need fixing (don't change anything else), then report back briefly:\n${list}`;
    await ensureRunMode(ctx, tabId).catch(() => {});
    await sendMessage(ctx, tabId, message);
    b.sentText = message;
    b.rounds = 0;
    b.history = [];
    b.sentMessages = [message];
    b.nudges = 0;
    r.fixing = true;
    await ctx.save({ build: b });
    return true;
  }
  await ctx.log(`Waiting for Scram's bot (final review fixes, round ${b.rounds + 1})…`);
  const { decision, text } = await superviseRound(ctx, tabId, r.step, steps.length + 1);
  if (decision.action === "step_complete") {
    r.fixing = false;
    b.baseline = text;
    await ctx.log(`✓ Scram's AI reports the fixes done${r.pass < REVIEW_PASSES ? " — testing the app again" : ""}.`);
    if (r.pass >= REVIEW_PASSES) r.done = true;
  } else if (decision.action === "need_human") {
    b.baseline = text;
    await ctx.save({ build: b });
    throw new PauseError(`Final review: ${decision.reason || "needs your input"}`);
  } else if (decision.action === "wait") {
    await sleep(3000);
  }
  await ctx.save({ build: b });
  return !r.done;
}
