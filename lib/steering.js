// Live steering from Ask Autopilot (CONTROL_CENTER_ASK_AUTOPILOT_STEERING.md): the answerer
// returns actions ("skip step 14", "use blue buttons from now on", "send this to Scram now"…) and
// they're applied to the run immediately — running, paused, waiting, in error or stopped. Every
// action is validated; one that can't be applied is skipped with a plain reason. Never throws.

import * as store from "./storage.js";
import * as autopilot from "./autopilot.js";

export const ACTION_TYPES = ["instruct", "send_to_scram_now", "skip_step", "redo_step", "add_step", "edit_step", "update_spec", "jump_to_step", "pause", "resume", "stop", "answer_questions", "remove_instruction", "build_again"];

const ACTIVE = ["running", "paused", "waiting"];
const clean = (s, n = 4000) => String(s ?? "").trim().slice(0, n);

// The plan as the answerer and the site see it: 1-based step numbers.
export async function planOf(state) {
  if (!state?.siteUrl) return [];
  const steps = await store.getSteps(state.siteUrl);
  const b = state.build || {};
  const progress = await store.getProgress(state.siteUrl);
  const done = new Set(progress.completedSteps || []);
  const skipped = new Set(b.skipSteps || []);
  const inBuild = ["build", "finished"].includes(state.phase) || b.sentStep != null;
  return steps.map((s, i) => ({
    n: i + 1,
    title: s.title,
    status: skipped.has(s.stepNumber) ? "skipped" : done.has(s.stepNumber) ? "done" : inBuild && i === b.step ? "current" : "upcoming",
  }));
}

// Renumber step files to 0..n-1 in order (after an insert), keeping progress and skips aligned.
async function saveSteps(siteUrl, ordered, b) {
  const remap = new Map(ordered.map((s, i) => [s.stepNumber, i]));
  const files = (await store.get("handoffFiles", [])).filter((f) => !(f.siteUrl === siteUrl && f.fileType === "step"));
  const renumbered = ordered.map((s, i) => ({ ...s, stepNumber: i }));
  await store.set("handoffFiles", [...files, ...renumbered]);
  const p = await store.getProgress(siteUrl);
  await store.setProgress({ ...p, completedSteps: (p.completedSteps || []).map((n) => remap.get(n)).filter((n) => n != null) });
  if (b) {
    b.skipSteps = (b.skipSteps || []).map((n) => remap.get(n)).filter((n) => n != null);
    if (b.redo) b.redo.stepNumber = remap.get(b.redo.stepNumber) ?? b.redo.stepNumber;
    b.totalSteps = renumbered.length;
  }
  return renumbered;
}

function stepIndex(n, steps) {
  const i = Math.round(Number(n)) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= steps.length) throw new Error(`there's no step ${n} (the plan has steps 1–${steps.length})`);
  return i;
}

// Something changed which step the build is on: the round in progress stops waiting and its
// result for the old step is ignored (scram-pilot checks steerEpoch).
function interrupt(b) {
  b.steerEpoch = (b.steerEpoch || 0) + 1;
  b.sentStep = null;
}

async function needSteps(state) {
  const steps = await store.getSteps(state.siteUrl);
  if (!steps.length) throw new Error("the build plan isn't written yet");
  state.build ||= { step: 0, sentStep: null, rounds: 0, history: [] };
  return steps;
}

// One action on the CURRENT run. Returns a one-line summary of what changed.
async function applyOne(act, state) {
  const b = () => (state.build ||= { step: 0, sentStep: null, rounds: 0, history: [] });
  switch (act.type) {
    case "instruct": {
      const text = clean(act.text, 2000);
      if (!text) throw new Error("the instruction was empty");
      if (act.standing) {
        const item = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text, createdAt: Date.now(), source: "chat" };
        state.steering = [...(state.steering || []), item];
        // Also tell the supervisor now, so it acts on it this round, not only in later prompts.
        state.notes = [...(state.notes || []), { id: store.uid(), t: Date.now(), text: `New standing instruction (follow it from now on): ${text}`, seen: !(state.phase === "build" && state.status === "running"), fromAsk: true }].slice(-50);
        return `standing instruction added: “${text}”`;
      }
      const inBuild = state.phase === "build";
      state.notes = [...(state.notes || []), { id: store.uid(), t: Date.now(), text, seen: !(inBuild && ["running", "paused", "error"].includes(state.status)), fromAsk: true, ...(inBuild ? { step: b().step } : {}) }].slice(-50);
      return inBuild ? `instruction for step ${b().step + 1}: “${text}”` : `instruction noted for the rest of the run: “${text}”`;
    }
    case "send_to_scram_now": {
      const text = clean(act.text, 4000);
      if (!text) throw new Error("the message was empty");
      b().sendNow = [...(b().sendNow || []), text];
      const live = state.phase === "build" && state.status === "running";
      return live ? `sending to Scram's AI as soon as its current reply finishes: “${text.slice(0, 120)}”` : `will send to Scram's AI when the build is running again: “${text.slice(0, 120)}”`;
    }
    case "skip_step": {
      const steps = await needSteps(state);
      const i = stepIndex(act.step, steps);
      const bb = b();
      const done = new Set((await store.getProgress(state.siteUrl)).completedSteps || []);
      if (i < bb.step || done.has(steps[i].stepNumber)) throw new Error(`step ${i + 1} is already done`);
      bb.skipSteps = [...new Set([...(bb.skipSteps || []), steps[i].stepNumber])];
      if (i === bb.step) {
        bb.step += 1;
        interrupt(bb);
        return `skipped step ${i + 1} (${steps[i].title}) — moving on to step ${i + 2 <= steps.length ? i + 2 : "the final review"}`;
      }
      return `step ${i + 1} (${steps[i].title}) will be skipped`;
    }
    case "jump_to_step": {
      const steps = await needSteps(state);
      const i = stepIndex(act.step, steps);
      const bb = b();
      bb.skipSteps = (bb.skipSteps || []).filter((n) => n !== steps[i].stepNumber);
      bb.step = i;
      bb.returnTo = null;
      bb.redo = null;
      interrupt(bb);
      return `continuing from step ${i + 1} (${steps[i].title})`;
    }
    case "redo_step": {
      const steps = await needSteps(state);
      const i = stepIndex(act.step, steps);
      const bb = b();
      const done = new Set((await store.getProgress(state.siteUrl)).completedSteps || []);
      if (i >= bb.step && !done.has(steps[i].stepNumber)) throw new Error(`step ${i + 1} hasn't been built yet, so there's nothing to redo`);
      if (bb.returnTo == null) bb.returnTo = bb.step;
      bb.redo = { stepNumber: steps[i].stepNumber, reason: clean(act.reason, 1500) || "the user asked to redo it" };
      bb.step = i;
      interrupt(bb);
      return `redoing step ${i + 1} (${steps[i].title})${bb.redo.reason ? ` — ${bb.redo.reason}` : ""}, then back to step ${bb.returnTo + 1}`;
    }
    case "add_step": {
      const steps = await needSteps(state);
      const after = Math.round(Number(act.after));
      if (!Number.isInteger(after) || after < 0 || after > steps.length) throw new Error(`can't add a step after step ${act.after} (the plan has steps 1–${steps.length})`);
      const title = clean(act.title, 200) || "New step";
      const instructions = clean(act.instructions, 20000);
      if (!instructions) throw new Error("the new step had no instructions");
      const bb = b();
      const file = {
        id: store.uid(),
        siteUrl: state.siteUrl,
        fileType: "step",
        stepNumber: -1,
        title,
        summary: title,
        content: store.withTestingSection(`# Step ${after + 1} — ${title}\n\n(Added from the RoboBuild chat.)\n\n## Objective\n${instructions}`),
        createdAt: new Date().toISOString(),
        addedFromChat: true,
      };
      const ordered = [...steps.slice(0, after), file, ...steps.slice(after)];
      const inBuild = state.phase === "build" || bb.sentStep != null || bb.step > 0;
      const before = inBuild && after <= bb.step;
      // Inserted at or before the step being built: build it next, then come back.
      if (before) {
        const returnTo = bb.step + 1; // the current step moved down by one
        bb.returnTo = bb.returnTo == null ? returnTo : bb.returnTo + 1;
        bb.step = after;
        interrupt(bb);
      }
      await saveSteps(state.siteUrl, ordered, bb);
      return `added step ${after + 1} “${title}”${after < steps.length ? ` (the steps after it are now ${after + 2}–${steps.length + 1})` : ""}${before ? " — building it next" : ""}`;
    }
    case "edit_step": {
      const steps = await needSteps(state);
      const i = stepIndex(act.step, steps);
      const instructions = clean(act.instructions, 20000);
      if (!instructions) throw new Error("no new instructions were given");
      const bb = b();
      const started = i < bb.step || (i === bb.step && bb.sentStep === bb.step && state.phase === "build");
      if (started) {
        // Already built / being built: apply it as an instruction for that step instead.
        if (i !== bb.step) throw new Error(`step ${i + 1} is already built — ask me to redo it with the change instead`);
        state.notes = [...(state.notes || []), { id: store.uid(), t: Date.now(), text: `Change to this step: ${instructions}`, seen: false, fromAsk: true, step: bb.step }].slice(-50);
        return `step ${i + 1} is being built now, so the change was given to the supervisor for this step`;
      }
      const ordered = steps.map((s, k) => (k === i ? { ...s, content: `${s.content}\n\n## Updated instructions (from the user — these override anything above that conflicts)\n${instructions}`, editedFromChat: Date.now() } : s));
      await saveSteps(state.siteUrl, ordered, bb);
      return `updated step ${i + 1} (${steps[i].title})`;
    }
    case "update_spec": {
      const section = clean(act.section, 120) || "General";
      const text = clean(act.text, 8000);
      if (!text) throw new Error("the spec change was empty");
      state.specAmendments = [...(state.specAmendments || []), { section, text, at: Date.now() }];
      // Amend the documents too (re-reported to the site): the step manifest, and the design
      // concept when it's about the look.
      const files = await store.get("handoffFiles", []);
      const mi = files.findIndex((f) => f.siteUrl === state.siteUrl && f.fileType === "manifest");
      if (mi >= 0) {
        files[mi] = { ...files[mi], content: `${files[mi].content}\n\n## Amendment — ${section} (from the RoboBuild chat)\n${text}` };
        await store.set("handoffFiles", files);
      }
      if (/design|colou?r|theme|font|type|look|style|vibe|button|dark|light/i.test(`${section} ${text}`)) {
        const briefs = await store.get("designBriefs", {});
        if (briefs[state.siteUrl]) {
          briefs[state.siteUrl] = { ...briefs[state.siteUrl], content: `${briefs[state.siteUrl].content}\n\n## Amendment — ${section} (from the RoboBuild chat)\n${text}` };
          await store.set("designBriefs", briefs);
        }
      }
      state.notes = [...(state.notes || []), { id: store.uid(), t: Date.now(), text: `Spec change (${section}): ${text}`, seen: !(state.phase === "build" && state.status === "running"), fromAsk: true }].slice(-50);
      return `spec amended (${section}): “${text.slice(0, 120)}” — later steps follow it`;
    }
    case "remove_instruction": {
      const list = state.steering || [];
      const hit = list.find((s) => s.id === act.id) || (act.text ? list.find((s) => s.text.toLowerCase().includes(String(act.text).toLowerCase())) : null);
      if (!hit) throw new Error(`there's no standing instruction ${act.id ? `with id ${act.id}` : `like “${act.text}”`}`);
      state.steering = list.filter((s) => s !== hit);
      state.notes = [...(state.notes || []), { id: store.uid(), t: Date.now(), text: `The user REMOVED this standing instruction — stop following it: ${hit.text}`, seen: !(state.phase === "build" && state.status === "running"), fromAsk: true }].slice(-50);
      return `removed the instruction “${hit.text}”`;
    }
    default:
      throw new Error(`unknown action “${act.type}”`);
  }
}

// Actions that call the run's own controls (they save the run themselves).
async function control(act, state) {
  switch (act.type) {
    case "pause":
      if (state.status !== "running") throw new Error(`the run isn't running (it's ${state.status}), so there's nothing to pause`);
      await autopilot.pause();
      return "paused the run";
    case "resume":
      if (state.status === "running") return "the run is already running";
      if (state.status === "done") throw new Error("this run has finished — ask me to build it again if you want another build");
      await autopilot.resume();
      return state.status === "stopped" ? "restarted the stopped run" : "resumed the run";
    case "stop":
      if (!ACTIVE.includes(state.status)) throw new Error(`the run is already ${state.status}`);
      await autopilot.stop();
      return "stopped the run";
    case "answer_questions": {
      if (!(state.status === "waiting" && state.phase === "qa")) throw new Error("there are no questions waiting for answers");
      const answers = {};
      for (const [k, v] of Object.entries(act.answers && typeof act.answers === "object" ? act.answers : {})) answers[clean(k, 40)] = clean(v, 2000);
      await autopilot.answerQuestions(answers);
      return `answered the questions (${Object.keys(answers).length} chosen, the rest recommended)`;
    }
    default:
      return null;
  }
}

// Apply the answerer's actions to the run they're about. `run` = { current, state }.
// Returns [{ type, summary, ok }].
export async function applyActions(actions, run) {
  const results = [];
  const list = (Array.isArray(actions) ? actions : []).filter((a) => a && typeof a === "object").slice(0, 12);
  for (const act of list) {
    const type = String(act.type || "");
    try {
      if (!ACTION_TYPES.includes(type)) throw new Error(`I don't know how to “${type}”`);
      if (type === "build_again") {
        const site = run.state?.siteUrl;
        if (!site) throw new Error("I don't know which site that run was");
        const cur = await store.get("autopilot", null);
        if (cur && ACTIVE.includes(cur.status)) throw new Error("another run is active — stop it first");
        await autopilot.startBuildFrom({ siteUrl: site, instructions: run.state.instructions || "" });
        results.push({ type, ok: true, summary: `started a new build of ${new URL(site).host} from its existing steps` });
        continue;
      }
      if (!run.current) throw new Error("that run isn't the one loaded in RoboBuild any more, so I can't change it (I can start a new build from its steps)");
      const state = await store.get("autopilot", null);
      if (!state) throw new Error("no run is loaded in RoboBuild");
      const viaControl = await control(act, state);
      if (viaControl) {
        results.push({ type, ok: true, summary: viaControl });
        continue;
      }
      const summary = await autopilot.mutateRun((s) => applyOne(act, s));
      results.push({ type, ok: true, summary });
    } catch (e) {
      results.push({ type, ok: false, summary: String(e?.message || e) });
    }
  }
  return results;
}
