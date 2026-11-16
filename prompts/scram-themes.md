# How Scram themes work (from Scram's editor source, Nov 2026)

A Scram theme is created by Scram's AI with its `manageThemes` tool. Written as that tool's exact payload, it is passed through as-is instead of being interpreted.

## The payload (createTheme)
{"id":"<lowercase-slug>","themeName":"<Name>","description":"<one sentence: the look and who it is for>",
 "baseColors":{"primary":"#RRGGBB","secondary":"#RRGGBB","neutral":"#RRGGBB","success":"#RRGGBB","alert":"#RRGGBB","error":"#RRGGBB"},
 "colorShadeOverrides":{"<role>":{"<shade>":"#RRGGBB"}},
 "fonts":{"heading":"<one Google Font>","body":"<one Google Font>"},
 "spacing":<0-9>,"textSize":<0-9>,"border":<0-4>,"roundness":<0-9>,"size":<0-4>,
 "iconLibrary":"feather|hero-outline|hero-solid|lucide",
 "colorSchemeMode":"light-only|dark-only|switchable",
 "reasoning":"<why this theme>"}

## Colours
- Roles: primary, secondary, neutral, success, alert, error, and custom1–custom5. All six main roles need a base hex. Never use `surface` or `content` (legacy).
- A base colour sets each role's HUE AND SATURATION ONLY. Shades 50–950 are generated at a fixed lightness, so the base hex itself appears nowhere. To get an exact hex, pin it in `colorShadeOverrides` at a shade.
- Pin only what the design depends on: usually the brand colour at 500, the button fill at primary 800, a signature page colour at neutral 50, cards at neutral 100. Don't hand-set whole scales.
- Solid buttons: fill = primary 800, label = primary 50. If you pin one, keep the pair contrasting (4.5:1). Never reuse primary 50 for anything else.
- custom1–custom5 have no base colour: they exist only as pins. Pin them at 500.
- Pages use roles, not hexes: neutral 50 = page · neutral 100 = cards, nav, inputs · neutral 200 = borders · neutral 600 = muted text · neutral 900 = text · primary 100 = tints · primary 700 = accent text and icons · primary 800 / 50 = solid button fill / label.

## Dark
- Make a theme dark with `colorSchemeMode`, never with dark hexes. dark-only and switchable reverse the scale (50 = darkest), so "neutral 50 = page, neutral 900 = text" works in every theme. A human who wants a dark app gets "dark-only"; light and dark both: "switchable".
- Pins land on ONE variant: dark for dark-only, light otherwise. The dark side of a switchable theme cannot be pinned from chat (set it in the theme editor by hand); leave it generated.
- Pins persist until set to null, even when base colours change.

## Scales (steps, not px)
- spacing 0–9 (default 5), textSize 0–9 (default 3), roundness 0–9, border 0–4, size 0–4 (default 2: button heights, icon sizes).
- Body text: 14 px at textSize 0–1, 16 px at 2–6, 18 px at 7, 20 px at 8, 22 px at 9. Headings grow with it.
- Roundness (large corners): 2 px at 0, 8 px at 4, 20 px at 9.
- Border [sm, md, lg] px: 0 → [0,1,2] … 4 → [1,3,6].

## Fonts and icons
- Fonts: one Google Font name each for heading and body, no fallback stack. Commercial fonts aren't available.
- iconLibrary: feather | hero-outline | hero-solid | lucide.

## Not storable in a theme
Uppercase headings, letter-spacing, shadows, a mono or third font, exact px sizes, focus rings, textures and gradients. These go in the page styling rules, applied once in the shared components.

## Projects
A project can hold several named themes, chosen per frontend. Switching in the editor and asking the AI to switch change the same setting; whichever happens last wins. Check which theme the running app actually shows.
