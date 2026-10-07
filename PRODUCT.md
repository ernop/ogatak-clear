# Product: the Move Report panel (local fork)

This file defines what our local Ogatak fork's analysis display must do and
why. It is the requirements source for `src/modules/move_report.js` and the
layout changes around it. Written 2026-08-11 from Ernest's requirements.

Window chrome, pane show/hide, sizing, and restart-safe persistence live in
`PRODUCT-workspace.md`. That file wins when the two disagree about layout.

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

That repeated translation slows review and makes immediate comparison
difficult. This fork presents the same analysis in fixed, labeled frames of
reference.

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
   When **Display → Candidate moves shown** is a points cutoff, that
   cutoff *is* the scale, so the range is known even as the user changes
   it. When that filter is All or a move count, the scale is the worst
   currently shown candidate, including an added next move, so a played
   move that is worse than every candidate never shares their colour.
   The palette is chosen from **Display → Gradient**. Moves within ~a
   point of each other may look similar; a clearly better move must be
   visibly different. Never a set of identical-looking options when one
   is clearly better. The stock Colours-menu top/off pair is available
   as the Gradient item "Classic (Colours menu)".

## What a glance at the screen must convey

1. **Who is playing** — when the SGF provides `PB` or `PW`, a persistent
   player strip prominently shows both available names, ranks, stone colors,
   and which player is to move. Event, round, and result are secondary
   context. If neither player name exists, the strip is absent rather than
   displaying two large unknown placeholders.
   The layout keeps that priority at every panel width. Below 44em, the
   two players share a row only while every word of both names fits whole
   (otherwise they stack), and event, round, and result sit beneath them.
   From 44em, the event column sits between the players and takes at most
   30% of the width, leaving each name room for about ten letters per
   word. Below 44em a name breaks inside a word only when that word is
   wider than the whole strip. (Before 2026-10-07 the event column took
   its full one-line width first, so on the default 1333×780 window names
   rendered one letter per line.)
2. **Whose turn it is now** — stone icon + "BLACK TO PLAY" / "WHITE TO
   PLAY", large, always present.
3. **Where the last move was** — highlighted on the board (stock behavior,
   kept) and stated in the panel: move number, color, coordinate.
4. **How good the last move was** — verdict word, color-coded, with the
   points it threw away vs the engine's best, AND how far (in board lines)
   it was from the engine's preferred point, naming that point:
   "MISTAKE — lost 3.20 pts. Best was D4 (5 lines away)."
   Scale: <0.5 excellent (green) / <1.5 good / <3 inaccuracy (yellow) /
   <6 mistake (orange) / >=6 blunder (red).
5. **How the last move changed the likely outcome** — before -> after in
   labeled form, both score and winrate: "B+3.20 -> B+1.10", "B 62% -> B 55%".
6. **Next move options and values, ongoing** — the engine's current top
   candidates as a readable table: move, resulting score ("B+2.30"),
   winrate ("B 61%"), visits, and a "costs" column (points worse than the
   top candidate, unsigned, per rule 2, in the loss notation below). Rows
   clickable to play the move. Moves the user played and searched show
   that search's values (item 13, "Explored moves").
   The on-board colored candidate circles are stock behavior, kept — but
   the number shown on them is "Delta" (points lost vs the best available
   move), NOT visits: the visit count is irrelevant as a top-level item on
   the highlights (2026-08-11).
   Loss notation (2026-10-07): Delta and the costs column write a loss in
   hundredths of a point, unsigned, with no decimal point: 0.67 points
   worse than the best reads "67", 1.60 reads "160". A move that loses
   nothing, to the hundredth, reads "☻", including a move that scores
   better than the reference. The minus sign, leading zero, and decimal
   point carried no information: a shown loss is never negative, and the
   colour already says how bad it is, so a bigger number is simply worse.
   The loss is always the mover's, so "Numbers from Black's view" does not
   flip it. The filled ☻ rather than the outline ☺ because the outline
   face is too faint at board label size.
   **Display → Candidate moves shown** chooses which circles appear. It
   offers two kinds of cutoff in one menu; exactly one item is checked.
   Points cutoffs never depend on how many engine visits a move
   received; the move count's places have a small visit minimum (below).
   - *Points from best* (`≤ 0.30` … `≤ 8.00`, or All): every candidate
     at most that many points worse than the best move. Default 0.30.
   - *Move count* (`Best only`, `Best + 1 move` … `Best + 10 moves`;
     N defaults to 4) (2026-09-25): the engine's best move and the N
     lowest-cost other moves among those with at least
     `candidate_min_visits` visits (default 50). Fewer than N appear when
     fewer moves qualify — early in a search or in forced positions. The
     best move is shown however few visits it has. Rationale: a points
     cutoff shows a crowd of near-equal circles in quiet positions (19 at
     ≤ 0.50 in the opening that prompted this) and only one in sharp
     ones; a count always gives the same number of alternatives beside
     the move actually played.
     Visit minimum (2026-09-25, measured): a move's first few visits give
     a noisy score, often level with the best, so newly explored moves
     flashed into the N places for one report (~0.1 s) and vanished.
     Over 32 positions of Lee–AlphaGo game 4 at Best + 5, 346 of 566
     appearances vanished within a second, the median arriving on 1
     visit. A minimum of 50 left 42 (30 left 71; 100 left 29). Also
     admitting any move considered for 1 s was rejected: it re-admitted
     still-noisy moves and left 112.
   - *Every variation's next move* (2026-10-07): **Display → Show every
     variation's next move** (`always_show_next_move_eval`, default on)
     adds, in either mode, the next move of every line that continues
     from this position — the game's own next move and every variation —
     whenever it has a value: this position's search reported it, or the
     move was explored (item 13). It is drawn at that value however few
     visits it has; a move already shown is drawn once. Next Move Options
     lists the same moves after its first six, passes included. A move by
     the other colour is skipped (it is not one of this position's
     options), and a move with no value yet, never reported and never
     searched, is not drawn; Next move markers shows where it is. Off,
     the cutoff or count alone decides and the table shows its first six;
     an explored move then competes like any other move. Before
     2026-10-07 this item was "Always show next-move eval" and covered
     points cutoffs only, while move counts added these moves
     unconditionally; with the default on, the board is unchanged.
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
8. **Current Candidate Values** — a separate current-position detail view
   of candidate costs. It uses every candidate KataGo reported by default;
   its header accepts `all` or an engine-ranked top-N limit, persisted as
   `move_report_distribution_top_n` (`0` means all). The display always
   states how many candidates are shown and how many were reported, because
   “reported candidates” is knowable while “all available legal moves” is
   not. The view never silently clips a value tail.
9. **Choice Breadth History** — a separate historical chart rather than an
   overlay on Move Quality. It uses each current-line node's stored candidate
   costs and Width. Clicking navigates to that move; hovering reports exact
   Width, second-best cost, nearest value beyond 0.30, and stored coverage.
   Its x range follows Move Quality's full-history/sliding-window setting so
   the two charts remain directly alignable.
10. **Paired breadth views** — the global `breadth` picker switches Choice
   Breadth History and Current Candidate Values together and persists as
   `move_report_breadth_view`. Every mode is a complete representation:

   - `focus_tail`: historical count lines at 0.10, 0.30, and 1.00; current
     fixed-detail bins through 0.30 plus explicit 1/3/10-point tail bands and
     the nearest value outside 0.30.
   - `fixed_bands`: matching fixed score-cost bands in history and current:
     best, <=0.10, 0.10–0.30, 0.30–1, 1–3, 3–10, and >10.
   - `cumulative`: a historical threshold/count heatmap and current
     cumulative “moves within X points” step plot.
   - `rank`: a historical value-rank heatmap and current rank-versus-cost
     curve, with values above ten points explicitly pinned to the top.
   - `summary`: a historical forced/narrow/open/broad state strip and a
     current-position metric summary containing threshold counts, gaps,
     quantiles, and tail values.

11. **Width** — a number belonging to each analyzed game position:
   the count of all candidate moves whose score cost is at most 0.30 points
   worse than the engine's best found move at that position. Width uses all
   reported `moveInfos`, independent of Current Candidate Values' top-N
   display limit. It expresses how broad the strategic possibilities are:
   a sustained Width of 1 means that the path of near-best moves is narrow,
   while Width of 8 or more means that many competitive choices remain.
   Each accepted analysis snapshot stores width as SGF node property `OGWI`,
   so the historical series survives save/load. Each position also stores
   the score-ranked top 50 candidate costs in `OGWC`. These values belong
   only to Choice Breadth History; Move Quality remains a single-purpose
   chart with no Width or candidate overlays.
12. **Eval history** (2026-09-25, revised 2026-09-26) — how each candidate's
   value moved during this position's search, so a long search shows which
   moves are still "hot" and whether values are settling. A card (section
   `history`) holding one chart.
   - x is the search's total visits, log by default
     (`move_report_history_xscale`: `"log"` / `"linear"`, toggled in the
     card header), from 1,000 visits because the first second or so is
     mostly noise. Visits rather than time (2026-09-26): visits measure the
     search's actual progress, while time depends on the machine and on
     whatever else shares the GPU (the same kind of search ran at 666 and
     1,481 visits/s in two measurement runs). The header still shows elapsed
     time next to the visits.
   - y is each move's own score for the player to move: up is better for
     them. Every label is in "B+" / "W+" form, and the chart states the
     orientation ("↑ better for White (to play)").
   - Lines: every move drawn on the board at any point since the chart
     started keeps its line for the rest of the search (2026-09-26), drawn
     dashed once it has left the board, with a legend saying so. Board
     membership before 1,000 visits does not count: it only reflects which
     moves KataGo tried first. A move's line starts once it has
     `candidate_min_visits` visits (default 50). Lines use the board's
     gradient colours. At most 24 lines, on-board moves first, then by
     points worse than best; the followed move and the game's next move are
     always drawn.
   - Labels: every line is named (2026-09-26). A label sits just right of its
     line's end when there is room; otherwise on the line itself, as far
     right as there is room, on a dark backing; otherwise beside the end,
     moved to the nearest free spot with a leader line. Label text is the
     line's colour lifted toward white so it stays legible.
   - Hovering a candidate on the board follows that move: its line is drawn
     thick on top with the rest faded, its value is labelled at each visits
     tick ("after 10k visits it said…"), and the header gives the move, its
     value now, a "played" / "variation" tag when it is in the game record,
     its change since the chart started (▲ better / ▼ worse for the player
     to move), and its visits, noting when it is no longer on the board.
     The value comes straight after the move because a narrow card drops
     the header's last pieces first (2026-10-07).
   - The table of moves under the chart (value now, worse-by, sparkline,
     change, visits) was removed on 2026-09-26: the chart carries every line,
     and hovering gives exact numbers.
   - Each KataGo report is recorded under its query id, so every search of a
     position has its own history. The card shows the search that produced
     the displayed analysis, so like that analysis it never regresses to a
     fresher, shallower search; the header shows its visits and elapsed
     time, prefixed "stopped" once it is no longer running. Every report is
     kept for the first few seconds, then samples at least 4% of the elapsed
     time apart, so an hour-long search keeps a few hundred; the newest
     sample is always the latest report. The 40 most recently used searches
     stay in memory; histories are not saved to SGF.
13. **Explored moves** (2026-10-07) — at a position P, Ernest plays a move B
   himself, lets KataGo search the position after B (say 1,000 visits), and
   steps back. P must then show B at the value that search found. Before
   this, P showed only its own search's estimate of B, often from a handful
   of visits, or nothing at all when P's search never tried B.
   - The search after B stands in for P's estimate of B when: B is a single
     move by the side to move at P; both searches used the same KataGo
     executable, analysis config, network, rules, komi, board size, and
     override settings (values from different engines or rules are not
     comparable); the search after B had no avoid / allow restriction; and
     it has more visits than P's own search gave B, the same "more visits
     wins" rule a node uses for its own analyses. Otherwise P's own entry
     stands, and once P's search gives B more visits than the explored
     search had, P's own value returns. The engine version is not compared:
     it reads 1.0.0 until KataGo answers its version query, so a search
     started in that moment would otherwise never match.
   - An explored move takes that search's root result: score, winrate, and
     visits. Its line of play is B followed by that search's best line, its
     policy prior comes from P's search, and it carries that search's
     ownership map (shown with per-move ownership on). It has no LCB.
   - P's list keeps KataGo's order. An explored value replaces P's entry for
     the move in place; moves P's search never reported follow, most visits
     first.
   - The reference (cost 0, shown as ☻) stays P's best move, using its
     explored value when it was explored too. An explored move that scores
     better also costs 0 and shows ☻, like any move better than the
     reference (rule 5).
   - Shown in: board candidates, drawn like any other candidate
     (2026-10-07). An explored move is a move like any other, and its
     value means what every candidate's value means, KataGo's evaluation
     of the position after it, only from a bigger search. **Display → Mark
     explored moves** (`mark_explored_moves`, default off) draws explored
     moves as rounded squares, for anyone who wants the source visible on
     the board. Hovering one shows its line of play, its score, and
     "Visits: N explored" in the info bar. Labels: Delta, Score, Winrate,
     Visits, and Policy as usual; LCB and Visits (%) show "—"; Order shows
     P's rank when P's search ranked the move, otherwise "—". Next Move
     Options: the visits cell says "explored", since those visits belong
     to another search and are not part of P's total; moves played from P
     outside the first six are listed after them (item 6, "Every
     variation's next move"); a footnote explains the tag. Eval history: a
     square just right of the current visits (its value is not a point in
     P's search), linked by a dotted line to the move's own line when it has
     one, otherwise labelled; following it gives "■ value", "explored", and
     its visits.
   - Still P's own search only: Play best move, the candidate distribution,
     Width and the costs saved in the SGF (`OGWI` / `OGWC`), the stored score
     and winrate (`OGSC` / `SBKV`), and Eval history's lines.
   - Limits: explored values exist only while both analyses are in memory.
     Analyses are not saved to the SGF, so reopening a file drops them. Only
     P's direct children count; exploring further below B does not change
     B's value at P.
   - The presentation above (shapes, labels, header text, chart marker) is
     a first pass, to be tuned separately once the data path is settled
     (2026-10-07).
   - Logic: `src/modules/explored.js`, tested by `explored.test.js`.

### Current-line semantics

Move Quality, Choice Breadth History, and Game Status contain the current node and its ancestors
on the currently selected variation — never unreached future nodes and
never values taken from the main line merely because it is the main
line. Each chart independently toggles between full history and a sliding
window of the last N moves. N defaults to 40, is editable in that chart's
header, redraws immediately, and persists through
`move_report_quality_windowed`, `move_report_quality_window_n`,
`move_report_status_windowed`, and `move_report_status_window_n`. Before N
moves have been played, window mode shows the complete reached line. Move
numbers remain absolute rather than restarting at 1. Game Status includes
the position immediately before the first displayed move solely to draw
that move's incoming line segment. Move Quality and Choice Breadth History
share one quality-window range. Rewinding or changing
variation recalculates both ranges from the newly current line. Ogatak
starts fresh analysis whenever the current node changes; the charts redraw
as that analysis arrives. Next Move Options always comes only from the
current position's fresh analysis. Thus all displays describe the path the
user is currently traversing.

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
not a source-code constant. The initial value is 1,000,000, which keeps
the earlier behaviour. It is independent of `autoanalysis_visits`.
Visit count controls analysis effort rather than elapsed seconds,
which vary with the position and hardware.

- **Where it is set** (2026-09-26): typed in **Settings → Analysis →
  Visit limit per position** as any whole number from 2 to
  1,000,000,000, or picked from the presets under **Analysis → Ponder
  visits** (1,000 to 5,000,000). A typed value is added to that menu's
  list at the next start.
- **Time estimate:** Settings shows the time a limit takes at the
  engine's measured speed, but the setting itself stays in visits.
- **A new limit applies immediately** (2026-09-26, formerly "when the
  next query starts"): a running normal search restarts under it.
  - KataGo cannot resume a terminated search, so the new search
    starts from zero visits, but its neural-network cache is warm.
  - The snapshot rule below keeps the displayed analysis until the new
    search overtakes it.
  - Raising the limit therefore keeps the engine working toward the
    new target. Lowering it stops the old search at once; the
    replacement stops at the new limit.
  - Other modes (autoanalysis, self-play, engine play) use
    `autoanalysis_visits`, so their query is unchanged and nothing
    restarts.
- **Menu checkmark** (2026-09-26): the menu's checkmark follows the
  value. Until then it vanished after picking any preset of 1,000 or
  more, because the labels have thousands separators and the check
  sync compared them against the bare number.

## Layout: the panel owns the whole right side (respecified 2026-08-11)

The first implementation let the panel stretch across whatever width the
window had; on a wide monitor the chart became a ribbon and the options
table spread its columns across the whole screen. The second fixed the
content width but left the panel inside the stock grid, which reserved a
permanent bottom strip for the comments box — so growing the content (or
zooming) squeezed the panel into a small box surrounded by dead space.
Requirements now:

1. **The panel container is everything right of the board, top to bottom,
   out to the window edge**, except other panes the user has chosen to
   show there (variation tree, etc. — `PRODUCT-workspace.md`). Nothing
   silently reserves a grid row. The region re-flows on window resize
   and zoom; saved pane sizes are the persistence model, not leftover
   space.
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
4. **Named sections, each with its own controls** — `quality`, `breadth`,
   `status`, `distribution`, `turn`, `lastmove`, `outcome`, `options`, `history`,
   `comments`, `tree` — header buttons: move up (▲), move down (▼), hide (✕). Hidden
   sections appear as "+ name" chips in the controls bar, click to restore.
   The variation tree is default-hidden; see `PRODUCT-workspace.md`.
5. **Layout sizes are adjustable live from the panel itself**: a dim
   controls bar at the top offers width −/+ (card width) and chart −/+
   (chart height). Dragging the right edge of either chart also changes
   the shared card width continuously. No dialog, no restart, no menu
   digging. **Text size is deliberately NOT panel-local**: the panel
   follows the app-wide `info_font_size` (Sizes → Info font), the same
   setting as the board info bar, comments, and root editor, so the two
   sides of the window can never drift apart typographically. All new
   work must use this existing font management system — never introduce
   a separate font-size setting or control.
6. **Every adjustment persists immediately** to Ogatak's `config.json`:
   `move_report_width`, `move_report_chart_height`,
   `move_report_sections` (an ordered array of the visible sections).
   The on-board candidate filter persists as `candidate_filter` (`"cost"`
   or `"count"`), `cost_threshold` (points worse than the best available
   move; default 0.30; 0 = All), and `candidate_count` (moves beyond the
   best in count mode; default 4; a hand-edited N is added to the menu),
   and `candidate_min_visits` (count mode's visit minimum; default 50;
   0 = none; config.json only). Points cutoffs never depend on visits.
   With **Display → Show every variation's next move** on
   (`always_show_next_move_eval`, default true), the next move of every
   variation from this node is also drawn when it has a value, in either
   mode, even when it is worse than the cutoff, and is listed in Next
   Move Options. **Display → Mark explored moves** persists as
   `mark_explored_moves` (default false). The palette persists as
   `candidate_gradient`.
   Editing `config.json` by hand is an equally supported path — the array
   IS the template: reorder it, delete from it, and that's the layout.
7. **All text sizes come from the app's six-step type scale** (hero /
   emph / body / ui / caption / fine — see `src/modules/type_scale.js`
   and agents.md "UI conventions"), each a fixed multiple of the single
   app-wide font setting (`info_font_size`), so the whole panel —
   including canvas chart labels — scales coherently with one control.
   Ad-hoc font sizes and inline styles are forbidden.

Implementation: sections are stable DOM boxes reordered via flexbox
`order` in a `row wrap` flow (the chart canvases are never rebuilt);
section content is diffed as html strings and only written on change. The
comments textarea keeps its stock id and is adopted into its card at
startup, so the stock comment drawer and input handlers are untouched.

## What is removed

- The **vertical winrate strip** next to the board and its drag handle:
  replaced by the labeled chart in the panel.
- The **comments box drag handle and its reserved grid rows**: comments
  are a panel section now; their height is a size setting, not a
  permanent claim on the panel's space.
- The **visit-percentage candidate filter**: low-visit moves can be strong
  options, so candidate visibility depends only on points worse than best.
  Count mode's small fixed visit minimum is not a return of that filter:
  it only stops a move's first noisy visits from claiming one of the N
  places, and never hides the best or the played move.

The **variation tree** is not removed. It is a hideable pane (section id
`tree`), default hidden, restored from the Move Report chip list. See
`PRODUCT-workspace.md`.

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
- On-board candidate circles are selected only by score cost
  (`utils.select_candidates`, tested in `src/modules/utils.test.js`).
  The engine's first-ranked move, `moveInfos[0]`, is always shown and is
  the cost reference: cost is points worse than it, from the side to
  play, clamped at 0, matching the panel's costs column. With a points
  cutoff, every other move with a comparable score at or below
  `cost_threshold` appears, including symmetry-equivalent moves and
  candidates with few visits. In count mode the `candidate_count`
  lowest-cost other moves with at least `candidate_min_visits` visits
  appear; ties (including every move clamped to
  0) keep engine order, moves without a scoreLead rank last, and passes
  are skipped because they cannot be drawn. Child-node moves by the side
  to move that have a value are added in either mode when
  `always_show_next_move_eval` is on, so a played blunder still shows its
  Delta (`utils.board_candidates`; Next Move Options' rows come from
  `utils.options_table_infos`, both tested in `explored.test.js`).
