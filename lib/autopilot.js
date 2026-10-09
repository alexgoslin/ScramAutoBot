// Autopilot: explore a site → write specs → generate handoff → build it in Scram,
// with no clicks from the user. State lives in chrome.storage ("autopilot") so the
// run survives service-worker restarts; an alarm resumes it if the worker was killed.

import * as store from "./storage.js";
import { totalCost } from "./pricing.js";
import { generateHandoff, askJson, ask, loadPrompt, loadScramGuide } from "./jobs.js";
import * as explorer from "./explorer.js";
import * as pilot from "./scram-pilot.js";
import { writeBriefing } from "./briefing.js";

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

// Pause from the side panel: the loop stops at its next checkpoint (like Stop), but the run is
// marked "paused" so you can talk to Autopilot about it and then press Resume.
export async function pause() {
  const state = liveState || (await getState());
  if (!state || state.status !== "running") throw new Error("Autopilot isn't running.");
  stopRequested = true;
  const saved = await getState();
  saved.status = "paused";
  saved.pauseReason = "Paused by you — message me in the log below, then press Resume.";
  saved.message = saved.pauseReason;
  saved.log = [...(saved.log || []), { t: Date.now(), msg: "⏸ Paused by you. Ask me anything about the run below, or tell me what to change — I'll apply it when you press Resume." }].slice(-300);
  await saveState(saved);
  await explorer.release();
  await chrome.alarms.clear(ALARM);
}

export async function resume() {
  const state = await getState();
  if (!state) throw new Error("Nothing to resume.");
  if (state.status === "done") throw new Error("This run already finished.");
  if (state.status === "waiting" && state.phase === "qa") return answerQuestions({});
  // A paused/stopped loop may still be finishing its last action — let it end first.
  for (let i = 0; i < 240 && running; i++) await new Promise((r) => setTimeout(r, 500));
  const fresh = (await getState()) || state; // messages may have arrived while waiting
  fresh.status = "running";
  fresh.pauseReason = null;
  fresh.log = [...(fresh.log || []), { t: Date.now(), msg: "▶ Resumed." }].slice(-300);
  await saveState(fresh);
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  run();
}

// ---- Q&A: questions for the human between research and planning the build.

const QA_SYSTEM = `You are about to plan how to clone a website's core features in Scram (a no-code app builder with an AI builder; see the Scram guide). Before planning, list the questions you genuinely need the human to answer — decisions that materially change HOW it's built in Scram and that you can't sensibly decide yourself from the specs, the human's instructions and the Scram guide. Examples of good questions: how sign-up/login should work, whether a feed must update live or on refresh, how media uploads are stored and limited, which user roles exist, what happens with features Scram can't do natively, which of two reasonable data designs to use, what to do about payments or third-party integrations, naming/branding. Don't ask about things already decided (instructions, scope) or trivia; prefer fewer, sharper questions (at most 10, often 3–7). If nothing is genuinely open, return no questions.

You may also get UNCERTAINTIES NOTED DURING THE CRAWL — things the crawler wasn't sure how to build in Scram, with the screen it saw them on. Cover every one that is still genuinely open (they come first), merging similar ones into one question; drop any the specs, instructions or guide already settle. For a question that comes from those notes, set "from" to the screen name(s) it came from.

For each question give 2–4 concrete options and mark the one you recommend. Keep each question to one line, each option short.

Return ONLY JSON: {"questions":[{"id":"q1","question":"...","why":"<one line: what it changes in the build>","options":["...","..."],"recommended":<index of the recommended option>,"from":"<screen name, only for crawl notes>"}]}`;

async function makeQuestions(state, settings) {
  const specs = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === state.siteUrl)
    .map((s) => `<!-- ${s.pageTitle} (${s.pageUrl}) -->\n${s.content.slice(0, 6000)}`)
    .join("\n\n---\n\n")
    .slice(0, 60000);
  const guide = await loadScramGuide();
  const instr = store.runInstructions({ ...state, qa: null });
  const unsure = state.explore?.unsure || [];
  const notes = unsure.length
    ? `UNCERTAINTIES NOTED DURING THE CRAWL (ask about these first):\n${unsure.map((u) => `- [${u.page}] ${u.question}${u.why ? ` — ${u.why}` : ""}`).join("\n")}\n\n`
    : "";
  const userContent = `${instr ? `The human's instructions and scope:\n${instr}\n\n` : ""}${notes}<scram_guide>\n${guide}\n</scram_guide>\n\nScreen specs of ${state.siteUrl}:\n${specs || "(none)"}`;
  const res = await askJson({ what: "Q&A planner", system: QA_SYSTEM, userContent, maxTokens: 3000, model: settings.model });
  return (Array.isArray(res.questions) ? res.questions : [])
    .map((q, i) => {
      const options = (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean).slice(0, 4);
      const rec = Number.isInteger(q.recommended) && q.recommended >= 0 && q.recommended < options.length ? q.recommended : 0;
      const from = String(q.from || "").trim().slice(0, 120);
      return { id: String(q.id || `q${i + 1}`), question: String(q.question || "").trim(), why: String(q.why || "").trim(), options, recommended: rec, ...(from ? { from } : {}) };
    })
    .filter((q) => q.question)
    .slice(0, 10);
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
  // After Pause/Stop the loop may still be unwinding; its in-memory copy is stale then.
  const state = (!stopRequested && liveState) || (await getState());
  if (!state) throw new Error("Autopilot hasn't been started yet.");
  const note = { id: store.uid(), t: Date.now(), text, seen: false };
  state.notes = [...(state.notes || []), note].slice(-50);
  const log = [{ t: Date.now(), msg: `💬 You: ${text}` }];
  // While it isn't working (paused, stopped, errored, finished), Autopilot answers you itself.
  const idle = ["paused", "stopped", "error", "done"].includes(state.status);
  if (state.status === "waiting") {
    note.seen = true;
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Noted — I'll take that into account along with your answers." });
  } else if (idle) {
    if (state.phase !== "build" || state.status === "done") note.seen = true; // applied as an instruction / nothing left to act on
    state.replying = Date.now();
  } else if (state.phase !== "build") {
    // Exploring / writing the handoff / setting up: it's applied as an instruction from now on.
    note.seen = true;
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Got it — I'll follow that for the rest of the run." });
  } else {
    log.push({ t: Date.now(), msg: "🤖 Autopilot: Got it — reading it now." });
  }
  state.log = [...(state.log || []), ...log].slice(-300);
  await saveState(state);
  if (idle) replyWhileIdle(note); // answered in the background; the reply appears in the log
  return { ok: true };
}

const CHAT_SYSTEM = `You are Autopilot, a Chrome extension that clones a website's core features into Scram (a no-code app builder) by researching the site, writing step files, and supervising Scram's AI as it builds them. The run is not working right now (the human paused or stopped it, it hit a problem, or it finished), and the human is chatting with you in the run's log.

Answer as Autopilot, in first person, briefly (usually 1–4 sentences, never more than ~120 words), plain English, no Markdown headings. Use ONLY the run details given: what you've done, where you are, why you paused, what's next. If you don't know something, say so.
If the human gives an instruction or correction (e.g. "skip the settings page", "tell Scram to use blue buttons"), confirm what you'll do with it: it's saved and you'll apply it when they press Resume (or, if the run is finished, say it would need a new run). Don't claim you've already done it. If they ask you to continue, tell them to press Resume.`;

function runSummary(state) {
  const b = state.build || {};
  const sc = state.scope || {};
  const ex = state.explore || {};
  const qa = state.qa?.questions?.length ? state.qa.questions.map((q) => `- ${q.question} → ${state.qa.answers?.[q.id] ?? "(not answered yet)"}`).join("\n") : "(none)";
  return [
    `Site being cloned: ${state.siteUrl}`,
    `Status: ${state.status}${state.pauseReason ? ` — ${state.pauseReason}` : ""}. Phase: ${state.phase}.`,
    state.instructions ? `Human's instructions at the start: ${state.instructions}` : "",
    sc.core?.length ? `Core features: ${sc.core.map((f) => f.name).join(", ")}. Skipping: ${(sc.skip || []).map((f) => f.name).join(", ") || "nothing"}.` : "",
    `Screens explored: ${(ex.pages || []).map((p) => p.name).join(", ") || "none yet"}.`,
    `Q&A decisions:\n${qa}`,
    b.totalSteps ? `Build: step ${Math.min((b.step || 0) + 1, b.totalSteps)} of ${b.totalSteps}, round ${b.rounds || 0} of this step. Recent actions on this step: ${(b.history || []).slice(-6).join(" | ") || "none"}.` : "Build not started yet.",
  ].filter(Boolean).join("\n");
}

async function replyWhileIdle(note) {
  let reply;
  try {
    const state = await getState();
    const settings = await store.getSettings();
    const recentLog = (state.log || []).slice(-40).map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.msg}`).join("\n");
    const chat = (state.notes || []).slice(-8).map((n) => `- ${n.text}`).join("\n");
    const res = await ask({
      system: CHAT_SYSTEM,
      userContent: `Run details:\n${runSummary(state)}\n\nRecent log (newest last):\n${recentLog}\n\nThe human's recent messages (newest last):\n${chat}\n\nReply to the human's latest message: ${note.text}`,
      maxTokens: 9000,
      model: settings.model,
    });
    reply = String(res.text || "").trim() || "Noted — I'll act on it when you press Resume.";
  } catch (e) {
    reply = `Saved — I'll act on it when you press Resume. (I couldn't answer just now: ${e.message})`;
  }
  const state = await getState();
  if (!state) return;
  state.replying = null;
  state.log = [...(state.log || []), { t: Date.now(), msg: `🤖 Autopilot: ${reply.replace(/\s*\n+\s*/g, " ").slice(0, 1500)}` }].slice(-300);
  await saveState(state);
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
          const noted = state.explore?.unsure?.length || 0;
          await ctx.log(`Working out what to ask you before planning the build${noted ? ` (including ${noted} thing(s) I wasn't sure about while crawling)` : ""}…`);
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
        // A plain-English briefing for you (research + your answers → what will be built).
        // Separate from the pipeline: written in the background, never waited for.
        if (!state.briefingStarted) {
          await ctx.save({ briefingStarted: Date.now() });
          await ctx.log("📄 Writing a research briefing for you (what I found and what I'll build) — it runs alongside and doesn't hold anything up.");
          writeBriefing(JSON.parse(JSON.stringify(state)), {
            onDone: (b) =>
              b.status === "done"
                ? notify("Research briefing ready", "Open it from the Autopilot card in the side panel: what I researched and what I intend to build.")
                : console.warn("Research briefing failed:", b.error),
          });
        }
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
