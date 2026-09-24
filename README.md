# Scram Site Analysis & Handoff (Chrome extension)

A Manifest V3 Chrome side-panel extension that:

1. **Captures** the page you're on (including logged-in sites), sends it to Claude with the *Site Screen Spec Extractor* prompt, and saves the resulting markdown spec, grouped by site.
2. **Generates a handoff**: it joins all specs for a site and sends them to Claude with the *Phased Build Handoff Splitter* prompt. It saves the result as a manifest, a combined document, and ordered step files (Step 0 Setup, Step 1 Auth, Step 2+ screens).
3. **Builds in Scram**: it opens `https://dashboard.buildwithscram.com/`, tries to start a new project, and pastes the steps into the Scram AI chat one at a time, waiting for you to confirm each one.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Right-click the extension icon → **Options**. Paste your Anthropic API key, then click **Test API key** and **Save settings**.
3. Click the extension icon to open the side panel. It stays open while you browse.

## Your prompts

`prompts/site-screen-spec-extractor.md` and `prompts/scram-phased-handoff-splitter.md` are working **placeholders**. You can replace them in either of these ways:

- overwrite those two files with your own and reload the extension, or
- paste them into the two prompt boxes on the Options page. Options-page prompts take precedence.

The handoff request always appends instructions to return JSON in this shape:
`{ manifest, combinedDoc, steps: [{ stepNumber, title, content }] }`. Your splitter prompt doesn't need to describe the format.

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

- All Claude calls run in the service worker (`background.js`). Page text is collected with `chrome.scripting.executeScript` (`document.body.innerText`, `document.title`, `location.href`, plus a light outline of headings, buttons, links and forms) and cut off at 120k characters.
- **Model:** the default is `claude-sonnet-5`, and you can change it in Options. The model in the original brief, `claude-3-5-sonnet-20241022`, is retired and the API no longer accepts it.
- Max tokens are 8000 for specs and 16000 for handoffs by default, and both can be changed in Options.
- Captured page content is sent to the Anthropic API. Don't capture pages whose data you aren't allowed to share.
