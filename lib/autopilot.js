// Autopilot: explore a site → write specs → generate handoff → build it in Scram,
// with no clicks from the user. State lives in chrome.storage ("autopilot") so the
// run survives service-worker restarts; an alarm resumes it if the worker was killed.

import * as store from "./storage.js";
import { totalCost } from "./pricing.js";
import { generateHandoff, askJson, loadPrompt } from "./jobs.js";
import * as explorer from "./explorer.js";
import * as pilot from "./scram-pilot.js";

import { PauseError, StopError } from "./errors.js";

export { PauseError, StopError };

const ALARM = "autopilot-keepalive";
let running = false;
let stopRequested = false;
let liveState = null; // the running loop's state object (so messages land in it, not in a stale copy)

export async function getState() {
  return store.get("autopilot", null);
}

async function saveState(state) {
  state.updatedAt = Date.now();
  await store.set("autopilot", state);
}

function notify(title, message) {
  chrome.notifications?.create({ type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message: message.slice(0, 250) }, () => void chrome.runtime.lastError);
}

function makeCtx(state, settings) {
  const ctx = {
    state,
    settings,
    async save(patch = {}) {
      // Never let an in-flight step overwrite a Stop the user just pressed.
      if (stopRequested) throw new StopError("Stopped");
      Object.assign(state, patch);
      await saveState(state);
    },
    async log(msg) {
      if (stopRequested) throw new StopError("Stopped");
      state.log = [...(state.log || []), { t: Date.now(), msg }].slice(-300);
      state.message = msg;
      await saveState(state);
    },
    checkStop() {
      if (stopRequested) throw new StopError("Stopped");
    },
    notify,
  };
  return ctx;
}

export async function start({ tabId, instructions = "" }) {
  if (running) throw new Error("Autopilot is already running.");
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/.test(tab.url || "")) throw new Error("Open the website you want to clone first.");
  const siteUrl = store.siteUrlFor(tab.url);
  const state = {
    status: "running",
    phase: "explore",
    siteUrl,
    startUrl: tab.url,
    startedAt: Date.now(),
    // Free-text guidance from the user ("ignore the Grok part"), applied at every stage.
    instructions: String(instructions || "").trim().slice(0, 4000),
    // Token totals are all-time; remember where this run started so the card can show per-run usage.
    usageAtStart: await (async () => {
      const u = await store.get("usage", { input: 0, output: 0, calls: 0 });
      return { ...u, cost: totalCost(u) };
    })(),
    message: "Starting…",
    log: [],
    explore: { tabId: null, queue: [tab.url], visited: [], queued: [explorer.pattern(tab.url)], pages: [], skipped: [], avoid: [] },
    build: { tabId: null, step: 0, sentStep: null, rounds: 0, history: [], projectReady: false, modelChecked: false },
  };
  await saveState(state);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
  return state;
}

export async function stop() {
  stopRequested = true;
  const state = await getState();
  if (state && ["running", "paused", "waiting"].includes(state.status)) {
    state.status = "stopped";
    state.message = "Stopped by you.";
    await saveState(state);
  }
  await explorer.release();
  await chrome.alarms.clear(ALARM);
}

export async function resume() {
  const state = await getState();
  if (!state) throw new Error("Nothing to resume.");
  if (state.status === "done") throw new Error("This run already finished.");
  if (state.status === "waiting" && state.phase === "qa") return answerQuestions({});
  state.status = "running";
  state.pauseReason = null;
  await saveState(state);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
}

// ---- Q&A: questions for the human between research and planning the build.

const QA_SYSTEM = `You are about to plan how to clone a website's core features in Scram (a no-code app builder with an AI builder; see the Scram guide). Before planning, list the questions you genuinely need the human to answer — decisions that materially change HOW it's built in Scram and that you can't sensibly decide yourself from the specs, the human's instructions and the Scram guide. Examples of good questions: how sign-up/login should work, whether a feed must update live or on refresh, how media uploads are stored and limited, which user roles exist, what happens with features Scram can't do natively, which of two reasonable data designs to use, what to do about payments or third-party integrations, naming/branding. Don't ask about things already decided (instructions, scope) or trivia; prefer fewer, sharper questions (at most 8, often 3–6). If nothing is genuinely open, return no questions.

For each question give 2–4 concrete options and mark the one you recommend. Keep each question to one line, each option short.

Return ONLY JSON: {"questions":[{"id":"q1","question":"...","why":"<one line: what it changes in the build>","options":["...","..."],"recommended":<index of the recommended option>}]}`;

async function makeQuestions(state, settings) {
  const specs = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === state.siteUrl)
    .map((s) => `<!-- ${s.pageTitle} (${s.pageUrl}) -->\n${s.content.slice(0, 6000)}`)
    .join("\n\n---\n\n")
    .slice(0, 60000);
  const guide = await loadPrompt("scramGuide", "scram-guide.md");
  const instr = store.runInstructions({ ...state, qa: null });
  const userContent = `${instr ? `The human's instructions and scope:\n${instr}\n\n` : ""}<scram_guide>\n${guide}\n</scram_guide>\n\nScreen specs of ${state.siteUrl}:\n${specs || "(none)"}`;
  const res = await askJson({ what: "Q&A planner", system: QA_SYSTEM, userContent, maxTokens: 3000, model: settings.model });
  return (Array.isArray(res.questions) ? res.questions : [])
    .map((q, i) => {
      const options = (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 4);
      const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
      return { id: String(q.id || `q${i + 1}`), question: String(q.question || "").trim(), why: String(q.why || "").trim(), options, recommended: rec };
    })
    .filter((q) => q.question)
    .slice(0, 8);
}

// answers: { [questionId]: "<chosen or typed answer>" }; missing ones get the recommended option.
export async function answerQuestions(answers = {}) {
  const state = liveState || (await getState());
  if (!state?.qa || state.phase !== "qa") throw new Error("Autopilot isn't waiting for answers.");
  const filled = {};
  for (const q of state.qa.questions) {
    const a = String(answers[q.id] ?? "").trim();
    filled[q.id] = a || q.options[q.recommended] || "(your call)";
  }
  state.qa.answers = filled;
  state.qa.answeredAt = Date.now();
  state.phase = "handoff";
  state.status = "running";
  state.pauseReason = null;
  state.log = [
    ...(state.log || []),
    ...state.qa.questions.map((q) => ({ t: Date.now(), msg: `💬 ${q.question} → ${filled[q.id]}` })),
    { t: Date.now(), msg: "Thanks — planning the build with your answers." },
  ].slice(-300);
  await saveState(state);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
  return { ok: true };
}

// A message from you while Autopilot runs (side panel → log chat box).
export async function addNote(text) {
  text = String(text || "").trim().slice(0, 2000);
  if (!text) throw new Error("Type a message first.");
  const state = liveState || (await getState());
  if (!state) throw new Error("Autopilot isn't running.");
  const note = { id: store.uid(), t: Date.now(), text, seen: false };
  state.notes = [...(state.notes || []), note].slice(-50);
  const log = [{ t: Date.now(), msg: `💬 You: ${text}` }];
  if (state.status === "waiting") {
    note.seen = true;
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Noted — I'll take that into account along with your answers." });
  } else if (state.status === "paused" || state.status === "stopped" || state.status === "error") {
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Saved — I'll act on it when you press Resume." });
  } else if (state.phase !== "build") {
    // Exploring / writing the handoff / setting up: it's applied as an instruction from now on.
    note.seen = true;
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Got it — I'll follow that for the rest of the run." });
  } else {
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Got it — reading it now." });
  }
  state.log = [...(state.log || []), ...log].slice(-300);
  await saveState(state);
  return { ok: true };
}

export async function reset() {
  await stop();
  await store.set("autopilot", null);
}

// Called by the keepalive alarm: restart the loop if the worker was restarted mid-run.
export async function tick() {
  const state = await getState();
  if (state?.status === "running" && !running) run();
  if (!state || !["running", "paused", "waiting"].includes(state.status)) await chrome.alarms.clear(ALARM);
}

async function run() {
  if (running) return;
  running = true;
  stopRequested = false;
  const settings = await store.getSettings();
  let state = await getState();
  const ctx = makeCtx(state, settings);
  liveState = state;
  try {
    while (!stopRequested) {
      state = ctx.state;
      if (state.status !== "running") break;

      if (state.phase === "explore") {
        const more = await explorer.explorePage(ctx);
        if (!more) {
          await explorer.release();
          await ctx.log(`Exploration finished: ${state.explore.pages.length} screen(s) written up.`);
          await ctx.save({ phase: settings.askQuestions !== false ? "qa" : "handoff" });
        }
      } else if (state.phase === "qa") {
        // Ask the human what Claude can't decide alone, then wait for the answers.
        if (!state.qa) {
          await ctx.log("Working out what to ask you before planning the build…");
          const questions = await makeQuestions(state, settings).catch(async (e) => {
            await ctx.log(`Couldn't prepare questions (${e.message}) — carrying on without them.`);
            return [];
          });
          if (!questions.length) {
            await ctx.log("No open questions — going straight to the build steps.");
            await ctx.save({ phase: "handoff" });
            continue;
          }
          await ctx.save({ qa: { questions, answers: {}, askedAt: Date.now() } });
        }
        await ctx.save({ status: "waiting", message: `${state.qa.questions.length} question(s) for you — answer them in the Autopilot card.` });
        await ctx.log(`❓ ${state.qa.questions.length} question(s) for you before planning the build — answer them in the Autopilot card (or use the recommended answers).`);
        notify("Autopilot has questions", `${state.qa.questions.length} quick question(s) about how to build the clone in Scram. Answer them in the side panel.`);
        break;
      } else if (state.phase === "handoff") {
        await ctx.log("Generating the handoff step files…");
        const files = await generateHandoff(state.siteUrl, { instructions: store.runInstructions(state) });
        const appName = files.find((f) => f.fileType === "manifest")?.appName;
        const steps = files.filter((f) => f.fileType === "step").length;
        await ctx.save({ phase: settings.autopilotBuild ? "scram-setup" : "finished", build: { ...state.build, appName, step: 0, sentStep: null, totalSteps: steps } });
        await ctx.log(`Handoff ready: ${steps} steps for “${appName}”.`);
      } else if (state.phase === "scram-setup") {
        await pilot.setup(ctx);
        await ctx.save({ phase: "build" });
      } else if (state.phase === "build") {
        const more = await pilot.buildRound(ctx);
        if (!more) await ctx.save({ phase: "finished" });
      } else if (state.phase === "finished") {
        await ctx.save({ status: "done" });
        await ctx.log(settings.autopilotBuild ? "All steps built and confirmed in Scram. 🎉" : "Handoff generated. Building in Scram is turned off in Options.");
        notify("Autopilot finished", ctx.state.message);
        break;
      }
    }
  } catch (err) {
    if (err instanceof StopError) {
      // already marked stopped
    } else if (err instanceof PauseError) {
      await ctx.save({ status: "paused", pauseReason: err.message });
      await ctx.log(`Paused — needs you: ${err.message}`);
      notify("Autopilot needs you", err.message);
    } else {
      console.error(err);
      await ctx.save({ status: "error", pauseReason: err.message });
      await ctx.log(`Error: ${err.message}`);
      notify("Autopilot error", err.message);
    }
  } finally {
    running = false;
    liveState = null;
  }
}
