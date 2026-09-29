// "Scram chat test": run the Autopilot supervisor on a tiny throwaway task, so you can see
// it approve plans and answer questions in the real Scram chat before a full Autopilot run.
// Progress is written to chrome.storage ("chatTest") for tools/chat-test.html to show.

import * as store from "./storage.js";
import { dom, sleep } from "./dom.js";
import { superviseRound, sendMessage } from "./scram-pilot.js";
import { StopError } from "./errors.js";

const TEST_STEP = {
  stepNumber: 0,
  title: "Tester: Hello heading",
  content: `# Step 1 of 1: Tester — "Hello" heading

## Context
- This is a short test of an automation tool that drives the Scram chat. Keep everything minimal.

## Your scope for this step ONLY
- Add a heading that says "Hello from the tester" at the top of the Home Page.
- Style: use the theme's primary colour for the heading unless the builder suggests something better.

## Explicitly out of scope
- Anything else: no new pages, tables, workflows or data.

## Testing checklist
- [ ] The heading is visible at the top of the Home Page in Run mode.
- [ ] Nothing else in the project changed.

## Completion
Report back when the heading is visible and tested in Run mode.`,
};

const KICKOFF = `This is a quick test of an automation tool that drives this chat — please keep it tiny.

Task: add a heading that says "Hello from the tester" at the top of the Home Page.

Before building anything:
1. Propose a short plan and wait for my approval.
2. Ask me one question about the heading (for example its colour or size) and wait for my answer.

After building, check it in Run mode and confirm it's done.`;

let stopRequested = false;
let running = false;

async function save(state) {
  await store.set("chatTest", state);
}

export async function stop() {
  stopRequested = true;
  const st = await store.get("chatTest", null);
  if (st?.status === "running") await save({ ...st, status: "stopped", finishedAt: Date.now() });
}

// mode: "full" (send the test task, then handle replies) | "onscreen" (only handle what's there)
export async function start({ tabId, mode = "full", dryRun = true, maxRounds = 8 }) {
  if (running) throw new Error("A chat test is already running.");
  const tab = await chrome.tabs.get(tabId);
  if (!store.isScramEditorUrl(tab.url)) throw new Error("Pick a Scram PROJECT EDITOR tab (editor.buildwithscram.com) with the chat visible.");
  running = true;
  stopRequested = false;
  const state = { status: "running", mode, dryRun, maxRounds, log: [], startedAt: Date.now() };
  await save(state);
  run(tabId, state).finally(() => (running = false));
  return state;
}

async function run(tabId, state) {
  const settings = await store.getSettings();
  const ctx = {
    state: {
      siteUrl: "",
      instructions: "",
      build: { tabId, rounds: 0, history: [], baseline: "", sentText: "" },
    },
    // Handling what's already on screen shouldn't wait long for the page to "go quiet".
    settings: { ...settings, scramIdleSeconds: state.mode === "onscreen" ? 5 : settings.scramIdleSeconds },
    async save() {},
    async log(msg) {
      if (stopRequested) throw new StopError("Stopped");
      state.log = [...state.log, { t: Date.now(), msg }].slice(-200);
      await save(state);
    },
    checkStop() {
      if (stopRequested) throw new StopError("Stopped");
    },
    notify() {},
  };
  const b = ctx.state.build;

  try {
    await chrome.tabs.update(tabId, { active: true });
    const chat = await dom(tabId, "findChatInput");
    if (!chat) throw new Error("Couldn't find Scram's “Ask Claude…” chat box in that tab.");

    if (state.mode === "full") {
      b.baseline = (await dom(tabId, "bodyText")) || "";
      if (state.dryRun) {
        await ctx.log("DRY RUN — would send the test task to Scram (dry run never sends anything). Switch to “Handle what's on screen”, or untick Dry run, to go further.");
        state.status = "done";
        return;
      }
      await ctx.log("Sending the test task to Scram (asks for a plan and one question)…");
      await sendMessage(ctx, tabId, KICKOFF);
      b.sentText = KICKOFF;
    } else {
      await ctx.log(`Reading what's currently in the Scram chat${state.dryRun ? " (dry run — nothing will be clicked or typed)" : ""}…`);
    }

    for (let round = 1; round <= state.maxRounds; round++) {
      ctx.checkStop();
      await ctx.log(`Round ${round}: waiting for Scram's bot to finish…`);
      const { decision } = await superviseRound(ctx, tabId, TEST_STEP, 1, { dryRun: state.dryRun });
      if (state.dryRun) break;
      if (decision.action === "step_complete") {
        await ctx.log(`✅ Scram confirmed the test task is done: ${decision.summary || ""}`);
        break;
      }
      if (decision.action === "need_human") {
        await ctx.log(`⏸ The supervisor says this needs you: ${decision.reason || ""}`);
        break;
      }
      if (decision.action === "wait" || !decision.action) await sleep(10000);
      if (round === state.maxRounds) await ctx.log(`Stopped after ${state.maxRounds} round(s) (the limit you chose).`);
    }
    state.status = "done";
  } catch (e) {
    if (e instanceof StopError) state.status = "stopped";
    else {
      state.status = "error";
      state.log = [...state.log, { t: Date.now(), msg: `Error: ${e.message}` }];
    }
  } finally {
    state.finishedAt = Date.now();
    await save(state);
  }
}
