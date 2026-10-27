// Autopilot phase 1: crawl the site in a dedicated tab. On each screen it records
// the network trace while loading/scrolling, asks Claude which controls to try,
// clicks them one by one noting what changes and which requests fire (undoing
// toggles afterwards), types into text boxes without submitting, then writes the
// Screen Spec and queues further same-site screens.

import * as store from "./storage.js";
import { dom, navigate, screenshot, sleep, waitForLoad } from "./dom.js";
import { NetworkRecorder, summarizeNetwork } from "./network.js";
import { askJson, generateSpec, scramLimitations } from "./jobs.js";
import { PauseError } from "./errors.js";

// ------------------------------------------------------------------ interaction policy

// Two modes (Options → Exploration mode):
//   full (default) — click anything: likes, follows, bookmarks, reactions, toggles,
//                    settings switches, composers… Toggles are clicked again to undo.
//   safe           — read-only: only controls that reveal UI or navigate.
// In BOTH modes a short hard list is never clicked, whatever the planner says:
// ending the session, destroying the account/content, spending money, and
// actually sending content to other people.

const HARD_BLOCK_LABEL = /\b(log ?out|sign ?out|switch accounts?|delete|deactivate|close account|erase|buy|purchase|checkout|pay|payment|upgrade|subscribe|premium|donate|tip|post|tweet|reply|send|publish|submit|share (to|via|with)|invite|report|message)\b/i;
const HARD_BLOCK_URL = /log-?out|sign-?out|logout|signout|delete|deactivate|checkout|billing|payment|purchase|subscribe|premium|oauth|authorize|\/intent\/|\/share\?/i;
const SAFE_MODE_LABEL = /\b(remove|unsubscribe|cancel|repost|retweet|quote|follow|unfollow|like|unlike|favou?rite|bookmark|save|block|unblock|mute|unmute|accept|decline|approve|reject|join|leave|connect|disconnect|vote|upload|confirm|apply|update|edit|rename|archive|pin|unpin|hide|add|create|new|install|download|grant|allow|enable|disable|reset|clear|mark|dismiss|turn (on|off)|go live|start|stop)\b/i;
const SAFE_MODE_URL = /remove|unsubscribe|confirm|verify|compose|\/follow|\/like|\/download/i;
// Controls whose effect can be undone by clicking them again.
const TOGGLE_LABEL = /\b(un)?(like|follow|bookmark|favou?rite|save|pin|mute|block|star|upvote|downvote|watch|repost|retweet)\b/i;

// Product focus (Settings, on by default): the clone is about the product itself, so
// corporate/marketing/legal/help/monetisation pages are never queued. Matched on the
// FIRST path segment only, so product pages like /settings/privacy stay reachable.
const BUSINESS_FIRST_SEGMENT = /^(about|about-us|company|privacy|tos|terms|legal|cookies?|cookie-policy|careers|jobs|press|media-kit|newsroom|investors?|ir|advertis\w*|ads|business|brand|brand-toolkit|marketing|enterprise|partners?|affiliates?|help|support|faq|contact|contact-us|developers?|developer-platform|api-docs|docs|status|blog|premium|pricing|plans|upgrade|checkout|billing|download|downloads|get-app|imprint|sitemap|safety|transparency|rules|policies|policy|accessibility|licen[cs]es?|trust|security-center)$/i;

let MODE = "full";
let PRODUCT_FOCUS = true;

function isBusinessUrl(url) {
  try {
    const first = new URL(url, "http://x").pathname.split("/").filter(Boolean)[0] || "";
    return BUSINESS_FIRST_SEGMENT.test(first);
  } catch {
    return false;
  }
}

function isBlocked(el) {
  if (!el.label) return "no label";
  if (el.disabled) return "disabled";
  if (el.submits) return "submits a form";
  if (el.href) {
    // agent-dom reports same-site links as paths and other sites (incl. subdomains) as full URLs.
    if (/^[a-z][a-z0-9+.-]*:/i.test(el.href)) {
      let origin = "";
      try {
        origin = new URL(el.href).origin;
      } catch {
        /* not a URL */
      }
      if (!APP_ORIGINS.includes(origin)) return "link to another site";
    }
    if (HARD_BLOCK_URL.test(el.href)) return "hard-blocked link";
    if (PRODUCT_FOCUS && isBusinessUrl(el.href)) return "business/legal/marketing page (product focus)";
    if (MODE === "safe" && SAFE_MODE_URL.test(el.href)) return "changes data (safe mode)";
    return null;
  }
  if (HARD_BLOCK_LABEL.test(el.label)) return "hard-blocked (session, account, money or sends content)";
  if (el.editable) return "text box (typed into separately)";
  if (el.inLayer) return "inside a dialog/menu";
  if (el.type && /submit|file|reset/.test(el.type)) return `input type ${el.type}`;
  if (MODE === "safe") {
    if (el.type && /checkbox|radio|range|color|date/.test(el.type)) return `input type ${el.type}`;
    if (el.role && /switch|checkbox|radio|menuitemcheckbox|menuitemradio|slider/.test(el.role)) return `toggles (${el.role})`;
    if (el.role === "tab") return null;
    if (SAFE_MODE_LABEL.test(el.label) && !el.haspopup) return "changes data (safe mode)";
  }
  return null;
}

function isSearch(el) {
  return el.type === "search" || /searchbox|combobox/.test(el.role || "") || /search|find|filter/i.test(el.label || "");
}

function isTypeable(el) {
  if (!el.editable || el.inLayer || el.disabled) return false;
  if (el.type && /password|email|tel|number|file|hidden|checkbox|radio|submit|date|range|color/.test(el.type)) return false;
  return isSearch(el) || MODE === "full";
}

// ------------------------------------------------------------------ url helpers

// URL template used to avoid crawling 500 profiles/posts: numeric/hash-like segments collapse to :id.
export function pattern(url) {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (/^\d{3,}$|^[0-9a-f]{12,}$|^[0-9a-f-]{32,36}$|^[A-Za-z0-9_-]{20,}$/i.test(seg) ? ":id" : seg))
      .join("/")
      .replace(/\/$/, "");
    return `${u.origin}${path || "/"}`;
  } catch {
    return url;
  }
}

const sameOrigin = (url, siteUrl) => {
  try {
    const u = new URL(url);
    return u.origin === siteUrl || APP_ORIGINS.includes(u.origin);
  } catch {
    return false;
  }
};
// Where the product app lives when it isn't the site's own origin (e.g. monday.com's marketing
// site vs yourname.monday.com). Set per run from ctx.state.explore.appOrigins.
let APP_ORIGINS = [];
const baseDomain = (host) => {
  const parts = String(host || "").toLowerCase().split(".");
  const two = parts.slice(-2).join(".");
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
};
const sameSite = (a, b) => {
  try {
    return baseDomain(new URL(a).hostname) === baseDomain(new URL(b).hostname);
  } catch {
    return false;
  }
};
// "404 / page not found" screens: never written up and never counted.
function isErrorPage(snap) {
  const title = String(snap.title || "");
  const head = String(snap.text || "").slice(0, 600);
  return /\b404\b|not found|page (doesn['’]t|does not) exist|no longer exists/i.test(title) || (/\b404\b/.test(head) && /not found|doesn['’]t exist|does not exist|can['’]t find|couldn['’]t find/i.test(head));
}

// ------------------------------------------------------------------ tab + recorder

let recorder = null;

async function ensureTab(ctx) {
  const ex = ctx.state.explore;
  if (ex.tabId != null) {
    try {
      await chrome.tabs.get(ex.tabId);
      return ex.tabId;
    } catch {
      /* closed */
    }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  ex.tabId = tab.id;
  await ctx.save({ explore: ex });
  await ctx.log("Opened a dedicated exploration tab — please leave it alone while Autopilot works.");
  return tab.id;
}

async function ensureRecorder(ctx, tabId) {
  if (!ctx.settings.recordNetwork) return null;
  if (recorder?.tabId === tabId && recorder.attached) return recorder;
  await release();
  recorder = new NetworkRecorder(tabId, { bodies: ctx.settings.recordResponseBodies });
  try {
    await recorder.start();
  } catch (e) {
    await ctx.log(`Network recording unavailable (${e.message}) — continuing without it.`);
    recorder = null;
  }
  return recorder;
}

export async function release() {
  if (recorder) await recorder.stop();
  recorder = null;
}

// ------------------------------------------------------------------ planning

const PLANNER_COMMON = `BUTTON AUDIT — the crawler exists to understand how the site WORKS, button by button. Go through EVERY distinct button/control in the element list (buttons, icon buttons, tabs, menu triggers, toggles, nav items, cards that open something; not plain text links you put in "links"). For each, think about what it most likely does, then decide whether that functionality is worth building in the clone:
- "build": it does something users actually use (opens/creates/edits/filters/sorts/switches views/opens a panel, menu or detail, navigates to a working part of the app…) and a working version is reasonable to build in Scram.
- "skip": it isn't functional for users (marketing, upsell, help, cookie banners, feedback widgets), it's admin/enterprise plumbing, or the effort to build it far outweighs its value (e.g. needs something Scram can't do).
Put each one in "buttons" (repeated identical controls — the same "More" or "Like" on every item — once, with "repeats": how many). Then "controls" = the ids of the "build" buttons to click, most important first: the crawler clicks them and records exactly what each did. Hard-blocked buttons (marked BLOCKED) are never clicked, but still assess them (what they'd do, worth building or not).

SCREEN TYPES — think in types, not URLs. A screen type is a kind of screen defined by its layout and functionality, not by whose data it shows: every user's profile is the same type ("user profile"), every post's page is the same type ("post detail"), every conversation is the same type ("DM conversation"). testuser1's profile and testuser2's profile are the SAME type; post 123 and post 456 are the SAME type. Only treat something as a new type if its layout or available actions genuinely differ (e.g. your OWN profile with "Edit profile" vs someone else's with "Follow" may be separate types; a settings sub-page with different controls is a new type). Reuse the exact type names from "Screen types already explored/queued" whenever a screen is another instance of one.
- "screenType": the type of the CURRENT page.
- "sameAs": if the current page is just another instance of a type already EXPLORED, that type's exact name; otherwise null.

Links: choose same-origin links whose screen TYPE has not been explored or queued yet — at most one link per type. Label each with its type. Prefer primary navigation, sidebars, tabs and settings sections. Skip log out, delete, billing/checkout/payment, external sites, and legal/cookie/help boilerplate unless the site is tiny.
{{PRODUCT_FOCUS}}

Elements marked BLOCKED will not be clicked whatever you choose — don't pick them.

If the user gave instructions, they override everything above: never choose controls or links for areas the user said to ignore or avoid, and prioritise areas they said to focus on. Put URL path fragments for the areas to avoid (e.g. "/i/grok", "/premium") in "avoidPaths" — the crawler will then never visit any URL containing them.

LINKS MUST BE REAL: only choose links that appear in the element list (their href). Never invent or guess URLs (e.g. "/boards" because the product has boards): a made-up URL is usually a 404.

LOGIN AND APP: also judge from the page whether the crawler is logged in:
- "loggedIn": "yes" if you see signs of an account (avatar, account/profile menu, the user's own workspaces, boards, inbox, "Log out"); "no" if the page invites the visitor to log in or sign up (Log in / Sign in / Sign up / Get started / Start free trial / pricing-led hero) and shows no account; otherwise "unknown".
- "landing": true if this is a public marketing/landing page about the product rather than the product itself.
- "appUrl": if a link on this page goes into the logged-in product (e.g. "Go to my workspace", "Open app", "Dashboard", or a link to an app subdomain like app.example.com or yourname.example.com), its full URL; otherwise "".

Return ONLY a JSON object: {"pageName": "<short screen name>", "screenType": "<type of this page>", "sameAs": "<already-explored type name>" | null, "loggedIn": "yes"|"no"|"unknown", "landing": true|false, "appUrl": "<full URL or empty>", "buttons": [{"id": "<element id>", "label": "<label>", "does": "<what it most likely does>", "worth": "build"|"skip", "why": "<one short reason>", "repeats": <number, if repeated>}, ...], "controls": ["<element id>", ...], "typeInputs": ["<element id>", ...], "links": [{"path": "<path or full URL of a link on this page>", "type": "<screen type>"}, ...], "avoidPaths": ["<path fragment>", ...]}`;

const PLANNER_FULL = `You plan one step of an exploration of a website by an automated crawler that documents the site's UI and behaviour so it can be rebuilt faithfully. The crawler is logged into the user's own account and the user has allowed full interaction: it may click likes, follows, bookmarks, reactions, reposts, toggles and settings switches, tabs, menus, dropdowns, modals, and buttons that open composers/editors ("new post", "compose", "create…"), to observe what really happens and which requests fire. Toggles are clicked again afterwards to undo them.

It must still never be asked to: log out / switch account, delete / deactivate the account or delete content, spend money (buy, pay, upgrade, subscribe, premium, donate), or send content to other people (post, reply, send, publish, submit, share to, invite, report, message). Those are hard-blocked.

"controls" = the controls to click, in priority order.
"typeInputs" = text boxes worth typing a short test string into to observe behaviour (search suggestions, character counters, validation, send/post buttons enabling). The crawler types, observes, then clears — it NEVER submits or presses Enter.

` + PLANNER_COMMON;

const PRODUCT_FOCUS_NOTE = `
PRODUCT FOCUS: the goal is to clone the PRODUCT — what users actually do in the app — not the company around it. Spend the budget on core product functionality: creating and viewing content (e.g. composing posts, the feed/timeline, post detail with replies/threads, reposts/quotes, likes, media/images/video, polls), profiles and following, messaging/DMs, notifications, search and explore, lists/bookmarks/communities, and the user's own product settings. For work tools the product is everything users work in: workspaces, boards/projects/sheets and their views (table, board, calendar, timeline, form), item/record detail, docs, dashboards built from their own data, favourites, inbox/notifications, my-work/assigned-to-me, search, members and sharing. Never choose links or controls for business/corporate/marketing/legal/help/monetisation areas: about, careers, press, investors, advertising/ads, business or brand tools, help centre/support, developer/API docs, status, blog, privacy/terms/cookies/legal policies, premium/pricing/upgrade upsells, app downloads, or other subdomains (e.g. business.example.com, help.example.com). Add path fragments for any such areas you see to "avoidPaths".`;

const PLANNER_SAFE = `You plan one step of a READ-ONLY exploration of a website by an automated crawler that documents the site's UI and behaviour so it can be rebuilt. The crawler is logged into the user's REAL account: anything that creates, changes or deletes data, or affects the account or other people, must NEVER be clicked.

"controls" = SAFE controls to click: ones that only reveal UI or switch views — menus, "more"/overflow (…) buttons, dropdowns, popovers, tooltips, tabs, accordions/expanders, "show more", view/sort/filter switches, carousels, modals that open without submitting anything, and in-app navigation buttons. Never choose post/reply/send/share, like/react/vote/repost/bookmark/save, follow/subscribe/join/connect/invite, block/mute/report, delete/remove/archive/edit/rename, accept/decline/approve, upload/download, buy/pay/upgrade, log out, setting toggles, form submits, or anything whose effect you are unsure of.
"typeInputs" = search boxes only (typed into, never submitted).

` + PLANNER_COMMON;

// ------------------------------------------------------------------ scope (core features)

const SCOPE_SYSTEM = `You decide the scope of a website clone before a crawler explores it. The clone is built in Scram (a no-code app builder with its own AI builder). The goal is a clone that does what users really use the product for: every FUNCTIONAL feature that's worth building, and none of the fluff.

Think critically about each feature you can see or know the product has, weighing:
- VALUE: do users actually use it to get their work done (or is it marketing, upsell, admin-only or rarely touched)?
- EFFORT in Scram: can Scram build a working version without heroic effort? (Scram's AI builds it, so ordinary work — pages, tables, forms, lists, filters, dashboards from data, settings — is fine. Too much effort = needs something on Scram's "can NOT do" list, or a huge separate system like AI agents, a full automation engine, integrations marketplace, video calls.)
Keep a feature when its value is real and the effort is reasonable. Skip it only when it isn't functional (marketing, legal, help, careers, pricing/billing, ads), it's admin/enterprise plumbing (SSO, permissions consoles, audit logs), or the effort far outweighs the value. Don't skip a feature just because it isn't the very centre of the product: its views, favourites, dashboards built from the user's own data, inbox/notifications, search, settings the user changes, sharing and members lists all count when they work in Scram.

Decide:
- "product": one line on what this product is.
- "core": the features to clone, most important first (typically 6–14). Each with "why" (the value, and for anything Scram limits, how it'll be simplified, e.g. "refresh button instead of live updates").
- "skip": features NOT to clone, each with "why" naming the reason (not functional / admin plumbing / effort far outweighs value / Scram can't do it).
- For both, "paths": URL path fragments (from the links you see) that lead to that feature, if any.
- "avoidPaths": path fragments the crawler must never visit (only the skipped features' own paths; never a fragment that would also match a kept feature).
The user's instructions override your judgement.
Scram's hard limits are listed in the user message.

Return ONLY JSON: {"product":"...","core":[{"name":"...","why":"...","paths":["..."]}],"skip":[{"name":"...","why":"...","paths":["..."]}],"avoidPaths":["..."]}`;

async function decideScope(ctx, snap) {
  const links = snap.elements
    .filter((e) => e.href && !/^https?:/.test(e.href))
    .map((e) => `${JSON.stringify(e.label || "")} → ${e.href}`)
    .slice(0, 120);
  const instructions = store.runInstructions({ ...ctx.state, scope: null });
  const limits = await scramLimitations();
  const userContent = `${instructions ? `USER INSTRUCTIONS (they override your judgement):\n${instructions}\n\n` : ""}Site: ${ctx.state.siteUrl}
Start page: ${snap.url}
Title: ${snap.title}

Navigation links on the start page (label → path):
${links.join("\n") || "(none found)"}

Visible text (start):
${snap.text.slice(0, 3000)}${limits ? `\n\nScram's platform limits:\n${limits}` : ""}`;
  const raw = await askJson({ what: "Scope planner", system: SCOPE_SYSTEM, userContent, maxTokens: 2500 });
  const feats = (v) =>
    (Array.isArray(v) ? v : [])
      .map((f) => (typeof f === "string" ? { name: f, why: "", paths: [] } : { name: String(f?.name || ""), why: String(f?.why || ""), paths: (Array.isArray(f?.paths) ? f.paths : []).map(String) }))
      .filter((f) => f.name);
  const clean = (arr) => arr.map((p) => String(p).trim()).filter((p) => p.length >= 3 && p !== "/"); // never something as broad as "/i"
  const skip = feats(raw.skip);
  return {
    product: String(raw.product || ""),
    core: feats(raw.core).slice(0, 16),
    skip,
    avoidPaths: [...new Set(clean([...(Array.isArray(raw.avoidPaths) ? raw.avoidPaths : []), ...skip.flatMap((f) => f.paths)]))],
  };
}

async function planPage(ctx, snap) {
  const ex = ctx.state.explore;
  const s = ctx.settings;
  const lines = snap.elements.map((e) => {
    const bits = [e.id, e.role || e.tag, JSON.stringify(e.label || "")];
    if (e.href) bits.push(`href=${e.href}`);
    if (e.haspopup) bits.push(`haspopup=${e.haspopup}`);
    if (e.expanded) bits.push(`expanded=${e.expanded}`);
    if (e.selected) bits.push("current");
    if (e.editable) bits.push(`editable${e.type ? `:${e.type}` : ""}`);
    const blocked = e.editable ? (isTypeable(e) ? null : "not typeable") : isBlocked(e);
    if (blocked) bits.push(`BLOCKED(${blocked})`);
    return bits.join(" | ");
  });
  const remaining = Math.max(0, s.maxPages - ex.pages.length - ex.queue.length - 1);
  const instructions = store.runInstructions(ctx.state)
    ? `USER INSTRUCTIONS FOR THIS RUN (follow strictly):\n${store.runInstructions(ctx.state)}\n\n`
    : "";
  const explored = (ex.types || []).map((t) => `"${t.type}" (e.g. ${t.url.replace(ctx.state.siteUrl, "")})`);
  const queuedTypes = Object.values(ex.queueTypes || {}).filter(Boolean).map((t) => `"${t}"`);
  const sc = ctx.state.scope;
  const scope = sc?.core?.length
    ? `SCOPE (decided at the start): explore every functional screen of the features below — their lists, detail views, editors, other views (table/board/calendar…), favourites, dashboards, settings and empty states. Never follow links to the skipped features (add their path fragments to "avoidPaths"). For anything not listed either way, use judgement: follow it if it's a working part of the product a user would use, skip it if it's marketing, admin plumbing or not worth building. Within the core features, keep going: every distinct screen of a core feature counts (its list, detail view, editor, settings, empty states, sub-tabs), so keep choosing links to core screens you haven't explored until the screen budget is used.
Core: ${sc.core.map((f) => `${f.name}${f.paths.length ? ` (${f.paths.join(", ")})` : ""}`).join("; ")}
Skip: ${sc.skip.map((f) => f.name).join("; ") || "(nothing listed)"}

`
    : "";
  const userContent = `${instructions}${scope}Page: ${snap.url}
Title: ${snap.title}
Screen types already explored: ${explored.join(", ") || "(none — this is the first screen)"}
Screen types already queued: ${[...new Set(queuedTypes)].join(", ") || "(none)"}
URLs already visited: ${ex.visited.slice(-30).join(", ") || "(none)"}
Assess every button; choose at most ${s.maxInteractionsPerPage} controls to click, at most 2 typeInputs and at most ${Math.min(remaining, 8)} links.

Visible text (start):
${snap.text.slice(0, 2500)}

Interactive elements (id | role | label | extra):
${lines.join("\n")}`;
  try {
    const system = (MODE === "safe" ? PLANNER_SAFE : PLANNER_FULL).replace("{{PRODUCT_FOCUS}}", PRODUCT_FOCUS ? PRODUCT_FOCUS_NOTE : "");
    const plan = await askJson({ what: "Navigator", system, userContent, maxTokens: 8000, model: s.explorerModel });
    const list = (v) => (Array.isArray(v) ? v.map(String) : []);
    const links = (Array.isArray(plan.links) ? plan.links : [])
      .map((l) => (typeof l === "string" ? { path: l, type: "" } : { path: String(l?.path || l?.url || ""), type: String(l?.type || "") }))
      .filter((l) => l.path);
    // Keep only links that are really on the page (the planner sometimes guesses URLs).
    const onPage = new Set(
      snap.elements
        .filter((e) => e.href)
        .map((e) => {
          try {
            return pattern(new URL(e.href, snap.url).href);
          } catch {
            return "";
          }
        })
        .filter(Boolean)
    );
    const real = links.filter((l) => {
      try {
        return onPage.has(pattern(new URL(l.path, snap.url).href));
      } catch {
        return false;
      }
    });
    if (real.length < links.length) await ctx.log(`Ignored ${links.length - real.length} link(s) the navigator guessed that aren't on the page: ${links.filter((l) => !real.includes(l)).map((l) => l.path).slice(0, 6).join(", ")}.`);
    return {
      pageName: String(plan.pageName || snap.title || "Screen"),
      screenType: String(plan.screenType || plan.pageName || snap.title || "screen"),
      sameAs: plan.sameAs ? String(plan.sameAs) : null,
      loggedIn: ["yes", "no"].includes(String(plan.loggedIn)) ? String(plan.loggedIn) : "unknown",
      landing: plan.landing === true || plan.landing === "true",
      appUrl: typeof plan.appUrl === "string" ? plan.appUrl.trim() : "",
      controls: list(plan.controls || plan.safeControls),
      typeInputs: list(plan.typeInputs || plan.searchInputs),
      buttons: (Array.isArray(plan.buttons) ? plan.buttons : [])
        .map((b) => ({ id: String(b?.id || ""), label: String(b?.label || "").slice(0, 80), does: String(b?.does || "").slice(0, 200), worth: String(b?.worth || "").toLowerCase() === "skip" ? "skip" : "build", why: String(b?.why || "").slice(0, 200), repeats: Number(b?.repeats) || 0 }))
        .filter((b) => b.id || b.label)
        .slice(0, 120),
      links: real,
      avoidPaths: list(plan.avoidPaths).map((p) => p.trim()).filter((p) => p.length >= 2 && p !== "/"),
    };
  } catch (e) {
    ex.plannerFailures = (ex.plannerFailures || 0) + 1;
    await ctx.log(`⚠️ The crawl's navigator (${s.explorerModel}) failed on this page: ${e.message}. Carrying on with the page's own links${ex.plannerFailures >= 2 ? " — if this keeps happening, check the Navigator model in Settings" : ""}.`);
    // Name the screen by its URL shape, not its title: many sites use one title for every page,
    // which made every later page look like a duplicate and stopped the crawl early.
    const shape = pattern(snap.url).replace(ctx.state.siteUrl, "") || "/";
    return {
      pageName: snap.title || shape,
      screenType: `screen at ${shape}`,
      sameAs: null,
      controls: [],
      typeInputs: [],
      avoidPaths: [],
      links: snap.elements.filter((e) => e.href?.startsWith("/")).map((e) => ({ path: e.href, type: "" })).slice(0, Math.max(5, Math.min(remaining, 12))),
    };
  }
}

// ------------------------------------------------------------------ open questions

// While crawling, note what isn't clear about HOW to build each screen in Scram. The notes are
// saved on the run and asked as questions in the Q&A step, after the crawl and before the build.
const UNSURE_SYSTEM = `You help plan a clone of a website that will be built in Scram (a no-code app builder whose AI builds pages, a database, workflows and logins). You get the spec of ONE screen of the site, the clone's core scope, and Scram's platform limits.

List what you are genuinely NOT SURE how to implement in Scram for this screen — decisions only the human can make, that change how it's built. Good examples: a feature that needs something Scram can't do (live updates, charts, maps, fuzzy search, scheduled jobs…) — which simpler version they want; two reasonable data designs; who may see or edit something; how uploads should work; what to do with a payment, third-party or AI feature; behaviour the crawl couldn't see (behind a login, a destructive button not clicked).
Don't list things that are obvious, trivial, already decided by the instructions/scope, or outside the core scope. Usually 0–2, at most 3. An empty list is fine.

Return ONLY JSON: {"unsure":[{"question":"<one line, asked to the human>","why":"<one line: what you saw on this screen that makes it unclear>"}]}`;

async function noteOpenQuestions(ctx, pageName, url, spec) {
  if (ctx.settings.askQuestions === false || !spec?.content) return;
  const ex = ctx.state.explore;
  const known = ex.unsure || [];
  if (known.length >= 30) return;
  try {
    const limits = await scramLimitations();
    const instr = store.runInstructions(ctx.state);
    const userContent = `${instr ? `The human's instructions and scope:\n${instr}\n\n` : ""}${limits ? `Scram's platform limits:\n${limits}\n\n` : ""}${known.length ? `Already noted (don't repeat):\n${known.map((u) => `- ${u.question}`).join("\n")}\n\n` : ""}Screen: ${pageName} (${url})\n\nSpec:\n${spec.content.slice(0, 14000)}`;
    const res = await askJson({ what: "Open questions", system: UNSURE_SYSTEM, userContent, maxTokens: 1200, model: ctx.settings.explorerModel });
    const fresh = [];
    for (const u of (Array.isArray(res.unsure) ? res.unsure : []).slice(0, 3)) {
      const question = String(u?.question || "").trim().slice(0, 300);
      if (!question || [...known, ...fresh].some((k) => store.similarity(k.question, question) >= 0.6)) continue;
      fresh.push({ question, why: String(u?.why || "").trim().slice(0, 300), page: pageName, url });
    }
    if (!fresh.length) return;
    ex.unsure = [...known, ...fresh].slice(0, 30);
    await ctx.save({ explore: ex });
    for (const u of fresh) await ctx.log(`🤔 Not sure how to build this yet — saved for the Q&A: ${u.question}`);
  } catch {
    /* optional: a failed note never stops the crawl */
  }
}

// ------------------------------------------------------------------ interactions

function newLines(before, after, limit = 25) {
  const seen = new Set(before.split("\n").map((l) => l.trim()));
  const out = [];
  for (const l of after.split("\n")) {
    const t = l.trim();
    if (t && !seen.has(t)) {
      out.push(t.slice(0, 160));
      seen.add(t);
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function restore(ctx, tabId, pageUrl, beforeLayers) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url.split("#")[0] !== pageUrl.split("#")[0]) {
    await navigate(tabId, pageUrl, ctx.settings.actionDelayMs);
    return;
  }
  const sig = await dom(tabId, "signature").catch(() => null);
  if (sig && sig.layers > beforeLayers) {
    await dom(tabId, "pressKey", "Escape");
    await sleep(500);
    const sig2 = await dom(tabId, "signature").catch(() => null);
    if (sig2 && sig2.layers > beforeLayers) await navigate(tabId, pageUrl, ctx.settings.actionDelayMs);
  }
}

const reqLines = (rec, mark, origin, label, limit = 10) => {
  if (!rec) return [];
  const reqs = rec.since(mark);
  return [`  - ${label}: ${reqs.length ? `\n${summarizeNetwork(reqs, origin, limit).replace(/^/gm, "    ")}` : "none"}`];
};

async function tryControl(ctx, tabId, pageUrl, el, rec) {
  const origin = new URL(pageUrl).origin;
  const before = await dom(tabId, "signature");
  const beforeText = (await dom(tabId, "bodyText")) || "";
  const target = { id: el.id, label: el.label, role: el.role };
  const mark = rec?.mark();

  const res = await dom(tabId, "click", target);
  if (!res?.ok) return { md: `- **${el.label}** (${el.role || el.tag}): not clickable any more — skipped.` };

  await sleep(ctx.settings.actionDelayMs);
  if (rec) await rec.settle();
  let tab = await chrome.tabs.get(tabId);
  if (tab.status === "loading") {
    await waitForLoad(tabId);
    await sleep(ctx.settings.actionDelayMs);
    tab = await chrome.tabs.get(tabId);
  }

  const lines = [`- **${el.label}** (${el.role || el.tag}${el.haspopup ? `, haspopup=${el.haspopup}` : ""}${el.selected ? ", was selected" : ""}):`];
  let discovered = null;
  if (tab.url.split("#")[0] !== pageUrl.split("#")[0]) {
    lines.push(`  - Result: navigated to ${tab.url.replace(origin, "")} ("${tab.title}")${pattern(tab.url) === pattern(pageUrl) ? " — same screen template (URL state change)" : ""}.`);
    discovered = tab.url;
    lines.push(...reqLines(rec, mark, origin, "Requests fired"));
  } else {
    const after = await dom(tabId, "snapshot", { maxElements: 150, maxText: 0 }).catch(() => null);
    const afterText = (await dom(tabId, "bodyText").catch(() => "")) || "";
    if (after?.layers?.length > before.layers) {
      for (const l of after.layers.slice(0, 3)) lines.push(`  - Opened ${l.role}${l.label ? ` "${l.label}"` : ""}: ${l.text.slice(0, 700)}`);
      const layerControls = after.elements.filter((e) => e.inLayer && e.label).map((e) => `${e.label}${e.role ? ` [${e.role}]` : ""}`);
      if (layerControls.length) lines.push(`  - Controls inside it (not clicked): ${[...new Set(layerControls)].slice(0, 30).join(", ")}`);
    }
    const now = await dom(tabId, "describeTarget", target).catch(() => null);
    if (now) {
      const diffs = [];
      if (now.label !== el.label) diffs.push(`label "${el.label}" → "${now.label}"`);
      if (now.pressed !== el.pressed) diffs.push(`pressed/checked ${el.pressed ?? "false"} → ${now.pressed ?? "false"}`);
      if (now.selected !== el.selected) diffs.push(`selected ${!!el.selected} → ${!!now.selected}`);
      if (now.expanded !== el.expanded) diffs.push(`expanded ${el.expanded ?? "-"} → ${now.expanded ?? "-"}`);
      if (diffs.length) lines.push(`  - The control itself changed: ${diffs.join(", ")}.`);
    }
    const added = newLines(beforeText, afterText);
    if (added.length) lines.push(`  - New text on screen: ${added.join(" / ").slice(0, 900)}`);
    const beforeLabels = new Set(before.labels);
    const newControls = (after?.elements || []).filter((e) => e.label && !beforeLabels.has(e.label) && !e.inLayer).map((e) => e.label);
    if (newControls.length) lines.push(`  - New controls appeared: ${[...new Set(newControls)].slice(0, 20).join(", ")}`);
    if (lines.length === 1) lines.push("  - Result: no visible change detected.");
    lines.push(...reqLines(rec, mark, origin, "Requests fired"));

    // Undo toggles (like → unlike, follow → unfollow, switches, checkboxes…) so the account ends up as it started.
    const toggled = now && (now.label !== el.label || now.pressed !== el.pressed);
    const isToggle = TOGGLE_LABEL.test(el.label) || el.pressed !== undefined || /switch|checkbox|menuitemcheckbox/.test(el.role || "") || /checkbox/.test(el.type || "");
    if (MODE === "full" && toggled && isToggle && !(after?.layers?.length > before.layers)) {
      const undoMark = rec?.mark();
      await dom(tabId, "click", { id: el.id, label: now.label, role: el.role });
      await sleep(ctx.settings.actionDelayMs);
      if (rec) await rec.settle();
      const back = await dom(tabId, "describeTarget", { id: el.id, label: el.label, role: el.role }).catch(() => null);
      const undone = back && back.label === el.label && back.pressed === el.pressed;
      lines.push(`  - Undo (clicked again): ${undone ? "restored to original state" : "could NOT confirm it was restored"}.`);
      lines.push(...reqLines(rec, undoMark, origin, "Undo requests", 6));
    }
  }
  await restore(ctx, tabId, pageUrl, before.layers);
  return { md: lines.join("\n"), discovered };
}

async function tryTyping(ctx, tabId, pageUrl, el, rec) {
  const origin = new URL(pageUrl).origin;
  const search = isSearch(el);
  const text = search ? ctx.settings.searchQuery || "test" : "Testing this field (exploration test, not sent)";
  const target = { id: el.id, label: el.label, role: el.role };
  const beforeText = (await dom(tabId, "bodyText")) || "";
  const before = await dom(tabId, "snapshot", { maxElements: 150, maxText: 0 });
  const mark = rec?.mark();
  await dom(tabId, "click", target);
  await sleep(400);
  const typed = await dom(tabId, "typeText", target, text);
  if (!typed?.ok) return { md: `- **Text box "${el.label}"**: could not type into it.` };
  await sleep(ctx.settings.actionDelayMs + 800);
  if (rec) await rec.settle();
  const after = await dom(tabId, "snapshot", { maxElements: 150, maxText: 0 }).catch(() => null);
  const afterText = (await dom(tabId, "bodyText").catch(() => "")) || "";
  const lines = [`- **${search ? "Search box" : "Text box"} "${el.label}"** — typed "${text}" (never submitted):`];
  for (const l of (after?.layers || []).slice(0, 2)) lines.push(`  - ${search ? "Suggestions" : "Popup"} ${l.role}: ${l.text.slice(0, 600)}`);
  const added = newLines(beforeText, afterText);
  if (added.length) lines.push(`  - New text (counters, hints, validation): ${added.join(" / ").slice(0, 700)}`);
  const wasDisabled = new Map((before?.elements || []).map((e) => [e.label, !!e.disabled]));
  const enabled = (after?.elements || []).filter((e) => e.label && wasDisabled.get(e.label) === true && !e.disabled).map((e) => e.label);
  if (enabled.length) lines.push(`  - Became enabled after typing: ${[...new Set(enabled)].join(", ")}`);
  lines.push(...reqLines(rec, mark, origin, "Requests while typing", 8));
  await dom(tabId, "typeText", target, "").catch(() => {});
  await sleep(300);
  await dom(tabId, "pressKey", "Escape").catch(() => {});
  await sleep(300);
  await restore(ctx, tabId, pageUrl, before?.layers?.length || 0);
  return { md: lines.join("\n") };
}

// ------------------------------------------------------------------ main step

// Areas the user asked to skip, as URL fragments the planner derived from their instructions.
function isAvoided(ctx, url) {
  const avoid = ctx.state.explore.avoid || [];
  let path;
  try {
    const u = new URL(url);
    path = (u.pathname + u.search).toLowerCase();
  } catch {
    return false;
  }
  return avoid.some((frag) => path.includes(frag.toLowerCase()));
}

const typeKey = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9›>]+/g, " ").trim();

function typeExploredOrQueued(ex, type) {
  const k = typeKey(type);
  if (!k) return false;
  return (ex.types || []).some((t) => typeKey(t.type) === k) || Object.values(ex.queueTypes || {}).some((t) => typeKey(t) === k);
}

// Queue a URL unless it's blocked, already seen, or another instance of a screen type we
// already explored/queued (e.g. a second user's profile). `type` comes from the planner;
// URLs found by clicking have none — those are checked again once loaded (see explorePage).
function enqueue(ctx, url, type = "") {
  const ex = ctx.state.explore;
  const no = (why) => {
    ex.rejects ||= {};
    ex.rejects[why] = (ex.rejects[why] || 0) + 1;
    return false;
  };
  if (!sameOrigin(url, ctx.state.siteUrl)) return no("another site");
  if (HARD_BLOCK_URL.test(url) || (MODE === "safe" && SAFE_MODE_URL.test(url))) return no("unsafe (logout, delete, payment…)");
  if (PRODUCT_FOCUS && isBusinessUrl(url)) return no("business/legal/help page");
  if (isAvoided(ctx, url)) return no("skipped feature / your instructions");
  const p = pattern(url);
  if (ex.visited.includes(p) || ex.queued.includes(p)) return no("already seen");
  if (typeExploredOrQueued(ex, type)) return no("same kind of screen as one already explored");
  if (ex.pages.length + ex.queue.length >= ctx.settings.maxPages) return no("screen budget full");
  ex.queue.push(url);
  ex.queued.push(p);
  ex.queueTypes ||= {};
  ex.queueTypes[url] = type;
  return true;
}

// Resume after the human logged in: crawl from wherever the exploration tab is now (often an app
// subdomain such as yourname.monday.com), re-deciding the core features from the real app.
async function resumeAfterLogin(ctx) {
  const ex = ctx.state.explore;
  const tabId = await ensureTab(ctx);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const here = tab?.url || "";
  const was = ex.awaitingLogin?.url || ctx.state.siteUrl;
  ex.awaitingLogin = null;
  ex.loginChecked = true; // Resume means "go ahead from here" — don't ask again
  if (/^https?:/.test(here) && sameSite(here, ctx.state.siteUrl)) {
    const o = new URL(here).origin;
    if (o !== ctx.state.siteUrl && !(ex.appOrigins || []).includes(o)) (ex.appOrigins ||= []).push(o);
    APP_ORIGINS = ex.appOrigins || [];
    ex.queue = [here, ...ex.queue.filter((q) => q !== here)];
    ex.visited = ex.visited.filter((v) => v !== pattern(here));
    ex.types = [];
    ctx.state.scope = null;
    await ctx.save({ explore: ex, scope: null });
    await ctx.log(`Carrying on from ${here}${o !== ctx.state.siteUrl ? ` (the app lives on ${new URL(here).hostname}, so I'll crawl there too)` : ""}.`);
  } else {
    ex.queue = [was, ...ex.queue.filter((q) => q !== was)];
    await ctx.save({ explore: ex });
    await ctx.log(`The exploration tab isn't on ${new URL(ctx.state.siteUrl).hostname} (it's on ${here || "nothing"}), so I'll check ${was} again.`);
  }
}

// Single-page apps navigate with buttons, not links (monday's left rail, its sidebar's boards
// and dashboards, "Favorites", "More"…): click each navigation control once (never anything
// that changes data) and queue the screens they open, plus the links in menus they open.
// No Claude calls. Labels already tried on earlier pages are skipped (sidebars repeat).
const NAV_PER_PAGE = 14;
async function discoverNav(ctx, tabId, pageUrl) {
  const ex = ctx.state.explore;
  ex.navTried ||= [];
  const snap = await dom(tabId, "snapshot", { maxElements: 300, maxText: 0, pointer: true }).catch(() => null);
  if (!snap) return [];
  const cands = snap.elements
    .filter((e) => e.nav && !e.href && !e.editable && !e.inLayer && e.label && e.label.length <= 40 && !isBlocked(e) && !HARD_BLOCK_LABEL.test(e.label))
    .filter((e) => !ex.navTried.includes(e.label.toLowerCase()))
    .slice(0, NAV_PER_PAGE);
  const found = [];
  for (const e of cands) {
    if (ex.pages.length + ex.queue.length >= ctx.settings.maxPages) break;
    ctx.checkStop();
    const before = await dom(tabId, "signature").catch(() => null);
    try {
      const clicked = await dom(tabId, "click", { id: e.id, label: e.label, role: e.role });
      if (!clicked?.ok) continue; // not found on this render: try it again on a later page
      ex.navTried.push(e.label.toLowerCase());
      await sleep(Math.max(1000, ctx.settings.actionDelayMs));
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "loading") await waitForLoad(tabId);
      if (tab.url.split("#")[0] !== pageUrl.split("#")[0]) {
        if (enqueue(ctx, tab.url, "")) found.push(`${e.label} → ${tab.url.replace(ctx.state.siteUrl, "")}`);
      } else {
        // It opened a menu or panel (e.g. "More"): queue the screens its links lead to.
        const after = await dom(tabId, "snapshot", { maxElements: 200, maxText: 0 }).catch(() => null);
        for (const l of (after?.elements || []).filter((x) => x.inLayer && x.href && !isBlocked(x))) {
          try {
            if (enqueue(ctx, new URL(l.href, pageUrl).href, "")) found.push(`${e.label} › ${l.label} → ${l.href}`);
          } catch {
            /* bad url */
          }
        }
      }
    } catch {
      /* try the next one */
    }
    await restore(ctx, tabId, pageUrl, before?.layers || 0).catch(() => navigate(tabId, pageUrl, ctx.settings.actionDelayMs));
  }
  return found;
}

function buttonManifest(plan, clickedMd, byId) {
  if (!plan.buttons?.length) return "";
  const firstLine = (md) => String(md || "").split("\n").slice(0, 3).join(" ").replace(/^-\s*/, "").replace(/\s+/g, " ").slice(0, 300);
  const rows = plan.buttons.map((b) => {
    const el = byId.get(b.id);
    const label = b.label || el?.label || b.id;
    const blocked = el ? isBlocked(el) : null;
    const status = clickedMd[b.id] ? `CLICKED — observed: ${firstLine(clickedMd[b.id])}` : b.worth === "skip" ? "not clicked (not worth building)" : blocked ? `not clicked (${blocked}) — inferred` : "not clicked (click budget used) — inferred";
    return `| ${label.replace(/\|/g, "/")}${b.repeats > 1 ? ` (×${b.repeats})` : ""} | ${b.does.replace(/\|/g, "/") || "?"} | ${b.worth === "build" ? "BUILD" : "SKIP"} — ${b.why.replace(/\|/g, "/")} | ${status.replace(/\|/g, "/")} |`;
  });
  return `### Button manifest (every button on this screen)\n| Button | What it does | Worth building? | Clicked? |\n|---|---|---|---|\n${rows.join("\n")}\n\n### What each click did\n`;
}

// The queue ran dry before the screen budget was used (the planner returned few links, or most
// were the same kind of screen): collect the unseen links from pages already explored and queue
// them without the "same kind of screen" filter — each is checked again once it's loaded.
const MAX_REFILLS = 3;
async function refillQueue(ctx) {
  const ex = ctx.state.explore;
  if ((ex.refills || 0) >= MAX_REFILLS) return;
  ex.refills = (ex.refills || 0) + 1;
  const tabId = await ensureTab(ctx);
  const sources = [ctx.state.startUrl || ctx.state.siteUrl, ...ex.pages.map((p) => p.url)].filter((u, i, a) => u && a.indexOf(u) === i);
  const room = ctx.settings.maxPages - ex.pages.length;
  let added = 0;
  for (const src of sources.slice(0, 4)) {
    if (added >= room) break;
    ctx.checkStop();
    try {
      await navigate(tabId, src, Math.max(1500, ctx.settings.actionDelayMs));
      const snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 0 });
      for (const e of snap.elements) {
        if (added >= room) break;
        if (!e.href || /^[a-z][a-z0-9+.-]*:/i.test(e.href) || isBlocked(e)) continue;
        if (enqueue(ctx, new URL(e.href, src).href, "")) added++;
      }
    } catch {
      /* try the next page */
    }
  }
  await ctx.save({ explore: ex });
  await ctx.log(added ? `The crawl ran out of screens after ${ex.pages.length} — found ${added} more unexplored link(s) on the pages already seen; carrying on.` : `The crawl ran out of screens after ${ex.pages.length}, and the pages already seen have no unexplored links left.`);
}

// Explore one queued screen. Returns false when there is nothing left to explore.
export async function explorePage(ctx) {
  const ex = ctx.state.explore;
  const s = ctx.settings;
  MODE = s.explorationMode === "safe" ? "safe" : "full";
  PRODUCT_FOCUS = s.productFocus !== false;
  APP_ORIGINS = ex.appOrigins || [];
  if (ex.awaitingLogin) await resumeAfterLogin(ctx);
  if (!ex.queue.length && ex.pages.length > 0 && ex.pages.length < s.maxPages) await refillQueue(ctx);
  if (!ex.queue.length || ex.pages.length >= s.maxPages) {
    if (ex.pages.length < s.maxPages && ex.rejects && Object.keys(ex.rejects).length) {
      await ctx.log(`Crawl finished with ${ex.pages.length} screen(s). Links not followed: ${Object.entries(ex.rejects).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    }
    return false;
  }

  const url = ex.queue.shift();
  if (ex.queueTypes) delete ex.queueTypes[url];
  const p = pattern(url);
  if (ex.visited.includes(p) || (ex.pages.length > 0 && isAvoided(ctx, url))) {
    await ctx.save({ explore: ex });
    return true;
  }
  ex.visited.push(p);
  ex.current = url;
  await ctx.save({ explore: ex });
  await ctx.log(`Exploring ${url} (${ex.pages.length + 1}/${s.maxPages})…`);

  const tabId = await ensureTab(ctx);
  const rec = await ensureRecorder(ctx, tabId);
  const origin = ctx.state.siteUrl;

  const loadMark = rec?.mark();
  await navigate(tabId, url, Math.max(2000, s.actionDelayMs));
  ctx.checkStop();

  const tab = await chrome.tabs.get(tabId);
  // Logged-in users are often sent from the public site to the app on a subdomain
  // (e.g. monday.com → yourname.monday.com): follow it on the first screen.
  if (!sameOrigin(tab.url, origin) && ex.pages.length === 0 && /^https?:/.test(tab.url) && sameSite(tab.url, origin) && !HARD_BLOCK_URL.test(tab.url)) {
    (ex.appOrigins ||= []).push(new URL(tab.url).origin);
    APP_ORIGINS = ex.appOrigins;
    await ctx.save({ explore: ex });
    await ctx.log(`${new URL(origin).hostname} sent me to the app at ${new URL(tab.url).hostname} — crawling there.`);
  }
  if (!sameOrigin(tab.url, origin)) {
    ex.skipped.push(`${url} → redirected off-site to ${tab.url}`);
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url}: it redirected to another site.`);
    return true;
  }
  let snap = await dom(tabId, "snapshot", { maxElements: 300, maxText: 3000, pointer: true });
  if (isErrorPage(snap)) {
    ex.skipped.push(`${url} → page not found (404)`);
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url.replace(origin, "")}: that page doesn't exist (404) — not counted.`);
    return true;
  }
  if (snap.hasPassword && ex.pages.length > 0) {
    ex.skipped.push(`${url} → login wall`);
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url}: it shows a login form.`);
    return true;
  }

  // First page: ask Claude what the product's core features are, so the crawl (and later the
  // specs and build steps) cover only those.
  if (!ctx.state.scope && s.coreFeaturesOnly !== false) {
    await ctx.log("Working out the site's core features before crawling…");
    try {
      const scope = await decideScope(ctx, snap);
      ctx.state.scope = scope;
      ex.avoid = [...new Set([...(ex.avoid || []), ...scope.avoidPaths])];
      ex.queue = ex.queue.filter((q) => !isAvoided(ctx, q));
      await ctx.save({ scope, explore: ex });
      await ctx.log(`🎯 ${scope.product ? `${scope.product} — ` : ""}cloning only the core: ${scope.core.map((f) => f.name).join(", ") || "(none found)"}.`);
      if (scope.skip.length) await ctx.log(`Skipping: ${scope.skip.map((f) => f.name).join(", ")}.`);
    } catch (e) {
      ctx.state.scope = { product: "", core: [], skip: [], avoidPaths: [], failed: e.message };
      await ctx.log(`Couldn't work out the core features (${e.message}) — crawling normally.`);
    }
  }

  // Decide what this screen IS before spending anything on it.
  ctx.checkStop();
  const plan = await planPage(ctx, snap);
  // First screen: make sure we're logged in and in the product, not on its public website.
  if (ex.pages.length === 0 && !ex.loginChecked) {
    const site = new URL(origin).hostname;
    const app = plan.appUrl && sameSite(plan.appUrl, origin) && !HARD_BLOCK_URL.test(plan.appUrl) ? plan.appUrl : "";
    if (plan.landing && app && plan.loggedIn !== "no") {
      // The page links straight into the app (e.g. "Go to my workspace"): crawl there instead.
      const appOrigin = new URL(app).origin;
      if (appOrigin !== origin && !APP_ORIGINS.includes(appOrigin)) (ex.appOrigins ||= []).push(appOrigin);
      APP_ORIGINS = ex.appOrigins || [];
      ex.loginChecked = true;
      ex.queue.unshift(app);
      ctx.state.scope = null; // decide the core features from the real app, not the marketing page
      await ctx.save({ explore: ex, scope: null });
      await ctx.log(`This is ${site}'s public website, not the app — it links to the app at ${app}, so I'm crawling that instead.`);
      return true;
    }
    if (plan.loggedIn === "no" || plan.landing) {
      ex.awaitingLogin = { url, at: Date.now() };
      ex.visited = ex.visited.filter((v) => v !== pattern(url));
      await ctx.save({ explore: ex });
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      throw new PauseError(`I'm not logged in to ${site} — this is its public website, not the app${plan.loggedIn === "no" ? " (it shows Log in / Sign up)" : ""}. In the exploration tab, log in (or sign up), open the app's main screen (for example your workspace or boards), then press Resume. I'll crawl the app from there. (If this site doesn't need a login, just press Resume.)`);
    }
    ex.loginChecked = true;
  }
  const queueLinks = () => {
    for (const link of plan.links) {
      try {
        enqueue(ctx, new URL(link.path, url).href, link.type);
      } catch {
        /* bad url */
      }
    }
  };
  ex.types ||= [];
  const known = ex.types.find((t) => typeKey(t.type) === typeKey(plan.sameAs) || typeKey(t.type) === typeKey(plan.screenType));
  if (known && ex.pages.length > 0) {
    // Another instance of a screen type we've already documented (e.g. a different user's profile).
    ex.skipped.push(`${url} → another “${known.type}” (already explored at ${known.url})`);
    queueLinks(); // it may still link to screen types we haven't seen
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url.replace(origin, "")}: just another “${known.type}”, already explored — not counted.`);
    return true;
  }
  ex.types.push({ type: plan.screenType, url });

  // Scroll to trigger lazy loading / pagination, then back to the top.
  await dom(tabId, "scroll", 2);
  await sleep(s.actionDelayMs);
  await dom(tabId, "scroll", 2);
  await sleep(s.actionDelayMs);
  if (rec) await rec.settle();
  await dom(tabId, "scroll", "top");
  await sleep(600);
  const loadNetwork = rec ? summarizeNetwork(rec.since(loadMark), origin, 40) : "- (network recording off)";

  const page = await dom(tabId, "extract");
  const shot = s.screenshots ? await screenshot(tabId).catch(() => null) : null;
  // Element ids from the first snapshot stay valid (data-sab-id); refresh for anything lazy-loaded.
  snap = await dom(tabId, "snapshot", { maxElements: 300, maxText: 3000, pointer: true });

  ex.avoid ||= [];
  const newAvoid = plan.avoidPaths.filter((a) => !ex.avoid.includes(a));
  if (newAvoid.length) {
    ex.avoid.push(...newAvoid);
    ex.queue = ex.queue.filter((q) => !isAvoided(ctx, q));
    await ctx.log(`Following your instructions: never visiting URLs containing ${newAvoid.map((a) => `“${a}”`).join(", ")}.`);
  }
  await ctx.log(`“${plan.pageName}” — new screen type “${plan.screenType}”: trying ${Math.min(plan.controls.length, s.maxInteractionsPerPage)} control(s)…`);

  const interactions = [];
  const clickedMd = {}; // element id → what clicking it did
  const byId = new Map(snap.elements.map((e) => [e.id, e]));
  let tried = 0;
  for (const id of plan.controls) {
    if (tried >= s.maxInteractionsPerPage) break;
    ctx.checkStop();
    const el = byId.get(id);
    if (!el) continue;
    const blocked = isBlocked(el) || (el.href && isAvoided(ctx, new URL(el.href, url).href) ? "excluded by your instructions" : null);
    if (blocked) {
      interactions.push(`- **${el.label || id}**: not clicked (${blocked}).`);
      continue;
    }
    tried++;
    try {
      const r = await tryControl(ctx, tabId, url, el, rec);
      clickedMd[id] = r.md;
      interactions.push(r.md);
      if (r.discovered) enqueue(ctx, r.discovered);
    } catch (e) {
      interactions.push(`- **${el.label}**: error while testing (${e.message}).`);
      await navigate(tabId, url, s.actionDelayMs).catch(() => {});
    }
  }
  for (const id of plan.typeInputs.slice(0, 2)) {
    const el = byId.get(id);
    if (!el || !isTypeable(el)) continue;
    ctx.checkStop();
    try {
      interactions.push((await tryTyping(ctx, tabId, url, el, rec)).md);
    } catch (e) {
      interactions.push(`- Text box "${el.label}": error (${e.message}).`);
      await navigate(tabId, url, s.actionDelayMs).catch(() => {});
    }
  }

  const before = ex.queue.length;
  queueLinks();
  if (ex.pages.length + ex.queue.length < s.maxPages) {
    const nav = await discoverNav(ctx, tabId, url).catch(() => []);
    if (nav.length) await ctx.log(`🧭 Found ${nav.length} more screen(s) behind the app's navigation buttons: ${nav.slice(0, 6).join("; ")}${nav.length > 6 ? "; …" : ""}.`);
  }
  await ctx.save({ explore: ex });
  if (!plan.links.length) await ctx.log(`The navigator chose no links to follow from “${plan.pageName}”.`);
  else if (ex.queue.length === before) await ctx.log(`None of the ${plan.links.length} link(s) chosen on “${plan.pageName}” were new.`);

  // The button manifest: every button on this screen, what it does (observed when clicked,
  // otherwise inferred), and whether it's worth building — goes into this screen's spec.
  const manifest = buttonManifest(plan, clickedMd, byId);
  if (plan.buttons?.length) {
    const b = plan.buttons.filter((x) => x.worth === "build").length;
    await ctx.log(`🔘 “${plan.pageName}”: ${plan.buttons.length} button(s) assessed — ${b} worth building, ${plan.buttons.length - b} not; clicked ${Object.keys(clickedMd).length}.`);
  }

  ctx.checkStop();
  await ctx.log(`Writing the spec for “${plan.pageName}”…`);
  const spec = await generateSpec({
    siteUrl: origin,
    page,
    explored: {
      mode: MODE,
      instructions: store.runInstructions(ctx.state),
      screenshot: shot,
      network: loadNetwork,
      interactions: `${manifest}${interactions.join("\n") || "- (no interactions available)"}`,
    },
  });
  await noteOpenQuestions(ctx, plan.pageName, url, spec);
  ex.pages.push({ url, name: plan.pageName, type: plan.screenType, specId: spec.id });
  ex.current = null;
  await ctx.save({ explore: ex });
  await ctx.log(`Spec saved for “${plan.pageName}”. ${ex.queue.length} screen(s) queued.`);
  return true;
}

// Exposed for tests.
export const _internal = {
  isBlocked,
  isTypeable,
  pattern,
  setMode: (m) => (MODE = m),
};
