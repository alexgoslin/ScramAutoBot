// "Skills test": prove, live in Scram, each thing Autopilot knows how to do — open Scram in its
// own tab, create and rename a project, switch to Run mode, change the preview size, use the chat
// box, attach a file, and let its UI agent operate the editor. Each skill is checked afterwards
// and reported ✅ / ❌ / ⏭ in chrome.storage ("skillsTest") for tools/skills-test.html.

import * as store from "./storage.js";
import { dom, sleep } from "./dom.js";
import * as pilot from "./scram-pilot.js";
import { attachToScram, rememberMethod, realClick } from "./scram-attach.js";
import { StopError } from "./errors.js";

export const SKILLS = [
  { id: "open", label: "Open Scram in its own tab (and wait if you need to log in)" },
  { id: "create", label: "Create a new project with “Create new project” and wait for its editor", createOnly: true },
  { id: "rename", label: "Rename the project (More → project name)" },
  { id: "runmode", label: "Switch Scram to Run mode (from Edit), with a real click" },
  { id: "sizes", label: "Change the preview size: Tablet → Mobile → Desktop" },
  { id: "type", label: "Type into Scram's AI chat box, then clear it (nothing is sent)" },
  { id: "attach", label: "Attach a test .md file to the AI chat (not sent)" },
  { id: "agent", label: "Do-it-myself agent: open “More”, then go back to the Frontend view (uses a little Claude credit)" },
];

let running = false;
let stopRequested = false;

const save = (state) => store.set("skillsTest", state);

export async function stop() {
  stopRequested = true;
  const st = await store.get("skillsTest", null);
  if (st?.status === "running") await save({ ...st, status: "stopped", finishedAt: Date.now() });
}

// mode: "create" (new throwaway project) | "existing" (a project tab you picked)
export async function start({ mode = "create", tabId = null, skills = SKILLS.map((s) => s.id) }) {
  if (running) throw new Error("A skills test is already running.");
  if (mode === "existing") {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab || !store.isScramEditorUrl(tab.url)) throw new Error("Pick a Scram project editor tab (editor.buildwithscram.com).");
  }
  running = true;
  stopRequested = false;
  const wanted = new Set(skills);
  const state = {
    status: "running",
    mode,
    startedAt: Date.now(),
    log: [],
    steps: SKILLS.map((s) => ({
      id: s.id,
      label: s.id === "open" && mode === "existing" ? "Use the project tab you picked" : s.label,
      status: (s.createOnly && mode !== "create") || !wanted.has(s.id) ? "skip" : "pending",
      detail: s.createOnly && mode !== "create" ? "only when creating a new project" : !wanted.has(s.id) ? "not selected" : "",
    })),
  };
  await save(state);
  run(state, mode, Number(tabId) || null).finally(() => (running = false));
  return state;
}

async function run(state, mode, pickedTab) {
  const settings = await store.getSettings();
  const ctx = {
    state: { siteUrl: "", instructions: "", notes: [], build: { tabId: mode === "existing" ? pickedTab : null, step: 0, rounds: 0, history: [] } },
    settings,
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
  const tab = () => b.tabId;
  const testName = `AutoBot test ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  const SKILL_FNS = {
    async open() {
      if (mode === "existing") {
        await chrome.tabs.update(tab(), { active: true });
        return { ok: true, detail: "using your project tab" };
      }
      await pilot.ensureScramTab(ctx);
      await pilot.waitForLogin(ctx, tab());
      return { ok: true, detail: `opened ${new URL((await chrome.tabs.get(tab())).url).host}` };
    },

    async create() {
      await pilot.openOrCreateProject(ctx, testName);
      const t = await chrome.tabs.get(tab());
      const ok = store.isScramEditorUrl(t.url) && !!(await dom(tab(), "findChatInput"));
      return { ok, detail: ok ? "new project's editor is open with its AI chat" : `ended up on ${t.url}` };
    },

    async rename() {
      if (mode === "create") {
        const ok = await pilot.renameProject(ctx, tab(), testName);
        return { ok, detail: ok ? `renamed to “${testName}”` : "couldn't rename it" };
      }
      // Your own project: rename it to a test name, then back to what it was.
      const original = ((await chrome.tabs.get(tab())).title || "").replace(/\s*-\s*Editor\s*\|\s*Scram\s*$/i, "").trim();
      if (!original) return { ok: false, detail: "couldn't read the project's current name" };
      const ok = await pilot.renameProject(ctx, tab(), testName);
      const back = await pilot.renameProject(ctx, tab(), original);
      return { ok: ok && back, detail: ok ? `renamed to “${testName}”${back ? `, then back to “${original}”` : ` — but couldn't rename it back to “${original}”, please fix it by hand`}` : "couldn't rename it" };
    },

    async runmode() {
      let t = await dom(tab(), "modeToggle");
      if (!t) {
        await pilot.closePlansPanel(ctx, tab()).catch(() => false);
        await sleep(1000);
        t = await dom(tab(), "modeToggle");
      }
      if (!t) return { ok: false, detail: "couldn't find the Edit / Run buttons" };
      // Start from Edit so the switch is real.
      if (t.active !== false && t.editId) {
        await realClick(tab(), { id: t.editId }).catch(() => {});
        await sleep(1500);
      }
      const before = (await dom(tab(), "modeToggle"))?.active;
      await pilot.ensureRunMode(ctx, tab(), { force: true });
      const after = (await dom(tab(), "modeToggle"))?.active;
      if (after === true) return { ok: true, detail: `${before === false ? "Edit → " : ""}Run mode is on` };
      if (after === null) return { ok: true, detail: "clicked Run, but Scram doesn't show which mode is on — check the toolbar" };
      return { ok: false, detail: "clicked Run, but it still looks like Edit mode" };
    },

    async sizes() {
      const done = [];
      for (const size of ["tablet", "mobile", "desktop"]) {
        ctx.checkStop();
        const ok = await pilot.setPreviewSize(ctx, tab(), size);
        const now = await pilot.previewSizeNow(tab()).catch(() => null);
        done.push(`${size}: ${ok ? "✓" : "✗"}${now && now !== size ? ` (shows ${now})` : ""}`);
        if (!ok) return { ok: false, detail: done.join(" · ") };
        await sleep(800);
      }
      return { ok: true, detail: done.join(" · ") };
    },

    async type() {
      const input = await dom(tab(), "findChatInput");
      if (!input) return { ok: false, detail: "couldn't find the “Ask Claude…” box" };
      const text = "AutoBot skills test — typing works (this won't be sent)";
      await dom(tab(), "typeText", input, text);
      await sleep(600);
      const typed = (await dom(tab(), "inputValue", input)) || "";
      await dom(tab(), "typeText", input, "");
      await sleep(400);
      const cleared = !((await dom(tab(), "inputValue", input)) || "").trim();
      const ok = typed.includes("typing works") && cleared;
      return { ok, detail: ok ? "typed a line into the chat box and cleared it again" : `typed: ${typed ? "yes" : "no"}, cleared: ${cleared ? "yes" : "no"}` };
    },

    async attach() {
      const name = "autobot-skills-test.md";
      const res = await attachToScram(tab(), name, "# Scram AutoBot skills test\n\nThis file was attached by the extension's skills test. It was not sent — you can remove it from the chat box.\n", {
        preferred: settings.scramAttachMethod || null,
        onTry: (m) => ctx.log(`Attaching ${name} — trying “${m}”…`),
      });
      if (res.ok && res.method !== settings.scramAttachMethod) await rememberMethod(res.method);
      return { ok: res.ok, detail: res.ok ? `attached with “${res.method}” — it's sitting in the chat box unsent; remove it with its ✕` : res.log.filter((l) => l.startsWith("❌")).slice(-2).join(" · ") || "no method worked" };
    },

    async agent() {
      if (!(await store.get("apiKey", ""))) return { ok: false, detail: "needs your Anthropic API key (Settings)" };
      const ok = await pilot.uiAgent(
        ctx,
        tab(),
        'Click "More" in the top-left toolbar to open the project overview. Then click the "Frontend" tab (e.g. "Frontend 1") in the toolbar to go back to the page editor. Do not type anything or use the AI chat. Finish with done once the page editor is showing again.',
        { maxSteps: 8, optional: true }
      );
      return { ok, detail: ok ? "it operated Scram's editor by itself and came back to the Frontend view" : "it couldn't finish (see the log)" };
    },
  };

  try {
    for (const step of state.steps) {
      if (step.status === "skip") continue;
      ctx.checkStop();
      // Without the project open, later skills can't run.
      if (!tab() && step.id !== "open") {
        step.status = "skip";
        step.detail = "no Scram tab";
        continue;
      }
      step.status = "running";
      await ctx.log(`▶ ${step.label}`);
      try {
        const r = await SKILL_FNS[step.id]();
        step.status = r.ok ? "pass" : "fail";
        step.detail = r.detail || "";
      } catch (e) {
        if (e instanceof StopError) throw e;
        step.status = "fail";
        step.detail = e.message;
      }
      await ctx.log(`${step.status === "pass" ? "✅" : "❌"} ${step.label} — ${step.detail}`);
      if (["open", "create"].includes(step.id) && step.status === "fail") {
        for (const s of state.steps) if (s.status === "pending") Object.assign(s, { status: "skip", detail: "needs the project open" });
      }
    }
    const passed = state.steps.filter((s) => s.status === "pass").length;
    const failed = state.steps.filter((s) => s.status === "fail").length;
    state.status = "done";
    await ctx.log(`Finished: ${passed} passed, ${failed} failed.`);
  } catch (e) {
    if (e instanceof StopError) state.status = "stopped";
    else {
      state.status = "error";
      state.log = [...state.log, { t: Date.now(), msg: `Error: ${e.message}` }];
    }
    for (const s of state.steps) if (["pending", "running"].includes(s.status)) Object.assign(s, { status: "skip", detail: "stopped" });
  } finally {
    state.finishedAt = Date.now();
    await save(state);
  }
}
