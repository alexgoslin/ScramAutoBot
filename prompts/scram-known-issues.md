## Known Scram issues and pitfalls (from Scram's editor source and testing, Nov 2026)

Pages and components
- NEVER name a reusable component's prop `props` or `events`. Codegen declares its own locals with those names, the generated file is invalid JavaScript, and because every app compiles every component in the project, EVERY app in the project stops building — with no warning in the editor.
- Components have no id, so in-page links (jump to a section) need an invisible marker element just above each section. Check where the markers land.
- Breakpoints: use the tablet style for "768 and below".
- The email input ignores the theme's background and radius (a platform bug); don't spend rounds fighting it.
- Modals may be built as pages. If it matters, say so; otherwise accept it and note it.
- Dates default to the format 05/11/2026. Specify the format wanted (e.g. "5 Nov 2026"), or the locale default is used.

Links and addresses
- Every link the app hands out (copy buttons, emails, webhook and MCP responses) must be a FULL URL built from one `publicBaseUrl` setting. A bare `/path` looks right in the editor and breaks everywhere else.
- The Run-view address changes with every build; the stable dev form is `<project>.dev.scramapps.com/<appId>/app/...`. Change `publicBaseUrl` when publishing to the live domain.

Users and data
- New accounts start with NO roles: the first admin must be given the role by hand (in Scram's Users panel). A tester who signs up can't reach admin pages until someone adds the role.
- Enums are stored as keys, with labels mapped in the UI. A display id (e.g. ITEM-001) is stored beside the auto integer id; say whether lookups must match by number (ITEM-3 finds ITEM-003).
- Backend steps can't run script code: pure parsing functions become SQL functions. Fine — test them with example inputs and expected outputs.

Integrations
- Workflows can't see the raw request body, so webhook HMAC signatures (e.g. GitHub's X-Hub-Signature-256) can't be verified. The working fallback is a shared key in the URL query (?key=), which is weaker; decide up front whether that's acceptable.
- Make inbound endpoints idempotent: store the delivery id so the same delivery twice doesn't create two rows; ignore unknown ids and return 200 with the ids handled.
- Secrets are settings with a placeholder value: never invent a value and never print one in chat.
- MCP auth: a bare HTTP 401 makes MCP clients start an OAuth handshake, so return HTTP 200 with a JSON-RPC error instead. The platform may intercept an Authorization header; test the real key as Bearer and fall back to ?key= if it 401s.

Working with Scram's AI
- The editor preview isn't a test: it can show a stale build and doesn't keep state. Test in Run mode.
- Scram's AI can't see what a page looks like (computed colours, fonts, sizes) or resize the window; visual checks are done from outside.
- "Investigate only" isn't always respected: Scram's AI has rebuilt components and switched themes while told not to change anything. Ask it to list everything it changed.
- When Scram's AI says something "isn't possible", it often means its own tool can't do it, not that the platform can't.
