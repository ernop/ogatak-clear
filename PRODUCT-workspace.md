# Product: workspace, chrome, and layout persistence

This file is the requirements source for the window chrome (tab strip,
board info bar), the pane layout (board, Move Report sections, variation
tree, comments), and how every size/position/visibility choice is stored
and restored. Written 2026-08-13 from Ernest's requirements.

The analysis *content* rules (labeled numbers, move quality, charts) live
in `PRODUCT.md`. This file is about *where things sit* and *that they
stay there*.

## Why

A review GUI is a workspace. Chess tools (ChessBase, Scid, Arena, Lichess
analysis) treat the board, the move list / variation tree, engine output,
and comments as things you show, hide, and size. Stock Ogatak (and this
fork's first Move Report layout) instead *derive* most sizes from leftover
space: the board square size is computed from remaining window height,
that width then steals from the right column, cards then flex-grow to
fill whatever is left. Combined with saving the window size from
`window.innerWidth` *after* Chromium zoom, restarting the app produced a
different layout than the one the user left. That is a product failure.

The user adjusts the workspace once. Restarting, zooming, or toggling a
pane must not invent a new layout.

## Persistence (non-negotiable)

These rules are about the *kind* of state we store, not about testing
harder.

1. **The layout is a saved state, not a procedure.** Restoring means
   reading the saved numbers and applying them. There is no "setup
   sequence", no order requirement, and no second pass that "fits" things
   into leftover space and thereby changes other saved sizes.
2. **Save the user's gesture, not a derived byproduct.** If they drag a
   pane to 640×280, store 640 and 280. Do not store "the window was 1333
   CSS pixels after zoom, so the board became 37px squares, so the right
   column was 412px, so the cards wrapped."
3. **Window bounds come from the OS window, in DIP, from the main
   process** (`getContentSize` / `getBounds`). Never from
   `window.innerWidth` / `innerHeight`, which shrink when page zoom
   grows. Zoom is a separate multiplier (`zoom_factor`) applied after
   the window exists. Saving zoomed CSS pixels and then applying zoom
   again on launch is how the layout "magically" changed.
4. **Every user-visible change persists without waiting for Quit.**
   `config.json` is updated on a short trailing debounce after the last
   change; Quit flushes immediately. Killing the app a second after a
   resize still keeps that resize. Config keys not listed in
   `config_io.defaults` are dropped on save — new layout keys must be
   added there.
5. **No setting's restore may rewrite another setting.** Showing the tab
   strip must not change saved pane sizes. Changing zoom must not change
   saved window DIP size. Hiding a card must not resize the others'
   saved width/height (they may *reflow* in the remaining space, but
   their stored sizes stay).
6. **Off-screen positions are the only exception.** If the saved `x,y`
   is not on any current display, ignore position and use the OS default
   placement. Keep the saved size.

Systems that fight these rules are not used:

- Deriving board square size from leftover viewport height as the *source
  of truth* for column width (transitional: still happens for the board
  *drawing* until the board is a pane with its own saved box; it must
  not be what we persist as "the layout").
- Writing `config.width` from `window.innerWidth`.
- Saving config only on quit.
- Flex-grow that *replaces* a saved size (filling leftover space is fine
  as paint, not as the value we write back).
- Chromium session zoom fighting `zoom_factor`. One zoom value, from
  config, applied once.

## Chrome the user can toggle

Every chrome piece is a named, persisted flag or list. Toggles live
*on the thing itself* (hover ✕, restore chip) and also in **Display**
where a menu item is natural. No buried Sizes-menu archaeology for
show/hide.

### Tab strip

- `show_tab_strip` (boolean, default true).
- Off: the thumbnail column takes no width. On: as today.
- Display → Tab strip. Restart restores the last choice.

### Board info bar

The strip above the board is not a fixed 12-span table. It is:

- **Players**, when enabled and when the SGF has `PB` and/or `PW`:
  Black name + rank on the **left**, White name + rank on the **right**.
  Absent names are omitted, not replaced with "Black player" placeholders
  (same rule as the Move Report identity strip). Toggle:
  `info_bar_show_players` (default true).
- **Stats**, an ordered list `info_bar_items`. Each item is hideable and
  restorable from a "+ name" chip on the bar itself. Default:

      rules, toplay, caps, komi, score, show, visits

  Meaning:

  | id | what |
  |---|---|
  | `rules` | Ruleset (click cycles, stock) |
  | `toplay` | `[B\|W]` whose turn |
  | `caps` | Captures or stone counts (click still toggles that mode) |
  | `komi` | Komi (click cycles, stock) |
  | `score` | Labeled score lead (`B+…` / `W+…`) |
  | `show` | Candidate number type (click cycles, stock) |
  | `visits` | Move visits / root visits |

- The info bar must not widen the board column. It wraps inside the
  width the board already owns.
- Engine-error and editing messages still replace the bar when active.

## Panes (board, analysis, tree, comments, …)

Anything that occupies a rectangle in the workspace is a **pane**:
Move Quality, Game Status, Distribution, Choice Breadth, Turn, Last move, Outcome,
Next move options, Comments, **Variation tree**, and later anything
similar. The variation tree is not an optional extra — reviewers
need it, the same way chess tools need the move list. Default may
be hidden; showing it is one click (chip or Display), not a rebuild.

### Target sizing model (chosen)

Each pane stores `{id, visible, order, width, height}` in CSS pixels
**at zoom 1**. Zoom scales the whole page on top. A bottom-right
handle resizes that pane freely. Hold Shift to lock aspect ratio
(needed for charts the user wants square-ish; off by default so
text tables can go wide and short).

On window resize, saved pane sizes do **not** change. Extra window
space is empty; too little space scrolls that region. The user
already chose the sizes. Auto-stretching them is how restart and
"I just made the window a bit taller" become a new layout.

The board is a pane whose box is saved. The stones are the largest
square that fits that box. The board does not dictate the right
column by growing to leftover height.

### Options considered (and why not, as the source of truth)

1. **Wrapping flex cards with one shared `move_report_width` and
   flex-grow** (current). Easy, but every card shares one width, the
   last row stretches, and window size changes the painted layout
   even when saved numbers did not. Transitional only.
2. **Nested splitters** (ChessBase / Scid style). Good for "fill the
   window", bad for persistence: ratios *are* derived from leftover
   space, and restoring ratios after a zoom/DPI/info-bar change is
   an order-sensitive procedure.
3. **Full docking libraries** (Golden Layout, phosphor, etc.).
   Heavy, finicky, easy to serialize into a blob that only that
   library can restore. Rejected: we need a config.json a human
   can edit, same as `move_report_sections` today.
4. **Absolute x,y plus free drag-to-move.** Maximum power, overlap
   hell, off-screen widgets. Not needed until someone asks to tear
   panes out into floating windows.
5. **Explicit saved width×height per pane, packed in order, no
   grow-to-fill** (chosen). The state *is* the sizes. Corner-drag
   is the natural editor. Aspect-ratio lock is a modifier, not a
   mode. `config.json` stays an array of panes.

Until (5) is implemented, new panes (including the variation tree)
join the existing Move Report card flow: hideable, orderable, chip
to restore, persisted in `move_report_sections`. That is the same
*vocabulary* (named sections, on-object controls). It is not yet
the same *sizing* model.

### Variation tree

- Section id `tree`, title "VARIATION TREE".
- Default: not in `move_report_sections` (hidden, "+ variation tree"
  chip). Stock tree drawing and click-to-jump stay intact.
- While it lives as a card, its canvas sizes to that card's box
  (`tree_pane_height`, and the shared card width). It must not
  measure itself to the window edge or subtract `comment_box_height`
  from the viewport — comments are a sibling pane, not a grid row
  reserved under the tree.

## What a glance at chrome must allow

1. Hide the tab strip when reviewing a single game.
2. See who is playing (names, ranks) next to the board without
   opening the SGF properties, and hide that when it is noise.
3. Hide any one info-bar stat in one click; bring it back from a chip.
4. Bring the variation tree back in one click when a game has
   branches that matter.
5. Leave, restart, and see the same chrome, the same zoom, the same
   window, the same hidden/shown panes.
