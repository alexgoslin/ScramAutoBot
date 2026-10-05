// "Explore Scram": Claude clicks around a Scram project editor on its own (safely — no
// publishing, deleting, sharing, billing, or chatting with Scram's AI), notes what every view
// and control does and how to get back, then writes a navigation guide. The guide is saved as
// "scramKnowledge" and given to the UI agent whenever Autopilot has to operate Scram's editor.

import * as store from "./storage.js";
import { dom, sleep, waitForLoad } from "./dom.js";
import * as pilot from "./scram-pilot.js";
import { askJson, ask } from "./jobs.js";
import { realClick } from "./scram-attach.js";
import { StopError } from "./errors.js";

// Never clicked while exploring, whatever Claude picks.
const DANGER = /publish|deploy|delete|remove|discard|reset|revert|restore|duplicate|invite|share|billing|upgrade|pricing|credits?\b|log ?out|sign ?out|transfer|archive|leave|api key|secret|payment|subscribe/i;

const EXPLORE_SYSTEM = `You are mapping the user interface of Scram (a no-code app builder) so an automation tool can navigate it reliably later. You're in a throwaway test project's editor. Explore by clicking things, one action per turn: open every tab, menu, panel, view and dialog you can find, see what each control does, and ALWAYS work out how to get back (Back buttons, breadcrumbs, close ×, Escape, the frontend tab next to "More"). Prefer controls you haven't tried yet; don't repeat yourself.

Rules: never click anything marked BLOCKED; never type anything; never use Scram's AI chat; don't change settings or data you'd need to undo — open things to look, then close or go back. If a dialog appears, look at it, then cancel/close it.

Each turn return ONLY JSON:
{"view":"<short name of the screen you're on now>","observation":"<what you learned from the PREVIOUS action and this screen: what it is, what's on it, how you got here, how to get back>","action":"click"|"back"|"escape"|"done","id":"<element id, for click>","why":"<what you expect to learn>"}
"back" = click the screen's Back control; "escape" = press Escape (closes menus/dialogs); "done" = you've covered the editor's views and controls.`;

const GUIDE_SYSTEM = `You write a navigation guide of Scram's project editor for an automation agent that has to operate it (open the AI chat, switch Edit/Run, change preview size, attach files, find its way back from any screen). Use ONLY what the exploration notes show. Be concrete and concise (markdown, bullets):
## Views — for each screen: how to recognise it (labels, layout), how to get there, and exactly how to get back to the page view with the AI chat.
## Key controls — where each important control is and what it does (AI chat box, attach, Edit/Run, preview size, Plans panel, More/Overview, frontend tab, Back, dialogs).
## Gotchas — things that hide the AI chat or the Run button, traps, things to avoid.`;

let running = false;
let stopRequested = false;
const save = (state) => store.set("scramExplore", state);

export async function stop() {
  stopRequested = true;
  const st = await store.get("scramExplore", null);
  if (st?.status === "running") await save({ ...st, status: "stopped", finishedAt: Date.now() });
}

export async function start({ mode = "create", tabId = null, maxActions = 30 }) {
  if (running) throw new Error("An exploration is already running.");
  if (!(await store.get("apiKey", ""))) throw new Error("Add your Anthropic API key in Settings first.");
  if (mode === "existing") {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab || !store.isScramEditorUrl(tab.url)) throw new Error("Pick a Scram project editor tab (editor.buildwithscram.com).");
  }
  running = true;
  stopRequested = false;
  const state = { status: "running", mode, maxActions, startedAt: Date.now(), log: [], notes: [], views: [], guide: "" };
  await save(state);
  run(state, mode, Number(tabId) || null, Math.min(80, Math.max(5, Number(maxActions) || 30))).finally(() => (running = false));
  return state;
}

async function run(state, mode, pickedTab, maxActions) {
  const settings = await store.getSettings();
  const ctx = {
    state: { siteUrl: "", instructions: "", notes: [], build: { tabId: mode === "existing" ? pickedTab : null, step: 0, rounds: 0, history: [] } },
    settings,
    async save() {},
    async log(msg) {
      if (stopRequested) throw new StopError("Stopped");
      state.log = [...state.log, { t: Date.now(), msg }].slice(-300);
      await save(state);
    },
    checkStop() {
      if (stopRequested) throw new StopError("Stopped");
    },
    notify() {},
  };
  const b = ctx.state.build;

  try {
    // 1. Get a project editor open.
    if (mode === "create") {
      await pilot.ensureScramTab(ctx);
      await pilot.waitForLogin(ctx, b.tabId);
      await pilot.openOrCreateProject(ctx, `AutoBot explorer ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } else {
      await chrome.tabs.update(b.tabId, { active: true });
    }
    const home = (await chrome.tabs.get(b.tabId)).url;
    await ctx.log(`Exploring Scram's editor (up to ${maxActions} actions)…`);

    // 2. Click around.
    for (let i = 1; i <= maxActions; i++) {
      ctx.checkStop();
      const tabId = b.tabId;
      // Stay inside the project editor.
      const tab = await chrome.tabs.get(tabId);
      if (!store.isScramEditorUrl(tab.url)) {
        await ctx.log(`Left the editor (${new URL(tab.url).host}) — going back to the project.`);
        await chrome.tabs.update(tabId, { url: home });
        await waitForLoad(tabId);
        await sleep(2500);
      }
      const snap = await dom(tabId, "snapshot", { maxElements: 200, maxText: 1500, pointer: true });
      const chat = await dom(tabId, "chatPanelBox").catch(() => null);
      const inChat = (e) => chat && e.box && e.box[0] >= chat.left - 1 && e.box[0] + e.box[2] <= chat.right + 1 && e.box[1] >= chat.top - 1 && e.box[1] + e.box[3] <= chat.bottom + 1;
      const blockedWhy = (e) => (DANGER.test(e.label || "") ? "risky" : e.editable ? "no typing" : inChat(e) ? "AI chat" : null);
      const lines = snap.elements.map((e) => {
        const why = blockedWhy(e);
        return [e.id, e.role || e.tag, JSON.stringify(e.label || ""), e.inLayer ? "in-dialog" : "", e.href ? `href=${e.href}` : "", why ? `BLOCKED(${why})` : ""].filter(Boolean).join(" | ");
      });
      const trail = state.notes.slice(-12).map((n) => `${n.i}. [${n.view}] ${n.action} → ${n.observation}`).join("\n");
      const userContent = `Action ${i} of ${maxActions}.
Views seen so far: ${state.views.join(", ") || "(none yet)"}
Recent actions and what you learned:
${trail || "(none yet — this is the start)"}

URL: ${snap.url}
Title: ${snap.title}
Open dialogs/menus: ${snap.layers.map((l) => `[${l.role}] ${l.text.slice(0, 300)}`).join(" || ") || "(none)"}
Visible text (start):
${snap.text}

Clickable elements (id | role | label | flags):
${lines.join("\n")}`;
      let act;
      try {
        act = await askJson({ what: "Scram explorer", system: EXPLORE_SYSTEM, userContent, maxTokens: 1200 });
      } catch (e) {
        await ctx.log(`Explorer step failed (${e.message}) — trying again.`);
        continue;
      }
      const view = String(act.view || snap.title || "screen").slice(0, 60);
      if (!state.views.includes(view)) state.views.push(view);
      const target = snap.elements.find((e) => e.id === act.id);
      let did = String(act.action || "");
      if (act.action === "done") {
        state.notes.push({ i, view, action: "done", observation: String(act.observation || "") });
        await ctx.log(`Explorer: done — ${act.observation || act.why || ""}`);
        break;
      } else if (act.action === "click" && target && !blockedWhy(target)) {
        did = `click “${target.label}”`;
        await realClick(tabId, { id: target.id, label: target.label }).catch(() => dom(tabId, "click", { id: target.id, label: target.label }));
      } else if (act.action === "click") {
        did = `refused: ${target ? `“${target.label}” is blocked (${blockedWhy(target)})` : "unknown element"}`;
      } else if (act.action === "back") {
        const back = await dom(tabId, "backTarget").catch(() => null);
        if (back) await realClick(tabId, { id: back.id, label: back.label }).catch(() => {});
        did = back ? `click Back (“${back.text || back.label}”)` : "back: no Back control here";
      } else if (act.action === "escape") {
        await dom(tabId, "pressKey", "Escape").catch(() => {});
        did = "press Escape";
      } else {
        did = `unknown action “${act.action}”`;
      }
      state.notes.push({ i, view, action: did, observation: String(act.observation || "").slice(0, 400) });
      await ctx.log(`${i}. [${view}] ${did}${act.why ? ` — ${act.why}` : ""}`);
      await sleep(1600);
      const t2 = await chrome.tabs.get(tabId);
      if (t2.status === "loading") await waitForLoad(tabId);
    }

    // 3. Write the guide, save it, and leave the editor on the page view.
    await ctx.log("Writing up what it found…");
    const notes = state.notes.map((n) => `${n.i}. [${n.view}] ${n.action}\n   ${n.observation}`).join("\n");
    const { text } = await ask({ system: GUIDE_SYSTEM, userContent: `Views seen: ${state.views.join(", ")}\n\nExploration notes (in order):\n${notes}`, maxTokens: 3000 });
    state.guide = text.trim();
    await store.set("scramKnowledge", { text: state.guide, updatedAt: new Date().toISOString(), views: state.views, actions: state.notes.length });
    await pilot.showEditorHome(ctx, b.tabId).catch(() => {});
    state.status = "done";
    await ctx.log(`Saved a Scram navigation guide (${state.views.length} views, ${state.notes.length} actions). Autopilot's UI agent will use it from now on.`);
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
