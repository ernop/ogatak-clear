# ogatak-clear - Agent Index

Fork of [rooklift/ogatak](https://github.com/rooklift/ogatak) (AGPL-3.0), a
KataGo analysis GUI / SGF editor in Electron. The fork's purpose: visually
improving the comprehensibility of the AI data shown during game review.

## Start here

- `PRODUCT.md` — the requirements source for the analysis display
  (no bare signed numbers; move quality is "points thrown away", always
  >= 0; perspective stated, never implied). Read it before touching
  Move Report / candidate / chart code.
- `PRODUCT-workspace.md` — window chrome, pane layout, info bar, tab
  strip, variation tree as a pane, and restart-safe persistence. Read
  it before touching layout, zoom, window size, or show/hide. When it
  disagrees with `PRODUCT.md` about layout, it wins.
- `src/modules/settings_schema.js` / `settings_pane.js` — the Settings pane
  (File → Settings..., Ctrl+,): every user-facing setting on one page,
  applied through `hub.set()`. A new user-facing config key gets a row in
  `settings_schema.js`. Requirements: `PRODUCT-workspace.md` "Settings pane".
- `src/modules/move_report.js` — the Move Report panel: score-history chart,
  turn indicator, last-move verdict, outcome change, next-move options table.
  Section order/visibility and sizes are config-driven and adjustable live
  from controls the panel renders itself.
- Our other touches vs upstream: `src/ogatak.html`, `src/ogatak.css` (panel
  styles; old strip-graph hidden; tree is a hideable pane), `src/modules/hub.js`,
  `src/modules/__start.js`, `src/modules/__start_spinners.js` (wiring),
  `src/modules/config_io.js` (the `move_report_*` and workspace config keys),
  `src/modules/colour_gradients.js` (candidate palettes; Display →
  Gradient), the Display → Candidate moves shown filter
  (`candidate_filter` / `cost_threshold` / `candidate_count` /
  `candidate_min_visits`, selected by `utils.select_candidates`), Display →
  Show every variation's next move (`always_show_next_move_eval`, the key
  kept from its earlier name "Always show next-move eval";
  `utils.board_candidates` and `utils.options_table_infos`), Display → Mark explored moves
  (`mark_explored_moves`, `board_drawer.js`), `src/modules/eval_history.js`
  (per-search candidate value history, recorded from `hub.receive_object`,
  drawn by the Move Report's Eval history card), and
  `src/modules/explored.js` (explored moves: a child's own search standing
  in for its parent's estimate of that move; merged in by
  `utils.board_candidates`, Next Move Options, and Eval history;
  requirements in `PRODUCT.md` item 13; and `explored.inherited_root`,
  inherited values: the parent's search of the move into a node standing in
  for that node's own search, read by `Node.stored_score` /
  `stored_winrate` and the info bar; `PRODUCT.md` item 14).

## Remotes

- `origin` — github.com/ernop/ogatak-clear (public).
- `upstream` — github.com/rooklift/ogatak. Pull his releases and merge; our
  changes are deliberately concentrated in few files to keep merges small.

## Running

- `cd src && node_modules/.bin/electron .` (Electron is npm-installed in
  `src/node_modules`, gitignored). The `ogatak` zsh alias and the desktop
  launcher do this.
- This machine (Ubuntu 26.04) restricts unprivileged user namespaces, so
  Electron aborts at startup unless `chrome-sandbox` is `root:root` mode
  4755. Reinstalling Electron resets that; redo the chown/chmod from the
  README's Setup, or pass `--no-sandbox` (startup ignores argv entries
  that aren't existing files).
- Engine paths live in the user config `~/.config/Ogatak/config.json`
  (KataGo TensorRT wrapper at `~/katago/trt/katago-trt`). Full KataGo setup
  story: mybrowser repo,
  `project-ideas/candidate-projects/katago-local-go-analysis.md`.

## Testing changes without disturbing a live instance

Ogatak is single-instance per config dir. Launch a sandboxed second instance:

    XDG_CONFIG_HOME=/tmp/ogatak-test/confighome src/node_modules/.bin/electron src --remote-debugging-port=9223

then drive it over CDP (evaluate JS, take screenshots) — a minimal driver
script exists at `/tmp/ogatak-test/cdp.js` (recreate as needed: hit
`http://127.0.0.1:9223/json`, open the page websocket, send
`Runtime.evaluate` / `Page.captureScreenshot`). Adding `--inspect=9230`
exposes the main process the same way, which is where the native menu
lives (`require("electron").Menu.getApplicationMenu()`; an item's
`.click()` behaves like a real menu click).

The sandbox's window otherwise pops up on the user's desktop and takes
focus, which looks like a stray second Ogatak; keep it hidden. Launch
with `--inspect=9230`, then poll `http://127.0.0.1:9230/json` straight
away and evaluate `BrowserWindow.prototype[k] = function() {}` for
`show` / `focus` / `maximize` / `restore` — the window is created hidden
and only shown once the renderer reports ready, so the patch wins the
race. (`--ozone-platform=headless` segfaults in this Electron, and a
`NODE_OPTIONS=--require` preload runs before `require("electron")`
resolves.) The window is created with `backgroundThrottling: false`, so
a hidden sandbox still analyses at full speed.

A hidden window cannot be screenshotted (on Wayland it never produces a
frame, so `Page.captureScreenshot` and `capturePage({stayHidden})` hang).
For screenshots, start Ogatak through a tiny wrapper app whose `main.js`
intercepts `require("electron")` (via `Module._load`) to return a
`BrowserWindow` subclass forcing `webPreferences.offscreen = true` and
no-op `show` / `focus` / `maximize`, then requires `src/prestart.js`. The
window then renders offscreen and `webContents.capturePage()` works from
the `--inspect` main process (look the page up with
`webContents.getAllWebContents()`; `BrowserWindow.getAllWindows()` skips
subclassed windows). CDP `Input.dispatchMouseEvent` takes zoomed CSS pixel
coordinates, which is how README screenshots show real board hovers.

Sandbox practicalities:

- Start the sandbox as a background job of its own. If you start it with
  `(… &)` inside another command, it is killed when that command returns.
- Stop it with `pkill -f "[o]ffscreen-app"`. The bracket keeps the
  pattern from matching the shell running the pkill.
- A page reload does not restart the renderer: main answers
  `renderer_started` once. Restart the app instead.
- CDP key events (`Input.dispatchKeyEvent`) reach the page's handlers
  but never Electron's menu accelerators in the offscreen window. A
  menu-accelerator path (Esc, Left/Right siblings) can't be exercised
  that way.
- Analysis displays can be checked without KataGo: build the position with
  `hub.try_move()`, then give nodes analyses through
  `node.receive_analysis(o)` with `o[ANALYSIS_CONTEXT_PROPERTY]` set from
  `query.analysis_context(query.new_query(node, ...), identity)`, so
  contexts are exactly what the engine would produce. With no engine
  process, `engine_failure_spinner` redraws every 1.2 s and wipes hovers;
  set `hub.engine.exe` to a stub with `stdin.write()` first.
- KataGo runs with its working directory set to its own folder, so a
  relative `logDir` in the analysis config writes there. A sandbox using
  the user's engine should point `engineconfig` at a copy whose `logDir`
  is under `/tmp`.

Pure-logic tests run with plain Node, no install: `node src/modules/utils.test.js`,
`node src/modules/eval_history.test.js`,
`node src/modules/candidate_profile.test.js`,
`node src/modules/settings_schema.test.js`, and
`node src/modules/explored.test.js`. CI (`.github/workflows/tests.yml`) runs
`node --check` on `src/*.js` and `src/modules/*.js`, then every
`src/modules/*.test.js`, on each push and pull request, so a new test file
is picked up by its name alone. A test must not need Electron installed:
stand in for the `electron` module as `settings_schema.test.js` does.

## UI conventions

- **One font system, six sizes.** The entire app uses exactly six font
  sizes — hero / emph / body / ui / caption / fine — defined once in
  `src/modules/type_scale.js` as multiples of the single user setting
  `info_font_size` (Sizes → Info font), times the whole-UI `zoom_factor`.
  DOM text consumes them via the `--fs-*` CSS variables (or `fs-*` utility
  classes) in `ogatak.css`; canvas text uses `type_scale.px()` /
  `canvas_font()`. Never write an ad-hoc font size (no em/px literals) and
  never add a pane-local font-size config key or control (the Move Report
  panel once had one — `move_report_font_size` — and it silently drifted
  out of step with the rest of the UI; it was removed).
- **`board_drawer.square_size` can be fractional CSS pixels.** It is a
  whole number of device pixels, so the grid stays crisp under UI zoom
  (`PRODUCT-workspace.md`, "The board under UI zoom"). Never use it as
  an array index or assume it is an integer. `board_font_chooser`
  floors it.
- **No inline styles in our modules.** Every style rule lives in
  `ogatak.css` classes. JS and HTML templates never set concrete style
  properties; config- or data-driven values (card width, section order,
  gradient colours, wood colour) are published as CSS custom properties
  which the classes consume. Upstream modules (comment_drawer, fullbox,
  stderrbox, root_editor, grapher, board square rendering) keep their stock
  mechanisms to stay merge-friendly.

## KataGo data conventions

Ogatak requests `reportAnalysisWinratesAs: "BLACK"` (`src/modules/query.js`),
so `rootInfo.winrate`/`scoreLead` and all `moveInfos[]` are Black-POV
everywhere in the app. Convert to labeled form ("B+2.3", "W 61%") at the
display layer only.
