# UI quality gate — what the final review checks

A screen isn't finished until the evidence shows it. Check every page at a narrow (phone), a medium (tablet) and a full (desktop) width, and in light and dark where the theme has both. What can't be checked from what you were given is listed as unverified, never assumed to pass.

1. **Overflow:** no text cut off without "…" and nothing overlapping — including with very long text, 1 item and many items.
2. **Consistency:** same-kind components match in height, radius, padding and hover. Rows of a type share one height; trailing items share one right edge.
3. **Theme:** no colour, font, size, radius, border or shadow outside the app's theme and design concept.
4. **Craft:** one focal point and one primary action per screen; the accent only on its roles (selection, focus, active nav, the primary action).
5. **States and access:** hover, focus, empty, loading and error states exist. Focus is visible, fields are labelled, and state is never shown by colour alone.
6. **Regressions:** nothing that worked now stacks, wraps or moves.

Each problem names the page, the width it was seen at, and the evidence (which screenshot, which automatic finding, which click).
