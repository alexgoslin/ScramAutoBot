# Scram Site Analysis & Handoff (Chrome extension)

A Manifest V3 Chrome side-panel extension that:

1. **Captures** the page you're on (including logged-in sites), sends it to Claude with the *Site Screen Spec Extractor* prompt, and saves the resulting markdown spec, grouped by site.
2. **Generates a handoff**: it joins all specs for a site and sends them to Claude with the *Phased Build Handoff Splitter* prompt. It saves the result as a manifest, a combined document, and ordered step files (Step 0 Setup, Step 1 Auth, Step 2+ screens).
3. **Builds in Scram**: it opens `https://dashboard.buildwithscram.com/`, tries to start a new project, and pastes the steps into the Scram AI chat one at a time, waiting for you to confirm each one.

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
