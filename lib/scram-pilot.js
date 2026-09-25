// Autopilot phases 3–4: open Scram, get a project open with the AI chat visible,
// then feed the step files one at a time — reading the Scram bot's replies and
// answering questions / approving plans / pushing for testing, until each step is
// confirmed done. Scram's DOM isn't a public API, so UI navigation is done by a
// small Claude-driven agent that reads the page's controls and picks actions.

import * as store from "./storage.js";
import { askJson, loadPrompt } from "./jobs.js";
import { dom, sleep, waitForLoad } from "./dom.js";
import { PauseError } from "./errors.js";

const SCRAM_URL = "https://dashboard.buildwithscram.com/";

// ------------------------------------------------------------------ tab

async function ensureScramTab(ctx) {
  const b = ctx.state.build;
  if (b.tabId != null) {
    try {
      const t = await chrome.tabs.get(b.tabId);
      if (t.url?.startsWith(SCRAM_URL)) return b.tabId;
    } catch {
      /* closed */
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

async function uiAgent(ctx, tabId, goal, { maxSteps = 20, optional = false } = {}) {
  const history = [];
  for (let i = 0; i < maxSteps; i++) {
    ctx.checkStop();
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
    const act = await askJson({ system: UI_AGENT_SYSTEM, userContent, maxTokens: 500 });
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
  }
  if (optional) return false;
  throw new PauseError(`Couldn't finish in Scram after ${maxSteps} actions: ${goal.split(".")[0]}`);
}

// ------------------------------------------------------------------ setup

export async function setup(ctx) {
  const b = ctx.state.build;
  const tabId = await ensureScramTab(ctx);
  await waitForLogin(ctx, tabId);

  if (!b.projectReady) {
    const name = b.appName || "Cloned App";
    await ctx.log(`Opening the Scram project “${name}”…`);
    await uiAgent(
      ctx,
      tabId,
      `Make sure the Scram project named "${name}" is open in the editor with the AI chat panel open (the chat bubble icon in the left side navigation) and its message input visible. If a project with exactly that name already exists in the project list, open it; otherwise create a new project with that name (fill any other required fields sensibly, e.g. a one-line description of an app cloned from ${ctx.state.siteUrl}). Do not send any chat message yet.`
    );
    if (!(await dom(tabId, "findChatInput"))) {
      await uiAgent(ctx, tabId, "Open the AI chat panel (chat bubble icon in the left side navigation) so its message input box is visible.", { maxSteps: 8 });
    }
    b.projectReady = true;
    await ctx.save({ build: b });
  }

  if (!b.modelChecked) {
    // Scram guide: run the bot on Claude Sonnet with low thinking — other options are too expensive.
    await uiAgent(
      ctx,
      tabId,
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

async function sendMessage(ctx, tabId, text) {
  let inputId = await dom(tabId, "findChatInput");
  if (!inputId) {
    await uiAgent(ctx, tabId, "Open the AI chat panel so its message input box is visible. Do not send anything.", { maxSteps: 8 });
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
  const sendId = await dom(tabId, "findSendButton", inputId);
  if (sendId) await dom(tabId, "click", sendId);
  else await dom(tabId, "pressKey", "Enter", inputId);
  await sleep(2000);
  if (await stillThere()) {
    await dom(tabId, "pressKey", "Enter", inputId);
    await sleep(2000);
  }
  if (await stillThere()) {
    await uiAgent(ctx, tabId, "A message is already typed in the AI chat input. Send it (click the chat's send button). Do not change the text.", { maxSteps: 4 });
  }
}

// Wait until Scram's page stops changing (bot finished replying).
async function waitForIdle(ctx, tabId, baseline) {
  const s = ctx.settings;
  const start = Date.now();
  let last = null;
  let stableSince = Date.now();
  let changed = false;
  for (;;) {
    ctx.checkStop();
    await sleep(3000);
    const text = (await dom(tabId, "bodyText").catch(() => "")) || "";
    const generating = await dom(tabId, "isGenerating").catch(() => false);
    const n = norm(text);
    if (n !== norm(baseline)) changed = true;
    if (n !== last || generating) {
      last = n;
      stableSince = Date.now();
    }
    const quietFor = (Date.now() - stableSince) / 1000;
    if (changed && quietFor >= s.scramIdleSeconds) return { text, timedOut: false };
    if (!changed && Date.now() - start > 120000) return { text, timedOut: true }; // nothing happened at all
    if (Date.now() - start > s.maxTurnMinutes * 60000) return { text, timedOut: true };
  }
}

// ------------------------------------------------------------------ supervisor

const SUPERVISOR_RULES = `You are the human user of Scram, driving Scram's AI bot through ONE step file of a phased build. The real human is away and has asked you to act for them: answer the bot's questions, approve its plans, and keep it working until the step is genuinely finished. Be decisive and concise.

Each turn you get: the current step file, what the bot has said/done since your last message, and the clickable buttons on screen. Decide ONE action and return ONLY a JSON object:
{"action":"reply","message":"<what to type into the Scram chat>","reason":"..."}
{"action":"click","elementId":"<id>","reason":"..."}             (e.g. an Approve / Accept plan / Continue / "let the AI fix it" button)
{"action":"step_complete","summary":"<one line of what was built>","reason":"..."}
{"action":"wait","reason":"..."}                                  (only if the bot is clearly still working)
{"action":"need_human","reason":"..."}

How to decide:
- Plan presented / approval requested: check it covers everything in the step's scope and testing checklist and nothing out of scope. If it does, approve — click the approve/accept button if one is visible, otherwise reply "Approved — go ahead. Test each feature in Run mode as you build it." If not, reply with precise corrections.
- Questions: answer them concretely using the step file and its Context Block. Make sensible product decisions yourself, consistent with the spec. Don't defer to the human for ordinary product/design choices.
- Bot says it has finished: it must have tested every checklist item itself in the running app (Run mode) and explicitly confirmed each one plus "nothing hardcoded". If it hasn't, reply asking it to test and confirm the specific missing items.
- step_complete ONLY when the bot has explicitly confirmed every checklist item passes in its own testing and nothing is hardcoded. The extension then sends the next step file itself — never ask the bot to start the next step.
- Bot stopped mid-work, output looks cut off, or nothing new appeared (timed out): reply "Please continue where you left off." (the Scram guide says it sometimes stops randomly).
- Same problem for 2+ rounds: tell it to switch component or find another approach rather than forcing the same method (per the Scram guide).
- Error visible (red cross, failed deployment, error banner): click the "let the AI solve it" control if visible, otherwise reply asking the bot to diagnose and fix it (it can check Server Logs / run SQL in dev).
- need_human ONLY for: credentials/API keys/accounts you don't have, payments or plan upgrades, publishing to Live, deleting the project or data, or the same blocker persisting after several different attempts.
- Never approve or request publishing to Live, deleting the project, purchases/upgrades, or inviting people.

Scram guide for reference:
<scram_guide>
{{GUIDE}}
</scram_guide>`;

async function supervise(ctx, { step, totalSteps, output, buttons, timedOut }) {
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

Clickable buttons visible (id | label):
${buttons.map((e) => `${e.id} | ${JSON.stringify(e.label)}${e.inLayer ? " | in-dialog" : ""}`).join("\n") || "(none)"}`;
  return askJson({ system, userContent, maxTokens: 1500 });
}

// ------------------------------------------------------------------ build loop

const STEP_SUFFIX = `

---
Before building anything, create a detailed plan for this step and wait for my approval. After building, test every item of this step's testing checklist yourself in Run mode, then report back confirming each item, that nothing is hardcoded, and that you tested it yourself.`;

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
    const message = step.content + STEP_SUFFIX;
    await ctx.log(`Sending step ${step.stepNumber + 1}/${steps.length}: ${step.title}`);
    b.baseline = (await dom(tabId, "bodyText")) || "";
    await sendMessage(ctx, tabId, message);
    b.sentStep = b.step;
    b.sentText = message;
    b.rounds = 0;
    b.history = [];
    await ctx.save({ build: b });
    const p = await store.getProgress(ctx.state.siteUrl);
    await store.setProgress({ ...p, currentStep: step.stepNumber });
  }

  await ctx.log(`Waiting for Scram's bot (step ${step.stepNumber + 1}, round ${b.rounds + 1})…`);
  const { text, timedOut } = await waitForIdle(ctx, tabId, b.baseline);
  const output = newLines(b.baseline, text, b.sentText || "");
  const snap = await dom(tabId, "snapshot", { maxElements: 200, maxText: 0 });
  const buttons = snap.elements.filter((e) => e.label && !e.editable && !e.href).slice(0, 120);

  const decision = await supervise(ctx, { step, totalSteps: steps.length, output, buttons, timedOut });
  const reason = decision.reason ? ` — ${decision.reason}` : "";
  b.rounds += 1;

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
    case "click": {
      const el = buttons.find((e) => e.id === decision.elementId);
      await ctx.log(`Clicking “${el?.label || decision.elementId}” in Scram${reason}`);
      b.history.push(`clicked: ${el?.label || decision.elementId}`);
      b.baseline = text;
      if (el) await dom(tabId, "click", { id: el.id, label: el.label, role: el.role });
      break;
    }
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
