// Research briefing: a plain-English document for the human, written after the research and
// the Q&A, explaining what the extension looked at, what it understood and what it intends to
// build. It is NOT part of the pipeline: nothing else reads it, and a failure here never
// affects the run. Saved under "briefings" and shown on tools/briefing.html.

import * as store from "./storage.js";
import { ask, scramLimitations } from "./jobs.js";

const KEEP = 10;

const BRIEFING_SYSTEM = `You write a briefing document for a human who asked an automation tool to clone a website's core features in Scram (a no-code app builder with its own AI builder). The tool has finished researching the site and the human has answered its questions. Your document explains, in plain friendly English, what the tool did and understood and what it intends to build, so the human can check it understood correctly before the build. It is only for the human to read; the build doesn't use it.

Write Markdown with these sections (## headings), in this order:
## In a nutshell: 3–5 sentences: what the product is, what the clone will be, and the main choices made.
## What I researched: which screens were explored (by name, with the page address), how the tool explored them (opened pages, tried buttons and menus, typed into search boxes, recorded what the site loaded), and what it deliberately didn't touch (destructive or account-changing buttons, out-of-scope areas).
## What I understood the product to be: who it's for, the main things users do, and the main "things" it manages (e.g. posts, users, messages) and how they relate.
## What I'm going to build: one ### subsection per core feature: what it lets a user do, the screens involved, the data behind it, and in a sentence or two how it will work in Scram (pages, database tables, logins). Use only what the research shows.
## What I'm leaving out, and why: the skipped features, with the reason for each.
## Your answers: each question and the answer that will be used, and in a few words what that changes in the build. If there were no questions, say so.
## Where Scram's limits change things: features that will be simplified because Scram can't do them (e.g. refresh instead of live updates), and what the simpler version is. Say "none" if nothing is affected.
## Assumptions and things to double-check: what was guessed or couldn't be seen (behind a login, buttons not clicked), so the human can correct it.
## What happens next: the plan from here: the tool writes small step files (each with an objective and its own test section), creates a Scram project, hands the steps to Scram's AI one at a time, and Scram's AI builds and tests each one in Run mode while the tool supervises. The human can message Autopilot from the side panel at any time.

Rules: be concrete and specific to this site, never generic. No marketing tone. Don't invent features or screens the research doesn't show; if something is unclear, say so under assumptions. Use short paragraphs and bullet lists. Address the reader as "you" and the tool as "I".`;

export async function listBriefings() {
  return store.get("briefings", []);
}

async function saveBriefing(b) {
  const all = (await store.get("briefings", [])).filter((x) => x.id !== b.id);
  all.push(b);
  await store.set("briefings", all.slice(-KEEP));
}

// Collects what the research produced. state is a snapshot of the Autopilot state.
async function researchInput(state) {
  const ex = state.explore || {};
  const sc = state.scope || {};
  const specs = (await store.get("specFiles", [])).filter((s) => s.siteUrl === state.siteUrl);
  const perSpec = Math.max(2500, Math.floor(90000 / Math.max(1, specs.length)));
  const limits = await scramLimitations().catch(() => "");
  const qa = state.qa?.questions?.length
    ? state.qa.questions.map((q) => `- Q: ${q.question}${q.from ? ` (noticed on: ${q.from})` : ""}\n  A: ${state.qa.answers?.[q.id] ?? q.options?.[q.recommended] ?? "(recommended)"}${q.why ? `\n  (what it changes: ${q.why})` : ""}`).join("\n")
    : "(no questions were asked)";
  return [
    `Site: ${state.siteUrl} (started from ${state.startUrl || state.siteUrl})`,
    state.instructions ? `The human's instructions:\n${state.instructions}` : "The human gave no extra instructions.",
    sc.product || sc.core?.length
      ? `Scope decided before crawling:\nProduct: ${sc.product || "?"}\nCore: ${(sc.core || []).map((f) => `${f.name}${f.why ? ` — ${f.why}` : ""}`).join("; ") || "(none)"}\nSkipped: ${(sc.skip || []).map((f) => `${f.name}${f.why ? ` — ${f.why}` : ""}`).join("; ") || "(none)"}`
      : "No scope was decided (the whole site was in scope).",
    `Screens explored (${(ex.pages || []).length}):\n${(ex.pages || []).map((p) => `- ${p.name} (${p.type || "screen"}) — ${p.url}`).join("\n") || "(none)"}`,
    ex.skipped?.length ? `Pages skipped while crawling:\n${ex.skipped.slice(0, 40).map((s) => `- ${typeof s === "string" ? s : `${s.url || ""} ${s.why || s.reason || ""}`}`).join("\n")}` : "",
    ex.unsure?.length ? `Things the crawler wasn't sure how to build:\n${ex.unsure.map((u) => `- [${u.page}] ${u.question}`).join("\n")}` : "",
    `Questions asked and the answers that will be used:\n${qa}`,
    limits ? `Scram's platform limits:\n${limits}` : "",
    `Screen specs written during the research:\n${specs.map((s, i) => `<!-- Spec ${i + 1}: ${s.pageTitle} (${s.pageUrl}) -->\n${s.content.slice(0, perSpec)}`).join("\n\n---\n\n") || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Writes the briefing for this run. Never throws: errors are saved on the briefing instead.
export async function writeBriefing(state, { onDone } = {}) {
  const id = `${state.startedAt}`;
  const base = { id, siteUrl: state.siteUrl, runStartedAt: state.startedAt, createdAt: Date.now() };
  await saveBriefing({ ...base, status: "writing" });
  try {
    const settings = await store.getSettings();
    const { text } = await ask({ system: BRIEFING_SYSTEM, userContent: await researchInput(state), maxTokens: 12000, model: settings.model });
    const title = `# Research briefing: ${new URL(state.siteUrl).host}\n\n_Written ${new Date().toLocaleString()} after the research and your answers. This is only for you to read; the build doesn't use it._\n\n`;
    const done = { ...base, status: "done", content: title + String(text || "").trim(), finishedAt: Date.now() };
    await saveBriefing(done);
    onDone?.(done);
    return done;
  } catch (e) {
    const failed = { ...base, status: "error", error: e.message || String(e), finishedAt: Date.now() };
    await saveBriefing(failed);
    onDone?.(failed);
    return failed;
  }
}
