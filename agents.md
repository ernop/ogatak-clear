# ogatak-clear - Agent Index

Fork of [rooklift/ogatak](https://github.com/rooklift/ogatak) (AGPL-3.0), a
KataGo analysis GUI / SGF editor in Electron. The fork's purpose: visually
improving the comprehensibility of the AI data shown during game review.

## Start here

- `PRODUCT.md` — the requirements source for everything this fork changes,
  and the display framework rules (no bare signed numbers; move quality is
  "points thrown away", always >= 0; perspective stated, never implied).
  Read it before touching the display code.
- `src/modules/move_report.js` — the Move Report panel: score-history chart,
  turn indicator, last-move verdict, outcome change, next-move options table.
  Section order/visibility and sizes are config-driven and adjustable live
  from controls the panel renders itself.
- Our other touches vs upstream: `src/ogatak.html`, `src/ogatak.css` (panel
  styles; old strip-graph and tree canvas hidden), `src/modules/hub.js`,
  `src/modules/__start.js`, `src/modules/__start_spinners.js` (wiring),
  `src/modules/config_io.js` (the `move_report_*` config keys),
  `src/modules/colour_gradients.js` (candidate palettes; Display →
  Gradient), and the Display → Distance from best filter
  (`cost_threshold`) in `utils.js` / `board_drawer.js`.

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

## KataGo data conventions

Ogatak requests `reportAnalysisWinratesAs: "BLACK"` (`src/modules/query.js`),
so `rootInfo.winrate`/`scoreLead` and all `moveInfos[]` are Black-POV
everywhere in the app. Convert to labeled form ("B+2.3", "W 61%") at the
display layer only.
