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

async function ensureScramTab(ctx) {
  const b = ctx.state.build;
  if (b.tabId != null) {
    try {
      const t = await chrome.tabs.get(b.tabId);
      if (store.isScramUrl(t.url)) return b.tabId;
    } catch {
      /* closed */
    }
  }
  // A project editor may already be open (e.g. Scram opened it in its own tab).
  if (b.projectReady) {
    const [editor] = (await store.scramTabs()).filter((t) => store.isScramEditorUrl(t.url));
    if (editor) {
      b.tabId = editor.id;
      await ctx.save({ build: b });
      return editor.id;
    }
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

async function waitForLogin(ctx, tabId) {
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

Rules: never publish to Live, deploy to production, delete anything, buy/upgrade/change billing, invite people, or change account settings. Pick the most direct path. If a dialog blocks progress, handle it or close it. Don't repeat an action that didn't work — try something else.`;

// Scram opens projects on editor.buildwithscram.com — sometimes in a NEW tab. If a Scram tab
// appeared that wasn't there before, switch to it (and remember it for the rest of the run).
async function followNewScramTab(ctx, knownIds) {
  const fresh = (await store.scramTabs()).filter((t) => !knownIds.has(t.id));
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

async function uiAgent(ctx, startTabId, goal, { maxSteps = 20, optional = false } = {}) {
  const history = [];
  let tabId = startTabId;
  const knownIds = new Set((await store.scramTabs()).map((t) => t.id));
  for (let i = 0; i < maxSteps; i++) {
    ctx.checkStop();
    tabId = (await followNewScramTab(ctx, knownIds)) || ctx.state.build.tabId || tabId;
    const snap = await dom(tabId, "snapshot", { maxElements: 200, maxText: 2500 });
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
    const act = await askJson({ what: "Scram UI agent", system: UI_AGENT_SYSTEM, userContent, maxTokens: 1200 });
    const target = snap.elements.find((e) => e.id === act.id);
    const desc = `${act.action}${target ? ` "${target.label}"` : ""}${act.text ? ` ← "${String(act.text).slice(0, 60)}"` : ""}${act.key ? ` ${act.key}` : ""} — ${act.reason || ""}`;
    history.push(desc);
    await ctx.log(`Scram UI: ${desc}`);

    if (act.action === "done") return true;
    if (act.action === "fail") {
      if (optional) return false;
      throw new PauseError(`Couldn't do this in Scram: ${goal.split(".")[0]} — ${act.reason}`);
    }
    if (act.action === "click" && target) await dom(tabId, "click", { id: target.id, label: target.label, role: target.role });
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

export async function setup(ctx) {
  const b = ctx.state.build;
  await ensureScramTab(ctx);
  await waitForLogin(ctx, b.tabId);

  if (!b.projectReady) {
    const name = b.appName || "Cloned App";
    await ctx.log(`Opening the Scram project “${name}”…`);
    await uiAgent(
      ctx,
      b.tabId,
      `Make sure the Scram project named "${name}" is open in the project EDITOR (its address is on editor.buildwithscram.com; the page shows a "Chat" panel with an "Ask Claude..." box). If a project with exactly that name already exists in the project list, open it; otherwise create ONE new project with that name (fill any other required fields sensibly, e.g. a one-line description of an app cloned from ${ctx.state.siteUrl}). Never create more than one project. Do not send any chat message yet. Finish with done as soon as the editor with its chat box is showing.`
    );
    if (!(await dom(b.tabId, "findChatInput"))) {
      await uiAgent(ctx, b.tabId, "Open the AI chat panel (the \"Chat\" panel on the left of the project editor) so its \"Ask Claude...\" message box is visible.", { maxSteps: 8 });
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

export async function sendMessage(ctx, tabId, text) {
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
  let changed = false;
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

// Scram's editor has an Edit / Run toggle (top right). The bot works best in Run mode, and
// building still happens in Run mode — so switch to it if we're in Edit mode.
export async function ensureRunMode(ctx, tabId) {
  const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 }).catch(() => null);
  const run = snap?.elements.find((e) => !e.inLayer && !e.editable && !e.disabled && /^▷?\s*run$/i.test((e.label || "").trim()));
  if (!run) return false;
  if (run.selected || run.pressed === "true") return true;
  await dom(tabId, "click", { id: run.id, label: run.label, role: run.role });
  await ctx.log("Switched Scram to Run mode.");
  await sleep(3000);
  return true;
}

// ------------------------------------------------------------------ supervisor

const SUPERVISOR_RULES = `You are the human user of Scram, driving Scram's AI bot through ONE step file of a phased build. The real human is away and has asked you to act for them: answer the bot's questions, approve its plans, and keep it working until the step is genuinely finished. Be decisive and concise.

Each turn you get: the current step file, what the bot has said/done since your last message, and the controls on screen (buttons, options, and any form fields the bot is asking you to fill). Return ONLY a JSON object — either one action:
{"action":"reply","message":"<what to type into the Scram chat box>","reason":"..."}
{"action":"click","elementId":"<id>","reason":"..."}             (e.g. "Approve plan", an answer option, Continue, "let the AI fix it")
{"action":"type","elementId":"<id>","text":"...","reason":"..."}  (fill a form field the bot showed — NOT the main chat box; use reply for that)
{"action":"step_complete","summary":"<one line of what was built>","reason":"..."}
{"action":"wait","reason":"..."}                                  (only if the bot is clearly still working)
{"action":"need_human","reason":"..."}
— or several in order, for question forms: {"actions":[{"action":"click","elementId":"s12"},{"action":"type","elementId":"s14","text":"..."},{"action":"click","elementId":"s15"}],"reason":"..."}

How to decide:
- PLANS: Scram often shows a plan card (e.g. "Review plan" … "Approve plan") and will not build until it is approved. If an "Approve plan" / "Approve" / "Accept" / "Build it" / "Proceed" button is visible, CLICK IT — that is the normal path. Only if the plan clearly misses part of the step's scope or adds something out of scope, reply with precise corrections instead (the bot then revises; approve the revised plan next round). If a plan is presented in plain text with no button, reply "Approved — go ahead. Test each feature in Run mode as you build it."
- QUESTIONS: the bot will not continue until they are answered. Answer every question concretely from the step file and its Context Block, making sensible product/design decisions yourself, consistent with the spec — never defer ordinary choices to the human. If the bot shows answer options or a small form, pick/fill them (use "actions" for several) and click its submit/continue button; if it asks in plain text, reply in the chat box answering each question in order.
- Bot says it has finished: it must have tested every checklist item itself in the running app (Run mode) and explicitly confirmed each one plus "nothing hardcoded". If it hasn't, reply asking it to test and confirm the specific missing items.
- step_complete ONLY when the bot has explicitly confirmed every checklist item passes in its own testing and nothing is hardcoded. The extension then sends the next step file itself — never ask the bot to start the next step.
- Bot stopped mid-work, output looks cut off, or nothing new appeared (timed out): reply "Please continue where you left off." (the Scram guide says it sometimes stops randomly).
- Same problem for 2+ rounds: tell it to switch component or find another approach rather than forcing the same method (per the Scram guide).
- Error visible (red cross, failed deployment, error banner): click the "let the AI solve it" control if visible, otherwise reply asking the bot to diagnose and fix it (it can check Server Logs / run SQL in dev).
- need_human ONLY for: Scram saying you're out of credits / usage limit reached, credentials/API keys/accounts you don't have, payments or plan upgrades, publishing to Live, deleting the project or data, or the same blocker persisting after several different attempts. Give a short, plain reason the human can act on (e.g. "Scram is out of credits — top up, then press Resume").
- Never approve or request publishing to Live, deleting the project, purchases/upgrades, or inviting people.

Scram guide for reference:
<scram_guide>
{{GUIDE}}
</scram_guide>`;

async function supervise(ctx, { step, totalSteps, output, buttons, timedOut, chatInputId }) {
  const b = ctx.state.build;
  const guide = await loadPrompt("scramGuide", "scram-guide.md");
  const system = SUPERVISOR_RULES.replace("{{GUIDE}}", guide);
  const instructions = ctx.state.instructions
    ? `The human's instructions for this clone (respect them in every answer — e.g. don't let the bot build areas they said to ignore):\n${ctx.state.instructions}\n\n`
    : "";
  const userContent = `${instructions}Current step: ${step.stepNumber + 1} of ${totalSteps} — "${step.title}" (round ${b.rounds + 1} for this step)

<step_file>
${step.content.slice(0, 40000)}
</step_file>

Your earlier actions on this step:
${(b.history || []).slice(-8).map((h) => `- ${h}`).join("\n") || "(none yet — the step file was just sent)"}

${timedOut ? "NOTE: the bot produced no new output for a long time (timed out waiting).\n" : ""}What appeared in Scram since your last message (new lines only, most recent last):
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
  return askJson({ what: "Scram supervisor", system, userContent, maxTokens: 3000 });
}

// ------------------------------------------------------------------ build loop

const STEP_SUFFIX = `

---
Before building anything, create a detailed plan for this step and wait for my approval. After building, test every item of this step's testing checklist yourself in Run mode, then report back confirming each item, that nothing is hardcoded, and that you tested it yourself.`;

// Send a step to Scram's bot. Preferred: attach it as a .md file (Scram's bot works well
// with markdown files) plus a short pointer message. If the chat has no working upload
// (the file name never shows up), fall back to pasting the full text.
async function sendStep(ctx, tabId, step, total) {
  const name = store.handoffFileName(step);
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
  let { text, timedOut } = await waitForIdle(ctx, tabId, b.baseline);
  // Plan cards are collapsed ("Read more") — expand so the whole plan / question is read.
  if (await dom(tabId, "expandCollapsed").catch(() => 0)) {
    await sleep(800);
    text = (await dom(tabId, "bodyText")) || text;
  }
  const output = newLines(b.baseline, text, b.sentText || "");
  const snap = await dom(tabId, "snapshot", { maxElements: 220, maxText: 0 });
  const chatInputId = await dom(tabId, "findChatInput").catch(() => null);
  // Buttons/options, plus any form fields the bot is asking us to fill (not links).
  const controls = snap.elements.filter((e) => !e.href && (e.label || e.editable)).slice(0, 140);
  const approveBtn = controls.find((e) => !e.editable && !e.disabled && /^(approve( plan)?|accept( plan)?|approve (and|&) build|build it|proceed)$/i.test((e.label || "").trim()));

  let decision;
  try {
    decision = await supervise(ctx, { step, totalSteps, output, buttons: controls, timedOut, chatInputId });
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
    case "click": {
      const el = controls.find((e) => e.id === decision.elementId);
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
    await ctx.save({ build: b });
    const p = await store.getProgress(ctx.state.siteUrl);
    await store.setProgress({ ...p, currentStep: step.stepNumber });
  }

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
      const p = await store.getProgress(ctx.state.siteUrl);
      const completed = [...new Set([...(p.completedSteps || []), step.stepNumber])].sort((x, y) => x - y);
      await store.setProgress({ ...p, completedSteps: completed, currentStep: step.stepNumber + 1 });
      await ctx.log(`✓ Step ${step.stepNumber + 1} confirmed: ${decision.summary || step.title}`);
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
      await sleep(20000);
  }

  if (b.rounds >= ctx.settings.maxRoundsPerStep && decision.action !== "step_complete") {
    await ctx.save({ build: b });
    throw new PauseError(`Step ${step.stepNumber + 1} took more than ${ctx.settings.maxRoundsPerStep} rounds without being confirmed — have a look, then press Resume.`);
  }
  await ctx.save({ build: b });
  return true;
}
