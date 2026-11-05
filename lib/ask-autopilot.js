// Ask Autopilot (CONTROL_CENTER_ASK_AUTOPILOT.md): the RoboBuild website's chat about a run.
// Every message gets an answer, written by its own task alongside the build — it never pauses or
// waits for the build loop. The answerer sees everything: what RoboBuild and Scram are, the run's
// state, every document so far, the Q&A, lessons, costs, the log, and the run's recent errors
// with the raw data that failed. A message that also tells Autopilot to do something is passed
// to the build loop like a chat message ("steer").

import * as store from "./storage.js";
import { ask, loadScramGuide } from "./jobs.js";
import { extractJson, balancedObjects } from "./claude.js";
import { totalCost, formatCost } from "./pricing.js";
import { dom } from "./dom.js";
import { getRunErrors } from "./run-errors.js";
import * as autopilot from "./autopilot.js";
import { trimState, flushNow as reportStateNow } from "./bridge-reporter.js";
import { getBridge, updateBridge, post, enqueueOutbox } from "./bridge.js";
import { applyActions, planOf } from "./steering.js";

const PENDING = "pendingAsks"; // asks being answered: survive a service-worker restart
const MAX_DOCS = 160000; // characters of documents in the prompt (trimmed after the log)
const MAX_DOC = 25000;
const MAX_LOG = 60000;

const ABOUT = `RoboBuild (formerly ScramAutoBuild) is a Chrome extension that clones a website — or a whole category of apps — into a working app built in Scram, a no-code app builder with its own AI ("Scram's bot"). It runs in the user's own Chrome, with their Anthropic API key, and is steered from the RoboBuild website (the Control Center), where the user starts runs, answers questions and reads everything it produced.

How a SITE run works (phases): explore → qa → handoff → scram-setup → build → finished.
- explore: a navigator crawls the site in RoboBuild's own browser window, screen by screen, assessing and clicking every button worth building, and writes a screen spec (with a button manifest) for each screen. It first decides the scope (core features vs. what to skip). If it isn't logged in to the site it pauses and asks the user to log in.
- qa: questions for the user — design questions first (vibe d1, how bold d2, must-haves d3), then build questions (q1…), each with a recommended option. Unanswered ones get the recommended answer.
- handoff: a design concept (VIBE / CONCEPT) is written from the answers, then the build is planned as numbered step files (a manifest + steps, each with objective and testing checklist), plus a research briefing for the user.
- scram-setup: RoboBuild opens Scram in its window, creates a new project, and makes sure the AI chat and Run mode are ready.
- build: steps are given to Scram's bot one at a time. Each step takes ROUNDS: RoboBuild waits for the bot to go quiet, then the SUPERVISOR (a Claude model acting as the operator) reads what the bot did — the new chat lines, a screenshot of the Scram tab and the running app — and decides one action as JSON: reply to the bot, approve its plan, answer its question, test in Run mode, ask for a fix, start a new chat, do_it_myself (when the bot can't do something that is really an action in Scram's editor UI — a drag, a toggle, a setting — RoboBuild's own UI agent does it with real clicks/typing, then tells the bot), mark the step complete, or need_human (pause for the user). The supervisor's reply MUST be valid JSON; if it isn't, RoboBuild asks once more, and if that also fails the run stops with "Scram supervisor reply wasn't valid JSON." (Resume retries the same step and round). Lessons ("Learned: …") are saved when the bot says it can't do something, so it's never asked again.
- finished: optionally a final review of the running app, then done.
A CATEGORY run first proposes sites (cat-propose), the user confirms each (cat-confirm), logs in to each and RoboBuild crawls it (cat-explore), summarises each into a digest (cat-digest), asks the questions (qa), then a TRIBUNAL (organiser → FOR / IMPARTIAL / AGAINST advocates → judge's blueprint → critic's review → final blueprint) decides the one app to build; then handoff and build as above.
A BUILD-ONLY run ("build again") starts at scram-setup from existing step files.
Statuses: running, waiting (for the user), paused (by the user, or needs the user: login, out of Scram credits, etc.), stopped, error, done.
Pause/Resume/Stop/Clear and all questions are done on the RoboBuild website. Messages the user sends are read by the supervisor at its next round.`;

const SYSTEM = `You are Autopilot, RoboBuild's assistant, answering the user's questions about one run in the "Ask Autopilot" chat on the RoboBuild website. You are NOT controlling the build — the build keeps running separately while you answer.

${ABOUT}

How to answer:
- Answer the user's question directly and specifically from the data you're given about this run: its state, documents, Q&A, lessons, costs, the activity log, and especially the RECENT ERRORS record, which holds the raw data that failed (e.g. the supervisor's actual reply and the JSON parse error). Quote the actual error text or reply text when it's relevant, in a code block if it's long.
- Explain errors in plain words: what failed, why (from the raw data), what RoboBuild did next, and what the user can do.
- If something isn't in the data, say so plainly — never invent facts, steps or reasons.
- Be concise and use plain language and Markdown. Never reveal API keys, tokens or secrets.
- You can also CHANGE the build, live. Decide whether the message is a question, an instruction, or both. If it tells Autopilot to do something, return the matching actions — they're applied immediately (running, paused, waiting, in error or stopped) and you'll be told what actually happened, so in "answer" say plainly what you're doing (e.g. "Done — skipped step 14 (sidebar star drag), and from now on every page uses blue buttons."). Use the PLAN's step numbers and the STANDING INSTRUCTIONS' ids exactly as given.
- Actions (JSON objects in "actions"):
  {"type":"instruct","text":"…","standing":true|false}  — an instruction for Scram's bot / the supervisor. standing:true = keep it for every later round and step ("use blue buttons everywhere"); false = the current step only.
  {"type":"send_to_scram_now","text":"…"}  — typed into Scram's AI chat right away (once its current reply finishes). For "stop doing X", "change Y on this page now".
  {"type":"skip_step","step":N}  {"type":"jump_to_step","step":N}  {"type":"redo_step","step":N,"reason":"…"}
  {"type":"add_step","after":N,"title":"…","instructions":"…"}  (after: 0 = at the start)  {"type":"edit_step","step":N,"instructions":"…"}  (future steps)
  {"type":"update_spec","section":"…","text":"…"}  — amend the design/spec (colours, a new page, a removed feature); later steps follow it.
  {"type":"pause"}  {"type":"resume"}  {"type":"stop"}  — like the site's buttons. "Carry on" on a paused, errored or stopped run = resume.
  {"type":"answer_questions","answers":{"<question id>":"<answer text>"}}  — when the run is waiting for its questions.
  {"type":"remove_instruction","id":"<standing instruction id>"}
  {"type":"build_again"}  — a FINISHED run (or one no longer loaded): start a new build in Scram from its existing steps.
- Only act when the user clearly asks for it. A pure question gets "actions": []. On a paused run, don't add "resume" unless the user asked to carry on. For an ambiguous or destructive request ("delete everything and start over"), ask a clarifying question in "answer" and take NO action.

Reply with ONLY this JSON (no code fence): {"answer": "<Markdown answer>", "actions": [ … ]}`;

// ------------------------------------------------------------------ context

const clip = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}\n… [cut: ${(s.length - n).toLocaleString()} more characters]` : s;
};
const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

async function documentsFor(a) {
  const site = a.siteUrl;
  const got = await chrome.storage.local.get(["specFiles", "handoffFiles", "designBriefs", "briefings", "categoryDocs"]);
  const docs = [];
  const design = (got.designBriefs || {})[site];
  if (design?.content) docs.push(["Design concept", design.content]);
  const brief = (got.briefings || []).filter((b) => b.siteUrl === site && b.content).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0];
  if (brief) docs.push(["Research briefing", brief.content]);
  const hand = (got.handoffFiles || []).filter((f) => f.siteUrl === site);
  const manifest = hand.find((f) => f.fileType === "manifest");
  if (manifest?.content) docs.push([manifest.title || "Step manifest", manifest.content]);
  for (const f of hand.filter((f) => f.fileType === "step").sort((x, y) => x.stepNumber - y.stepNumber)) docs.push([`Step file ${f.stepNumber}: ${f.title}`, f.content]);
  for (const d of [...((got.categoryDocs || {})[site] || [])].sort((x, y) => /blueprint/i.test(y.title) - /blueprint/i.test(x.title))) docs.push([`Category document: ${d.title}`, d.content]);
  for (const s of (got.specFiles || []).filter((s) => s.siteUrl === site || s.categoryKey === site)) docs.push([`Screen spec: ${s.pageTitle} (${s.pageUrl})`, s.content]);
  let left = MAX_DOCS;
  const out = [];
  const skipped = [];
  for (const [title, content] of docs) {
    if (left < 2000) {
      skipped.push(title);
      continue;
    }
    const text = clip(content, Math.min(MAX_DOC, left));
    left -= text.length;
    out.push(`<document title="${title.replace(/"/g, "'")}">\n${text}\n</document>`);
  }
  return `${out.join("\n\n") || "(no documents yet)"}${skipped.length ? `\n\n(Not included for length: ${skipped.join("; ")})` : ""}`;
}

function logText(a) {
  const lines = (a.log || []).map((l) => `${time(l.t)} ${l.msg}`);
  let text = lines.join("\n");
  if (text.length > MAX_LOG) {
    // Too long: the latest lines in full, plus every warning/error from the earlier ones.
    let tail = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0 && size < MAX_LOG * 0.8; i--) {
      tail.unshift(lines[i]);
      size += lines[i].length;
    }
    const earlier = lines.slice(0, lines.length - tail.length);
    const important = earlier.filter((l) => /⚠|Error|error|Paused|failed|wasn't|couldn't/i.test(l));
    text = `(${earlier.length} earlier lines summarised — warnings and errors among them:)\n${important.join("\n") || "(none)"}\n\n(latest ${tail.length} lines in full:)\n${tail.join("\n")}`;
  }
  return `${text || "(empty)"}\n(RoboBuild keeps the last 300 log lines of a run.)`;
}

async function whatItSees(a) {
  const tabId = a.build?.tabId;
  if (tabId == null) return "No Scram tab is open for this run right now.";
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return "The run's Scram tab is closed.";
  const toggle = await withTimeout(dom(tabId, "modeToggle").catch(() => null), 4000);
  const chat = await withTimeout(dom(tabId, "chatText").catch(() => ""), 4000);
  return [
    `Scram tab: ${tab.url}`,
    toggle ? `Editor mode: ${toggle.active === true ? "Run" : "Edit"}` : "",
    chat ? `Latest part of Scram's AI chat (up to 2,000 characters):\n${String(chat).slice(-2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Which run a question is about: the one loaded now, an earlier one kept in the archive, or one
// this extension no longer has (e.g. after a reinstall) — never refused.
export async function lookupRun(run_id) {
  const [a, b] = await Promise.all([store.get("autopilot", null), getBridge()]);
  const idOf = (startedAt) => b.runIds?.[String(startedAt)];
  if (a && (run_id == null || idOf(a.startedAt) === run_id || (idOf(a.startedAt) == null && b.pendingStartRunId === run_id)))
    return { current: true, state: a, errors: await getRunErrors(a.startedAt) };
  const startedAt = Object.entries(b.runIds || {}).find(([, id]) => id === run_id)?.[0];
  const old = startedAt ? await autopilot.archivedRun(startedAt) : null;
  if (old) return { current: false, state: old.state, errors: old.errors || [] };
  // Not mapped and nothing archived: if the loaded run isn't linked to any run id yet, it's this one.
  if (a && idOf(a.startedAt) == null) return { current: true, state: a, errors: await getRunErrors(a.startedAt) };
  return { current: false, state: null, errors: [], unknown: true };
}

export async function buildContext(text, history = [], run = null) {
  run ||= await lookupRun(null);
  const a = run.state;
  const [lessons, usage] = await Promise.all([store.getLessons().catch(() => []), store.get("usage", null)]);
  const parts = [];
  if (!a) {
    parts.push(
      run.unknown
        ? "This run isn't in RoboBuild any more (the extension was reinstalled, or the run was cleared long ago), so its detailed state, log and errors aren't available. Answer from the chat history below and say that you no longer have this run's detailed log. Don't take actions for it except build_again if the user asks."
        : "There is no run in the extension right now (it may have been cleared)."
    );
  } else {
    if (!run.current) parts.push(`NOTE: this is an EARLIER run (no longer the one loaded in RoboBuild): it can't be changed, only answered about — or built again (build_again).`);
    const st = trimState(a);
    const b = a.build || {};
    parts.push(
      `RUN: ${a.mode === "category" ? `category clone "${a.category?.name}" (${a.siteUrl})` : a.buildOnly ? `build-only run for ${a.siteUrl}` : `site clone of ${a.siteUrl}`}; started from ${a.startUrl}; started ${new Date(a.startedAt).toLocaleString()}.
STATUS: ${a.status}; PHASE: ${a.phase}${b.totalSteps ? `; STEP ${Math.min((b.step || 0) + 1, b.totalSteps)} of ${b.totalSteps}, ROUND ${b.rounds || 0} of this step` : ""}${a.pauseReason ? `; pause/error reason: ${a.pauseReason}` : ""}.
Current status line: ${a.message || "(none)"}
User's instructions for the run: ${a.instructions || "(none)"}
Messages the user sent to steer the run: ${(a.notes || []).map((n) => `${n.text}${n.seen ? "" : " (not read by the supervisor yet)"}`).join(" | ") || "(none)"}
Recent build actions this step: ${(b.history || []).slice(-15).join(" | ") || "(none)"}`,
      `RUN STATE (JSON):\n${clip(JSON.stringify(st, null, 1), 30000)}`
    );
    const cost = usage ? Math.max(0, totalCost(usage) - totalCost(a.usageAtStart || usage)) : 0;
    parts.push(`COSTS: this run so far ≈ ${formatCost(cost)}; all-time ${formatCost(totalCost(usage))} (${usage?.calls || 0} Claude calls).`);
    const errors = run.errors || [];
    const plan = await planOf(a);
    parts.push(
      `PLAN (step numbers as the user sees them — use these, even if a step file's own heading counts from 0):\n${plan.map((p) => `${p.n}. ${p.title} — ${p.status}`).join("\n") || "(no build steps written yet)"}${a.build?.returnTo != null ? `\n(After the current step the build returns to step ${a.build.returnTo + 1}.)` : ""}`,
      `STANDING INSTRUCTIONS (from the chat; ids for remove_instruction):\n${(a.steering || []).map((s) => `- [${s.id}] ${s.text}`).join("\n") || "(none)"}`,
      `SPEC CHANGES made from the chat:\n${(a.specAmendments || []).map((x) => `- [${x.section}] ${x.text}`).join("\n") || "(none)"}`
    );
    parts.push(
      `RECENT ERRORS AND WARNINGS (newest last, verbatim, with the raw data that failed):\n${errors.length ? JSON.stringify(errors.map((e) => ({ ...e, time: new Date(e.t).toLocaleString() })), null, 1) : "(none recorded)"}`
    );
    if (run.current) parts.push(`WHAT ROBOBUILD SEES RIGHT NOW:\n${await whatItSees(a)}`);
    parts.push(`ACTIVITY LOG:\n${logText(a)}`);
    parts.push(`DOCUMENTS GENERATED SO FAR (full text):\n${await documentsFor(a)}`);
  }
  parts.push(`LEARNED ABOUT SCRAM'S BOT (lessons kept across runs):\n${lessons.map((l) => `- ${l.text}`).join("\n") || "(none)"}`);
  const chat = (Array.isArray(history) ? history : []).slice(-20).map((m) => `${m.role === "assistant" ? "Autopilot" : "User"}: ${String(m.text || "").slice(0, 4000)}`);
  parts.push(`ASK AUTOPILOT CHAT SO FAR (oldest first):\n${chat.join("\n\n") || "(this is the first message)"}`);
  parts.push(`THE USER'S NEW MESSAGE:\n${text}`);
  return parts.join("\n\n=====\n\n");
}

// ------------------------------------------------------------------ answering

function plainError(e) {
  const m = String(e?.message || e);
  if (/No Anthropic API key/i.test(m)) return "Anthropic API key missing — add it in the RoboBuild extension (Settings → Claude & models), then ask again.";
  if (/\b401\b|invalid x-api-key|authentication/i.test(m)) return "The Anthropic API key in the RoboBuild extension was refused — check it in Settings → Claude & models.";
  if (/\b429\b|rate.?limit/i.test(m)) return "Anthropic's API is rate-limiting this key right now — wait a minute and ask again.";
  if (/overloaded|\b529\b|\b5\d\d\b/i.test(m)) return "Anthropic's API is overloaded right now — please ask again in a minute.";
  if (/fetch|network|Failed to/i.test(m)) return "RoboBuild couldn't reach Anthropic's API (network problem) — check the internet connection and ask again.";
  return `Couldn't produce an answer: ${m.slice(0, 300)}`;
}
const transient = (e) => /\b429\b|rate.?limit|overloaded|\b5\d\d\b|fetch|network|timeout|Failed to/i.test(String(e?.message || e));

async function sendChat(from, body) {
  try {
    const res = await post("bridge_report_chat", body, from);
    if (res.ok === false && res.error === "server_error") await enqueueOutbox("bridge_report_chat", body);
    return res;
  } catch {
    // Kept in the outbox (stored, so it survives a restart) and retried.
    if ((await getBridge()).baseUrl === from.baseUrl) await enqueueOutbox("bridge_report_chat", body);
    return { ok: false, error: "transport" };
  }
}

let pendingChain = Promise.resolve();
function setPending(id, value) {
  // One write at a time: several questions can be in flight.
  const next = pendingChain.then(async () => {
    const { [PENDING]: all = {} } = await chrome.storage.local.get(PENDING);
    if (value) all[id] = value;
    else delete all[id];
    await chrome.storage.local.set({ [PENDING]: all });
  });
  pendingChain = next.catch(() => {});
  return next;
}

// The answerer's reply → { answer, actions }. The reply should be {"answer","actions"}, but models
// sometimes write the answer as prose and then a JSON object (even an empty one): then the prose
// is the answer. JSON objects and ```json blocks are always removed from what the user sees;
// actions are applied wherever they were.
const parsesAsJson = (t) => {
  try {
    const j = extractJson(t);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
};
export function splitAnswer(raw) {
  const text = String(raw || "").trim();
  const j = parsesAsJson(text);
  let prose = text.replace(/```[a-z]*\s*([\s\S]*?)```/gi, (m, inner) => (parsesAsJson(inner) ? "" : m));
  for (const o of balancedObjects(prose).reverse()) if (parsesAsJson(o.text)) prose = prose.slice(0, o.start) + prose.slice(o.end);
  prose = prose.replace(/\n{3,}/g, "\n\n").trim();
  let answer = typeof j?.answer === "string" && j.answer.trim() ? j.answer.trim() : prose;
  const actions = Array.isArray(j?.actions) ? [...j.actions] : [];
  // Older reply shape: {"steer": "…"} = one instruction for the current step.
  if (typeof j?.steer === "string" && j.steer.trim()) actions.push({ type: "instruct", text: j.steer.trim(), standing: false });
  if (/^\s*[{[]\s*"/.test(answer) || /```json/i.test(answer)) answer = ""; // never show raw JSON
  return { answer, actions };
}

// Each question is answered once: a command delivered twice (or re-queued after a restart while
// its answer was already sent) is ignored. Ids are remembered per environment (last 300).
const ANSWERED = "answeredAsks";
const inFlight = new Set();
const askKey = (from, id) => `${from?.baseUrl || ""}#${id}`;
async function wasAnswered(from, id) {
  const { [ANSWERED]: list = [] } = await chrome.storage.local.get(ANSWERED);
  return list.includes(askKey(from, id));
}
async function markAnswered(from, id) {
  const { [ANSWERED]: list = [] } = await chrome.storage.local.get(ANSWERED);
  if (!list.includes(askKey(from, id))) await chrome.storage.local.set({ [ANSWERED]: [...list, askKey(from, id)].slice(-300) });
}

async function answerOne(job, from) {
  if (await wasAnswered(from, job.message_id)) return; // already answered: never twice
  const { message_id, run_id, text, history } = job;
  const base = { run_id, message_id };
  await setPending(message_id, { ...job, baseUrl: from.baseUrl, at: job.at || Date.now() });
  await updateBridge((x) => ({ ...x, lastChatAt: Date.now() })).catch(() => {});
  try {
    sendChat(from, { ...base, kind: "progress", text: "Looking at this run's state, log, errors and documents…" }).catch(() => {});
    const settings = await store.getSettings();
    const run = await lookupRun(run_id);
    const userContent = await buildContext(text, history, run);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await ask({ system: SYSTEM, userContent, maxTokens: 4000, model: settings.model });
        break;
      } catch (e) {
        if (attempt >= 2 || !transient(e)) throw e; // at most two retries
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    // Never fail to answer because the reply isn't JSON, and never show JSON to the user.
    let { answer, actions } = splitAnswer(res.text);
    // Apply the actions now, then say exactly what changed (and what couldn't be done).
    const results = actions.length ? await applyActions(actions, run) : [];
    const applied = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (applied.length) answer += `\n\n**Done:** ${applied.map((r) => r.summary).join("; ")}.`;
    if (failed.length) answer += `\n\n**Couldn't do:** ${failed.map((r) => `${r.type.replace(/_/g, " ")} — ${r.summary}`).join("; ")}.`;
    if (run.current) for (const r of applied) await autopilot.appendLog(`🧭 Steering from chat: ${r.summary}`, "steer").catch(() => {});
    await markAnswered(from, message_id);
    await sendChat(from, {
      ...base,
      kind: "answer",
      text: answer || "(I couldn't think of an answer — please rephrase.)",
      steered: applied.length > 0,
      ...(applied.length ? { actions_applied: applied.map((r) => ({ type: r.type, summary: r.summary })) } : {}),
    });
    if (run.current) await autopilot.appendLog("🤖 Answered your question in Ask Autopilot.").catch(() => {});
    // The plan, step counts and instructions changed: tell the site at once.
    if (applied.length) await reportStateNow().catch(() => {});
  } catch (e) {
    await markAnswered(from, message_id);
    await sendChat(from, { ...base, kind: "error", text: plainError(e), steered: false });
    if ((await lookupRun(run_id).catch(() => ({}))).current) await autopilot.appendLog(`🤖 Couldn't answer your question in Ask Autopilot: ${plainError(e)}`).catch(() => {});
  } finally {
    await setPending(message_id, null);
  }
}

// One queue per run: several questions are answered one after another, in order, while the
// build carries on.
const queues = new Map();
export function startAsk(job, from) {
  const id = askKey(from, job.message_id);
  if (inFlight.has(id)) return Promise.resolve(); // the same question delivered twice
  inFlight.add(id);
  const key = String(job.run_id ?? "none");
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(() => answerOne(job, from)).catch(() => {}).finally(() => inFlight.delete(id));
  queues.set(key, next);
  next.then(() => queues.get(key) === next && queues.delete(key));
  return next;
}

// After a restart: finish the questions that were being answered (or say they can't be).
export async function resumePending() {
  const { [PENDING]: all = {} } = await chrome.storage.local.get(PENDING);
  const from = await getBridge();
  for (const job of Object.values(all).sort((a, b) => a.message_id - b.message_id)) {
    if (job.baseUrl !== from.baseUrl) {
      await setPending(job.message_id, null); // asked on the other environment: can't answer there now
      continue;
    }
    if (Date.now() - (job.at || 0) > 15 * 60000) {
      await sendChat(from, { run_id: job.run_id, message_id: job.message_id, kind: "error", text: "RoboBuild restarted before it could answer this — please ask again.", steered: false });
      await setPending(job.message_id, null);
    } else startAsk(job, from);
  }
}
