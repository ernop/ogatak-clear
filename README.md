# ogatak-clear

A fork of [rooklift/ogatak](https://github.com/rooklift/ogatak) (AGPL-3.0) focused
on turning KataGo's raw analysis output into clear, statistically legible
visuals during game review.

Upstream Ogatak provides a fast, self-contained KataGo GUI, SGF editor, and
multi-format game loader. `ogatak-clear` tracks upstream releases (currently
synced through upstream 2.2.1-dev) and adds a full statistical review layer:
loss-anchored board candidates, search-convergence curves, choice-breadth
distributions, separated move-quality and game-status charts, inherited and
explored evaluations, and a single live Settings page. The complete
requirements and design rationale live in [PRODUCT.md](PRODUCT.md) and
[PRODUCT-workspace.md](PRODUCT-workspace.md).

![ogatak-clear before Lee Sedol's move 78 against AlphaGo, showing Best + 5 candidates and Eval history](docs/screenshots/count-mode-eval-history-move-78.png)

_Lee Sedol–AlphaGo Game 4, just before Lee's move 78, after a
three-and-a-half-minute search (142k visits). On the board: the best move
(P8, blue star — the move that leaves White the most points), the five
next-best moves labelled with the exact points each loses against it, and the
move Lee actually played (L11, red). On the right: Eval history plots every
candidate's score against search visits, keeping moves that have since left
the board as dashed lines. See [sample-game details](docs/sample-games/README.md)._

## Analytical and statistical features at a glance

Most Go GUIs dump winrate percentages, visit counts, and flickering board
markers onto the screen without separating *how good a move is*, *how deep the
position's choices are*, and *whether the engine is still changing its mind*.
`ogatak-clear` organizes review around five concrete questions:

1. **What does each option actually cost?**
   Every position has **one best move** (the move with at least 50 visits that
   leaves the player to move the most points), marked by a blue star. Every
   other candidate is labelled with its exact point loss relative to that best
   move (`-0.67`, or `67` in basis-point display) on one continuous colour
   scale. The loss shown on the board before a move is the exact loss its
   Move Quality verdict reports after it is played.
2. **Is KataGo still changing its mind as visits grow? (`Eval history`)**
   Plots every candidate's score over the entire search against total visits
   (logarithmic or linear scale). Hovering or pinning any line shows its
   continuation on the board alongside a live statistics strip: current score,
   visits and share of search, neural-net policy prior, visit-rank trajectory
   (current rank vs. peak rank), when KataGo first searched it, and how many
   points its estimate drifted since its line began.
3. **How sharp or forgiving was each position? (`Choice Breadth` & `Current Candidate Values`)**
   Measures **Width** — the count of moves within `0.30` points of best — at
   every move in the game and saves both Width and candidate costs directly in
   the SGF. Five switchable statistical views (*focus-plus-tail*, *fixed bands*,
   *cumulative counts*, *rank landscapes*, and *decision summary*) distinguish
   only-move positions from broad, forgiving ones and reveal cliffs just behind
   the top choices.
4. **Who lost points on each move, and who was ahead? (`Move Quality` & `Game Status`)**
   Separates per-move point loss from cumulative score lead in two dedicated
   clickable charts. Both support **linear** and **log-base-2** scales (so
   half-point endgame inaccuracies stay readable beside 15-point blunders),
   full-game or sliding-window framing (default: last 40 moves), and automatic
   branch following.
5. **What did deeper reading find? (`Inherited values` & `Explored moves`)**
   Playing a move KataGo already searched starts the child position from that
   search immediately (`Visits: 80000 inherited`) until the child's own search
   surpasses it. Exploring a branch yourself and stepping back propagates your
   deeper evaluation back up to the parent move, even if the parent's search
   barely touched it. Revisiting any position keeps its deepest valid analysis
   instead of overwriting it with an early shallow report.

---

## Eval history: watching a search converge

![Hovering Lee Sedol's move 78 follows it in Eval history](docs/screenshots/eval-history-hover-l11.png)

_Hovering L11 previews its principal variation on the board and highlights its
curve in Eval history with values at each visits tick. The top band reports its
current value, visits and search share, neural-net policy prior, visit-rank
history (`11th`, peak `4th`), and drift since the line started._

* **Visits on the x-axis (log by default, toggleable to linear):** visits
  measure real search work independent of hardware speed or GPU contention; a
  log axis keeps both early tactical swings and long tail settling visible
  from 1,000 visits to multi-million-visit searches.
* **Player-to-move score on the y-axis:** up is always better for the side to
  move, and each line uses its move's board colour.
* **Dropped candidates stay visible:** any move that ever appeared on the board
  keeps its curve as a thin dashed line after dropping out of `Best + N`, so
  you can see *why* KataGo abandoned an attractive first-look move.
* **Hover and pin directly from labels:** hovering a line's label previews that
  move's continuation on the board even after it has left the board. Click a
  label to pin it; click again (or anywhere else in the chart) to release.
* **50-visit noise floor & retained history:** lines begin once a move reaches
  50 visits. Each search stores a compact history (a few hundred samples even
  for an hour-long run), and revisiting a position keeps showing the longer
  prior search until a new search overtakes it.
* **Resizable:** use Chart `−` / `+` on the Move Report bar to grow the card as
  tall as you want; its title bar shows total visits and elapsed time.

![Hovering E8's label in Eval history shows its continuation on the board](docs/screenshots/eval-history-label-hover-e8.png)

_Hovering E8's label in Eval history. E8 is no longer among Best + 5 (no board
circle, dashed curve), yet hovering its label still puts its continuation on
the board. The stats strip tells the story: a strong 17% policy prior and peak
2nd-most-searched status, eventually settling at 5th by visits and 1.35 points
behind P8._

## Move Report and whole-game statistics

![Move Report after 120 moves of Lee Sedol–AlphaGo Game 4](docs/screenshots/lee-sedol-alphago-game-4-move-120-report.png)

_The Move Report at move 120: move-by-move Move Quality, Choice Breadth (Width),
Game Status, the current position's candidate distribution, and the clickable
Next Move Options table._

* **Explicit perspective, unsigned losses:** score leads always state who is
  ahead (`B+2.30`, `W+0.50`), and verdicts report unsigned points thrown away
  against the best move (e.g., **MISTAKE** — `lost 3.20 pts vs best — best was
  D4 (5 lines away)`).
* **Move Quality vs. Game Status:** Move Quality draws one bar per move (White
  gains upward, Black downward); Game Status charts the running score lead
  separately. Both have labelled axes, linear / log-base-2 toggles,
  full-history / sliding-window toggles (default last 40 moves), branch
  tracking, and click-to-navigate.
* **Choice Breadth History & Current Candidate Values:** track how many good
  options exist at each move and in the current position. One persisted picker
  switches both cards across five complete views:
  * **Focus-plus-tail** — highlights moves inside the `0.30`-point Width band
    alongside tail bands for near-misses and steep drop-offs.
  * **Fixed bands** — groups candidates into fixed point-loss buckets.
  * **Cumulative counts** — shows how many moves stay within each loss bound.
  * **Rank landscapes** — plots point loss by candidate rank.
  * **Decision summary** — condenses sharpness and separation into a compact
    summary.
  Width and candidate costs are stored inside the SGF so full-game breadth
  charts reload intact when you reopen the file.
* **High-contrast, live-customizable layout:** reorderable, hideable cards
  (turn, last-move verdict, outcome change, Next Move Options, Eval history,
  comments, history charts), persistent player-name/rank strip from SGF
  headers, zero gray text (pure white on dark panels, pure black on light),
  and one unified six-step type scale driven by **Sizes → Info font** plus
  whole-UI zoom (`Ctrl+=`, `Ctrl+-`, `Ctrl+Shift+0`) and fullscreen
  (`Alt+Enter`).

## Candidate moves on the board

* **Loss labels (points or basis points):** circles show point loss versus the
  best move (`-0.67`) or hundredths of a point (`67`) with **Display → Use
  basis point display**, never raw visit counts. Being behind in the game never
  makes the best available move look bad; ties or low-visit flukes read `0.00`,
  never `+0.12`.
* **One best move, 50-visit stability gate:** the starred move is the highest-scoring
  candidate with at least 50 visits (`candidate_min_visits`), matching row 1 of
  Next Move Options and **Play best move**. Requiring 50 visits prevents
  noisy first visits from stealing the star or flickering in and out (cutting
  transient board flashes from 346 to 42 across 32 measured positions).
* **Two candidate selection modes (`Display → Candidate moves shown`):**
  * **Points from best** (`≤ 0.30` … `≤ 8.00`, or All; default `≤ 0.30`) shows
    every candidate within that point loss.
  * **Best + N moves** (`Best only` … `Best + 10 moves`; default N = 4) shows a
    fixed count of top options.
* **Every variation's next move (`Display → Show every variation's next move`, on by default):**
  always surfaces the game's played move and every explored variation's next
  move on the board and in Next Move Options, even outside the cutoff.
* **Explored moves (`Display → Mark explored moves`):** once you play and
  search a branch deeper than the parent search gave it, stepping back
  displays that deeper value (propagated recursively up explored lines) and
  optionally marks the candidate as a rounded square and tags it `explored` in
  Next Move Options.
* **Continuous colour gradients (`Display → Gradient`):** maps best-to-worst
  across the active cutoff (or down to the worst shown move, including the
  played move, in `Best + N` / `All` modes).

## Settings

![Settings open beside a live analysis of Lee Sedol–AlphaGo Game 4](docs/screenshots/settings-pane.png)

_Settings open during live analysis. The board and candidates remain active on
the left. The Analysis card shows that a 1,000,000-visit limit takes about 10
minutes at the engine's current 1,625 visits/s._

* Open with **File → Settings...** (`Ctrl+,`) or **⚙ settings** on the Move
  Report bar; close with `Esc`, `Ctrl+,`, or its close button.
* Collects every menu option plus formerly `config.json`-only keys (minimum
  visits to be best or in `Best + N`, move-number count, default rules and
  komi, variation-tree height) on one searchable page.
* Type numbers directly (`1,000,000`, `1m`, `250k`) or step presets with
  `−` / `+` and arrow keys. Changes apply and persist immediately without an
  Apply button.
* **Find** filters rows live; typing in fields never fires board hotkeys, while
  `Space` still toggles analysis.

## Analysis handling

* **Deepest analysis wins:** a node keeps its highest-visit valid result across
  revisits whenever engine, network, rules, komi, board state, move history,
  and search parameters match.
* **Inherited values:** playing into a candidate the parent already searched
  immediately shows the parent's evaluation and verdict (`Visits: N inherited`)
  until the child's own search catches up (accelerated by KataGo's tree cache).
* **Independent visit limit:** set any ponder visit cap in Settings or
  **Analysis → Ponder visits**; changes apply immediately to the running search.

## Capabilities from upstream Ogatak

* Direct Electron desktop GUI with zero external runtime dependencies beyond
  Electron and KataGo.
* Full SGF editor supporting handicaps, mid-game board edits, and NGF / GIB /
  UGI import.
* **Copy SGF** (`Ctrl+Shift+C`) with toast confirmation and **Paste SGF**
  (`Ctrl+Shift+V`).
* **Optional move numbers on stones** (**Display → Move numbers**, plus recent
  move count in Settings).
* Credits: built on [rooklift/ogatak](https://github.com/rooklift/ogatak),
  [KataGo](https://github.com/lightvector/KataGo), stone and board graphics
  modified from [Sabaki](https://github.com/SabakiHQ/Sabaki), and concepts from
  [Lizzie](https://github.com/featurecat/lizzie),
  [KaTrain](https://github.com/sanderland/katrain),
  [CGoban](https://www.gokgs.com/download.jsp), and
  [LizGoban](https://github.com/kaorahi/lizgoban).

## Setup

* Clone this repository and install Electron without modifying `package.json`:
  `cd src && npm install --no-save electron`.
* Run from the repository root with `src/node_modules/.bin/electron src` (the
  first install downloads the Electron binary).
* On Linux systems restricting unprivileged user namespaces (Ubuntu 24.04+),
  configure the SUID sandbox helper once after installing or updating Electron:
  `sudo chown root:root src/node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 src/node_modules/electron/dist/chrome-sandbox`
  (or pass `--no-sandbox`).
* Install KataGo and a network weights file separately, then set them under
  `Setup → Locate KataGo...` and `Setup → Choose network...`.
* Run the pure-logic test suite with plain Node (no Electron install needed):
  ```bash
  for f in src/*.js src/modules/*.js; do node --check "$f"; done
  for t in src/modules/*.test.js; do node "$t"; done
  ```
  GitHub Actions ([`.github/workflows/tests.yml`](.github/workflows/tests.yml))
  runs both checks on every push and pull request.

## Performance tips

* Per-move ownership (`Analysis` menu) is demanding; turn it off if the UI lags.
* Adjusting the engine report interval (`Setup` menu, default `0.1` s) trades
  update frequency for lower overhead.
* KataGo's `wide root noise` can slow sequential review or whole-file analysis
  due to cache interaction.
* Candidate visibility filters (`0.30` cutoff or `Best + N`) affect display
  only — KataGo still searches the full position.
* KataGo uses `analysis_example.cfg` by default unless you pick a custom config
  (some users prefer [KaTrain's analysis_config.cfg](https://github.com/sanderland/katrain/blob/master/katrain/KataGo/analysis_config.cfg)
  for faster throughput).

## Translations

Most menu items and GUI labels are translatable in
`src/modules/translations.js`. Thanks to translators ParmuzinAlexander,
CGLemon, and Bandysol.

## Upstream project contact

The upstream Ogatak author can often be found on the
[Computer Go Discord](https://discord.com/invite/5vacH5F).

## License

This fork remains licensed under the GNU Affero General Public License v3.0.
