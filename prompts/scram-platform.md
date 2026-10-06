# What Scram can build — platform facts (from the official docs, scram.mintlify.app)

This is about what **Scram's AI** builds with. The extension can't do any of it: it only drives the editor (Run mode, preview size, panels) and talks to Scram's AI. Use these facts to plan steps Scram can really build, to word requests in Scram's terms, and to recognise a genuine platform limit when Scram's AI reports one.

## How a Scram app is made
- A **project** holds one or more **frontends** (once called "apps": web app, admin tool…). Frontends share the same database, file store, users, components and theme.
- **Pages** are built on the **Canvas** from **components**. Each component instance has Properties, Styles and Logic (events → workflows). Custom components can be built from other components. They have props, variables and events, and use **slots** (the Repeater has several).
- **Workflows** are action sequences that run on events (click, submit, change, page load) or server side.
- **Page data** loads when a page opens and can be reloaded with Reload Page Data. Data is **reactive**: expressions update when their inputs change.
- **Database**: a built-in PostgreSQL database. You define tables and columns, and SQL runs through the **Execute SQL** workflow action (SELECT / INSERT / UPDATE with `:named` parameters). **Table Security** (row-level security) decides who can read and write each table. A built-in **Users** table holds the users.
- **Users and auth** are built in: email + password sign-up and login, social login (Google, Facebook, Microsoft, custom OAuth/OIDC), roles ("Registered User" and "Admin" to start; roles can't be deleted), page authorisation with fallback pages, and API tokens.
- **File Store**: S3-backed storage for user uploads (Prepare File Upload / Upload File to URL / List Files). A file's `path` is its identity. **Project Files** hold the app's own static assets (logo, images).
- **HTTP API**: outgoing calls to external services and incoming webhook endpoints.
- **Theme**: a project-wide set of colours, fonts, spacing, corner radius and icon library.
- **Deployments**: Run uses a Dev build, and Publish creates a Live version that can be rolled back. **Server Logs** cover Dev only. Log Message actions write to them.

## Building blocks (names Scram uses)
- **Components**: Page Template Full · Repeater (lists, with pagination) · Container · Styled Container · Background Image Container · Card · Divider · Overlay Container · Full Screen Overlay · HTML Element · Avatar · Avatar Group · Chip · Heading (1–4) · Icon · Image · Text · Unstyled Text · Checkbox · Checkbox Group · Chip Group · Input components (text, number, email, password, text area…) · Input Select · Date Picker Input · Meter · Progress Bar · Main Navigation · Main Footer · Link · Tabbed Section · Breadcrumbs · Alert · Toast · Button · Icon Button · Button Group.
- **Workflow actions**: Set Variable · Create Variable · Reload Page Data · Reload All Page Data · Run Code (JavaScript) · Emit Event · If/Else · Case Switch · Switch Case · Terminate · Log Message / Log to Console · Upload File to URL · Signup New User with Email and Password · Login Existing User · Login With Token · Logout User · Reload User · Signup or Login with Social Provider · Set Password · Validate Password · Generate Secret Token · Execute SQL.
- Also: aggregates, filtering with query parameters, pagination, dates and times, arrays, CSV import into the database, and manual transactions (BEGIN/COMMIT inside one Execute SQL step).

## What Scram can NOT do yet (official "Current limitations")
Don't plan steps that need these. Build the nearest simple version, or leave the feature out and say why, so Scram's AI doesn't get stuck. When Scram's AI reports one of these, it's a real limit: accept it and move on.
- **Background processing over many records** ("for every contact, send an email"). Bulk and batch jobs and queued work are not supported.
- **Scheduled jobs / CRON** (nightly syncs, daily digests).
- **Real-time push** (WebSockets / server-sent events): no live chat updates, presence or live notifications. Use a Refresh button or reload-on-action instead.
- **Database triggers** (run a workflow when a row changes). The workflow that writes the row must do the side effect itself.
- **External database access** (connection string, BI tools, replication).
- **Fuzzy, full-text or semantic search**. Only SQL `LIKE` / `ILIKE`.
- **Private files with signed or expiring URLs**. Stored files are served from public URLs.
- **Server-side JWT signing** (LiveKit, Mux, Stream, Algolia, GitHub Apps…).
- **Verifying incoming webhook signatures** (Stripe, GitHub, Slack, Twilio, Shopify HMAC).
- **Shorter login sessions**. Users stay logged in for 30 days.
- **A cookie consent banner** that gates which cookies are set.
- **IP allowlists / denylists**.
- **SEO**: per-page title and meta, Open Graph cards, sitemap, robots.txt, JSON-LD.
- **Custom scripts in the page head**: no Google Analytics, pixels, Intercom or Hotjar snippets.
- **Charts and data visualisation**. There's no chart component, so show numbers as cards, tables, meters or progress bars.
- **Interactive maps and geo queries** (map widgets, distance sorting, place autocomplete, routing).

## Gotchas worth putting in step files
- **Keep workflows that write to the database short.** A slow call can be retried automatically and write duplicate rows. Batch big writes (a few hundred rows per call) and check whether a record exists before inserting it.
- **Social login inside the Run preview** may not finish in some browsers. Test it in Chrome, or open the app in its own tab with the external-link icon in Run mode.
- **Separate Execute SQL steps are not one transaction.** Writes that must succeed together go in one step with BEGIN/COMMIT.
- **Uploads**: "Check for Duplicates" (on by default) blocks a second file at the same path. For many users uploading `cv.pdf`, put a unique token in the path. For a profile picture, use a fixed per-user path with the check off. A table of file records gives a reusable "my files" list.
- **Roles can't be deleted.** Name them carefully.
- **Storage files can't be deleted in Scram's UI.**
- **Testing**: Scram's AI tests in Run mode, which uses a Dev build.
