# Screenshot game

`lee-sedol-vs-alphago-game-4.sgf` is Game 4 of the Google DeepMind
Challenge Match:

- Black: AlphaGo
- White: Lee Sedol 9p
- Date: March 13, 2016
- Result: White won by resignation after 180 moves
- Location: Four Seasons Hotel, Seoul

Lee Sedol's move 78 and the sequence that followed made this the only game
AlphaGo lost in the five-game match.

The unmodified game record was downloaded from the
[CWI AlphaGo game archive](https://homepages.cwi.nl/~aeb/go/games/games/AlphaGo/LeeSedol/4.sgf).
It is included to make the README screenshots reproducible.

`lee-sedol-vs-alphago-game-4-analyzed.sgf` contains the score, win-rate,
Width, and score-ranked top-50 candidate-cost properties generated for the
screenshots. All 181 positions, including the empty starting board, received
at least 2,500 KataGo visits. Move 120 received 10,000 visits for its
current-position displays. Full candidate records are not stored in SGF, so
Current Candidate Values and Eval history still require live analysis after
reopening the file. The file was regenerated the same way on 2026-10-12, so
each position's saved score and win rate are its best move's
([PRODUCT.md](../../PRODUCT.md), "One best move") rather than KataGo's root
average; the two differ by about half a point per position on average.

The three move-78 screenshots (the position just before Lee Sedol's move 78)
were taken on 2026-10-08 from one live search of three and a half minutes,
142,000 visits (the GPU was shared with another KataGo), with the earlier
version of this analyzed file loaded and
**Display → Candidate moves shown** set to `Best + 5 moves`. Another search of the same position with the same engine
settings, run just before it, ended with N7 as KataGo's top
move instead of P8 and with 140,000 visits. At this depth, moves within about
half a point of each other can swap places from one search to the next.
