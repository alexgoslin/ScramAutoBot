# Scram Site Analysis & Handoff (Chrome extension)

A Manifest V3 Chrome side-panel extension that:

1. **Captures** the page you're on (including logged-in sites), sends it to Claude with the *Site Screen Spec Extractor* prompt, and saves the resulting markdown spec, grouped by site.
2. **Generates a handoff**: it joins all specs for a site and sends them to Claude with the *Phased Build Handoff Splitter* prompt. It saves the result as a manifest, a combined document, and ordered step files (Step 0 Setup, Step 1 Auth, Step 2+ screens).
3. **Builds in Scram**: it opens `https://dashboard.buildwithscram.com/`, tries to start a new project, and pastes the steps into the Scram AI chat one at a time, waiting for you to confirm each one.

It can do all three steps on its own with **Autopilot** (see below), or you can drive each step yourself.

## Autopilot

Open the site you want to clone (logged in, if it has accounts), open the side panel and click **🚀 Autopilot [site]**. After one confirmation it runs with no further clicks.

Before starting, you can type **Instructions for this run**, e.g. "Ignore the Grok part and anything Premium; focus on the timeline, profiles and DMs". Every stage follows them:
- **Crawl:** the navigator skips matching controls and links, and turns your instructions into URL fragments (e.g. `/i/grok`) that are hard-blocked for the rest of the crawl.
- **Specs:** excluded areas are left out.
- **Handoff:** no steps are created for excluded areas.
- **Scram:** the supervisor respects your instructions when answering Scram's bot.

The draft is remembered between panel openings.

The stages:

1. **Explore:** opens a dedicated tab and crawls up to 20 screens (you can change this). On each screen it:
   - records the page's API traffic via `chrome.debugger` (Chrome shows a "debugging this browser" bar while this runs),
   - scrolls to trigger lazy loading, takes a screenshot, and reads every control on the page,
   - asks a cheap navigator model which controls, text boxes and links to try,
   - clicks each control and records what opened or changed, how the control itself changed, and which requests fired. Toggles (like, follow, bookmark, switches, checkboxes) are clicked again to undo them,
   - types a test string into search boxes and composers to see suggestions, counters, validation and buttons becoming enabled. It never submits.

   It then writes the Screen Spec with the network trace and interaction log as observed evidence, and queues other *kinds* of screens: one profile, one post, one settings page, not 500 of each.
2. **Handoff:** generates the step files, with your Scram guide included as reference and an original app name.
3. **Scram setup:** opens Scram and waits for you if you need to log in. A small Claude-driven UI agent then opens or creates the project, opens the AI chat, and sets the bot to Sonnet with low thinking if there's a selector for it.
4. **Build:** sends each step file with "plan first, wait for approval", then waits until Scram's bot goes quiet. A supervisor reads the bot's new output and decides what to do next:
   - approves the plan (clicks Approve or replies),
   - answers the bot's questions,
   - pushes it to test every checklist item in Run mode,
   - tells it to continue or switch approach when it stalls,
   - marks the step done once testing is explicitly confirmed, then sends the next step.

Autopilot **pauses and notifies you** when it needs a person: a Scram login it waits for, credentials or payments, publishing to Live, or a step that goes past 30 rounds. It also stops on an error. Click **Resume** to continue or **Stop** to end it. Progress is saved, so it survives Chrome restarting the extension's background worker.

**Product focus** (Settings, on by default): the clone covers the *product* (posting, feeds, replies and threads, reposts, media, profiles, messages, notifications, search, product settings), not the company around it. Four things enforce this:
- URLs whose first path segment is corporate or boilerplate are never queued. That covers about, careers, press, ads, business, help, developer docs, blog, privacy, terms, cookies, legal, premium, pricing and downloads. Product pages like `/settings/privacy` stay reachable.
- Links to other sites and subdomains (e.g. `business.x.com`) are never clicked.
- The navigator is told to prioritise product features.
- Specs give business areas one line, and the handoff creates no steps for them.

**Exploration mode** (Settings):
- **Full interaction** (default): clicks everything as described above.
- **Safe:** read-only. Only menus, tabs, modals, links and search.

In both modes a hard block-list is never clicked, whatever the model says: log out or switch account, delete or deactivate, buy/pay/upgrade/subscribe, and post/reply/send/publish/invite/report/message. Text typed into boxes is never submitted.

It uses your Anthropic API credits (roughly two calls per explored screen, plus one per Scram chat round) and your Scram credits. The Autopilot card shows this run's calls and tokens. The all-time total, with a reset button, is under Settings → Data.

**Keeping token use down:**
- **Specs:** they are written tersely. After a site's first screen, the site-wide sections (design tokens, backend, rationale, testing mandate) only record what's new on that screen, since all specs are merged later anyway.
- **Handoff:** Claude writes the Context Block once. The extension inserts it into every step file with a progress ledger, so Scram still gets it in full every time.
- **Prompt caching:** the large system prompts (extractor, splitter, Scram guide) are marked for caching, so repeat calls read them at a fraction of the input price.
- **Lower cost further:** in Settings, reduce **Max screens** or **Max controls per screen**, or point **Model** at a cheaper model.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Right-click the extension icon → **Options**. Paste your Anthropic API key, then click **Test API key** and **Save settings**.
3. Click the extension icon to open the side panel. It stays open while you browse.

## Prompts

`prompts/site-screen-spec-extractor.md` and `prompts/scram-phased-handoff-splitter.md` are the system prompts, word for word. To try a different version without editing files, paste it into the matching box on the Options page. Options-page prompts take precedence.

Both prompts were written for a different setup, so the extension adds a short note to the **user message** of each request. The prompts themselves stay unchanged:

- **Capture:** the extractor assumes Claude in Chrome with browsing, screenshots and devtools. The note says this is a single-page capture. It tells Claude to skip the discovery loop and screenshots, to treat the computed-style data as observed, to treat backend workflows as inferred (there's no network trace), and to replace personal data with placeholders.
- **Handoff:** the splitter expects one merged `screen-spec.md`. The note tells Claude to merge the per-page specs first, then follow the procedure. It also asks for JSON: `{ manifest, combinedDoc, steps: [{ stepNumber, title, content }] }`. Claude leaves `combinedDoc` empty, and the extension builds it from the manifest plus the step files, so output tokens go to the steps. Steps are renumbered 0…n-1 in Claude's order, so an arc like "3a/3b" still makes a clean queue.

## Side panel

| Tab | What it does |
| --- | --- |
| **Capture** | Shows the current URL, a **Capture this page** button with a spinner and elapsed time, and the pages captured so far for the current site |
| **Files** | Every spec file, grouped by site. Click a file to read it, **Copy** to copy it, ✕ to delete it |
| **Handoff** | Pick a site and click **Generate Handoff for …**. Lists the manifest, the combined doc and the steps in order, each readable and copyable |
| **Build** | **Build in Scram** plus the step queue. Each step has **Send to Scram** (copies it to the clipboard, focuses or opens Scram, and pastes it) and **Done** (marks it complete and sends the next step) |

## The Scram flow

When a build is active, a small overlay appears on the Scram dashboard. It will:

- try once to click a "New project" / "Create project" button,
- wait up to 5 minutes for the AI chat box to appear, then paste the current step into it (the step is also copied to your clipboard),
- press send only if **Auto-submit** is turned on in Options (off by default, so you can review the text first),
- give you **Paste into chat**, **Copy step**, **New project** and **✓ Step done — send next** buttons.

Scram has no public API, so its UI is detected with heuristics (button text, textarea or contenteditable placeholders). If detection fails, the step is still on your clipboard: paste it with Ctrl/Cmd+V.

## Storage (`chrome.storage.local`)

- `sites`: `[{ siteUrl, domain, firstCapturedAt, lastCapturedAt }]`
- `specFiles`: `[{ id, siteUrl, pageUrl, pageTitle, content, capturedAt }]`
- `handoffFiles`: `[{ id, siteUrl, fileType: "manifest" | "combined" | "step", stepNumber, title, content, createdAt }]`
- `buildProgress`: `{ [siteUrl]: { siteUrl, currentStep, completedSteps[] } }`
- `apiKey`, `settings`, `promptOverrides`, `activeBuild`, `jobs` (in-flight status for spinners)

`siteUrl` is the page's origin, for example `https://x.com`.

## Notes

- All Claude calls run in the service worker (`background.js`) and stream their responses, so long generations don't time out. The spinner shows how many characters have arrived.
- Page data is collected with `chrome.scripting.executeScript`:
  - `document.body.innerText` (cut off at 120k characters), `document.title` and `location.href`
  - a nested layout outline with real pixel sizes and flex, grid, scroll and z-index info
  - computed design tokens: text and background colours as hex, fonts by role, radii, shadows, spacing
  - every visible control, link, form and input, with its state (disabled, selected, expanded and so on)
  - localStorage, sessionStorage and cookie **key names**, but never their values
  - third-party script hosts
- **Model:** the default is `claude-sonnet-5`, and you can change it in Options. The model in the original brief, `claude-3-5-sonnet-20241022`, is retired and the API no longer accepts it.
- Max tokens are 8000 for specs and 16000 for handoffs by default, and both can be changed in Options. Your splitter repeats the full context block in every step file, so a site with many screens can go past 16000. When that happens you get an error; raise the handoff limit in Options (for example to 32000–64000) and generate again. A spec cut off at 8000 tokens is saved with a warning note at the end.
- Captured page content is sent to the Anthropic API. Don't capture pages whose data you aren't allowed to share.
