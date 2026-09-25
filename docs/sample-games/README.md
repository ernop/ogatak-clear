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
reopening the file.

The three move-78 screenshots (the position just before Lee Sedol's move 78)
were taken from one live search of about three minutes, 270,000–300,000
visits, with **Display → Candidate moves shown** set to `Best + 5 moves`.
