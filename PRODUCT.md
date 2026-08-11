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
   favors: "B+2.3", "W+0.5", "B 61%". A reader never converts a sign.
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
6. **Value differences among candidates use one pure green gradient that
   spends much of its brightness range.** (added 2026-08-11) Best available
   = brightest green, scaling down by points worse. Moves within ~a point
   of each other may look similar; a clearly better move must be visibly
   brighter than the rest. Never a set of identical-looking options when
   one is clearly better.

## What a glance at the screen must convey

1. **Whose turn it is now** — stone icon + "BLACK TO PLAY" / "WHITE TO
   PLAY", large, always present.
2. **Where the last move was** — highlighted on the board (stock behavior,
   kept) and stated in the panel: move number, color, coordinate.
3. **How good the last move was** — verdict word, color-coded, with the
   points it threw away vs the engine's best, AND how far (in board lines)
   it was from the engine's preferred point, naming that point:
   "MISTAKE — lost 3.2 pts. Best was D4 (5 lines away)."
   Scale: <0.5 excellent (green) / <1.5 good / <3 inaccuracy (yellow) /
   <6 mistake (orange) / >=6 blunder (red).
4. **How the last move changed the likely outcome** — before -> after in
   labeled form, both score and winrate: "B+3.2 -> B+1.1", "B 62% -> B 55%".
5. **Next move options and values, ongoing** — the engine's current top
   candidates as a readable table: move, resulting score ("B+2.3"),
   winrate ("B 61%"), visits, and a "costs" column (points worse than the
   top candidate, unsigned, per rule 2). Rows clickable to play the move.
   The on-board colored candidate circles are stock behavior, kept — but
   the number shown on them is "Delta" (points vs the best available
   move, 0 = best), NOT visits: the visit count is irrelevant as a
   top-level item on the highlights (2026-08-11). Engine effort still
   shows as circle opacity and in the panel's visits column.
6. **Quality of recent moves** — (respecified 2026-08-11: this is NOT a
   line graph) a bar chart, one bar per move: up = the move gained points
   vs the prior estimate, down = it lost points, bar height = the points.
   Bars colored by who moved (grey = Black's moves, white = White's).
   This chart answers only "how well were recent moves played"; it says
   nothing about who is winning. Click a bar to jump to that move.
7. **Running game status** — a SEPARATE chart: who was winning at each
   point according to the AI. x = move number, y = score lead, axis ticks
   written as "B+10" / "0" / "W+10", current position marked, filled
   regions showing who led. Click to jump to a move. Together with #6 this
   replaces the stock vertical strip graph; the two must never be merged,
   because "was that move good" and "who is winning" are different
   questions.

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
   `turn`, `lastmove`, `outcome`, `options`, `comments` — header buttons:
   move up (▲), move down (▼), hide (✕). Hidden sections appear as
   "+ name" chips in the controls bar, click to restore.
5. **Sizes are adjustable live from the panel itself**: a dim controls bar
   at the top offers text −/+ (font size), width −/+ (card width), and
   chart −/+ (chart height). No dialog, no restart, no menu digging.
6. **Every adjustment persists immediately** to Ogatak's `config.json`:
   `move_report_font_size`, `move_report_width`, `move_report_chart_height`,
   `move_report_sections` (an ordered array of the visible sections).
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
