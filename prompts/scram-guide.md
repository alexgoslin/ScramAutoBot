# Using Scram to Build Apps — Complete Guide for Claude

---

## What is Scram?

Scram is a website where you build complete, fully working web applications without
writing code. You log in, describe what you want, and Scram's built-in AI bot
builds it for you — database, pages, logic, authentication, file storage, and
all. The app it creates is real and deployable, not a prototype.

You are going to use Scram to clone an existing product (a website or app) and
reproduce it with a different name and branding. Your job is to research that
product thoroughly, create a plan, and then work with Scram's AI bot to build it.

---

## The Single Most Important Feature: The Scram AI Bot

Inside every Scram project is a chat panel with a built-in AI assistant — also
Claude, but deeply connected to your project. This bot can see your entire
project at all times: every page, every database table, every piece of logic,
every component. It can build, modify, fix, and test things directly.

**This bot is your primary tool.** Almost everything in this guide is something
you would describe to the bot in plain English, and it handles the rest. You do
not need to click through menus to build things — you tell the bot what you want.

The bot can also:
- Open your running app and click through it to test features on your behalf
- Spot wiring issues, broken buttons, and visual glitches
- Check for errors across your entire project
- Compare what was built against your original plan

When you are unsure about anything, ask the bot. When something looks wrong,
describe it to the bot. It is not just a code generator — it is an active
collaborator that understands the full context of your project.

A few tips to do with the scram bot, only run it at claude sonnet with low thinking, the other
models and thinking capabilities are too expensive. When something does not work consistently, 
and the AI seems stuck, ask the AI to switch the component, or find another way around, do not
force a method if it is not working out. Sometimes the AI will stop talking randomly, prompt 
it to continue if this happens. If in any case a scenario happens where a component does not 
load in properly in the "run" mode of the site, then there will be a red cross, click the red
cross and you should be prompted to let the AI solve it. If there is a feature you would like 
to know about or to have, ask the AI and it will point you to it in the menu. If you need to 
test something like a user SQL problem, you can ask the AI to perform SQL queries for you into 
the dev environment.

---

## Before You Open Scram: Research the Product First

Before touching Scram at all, spend serious time studying the product you are
cloning. The more detail you bring, the more accurately the bot will reproduce it.

### What to document:

**Every page**
- What does it show?
- What is on the page (lists, cards, forms, sidebars, headers, etc.)?
- What happens when there is no data yet?
- What happens while something is loading?

**Every button and link**
- Where does it go?
- What does it do?
- Does anything change on screen when you click it?

**Every form**
- What fields are there?
- Are any fields required?
- What happens when you submit with missing or invalid data?
- What happens on successful submission?

**Every user type**
- Can different users do different things?
- Is there an admin or owner role with extra abilities?
- What can a guest (not logged in) see vs. a signed-in user?

**Every entity in the product**
- What are the "things" the app manages? (Users, posts, messages, servers,
  channels, files, reactions, etc.)
- How do they relate to each other?

**The visual design**
- Color palette
- Fonts
- Spacing and layout style
- Dark mode / light mode

Take screenshots of every screen. Write notes. Then bring all of it to Scram.

**Remember:** You are cloning the structure and features, not the brand. Use a
different name, different colors, and an original identity.

---

## The Scram Editor — A Complete Tour

When you open a project in Scram, you are in the editor. Here is every section
and what it does.

---

### TOP NAVIGATION BAR (runs across the very top)

**App switcher (left side)**
If your project has more than one app (e.g. a customer-facing site and a
separate admin panel), you switch between them here.

**Edit / Run toggle (center)**
- **Edit** — the default mode. You see the visual canvas and can make changes.
  Nothing is interactive here — it is design-only.
- **Run** — deploys your app to a real test environment and opens it right
  there in the editor. Buttons work, forms submit, data loads, login works.
  This is how you test whether things actually work. Switch back to Edit at
  any time — it is instant.

**Publish button (top right)**
Publishes your app to your live production URL — the real address your actual
users visit. Separate from Run, which is just for testing.

**Deployment button (top right)**
Opens the deployment panel where you can:
- Deploy to Dev (test environment)
- Publish to Live (production)
- See the full version history of every Live publish
- Roll back to a previous version if something went wrong

**Frontend configuration (top right area)**
Settings for the current app:
- The page users land on after logging in
- The page users are sent to if they try to access something they don't have
  permission for
- App name and description

**Project settings (top right)**
Project-wide settings:
- Project name
- Default language and timezone
- User roles (the permission levels in your app, e.g. "Member", "Admin")
- Project description

**Theme editor (top right)**
The global visual style of your entire app:
- Color palette (primary, secondary, neutral, error, success, and more)
- Heading font and body font
- Spacing scale
- Corner roundness
- Icon library
Changing anything here updates it everywhere across the app instantly.

---

### SIDE NAVIGATION (runs down the left edge, always visible)

**AI Chat (chat bubble icon)**
The Scram AI bot. This is where you type to describe what you want built, ask
questions, report problems, or request testing. Available in all views.

**Pages panel**
A list of all the pages (screens) in your app, organized by their URL structure.
Click any page to open it on the canvas. You can also create new pages here.

**Page Structure panel**
A tree view showing every element on the current page, nested in the order it
appears. Useful for selecting elements that are hard to click on the canvas,
reordering things, and understanding how the layout is structured.

**Component Instance Editor (appears when something is selected)**
When you click a component on the canvas, this panel opens with three tabs:
- **Properties** — the content and settings of that element (text, image source,
  link destination, etc.)
- **Styles** — the visual appearance (color, size, spacing, font, etc.)
- **Logic** — what happens when a user interacts with it (which workflow runs
  when it is clicked, submitted, changed, etc.)

---

### THE CANVAS (center of the screen, Edit mode)

The visual design view. You can see your pages here as they are being built.

**Clicking a component** selects it and opens its settings in the side panel.

**Right-clicking on empty space** gives you:
- Insert Component — add a new element to the page
- Edit page settings — name, URL path, access control
- Edit page data — what data loads when the page opens
- Frontend configuration — app-level settings

**Right-clicking on a component** gives you:
- Insert After — add something after it
- Wrap in Container — nest it inside a new container
- Copy / Clone — duplicate it
- Delete — remove it
- Open definition — edit the underlying reusable component
- Workflows — see the logic attached to it
- Metadata — view internal details

**Right-clicking in the Page Structure panel** gives you:
- Insert Component — add a child inside it
- Wrap in Container
- Copy / Clone / Delete
- Rename — give it a readable label
- Change Icon — change how it appears in the structure panel
- Highlight — flash it on the canvas so you can find it

**Keyboard shortcuts on the canvas:**
- Ctrl+C — copy selected component
- Ctrl+X — cut
- Ctrl+V — paste
- Ctrl+. — add new component
- Delete — delete selected component
- Escape — deselect
- Alt — hide selection outlines temporarily

---

### WORKFLOW EDITOR (accessible from the side panel Logic tab or Pages panel)

This is where logic lives — what happens when a button is clicked, a form is
submitted, a page opens, etc. Workflows are sequences of steps that run in order.

You do not need to build workflows manually. Describe the behavior to the bot
and it creates the workflow for you. But you can open them here to inspect what
was built or to understand what is happening.

---

### MORE (backend view — accessible from the left sidebar or top nav)

"More" is where everything outside of individual pages lives. It has these
sections:

---

#### DATABASE

Your app's built-in database. Think of it as a collection of spreadsheets that
store all of your app's data — users, messages, posts, channels, everything.

**Tables (listed across the top)**
Every table in your database. The Users table is always there and cannot be
removed. Click the + button to add a new table. Click any table to open it.

Each table has three tabs:

**Data tab**
The actual rows stored in this table right now. You can:
- Browse existing records
- Manually add new rows (useful for testing)
- Edit existing rows
- Delete rows

**Security tab**
Controls who can read, write, update, or delete rows in this table. This is
how you make sure users can only see their own data, or that only admins can
delete records. The bot sets these up for you.

**Schema tab**
The structure of the table — its columns (fields), their data types, and whether
they can be empty. The bot creates and modifies these. You can inspect them here.

**Manage Data tab**
A direct SQL query runner. Type a database query and run it to inspect data,
make bulk changes, or debug something. Runs with full access — no security
filters applied — so use with care.

**Configuration tab**
A read-only log of every schema change (migration) that has run on your
database. Useful for tracking what changed and when.

---

#### STORAGE

A direct view into your app's file storage — where any files uploaded by users
(or by you during development) are kept. Think of it as an S3 bucket you can
browse.

**What you see**
A list of files and folders. Folders are virtual — a file is "in" a folder
simply because its name starts with that folder's path (e.g.
`avatars/user-photo.png`).

**Refresh button**
Reloads the file list to show the current state.

**Upload button**
Upload a file directly here without going through the app. Useful for adding
test assets or initial content during development.

**Note:** Files cannot currently be deleted through the Scram UI. Plan your
file structure carefully.

---

#### HTTP API (Integrations)

Where you connect your app to external services — things like payment providers,
email services, mapping APIs, AI models, etc. You can typically ask the scram AI to do this, and it will do it with good quality.


**Manual Setup**
Configure an external API by hand — useful for simpler integrations or webhooks:
- **Outgoing APIs** — calls your app makes to external services (set the base URL,
  authentication method, shared headers)
- **Incoming APIs / Webhooks** — endpoints that external services can call into
  your app

**Danger Zone**
Permanently delete an API integration. Cannot be undone.

---

#### USERS

Where you manage who can log into your app and how.

**Accepted Logins section**
Shows every authentication method enabled for your app. Email/Password is on
by default. Each provider card shows:
- How many users signed up via it
- How many have ever logged in
- How many are suspended or removed

Click a card to configure it — you can set up Google, Facebook, Microsoft, or
custom OAuth/OIDC providers here. Each provider shows the callback URLs you
need to register with that provider.

**Add User button**
Add a user directly without them going through the signup flow. Fill in their
email, optional name, roles, and password. Useful for admin accounts or testing.

**Roles section**
The permission levels in your app. Every project starts with "Registered User"
and "Admin". You can add more roles (e.g. "Moderator", "Owner"). Roles are used
to control which pages and features different users can access.

Note: Roles cannot be deleted once created, only renamed. Add them carefully.

**API Tokens section**
Generate tokens that let external systems call into your app's API without going
through the normal login flow. Each token is tied to a user record and has an
expiry date (1 day to 3 years).

---

#### WORKFLOWS (Server-side)

Backend workflows that run independently of any page or user action — things
like scheduled tasks or webhook handlers. Separate from the page-level workflows
attached to buttons and forms.

---

#### DATA TYPES

Custom types you define for use across the project — for when you need a
structured, reusable shape for a piece of data. The bot creates these when
needed. You can inspect and manage them here.

---

#### DEPLOYMENTS

The full publication history of your live app.

**Dev environment**
Your test environment. Deploy here to test changes in a real, running app before
they go to your real users. Ephemeral — not a permanent environment.

**Live environment**
Your production URL. What your real users see.

**Version history**
Every past publish is listed with:
- Its version number (v1, v2, v3…)
- When it was published
- Change notes describing what was in that version
- A migration log showing what database changes ran

**Publish New Version**
Publishes the current state of your app as a new live version.

**Republish Previous**
Rolls back to the previous version instantly. Use this if a new deployment
breaks something. Note: this only rolls back the app code, not the database —
any data changes stay in place.

---

#### SERVER LOGS

A real-time log of everything happening on your app's backend server.

**What gets logged**
Server-side activity is logged automatically. The bot can also insert custom
log messages into workflows so you can trace exactly what is happening step
by step.

**Filter and search**
Filter logs by Dev build number, search for specific messages, and sort by
time.

**Backend URL**
The Server Logs page is also where you find the URL of your app's backend
server — needed when setting up incoming webhooks or integrating with external
services that need to call into your app.

Note: Logs are for the Dev environment only, not Live.

---

#### PROJECT FILES

Static assets attached to your project — images, icons, fonts, and other files
you want to use in your app's design (not files uploaded by users, which go in
Storage).

Upload files here, then tell the bot "I uploaded a logo called X" and it will
use it in the design.

---

#### COMPONENT GALLERY

A visual showcase of every component available in your project — both Scram's
built-in components and any custom ones that have been built. A reference view
for browsing what exists. Not an editing tool.

---

## Working with the Bot — How to Get the Best Results

### Give it your full research first
Paste your notes, screenshots, and feature lists into the chat before anything
else. The bot uses this context for the entire build.

### Always ask for a plan before building
Say: *"Create a detailed plan and wait for my approval before building
anything."* Review every task. Compare it against your research. Every feature
from the original product should appear somewhere in the plan.

### Test each feature as it is built
After the bot completes any feature, say: *"Test that feature in the running
app before we move on."* The bot will open the live test environment, walk
through the flow, check for errors, and fix anything broken — before starting
the next feature.

**This is non-negotiable. Do not allow the bot to skip per-feature testing.**

### Test it yourself too
After the bot says something works, click Run and try it yourself. You know
the original product. If anything feels wrong or different, describe it exactly
and ask the bot to fix it.

### Use Server Logs to debug
If something is not working and it is not obvious why, go to More → Server Logs.
Ask the bot to add log messages to the relevant workflow so you can trace what
is happening step by step.

### Use the Database to verify data
Go to More → Database and open the relevant table's Data tab to confirm that
records are actually being saved when they should be. If data is not appearing,
describe what you expected to the bot.

### Use Storage to verify file uploads
Go to More → Storage and click Refresh to confirm that any uploaded files are
actually landing in the file store.

---

## Final Review — Before Calling It Done

When every feature is built, ask the bot to do a full final review. It should:

1. Go back through the original plan and confirm every task is complete
2. Go through every page of the app and compare it to the original product
3. Check every button — is it wired? Does it do something?
4. Check every link — does it go to the right place?
5. Check every form — does it submit? Does it validate? Does it show errors?
6. Check every empty state — what shows when there is no data?
7. Check every loading state — does the UI show something while data is fetching?
8. Check every error state — what happens when something goes wrong?
9. Check mobile and tablet layouts — does the design hold up on smaller screens?
10. Check light mode and dark mode — do colors still contrast correctly in both?
11. Check for visual glitches — anything repeated unexpectedly, cut off, or
    misaligned?
12. Check auth — sign up as a new user, log in, log out, try accessing a
    protected page while logged out
13. Check roles — do admin features hide correctly from regular users?
14. Run a full error check across the entire project and fix everything

---

## The Definition of Done

The app is complete when all of the following are true:

- [ ] Every feature from the original product exists and works
- [ ] Every button does something
- [ ] Every link goes somewhere correct
- [ ] Every form submits, validates, and shows errors properly
- [ ] All data comes from the real database (no placeholder content)
- [ ] Empty states are handled (something intentional shows when there's nothing)
- [ ] Auth works: sign up → correct role assigned → log in → protected pages
      work → log out returns to the right place
- [ ] Users without permission cannot reach pages they shouldn't see
- [ ] The layout works on mobile and tablet
- [ ] Light and dark mode both look correct
- [ ] Server Logs show no unexpected errors
- [ ] The Database shows data being saved correctly
- [ ] Every feature has been tested in the running app by the bot
- [ ] The final review is complete and matches the original product
- [ ] The plan has been checked and every single task is confirmed done

**"The bot built it" is not done. "The bot tested it and confirmed it works" is done.**
