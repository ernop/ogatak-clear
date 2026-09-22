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
- `src/modules/move_report.js` — the Move Report panel: score-history chart,
  turn indicator, last-move verdict, outcome change, next-move options table.
  Section order/visibility and sizes are config-driven and adjustable live
  from controls the panel renders itself.
- Our other touches vs upstream: `src/ogatak.html`, `src/ogatak.css` (panel
  styles; old strip-graph hidden; tree is a hideable pane), `src/modules/hub.js`,
  `src/modules/__start.js`, `src/modules/__start_spinners.js` (wiring),
  `src/modules/config_io.js` (the `move_report_*` and workspace config keys),
  `src/modules/colour_gradients.js` (candidate palettes; Display →
  Gradient), the Display → Distance from best filter
  (`cost_threshold`), and Display → Always show next-move eval
  (`always_show_next_move_eval`) in `utils.js` / `board_drawer.js`.

## Remotes

- `origin` — github.com/ernop/ogatak-clear (public).
- `upstream` — github.com/rooklift/ogatak. Pull his releases and merge; our
  changes are deliberately concentrated in few files to keep merges small.

## Running

- `cd src && node_modules/.bin/electron .` (Electron is npm-installed in
  `src/node_modules`, gitignored). The `ogatak` zsh alias and the desktop
  launcher do this.
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
`Runtime.evaluate` / `Page.captureScreenshot`).

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
