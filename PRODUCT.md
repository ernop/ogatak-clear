# Product: the Move Report panel (local fork)

This file defines what our local Ogatak fork's analysis display must do and
why. It is the requirements source for `src/modules/move_report.js` and the
layout changes around it. Written 2026-08-11 from Ernest's requirements.

## Why (the problem with the stock display)

Stock Ogatak (and Lizzie, KaTrain, Sabaki, and nearly every Go GUI) shows
engine output in a form that requires constant mental translation:

- The winrate/score graph is a thin unlabeled strip: no axis, no legend, no
  units, unreadably small. You cannot glance at it and learn anything.
- Values are signed numbers whose meaning depends on whose turn it is and on
  a POV convention you have to remember ("it's W's turn now but B moved
  last, so for the score diff, negative means... so a positive number means
  B played well? ugh").
- There is no direct answer to the question the player actually has after
  every move: "how bad was that move, compared to the best available?"

That translation loop is a failed method of showing information. This fork
replaces it.

## The framework (rules every display element must follow)

1. **No bare signed numbers.** Every value is labeled with the color it
   favors: "B+2.30", "W+0.50", "B 61%". Point values use two decimal
   places when KataGo supplies them. A reader never converts a sign.
2. **Move quality is always "points thrown away by the player who moved",
   a number >= 0.** 0 = as good as the engine's best. It is never presented
   as a POV-dependent delta. Sub-point precision noise is clamped to 0.
3. **Perspective is stated, never implied.** "Whose turn" is shown as a
   stone and a word, not inferred from move parity.
4. **Everything readable at a glance**: real font sizes, labeled axes,
   color-coded verdicts. If an element needs explanation, it failed.
5. **Candidate values are relative to the best available move from here,
   never to the global board value.** (added 2026-08-11) If you are losing
   badly, the question is "from here, what's the best we can do" — the best
   available move is the reference point and displays as best, not as
   "very bad because the game is lost".
6. **Value differences among candidates use one continuous gradient from
   best to worst, never a special colour for the single top move.**
   (revised 2026-08-13) Best available = the gradient's start (default:
   top green), worst on the current scale = the end (default: dull red).
   When **Display → Distance from best** is a cutoff, that cutoff *is*
   the scale, so the range is known even as the user changes it. When
   that filter is All, the scale is the worst currently shown candidate.
   The palette is chosen from **Display → Gradient**. Moves within ~a
   point of each other may look similar; a clearly better move must be
   visibly different. Never a set of identical-looking options when one
   is clearly better. The stock Colours-menu top/off pair is available
   as the Gradient item "Classic (Colours menu)".

## What a glance at the screen must convey

1. **Whose turn it is now** — stone icon + "BLACK TO PLAY" / "WHITE TO
   PLAY", large, always present.
2. **Where the last move was** — highlighted on the board (stock behavior,
   kept) and stated in the panel: move number, color, coordinate.
3. **How good the last move was** — verdict word, color-coded, with the
   points it threw away vs the engine's best, AND how far (in board lines)
   it was from the engine's preferred point, naming that point:
   "MISTAKE — lost 3.20 pts. Best was D4 (5 lines away)."
   Scale: <0.5 excellent (green) / <1.5 good / <3 inaccuracy (yellow) /
   <6 mistake (orange) / >=6 blunder (red).
4. **How the last move changed the likely outcome** — before -> after in
   labeled form, both score and winrate: "B+3.20 -> B+1.10", "B 62% -> B 55%".
5. **Next move options and values, ongoing** — the engine's current top
   candidates as a readable table: move, resulting score ("B+2.30"),
   winrate ("B 61%"), visits, and a "costs" column (points worse than the
   top candidate, unsigned, per rule 2). Rows clickable to play the move.
   The on-board colored candidate circles are stock behavior, kept — but
   the number shown on them is "Delta" (points vs the best available
   move, 0 = best), NOT visits: the visit count is irrelevant as a
   top-level item on the highlights (2026-08-11). On-board circles show
   every candidate at most `cost_threshold` points worse than the best
   move, regardless of how many engine visits it received. The current
   threshold is 0.30.
6. **Quality of moves** — (respecified 2026-08-11: this is NOT a
   line graph) a bar chart, one bar per move, on a FIXED axis: up always
   means "White gained points", down always means "Black gained points" —
   the top is labeled "white gains" and the bottom "black gains" in all
   cases. Up does NOT mean "the mover gained": since root values assume
   best play, a mover can only lose points, so White's moves show as
   height zero (the perfect move) or down-bars, and Black's as zero or
   up-bars. Bar height = the points. Bars colored by who moved (grey =
   Black's moves, white = White's). Every bar fills its complete move
   slot, with no horizontal gap between adjacent moves. Move numbers run
   along the bottom. Show every number that fits; when they would overlap,
   show every second, third, fourth, etc. number as needed, always
   including the last move. The y scale is toggleable in the
   chart's own header between linear and log base 2 (position by
   log2(1 + pts), gridlines at powers of two), so one blunder doesn't
   flatten every ordinary move; the choice persists in config
   (`move_report_quality_yscale`). This chart answers only "how well were
   the moves played"; it says nothing about who is winning. Click a
   bar to jump to that move.
7. **Running game status** — a SEPARATE chart: who was winning at each
   point according to the AI. x = move number, y = score lead, axis ticks
   written as "W+10" / "0" / "B+10": White-ahead values are always above
   zero and Black-ahead values below it, matching the Move Quality chart's
   fixed White-up / Black-down direction. Its header has the same
   linear/log-base-2 toggle, with the same transform and power-of-two
   log ticks; the choice persists as `move_report_status_yscale`. Both
   charts share their centered-axis implementation, control placement,
   grid styling, current-position marker, and directional corner-label
   placement. The current position is marked, with filled regions showing
   who led. Click to jump to a move. Together with #6 this replaces the
   stock vertical strip graph; the two must never be merged, because "was
   that move good" and "who is winning" are different questions.
8. **Move Value Distribution** — a third, separate histogram of the
   engine-ranked top N candidate moves KataGo has reported for the current
   position. N defaults to 50, is directly editable in the chart header,
   redraws immediately, and persists as
   `move_report_distribution_top_n`. The chart always has exactly ten
   buckets. x = score points worse than the best move found so far, rounded
   to hundredths before binning. The first bar is labeled `top` and
   contains exactly the engine's first-ranked move; even another move tied
   at 0.00 belongs to the ranged buckets. The remaining nine buckets always
   use identical-width hundredth-point intervals. Their shared bucket width
   expands or contracts whenever the current top-N distribution changes.
   Empty buckets remain visible. y = the count of those top N moves in each
   range. This is independent of the six-row Next Move Options table and
   the on-board visit filter and Distance-from-best filter. Near-best
   bars use the selected gradient's start colour and progressively worse
   ranges walk toward its end. Counts appear on bars when
   space permits; axis labels thin automatically as bins narrow while
   retaining the `top` label and final range. The section is named
   `distribution`, appears after the other two charts by default, updates
   with every current-position analysis report, and uses the same live
   card-width dragger and chart-height controls.
9. **Width** — a number belonging to each analyzed game position:
   the count of all candidate moves whose score cost is at most 0.30 points
   worse than the engine's best found move at that position. Width uses all
   reported `moveInfos`, independent of Move Value Distribution's top-N
   display limit. Each accepted analysis snapshot stores width as the SGF
   node property `OGWI`, so the historical series survives save/load.
   Move Quality overlays that series: at every analyzed node on the current
   line, a small semi-transparent green point rises from the chart's center
   line on an independent positive-only scale and is labeled with its width
   integer. No connecting line is drawn. The overlay is labeled
   `width: moves ≤0.30` and never changes the Move Quality point-loss axis.

### Current-line semantics

Move Quality, its Width overlay, and Game Status contain the current node and its ancestors
on the currently selected variation — never unreached future nodes and
never values taken from the main line merely because it is the main
line. Neither switches to a fixed-size lookback window: both retain the
whole current line and make each move's column or line segment narrower
as the line grows. Rewinding shortens both charts. Advancing along the
same variation or playing a different variation extends them one reached
position at a time. Ogatak starts fresh analysis whenever the current
node changes; the charts redraw as that analysis arrives. Next Move
Options always comes only from the current position's fresh analysis.
Thus all displays describe the path the user is currently
traversing.

### Analysis snapshots must never regress

Each node retains the highest-visit analysis received for its exact
analysis context. Revisiting a node starts a new KataGo search at zero
MCTS visits, but early reports from that refresh must not replace a
stronger saved result. The refresh replaces the node snapshot only when
its root visit count reaches or exceeds the saved count. Late reports
from terminated queries obey the same rule.

Visit counts are compared only within a matching context fingerprint:
engine mode and identity, model, engine configuration, rules, komi,
board and move history, player, avoided/allowed moves, and search
overrides. A result from a changed context replaces the old context
without comparing visits because their visit counts are not comparable.
The accepted snapshot remains the source for Move Quality, Game Status,
Next Move Options, on-board candidates, and the SGF `SBKV` / `OGSC`
properties. Lower-visit refresh reports do not rewrite any of them.

This protects analysis within the current Ogatak process. KataGo's
neural-network evaluation cache also remains warm across queries, but
stock KataGo cannot resume a terminated MCTS tree. Full cross-root MCTS
continuation requires engine support beyond this snapshot rule.

### Pondering limit

Normal Space-key pondering uses the persisted `ponder_visits` setting,
not a source-code constant. It is selectable under **Analysis → Ponder
visits**, independently of `autoanalysis_visits`. The initial value is
1,000,000 to preserve earlier behavior; choices range from 1,000 to
5,000,000. The selected limit applies when the next normal analysis
query starts. Visit count controls analysis effort rather than elapsed
seconds, which varies with the position and hardware.

## Layout: the panel owns the whole right side (respecified 2026-08-11)

The first implementation let the panel stretch across whatever width the
window had; on a wide monitor the chart became a ribbon and the options
table spread its columns across the whole screen. The second fixed the
content width but left the panel inside the stock grid, which reserved a
permanent bottom strip for the comments box — so growing the content (or
zooming) squeezed the panel into a small box surrounded by dead space.
Requirements now:

1. **The panel container is everything right of the board, top to bottom,
   out to the window edge.** Nothing else reserves space in that region,
   and it re-flows on every window resize and zoom change. (The stock
   comments box used to reserve up to 256px of height at all times, even
   empty; it no longer can — see 3.)
2. **Sections are fixed-width cards in a wrapping flow.** Each card is
   `move_report_width` wide (default 640px, live-adjustable). On a wide
   panel, cards sit side by side and fill the width; on a narrow one they
   stack into a single scrollable column. Readable width everywhere, no
   stretched ribbons, no reserved dead space.
3. **The SGF comments box is a section** (`comments`) like any other:
   orderable, hideable, restorable from a chip. The stock comment drawer
   still owns the textarea's content; `comment_box_height` (Sizes menu)
   now sets the textarea's own height instead of carving a grid row out
   of the panel's space.
4. **Named sections, each with its own controls** — `quality`, `status`,
   `distribution`, `turn`, `lastmove`, `outcome`, `options`, `comments` — header buttons:
   move up (▲), move down (▼), hide (✕). Hidden sections appear as
   "+ name" chips in the controls bar, click to restore.
5. **Sizes are adjustable live from the panel itself**: a dim controls bar
   at the top offers text −/+ (font size), width −/+ (card width), and
   chart −/+ (chart height). Dragging the right edge of either chart also
   changes the shared card width continuously. No dialog, no restart, no
   menu digging.
6. **Every adjustment persists immediately** to Ogatak's `config.json`:
   `move_report_font_size`, `move_report_width`, `move_report_chart_height`,
   `move_report_sections` (an ordered array of the visible sections).
   The on-board candidate filter persists as `cost_threshold` (points worse
   than the best available move; current/default 0.30; 0 = All). Candidate
   visibility never depends on visits. The palette persists as
   `candidate_gradient`.
   Editing `config.json` by hand is an equally supported path — the array
   IS the template: reorder it, delete from it, and that's the layout.
7. **All text sizes are em-based** so the single font-size control scales
   the whole panel coherently.

Implementation: sections are stable DOM boxes reordered via flexbox
`order` in a `row wrap` flow (the chart canvases are never rebuilt);
section content is diffed as html strings and only written on change. The
comments textarea keeps its stock id and is adopted into its card at
startup, so the stock comment drawer and input handlers are untouched.

## What is removed

- The **game tree canvas**: not needed for this workflow (navigation is
  arrow keys, the new chart, and tabs). The tree code is intact but its
  canvas is hidden; variations still work, they're just not drawn.
- The **vertical winrate strip** next to the board and its drag handle:
  replaced by the labeled chart in the panel.
- The **comments box drag handle and its reserved grid rows**: comments
  are a panel section now; their height is a size setting, not a
  permanent claim on the panel's space.
- The **visit-percentage candidate filter**: low-visit moves can be strong
  options, so candidate visibility depends only on points worse than best.

## Data notes (for implementers)

- Ogatak requests all KataGo values with `reportAnalysisWinratesAs:
  "BLACK"` (`src/modules/query.js`), so `rootInfo.winrate` / `scoreLead`
  and every `moveInfos[]` entry are Black-POV. Convert to labeled form at
  the display layer only.
- Points lost by the move into node N = (N.parent root scoreLead) -
  (N root scoreLead), negated when the mover was White, clamped at 0.
  Root values assume best play, so this is "vs best". Works from stored
  SGF tags (SBKV/OGSC) too, so quality survives engine restarts; only the
  "best was <point>" detail needs the parent's full analysis in memory.
- The mover's best alternative = parent's `moveInfos[0]`. Distance is
  Chebyshev (max of dx, dy), reported as "lines".
- On-board candidate circles are filtered only by `cost_threshold`. The
  engine's first-ranked move is always shown. Every other move with a
  comparable score at or below the threshold appears, including
  symmetry-equivalent moves and candidates with few visits.
  `cost_threshold` is points worse than `moveInfos[0]`, from the side to
  play, matching the panel's costs column.
