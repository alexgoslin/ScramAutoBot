# Screen Spec → Phased Build Handoff Splitter (for Scram)

## Purpose

The Screen Spec Extractor (`site-screen-spec-extractor.md`) produces one large, complete `screen-spec.md`. Handing that whole file to Scram's build agent in a single prompt has a predictable failure mode: the agent tries to hold the entire app in its head at once, context degrades as the build goes on, earlier requirements get silently dropped or half-implemented, testing gets deferred to "later" and then rushed or skipped, and by the time something's wrong it's buried under several more features built on top of it.

This document's job is to take a finished `screen-spec.md` (all 13 sections, per the extractor's template) and split it into a **sequence of small, individually-scoped step files**, handed to Scram's agent **one at a time**. Each file is a complete, self-contained work order: it re-states all the context the agent needs (not just what changed since last time — assume the agent's memory of earlier steps is unreliable and rebuild the picture fresh every time), specifies exactly one scoped chunk of work, and ends with a hard testing gate. The agent may not receive the next step file until it has fully built and rigorously tested everything the current one asked for — nothing hardcoded, every control genuinely interactable, every use case and edge case checked — and has explicitly reported that back.

This is a **splitting procedure**, not a build procedure: you are not building the app here, you're deciding how to cut the spec into an ordered stack of digestible, verifiable work orders, and writing each one out in full.

---

## Step 1 — Decide the step boundaries (build order)

Before writing any step files, plan the sequence. Two rules govern this:

1. **Step 0 is always Setup, and only Setup.** Every other step depends on it. It establishes the bedrock everything else gets built on: project scaffold, chosen stack, the global design system/theme, the theorized backend's data model and behavior (Section 9 of the spec) implemented as a real, working layer, routing, the app shell (Section 2), and the testing discipline itself. No screen-specific content, no individual features — just the systems every later step will build against. Get this step wrong or leave it vague, and every subsequent step inherits the ambiguity.

2. **After Setup, order steps by dependency, not by convenience.** Work out, from Section 9 (Theorized Backend Architecture) and Section 10 (Feature Workflow Library) of the spec, which features are load-bearing for others: auth before anything gated by it; the core data entities (e.g. "message," "channel," "user") before screens that just display/filter/paginate them; a shared component (Section 4) before the first screen that uses it, if that screen is also the first place it's fully specified. A rough default ordering that works for most app-shaped sites:
   - Step 0: Setup (bedrock — see above)
   - Step 1: Auth / identity flow, if the app has one (login, session, logged-out vs. logged-in states) — almost everything else depends on knowing who's "logged in"
   - Step 2: The primary app shell's static structure — nav, primary layout regions — wired to real (even if minimal) data, but without the complex interactive workflows inside it yet
   - Step 3+: One step per screen or tightly-related screen cluster, in roughly the order a new user would encounter them, each step adding that screen's components and workflows on top of the now-stable shell
   - Later steps: secondary/modal screens, settings, and anything explicitly lower-priority
   - Final step: a dedicated cross-feature regression step (see Step 6 below) — not a place to add new features, purely verification across everything built so far

Keep each step small enough that the agent can plausibly hold it entirely in mind and test it exhaustively in one focused pass. As a rule of thumb: if a step's checklist (Step 4 below) would run past roughly 8–10 testable items, split it into two steps rather than one. A screen with a lot of workflow complexity (e.g. a chat view with send/edit/delete/react/upload/reply-threading) deserves its own multi-step arc (e.g. "3a: message list + send," "3b: edit/delete/react," "3c: attachments") rather than being crammed into one file.

Write down your planned sequence before drafting files — this becomes the manifest in Step 5.

## Step 2 — Assemble the reusable context block

This is the single most important piece of this whole exercise, because it's what compensates for an agent's tendency to lose the thread as a build gets longer. Build one **Context Block** — condensed but complete — and paste it, in full, into **every single step file**, Setup included. Never assume the agent remembers it from a previous file; never replace it with "see step 0" or "as established earlier." Every file must stand alone as if it were the first thing the agent has ever seen, plus a running log of what's already built.

The Context Block draws from the spec and must contain, every time:

- **Project identity**: what site is being cloned, one line on what it is/does, the source URL(s) (Meta section of the spec).
- **Tech/architecture decisions**: whatever was decided in Setup (framework, state management approach, how the theorized backend from Section 9 is being realized — real API, mock server, local-only state layer, etc.) — stated as settled fact, not re-debated, in every later step.
- **Condensed design tokens**: the core palette, type scale, and spacing unit from Section 3 — condensed to the handful of values used constantly, not the full table every time (link back to Setup's fuller output for the rest).
- **Condensed global data model**: the entities and relationships from Section 9's theorized data model, stated plainly (e.g. "User → Server → Channel → Message, Message belongs to a Channel and a User, has many Reactions").
- **Navigation map**: the IA from Section 6, so the agent always knows where the piece it's building fits in the whole.
- **The standing testing mandate**: restate Section 13's core rules in full every time — no hardcoding, every control fully interactable, test as you build, every use case and edge case, nothing marked done on a single successful click. Do not abbreviate this to "see the testing rules" — write it out. This is the rule most likely to erode under context pressure, so it gets repeated in full every single time, not summarized down.
- **Progress ledger**: a short list of every step completed so far and what each delivered in one line (e.g. "Step 0: scaffold, theme, data layer, routing — done. Step 1: auth flow (login/logout/session persistence) — done."). This lets the agent orient itself instantly without needing to remember the conversation.

Keep this block tight and information-dense — condensed doesn't mean vague. It should be a page, not ten, but nothing load-bearing gets cut to save space.

## Step 3 — Write Step 0 (Setup) in full

Setup is different in kind from every step after it, so give it its own template (below). It must deliver, as working, verified code — not placeholders for later:

- Project scaffold with the chosen stack, running and viewable.
- The design system/theme implemented as real, reusable tokens (not values typed inline per-component) — colors, type, spacing, radii — from Section 3.
- The theorized backend from Section 9 implemented as an actual working layer the rest of the app will call into: real data model, real create/read/update/delete behavior for the core entities, and — if the original had one — a real-time propagation mechanism (even a simple in-memory pub/sub is fine at this stage; it just has to genuinely work, not be stubbed to "TODO"). This is the single highest-leverage part of the whole build: every later step's "nothing hardcoded" requirement is only possible if this layer is real from the start.
- Routing scaffold matching Section 6.
- The app shell's static structural layout from Section 2 (regions present and correctly sized/positioned), without yet wiring in every screen's content.
- A basic auth/session scaffold if the app has one, even if the actual login flow is built as its own step next — at minimum, the concept of a "current user" needs to exist in the data layer from the start, since nearly everything else will reference it.

Setup's own testing gate (below) is about proving the *foundation* works, independent of any specific feature: the data layer can genuinely create/read/update/delete a record and have that persist and be re-readable; the theme tokens are actually applied, not hardcoded per-component; routing actually navigates; the shell renders correctly at all three breakpoints from Section 2.

## Step 4 — Write each subsequent step file from the template

For every step after Setup, use the generic Step Template (below), filling it from the relevant parts of the spec:

- **Scope**: pull the *exact, full* relevant entries from Section 5 (Per-Screen Detail), Section 4 (component states needed), and Section 10 (workflow write-ups) for whatever this step covers. Paste them in full — this is the one part of the file that should be verbatim spec content, not a summary, since it's the actual specification of what "correct" looks like.
- **Explicitly out of scope**: name anything adjacent that the agent might be tempted to build ahead of schedule (a related screen, a workflow that belongs to a later step) and say plainly not to build it yet — only a clearly-labeled placeholder/disabled state if the current screen's layout requires *something* to occupy that space (e.g. a nav link to a not-yet-built screen can exist and be visibly disabled/inert, but shouldn't fake-navigate to a fake version of that screen).
- **Testing checklist for this step only**: derived from Section 13's mandate but scoped down to exactly what this step built — see Step 4's template section below for the shape.
- **Completion definition**: an explicit, checkable list of what must be true for this step to count as done.
- **The gate instruction**: told to the agent, every time, in the same words — it must not request or assume the next step's content until it has verified every item on this step's checklist against its own running build (not against its own assumptions about the code), and must report back explicitly confirming completion, including a plain statement that nothing in this step's scope is hardcoded and that every control was individually tested. Only after that confirmation does it receive the next file.

## Step 5 — Assemble the manifest

Write a short `step-manifest.md` listing every step file in build order with a one-line description of what each delivers (see template below). This is for the human/orchestrator running the handoff, so they know the full plan at a glance — it is **not** given to Scram's agent all at once; the agent only ever sees the step file currently in play, plus the Context Block's progress ledger telling it what's already behind it. Keeping the manifest separate from what the agent sees keeps the agent's attention on the one step in front of it rather than the whole remaining mountain of work.

## Step 6 — Reserve a final regression step

After every planned feature step, add one last step file: **Final Regression Pass**. Its scope is not new features — it's Section 13's full mandate applied across the *entire* spec at once (every row of Section 1, every component of Section 4, every workflow of Section 10), specifically hunting for cross-feature issues that only surface once everything coexists: a later feature quietly breaking an earlier one, two features disagreeing about shared state, a workflow that passed alone but fails once other features are also present. Same gate rule applies: the agent reports back explicitly before the handoff is considered finished.

---

## Step File Templates (fill these in exactly)

### `step-manifest.md`

```markdown
# Build Sequence: {Site Name} Clone

Total steps: {N}

| Step | File | Delivers | Depends on |
|---|---|---|---|
| 0 | step-00-setup.md | Scaffold, theme, working data/backend layer, routing, static shell | — |
| 1 | step-01-{name}.md | {one-line} | Step 0 |
| 2 | step-02-{name}.md | {one-line} | Step 0, 1 |
| … | … | … | … |
| N | step-{N}-final-regression.md | Full-spec regression pass, no new features | All prior steps |

Delivery rule: give the agent one file at a time, in order. Do not release step {n+1} until the agent has explicitly confirmed step {n}'s completion checklist, including confirming nothing is hardcoded and every control was individually tested.
```

### `step-00-setup.md`

```markdown
# Step 0 of {N}: Setup — Bedrock for {Site Name} Clone

## Context Block (read this in full even though it's Step 0 — this is the baseline every later step will repeat)
- Project: cloning {site name} ({one-line description}). Source: {URL(s)}.
- Stack: {chosen stack and why, in one or two lines}.
- This step establishes everything below — there is no prior step to reference.

## Your scope for this step ONLY
Build, as real working code — not placeholders:
1. Project scaffold, runnable, using {stack}.
2. Design tokens from the spec's Section 3, implemented as real reusable theme values (not hardcoded per component): {paste condensed color/type/spacing/shape values here}.
3. A real, working data layer implementing the theorized backend from the spec's Section 9: entities = {list}, relationships = {list}, full create/read/update/delete behavior for each, and {a real-time propagation mechanism / none — per spec}.
4. Routing scaffold matching the spec's Section 6 nav structure: {paste}.
5. The app shell's static structural layout from the spec's Section 2: {paste wrapper regions, sizes, stacking}. Render it correctly at 1440px / 768px / 375px. Screen-specific content inside it comes in later steps — for now the regions just need to exist, be correctly sized/positioned, and be empty or minimally placeholder.
6. A "current user" concept in the data layer, even if the actual login UI is a later step.

## Explicitly out of scope for this step
Do not build any individual screen's content, any workflow from Section 10, or the login/auth UI itself yet. If the shell's nav needs to reference screens that don't exist yet, render those nav items visibly but inert/disabled — do not fake-build the screens behind them.

## Testing checklist — complete ALL of these before reporting done
- [ ] App scaffold runs with no errors.
- [ ] Every design token is defined once and referenced, not hardcoded inline anywhere — spot-check by searching for raw hex/px values outside the theme definition.
- [ ] The data layer can genuinely create a record, read it back, update it, and delete it, for every entity listed above — verified by actually exercising it, not by reading the code and assuming it works.
- [ ] Data persists across a page refresh (or is explicitly and correctly scoped to session-only, if that's what the spec implies) — verified, not assumed.
- [ ] Every route defined actually navigates and renders the correct (even if empty) region.
- [ ] The app shell renders correctly — correct regions, correct relative sizing/stacking — at all three breakpoints.
- [ ] Disabled/inert nav items are genuinely non-functional, not fake-clickable.

## Completion / gate
Do not request the next step file until every box above is checked against your actual running build. When ready, report back explicitly: confirm each checklist item, confirm nothing in this step is hardcoded, and confirm you tested it yourself rather than inferring correctness from the code. Only then ask for Step 1.
```

### `step-{NN}-{name}.md` (generic template — reuse for every step after Setup)

```markdown
# Step {n} of {N}: {Step Title}

## Context Block (repeated in full — do not rely on memory of earlier steps)
- Project: cloning {site name} ({one-line description}). Source: {URL(s)}.
- Stack & architecture: {condensed, as settled in Step 0}.
- Design tokens in use: {condensed core palette/type/spacing}.
- Global data model: {condensed entity/relationship summary}.
- Navigation map: {condensed IA from Section 6}.
- Standing testing mandate (applies to everything you build, every step, no exceptions):
  - Nothing may be hardcoded. Anything that looks like data must come from the real data layer built in Step 0 and change when that data changes.
  - Every workflow you implement must be built end-to-end per its full write-up below — not just its first visible step.
  - Every listed component state must be genuinely reachable through real interaction, not just styled.
  - Test each piece as you build it — do not defer testing to the end of this step, let alone to some later step.
  - Cover the happy path, boundary/edge cases, failure cases, cross-screen consistency, and all three breakpoints for everything in this step.
  - Nothing is "done" on a single successful click.
- Progress so far: {one line per completed step, e.g. "Step 0: scaffold, theme, data layer, routing, static shell — done."}

## Your scope for this step ONLY
{Paste, verbatim, the relevant Section 5 per-screen detail, Section 4 component states, and Section 10 workflow write-ups this step covers. This should be the actual spec content, not a paraphrase.}

## Explicitly out of scope for this step
{Name anything adjacent the agent should not build yet, and what — if anything — should exist as a visible-but-inert placeholder instead.}

## Testing checklist — complete ALL of these before reporting done
{One checklist line per component/workflow in this step's scope, each expanded to its real cases, e.g.:}
- [ ] {Workflow name}: happy path works end-to-end per its Section 10 write-up.
- [ ] {Workflow name}: empty/invalid input handled correctly, not silently ignored.
- [ ] {Workflow name}: rapid repeated triggering does not duplicate or break state.
- [ ] {Workflow name}: failure/error case (per its documented failure modes) shows a real, visible error state.
- [ ] {Workflow name}: result is reflected correctly everywhere else that data appears, not just in the triggering screen.
- [ ] {Component name}: every listed state (default/hover/active/focus/disabled/selected/loading/empty/error, as applicable) reached through genuine interaction.
- [ ] All of the above re-verified at 768px and 375px, not just desktop.
- [ ] No hardcoded values anywhere in this step's scope — spot-checked directly, not assumed.

## Completion / gate
Do not request the next step file until every box above is checked against your actual running build. When ready, report back explicitly: confirm each checklist item, confirm nothing in this step's scope is hardcoded, and confirm you tested it yourself rather than inferring correctness from the code. Only then ask for the next step.
```

### `step-{N}-final-regression.md`

```markdown
# Step {N} of {N}: Final Regression Pass — {Site Name} Clone

## Context Block (repeated in full)
{Same Context Block shape as above, with the complete progress ledger — every step, one line each.}

## Your scope for this step
No new features. Go through the entire spec — every row of Section 1 (Screen Inventory), every component of Section 4, every workflow of Section 10 — and re-verify each one against the now-complete app, specifically looking for:
- A later step's feature that broke an earlier one.
- Two features that disagree about shared state (the same data shown or behaving differently in two places).
- A workflow that passed in isolation during its own step but fails now that other features are also present (e.g. a race condition, a shared-state conflict, a performance issue under more data).
- Any remaining hardcoded value anywhere in the app, however small.
- Any component state, anywhere, that isn't genuinely reachable.

## Testing checklist
- [ ] Every screen in Section 1 re-checked end-to-end.
- [ ] Every component state in Section 4 re-verified reachable.
- [ ] Every workflow in Section 10 re-run, including its edge and failure cases, with other features now also present.
- [ ] Cross-feature consistency checked explicitly: pick at least one piece of shared data and confirm it's correct everywhere it appears.
- [ ] Full app re-checked at all three breakpoints.
- [ ] A final search for hardcoded values across the whole codebase, not just this step's files.

## Completion / gate
Report back explicitly confirming every item above, and confirming the app as a whole — not just each step in isolation — has zero hardcoded values and every control genuinely works. This is the last gate before the clone is considered finished.
```

---

## Quality bar before you consider the split done

- Step 0 contains no screen-specific content and is entirely about the bedrock (scaffold, theme, real data layer, routing, static shell) — every later step depends on it and none of it gets re-litigated later.
- Every step file's Context Block is complete and self-contained — a reader with zero memory of any other file could still understand the project, the architecture, the design system, the data model, and the testing standard from that file alone.
- No step file references "as established earlier" or "see step X" in place of actually restating the needed context.
- Every step's scope is small enough to be fully tested in one focused pass (roughly 8–10 checklist items or fewer); anything bigger has been split further.
- Every step file's testing checklist is specific to that step's actual scope, not a generic copy-paste, and always ends with an explicit no-hardcoding check.
- Every step file ends with the same gate instruction: full local verification and an explicit completion report before the next file is released — never build-ahead, never self-serve the next step's content.
- A dedicated Final Regression step exists after all feature steps and adds no new features of its own.
- The manifest lists the full sequence for the human/orchestrator, but no single step file exposes the content of steps beyond the one currently in play.
