"use strict";

const assert = require("assert");
const {select_candidates, candidate_count_label} = require("./utils");

// Black to play; scoreLead is Black-POV, so cost = best lead - lead.
let infos = [
	{move: "A1", scoreLead: 5.0},		// best (reference), cost 0
	{move: "B1", scoreLead: 4.9},		// 0.10
	{move: "C1", scoreLead: 3.0},		// 2.00
	{move: "D1", scoreLead: 4.95},		// 0.05
	{move: "E1", scoreLead: 4.5},		// 0.50
	{move: "F1", scoreLead: 5.2},		// better than best, clamped to 0
	{move: "pass", scoreLead: 4.99},	// 0.01, but can't be drawn
	{move: "H1", scoreLead: 4.0},		// 1.00
];
let moves = (sel) => sel.infos.map(info => info.move);
let count = (n) => ({mode: "count", threshold: 0.3, count: n});

let top4 = select_candidates(infos, true, null, count(4));
assert.deepStrictEqual(moves(top4), ["A1", "B1", "D1", "E1", "F1"]);
assert.strictEqual(top4.scale, 0.5);
assert.strictEqual(top4.costs.length, top4.infos.length);

let played = select_candidates(infos, true, {C1: true}, count(4));
assert.deepStrictEqual(moves(played), ["A1", "B1", "C1", "D1", "E1", "F1"]);
assert.strictEqual(played.scale, 2.0);			// A worse played move extends the scale rather than sharing E1's colour.

let already_in = select_candidates(infos, true, {D1: true}, count(4));
assert.deepStrictEqual(moves(already_in), moves(top4));

assert.deepStrictEqual(moves(select_candidates(infos, true, {H1: true}, count(0))), ["A1", "H1"]);
assert.deepStrictEqual(moves(select_candidates(infos, true, null, count(2))), ["A1", "D1", "F1"]);
assert.deepStrictEqual(moves(select_candidates(infos, true, null, count(99))), ["A1", "B1", "C1", "D1", "E1", "F1", "H1"]);
assert.strictEqual(select_candidates(infos, true, null, count(99)).scale, 2.0);

// White to play: lower Black-POV lead is better for the mover.
let white_infos = [
	{move: "A1", scoreLead: -3.0},		// best
	{move: "B1", scoreLead: -2.0},		// 1.00
	{move: "C1", scoreLead: -2.9},		// 0.10
	{move: "D1", scoreLead: -1.0},		// 2.00
];
assert.deepStrictEqual(moves(select_candidates(white_infos, false, null, count(1))), ["A1", "C1"]);
let white = select_candidates(white_infos, false, null, count(2));
assert.deepStrictEqual(moves(white), ["A1", "B1", "C1"]);
assert.strictEqual(white.scale, 1.0);

// Moves better than the reference are clamped to cost 0 and so rank by engine order.
assert.deepStrictEqual(moves(select_candidates(infos, false, null, count(2))), ["A1", "B1", "C1"]);

// Ties keep engine order; moves without scoreLead rank last, in engine order.
let tied = [
	{move: "A1", scoreLead: 1},
	{move: "B1", scoreLead: 0.5},
	{move: "C1", scoreLead: 0.5},
	{move: "D1"},
	{move: "E1", scoreLead: 0.5},
];
assert.deepStrictEqual(moves(select_candidates(tied, true, null, count(2))), ["A1", "B1", "C1"]);
assert.deepStrictEqual(moves(select_candidates(tied, true, null, count(4))), ["A1", "B1", "C1", "D1", "E1"]);
let no_scores = [{move: "A1"}, {move: "B1"}, {move: "C1"}];
assert.deepStrictEqual(moves(select_candidates(no_scores, true, null, count(1))), ["A1", "B1"]);
assert.strictEqual(select_candidates(no_scores, true, null, count(1)).scale, 0.5);

// Cost mode is unchanged: cutoff = scale, passes count, next move added past the cutoff.
let cut = select_candidates(infos, true, {C1: true}, {mode: "cost", threshold: 0.3, count: 4});
assert.deepStrictEqual(moves(cut), ["A1", "B1", "C1", "D1", "F1", "pass"]);
assert.strictEqual(cut.scale, 0.3);
let all = select_candidates(infos, true, null, {mode: "cost", threshold: 0, count: 4});
assert.strictEqual(all.infos.length, infos.length);
assert.strictEqual(all.scale, 2.0);

assert.deepStrictEqual(select_candidates([], true, null, count(4)), {infos: [], costs: [], scale: 0.5});

// Count mode's places need min_visits; the best and the played move are shown however few they have.
let noisy = [
	{move: "A1", scoreLead: 5.0, visits: 30},		// best
	{move: "B1", scoreLead: 5.0, visits: 2},		// looks as good as best on 2 visits
	{move: "C1", scoreLead: 4.8, visits: 400},		// 0.20
	{move: "D1", scoreLead: 4.5, visits: 50},		// 0.50, exactly at the minimum
	{move: "E1", scoreLead: 4.0, visits: 49},		// 1.00, one short
	{move: "F1", scoreLead: 3.0, visits: 1},		// played, 2.00
];
let gated = (n, min_visits, next = null) => select_candidates(noisy, true, next, {mode: "count", threshold: 0.3, count: n, min_visits});
assert.deepStrictEqual(moves(gated(5, 50, {F1: true})), ["A1", "C1", "D1", "F1"]);
assert.deepStrictEqual(moves(gated(1, 50)), ["A1", "C1"]);
assert.deepStrictEqual(moves(gated(2, 0)), ["A1", "B1", "C1"]);
assert.deepStrictEqual(moves(select_candidates(noisy, true, null, {mode: "cost", threshold: 0.3, count: 5, min_visits: 50})), ["A1", "B1", "C1"]);

assert.strictEqual(candidate_count_label(0), "Best only");
assert.strictEqual(candidate_count_label(1), "Best + 1 move");
assert.strictEqual(candidate_count_label(4), "Best + 4 moves");

console.log("utils tests passed");
