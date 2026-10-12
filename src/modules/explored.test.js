"use strict";

const assert = require("assert");

global.config = {};

const new_node = require("./node");
const {ANALYSIS_CONTEXT_PROPERTY, analysis_context} = require("./query");
const {same_settings, merge, child_results, node_infos, inherited_root, best_index, node_best, best_info} = require("./explored");
const {select_candidates, next_move_gtp_set, board_candidates, options_table_infos, info_cost, loss_text, ZERO_LOSS} = require("./utils");

// move_report.points_lost (the verdict), which needs a DOM to load: the mover's
// drop in position value, at least 0.
const points_lost = (node) => {
	let delta = node.stored_score() - node.parent.stored_score();
	return Math.max(0, node.has_key("B") ? -delta : delta);
};

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
analyse(d4, at_b, {		// Its value is its best move's, Q3's, not the root average.
	id: "d4", rootInfo: {visits: 1000, winrate: 0.49, scoreLead: 1.4, scoreSelfplay: 1.6},
	moveInfos: [{move: "Q3", order: 0, visits: 700, winrate: 0.47, scoreLead: 1.0, scoreSelfplay: 1.3, pv: ["Q3", "R4"]}],
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
	id: "pass", rootInfo: {visits: 300, winrate: 0.9, scoreLead: 9.0}, moveInfos: [{move: "D4", order: 0, visits: 300, winrate: 0.9, scoreLead: 9.0, pv: ["D4"]}],
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

assert.strictEqual(node_best(p), 0);
let shown = select_candidates(infos, node_best(p), false, next_move_gtp_set(p), {mode: "count", threshold: 0.3, count: 0, min_visits: 50});
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
	id: "k4", rootInfo: {visits: 1000, winrate: 0.5, scoreLead: 0.7}, moveInfos: [{move: "Q16", order: 0, visits: 600, winrate: 0.5, scoreLead: 0.7, pv: ["Q16"]}],
});
analyse(child(q, "W", ""), context([["B", "D16"], ["W", "pass"]]), {
	id: "q-pass", rootInfo: {visits: 300, winrate: 0.9, scoreLead: 9.0}, moveInfos: [{move: "Q16", order: 0, visits: 300, winrate: 0.9, scoreLead: 9.0, pv: ["Q16"]}],
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

// ------------------------------------------------------------------------------------------------
// Inherited values: the parent's search of a move stands for the position after it until that
// position's own search, with the same settings, has more visits.

let r = child(root, "B", "pp");				// Q4; White to play at r.
let at_d16 = context([["B", "Q4"], ["W", "D16"]]);

analyse(r, context([["B", "Q4"]]), {
	id: "r", rootInfo: {visits: 100000, winrate: 0.55, scoreLead: 1.5},
	moveInfos: [
		{move: "D16", order: 0, visits: 80000, winrate: 0.56, scoreLead: 1.6, scoreSelfplay: 2.0, prior: 0.3, pv: ["D16", "Q16"]},
		{move: "D4", order: 1, visits: 15000, winrate: 0.58, scoreLead: 2.4, prior: 0.2, pv: ["D4"]},
		{move: "Q16", order: 2, visits: 3000, winrate: 0.60, scoreLead: 3.0, prior: 0.1, pv: ["Q16"]},
		{move: "C3", order: 3, visits: 2000, winrate: 0.62, scoreLead: 3.5, prior: 0.1, pv: ["C3"]},
		{move: "pass", order: 4, visits: 3, winrate: 1.2, scoreLead: 9.0, prior: 0.0, pv: ["pass"]},
	],
	policy,
});

let d16 = child(r, "W", "dd");				// Just played, not searched yet.
assert.deepStrictEqual(inherited_root(d16), {visits: 80000, winrate: 0.56, scoreLead: 1.6, scoreSelfplay: 2.0});
assert.strictEqual(d16.stored_score(), 1.6);
assert.strictEqual(d16.stored_winrate(), 0.56);

analyse(d16, at_d16, {id: "d16", rootInfo: {visits: 500, winrate: 0.50, scoreLead: 0.9}, moveInfos: [{move: "Q16", order: 0, visits: 400, pv: ["Q16"]}]});
assert.strictEqual(inherited_root(d16).visits, 80000);
assert.strictEqual(d16.stored_score(), 1.6);

analyse(d16, at_d16, {id: "d16", rootInfo: {visits: 80000, winrate: 0.54, scoreLead: 1.2}, moveInfos: [{move: "Q16", order: 0, visits: 70000, winrate: 0.53, scoreLead: 1.25, pv: ["Q16"]}]});
assert.strictEqual(inherited_root(d16), null);		// Ties go to the position's own search: its best move.
assert.strictEqual(d16.stored_score(), 1.25);
assert.strictEqual(d16.stored_winrate(), 0.53);

let d4_komi = child(r, "W", "dp");			// Searched at another komi: not comparable, so its own search stands.
analyse(d4_komi, context([["B", "Q4"], ["W", "D4"]], {komi: 6.5}), {
	id: "d4k", rootInfo: {visits: 200, winrate: 0.4, scoreLead: 3.3}, moveInfos: [{move: "Q16", order: 0, visits: 150, winrate: 0.41, scoreLead: 3.4, pv: []}],
});
assert.strictEqual(inherited_root(d4_komi), null);
assert.strictEqual(d4_komi.stored_score(), 3.4);

let q16_avoiding = child(r, "W", "pd");		// Its own search was told to avoid moves, as the user asked.
analyse(q16_avoiding, context([["B", "Q4"], ["W", "Q16"]], {avoidMoves: [{player: "B", moves: ["C3"], untilDepth: 1}]}), {
	id: "q16", rootInfo: {visits: 100, winrate: 0.5, scoreLead: 0.2}, moveInfos: [{move: "C17", order: 0, visits: 90, pv: []}],
});
assert.strictEqual(inherited_root(q16_avoiding), null);

let c3_from_file = child(r, "W", "cq");		// Values saved in the SGF have unknown visits.
c3_from_file.set("SBKV", "40.00");
c3_from_file.set("OGSC", "-0.50");
assert.strictEqual(inherited_root(c3_from_file), null);
assert.strictEqual(c3_from_file.stored_score(), -0.5);
assert.strictEqual(c3_from_file.stored_winrate(), 0.4);

let r_pass = child(r, "W", "");
assert.strictEqual(inherited_root(r_pass).visits, 3);
assert.strictEqual(r_pass.stored_score(), 9.0);
assert.strictEqual(r_pass.stored_winrate(), 1);		// Clamped like a node's own winrate.

let k10 = child(r, "W", "jj");				// Never reported by r's search.
assert.strictEqual(inherited_root(k10), null);
assert.strictEqual(k10.stored_score(), null);
assert.strictEqual(k10.stored_winrate(), null);

assert.strictEqual(inherited_root(child(r, "B", "dd")), null);		// Black twice: not one of r's options.
let d16_edited = child(r, "W", "dd");
d16_edited.set("AB", "aa");
assert.strictEqual(inherited_root(d16_edited), null);
assert.strictEqual(inherited_root(root), null);
assert.strictEqual(inherited_root(child(child(root, "B", "aa"), "W", "bb")), null);		// The parent has no search.

// Both directions agree: D4's own 1,000-visit search lost to p's 1,800 visits of D4 above,
// so p lists p's own entry and D4 itself shows that entry's value.

assert.strictEqual(node_infos(p)[1].explored, undefined);
assert.strictEqual(inherited_root(d4).visits, 1800);
assert.strictEqual(d4.stored_score(), 0.7);

// ------------------------------------------------------------------------------------------------
// best_index: the most points for the side to move among moves with enough visits, ties to the
// earlier entry, else KataGo's first.

let ranked = [
	{move: "A1", visits: 5000, scoreLead: 1.0},
	{move: "B1", visits: 3000, scoreLead: 1.3},
	{move: "C1", visits: 20, scoreLead: 2.0},
	{move: "D1", visits: 3000, scoreLead: 1.3},
	{move: "E1", visits: 900, scoreLead: 0.4},
];
assert.strictEqual(best_index(ranked, true, 50), 1);			// C1 scores more, on too few visits; D1 ties B1.
assert.strictEqual(best_index(ranked, true, 0), 2);
assert.strictEqual(best_index(ranked, false, 50), 4);
assert.strictEqual(best_index(ranked, true, 10000), 0);			// Nothing qualifies: KataGo's first.
assert.strictEqual(best_index([{move: "A1", visits: 9}, {move: "B1", visits: 9}], true, 0), 0);	// No scores: KataGo's first.
assert.strictEqual(best_index([], true, 0), -1);

// ------------------------------------------------------------------------------------------------
// One best move. At s, KataGo ranks D4 first, but Q4 leaves White more on enough visits: Q4 is the
// best move, the position's value, the first Next Move Options row, and the only star.
// C16 scores even better on 20 visits, below the minimum, so it reads 0.00.

config.candidate_min_visits = 50;
config.always_show_next_move_eval = true;

let ctx_s = context([["B", "Q16"]]);
let s = child(root, "B", "pd");				// Q16; White to play at s.
analyse(s, ctx_s, {
	id: "s", rootInfo: {visits: 9020, winrate: 0.41, scoreLead: -0.9},
	moveInfos: [
		{move: "D4", order: 0, visits: 5000, winrate: 0.40, scoreLead: -1.0, prior: 0.3, pv: ["D4"]},
		{move: "Q4", order: 1, visits: 3000, winrate: 0.42, scoreLead: -1.3, prior: 0.2, pv: ["Q4", "C16"]},
		{move: "C16", order: 2, visits: 20, winrate: 0.38, scoreLead: -2.0, prior: 0.1, pv: ["C16"]},
		{move: "R4", order: 3, visits: 1000, winrate: 0.45, scoreLead: -0.5, prior: 0.1, pv: ["R4"]},
	],
	policy,
});

assert.strictEqual(node_best(s), 1);
assert.strictEqual(best_info(s).move, "Q4");
assert.strictEqual(s.stored_score(), -1.3);					// Q4's value, not the root average's -0.9.
assert.strictEqual(s.stored_winrate(), 0.42);
assert.strictEqual(s.get("OGSC"), "-1.30");
assert.strictEqual(s.get("SBKV"), "42.00");
assert.strictEqual(s.get("OGWC"), "0.00,0.00,0.30,0.80");		// C16 is clamped: costs are never negative.
assert.deepStrictEqual(moves(options_table_infos(s)), ["Q4", "D4", "C16", "R4"]);

let s_board = (settings) => {
	Object.assign(config, settings);
	let sel = board_candidates(s);
	return sel.infos.map((info, i) => `${info.move} ${loss_text(sel.costs[i], false, true, i === sel.best)}`);
};
assert.deepStrictEqual(s_board({candidate_filter: "count", candidate_count: 1}), ["Q4 ★", "D4 -0.30"]);
assert.deepStrictEqual(s_board({candidate_filter: "cost", cost_threshold: 0.3}), ["Q4 ★", "D4 -0.30", "C16 0.00"]);

config.candidate_min_visits = 0;							// Every move qualifies: C16 becomes the best.
assert.strictEqual(best_info(s).move, "C16");
assert.strictEqual(s.stored_score(), -2.0);
config.candidate_min_visits = 50;
assert.strictEqual(best_info(s).move, "Q4");

// ------------------------------------------------------------------------------------------------
// Values pass up explored lines: the user plays Q4 at s, then C16, each searched longer than the
// position above gave it. Every position's value is its best move's, explored value included.

let t = child(s, "W", "pp");				// Q4; Black to play at t.
analyse(t, context([["B", "Q16"], ["W", "Q4"]]), {
	id: "t", rootInfo: {visits: 6000, winrate: 0.57, scoreLead: -1.1},
	moveInfos: [
		{move: "D4", order: 0, visits: 4000, winrate: 0.56, scoreLead: -1.0, pv: ["D4"]},
		{move: "C16", order: 1, visits: 1500, winrate: 0.55, scoreLead: -0.8, pv: ["C16", "D4"]},
	],
});

assert.strictEqual(best_info(t).move, "C16");
assert.strictEqual(t.stored_score(), -0.8);
assert.deepStrictEqual(node_infos(s)[1], {
	move: "Q4", order: 1, visits: 6000, winrate: 0.55, scoreLead: -0.8,
	pv: ["Q4", "C16", "D4"], prior: 0.2, explored: {own: s.analysis.moveInfos[1]},
});
assert.strictEqual(s.stored_score(), -0.8);					// The best move, Q4, at its explored value.
assert.strictEqual(points_lost(t), 0);
assert.strictEqual(s.get("OGSC"), "-1.30");					// Saved values stay s's own search's.

let u = child(t, "B", "cd");				// C16; White to play at u.
analyse(u, context([["B", "Q16"], ["W", "Q4"], ["B", "C16"]]), {
	id: "u", rootInfo: {visits: 3000, winrate: 0.46, scoreLead: -0.3},
	moveInfos: [{move: "D4", order: 0, visits: 2500, winrate: 0.47, scoreLead: -0.4, pv: ["D4"]}],
});

assert.strictEqual(u.stored_score(), -0.4);
assert.strictEqual(t.stored_score(), -0.4);					// C16 at u's value...
assert.strictEqual(s.stored_score(), -0.4);					// ...and Q4 at t's, two levels up.
assert.strictEqual(points_lost(u), 0);
assert.strictEqual(points_lost(t), 0);

// Other moves at s: D4 explored worse, R4 explored better than the best. R4 is the best's equal
// at most (0.00), never a second star: the best move is s's own search's choice.

let v = child(s, "W", "dp");				// D4.
analyse(v, context([["B", "Q16"], ["W", "D4"]]), {
	id: "v", rootInfo: {visits: 8000, winrate: 0.6, scoreLead: 0.3},
	moveInfos: [{move: "Q4", order: 0, visits: 6000, winrate: 0.61, scoreLead: 0.2, pv: ["Q4"]}],
});
let w = child(s, "W", "qp");				// R4.
analyse(w, context([["B", "Q16"], ["W", "R4"]]), {
	id: "w", rootInfo: {visits: 2000, winrate: 0.35, scoreLead: -2.4},
	moveInfos: [{move: "D4", order: 0, visits: 1500, winrate: 0.34, scoreLead: -2.5, pv: ["D4"]}],
});

assert.strictEqual(best_info(s).move, "Q4");
assert.strictEqual(s.stored_score(), -0.4);
assert.ok(Math.abs(points_lost(v) - 0.6) < 1e-9);
assert.strictEqual(points_lost(w), 0);
assert.deepStrictEqual(s_board({candidate_filter: "cost", cost_threshold: 0.3}), ["Q4 ★", "D4 -0.60", "C16 0.00", "R4 0.00"]);		// D4, played from s, past the cutoff.

// The verdict for every move from s and t is the cost their parent shows for it.

for (let node of [t, u, v, w]) {
	let parent_node = node.parent;
	let shown_entry = node_infos(parent_node).find(info => info.move === parent_node.get_board().gtp(node.get(node.has_key("B") ? "B" : "W")));
	let cost = info_cost(shown_entry, best_info(parent_node).scoreLead, parent_node.get_board().active === "b");
	assert.ok(Math.abs(points_lost(node) - cost) < 1e-9, `${node.analysis.id}: verdict ${points_lost(node)} vs cost ${cost}`);
}

console.log("explored tests passed");
