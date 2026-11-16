# UI consistency — how things line up and repeat

(Structural rules that hold no look, so every app can follow them all and still look nothing like the others. Every rule can be checked in the running app.)

## Rows
- One height per row type, used everywhere; avatars and icons fit the row, and rows don't grow to fit them. Controls on one row share one height and are vertically centred.
- The last item in a row (action, "…", chevron, count, pill) sits against the row's right edge, so trailing items form one column.
- Leading content, labels and headers share one left edge with the body below.
- A table's header and rows share one column definition. Flexible columns keep a minimum width; when space runs out, the table scrolls inside its region. Columns never shrink to nothing.

## Shape and spacing
- Every button uses one corner radius and one height per size. Inputs and selects match the buttons of their size.
- The same relationship gets the same gap everywhere — items in a row, inside cards, around the page — from the theme's spacing steps.
- Container padding is equal on all sides and larger than the gaps inside it.
- Every page uses one content max width, so content edges line up from page to page.

## Components
- Shell, buttons, inputs, menus, pills and empty states each come from one shared component. Extend it with a variant; never copy it into a page, because copies drift. Make a new component only when it's needed in 3+ places.
- Components doing the same job share identical hover, focus, selected and disabled styles, with one hover style app-wide.
- The same job gets the same control: toggle for instant on/off, checkbox for selection, segmented control for small sets, select for long lists.
- Items of the same kind get the same treatment: nav items all have icons, or none do.

## Overflow
- Any one-line text, headers included, that's too long shortens with "…" and shows the full text on hover. It never overlaps or pushes a neighbour.
- Text in flex or grid children sets `min-width: 0`; long words and URLs wrap. No fixed heights on user-entered text.
