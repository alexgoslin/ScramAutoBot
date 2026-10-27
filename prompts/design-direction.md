# Give every app its own unique, art-directed design

The default look is safe, generic and forgettable: white background, centred hero, three identical icon cards, a soft gradient and a blue or green button. Never ship that. Every app should look like a design studio made it for this product alone, and a visitor should never guess two of our apps came from the same tool.

## 1. Invent a concept first (think, don't copy)
1. Read the product. Who uses it, what it feels like to use, what world it belongs to, and what it is the opposite of.
2. Come up with 3 very different directions. Each needs a short name, an inspiration source and a one-line mood. Pull inspiration from outside software: print, architecture, signage, fashion, packaging, games, film titles, nature, science, a decade, a material or a craft.
   - Illustrative only, do not reuse: "Swiss railway timetable", "risograph zine", "1970s NASA manual", "botanical field notes", "arcade cabinet", "brutalist concrete", "frosted glass & sky", "museum wall labels".
3. Pick the boldest direction that still fits the product, and say in two sentences why it suits this app.
4. Make it different from our other apps. If it resembles a previous project (same palette, same fonts, same layout tricks), choose again.
   - Previously used, so don't repeat: paper & ink editorial with Bricolage Grotesque, and editorial indigo with outlined headlines (plus any concepts listed as already used).

Write the concept as one line ("CONCEPT: …") and make every later decision serve it.

## 2. Turn the concept into a system (as theme tokens)
Choose deliberately; don't fall back to defaults.
- **Palette:** a background that isn't plain #FFFFFF, an ink colour, and 1–3 accents used with conviction (big flat blocks, not timid tints). Dark, warm, saturated and muted palettes are all allowed if they fit. Text contrast must pass WCAG AA.
- **Typography:** a display face with real character, paired with a readable body face. Optionally a third utility face (mono, condensed or serif) for labels. Dramatic size contrast between headlines and body. At most 3 families (Google Fonts, so Scram can load them).
- **Shape language:** ONE (sharp and square, soft and round, pill and glossy, hand-drawn, cut-paper, etc.), applied to buttons, inputs, cards, chips and images.
- **Texture & depth:** what fits — flat colour, grain, hairline rules and grids, glass and blur, hard offset shadows, layered paper. No generic soft drop shadows everywhere.
- **Signature element:** one memorable motif repeated across the app (a recurring shape, numbered section labels, a stamp, a ticker, a custom divider, an illustration style, a cursor effect).
- **Motion:** one consistent personality (snappy, floaty, mechanical or playful) with a scroll reveal, hover states and page transitions. Always respect reduced-motion settings.

All of it goes into the theme, so the logged-in app (dashboards, tables, forms, settings, empty states) shares the same identity as any public page.

## 3. Compose pages like a designer
- **Hero / first screen:** a confident, specific headline (no "Welcome to X" or "The all-in-one platform for…") plus a striking visual made from the real product (stylised mock-ups of actual screens built with real components, layered with the concept's shapes or textures).
- **Layout:** vary it between sections: asymmetric splits, full-bleed bands, big type moments, grids and overlaps. No two consecutive sections share a layout. Alternate light and dark or colour-block bands where it fits.
- **Copy:** short, specific, with a voice that matches the concept, written for real users rather than marketing filler.
- **Small details count:** empty states, loading states, 404 pages, emails and favicons get the concept treatment too.
- **No:** stock photos, emoji as icons, lorem ipsum, default rounded-blue buttons, meaningless gradient blobs, or a centred hero with 3 identical icon cards.

## 4. Quality bar
- The concept line exists, and someone could describe the look in 3 words.
- It's clearly different from the default Scram look and from our other apps.
- Typography hierarchy is dramatic and consistent, with no more than 3 font families.
- All colours, fonts, radii and shadows come from theme tokens; nothing is hard-coded one-off.
- Works at desktop size with no horizontal scroll, overlap or clipped text (this build targets desktop only).
- AA contrast, visible focus states and reduced-motion support.
- The logged-in screens look like the same brand as any public page.
