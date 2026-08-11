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
   (The on-board colored candidate circles are stock behavior, kept.)
6. **The game's score history** — a labeled horizontal chart (x = move
   number, y = score lead) with axis ticks written as "B+10" / "0" /
   "W+10", the current position marked, filled regions showing who led.
   Click to jump to a move. This replaces the stock vertical strip graph.

## Layout: adjustable while playing (added 2026-08-11)

The first implementation let the panel stretch across whatever width the
window had; on a wide monitor the chart became a ribbon and the options
table spread its columns across the whole screen. Requirements now:

1. **The panel content is a fixed-width column** (default 640px), not a
   fluid fill. Empty space to its right is fine; unreadable stretched
   content is not.
2. **The panel is made of named sections** — `chart`, `turn`, `lastmove`,
   `outcome`, `options` — each with a small header carrying its own
   controls: move up (▲), move down (▼), hide (✕). Hidden sections appear
   as "+ name" chips in the controls bar, click to restore.
3. **Sizes are adjustable live from the panel itself**: a dim controls bar
   at the top offers text −/+ (font size), width −/+ (column width), and
   chart −/+ (chart height). No dialog, no restart, no menu digging.
4. **Every adjustment persists immediately** to Ogatak's `config.json`:
   `move_report_font_size`, `move_report_width`, `move_report_chart_height`,
   `move_report_sections` (an ordered array of the visible sections).
   Editing `config.json` by hand is an equally supported path — the array
   IS the template: reorder it, delete from it, and that's the layout.
5. **All text sizes are em-based** so the single font-size control scales
   the whole panel coherently.

Implementation: sections are stable DOM boxes reordered via flexbox
`order` (the chart canvas is never rebuilt); section content is diffed as
html strings and only written on change.

## What is removed

- The **game tree canvas**: not needed for this workflow (navigation is
  arrow keys, the new chart, and tabs). The tree code is intact but its
  canvas is hidden; variations still work, they're just not drawn.
- The **vertical winrate strip** next to the board and its drag handle:
  replaced by the labeled chart in the panel.

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
