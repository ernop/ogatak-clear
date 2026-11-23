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

### The board under UI zoom (2026-09-26)

- **Whole device pixels.** A board square is always a whole number of
  device pixels, at any UI zoom and display scale. In CSS pixels it may
  be fractional (`window.devicePixelRatio` includes the UI zoom).
  - Why: at 50% zoom a 95 CSS px square was 47.5 device px. Alternate
    squares then started on half pixels, where their grid lines
    vanished. The board showed a cross at every other intersection,
    with star points floating between them.
- **Grid images at device resolution.** The grid-line images are drawn
  at device resolution. Their lines keep the same physical thickness
  (`board_line_width` at 100% zoom) whatever the UI zoom, matching the
  board's own constant physical size. At 100% zoom on a 1× display,
  rendering is identical to before.

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
  `info_bar_show_players` (default false since 2026-11-22: Move Report's
  identity strip already shows both players and active turn).
- **Stats**, an ordered list `info_bar_items`. Each item's `✕` hide button
  reveals on hover (fixed width, no layout shift), and hidden items are
  restored via a hover-revealed `+` toggle on the bar (collapsed at rest so
  restore chips do not add visual noise) or in Settings. Default since
  2026-11-22 (facts not already duplicated in Move Report):

      rules, komi, caps, show

  Meaning:

  | id | what |
  |---|---|
  | `rules` | Ruleset (click cycles, stock) |
  | `toplay` | `[B\|W]` whose turn |
  | `caps` | Captures or stone counts (click still toggles that mode) |
  | `komi` | Komi (click cycles, stock) |
  | `score` | Labeled score lead (`B+…` / `W+…`) |
  | `show` | Candidate number type (click cycles, stock) |
  | `visits` | Move visits / root visits (compact SI formatting) |

- The info bar must not widen the board column. It wraps inside the
  width the board already owns.
- **Changing values never re-wrap the bar** (2026-09-26, tightened
  2026-11-22). Each value sits in a fixed-width slot (`pad()` widths,
  spaces kept by `white-space: pre`). The slots are Rules 12, Komi 4,
  Caps 7, Show 10, Score 8, Visits 13 (compact `fmt_visits` such as
  `33.1k / 60.5k`). So an unanalysed position's empty Score and Visits
  take the same room as filled ones, and so do growing visit counts.
  - Why: the board's square size is derived from the height below the
    bar (see "Systems that fight these rules"). Every re-wrap therefore
    moved and resized the board and shifted the right-hand column.
  - The measured failure: each board click made the board jump up,
    grow, jump down, and shrink back within about 60 ms.
  - The bar's line count now changes only when the user changes
    something: which items are shown, a visit limit, zoom, or text
    size.
- Engine-error and editing messages still replace the bar when active.

### Mouse wheel scoping (2026-11-22)

- The mouse wheel steps moves in the game **only when the pointer is over
  the board** (`#gridder_board_graph`, calling `preventDefault()`).
- Over any UI panel (`#movereport`, `#settings`, `#tabdiv`, `#boardinfo`,
  `#comments`, modal overlays), the wheel scrolls that panel normally and
  never steps the game tree.
- Rationale: upstream checked only `#tabdiv` and `#comments` when
  scrollable, so wheeling over Move Report or Settings scrolled the UI
  and stepped the game tree simultaneously.

## Panes and Dockview workspace (settled 2026-11-22)

All non-board panels (`history`, `options`, `corridor`, `tree`, `status`,
`quality`, `comments`, `lastmove`, `outcome`, `breadth`, `distribution`,
`turn`) live in a **`dockview-core` v8.9.1** workspace (`src/vendor/dockview/`,
MIT license, vendored locally with zero build step and zero native
dependencies — works identically on Linux, macOS, and Windows).

- **Zero outer scrollbars; full two-axis resize.** The workspace fills the
  right-hand viewport (`#mr_dockview`, `flex: 1 1 0; min-height: 0;`).
  Dragging any Dockview splitter resizes adjacent panels smoothly in both X
  and Y; all canvas charts and `#treecanvas` observe both width and height
  via `ResizeObserver` and redraw to fill their panel box.
- **Persistent DOM pool.** Closing a panel or switching presets parks its
  DOM element in `#mr_panel_pool` rather than destroying `#treecanvas`,
  `#comments`, or chart canvases.
- **Dock, tab, split, float, maximize.** Tabs can be dragged to reorder,
  stacked into tab groups, split horizontally/vertically, popped out into
  floating groups, or maximized via the tab right-click context menu.
- **Built-in presets** in `#mr_controls`:
  - **Review** (default): Top: `[Eval History*, Move Quality]`; Bottom-Left:
    `[Next Move Options*, Variation Space]`; Bottom-Right: `[Variation Tree*,
    Game Status, Comments]`.
  - **Explore**: 2×2 grid keeping Eval History, Variation Space, Next Move
    Options, and Variation Tree visible simultaneously.
  - **Minimal**: Top `[Next Move Options*, Variation Space]` over Bottom
    `[Variation Tree*, Game Status, Comments]`.
- **Persistence.** Every layout drag, split, tab switch, or panel open/close
  persists debounced JSON into `config.workspace_layout` (and mirrors open
  panel IDs in `config.move_report_sections` for Settings toggles). Invalid
  or empty saved layouts fall back cleanly to the `Review` preset.
- **Variation tree visible by default.** `tree` is docked open in all three
  presets, and Ctrl+click stone-move setup branches draw with a gold node
  outline (`#e0b872ff`).

## Settings pane (2026-09-26)

Every setting has one place where it can be seen and changed:
**Settings**, a pane with all of them on one scrollable page.

### Why

Stock Ogatak keeps its settings in the native menus and in hand-edited
`config.json`. That fails in four ways:

- A menu hides the current value until you open the right submenu.
- A menu offers only presets. The analysis visit limit could not be
  set to, say, 300,000.
- About 90 settings are spread over Setup, Analysis, Display, Sizes,
  Misc, Dev and Language, among the actions (Go, Halt, navigation).
- Some settings had no menu at all (`candidate_min_visits`,
  `default_rules`, `default_komi`, `tree_pane_height`).

### Behaviour

- **Opening and closing.** Opened by File → Settings... (Ctrl+,) or
  the **⚙ settings** control at the left of the Move Report's
  controls bar. Closed by its close ✕, Esc, or Ctrl+, again.
- **Placement.** It covers the Move Report in the right-hand column.
  The board, info bar, and tab strip stay visible and live, so the
  effect of a change can be judged at once. Analysis keeps running
  while it is open. (A separate window was rejected: the renderer
  owns `config` and every setting's follow-up actions, so a second
  window would need a synchronization layer.)
- **Cards.** Settings are grouped into cards, in this order: Analysis,
  Candidates on the board, Board and info bar, Engine, Layout and
  text, Move Report, Move Report cards shown, Games, SGF charset
  detection, App. Cards flow into as many columns as fit (each at
  least 32em). The pane scrolls vertically.
- **One line per row.** Each row has its label on the left and its
  control on the right. Each row sizes its own control, so a wide
  control never truncates other labels.
- **Controls.**
  - On/off settings: a button reading "on" or "off".
  - Two or three short options: all shown as buttons.
  - Longer lists: a dropdown.
  - Numbers: a typed field between − and +. The buttons and the Up /
    Down keys step to the nearest preset above or below the current
    value, or by a fixed step when a row has no presets. Enter or
    leaving the field applies a typed number. Accepted forms include
    "1,000,000", "1m", "250k", "2.5k", "1e6", a decimal comma, "61%"
    (zoom), and "all" where 0 means all. Invalid input is flagged
    with the allowed range and not applied. Esc restores the saved
    value.
  - File paths: shown in full, trimmed from the left so the file name
    stays visible. Their "choose…" buttons open the existing menu
    dialogs.
- **Find.** A find box filters rows by label, config key, extra
  keywords, option names, and card title.
- **Applying and saving.** Every change goes through `hub.set()`,
  exactly like a menu click. It applies immediately, keeps the
  menus' checkmarks in step, and is saved by the usual 400 ms
  debounce. There is no Apply or Save button.
- **Visit limits.** The visit limit per position (`ponder_visits`)
  and the autoanalysis / engine visits (`autoanalysis_visits`)
  accept any whole number from 2 to 1,000,000,000. Under each is a
  read-only row showing how long that many visits takes at the speed
  measured on the displayed analysis's search ("Time per position at
  1,625 visits/s — ≈10 min"). Visits stay the unit because they
  measure effort (see `PRODUCT.md`, Pondering limit); the time row
  only translates. For how a new limit reaches a running search, see
  the same section.
- **Keyboard.** Keys typed into the pane's fields and dropdowns (and
  the Move Report's header fields) work those controls, never the
  board: Space, Comma, arrows, Home/End and Tab. A mouse press on a
  pane button never gives it keyboard focus, and a press outside the
  pane gives the keyboard back to the board. So Space still toggles
  analysis after clicking a setting.
- **Menus stay.** The menus remain as they are, for upstream merge
  compatibility and their accelerators. Settings is the complete
  place, and the menus are shortcuts to part of it. A visit limit
  typed in Settings is added to its menu's list at the next start.
- **Main-process copy of config.** The renderer sends every change to
  the main process, which keeps its copy of `config` current. The
  main process reads `confirm_quit`, `language` and the file-dialog
  folders while running.

### Not in Settings (config.json only)

- The stock strip graph's settings: the fork hides that graph.
- Colours that have no menu (wood, grid, tree, graph, previous
  marker).
- Developer and internal keys (`logfile`, `mousemove_delay`,
  `gtp_*`).
- The preset lists themselves (`visit_options`,
  `ponder_visit_options`, `komi_options`).

### For implementers

A new user-facing config key gets a row in
`src/modules/settings_schema.js`. `settings_schema.test.js` checks
that every row's key exists in `config_io.defaults`, because `save()`
drops unknown keys. It also checks that each default can be shown by
its row.

## What a glance at chrome must allow

1. Hide the tab strip when reviewing a single game.
2. See who is playing (names, ranks) next to the board without
   opening the SGF properties, and hide that when it is noise.
3. Hide any one info-bar stat in one click; bring it back from a chip.
4. Bring the variation tree back in one click when a game has
   branches that matter.
5. Leave, restart, and see the same chrome, the same zoom, the same
   window, the same hidden/shown panes.
6. Find any setting in one place, change it by typing or one click,
   and see the effect on the live board beside it.
