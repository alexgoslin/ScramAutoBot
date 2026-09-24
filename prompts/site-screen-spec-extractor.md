# Site → Screen Spec Extractor (for Claude in Chrome)

## Purpose

You are cloning the UI **and the underlying system** of a live website (e.g. Discord) so that Scram's vibecoding agent can rebuild it faithfully. Your job is NOT to write the clone yourself — it is to produce a complete, structured **Screen Spec** plus a screenshot set, precise enough that a separate AI agent (Scram) can build a pixel-and-behavior-faithful copy from your output alone, without ever visiting the original site.

"Faithful" means more than pixels. A button that looks right but does nothing, or does the wrong thing when clicked, is not a faithful clone. For every meaningful interactive element you document, you must also reconstruct — as a well-reasoned theory, clearly labeled as such — **what happens when it's used**: what the client does, what it likely sends to a server, what the server likely does with it, and what comes back. You are not just describing a UI; you are reverse-engineering the *system* that UI is a window into.

Treat this as a design/dev audit, not a casual description. Be exhaustive about structure, tokens, states, workflows, and reasoning — vague language ("looks modern", "has a sidebar", "sends the message to the server") is not acceptable; give measurements, hex values, hierarchy, endpoints-if-observable, and mechanism.

This document is both your **procedure** (steps 0–8 below) and the **template** your final output must follow (the "Screen Spec Format" section). Fill in every section; write "not observed" rather than skipping a section silently. Where you are theorizing rather than observing, say so explicitly (e.g. "inferred — not confirmed by network trace") — never present a guess as an observed fact.

---

## Guiding principle: describe the *system*, not just the *screen*

Every non-trivial control on a page is the visible tip of a workflow that usually spans client state, a network boundary, and server-side logic. Before you can tell Scram's agent how to replicate a feature, you need to be able to answer three questions about it:

1. **What does it do, mechanically?** — the literal sequence of events from interaction to settled UI state.
2. **How would the backend plausibly be built to support that?** — the theorized architecture: what shape of API, what data model, what auxiliary systems (queues, sockets, caches, third-party services) it implies.
3. **Why is it built that way, and not some simpler or different way?** — the design/engineering rationale. Software is shaped by constraints (latency, consistency, scale, cost, abuse-prevention, offline behavior, team conventions) as much as by aesthetics. If you can't articulate a plausible "why," you probably haven't understood the feature well enough to replicate it — you've only described its surface.

Answering (1) is mostly observation. Answering (2) and (3) is *informed inference* — you use what's directly observable (network requests, response shapes, timing, DOM changes, error states, URL structure, headers, cookies/localStorage keys, loading skeletons, optimistic vs. pessimistic UI behavior) plus general knowledge of how systems like this are normally built, to construct the most plausible theory. Always mark inferred material as inferred. A good theory that's clearly labeled as a theory is far more useful to Scram's agent than either silence or false confidence.

---

## Step 0 — Autonomous discovery loop ("scope out this site")

When the instruction is open-ended ("scope out discord.com", "go get the whole app") rather than pointed at specific screens, run this loop yourself before falling back to Steps 1–8 for each screen it finds. This is the self-directed version of what `screen_extractor.py --crawl` does mechanically when it has raw network access — you're doing the same thing through your own browsing tools instead.

1. **Start a visited list and a queue.** Seed the queue with the starting URL.
2. **Take the next item off the queue.** If its URL (ignoring #fragments) is already in the visited list, skip it. Otherwise mark it visited and treat it as a new screen: run Steps 2–7 below on it (screenshots, structure, tokens, components, workflows, rationale, detail).
3. **After capturing a screen, look for more to add to the queue:**
   - Every same-site link in the nav, header, footer, and body that you haven't already visited or queued.
   - Every menu, dropdown, tab set, hamburger toggle, or "..." overflow button visible on the page — open each one, capture what it reveals as its own screen (see the note below on triggered vs. navigated screens), then close it before moving on so you don't carry state into the next check.
   - Modals reachable from a visible button (e.g. "Create Server", "Settings") — open, capture, close.
4. **Do not click or queue anything that looks destructive or account-altering**: log out, delete, remove, cancel/unsubscribe, purchase/buy/checkout/pay, deactivate/close account, disconnect, or anything requiring you to submit a real form (posting a message, sending a friend request, submitting payment info). If a control's purpose is ambiguous, err toward not clicking it and note it as unexplored in Section 8 (Open Questions) rather than guessing by clicking. You can — and should — still *theorize* the workflow behind a destructive/unclicked control from static evidence (its label, icon, surrounding copy, any confirmation dialog text visible without confirming, disabled/enabled logic); just label that theory as unverified.
5. **Stay same-site.** Don't follow links to a different domain (external docs, social links, ads) — note that they exist and where they go, but don't crawl them.
6. **Stopping conditions** — stop the loop when any of these hit, whichever comes first:
   - No new same-site links or unexplored menus turn up from the last few screens captured.
   - You've captured a reasonable cap for the task — default to **20 screens** unless the user asked for more/fewer or for "everything."
   - You hit a login wall or a page you don't have credentials for — stop, note it in Open Questions, and ask the user whether to continue with provided credentials rather than guessing or skipping silently.
7. **Menu/dropdown captures are single-viewport, not three-breakpoint.** Resizing the viewport can itself close an open menu, so for an in-page triggered state (as opposed to a navigated page), capture it once at whatever breakpoint you're already testing and say so in the spec rather than resizing through all three.
8. **Merge, don't restart.** Every screen discovered this way gets folded into the *same* running Screen Spec document (Section 1 Screen Inventory grows by one row per screen; Section 3 Design Tokens should be deduplicated/merged across screens rather than repeated verbatim per screen once you have more than a couple — call out only what's *different* between screens after the first; Section 9 Theorized Backend Architecture and Section 11 Design Rationale are also global and should accumulate/merge, not repeat per screen).

If you have the ability to invoke `screen_extractor.py --crawl` directly (e.g. you're operating alongside a shell/tool that can run it) instead of clicking through manually, prefer that for the deterministic parts (screenshots, structure, tokens) and use your own judgment only for what it deliberately leaves as TODO — which, by default, includes all backend theorizing and rationale, since those require judgment a scraper can't automate. Otherwise, run the loop above with your own browsing tools — the output should look the same either way.

## Step 1 — Map the site

If you were instead pointed at specific screens ("clone the pricing page and the settings modal"), skip the autonomous loop above and just enumerate the distinct **screens/states** you were asked for. A "screen" is any materially different layout: a page, a major modal, a collapsed/expanded nav state, an empty state, a loading state, an error state.

For a Discord-style app this typically looks like: landing/marketing page, login, server sidebar + channel list + chat view (the main app shell), a DM view, user settings modal, a create-server modal, right-hand member list panel toggled on/off.

Output of this step: a numbered list of screens you will capture, in the order you'll do them.

## Step 2 — Capture screenshots at multiple breakpoints

For each screen in your list, capture screenshots at three viewport widths: **1440px** (desktop), **768px** (tablet), **375px** (mobile), unless the app is desktop-only (say so and skip mobile/tablet if true). Capture the full scrollable area where relevant, not just the fold.

Also capture close-up crops of any component whose detail matters and won't read at full-page zoom (e.g. an avatar/status-dot combo, a message hover toolbar, an icon-only nav rail).

Name every screenshot systematically: `{screen-name}_{breakpoint}.png`, e.g. `channel-view_1440.png`, `channel-view_375.png`, `settings-modal_1440.png`. This naming becomes your asset manifest in the spec.

## Step 3 — Inspect structure

For the app shell and for each screen, work out the actual DOM/layout structure — not just what it looks like, but how it's composed:

- Read the page's DOM/accessibility tree (or view-source / inspect where available) to identify the top-level wrapper regions: e.g. `<nav>` server rail, `<aside>` channel list, `<main>` message area, `<aside>` member list.
- For each wrapper, note: is it fixed or scrolling independently, its approximate width/height (px or %), whether it's flex or grid, and its stacking relative to siblings (does it overlay, push, or sit side-by-side).
- Note z-index layering for anything that floats above content (modals, tooltips, context menus, toasts).
- Trace nesting depth for the main content area specifically — this is usually where the real complexity is (e.g. message list → message group → message row → avatar + author/timestamp header + body + reaction row).

You don't need raw HTML dumps in the final spec — you need the *structural skeleton* translated into plain, unambiguous language or a small indented outline (see template below). If you can grab a genuinely representative HTML snippet for a tricky component, include it in the appendix, but don't paste entire page source.

## Step 4 — Extract design tokens

Sample enough elements to reconstruct a design system, not just "it's mostly dark grey":

- **Color palette**: background layers (usually 2–4 shades from darkest to lightest in a dark-mode app), primary/brand accent color, text colors (primary/secondary/muted), semantic colors (success/error/warning/online-status/mention-highlight), border/divider colors. Give hex codes where you can read/sample them, otherwise closest approximation labeled as such.
- **Typography**: font family (check for a custom/branded font vs. system font), and for each text role (page title, section header, body, small/meta text, button label) the size, weight, and line-height you observe.
- **Spacing scale**: the repeating spacing unit(s) the layout uses (e.g. 4/8/12/16/24px rhythm) — infer from gaps between elements.
- **Shape**: border-radius values by component type (buttons vs. cards vs. avatars vs. inputs), shadow/elevation styles, border widths/colors.
- **Iconography**: icon style (outline vs filled), approximate size, source if identifiable (e.g. a known icon set).

## Step 5 — Component inventory

List every reusable component you can identify across the screens (not per-screen — once, globally), each with: name, one-line purpose, visual description, and every state you actually observed (default, hover, active/pressed, focus, disabled, selected, loading, empty, error). If you couldn't trigger a state (e.g. you didn't have an account to see an error toast), say so rather than inventing it.

For every component that *initiates an action* (buttons, submit controls, toggles, drag targets, infinite-scroll triggers, etc.), add a one-line pointer to its full workflow writeup in Section 10 (Feature Workflow Library) rather than duplicating the workflow here — the component inventory stays about visual/state facts; Section 10 owns behavior and mechanism.

## Step 6 — Theorize the backend workflow behind each significant interaction

This is the step most clone attempts skip, and it's usually why a "faithful-looking" clone feels dead — the buttons are there but nothing behind them makes sense together. For every interactive element that plausibly talks to a server (posting content, toggling a setting, uploading a file, real-time updates, search, pagination, auth, presence/status), work out — as a labeled theory — the round trip it triggers.

**How to gather evidence (in order of reliability):**

1. **Network tab / request inspector**, if your tooling exposes it: trigger the action and observe the actual request — method (GET/POST/PATCH/DELETE), URL/endpoint shape, request payload, response payload, status code, response headers (rate-limit headers, cache-control, etag), and timing. This is the single best source — use it whenever available, even for a couple of representative actions, rather than theorizing blind.
2. **WebSocket/streaming frames**, if visible: note the message shape and whether it's push (server-initiated) or a response to a client message. A chat app that updates other open tabs/windows instantly without polling is a strong signal of a persistent connection (WebSocket, SSE, or long-polling).
3. **Client-side timing and UI behavior**: does the UI update *before* any network activity completes (optimistic update, likely rolled back on failure) or only *after* (pessimistic, waits for server confirmation)? Does a failed action show a distinct retry/error state, implying the client tracks pending vs. confirmed vs. failed items?
4. **URL structure and routing**: REST-ish nested paths (`/servers/{id}/channels/{id}/messages`) imply a resource-oriented API; a single endpoint with an `operation` or query field implies RPC or GraphQL-style access.
5. **Storage inspection**: cookies, localStorage, sessionStorage keys (auth tokens, session IDs, feature flags, draft message content, cached user prefs) reveal what the client persists client-side vs. what it always re-fetches.
6. **Static/indirect evidence** when none of the above is available (no devtools access, or the action is one you deliberately didn't trigger per Step 0.4): infer from the control's label, icon, disabled/enabled conditions, adjacent copy, loading skeleton shape, and general knowledge of how equivalent features are conventionally built. Always mark this tier explicitly as "inferred, unverified."

**What to write for each workflow** (this becomes a Section 10 entry): a plain-language, ordered account of the full loop, covering as many of these as are relevant to that specific feature —

- **Trigger**: the exact user action (click, keypress, drag-drop, scroll threshold, timer).
- **Client-side pre-work**: validation, formatting, debouncing/throttling, local optimistic state change, disabling the control to prevent double-submit.
- **The request**: method, endpoint shape, auth mechanism implied (bearer token, cookie session), payload shape, idempotency concerns (does it need a client-generated ID to survive a retry without duplicating?).
- **Theorized server-side handling**: what the server plausibly does — validates/authorizes, writes to a primary datastore, possibly enqueues follow-on work (fan-out to other users' feeds, push notification dispatch, search-index update, thumbnail/preview generation, moderation/spam scan), and what it returns.
- **Real-time propagation**, if relevant: how the change reaches *other* connected clients (server pushes over the same socket/topic other users are subscribed to; a poll interval; a cache invalidation).
- **Client-side settlement**: how the UI reconciles the optimistic state with the real response (swap a temp ID for a real one, replace a "sending…" spinner with a timestamp, roll back and show an error toast on failure).
- **Failure modes observed or inferred**: what happens offline, on a validation error, on a rate limit, on a conflict (e.g. edited-elsewhere).
- **What Scram needs to replicate it faithfully**: the minimum mechanism — e.g. "needs an optimistic list-append with a temp key, a POST that returns the canonical record, and a reconciliation step keyed on that temp key" — stated as an implementation-agnostic requirement, not literal backend code (Scram may use a different stack entirely; the point is preserving the *behavior*, not the implementation).

**Worked example — "Post/Send" button (e.g. composing and sending a tweet, or a chat message):**

> Trigger: click on the send button, or Enter in the compose field (Shift+Enter for newline, if observed).
> Client pre-work: the compose field's content is trimmed and validated client-side (non-empty, under a character limit shown by a live counter); the button is disabled while empty and re-enabled once there's content; on submit, the input is cleared and the control is disabled immediately to prevent double-send.
> Optimistic UI: the new post appears in the feed/message list immediately, in a "pending" visual state (slightly muted, or with a small clock/spinner icon), before any server confirmation is observed — this is a strong signal of optimistic rendering with a locally-generated temporary ID.
> Request (inferred/observed): a POST to a resource-oriented endpoint (e.g. `/api/.../posts` or `/api/.../channels/{id}/messages`) carrying the body text, any attachments (likely already uploaded separately — see below — with the post referencing returned attachment IDs), and a client-generated idempotency/temp ID.
> Theorized server-side handling: authenticate the request via session/token → validate content (length, rate limits, spam/abuse filters) → persist the record → asynchronously fan it out to followers'/other members' feeds or push it over their open sockets → asynchronously trigger any secondary effects (notification dispatch to mentioned users, link-preview/thumbnail generation, search-index update) → return the canonical saved record (real ID, server timestamp).
> Real-time propagation: other connected clients viewing the same feed/channel receive the new item over a push channel rather than by polling — evidenced by it appearing in another open tab without a refresh, if you tested that.
> Settlement: the client swaps the temporary pending item for the canonical one keyed by matching the temp ID, removing the pending styling once the real response/socket event arrives.
> Failure modes: on rejection (rate limit, validation, moderation), the pending item likely reverts to an error state with a retry affordance rather than silently disappearing.
> Why this shape (see Step 7): optimistic UI trades a small risk of visible rollback for the perception of instant responsiveness, which matters enormously for a high-frequency action like posting/messaging; a naive "disable everything and wait for the server" version would feel sluggish by comparison and is why almost no modern chat/social product does it that way.
> What Scram needs: a client-side pending-item pattern with a temp key, a create endpoint that returns a canonical record, a reconciliation step, and a visible error/retry path on failure — not a literal database schema.

Apply this same depth of reasoning to *every* meaningful action you find: uploading media, editing/deleting a post, reacting/liking, following/friending, searching, infinite-scroll pagination, toggling a setting, switching channels/rooms (does it re-fetch or does it already have the data cached from a prior visit?), authentication (login/logout/token refresh), and presence indicators (online/offline/typing dots — these are almost always a real-time-channel feature, not a poll).

## Step 7 — Explain the *why*: design and engineering rationale

For each workflow you documented in Step 6, and for any structural/visual decision from Steps 3–4 that's non-obvious, add a short rationale explaining why it's plausibly built that way rather than some simpler or different way. This is what separates a spec that produces a *convincing* clone from one that produces a merely *decorated* one — Scram's agent should understand the intent behind a pattern well enough to make sensible decisions in the gaps you didn't explicitly cover.

Useful lenses to reason through (use whichever apply; you won't use all of them for every feature):

- **Perceived performance vs. correctness**: optimistic UI, skeleton loaders, and stale-while-revalidate caching all trade a small chance of visible correction for a faster-feeling product. Ask: would this feature feel noticeably worse if it waited for a round trip before showing anything?
- **Consistency vs. availability trade-offs**: real-time collaborative features (chat, presence, live reactions) tend to favor showing *something* immediately (eventual consistency) over blocking until every client agrees, because blocking would make the product unusable at scale.
- **Cost and scale**: why polling gets replaced by sockets/SSE as an app grows (polling multiplies request volume linearly with users × poll frequency; a push model doesn't); why images/attachments are uploaded to a dedicated store (often via a pre-signed URL obtained from the app server, so the large binary bypasses the app server entirely) rather than through the same endpoint as the rest of the form; why lists paginate/virtualize rather than loading everything.
- **Abuse and trust boundaries**: why destructive or identity-sensitive actions (delete, payment, email change) are pessimistic and often require re-confirmation, while low-stakes actions (like, react, draft-save) are optimistic; why rate limits and validation happen server-side even when also duplicated client-side (client-side checks are for UX, not security — the server can't trust the client).
- **State ownership**: why some state lives only on the client (draft text, UI panel open/closed, scroll position) and never touches the server, versus state that must be server-authoritative (anything other users can see, anything billing/permissions-related) — this boundary is usually visible in what does and doesn't survive a hard refresh.
- **Progressive disclosure / componentization**: why a feature is a modal instead of a full page (keeps context, implies it's a secondary/quick action) or vice versa (implies it's a primary, bookmark-able, back-button-relevant flow); why a sidebar collapses at a breakpoint instead of just shrinking (implies the content inside doesn't reflow gracefully below some width).
- **Convention and familiarity**: sometimes the honest answer is "this is how every app in this category does it, so users already have the muscle memory" — that's a legitimate and worth-stating rationale, not a cop-out, as long as you say it explicitly rather than implying it's a unique technical necessity.

Write these rationale notes in plain language, one to a few sentences each, attached to the relevant workflow entry (Section 10) or as a standalone note in Section 11 for broader architectural choices that span multiple features (e.g. "the whole app appears to be a single-page app with client-side routing, likely because navigating between channels needs to preserve the open socket connection and in-memory message cache rather than tearing it down on every page load").

## Step 8 — Per-screen detail

For each screen from Step 1, describe layout top-to-bottom / left-to-right as a build order: what's in each wrapper region, which components (from Step 5) appear where, real or representative copy/content, and any interaction notes specific to that screen (what happens on click/hover/scroll, any animation/transition you noticed) — and for anything that triggers a workflow documented in Step 6/Section 10, reference it rather than re-explaining it inline.

## Step 9 — Package and hand off

Assemble the final output as:

1. `screen-spec.md` — the filled-out template below.
2. `/screenshots/` — every capture from Step 2, named per the convention.
3. (optional) `appendix.md` — any raw HTML/CSS snippets worth preserving verbatim.

This bundle is what gets hand off to Scram — use `scram-handoff-prompt-template.md` (the companion file) to wrap it into a build prompt for Scram's agent. For a large, multi-screen bundle from the autonomous loop, see that file's note on chunking the handoff rather than sending everything in one prompt. When chunking, keep Section 9 (Theorized Backend Architecture) and Section 11 (Design Rationale) together in whichever chunk establishes the app shell — downstream chunks describing individual screens should reference them rather than re-deriving the architecture per screen.

## Step 10 — Write Scram's testing mandate into the spec

To be clear about the division of labor: you (running this procedure) never build anything and never have a running clone to test — you only extract. Nothing in this step asks you to test a live build yourself. What you're producing here is the **testing mandate**: a explicit, non-skippable set of instructions written *into the handoff spec* that governs how Scram's agent must build and verify its own clone. You're handing Scram not just what to build, but the standard it must hold itself to while building it, feature by feature, since that agent — not you — is the one with a live build to actually click through.

Add a **Section 13: Testing & No-Hardcoding Mandate (instructions for Scram)** to your output (template below), written as direct imperatives to the builder, covering:

**No hardcoding, ever.** Anything that looks like data in the original — a message, a username, an avatar, a count, a timestamp, a list item, a status indicator — must be backed by real state/a data layer in the clone, not a static value baked into markup. If a value can't change as a result of some interaction, it's hardcoded, and the mandate should say that's not acceptable, full stop.

**Every documented workflow must be fully implemented, not just its first visible step.** Point Scram back at Section 10: a "send" button has to actually perform the whole workflow you documented — append to real state, handle a second send, handle empty/invalid input, reflect the change everywhere else that data appears — not just clear the input and show one fake item once.

**Every documented component state must be genuinely reachable.** Point Scram back at Section 4: default/hover/active/focus/disabled/selected/loading/empty/error must each be something the clone actually enters through real interaction (submitting invalid input, emptying a list, simulating a failure), not a style copied from a screenshot with no logic behind it.

**Test as you build, not at the end.** The mandate should instruct Scram to test each feature immediately upon implementing it — before moving on to the next one — rather than batching testing to a single pass after the whole app is built. Untested features compound: a broken data layer under an early feature can silently break several later ones, and hardcoded stand-ins left in "temporarily" tend to get forgotten rather than replaced. A feature isn't done until it's been tested; that's part of its definition of done, not a separate phase after.

**Every use case, not just the happy path.** For each workflow, the mandate should require Scram to check: the happy path end-to-end; boundary/edge cases (empty input, max-length input, zero/one/many items, rapid double-submit, refresh mid-flow); failure cases (whatever failure modes Section 10 theorized — invalid input, offline/network failure, conflicts — handled visibly, not silently swallowed); cross-cutting consistency (a change made in one place is reflected everywhere else that data appears); and responsive behavior at every breakpoint from Section 2, not just desktop.

**One more full pass at the end.** After every feature has been tested individually as it was built, the mandate should also require one final regression pass across the whole spec (every row of Section 1, every component of Section 4, every workflow of Section 10) — not to do first-time testing that should already be done, but to catch cross-feature regressions and inconsistencies that only appear once everything coexists.

Write this section in plain, direct, unambiguous language — it's the part of the handoff most likely to get skimmed or skipped under time pressure, so state it as a hard requirement ("must," "before moving on," "not acceptable") rather than a suggestion.

---

## Screen Spec Format (fill this in exactly)

```markdown
# Screen Spec: {Site Name}

## Meta
- Source URL(s): 
- Capture date: 
- Breakpoints captured: 
- Screens covered: {list}

## 1. Screen Inventory
| # | Screen name | Description | Screenshot files |
|---|---|---|---|

## 2. Global Layout / App Shell
- Wrapper regions (name, position, fixed/scroll, approx. size, flex/grid):
- Stacking / layering notes:
- Nesting outline (indented):

## 3. Design Tokens
### Colors
| Token | Hex | Used for |
|---|---|---|

### Typography
| Role | Font family | Size | Weight | Line-height |
|---|---|---|---|---|

### Spacing scale
- 

### Shape & elevation
- Border radius by component:
- Shadows:
- Borders:

## 4. Component Inventory
### {Component name}
- Purpose:
- Visual description:
- States observed: default / hover / active / focus / disabled / selected / loading / empty / error
- Triggers workflow(s): {pointer to Section 10 entry/entries, if applicable}

(repeat per component)

## 5. Per-Screen Detail
### {Screen name}
- Layout build order (top-to-bottom / left-to-right):
- Components used:
- Content/copy:
- Interactions & motion:
- Responsive changes at 768px / 375px:
- Workflows triggered here: {pointer(s) to Section 10}

(repeat per screen)

## 6. Navigation / IA
- Nav structure:
- Modal vs. full-page routing:
- Client-side vs. full-page-load routing (inferred, and why it matters — see Section 11):

## 7. Asset Manifest
| File | Screen | Breakpoint |
|---|---|---|

## 8. Open Questions / Not Observed
- {anything you couldn't verify — flag rather than guess}

## 9. Theorized Backend Architecture (global — applies across all screens)
- **API style** (REST / GraphQL / RPC / mixed), with evidence:
- **Auth model** (session cookie / bearer token / OAuth-style redirect), with evidence:
- **Real-time layer**, if any (WebSocket / SSE / long-poll / none observed), with evidence:
- **Theorized core data model**: the main entities implied by the UI and their relationships (e.g. User, Server, Channel, Message, Attachment, Reaction — sketch as a short indented outline or list of `Entity → key fields → relates to`), marked inferred:
- **Media/attachment handling**: direct upload to app server vs. inferred pre-signed URL to a separate object store, with evidence:
- **Caching/offline behavior observed**: what persists across refresh (localStorage/sessionStorage/cookies found, and what each likely holds):
- **Third-party services plausibly involved** (CDN, push notification provider, analytics, error tracking, payments), with evidence if any (request domains, script tags):
- **Overall architecture guess**: e.g. "single-page app, client-side router, persistent socket held at the app-shell level so it survives in-app navigation" — stated as a theory with supporting observations, not asserted as fact.

## 10. Feature Workflow Library (global — every action that plausibly hits a server)
### {Feature / control name, e.g. "Send message", "Upload attachment", "React with emoji", "Toggle setting"}
- Screen(s) where triggered:
- Evidence tier: observed via network trace / observed via UI timing only / inferred from static evidence (label this honestly)
- Trigger:
- Client-side pre-work:
- Request shape (method, endpoint pattern, payload) — mark inferred parts:
- Theorized server-side handling:
- Real-time propagation to other clients, if any:
- Client-side settlement / reconciliation:
- Failure modes (observed or inferred):
- What Scram needs to replicate this faithfully (behavioral requirement, not literal backend code):

(repeat per workflow — cover every button/control that isn't purely local UI state)

## 11. Design Rationale (Why) — architectural and cross-cutting decisions
- {Decision}: {plausible reasoning, using the lenses from Step 7 — performance, consistency/availability, cost/scale, trust boundary, state ownership, componentization, convention}

(repeat per notable decision; feature-specific rationale can live inline in the relevant Section 10 entry instead of being duplicated here)

## 12. Open Questions / Not Observed
- {anything you couldn't verify, including any workflow you could only theorize without network evidence — flag rather than assert as confirmed}

## 13. Testing & No-Hardcoding Mandate (instructions for Scram)
- No hardcoding: {statement of the requirement, applied to this app's specific data-bearing elements}
- Every workflow in Section 10 must be fully implemented end-to-end, not just its trigger — verify against that section's steps
- Every state in Section 4 must be genuinely reachable through real interaction, not just styled
- Test each feature immediately after building it, before moving to the next — do not batch testing to the end
- Per-feature test coverage required: happy path / boundary & edge cases / failure cases / cross-cutting consistency / every breakpoint from Section 2
- One final full regression pass required across Sections 1, 4, and 10 once all features are built, to catch cross-feature issues
```

---

## Quality bar before you consider this done

- Every screen you captured (whether from the fixed Step 1 list or discovered by the Step 0 loop) has a corresponding section in Step 8 and screenshots in the manifest.
- If you ran the autonomous loop, the Open Questions section lists anything you deliberately didn't click (destructive-looking controls, login walls, external links) rather than silently omitting them.
- Every color/type/spacing value is a real observed value, or explicitly marked as an approximation.
- Every meaningful interactive control (anything that isn't purely local, client-only UI state) has a corresponding entry in Section 10 with a full workflow write-up — trigger through settlement — and every workflow entry is honest about its evidence tier (observed vs. inferred).
- Section 9 (Theorized Backend Architecture) presents a coherent, internally consistent system theory — the data model, auth model, and real-time layer you describe should actually be capable of producing the behaviors documented in Section 10, not just be a generic checklist filled in independently per section.
- Every non-obvious design or architectural choice has an accompanying "why" — a plausible engineering or product rationale, not just a restatement of what the choice is.
- Nothing inferred is presented with the same confidence as something directly observed — the spec is explicit throughout about which tier of evidence each claim rests on.
- A reader who has never seen the original site could hand this spec + screenshots to a builder and get something structurally correct *and behaviorally coherent* — not just visually similar, and not just a static shell with dead buttons.
- You have not copied large verbatim blocks of the original site's copy/branding beyond what's needed to reproduce the *layout, structure, and behavior* faithfully — the goal is an accurate structural/visual/behavioral clone for prototyping on Scram, not a byte-for-byte mirror of their content.
