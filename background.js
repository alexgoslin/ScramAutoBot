import * as store from "./lib/storage.js";
import { callClaude, extractJson } from "./lib/claude.js";

const SCRAM_URL = "https://dashboard.buildwithscram.com/";
const MAX_PAGE_CHARS = 120000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  // Any job marked "running" from a previous browser session is dead.
  store.set("jobs", {});
});

// ---------------------------------------------------------------------------
// Prompts: Options-page override wins, otherwise the bundled prompts/*.md file.
// ---------------------------------------------------------------------------

async function loadPrompt(name, file) {
  const overrides = await store.get("promptOverrides", {});
  if (overrides[name]?.trim()) return overrides[name];
  const res = await fetch(chrome.runtime.getURL(`prompts/${file}`));
  return res.text();
}

// ---------------------------------------------------------------------------
// Job 1: capture a page and turn it into a spec.
// ---------------------------------------------------------------------------

// Runs inside the target page via chrome.scripting.executeScript.
// Collects what a single-page capture can offer the Screen Spec Extractor:
// visible text, the DOM skeleton with real box sizes, computed design tokens,
// interactive controls, and storage *key names* (never values).
function extractPage() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const take = (sel, map, limit = 80) =>
    Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, limit).map(map).filter(Boolean);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)} @ (${Math.round(r.left + scrollX)}, ${Math.round(r.top + scrollY)})`;
  };
  const toHex = (c) => {
    const m = c && c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null; // fully transparent
    const hex = "#" + [m[1], m[2], m[3]].map((n) => Math.round(+n).toString(16).padStart(2, "0")).join("");
    return m[4] !== undefined && parseFloat(m[4]) < 1 ? `${hex} @ ${parseFloat(m[4])} alpha` : hex;
  };
  const label = (el) => {
    const id = el.id ? `#${el.id}` : "";
    const role = el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : "";
    const aria = el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : "";
    return `${el.tagName.toLowerCase()}${id}${role}${aria}`;
  };

  // Layout skeleton: landmark / large container elements, nested, with sizes and layout mode.
  const LANDMARK = "header,nav,main,aside,footer,section,form,dialog,[role=navigation],[role=main],[role=banner],[role=complementary],[role=dialog],[role=list],[role=feed],[role=tablist],[role=region]";
  const vw = innerWidth, vh = innerHeight;
  const skeleton = [];
  const walk = (el, depth) => {
    if (skeleton.length > 120 || depth > 8) return;
    for (const child of el.children) {
      if (!visible(child)) continue;
      const cs = getComputedStyle(child);
      const r = child.getBoundingClientRect();
      const significant = child.matches(LANDMARK) || ((cs.position === "fixed" || cs.position === "sticky") && r.width * r.height > 2000) ||
        (r.width > vw * 0.15 && r.height > vh * 0.3 && (cs.display.includes("flex") || cs.display.includes("grid") || /auto|scroll/.test(cs.overflowY)));
      if (significant) {
        const bits = [cs.display, cs.position !== "static" ? cs.position : "", /auto|scroll/.test(cs.overflowY) ? "scrolls-y" : "",
          cs.zIndex !== "auto" ? `z=${cs.zIndex}` : "", cs.backgroundColor ? `bg ${toHex(cs.backgroundColor) || "transparent"}` : ""].filter(Boolean);
        skeleton.push(`${"  ".repeat(depth)}- ${label(child)} ${box(child)} [${bits.join(", ")}]`);
        walk(child, depth + 1);
      } else {
        walk(child, depth);
      }
    }
  };
  if (document.body) walk(document.body, 0);

  // Design tokens: frequency of computed colours, fonts, radii, shadows, spacing across visible elements.
  const counts = { text: {}, bg: {}, border: {}, font: {}, radius: {}, shadow: {}, spacing: {} };
  const bump = (bucket, key) => key && (counts[bucket][key] = (counts[bucket][key] || 0) + 1);
  const all = Array.from(document.body ? document.body.querySelectorAll("*") : []).slice(0, 4000);
  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
      bump("text", toHex(cs.color));
      bump("font", `${cs.fontFamily.split(",")[0].replace(/["']/g, "")} ${cs.fontSize}/${cs.lineHeight} w${cs.fontWeight}`);
    }
    bump("bg", toHex(cs.backgroundColor));
    if (parseFloat(cs.borderTopWidth) > 0) bump("border", `${cs.borderTopWidth} ${toHex(cs.borderTopColor)}`);
    if (cs.borderRadius !== "0px") bump("radius", `${cs.borderRadius} (${el.tagName.toLowerCase()})`);
    if (cs.boxShadow !== "none") bump("shadow", cs.boxShadow);
    for (const v of [cs.paddingTop, cs.paddingLeft, cs.marginTop, cs.gap]) if (v && v !== "0px" && v !== "normal" && v !== "auto") bump("spacing", v);
  }
  const top = (bucket, n) => Object.entries(counts[bucket]).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} (×${c})`);

  // Typography by role.
  const roleStyle = (sel) => {
    const el = Array.from(document.querySelectorAll(sel)).find(visible);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return `${sel}: ${cs.fontFamily} | ${cs.fontSize} | w${cs.fontWeight} | lh ${cs.lineHeight} | ${toHex(cs.color)}`;
  };
  const typography = ["h1", "h2", "h3", "p", "a", "button", "input", "small", "label"].map(roleStyle).filter(Boolean);

  // Interactive controls with state hints.
  const controlState = (el) => [el.disabled ? "disabled" : "", el.getAttribute("aria-pressed") === "true" ? "pressed" : "",
    el.getAttribute("aria-selected") === "true" ? "selected" : "", el.getAttribute("aria-expanded") ? `expanded=${el.getAttribute("aria-expanded")}` : "",
    el.getAttribute("aria-current") ? "current" : ""].filter(Boolean).join(",");
  const buttons = take("button,[role=button],input[type=submit],[role=tab],[role=menuitem],[role=switch],[role=checkbox]", (b) => {
    const t = clean(b.innerText || b.value || b.getAttribute("aria-label") || b.title);
    if (!t) return null;
    const st = controlState(b);
    return `${t}${b.getAttribute("role") ? ` [${b.getAttribute("role")}]` : ""}${st ? ` {${st}}` : ""}`;
  }, 150);
  const links = take("a[href]", (a) => {
    const t = clean(a.innerText || a.getAttribute("aria-label"));
    if (!t) return null;
    let href = a.getAttribute("href");
    try { const u = new URL(a.href); href = u.origin === location.origin ? u.pathname + u.search : `${u.origin}${u.pathname} (external)`; } catch {}
    return `${t.slice(0, 80)} -> ${href}${a.getAttribute("aria-current") ? " {current}" : ""}`;
  }, 150);
  const fieldDesc = (i) => {
    const st = [i.required ? "required" : "", i.disabled ? "disabled" : "", i.maxLength > 0 ? `maxlength=${i.maxLength}` : "", i.pattern ? `pattern=${i.pattern}` : ""].filter(Boolean).join(",");
    return `${i.tagName.toLowerCase()}[${i.type || (i.isContentEditable ? "contenteditable" : "")}] ${i.name || i.id || i.placeholder || i.getAttribute("aria-label") || ""}${st ? ` {${st}}` : ""}`.trim();
  };
  const forms = take("form", (f) => `form${f.getAttribute("method") ? ` method=${f.getAttribute("method")}` : ""}${f.getAttribute("action") ? ` action=${f.getAttribute("action")}` : ""}: ${Array.from(f.querySelectorAll("input,select,textarea")).filter((i) => i.type !== "hidden").map(fieldDesc).join(", ")}`, 20);
  const standaloneInputs = take("input:not(form input):not([type=hidden]),textarea:not(form textarea),select:not(form select),[contenteditable=true]", fieldDesc, 40);
  const headings = take("h1,h2,h3,h4", (h) => `${h.tagName}: ${clean(h.innerText).slice(0, 120)}`, 120);
  const images = take("img,svg[role=img],[role=img]", (i) => `${i.tagName.toLowerCase()} ${clean(i.getAttribute("alt") || i.getAttribute("aria-label") || "")} ${box(i)}`.trim(), 40);

  // Storage key names only — values may hold tokens or personal data.
  const keys = (store) => { try { return Object.keys(store).slice(0, 60); } catch { return []; } };
  const cookieNames = document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean).slice(0, 60);
  const scripts = [...new Set(Array.from(document.scripts).map((s) => { try { return new URL(s.src).host; } catch { return null; } }).filter(Boolean))];

  return {
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : "",
    viewport: `${vw}×${vh} (devicePixelRatio ${devicePixelRatio}), page height ${document.documentElement.scrollHeight}px`,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    skeleton,
    tokens: {
      textColors: top("text", 12), backgrounds: top("bg", 12), borders: top("border", 8), fonts: top("font", 14),
      radii: top("radius", 10), shadows: top("shadow", 6), spacing: top("spacing", 14),
    },
    typography,
    structure: { headings, buttons, links, forms, standaloneInputs, images },
    storage: { localStorage: keys(localStorage), sessionStorage: keys(sessionStorage), cookies: cookieNames },
    thirdPartyScriptHosts: scripts.filter((h) => h !== location.host).slice(0, 40),
  };
}

function formatCapture(page) {
  const list = (items) => (items && items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none observed)");
  const section = (name, body) => `### ${name}\n${body}`;
  return [
    section("Viewport at capture", `- ${page.viewport}\n- Browser colour scheme: ${page.colorScheme}`),
    section("Layout skeleton (nested regions: size @ position [display, position, scroll, z-index, background])", page.skeleton.length ? page.skeleton.join("\n") : "- (none detected)"),
    section("Typography by role (computed)", list(page.typography)),
    section("Most-used text colours (computed)", list(page.tokens.textColors)),
    section("Most-used background colours (computed)", list(page.tokens.backgrounds)),
    section("Borders", list(page.tokens.borders)),
    section("Font usage (family size/line-height weight)", list(page.tokens.fonts)),
    section("Border radii", list(page.tokens.radii)),
    section("Shadows", list(page.tokens.shadows)),
    section("Spacing values (padding/margin/gap)", list(page.tokens.spacing)),
    section("Headings", list(page.structure.headings)),
    section("Buttons & controls {state hints}", list([...new Set(page.structure.buttons)])),
    section("Links", list(page.structure.links)),
    section("Forms", list(page.structure.forms)),
    section("Inputs outside forms", list(page.structure.standaloneInputs)),
    section("Images / icons", list(page.structure.images)),
    section("Client storage key names (values deliberately not captured)", `- localStorage: ${page.storage.localStorage.join(", ") || "(none)"}\n- sessionStorage: ${page.storage.sessionStorage.join(", ") || "(none)"}\n- cookies readable by JS: ${page.storage.cookies.join(", ") || "(none)"}`),
    section("Third-party script hosts", list(page.thirdPartyScriptHosts)),
  ].join("\n\n");
}

// Your extractor prompt is written for Claude in Chrome with browsing tools; this
// explains what this single-page capture does and doesn't contain.
const CAPTURE_PREAMBLE = `You are being run from a Chrome extension, not with browsing tools. You cannot navigate, click, resize, screenshot, or open devtools. You have received a single automated capture of ONE screen, containing: URL, title, viewport, a nested layout skeleton with real pixel sizes, computed styles (colours, fonts, radii, shadows, spacing), every visible heading/control/link/form/input with state hints, client-storage key names, third-party script hosts, and the visible text.

How to apply your procedure to this capture:
- Skip Step 0 (autonomous discovery loop) and screenshot capture. Treat this as Step 1 pointed at exactly this one screen, and produce the full Screen Spec Format (all 13 sections) for it. Other pages of the same site are captured separately and merged later, so do not invent screens you cannot see — list same-site links you see as candidate screens in Open Questions instead.
- Values in the capture's computed-style sections count as OBSERVED (computed style), not inferred. Only the one captured breakpoint (the viewport width shown) is observed; describe other breakpoints as inferred.
- There is no network trace. Every Section 9/10 workflow is evidence tier "inferred from static evidence" unless the capture itself proves more (e.g. storage key names, script hosts, form action/method).
- Section 7 Asset Manifest: state that no screenshots were captured by this tool.
- The page may belong to a logged-in account. Replace personal data (names, handles, emails, message bodies, avatars) with realistic placeholders of the same shape; keep structural and UI copy.
- Output ONLY the filled-in markdown Screen Spec, starting with "# Screen Spec:".`;

async function capturePage(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be captured (only http/https pages are supported).");

  const siteUrl = store.siteUrlFor(tab.url);
  const jobKey = `capture:${siteUrl}`;
  const startedAt = Date.now();
  await store.setJob(jobKey, { status: "running", message: `Analysing ${tab.title || tab.url}…`, startedAt });

  try {
    const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPage });
    let text = page.text || "";
    const truncated = text.length > MAX_PAGE_CHARS;
    if (truncated) text = text.slice(0, MAX_PAGE_CHARS);

    const userContent = [
      CAPTURE_PREAMBLE,
      ``,
      `# Captured screen`,
      `URL: ${page.url}`,
      `Title: ${page.title}`,
      `Captured at: ${new Date().toISOString()}`,
      ``,
      `## Automated capture`,
      formatCapture(page),
      ``,
      `## Visible text${truncated ? " (truncated)" : ""}`,
      "```",
      text,
      "```",
    ].join("\n");

    const [apiKey, settings, system] = await Promise.all([
      store.get("apiKey", ""),
      store.getSettings(),
      loadPrompt("specExtractor", "site-screen-spec-extractor.md"),
    ]);

    const { text: content, stopReason } = await callClaude({
      apiKey,
      model: settings.model,
      system,
      userContent,
      maxTokens: settings.specMaxTokens,
      onProgress: (chars) => store.setJob(jobKey, { status: "running", message: `Writing spec for ${page.title || page.url} (${chars.toLocaleString()} chars)…`, startedAt }),
    });

    const spec = {
      id: store.uid(),
      siteUrl,
      pageUrl: page.url,
      pageTitle: page.title || page.url,
      content: stopReason === "max_tokens" ? `${content}\n\n> ⚠️ Output was cut off at the max token limit.` : content,
      capturedAt: new Date().toISOString(),
    };
    await store.addSpecFile(spec);
    await store.setJob(jobKey, null);
    return spec;
  } catch (err) {
    await store.setJob(jobKey, { status: "error", message: err.message, startedAt: Date.now() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Job 2: split all specs for a site into handoff step files.
// ---------------------------------------------------------------------------

// Your splitter prompt expects one merged screen-spec.md and writes files; this
// adapts it to several per-page specs and a JSON response the extension can store.
const HANDOFF_PREAMBLE = `The input below is not one merged screen-spec.md. It is several Screen Specs of the SAME site, one per captured page, each produced by the Site → Screen Spec Extractor from a single-page capture. Before planning steps, merge them as if they were one screen-spec.md: union the Section 1 inventories; deduplicate Section 3 tokens and Section 4 components; merge Sections 9 and 11 into one coherent global architecture and rationale (resolve conflicts, prefer observed over inferred); merge Section 10 workflows (one entry per workflow, even if several pages trigger it); combine Sections 8/12 open questions. Then follow your procedure exactly (build order, Context Block repeated in full in every step file, Step 0 = Setup only, final regression step, templates filled in exactly).`;

const HANDOFF_FORMAT_INSTRUCTIONS = `
OUTPUT FORMAT — the extension parses your reply as JSON, so return a single JSON object and nothing else: no prose before or after, no markdown fences. Exactly this shape:

{
  "manifest": "<the complete step-manifest.md, filled in per your template>",
  "combinedDoc": "",
  "steps": [
    { "stepNumber": 0, "title": "Setup", "content": "<the complete step-00-setup.md>" },
    { "stepNumber": 1, "title": "Auth", "content": "<the complete step-01-....md>" }
  ]
}

Rules:
- "steps" holds every step file in build order, including the final regression step, each "content" being that file's full markdown exactly as your templates specify (Context Block in full, scope, out of scope, testing checklist, completion/gate).
- stepNumber is an integer that starts at 0 and increases by 1 with no gaps. If you split a screen into an arc like "3a/3b/3c", give each its own consecutive integer and keep the arc label in the title (e.g. "Chat view (3b): edit/delete/react").
- Leave "combinedDoc" as an empty string — the extension assembles it from the manifest and steps itself, which saves output length for the step files.
- All string values must be valid JSON strings (escape newlines as \\n and double quotes as \\").`;

async function generateHandoff(siteUrl) {
  const jobKey = `handoff:${siteUrl}`;
  const specs = (await store.get("specFiles", []))
    .filter((s) => s.siteUrl === siteUrl)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  if (!specs.length) throw new Error(`No captured pages for ${siteUrl} yet.`);

  const startedAt = Date.now();
  await store.setJob(jobKey, { status: "running", message: `Splitting ${specs.length} spec file(s) into build steps…`, startedAt });

  try {
    const combinedSpecs = specs
      .map((s, i) => `<!-- Spec ${i + 1} of ${specs.length}: ${s.pageTitle} (${s.pageUrl}) -->\n\n${s.content}`)
      .join("\n\n---\n\n");

    const userContent = `${HANDOFF_PREAMBLE}\n\nSite: ${siteUrl}\nNumber of per-page screen specs: ${specs.length}\n\n${combinedSpecs}\n\n---\n${HANDOFF_FORMAT_INSTRUCTIONS}`;

    const [apiKey, settings, system] = await Promise.all([
      store.get("apiKey", ""),
      store.getSettings(),
      loadPrompt("handoffSplitter", "scram-phased-handoff-splitter.md"),
    ]);

    const { text, stopReason } = await callClaude({
      apiKey,
      model: settings.model,
      system,
      userContent,
      maxTokens: settings.handoffMaxTokens,
      onProgress: (chars) => store.setJob(jobKey, { status: "running", message: `Writing ${specs.length}-page handoff (${chars.toLocaleString()} chars)…`, startedAt }),
    });

    if (stopReason === "max_tokens") {
      throw new Error("Claude hit the max token limit before finishing the handoff JSON. Raise 'Handoff max tokens' in Options or capture fewer pages.");
    }

    const parsed = extractJson(text);
    if (!Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error("Handoff JSON had no steps.");

    const now = new Date().toISOString();
    // Keep Claude's order, then renumber 0..n-1 so the build queue never has gaps or duplicates.
    const steps = parsed.steps
      .map((s, i) => ({ s, order: Number.isFinite(Number(s.stepNumber)) ? Number(s.stepNumber) : i, i }))
      .sort((a, b) => a.order - b.order || a.i - b.i)
      .map(({ s }, n) => ({
        id: store.uid(),
        siteUrl,
        fileType: "step",
        stepNumber: n,
        title: String(s.title || `Step ${n}`),
        content: String(s.content || ""),
        createdAt: now,
      }));
    const manifest = String(parsed.manifest || "");
    const combinedDoc = String(parsed.combinedDoc || "").trim() ||
      [manifest, ...steps.map((s) => s.content)].filter(Boolean).join("\n\n---\n\n");
    const files = [
      { id: store.uid(), siteUrl, fileType: "manifest", stepNumber: null, title: "Step Manifest", content: manifest, createdAt: now },
      { id: store.uid(), siteUrl, fileType: "combined", stepNumber: null, title: "Combined Handoff", content: combinedDoc, createdAt: now },
      ...steps,
    ];

    await store.replaceHandoffFiles(siteUrl, files);
    // New steps invalidate any previous build progress for this site.
    await store.setProgress({ siteUrl, currentStep: files.find((f) => f.fileType === "step").stepNumber, completedSteps: [] });
    await store.setJob(jobKey, null);
    return files;
  } catch (err) {
    await store.setJob(jobKey, { status: "error", message: err.message, startedAt: Date.now() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Job 3: drive the Scram build one step at a time.
// ---------------------------------------------------------------------------

async function findScramTab(progress) {
  if (progress?.scramTabId != null) {
    try {
      const tab = await chrome.tabs.get(progress.scramTabId);
      if (tab.url?.startsWith(SCRAM_URL)) return tab;
    } catch {
      /* tab closed */
    }
  }
  const [tab] = await chrome.tabs.query({ url: `${SCRAM_URL}*` });
  return tab || null;
}

async function startBuild(siteUrl) {
  const steps = await store.getSteps(siteUrl);
  if (!steps.length) throw new Error("Generate the handoff first.");
  const progress = await store.getProgress(siteUrl);
  const tab = await chrome.tabs.create({ url: SCRAM_URL, active: true });
  await store.setProgress({
    ...progress,
    currentStep: progress.completedSteps.length ? progress.currentStep : steps[0].stepNumber,
    scramTabId: tab.id,
    startedAt: new Date().toISOString(),
    autoProjectAttempted: false,
  });
  await store.set("activeBuild", siteUrl);
  return { tabId: tab.id };
}

async function buildState() {
  const siteUrl = await store.get("activeBuild", null);
  if (!siteUrl) return { active: false };
  const [steps, progress, settings] = await Promise.all([store.getSteps(siteUrl), store.getProgress(siteUrl), store.getSettings()]);
  const step = steps.find((s) => s.stepNumber === progress.currentStep) || null;
  return {
    active: true,
    siteUrl,
    step,
    totalSteps: steps.length,
    stepIndex: step ? steps.indexOf(step) : -1,
    progress,
    finished: steps.every((s) => progress.completedSteps.includes(s.stepNumber)),
    autoSubmit: settings.autoSubmit,
  };
}

async function notifyScram(siteUrl, message) {
  const progress = await store.getProgress(siteUrl);
  const tab = await findScramTab(progress);
  if (!tab) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  } catch {
    return false;
  }
}

async function completeStep(siteUrl, stepNumber) {
  const steps = await store.getSteps(siteUrl);
  const progress = await store.getProgress(siteUrl);
  const completed = new Set(progress.completedSteps);
  completed.add(stepNumber);
  const next = steps.find((s) => !completed.has(s.stepNumber));
  const updated = { ...progress, completedSteps: [...completed].sort((a, b) => a - b), currentStep: next ? next.stepNumber : stepNumber };
  await store.setProgress(updated);
  if (next && (await store.get("activeBuild")) === siteUrl) {
    await notifyScram(siteUrl, { type: "scram:pasteStep" });
  }
  return updated;
}

async function sendStep(siteUrl, stepNumber) {
  const progress = await store.getProgress(siteUrl);
  await store.setProgress({ ...progress, currentStep: stepNumber });
  await store.set("activeBuild", siteUrl);
  const tab = await findScramTab(progress);
  if (!tab) {
    const created = await chrome.tabs.create({ url: SCRAM_URL, active: true });
    await store.setProgress({ ...(await store.getProgress(siteUrl)), scramTabId: created.id });
    return { opened: true };
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await store.setProgress({ ...(await store.getProgress(siteUrl)), scramTabId: tab.id });
  await notifyScram(siteUrl, { type: "scram:pasteStep" });
  return { opened: false };
}

async function resetBuild(siteUrl) {
  const steps = await store.getSteps(siteUrl);
  await store.setProgress({ siteUrl, currentStep: steps[0]?.stepNumber ?? 0, completedSteps: [] });
}

async function uncompleteStep(siteUrl, stepNumber) {
  const progress = await store.getProgress(siteUrl);
  await store.setProgress({ ...progress, completedSteps: progress.completedSteps.filter((n) => n !== stepNumber) });
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const handlers = {
  ping: async () => "pong",
  capture: ({ tabId }) => capturePage(tabId),
  generateHandoff: ({ siteUrl }) => generateHandoff(siteUrl),
  startBuild: ({ siteUrl }) => startBuild(siteUrl),
  sendStep: ({ siteUrl, stepNumber }) => sendStep(siteUrl, stepNumber),
  completeStep: ({ siteUrl, stepNumber }) => completeStep(siteUrl, stepNumber),
  uncompleteStep: ({ siteUrl, stepNumber }) => uncompleteStep(siteUrl, stepNumber),
  resetBuild: ({ siteUrl }) => resetBuild(siteUrl),
  stopBuild: () => store.set("activeBuild", null),
  clearJob: ({ key }) => store.setJob(key, null),

  // From the Scram content script.
  "scram:getState": () => buildState(),
  "scram:markProjectAttempted": async () => {
    const siteUrl = await store.get("activeBuild");
    if (siteUrl) await store.setProgress({ ...(await store.getProgress(siteUrl)), autoProjectAttempted: true });
  },
  "scram:completeCurrent": async () => {
    const state = await buildState();
    if (!state.active || !state.step) throw new Error("No active build step.");
    await completeStep(state.siteUrl, state.step.stepNumber);
    return buildState();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => {
      console.error(msg.type, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // keep the channel open for the async response
});
