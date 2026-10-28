# Give every app its own unique, art-directed design

The default look is safe, generic and forgettable: white background, centred hero, three identical icon cards, a soft gradient and a blue or green button. Never ship that. Every app should look like a design studio made it for this product alone, and a visitor should never guess two of our apps came from the same tool.

## 1. Start from a vibe, then make it your own
1. Read the product. Who uses it, what it feels like to use, and what it should feel like instead of the generic default.
2. Start from the VIBE — the overall feeling (e.g. cozy, modern, rough and raw, calm and minimal, playful, premium, bold and energetic, retro, techy and precise, natural and organic, friendly). The human picks one; it's the north star for every choice.
3. Turn the vibe into a concept that's distinctive but tasteful: a grown-up product people would happily use every day. Inspiration from outside software (print, architecture, materials, a decade, a craft) can season the details — a texture, a type choice, a divider — but never turn the app into a costume or a theme park. No literal themes such as a construction site, a kitchen order ticket, a casino or a spaceship cockpit.
4. Make it different from our other apps. If it resembles a previous project (same palette, same fonts, same layout tricks), change it.
   - Previously used, so don't repeat: paper & ink editorial with Bricolage Grotesque, and editorial indigo with outlined headlines (plus any concepts listed as already used).

Write the concept as one line ("CONCEPT: …") and make every later decision serve it and the vibe.

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
- The concept line exists, it clearly expresses the chosen vibe, and someone could describe the look in 3 words.
- It's clearly different from the default Scram look and from our other apps.
- Typography hierarchy is dramatic and consistent, with no more than 3 font families.
- All colours, fonts, radii and shadows come from theme tokens; nothing is hard-coded one-off.
- Works at desktop size with no horizontal scroll, overlap or clipped text (this build targets desktop only).
- AA contrast, visible focus states and reduced-motion support.
- The logged-in screens look like the same brand as any public page.
