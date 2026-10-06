# Scram editor — operating guide for the automation

Built from a 303-action exploration of the Scram editor (Oct 2026) plus the user's own notes. "Scram's AI" = the builder bot in Scram's chat; "the extension" = us.

## Quick reference (most important)

- **Scram's AI can only build, and test its own work in Run mode.** It CANNOT switch Edit/Run, change the preview size, close panels or click anything in the editor. The extension does all of that. Never ask Scram's AI to.
- **The page view** (where building happens): AI chat on the left ("Ask Claude…" box at the bottom), the page canvas in the middle, page settings on the right. URL: `editor.buildwithscram.com/branch/<branch>/fe/app/<frontendId>/page/<pageId>[/settings]`.
- **Run mode**: the **Edit / ▷ Run** tabs at the top right of the canvas. Run mode = `preview=run` in the URL; Edit = no `preview` parameter. In Run mode the canvas toolbar becomes Refresh · Change favicon · path box · external preview link · Preview size · Edit/Run, and the status reads "Running frontend". Keep Run on for the whole build.
- **Preview size**: the device-icon button "Preview size, Desktop/Tablet/Mobile" next to Edit/Run opens a menu with Desktop / Tablet / Mobile; choosing one closes the menu and sets `breakpoint=desktop|tablet|mobile` in the URL. Works in Edit and Run mode.
- **Get back to the page view with the AI chat from anywhere**:
  1. Press Escape (closes most menus/dropdowns).
  2. Close any panel in the way (Plans ×, Activity ✕, "Close history", "Close theme panel"); Warnings/Errors dialogs close by clicking the same warnings/errors button again (Escape does NOT close them).
  3. In a workflow/data sub-view click **‹ Back** (top left of the canvas; repeat if nested).
  4. Click the frontend tab in the top bar (left of "More"; named after the frontend, e.g. "Frontend 1" or "Tasklane Web"). It may land on **Configure Frontend** (`…/fe/app/<id>/manage` or `…/fe/app/<id>`) instead of a page: then open the page list ("Current page: … Open page list.") and click the page entry (e.g. "Home Page /").
  5. If the AI chat section is collapsed, click its header chevron (^) once to re-open it.
- **Never click**: Publish; anything in the account menu except the "Copy …" items (especially **Cookie Preferences — it froze the whole editor until a page reload**; also Log out, Dashboard, debug items, feature-flag switches, "Reset pane layout"); "New savepoint"; "Add page" / "Add frontend" / "Add integration" / "Add workflow" / "Add Tables" / "Add user" / "Generate token" (they create things); "Change favicon" (leaves the page for Configure Frontend); the left-column section headers and their icons (AI chat title row: plans / + new chat / history / ^ collapse; "Page Structure" ⌄).

## Screens

### Dashboard (`dashboard.buildwithscram.com`)
- Big "What shall we build today? / Describe your project to start building…" box — **never type here** (it starts a project from a prompt).
- "Projects" grid with a **"Create new project"** card (a "+" tile) — click it to create a blank project; Scram opens the new project's editor by itself after ~20 s.

### Page editor — Edit mode
- **Top bar** (left → right): Scram logo · **frontend tab** (e.g. "Frontend 1") · **More** · section breadcrumb · … · search · **History** · warnings (⚠) / errors (ⓧ) · **Publish** (never) · **Help** · account menu.
- **Left column**: AI chat section (title row + messages + "Ask Claude…" box, paperclip "Attach files", send arrow), then **Page Structure** (Home Page / Page Root tree). A **Plans** list may show "No plans yet".
- **Canvas toolbar**: page picker ("Current page: Home Page. Open page list."), Components, Theme, Preview size, **Edit / Run**. Empty page shows "Add component" / "Project overview" cards.
- **Right panel**: "Edit Home Page" with Settings / Data / Logic tabs (Slug, URL query parameters, Access Control). The "Nobody has access" roles list there is an inline list, not a popup — Escape won't close it and it's harmless.
- **Plans panel**: a big "Plans" panel can cover the middle of the editor (with its tasks and a % bar). Close it with the **×** icon at the top right of the panel — it covers the Edit/Run buttons.

### Page editor — Run mode
- Same top bar and left column (AI chat + Plans). Canvas = live running app; toolbar: Refresh (reloads the preview), Change favicon (**navigates away** to Configure Frontend — avoid), path box, external dev-preview link (opens a new tab — avoid), Preview size, Edit/Run.
- A small number badge (e.g. "1", `dev-deployment-activity-btn`) opens an **Activity** panel (dev deployment log); close it with its ✕.

### Configure Frontend (page list → "Configure Frontend 1", or the frontend tab)
- URL `…/fe/app/<id>/manage` (or `…/fe/app/<id>`). Frontend name, description, Favicon picker, Fallback Pages dropdowns, static frontend URL. No Edit/Run here.
- **Back to a page**: page list → "Home Page /".

### Project Overview ("More")
- URL `…/branch/<branch>/be`. Clicking **More also pops open the section ("resources") menu — press Escape** to close it.
- Shows the project name (click it to rename: type the new name, Enter) above "Describe your project to start building…", and cards: Frontend 1, Add frontend, Project files (`/be/static-assets`), Workflows (`/be/workflows`), Data types (`/be/types/…`), Server logs (`/be/logs`), Database (`/be/data-sources/o_scramdb/…`), Storage (`/be/data-sources/o_scramfilestore`), Users (`/be/users`), Add integration, Components (`/fe/components`), Deployments; plus Locale/Timezone settings.
- The AI chat may be hidden here. **Back**: the frontend tab (then page list → page if it lands on Configure Frontend).

### Section ("resources") menu
- Button "Current section: X. Open resources menu." in the top bar. Lists Overview · FRONTEND (Component gallery, Project files) · DATA (Database, Storage) · INTEGRATIONS · AI AGENTS · SERVICES (Users, Workflows, Data types) · PUBLISHED PROJECT (Deployments, Server logs). Escape closes it.

### Backend screens (from Overview)
- **Workflows**: table of reusable workflows ("Send Email" by default); "Add workflow" menu.
- **Workflow / data-type canvases** (opened by Scram's AI or from lists): a canvas with **‹ Back** and a breadcrumb at the top left — click Back to return; the Edit/Run buttons aren't shown there.
- **Data types**: type definitions; the sub-breadcrumb (e.g. "Database > Users") opens a type picker.
- **Database**: per-table tabs (Data / Security / Schema), "Manage Data" (SQL query editor with Template SQL menu, Run Query) and "Change History". "Add Tables" opens a Create Table dialog (Cancel to close).
- **Users**: auth providers, roles, tokens. **Storage**, **Project files**: file lists and upload areas. **Server logs**: build filter, sort, copy URL. **Component gallery**: platform components with Properties / Styles / Logic.

### Panels and dialogs
- **History** (top bar): opens a right panel (`history=open` in URL) — close with **"Close history"** ×. "Collapse panel"/clicking the History header only minimises it.
- **Help**: menu with Scram manual (new tab), Keyboard shortcuts, Request support (dialog — close with its × or Cancel; never Submit).
- **Warnings / Errors** (status icons): open a dialog; **click the same icon again to close** (Escape doesn't).
- **Theme** (canvas toolbar): menu with the app's theme; "Edit Scram Theme" opens a **theme panel in the left column above the AI chat** (URL gets `theme=…`). Escape doesn't close it; use its "Close theme panel" × (or switching to Run hides it).
- **Components** / "Add component": component picker with category buttons (Structure, Content, Input, Data, Navigation, Overlays, Actions, Page Sections) — Escape closes it; clicking a component would insert it.
- **Preview size menu**, page list, fallback dropdowns, type picker, template menus: Escape closes them without changing anything.
- Toasts ("Copied", "Server URL copied") close with their × or by themselves.

## The AI chat (Scram's AI)

- Type in **"Ask Claude…"**, send with the arrow (`aria-label="Send"`) or Enter. Attach files with the paperclip (`aria-label="Attach files"`): it opens a file chooser; files appear as chips in the box.
- The chat's title row (chat name in quotes) has icons: plans list, **+ (new chat)**, chat history, **^ (collapse)** — don't click them. If the chat is collapsed, click ^ once to re-open.
- Scram's AI usually **proposes a plan** first (a plan card with "Read more" and an **"Approve plan"** button) and won't build until it's approved.
- It asks **questions** as forms: option buttons, a **"Write my own answer"** box, and "Submit answers". It may offer "Open Run and let me test it" — don't pick that; switch Run on yourself and answer that Run mode is on.
- While it works it shows progress lines ("85s · 9 steps …") and a Stop control; when finished it summarises what it did.
- **"AI paused by the browser"**: Scram pauses its AI when its tab isn't the visible one — keep the Scram tab visible (its own window).
- "Out of credits" / usage limits stop it — that needs the human.

## Recovery
- Clicks stop doing anything (e.g. after Cookie Preferences): reload the page.
- Landed on the dashboard or another project: go back to the project's editor URL.
- Can't find Edit/Run: close panels (Plans, Activity, history, theme), leave sub-views (Back), make sure you're on a page (`/page/` in the URL — use the page list if on Configure Frontend). As a last resort, add `preview=run` to the page URL.
