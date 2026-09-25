// Autopilot phase 1: crawl the site in a dedicated tab. On each screen it records
// the network trace while loading/scrolling, asks Claude which controls to try,
// clicks them one by one noting what changes and which requests fire (undoing
// toggles afterwards), types into text boxes without submitting, then writes the
// Screen Spec and queues further same-site screens.

import { dom, navigate, screenshot, sleep, waitForLoad } from "./dom.js";
import { NetworkRecorder, summarizeNetwork } from "./network.js";
import { askJson, generateSpec } from "./jobs.js";

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
    if (/^[a-z][a-z0-9+.-]*:/i.test(el.href)) return "link to another site";
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
    return new URL(url).origin === siteUrl;
  } catch {
    return false;
  }
};

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

const PLANNER_COMMON = `Prefer variety: choose controls most likely to reveal NEW UI or behaviour. If many identical controls repeat (e.g. the same "More" or "Like" button on every feed item), choose only one of them.

SCREEN TYPES — think in types, not URLs. A screen type is a kind of screen defined by its layout and functionality, not by whose data it shows: every user's profile is the same type ("user profile"), every post's page is the same type ("post detail"), every conversation is the same type ("DM conversation"). testuser1's profile and testuser2's profile are the SAME type; post 123 and post 456 are the SAME type. Only treat something as a new type if its layout or available actions genuinely differ (e.g. your OWN profile with "Edit profile" vs someone else's with "Follow" may be separate types; a settings sub-page with different controls is a new type). Reuse the exact type names from "Screen types already explored/queued" whenever a screen is another instance of one.
- "screenType": the type of the CURRENT page.
- "sameAs": if the current page is just another instance of a type already EXPLORED, that type's exact name; otherwise null.

Links: choose same-origin links whose screen TYPE has not been explored or queued yet — at most one link per type. Label each with its type. Prefer primary navigation, sidebars, tabs and settings sections. Skip log out, delete, billing/checkout/payment, external sites, and legal/cookie/help boilerplate unless the site is tiny.
{{PRODUCT_FOCUS}}

Elements marked BLOCKED will not be clicked whatever you choose — don't pick them.

If the user gave instructions, they override everything above: never choose controls or links for areas the user said to ignore or avoid, and prioritise areas they said to focus on. Put URL path fragments for the areas to avoid (e.g. "/i/grok", "/premium") in "avoidPaths" — the crawler will then never visit any URL containing them.

Return ONLY a JSON object: {"pageName": "<short screen name>", "screenType": "<type of this page>", "sameAs": "<already-explored type name>" | null, "controls": ["<element id>", ...], "typeInputs": ["<element id>", ...], "links": [{"path": "<same-origin path>", "type": "<screen type>"}, ...], "avoidPaths": ["<path fragment>", ...]}`;

const PLANNER_FULL = `You plan one step of an exploration of a website by an automated crawler that documents the site's UI and behaviour so it can be rebuilt faithfully. The crawler is logged into the user's own account and the user has allowed full interaction: it may click likes, follows, bookmarks, reactions, reposts, toggles and settings switches, tabs, menus, dropdowns, modals, and buttons that open composers/editors ("new post", "compose", "create…"), to observe what really happens and which requests fire. Toggles are clicked again afterwards to undo them.

It must still never be asked to: log out / switch account, delete / deactivate the account or delete content, spend money (buy, pay, upgrade, subscribe, premium, donate), or send content to other people (post, reply, send, publish, submit, share to, invite, report, message). Those are hard-blocked.

"controls" = the controls to click, in priority order.
"typeInputs" = text boxes worth typing a short test string into to observe behaviour (search suggestions, character counters, validation, send/post buttons enabling). The crawler types, observes, then clears — it NEVER submits or presses Enter.

` + PLANNER_COMMON;

const PRODUCT_FOCUS_NOTE = `
PRODUCT FOCUS: the goal is to clone the PRODUCT — what users actually do in the app — not the company around it. Spend the budget on core product functionality: creating and viewing content (e.g. composing posts, the feed/timeline, post detail with replies/threads, reposts/quotes, likes, media/images/video, polls), profiles and following, messaging/DMs, notifications, search and explore, lists/bookmarks/communities, and the user's own product settings. Never choose links or controls for business/corporate/marketing/legal/help/monetisation areas: about, careers, press, investors, advertising/ads, business or brand tools, help centre/support, developer/API docs, status, blog, privacy/terms/cookies/legal policies, premium/pricing/upgrade upsells, app downloads, or other subdomains (e.g. business.example.com, help.example.com). Add path fragments for any such areas you see to "avoidPaths".`;

const PLANNER_SAFE = `You plan one step of a READ-ONLY exploration of a website by an automated crawler that documents the site's UI and behaviour so it can be rebuilt. The crawler is logged into the user's REAL account: anything that creates, changes or deletes data, or affects the account or other people, must NEVER be clicked.

"controls" = SAFE controls to click: ones that only reveal UI or switch views — menus, "more"/overflow (…) buttons, dropdowns, popovers, tooltips, tabs, accordions/expanders, "show more", view/sort/filter switches, carousels, modals that open without submitting anything, and in-app navigation buttons. Never choose post/reply/send/share, like/react/vote/repost/bookmark/save, follow/subscribe/join/connect/invite, block/mute/report, delete/remove/archive/edit/rename, accept/decline/approve, upload/download, buy/pay/upgrade, log out, setting toggles, form submits, or anything whose effect you are unsure of.
"typeInputs" = search boxes only (typed into, never submitted).

` + PLANNER_COMMON;

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
  const instructions = ctx.state.instructions
    ? `USER INSTRUCTIONS FOR THIS RUN (follow strictly):\n${ctx.state.instructions}\n\n`
    : "";
  const explored = (ex.types || []).map((t) => `"${t.type}" (e.g. ${t.url.replace(ctx.state.siteUrl, "")})`);
  const queuedTypes = Object.values(ex.queueTypes || {}).filter(Boolean).map((t) => `"${t}"`);
  const userContent = `${instructions}Page: ${snap.url}
Title: ${snap.title}
Screen types already explored: ${explored.join(", ") || "(none — this is the first screen)"}
Screen types already queued: ${[...new Set(queuedTypes)].join(", ") || "(none)"}
URLs already visited: ${ex.visited.slice(-30).join(", ") || "(none)"}
Choose at most ${s.maxInteractionsPerPage} controls, at most 2 typeInputs and at most ${Math.min(remaining, 8)} links.

Visible text (start):
${snap.text.slice(0, 2500)}

Interactive elements (id | role | label | extra):
${lines.join("\n")}`;
  try {
    const system = (MODE === "safe" ? PLANNER_SAFE : PLANNER_FULL).replace("{{PRODUCT_FOCUS}}", PRODUCT_FOCUS ? PRODUCT_FOCUS_NOTE : "");
    const plan = await askJson({ system, userContent, maxTokens: 1500, model: s.explorerModel });
    const list = (v) => (Array.isArray(v) ? v.map(String) : []);
    const links = (Array.isArray(plan.links) ? plan.links : [])
      .map((l) => (typeof l === "string" ? { path: l, type: "" } : { path: String(l?.path || l?.url || ""), type: String(l?.type || "") }))
      .filter((l) => l.path);
    return {
      pageName: String(plan.pageName || snap.title || "Screen"),
      screenType: String(plan.screenType || plan.pageName || snap.title || "screen"),
      sameAs: plan.sameAs ? String(plan.sameAs) : null,
      controls: list(plan.controls || plan.safeControls),
      typeInputs: list(plan.typeInputs || plan.searchInputs),
      links,
      avoidPaths: list(plan.avoidPaths).map((p) => p.trim()).filter((p) => p.length >= 2 && p !== "/"),
    };
  } catch (e) {
    await ctx.log(`Planner failed (${e.message}); falling back to navigation links only.`);
    return {
      pageName: snap.title,
      screenType: snap.title || "screen",
      sameAs: null,
      controls: [],
      typeInputs: [],
      avoidPaths: [],
      links: snap.elements.filter((e) => e.href?.startsWith("/")).map((e) => ({ path: e.href, type: "" })).slice(0, 5),
    };
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
  if (!sameOrigin(url, ctx.state.siteUrl) || HARD_BLOCK_URL.test(url) || (MODE === "safe" && SAFE_MODE_URL.test(url))) return false;
  if (PRODUCT_FOCUS && isBusinessUrl(url)) return false;
  if (isAvoided(ctx, url)) return false;
  const p = pattern(url);
  if (ex.visited.includes(p) || ex.queued.includes(p)) return false;
  if (typeExploredOrQueued(ex, type)) return false;
  if (ex.pages.length + ex.queue.length >= ctx.settings.maxPages) return false;
  ex.queue.push(url);
  ex.queued.push(p);
  ex.queueTypes ||= {};
  ex.queueTypes[url] = type;
  return true;
}

// Explore one queued screen. Returns false when there is nothing left to explore.
export async function explorePage(ctx) {
  const ex = ctx.state.explore;
  const s = ctx.settings;
  MODE = s.explorationMode === "safe" ? "safe" : "full";
  PRODUCT_FOCUS = s.productFocus !== false;
  if (!ex.queue.length || ex.pages.length >= s.maxPages) return false;

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
  if (!sameOrigin(tab.url, origin)) {
    ex.skipped.push(`${url} → redirected off-site to ${tab.url}`);
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url}: it redirected to another site.`);
    return true;
  }
  let snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 3000 });
  if (snap.hasPassword && ex.pages.length > 0) {
    ex.skipped.push(`${url} → login wall`);
    await ctx.save({ explore: ex });
    await ctx.log(`Skipped ${url}: it shows a login form.`);
    return true;
  }

  // Decide what this screen IS before spending anything on it.
  ctx.checkStop();
  const plan = await planPage(ctx, snap);
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
  snap = await dom(tabId, "snapshot", { maxElements: 250, maxText: 3000 });

  ex.avoid ||= [];
  const newAvoid = plan.avoidPaths.filter((a) => !ex.avoid.includes(a));
  if (newAvoid.length) {
    ex.avoid.push(...newAvoid);
    ex.queue = ex.queue.filter((q) => !isAvoided(ctx, q));
    await ctx.log(`Following your instructions: never visiting URLs containing ${newAvoid.map((a) => `“${a}”`).join(", ")}.`);
  }
  await ctx.log(`“${plan.pageName}” — new screen type “${plan.screenType}”: trying ${Math.min(plan.controls.length, s.maxInteractionsPerPage)} control(s)…`);

  const interactions = [];
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

  queueLinks();
  await ctx.save({ explore: ex });

  ctx.checkStop();
  await ctx.log(`Writing the spec for “${plan.pageName}”…`);
  const spec = await generateSpec({
    siteUrl: origin,
    page,
    explored: {
      mode: MODE,
      instructions: ctx.state.instructions,
      screenshot: shot,
      network: loadNetwork,
      interactions: interactions.join("\n") || "- (no interactions available)",
    },
  });
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
