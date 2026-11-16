# App craft — making screens look finished within the app's own design

(Generated UIs look unfinished through omissions, not taste. These rules fill those gaps inside the app's own theme and design concept, as outcomes rather than values: the design concept supplies the values, so every app keeps its own look.)

## Before you build
1. **Theme.** Every colour, radius and space comes from the project's Scram theme (its colour roles and shades, its spacing / roundness / border / size steps). Anything a Scram theme can't hold (shadows, uppercase or letter-spaced headings, a third font, focus rings, textures) comes from the design concept's page styling rules, set once in the shared components — never as one-off values on a page.
2. **Direction.** The design concept's VIBE and CONCEPT lines are the direction. Every screen serves them.

## Craft
- **Focal point:** one per screen, clearly the largest thing on it.
- **Depth:** regions separate from the page by tone and a border; a shadowed card is lighter than the page, never darker. Menus, dialogs and sheets stand out most; dialogs sit on a scrim.
- **Regions, not rows:** a list is one region with dividers, never a card per row. Separate sections with headings and space, not more cards.
- **Type:** up to three roles per region, separated by weight and colour before size; `tabular-nums` for numbers in columns.
- **Colour:** neutrals carry the screen; the accent marks only selection, focus, active nav and the primary action. Status is a soft tinted pill. Text 4.5:1, large text and borders 3:1.
- **Icons:** one family (the theme's icon library), one size in nav and controls, including built-in inputs, selects and toggles; hit area comes from padding. Control text matches body text.
- **Corners:** controls share one radius; regions and dialogs a larger one.
- **Forms:** every field's purpose is clear; an error replaces helper text. The primary action ends the form.
- **Destructive actions:** last in their group, outline style; filled only in a confirm dialog.
- **Motion:** on the logged-in app screens (dashboards, lists, tables, forms, settings), short feedback only. Public and first-run pages may use the design concept's richer motion. Always respect reduced motion.

## States
- Interactive elements have hover, focus, selected and disabled states in the shared component. Hover is never the only way to reach an action.
- Data views have loading (a skeleton matching the layout), empty and error states. An empty state has an icon, a title, one line of help and a button; with no data at all, it replaces the whole layout.
- Every screen works in light and dark when the theme supports both.

## Growth
- Views work with 0, 1 and 500+ items and very long text. Long lists paginate with a count; avatars fall back to initials.
- Cards in a row share one width and height, with actions lined up at the bottom.
- The page never scrolls sideways; tables scroll inside their region or stack on small screens. No type below 12px.
