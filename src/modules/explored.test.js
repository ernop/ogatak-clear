"use strict";

const assert = require("assert");

global.config = {};

const new_node = require("./node");
const {ANALYSIS_CONTEXT_PROPERTY, analysis_context} = require("./query");
const {same_settings, merge, child_results, node_infos} = require("./explored");
const {select_candidates, next_move_gtp_set, board_candidates, options_table_infos} = require("./utils");

const ENGINE = {mode: "analysis", filepath: "/k/katago", engineconfig: "/k/a.cfg", weights: "/k/net.bin.gz", version: [1, 16, 0]};

function context(moves, changes = {}, engine = ENGINE) {
	let query = {
		rules: "chinese",
		komi: 7.5,
		boardXSize: 19,
		boardYSize: 19,
		initialStones: [],
		moves: moves,
		overrideSettings: {reportAnalysisWinratesAs: "BLACK", wideRootNoise: 0.04},
	};
	return analysis_context(Object.assign(query, changes), engine);
}

let moves = (infos) => infos.map(info => info.move);

// ------------------------------------------------------------------------------------------------
// same_settings: everything but the position must match, and the child must search freely.

let at_p = context([["B", "Q16"]]);
let at_b = context([["B", "Q16"], ["W", "D4"]]);

assert.strictEqual(same_settings(at_p, at_b), true);
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {komi: 6.5})), false);
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {rules: "japanese"})), false);
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {overrideSettings: {reportAnalysisWinratesAs: "BLACK", wideRootNoise: 0}})), false);
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {}, Object.assign({}, ENGINE, {weights: "/k/other.bin.gz"}))), false);
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {}, Object.assign({}, ENGINE, {engineconfig: "/k/b.cfg"}))), false);
assert.strictEqual(same_settings(context([["B", "Q16"]], {}, Object.assign({}, ENGINE, {version: [1, 0, 0]})), at_b), true);	// Searched before KataGo reported its version.
assert.strictEqual(same_settings(at_p, context([["B", "Q16"], ["W", "D4"]], {avoidMoves: [{player: "B", moves: ["C3"], untilDepth: 1}]})), false);
assert.strictEqual(same_settings(context([["B", "Q16"]], {avoidMoves: [{player: "W", moves: ["C3"], untilDepth: 1}]}), at_b), true);
assert.strictEqual(same_settings(at_p, "not json"), false);
assert.strictEqual(same_settings(null, at_b), false);

// ------------------------------------------------------------------------------------------------
// merge: more visits wins, in place; unreported moves follow, most visits first.

let A = {move: "A1", order: 0, visits: 1500, winrate: 0.60, scoreLead: 3.0, prior: 0.30, lcb: 0.59, pv: ["A1", "B2"]};
let C = {move: "C1", order: 1, visits: 300, winrate: 0.55, scoreLead: 2.0, prior: 0.20, lcb: 0.53, pv: ["C1"]};
let D = {move: "D1", order: 2, visits: 100, winrate: 0.50, scoreLead: 1.5, prior: 0.10, lcb: 0.45, pv: ["D1"]};
let parent = [A, C, D];
let result = (move, visits, scoreLead, pv = ["Z9"]) => ({move, visits, winrate: 0.5, scoreLead, scoreSelfplay: scoreLead + 0.5, pv, ownership: null});

assert.strictEqual(merge(parent, []).length, 3);
merge(parent, []).forEach((info, i) => assert.strictEqual(info, parent[i]));

let unreported = merge(parent, [result("B1", 1000, 2.5, ["E5", "F6"])], move => move === "B1" ? 0.004 : undefined);
assert.deepStrictEqual(moves(unreported), ["A1", "C1", "D1", "B1"]);
assert.strictEqual(unreported[0], A);
assert.deepStrictEqual(unreported[3], {
	move: "B1", order: 3, visits: 1000, winrate: 0.5, scoreLead: 2.5, scoreSelfplay: 3.0,
	pv: ["B1", "E5", "F6"], prior: 0.004, explored: {own: null},
});

let replaced = merge(parent, [result("C1", 1000, 2.6)]);
assert.deepStrictEqual(moves(replaced), ["A1", "C1", "D1"]);
assert.strictEqual(replaced[1].scoreLead, 2.6);
assert.strictEqual(replaced[1].visits, 1000);
assert.strictEqual(replaced[1].order, 1);
assert.strictEqual(replaced[1].prior, 0.20);
assert.strictEqual(replaced[1].explored.own, C);
assert.strictEqual(replaced[1].lcb, undefined);			// The child's search reports no LCB for the move.

let weaker = merge(parent, [result("A1", 1000, 2.0)]);
assert.strictEqual(weaker[0], A);						// The parent searched A1 more than its child search did.
assert.strictEqual(merge(parent, [result("C1", 300, 9)])[1], C);		// Ties keep the parent's own entry.

let best_explored = merge(parent, [result("A1", 4000, 2.9)]);
assert.strictEqual(best_explored[0].explored.own, A);
assert.strictEqual(best_explored[0].order, 0);

let several = merge(parent, [result("B1", 800, 1), result("E1", 2000, 1), result("B1", 1200, 2), result("F1", 0, 5), result("G1", NaN, 5)]);
assert.deepStrictEqual(moves(several), ["A1", "C1", "D1", "E1", "B1"]);
assert.strictEqual(several[4].visits, 1200);
assert.strictEqual(several[4].scoreLead, 2);
assert.strictEqual(several[3].prior, undefined);

// ------------------------------------------------------------------------------------------------
// Real nodes: the user plays W D4 at P, searches it, and comes back to P.

function analyse(node, ctx, o) {
	Object.defineProperty(o, ANALYSIS_CONTEXT_PROPERTY, {value: ctx, enumerable: false});
	assert.strictEqual(node.receive_analysis(o), true);
}

function child(parent_node, key, value) {
	let node = new_node(parent_node);
	node.set(key, value);
	return node;
}

let policy = new Array(19 * 19 + 1).fill(0.001);
policy[15 * 19 + 3] = 0.05;				// D4 is "dp": x 3, y 15.
policy[19 * 19] = 0.0001;				// pass

let root = new_node();
root.set("SZ", "19");
let p = child(root, "B", "pd");			// Q16; White to play at p.

assert.deepStrictEqual(node_infos(p), []);

analyse(p, at_p, {
	id: "p", rootInfo: {visits: 2000, winrate: 0.45, scoreLead: 1.0},
	moveInfos: [
		{move: "Q4", order: 0, visits: 1500, winrate: 0.44, scoreLead: 0.8, prior: 0.2, pv: ["Q4", "D16"]},
		{move: "D16", order: 1, visits: 400, winrate: 0.45, scoreLead: 1.1, prior: 0.2, pv: ["D16"]},
	],
	policy,
});

assert.strictEqual(node_infos(p), p.analysis.moveInfos);		// No explored children yet.

let d4 = child(p, "W", "dp");
analyse(d4, at_b, {
	id: "d4", rootInfo: {visits: 1000, winrate: 0.47, scoreLead: 1.0, scoreSelfplay: 1.3},
	moveInfos: [{move: "Q3", order: 0, visits: 700, winrate: 0.47, scoreLead: 0.6, pv: ["Q3", "R4"]}],
	ownership: [0.5],
});

let other_komi = child(p, "W", "dd");		// D16, but searched at a different komi.
analyse(other_komi, context([["B", "Q16"], ["W", "D16"]], {komi: 6.5}), {
	id: "dd", rootInfo: {visits: 5000, winrate: 0.4, scoreLead: 2.0}, moveInfos: [{move: "Q4", order: 0, visits: 5000, pv: []}],
});

child(p, "W", "cc");						// C17, played but never searched.

let edited = child(p, "W", "qc");			// R17 plus setup stones: not a plain move.
edited.set("AB", "aa");
analyse(edited, context([["B", "Q16"], ["W", "R17"]]), {
	id: "qc", rootInfo: {visits: 9000, winrate: 0.4, scoreLead: 2.0}, moveInfos: [{move: "Q4", order: 0, visits: 9000, pv: []}],
});

let wrong_colour = child(p, "B", "dc");		// Black playing twice is not one of White's options here.
analyse(wrong_colour, context([["B", "Q16"], ["B", "D17"]]), {
	id: "dc", rootInfo: {visits: 9000, winrate: 0.4, scoreLead: 2.0}, moveInfos: [{move: "Q4", order: 0, visits: 9000, pv: []}],
});

let passed = child(p, "W", "");
analyse(passed, context([["B", "Q16"], ["W", "pass"]]), {
	id: "pass", rootInfo: {visits: 300, winrate: 0.9, scoreLead: 9.0}, moveInfos: [{move: "D4", order: 0, visits: 300, pv: ["D4"]}],
});

assert.deepStrictEqual(child_results(p).map(r => [r.move, r.visits]), [["D4", 1000], ["pass", 300]]);

let infos = node_infos(p);
assert.deepStrictEqual(moves(infos), ["Q4", "D16", "D4", "pass"]);
assert.strictEqual(infos[0], p.analysis.moveInfos[0]);
assert.deepStrictEqual(infos[2], {
	move: "D4", order: 2, visits: 1000, winrate: 0.47, scoreLead: 1.0, scoreSelfplay: 1.3,
	pv: ["D4", "Q3", "R4"], prior: 0.05, explored: {own: null}, ownership: [0.5],
});
assert.strictEqual(infos[3].prior, 0.0001);

// With every variation's next move shown (the default), the explored move is drawn.
// White to play, so a higher Black-POV lead costs White: D4 leaves Black 0.2 more than Q4.

let shown = select_candidates(infos, false, next_move_gtp_set(p), {mode: "count", threshold: 0.3, count: 0, min_visits: 50});
assert.deepStrictEqual(moves(shown.infos), ["Q4", "D16", "D4"]);
assert.ok(Math.abs(shown.costs[2] - 0.2) < 1e-9);

// Searching D4 longer from P itself takes the explored value back out.

analyse(p, at_p, {
	id: "p2", rootInfo: {visits: 9000, winrate: 0.45, scoreLead: 1.0},
	moveInfos: [
		{move: "Q4", order: 0, visits: 6000, winrate: 0.44, scoreLead: 0.8, prior: 0.2, pv: ["Q4"]},
		{move: "D4", order: 1, visits: 1800, winrate: 0.46, scoreLead: 0.7, prior: 0.05, pv: ["D4"]},
	],
	policy,
});
assert.strictEqual(node_infos(p)[1], p.analysis.moveInfos[1]);
assert.strictEqual(node_infos(p)[1].explored, undefined);

// ------------------------------------------------------------------------------------------------
// Every variation's next move (always_show_next_move_eval): added to the board in either filter
// mode and listed in Next Move Options after the first six. Off, the filter and the first six
// alone decide, and an explored move competes like any other move.

let q = child(root, "B", "dd");				// D16; White to play at q.
let q_moves = ["Q16", "Q4", "D4", "R16", "C4", "Q17", "R4", "C17"];

analyse(q, context([["B", "D16"]]), {
	id: "q", rootInfo: {visits: 5000, winrate: 0.5, scoreLead: 0.5},
	moveInfos: q_moves.map((move, i) => ({move, order: i, visits: 1000 - 100 * i, winrate: 0.5, scoreLead: 0.5 + 0.4 * i, prior: 0.1, pv: [move]})),
	policy,
});

child(q, "W", "cc");						// C17: q's eighth move, played but never searched.
child(q, "W", "jj");						// K10: never reported or searched, so it has no value.
child(q, "B", "qp");						// R4 by Black: not one of White's options.
analyse(child(q, "W", "jp"), context([["B", "D16"], ["W", "K4"]]), {		// K4: explored, 0.2 worse than Q16.
	id: "k4", rootInfo: {visits: 1000, winrate: 0.5, scoreLead: 0.7}, moveInfos: [{move: "Q16", order: 0, visits: 600, pv: ["Q16"]}],
});
analyse(child(q, "W", ""), context([["B", "D16"], ["W", "pass"]]), {
	id: "q-pass", rootInfo: {visits: 300, winrate: 0.9, scoreLead: 9.0}, moveInfos: [{move: "Q16", order: 0, visits: 300, pv: ["Q16"]}],
});

assert.deepStrictEqual(Object.keys(next_move_gtp_set(q)).sort(), ["C17", "K10", "K4"]);
assert.deepStrictEqual(Object.keys(next_move_gtp_set(q, true)).sort(), ["C17", "K10", "K4", "pass"]);
assert.deepStrictEqual(moves(node_infos(q)), q_moves.concat(["K4", "pass"]));

let on_board = (settings) => {
	Object.assign(config, settings);
	return moves(board_candidates(q).infos);
};
let best_plus = (n) => ({candidate_filter: "count", candidate_count: n, candidate_min_visits: 50});
let within = (points) => ({candidate_filter: "cost", cost_threshold: points});

config.always_show_next_move_eval = true;
assert.deepStrictEqual(on_board(best_plus(0)), ["Q16", "C17", "K4"]);
assert.deepStrictEqual(on_board(within(0.3)), ["Q16", "C17", "K4"]);
assert.deepStrictEqual(moves(options_table_infos(q)), ["Q16", "Q4", "D4", "R16", "C4", "Q17", "C17", "K4", "pass"]);

config.always_show_next_move_eval = false;
assert.deepStrictEqual(on_board(best_plus(0)), ["Q16"]);
assert.deepStrictEqual(on_board(best_plus(2)), ["Q16", "Q4", "K4"]);		// K4 (0.2) and Q4 (0.4) are the cheapest.
assert.deepStrictEqual(on_board(within(0.3)), ["Q16", "K4"]);
assert.deepStrictEqual(moves(options_table_infos(q)), ["Q16", "Q4", "D4", "R16", "C4", "Q17"]);

assert.deepStrictEqual(options_table_infos(child(root, "B", "aa")), []);		// No analysis yet.

console.log("explored tests passed");
