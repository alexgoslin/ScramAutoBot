// Scram themes as the exact payload Scram's AI passes to its manageThemes tool, checked before
// it's sent. The rules mirror Scram's theme schema (packages/ai/src/tool-registry/manageThemes.ts,
// public/theming/src/types.ts and theme-consts.ts in Scram's editor, as of Nov 2026):
// prompts/scram-themes.md explains them. Pure functions, no chrome APIs.

export const MAIN_ROLES = ["primary", "secondary", "neutral", "success", "alert", "error"];
export const EDITABLE_ROLES = [...MAIN_ROLES, "custom1", "custom2", "custom3", "custom4", "custom5"];
export const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
export const ICON_LIBRARIES = ["feather", "hero-outline", "hero-solid", "lucide"];
export const SCHEME_MODES = ["light-only", "dark-only", "switchable"];
const STEPS = { spacing: [0, 9, 5], textSize: [0, 9, 3], roundness: [0, 9, 4], border: [0, 4, 1], size: [0, 4, 2] };
const DEFAULT_BASE = { primary: "#26252C", secondary: "#468D80", neutral: "#8A8A8A", success: "#097E00", alert: "#D99A3D", error: "#C93C3C" };
const HEX = /^#[0-9a-f]{6}$/i;

const hex = (v) => {
  const s = String(v ?? "").trim();
  if (HEX.test(s)) return s.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toUpperCase()}`; // a hex without "#"
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`.toUpperCase();
  return null;
};
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Check a createTheme object. Returns { ok, errors: [plain sentences], theme: a cleaned copy that is
// always valid (invalid parts dropped or clamped, missing base colours filled with neutral defaults) }.
export function checkTheme(input) {
  const errors = [];
  const t = input && typeof input === "object" ? input : {};
  const out = {};
  out.themeName = String(t.themeName || t.name || "").trim().slice(0, 60);
  if (!out.themeName) {
    errors.push("themeName is missing");
    out.themeName = "App theme";
  }
  out.id = slug(t.id) || slug(out.themeName) || "app-theme";
  out.description = String(t.description || "").trim().slice(0, 300) || out.themeName;

  out.baseColors = {};
  const base = t.baseColors && typeof t.baseColors === "object" ? t.baseColors : {};
  for (const k of Object.keys(base)) if (!MAIN_ROLES.includes(k)) errors.push(`baseColors.${k} isn't a base colour role (only ${MAIN_ROLES.join(", ")})`);
  for (const role of MAIN_ROLES) {
    const h = hex(base[role]);
    if (!h) errors.push(base[role] == null ? `baseColors.${role} is missing (all six are required)` : `baseColors.${role} "${base[role]}" isn't a #RRGGBB hex`);
    out.baseColors[role] = h || DEFAULT_BASE[role];
  }

  const pins = t.colorShadeOverrides && typeof t.colorShadeOverrides === "object" ? t.colorShadeOverrides : {};
  const cleanPins = {};
  for (const [role, shades] of Object.entries(pins)) {
    if (!EDITABLE_ROLES.includes(role)) {
      errors.push(/^(surface|content)$/.test(role) ? `colorShadeOverrides.${role} is a legacy role — use neutral shades instead` : `colorShadeOverrides.${role} isn't a colour role`);
      continue;
    }
    if (!shades || typeof shades !== "object") continue;
    for (const [shade, v] of Object.entries(shades)) {
      if (!SHADES.includes(String(shade))) {
        errors.push(`colorShadeOverrides.${role}.${shade} isn't a shade (50, 100…900, 950)`);
        continue;
      }
      if (v === null) {
        (cleanPins[role] ||= {})[shade] = null;
        continue;
      }
      const h = hex(v);
      if (!h) {
        errors.push(`colorShadeOverrides.${role}.${shade} "${v}" isn't a #RRGGBB hex`);
        continue;
      }
      (cleanPins[role] ||= {})[shade] = h;
    }
  }
  if (Object.keys(cleanPins).length) out.colorShadeOverrides = cleanPins;

  const fonts = {};
  for (const k of ["heading", "body"]) {
    const f = String(t.fonts?.[k] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!f) continue;
    if (/[,;]/.test(f) || /\b(sans-serif|serif|monospace|system-ui)\b/i.test(f)) {
      errors.push(`fonts.${k} "${f}" must be one Google Font name, no fallback stack`);
      const first = f.split(/[,;]/)[0].trim().replace(/^["']|["']$/g, "");
      if (first && !/^(sans-serif|serif|monospace|system-ui)$/i.test(first)) fonts[k] = first.slice(0, 60);
      continue;
    }
    fonts[k] = f.slice(0, 60);
  }
  for (const k of Object.keys(t.fonts || {})) if (!["heading", "body"].includes(k)) errors.push(`fonts.${k}: a theme holds only a heading and a body font (put a third font in the page styling rules)`);
  if (Object.keys(fonts).length) out.fonts = fonts;

  for (const [k, [lo, hi, def]] of Object.entries(STEPS)) {
    if (t[k] == null) continue;
    const n = Number(t[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      errors.push(`${k} ${JSON.stringify(t[k])} must be a step from ${lo} to ${hi}, not px`);
      out[k] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
    } else out[k] = n;
  }

  const icon = String(t.iconLibrary || "").trim();
  if (!ICON_LIBRARIES.includes(icon)) {
    if (icon) errors.push(`iconLibrary "${icon}" must be one of ${ICON_LIBRARIES.join(", ")}`);
    out.iconLibrary = "lucide";
  } else out.iconLibrary = icon;

  const mode = String(t.colorSchemeMode || "").trim();
  if (!SCHEME_MODES.includes(mode)) {
    errors.push(`colorSchemeMode "${mode}" must be light-only, dark-only or switchable`);
    out.colorSchemeMode = /dark/i.test(mode) ? "dark-only" : "light-only";
  } else out.colorSchemeMode = mode;

  out.reasoning = String(t.reasoning || "").trim().slice(0, 300) || out.description;
  return { ok: errors.length === 0, errors, theme: out };
}

// The first ```json block (or bare {…}) in a "## Scram theme" section of a design concept.
export function themeFromConcept(markdown) {
  const text = String(markdown || "");
  const sec = text.match(/##\s*Scram theme[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "";
  const block = sec.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || sec;
  const start = block.indexOf("{");
  const end = block.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(block.slice(start, end + 1));
    // Accept the bare createTheme object, or a whole manageThemes call.
    return j?.operations?.[0]?.createTheme || j?.createTheme || j;
  } catch {
    return null;
  }
}

// The exact manageThemes call for Scram's AI.
export function manageThemesCall(theme) {
  return { explanation: `${theme.themeName} theme`, operations: [{ createTheme: theme }] };
}

const ROUND_LG = { 0: 2, 4: 8, 9: 20 }; // the documented large-corner px values

// A one-line check a person (or the supervisor) can verify by eye in Run mode.
export function themeDoneWhen(theme) {
  const p = theme.colorShadeOverrides || {};
  const page = p.neutral?.["50"];
  const button = p.primary?.["800"];
  const parts = [
    page ? `the page background is ${page}` : `the page background is the theme's neutral 50`,
    button ? `a solid button is ${button}${p.primary?.["50"] ? ` with a ${p.primary["50"]} label` : ""}` : "solid buttons use the theme's primary 800 fill",
    theme.fonts?.heading ? `headings use ${theme.fonts.heading}` : null,
    theme.roundness != null && ROUND_LG[theme.roundness] != null ? `large corners are ${ROUND_LG[theme.roundness]} px` : null,
    theme.colorSchemeMode === "dark-only" ? "the app is dark" : theme.colorSchemeMode === "switchable" ? "the app switches between light and dark" : null,
  ].filter(Boolean);
  return `in Run mode, ${parts.join(", ")}.`;
}

// A short summary for the design history (so later apps pick different palettes and fonts).
export function themeSummary(theme) {
  const p = theme.colorShadeOverrides || {};
  const colours = [p.neutral?.["50"], p.primary?.["800"] || theme.baseColors?.primary, p.secondary?.["500"] || theme.baseColors?.secondary, p.custom1?.["500"]].filter(Boolean);
  return `${[theme.fonts?.heading, theme.fonts?.body].filter(Boolean).join(" / ") || "default fonts"}; ${colours.join(", ")}; ${theme.colorSchemeMode}`;
}
