// Autopilot phases 3–4: open Scram, get a project open with the AI chat visible,
// then feed the step files one at a time — reading the Scram bot's replies and
// answering questions / approving plans / pushing for testing, until each step is
// confirmed done. Scram's DOM isn't a public API, so UI navigation is done by a
// small Claude-driven agent that reads the page's controls and picks actions.

import * as store from "./storage.js";
import { askJson, loadPrompt } from "./jobs.js";
import { dom, sleep, waitForLoad } from "./dom.js";
import { PauseError } from "./errors.js";
import { attachToScram, rememberMethod, ALL_METHODS, realClick, realEnter } from "./scram-attach.js";

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
  const tab = await chrome.tabs.create({ url: SCRAM_URL, active: true });
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
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    ctx.checkStop();
    const snap = await dom(tabId, "snapshot", { maxElements: 40, maxText: 800 }).catch(() => null);
    const loginLike = snap && (snap.hasPassword || /log ?in|sign ?in/i.test(snap.title) || /\/(login|signin|sign-in|auth)\b/i.test(snap.url));
    if (snap && !loginLike) return;
    if (!warned) {
      warned = true;
      await ctx.log("Scram needs you to log in — log in in the Scram tab and Autopilot will carry on by itself.");
      ctx.notify("Log in to Scram", "Autopilot is waiting for you to log in to Scram in the tab it opened.");
    }
    if (Date.now() > deadline) throw new PauseError("Timed out waiting for a Scram login.");
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

Scram's editor: the normal page view shows the page with "Edit" / "▷ Run" buttons at its top right and a "Frontend …" tab top left. Opening a workflow, data type or other sub-view replaces it with a canvas that has a "‹ Back" button and a breadcrumb at its top left — click "Back" (repeatedly if nested) to return to the page view. "More" (top left) opens the project overview.

Rules: never publish to Live, deploy to production, delete anything, buy/upgrade/change billing, invite people, or change account settings. Pick the most direct path. If a dialog blocks progress, handle it or close it. Don't repeat an action that didn't work — try something else.`;

// The UI agent's instructions, plus the navigation guide written by "Explore Scram" (if any).
async function uiAgentSystem() {
  const k = await store.get("scramKnowledge", null);
  return k?.text ? `${UI_AGENT_SYSTEM}\n\nScram navigation guide (learned by exploring Scram — trust it):\n${k.text.slice(0, 8000)}` : UI_AGENT_SYSTEM;
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

export async function uiAgent(ctx, startTabId, goal, { maxSteps = 20, optional = false } = {}) {
  const history = [];
  let tabId = startTabId;
  const knownIds = new Set((await store.scramTabs()).map((t) => t.id));
  for (let i = 0; i < maxSteps; i++) {
    ctx.checkStop();
    tabId = (await followNewScramTab(ctx, knownIds)) || ctx.state.build.tabId || tabId;
    const snap = await dom(tabId, "snapshot", { maxElements: 220, maxText: 2500, pointer: true });
    const lines = snap.elements.map((e) =>
      [e.id, e.role || e.tag, JSON.stringify(e.label || ""), e.editable ? "editable" : "", e.disabled ? "disabled" : "", e.inLayer ? "in-dialog" : "", e.href ? `href=${e.href}` : ""].filter(Boolean).join(" | ")
    );
    const userContent = `GOAL: ${goal}

Actions so far:
${history.map((h, n) => `${n + 1}. ${h}`).join("\n") || "(none)"}

URL: ${snap.url}
Title: ${snap.title}
Open dialogs/menus: ${snap.layers.map((l) => `[${l.role}] ${l.text.slice(0, 400)}`).join(" || ") || "(none)"}

Visible text (start):
${snap.text}

Interactive elements (id | role | label | flags):
${lines.join("\n")}`;
    const act = await askJson({ what: "Scram UI agent", system: await uiAgentSystem(), userContent, maxTokens: 1200 });
    const target = snap.elements.find((e) => e.id === act.id);
    const desc = `${act.action}${target ? ` "${target.label}"` : ""}${act.text ? ` ← "${String(act.text).slice(0, 60)}"` : ""}${act.key ? ` ${act.key}` : ""} — ${act.reason || ""}`;
    history.push(desc);
    await ctx.log(`Scram UI: ${desc}`);

    if (act.action === "done") return true;
    if (act.action === "fail") {
      if (optional) return false;
      throw new PauseError(`Couldn't do this in Scram: ${goal.split(".")[0]} — ${act.reason}`);
    }
    // Real (trusted) clicks: many of Scram's controls ignore script clicks.
    if (act.action === "click" && target) await realClick(tabId, { id: target.id, label: target.label }).catch(() => dom(tabId, "click", { id: target.id, label: target.label, role: target.role }));
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
  if (await dom(tabId, "closePanel", "^plans$").catch(() => false)) await sleep(1000);
  try {
    const more = (await dom(tabId, "findText", "^more$", { maxLen: 10 }))[0];
    if (more) {
      await realClick(tabId, { id: more.id, label: more.label });
      await sleep(2000);
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

export async function sendMessage(ctx, tabId, text) {
  await assertInEditor(tabId);
  if (!(await dom(tabId, "findChatInput"))) await showEditorHome(ctx, tabId);
  let inputId = await dom(tabId, "findChatInput");
  if (!inputId) {
    await uiAgent(ctx, tabId, "Open the AI chat panel (the \"Chat\" panel on the left of the project editor) so its \"Ask Claude...\" message box is visible. Do not send anything.", { maxSteps: 8 });
    tabId = ctx.state.build.tabId || tabId;
    inputId = await dom(tabId, "findChatInput");
    if (!inputId) throw new PauseError("Couldn't find Scram's AI chat input.");
  }
  const typed = await dom(tabId, "typeText", inputId, text);
  if (!typed?.ok) throw new PauseError("Couldn't type into Scram's AI chat input.");
  await sleep(700);

  const stillThere = async () => {
    const v = await dom(tabId, "inputValue", inputId);
    return v != null && v.trim().length > 0 && text.startsWith(v.trim().slice(0, 40));
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
  // Remembered so the supervisor can't send the same request twice in a step (loop guard).
  const bs = ctx.state.build;
  if (bs) bs.sentMessages = [...(bs.sentMessages || []), String(text).slice(0, 1500)].slice(-10);
}

// Wait until Scram's bot has finished replying. Watches only the CHAT PANEL (other parts of
// Scram's page — preview, status indicators — keep changing and would make it wait forever),
// and returns quickly when Scram is visibly waiting on us (Approve plan, answer options…).
async function waitForIdle(ctx, tabId, baseline) {
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
  const pageGrace = Math.max(30, s.scramIdleSeconds * 2);
  for (;;) {
    ctx.checkStop();
    await sleep(3000);
    const chat = norm((await dom(tabId, "chatText").catch(() => "")) || "");
    const pageText = (await dom(tabId, "bodyText").catch(() => "")) || "";
    const page = norm(pageText);
    const generating = await dom(tabId, "isGenerating").catch(() => false);
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
    const done = () => ({ text: pageText, timedOut: false });
    // You sent Autopilot a message: stop waiting and let the supervisor act on it now.
    if ((ctx.state.notes || []).some((n) => !n.seen)) return done();
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
    // Normal finish: the whole page (chat included) has gone quiet.
    if (chatQuiet >= s.scramIdleSeconds && pageQuiet >= s.scramIdleSeconds) return done();
    // The chat is done but something else on the page never stops changing — don't wait forever on it.
    if (chatQuiet >= s.scramIdleSeconds + pageGrace) return done();
    if (Date.now() - start > s.maxTurnMinutes * 60000) return { text: pageText, timedOut: true };
  }
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

// Get back to the editor's page view with the AI chat visible: Escape any dialog, leave
// sub-views (Back), or click the frontend tab (e.g. from More → Overview).
export async function showEditorHome(ctx, tabId) {
  if (await dom(tabId, "findChatInput").catch(() => null)) return true;
  await dom(tabId, "pressKey", "Escape").catch(() => {});
  await sleep(500);
  if (await dom(tabId, "findChatInput").catch(() => null)) return true;
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
  if (await dom(tabId, "closePanel", "^plans$").catch(() => false)) {
    await sleep(1200);
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
  let t = await findModeToggle(ctx, tabId);
  if (!t) {
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

// Did the bot ask the user to press Run / switch to Run mode?
const ASKS_FOR_RUN = /\b(click|press|hit|tap|switch|put|turn|toggle|enable|activate|launch|start)\b[^.\n]{0,60}\brun\b|\brun mode\b[^.\n]{0,40}\b(active|on|enabled|needed|required)\b|\bin run mode\b[^.\n]{0,30}\?/i;

// ------------------------------------------------------------------ supervisor

const SUPERVISOR_RULES = `You are the human user of Scram, driving Scram's AI bot through ONE step file of a phased build. The real human is away and has asked you to act for them: answer the bot's questions, approve its plans, and keep it working until the step is genuinely finished. Be decisive and concise.

Each turn you get: the current step file, what the bot has said/done since your last message, and the controls on screen (buttons, options, and any form fields the bot is asking you to fill). Return ONLY a JSON object — either one action:
{"action":"reply","message":"<what to type into the Scram chat box>","reason":"..."}
{"action":"click","elementId":"<id>","reason":"..."}             (e.g. "Approve plan", an answer option, Continue, "let the AI fix it")
{"action":"type","elementId":"<id>","text":"...","reason":"..."}  (fill a form field the bot showed — NOT the main chat box; use reply for that)
{"action":"preview_size","size":"desktop"|"tablet"|"mobile","message":"<what to tell the bot once the preview is at that size>","reason":"..."}  (the EXTENSION switches Scram's preview size, then sends your message)
{"action":"do_it_myself","task":"<one concrete thing to do in Scram's editor UI>","message":"<what to tell the bot once it's done>","reason":"..."}  (the EXTENSION does it itself with real clicks/typing in Scram's editor, then sends your message; if it can't, it tells the bot to skip that part)
{"action":"step_complete","summary":"<one line of what was built>","reason":"..."}
{"action":"wait","reason":"..."}                                  (only if the bot is clearly still working)
{"action":"need_human","reason":"..."}
Any reply may also carry "learned":["<short lesson>", …] — see LEARNING below — and "to_human":"<one or two sentences>" — see MESSAGES FROM THE HUMAN.
— or several in order, for question forms: {"actions":[{"action":"click","elementId":"s12"},{"action":"type","elementId":"s14","text":"..."},{"action":"click","elementId":"s15"}],"reason":"..."}

How to decide:
- PLANS: Scram often shows a plan card (e.g. "Review plan" … "Approve plan") and will not build until it is approved. If an "Approve plan" / "Approve" / "Accept" / "Build it" / "Proceed" button is visible, CLICK IT — that is the normal path. Only if the plan clearly misses part of the step's scope or adds something out of scope, reply with precise corrections instead (the bot then revises; approve the revised plan next round). If a plan is presented in plain text with no button, reply "Approved — go ahead, and test everything yourself in Run mode."
- QUESTIONS: the bot will not continue until they are answered. Answer every question concretely from the step file and its Context Block, making sensible product/design decisions yourself, consistent with the spec — never defer ordinary choices to the human. If the bot shows answer options or a small form, pick/fill them (use "actions" for several) and click its submit/continue button; if it asks in plain text, reply in the chat box answering each question in order.
- WHAT THE BOT CAN DO: Scram's bot builds the app AND tests it itself by using the running app — but only while Scram is in Run mode, which the extension keeps on for the whole build. So the bot must test its own work thoroughly every step: click through the screens, fill forms, create/edit/delete data, check persistence and security rules. Ask it to describe what it tested and the results (don't ask it for screenshots).
- Bot says it has finished building: it must also have tested every checklist item itself in Run mode and reported each result plus "nothing hardcoded". If it hasn't, reply asking it to test the specific untested items in Run mode now and report back item by item. If a test failed, ask it to fix it and re-test.
- OBJECTIVES: every step has an objective (what the feature is for, and "done means" outcomes from a user's point of view — or infer it from the scope). Before accepting, check the bot proved each objective END TO END as a user would use it (e.g. post → appears in feed and on profile → survives refresh), not just that elements exist or individual buttons respond. If an outcome isn't demonstrated, or the feature works but doesn't achieve its purpose, ask the bot to test that specific user journey (and fix what's wrong).
- step_complete ONLY when the bot has reported testing every checklist item itself in Run mode, has shown each objective is achieved end to end, everything passes, and nothing is hardcoded. The extension then sends the next step file itself — never ask the bot to start the next step.
- Bot stopped mid-work, output looks cut off, or nothing new appeared (timed out): reply "Please continue where you left off." (the Scram guide says it sometimes stops randomly).
- Same problem for 2+ rounds: tell it to switch component or find another approach rather than forcing the same method (per the Scram guide).
- Error visible (red cross, failed deployment, error banner): click the "let the AI solve it" control if visible, otherwise reply asking the bot to diagnose and fix it (it can check Server Logs / run SQL in dev).
- need_human ONLY for: Scram saying you're out of credits / usage limit reached, credentials/API keys/accounts you don't have, payments or plan upgrades, publishing to Live, deleting the project or data, or the same blocker persisting after several different attempts. Give a short, plain reason the human can act on (e.g. "Scram is out of credits — top up, then press Resume").
- PREVIEW SIZE / BREAKPOINTS: Scram's bot CANNOT change the preview size (Desktop / Tablet / Mobile) — only the extension can, with Scram's preview-size button. Never ask the bot to resize, switch breakpoints or click "Preview size", never ask the human to do it, and never click those controls yourself. When checklist items need checking at other screen sizes: once the bot has tested at the current size, use {"action":"preview_size","size":"tablet","message":"I've switched the preview to Tablet (about 768px wide) for you. Test <the specific items> at this size with your own tools and report back item by item."}, then the same for "mobile" (about 375px) after it reports, and finally "desktop" again. One size per turn. If the bot says it can't resize the viewport, that's expected — switch it for it this way.
- RUN MODE: the extension itself keeps Scram's Edit/Run toggle on Run for the whole build — neither you nor the bot can press it, so never ask the bot to switch to Run mode, and never click Run/Edit yourself. If the bot asks you to click Run or put the app in Run mode, the extension has already done it: reply "Run mode is on now — please carry on and test it yourself."
- Never approve or request publishing to Live, deleting the project, purchases/upgrades, or inviting people.
- MESSAGES FROM THE HUMAN: the real human can message you while you work (listed each turn; ⭐ NEW = not acted on yet). They override the step file and your defaults. Act on new ones right away: relay what's needed to the bot (reply), change what you approve or ask for, skip or add something, or need_human if they ask you to pause. Always answer each new message in "to_human" (what you'll do, or the answer to their question) — that goes to the human, not the bot. If a message is just information, use it and say so.
- DO IT YOURSELF: when the bot says it can't do something that is really an action in Scram's editor UI (a toggle, button, setting, panel, menu, selecting something in the editor, switching a view, uploading something you have), don't ask it again and don't give up — use {"action":"do_it_myself","task":"<exact UI action, e.g. 'Turn on the Dark mode toggle in the editor toolbar'>","message":"<tell the bot it's done and what to do next>"}. Use preview_size for screen sizes (Run mode is automatic). Never use it for publishing, deleting, payments, account settings, inviting people or anything needing credentials — those are need_human. If the extension already tried a task and couldn't (see your earlier actions), don't try it again: tell the bot to skip it and carry on.
- LEARNING — don't go in circles: if the bot says it can't do something (its tools don't allow it, it has no way to, "you'll need to do this yourself"…), believe it. Add a short, general lesson to "learned" (e.g. "Scram's bot can't resize the preview viewport — the extension switches preview size") and NEVER ask it for that again, in any wording. Instead: do it yourself with an extension action if one fits (preview_size; Run mode is automatic), ask for a different check it CAN do that covers the same item, or treat that item as out of its reach and move on. Never argue, insist, or re-send the same request. The "Known limits" list in each turn holds everything learned so far — obey it.

Scram guide for reference:
<scram_guide>
{{GUIDE}}
</scram_guide>`;

// The bot telling us it can't do something we asked.
const REFUSAL = /\b(i (can(no|['’])t|am unable to|['’]m unable to|am not able to|['’]m not able to|don['’]t have (a|an|the|any)\b[^.\n]{0,40}\b(tool|ability|action|access|way))|there['’]?s no way for me|no way for me to|my (testing |interaction )?tools (can(no|['’])t|don['’]t|do not)|(isn['’]t|is not) something i can|outside (of )?what i can|you['’]ll need to (do|check|test|verify|click|resize)|beyond my (capabilities|tools)|not possible for me)/i;

async function supervise(ctx, { step, totalSteps, output, buttons, timedOut, chatInputId, note = "" }) {
  const b = ctx.state.build;
  const lessons = await store.getLessons();
  const limits = lessons.length
    ? `Known limits of Scram's bot (learned earlier — NEVER ask it to do any of these; work around them):\n${lessons.map((l) => `- ${l.text}`).join("\n")}\n\n`
    : "";
  const halves = b.chunk
    ? `NOTE: this step is being done in two halves. The bot is on PART ${b.chunk.part} of 2 — only these checklist items count right now:\n${b.chunk.parts[b.chunk.part - 1].map((t) => `  - ${t}`).join("\n")}\nWhen the bot has built and tested exactly these, choose step_complete (the extension then hands it ${b.chunk.part === 1 ? "part 2" : "nothing more — the step is done"}). Don't ask for the other half's items yet.\n`
    : "";
  const refusal = REFUSAL.test(output.slice(-4000))
    ? "NOTE: the bot seems to be saying it CAN'T do something. Don't ask again — put a short general lesson in \"learned\" and take a different route: if it's an action in Scram's editor UI, do it yourself (do_it_myself / preview_size); otherwise ask for a check it CAN do, or skip it.\n"
    : "";
  const guide = await loadPrompt("scramGuide", "scram-guide.md");
  const system = SUPERVISOR_RULES.replace("{{GUIDE}}", guide);
  const baseInstr = store.runInstructions({ ...ctx.state, notes: [] });
  const instructions = baseInstr
    ? `The human's instructions and the clone's scope (respect them in every answer — e.g. don't let the bot build areas that are out of scope):\n${baseInstr}\n\n`
    : "";
  const notes = ctx.state.notes || [];
  const messages = notes.length
    ? `Messages from the human during this run (oldest first):\n${notes.slice(-15).map((n) => `- ${n.seen ? "" : "⭐ NEW: "}${n.text}`).join("\n")}\n\n`
    : "";
  const userContent = `${instructions}${messages}${limits}Current step: ${step.stepNumber + 1} of ${totalSteps} — "${step.title}" (round ${b.rounds + 1} for this step)

<step_file>
${step.content.slice(0, 40000)}
</step_file>

Your earlier actions on this step:
${(b.history || []).slice(-8).map((h) => `- ${h}`).join("\n") || "(none yet — the step file was just sent)"}

${timedOut ? "NOTE: the bot produced no new output for a long time (timed out waiting).\n" : ""}${note}${halves}${refusal}What appeared in Scram since your last message (new lines only, most recent last):
<scram_output>
${output.slice(-12000) || "(nothing new)"}
</scram_output>

Controls visible (id | kind | label | state):
${buttons
  .map((e) => {
    const kind = e.editable ? `field${e.type ? `:${e.type}` : ""}` : e.role || e.tag;
    const state = [e.disabled ? "disabled" : "", e.selected ? "selected" : "", e.pressed ? `checked=${e.pressed}` : "", e.inLayer ? "in-dialog" : "", e.id === chatInputId ? "MAIN CHAT BOX (use reply)" : ""].filter(Boolean).join(", ");
    return `${e.id} | ${kind} | ${JSON.stringify(e.label || "")}${state ? ` | ${state}` : ""}`;
  })
  .join("\n") || "(none)"}`;
  let decision = await askJson({ what: "Scram supervisor", system, userContent, maxTokens: 3000 });
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
    const retry = await askJson({
      what: "Scram supervisor",
      system,
      userContent: `${userContent}\n\nIMPORTANT: you already sent the bot this, and it didn't work:\n"${repeat.slice(0, 600)}"\nDo NOT send that again in any wording. If the bot said it can't do it, add a lesson to "learned". Choose a different action: an extension action, a different request it can do, accept what it reported (step_complete if everything it CAN check passes), or need_human.`,
      maxTokens: 3000,
    }).catch(() => null);
    if (retry) {
      decision = retry;
      learned.push(...lessonsOf(retry)); // keep lessons from both answers
    }
  }

  // The human's new messages have now been read: answer them in the log.
  const fresh = notes.filter((n) => !n.seen);
  if (fresh.length) {
    for (const n of fresh) n.seen = true;
    await ctx.log(`🤖 Autopilot: ${String(decision.to_human || "Got it — I'm taking that into account.").slice(0, 600)}`);
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
First write a short plan for this step — starting with its objective (what the feature is for) — and wait for my approval. Then build it, test that it really achieves that objective end to end as the file's last section says, and report back.`;

// Send a step to Scram's bot. Preferred: attach it as a .md file (Scram's bot works well
// with markdown files) plus a short pointer message. If the chat has no working upload
// (the file name never shows up), fall back to pasting the full text.
async function sendStep(ctx, tabId, step, total) {
  step = { ...step, content: store.withTestingSection(step.content) }; // older handoffs lack it
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
      const message = `Attached: ${name} — the complete work order for step ${step.stepNumber + 1} of ${total} ("${step.title}"). Read the whole file before doing anything, and follow it exactly.${STEP_SUFFIX}`;
      await sendMessage(ctx, tabId, message);
      return message;
    }
    await ctx.log(`Couldn't attach ${name} in Scram's chat (${res.log.filter((l) => l.startsWith("❌")).length} methods tried — run Settings → “Test file upload to Scram” for details). Pasting the step text instead.`);
  }
  const message = step.content + STEP_SUFFIX;
  await sendMessage(ctx, tabId, message);
  return message;
}

// One supervisor round: wait for Scram's bot to go quiet, read what's new (expanding
// collapsed plans), let the supervisor decide, and carry out click/type/reply/form answers.
// With dryRun, nothing is clicked or typed — the decision is only logged ("Would …").
// Returns { decision, text }; step_complete / need_human / wait are left to the caller.
export async function superviseRound(ctx, tabId, step, totalSteps, { dryRun = false } = {}) {
  const b = ctx.state.build;
  // Scram's AI chat must be on screen (the bot or a click may have left it on Overview, a
  // workflow canvas, etc.).
  if (!dryRun && !(await dom(tabId, "findChatInput").catch(() => null))) await showEditorHome(ctx, tabId);
  // Scram pauses its AI when its tab isn't the one being looked at.
  const page = (await dom(tabId, "bodyText").catch(() => "")) || "";
  if (/AI paused by the browser|AI paused/i.test(page) && !b.warnedPaused) {
    b.warnedPaused = true;
    await ctx.log("⚠️ Scram says its AI was paused by the browser — it pauses when the Scram tab isn't the one on screen. Keep the Scram tab visible (e.g. drag it into its own window) while Autopilot builds.");
    ctx.notify("Keep the Scram tab visible", "Scram pauses its AI when its tab is in the background. Put the Scram tab in its own window while Autopilot builds.");
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
  let { text, timedOut } = await waitForIdle(ctx, tabId, b.baseline);
  // Plan cards are collapsed ("Read more") — expand so the whole plan / question is read.
  if (await dom(tabId, "expandCollapsed").catch(() => 0)) {
    await sleep(800);
    text = (await dom(tabId, "bodyText")) || text;
  }
  const output = newLines(b.baseline, text, b.sentText || "");
  // Scram's bot can't press Run itself — if it asks for Run mode, the extension switches it.
  let runNote = "";
  if (ASKS_FOR_RUN.test(output.slice(-3000))) {
    if (dryRun) await ctx.log("DRY RUN — the bot asked for Run mode; would click Scram's Run button.");
    else if (await ensureRunMode(ctx, tabId, { force: true })) runNote = "NOTE: the bot asked for Run mode — the extension has just switched Scram to Run mode itself. Tell the bot Run mode is now on and to carry on testing itself; do NOT ask it to switch modes.\n";
  } else if (!dryRun) {
    await ensureRunMode(ctx, tabId).catch(() => {});
  }
  const snap = await dom(tabId, "snapshot", { maxElements: 220, maxText: 0 });
  const chatInputId = await dom(tabId, "findChatInput").catch(() => null);
  // Buttons/options, plus any form fields the bot is asking us to fill (not links).
  const controls = snap.elements.filter((e) => !e.href && (e.label || e.editable)).slice(0, 140);
  const approveBtn = controls.find((e) => !e.editable && !e.disabled && /^(approve( plan)?|accept( plan)?|approve (and|&) build|build it|proceed)$/i.test((e.label || "").trim()));

  let decision;
  try {
    decision = await supervise(ctx, { step, totalSteps, output, buttons: controls, timedOut, chatInputId, note: runNote });
  } catch (e) {
    // If the supervisor can't answer but a plan is waiting for approval, approve it rather than stall.
    if (!approveBtn) throw e;
    await ctx.log(`Supervisor unavailable (${e.message}) — approving the plan that's waiting.`);
    decision = { action: "click", elementId: approveBtn.id, reason: "fallback: plan waiting for approval" };
  }
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  b.rounds += 1;
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
      } else if (a.action === "do_it_myself" && a.task) {
        const ok = await uiAgent(ctx, tabId, `In Scram's project editor, do exactly this: ${String(a.task).slice(0, 400)}. Use the editor's own controls. Do NOT type in or send anything with the AI chat box. Never publish, deploy, delete, pay, invite people or change account settings. Finish with done when it's visibly done, or fail if it isn't possible.`, { maxSteps: 12, optional: true }).catch(() => false);
        await ctx.log(ok ? `Done it myself: ${a.task}` : `Tried to do it myself but couldn't — giving up on: ${a.task}`);
      } else if (a.action === "preview_size") {
        await setPreviewSize(ctx, tabId, a.size);
      } else if (el && a.action === "click" && isPreviewSizeControl(el.label)) {
        const m = (el.label || "").match(/desktop|tablet|mobile/i);
        if (m) await setPreviewSize(ctx, tabId, m[0]);
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
    b.baseline = text;
    decision.action = "multi";
  }

  switch (decision.action) {
    case "reply": {
      const msg = String(decision.message || "Please continue where you left off.");
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
        ? String(decision.message || `I've done that for you in the editor (${task}). Please carry on, and test it yourself in Run mode.`)
        : `That can't be done from here (${task}), so skip that part and carry on with the rest of this step. Tell me what you could and couldn't verify.`;
      b.history.push(`${ok ? "did it myself" : "couldn't do it myself"}: ${task.slice(0, 120)}; replied: ${msg.slice(0, 120)}`);
      b.sentText = msg;
      await ctx.log(`Replying to Scram: “${msg.slice(0, 140)}”`);
      await sendMessage(ctx, tabId, msg);
      break;
    }
    case "preview_size": {
      const size = String(decision.size || "").toLowerCase();
      const ok = await setPreviewSize(ctx, tabId, size);
      const msg = ok
        ? String(decision.message || `I've switched the preview to ${SIZES[size] || size} for you. Test this step's checklist items at this size and report back item by item.`)
        : null;
      b.history.push(ok ? `switched preview to ${size}; replied: ${msg.slice(0, 160)}` : `couldn't switch preview to ${size}`);
      b.baseline = text;
      if (msg) {
        await ctx.log(`Replying to Scram: “${msg.slice(0, 140)}”${reason}`);
        b.sentText = msg;
        await sendMessage(ctx, tabId, msg);
      }
      decision.action = "reply";
      break;
    }
    case "click": {
      const el = controls.find((e) => e.id === decision.elementId);
      if (el && isPreviewSizeControl(el.label) && /desktop|tablet|mobile/i.test(el.label)) {
        // Preview size is the extension's job — use the proper switch (real clicks, verified).
        await setPreviewSize(ctx, tabId, el.label.match(/desktop|tablet|mobile/i)[0]);
        b.history.push(`switched preview to ${el.label}`);
        b.baseline = text;
        break;
      }
      if (/^\W*(run|edit)$/i.test((el?.label || "").trim())) {
        // The Edit/Run toggle is ours to manage (a script click doesn't work on it anyway).
        await ensureRunMode(ctx, tabId, { force: true });
        const msg = "Run mode is on now — please carry on and test it yourself.";
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
  return { decision, text };
}

// ---- halves: when the bot struggles with a step, hand it the checklist in two parts.
const checklistItems = (content) => [...String(content).matchAll(/^\s*[-*]\s*\[[ xX]\]\s*(.+)$/gm)].map((m) => m[1].trim());

function struggling(ctx) {
  const b = ctx.state.build;
  const at = Math.max(8, Math.floor((ctx.settings.maxRoundsPerStep || 40) / 3));
  return b.rounds >= at || (b.nudges || 0) >= 2;
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
  const msg = `Great — part 1 is done. Now build and test the rest of this step, then report back on each:\n${b.chunk.parts[1].map((t, i) => `${i + 1}. ${t}`).join("\n")}\nAlso re-check that part 1 still works.`;
  await ctx.log(`Part 1 confirmed — sending part 2 (${b.chunk.parts[1].length} items).`);
  b.history.push(`part 1 confirmed; sent part 2 (${b.chunk.parts[1].length} items)`);
  b.sentText = msg;
  await sendMessage(ctx, tabId, msg);
}

// One round of the conversation. Returns false when every step is done.
export async function buildRound(ctx) {
  const b = ctx.state.build;
  const steps = await store.getSteps(ctx.state.siteUrl);
  b.totalSteps = steps.length;
  if (b.step >= steps.length) return false;
  const step = steps[b.step];

  const tabId = await ensureScramTab(ctx);
  if (!b.projectReady) {
    await ctx.save({ phase: "scram-setup" });
    return true;
  }

  if (b.sentStep !== b.step) {
    await ensureRunMode(ctx, tabId).catch(() => {});
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
    await ctx.save({ build: b });
    const p = await store.getProgress(ctx.state.siteUrl);
    await store.setProgress({ ...p, currentStep: step.stepNumber });
  }

  if (!b.chunk && b.rounds > 0 && struggling(ctx)) await startHalves(ctx, tabId, step);
  await ctx.log(`Waiting for Scram's bot (step ${step.stepNumber + 1}, round ${b.rounds + 1})…`);
  const { decision, text } = await superviseRound(ctx, tabId, step, steps.length);
  const reason = decision.reason ? ` — ${decision.reason}` : "";

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
      b.step += 1;
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
      for (let i = 0; i < 20 && !(ctx.state.notes || []).some((n) => !n.seen); i++) await sleep(1000);
  }

  if (b.rounds >= ctx.settings.maxRoundsPerStep && decision.action !== "step_complete") {
    await ctx.save({ build: b });
    throw new PauseError(`Step ${step.stepNumber + 1} took more than ${ctx.settings.maxRoundsPerStep} rounds without being confirmed — have a look, then press Resume.`);
  }
  await ctx.save({ build: b });
  return true;
}
