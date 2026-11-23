"use strict";

const assert = require("assert");
const Module = require("module");

const load_module = Module._load;
Module._load = function(request, ...rest) {
	return request === "electron" ? {} : load_module.call(this, request, ...rest);
};

global.user_data_path = require("os").tmpdir();
const config_io = require("./config_io");
global.config = JSON.parse(JSON.stringify(config_io.defaults));

const new_node = require("./node");
const {new_query} = require("./query");
const {
	move_stone_on_tree,
	is_setup_stone_move,
	is_stone_move_sibling,
	what_if_origin_node,
	describe_stone_diff,
	summarize_what_if,
} = require("./stone_move");

// Build a short 4-move opening sequence: B D4 -> W Q16 -> B D16 -> W Q4.
let root = new_node(null);
root.set("SZ", "19");
root.set("RU", "Japanese");
root.set("KM", "6.5");

let b1 = root.try_move("dp");		// B D4
let w2 = b1.try_move("pd");			// W Q16
let b3 = w2.try_move("dd");			// B D16
let w4 = b3.try_move("pp");			// W Q4

// 1. Moving the exact last move (W Q4 -> R4 = "qp") creates ONE sibling move off b3.
let r1 = move_stone_on_tree(w4, "pp", "qp", new_node);
assert.ok(r1);
assert.strictEqual(r1.kind, "sibling_move");
assert.strictEqual(r1.in_place, false);
assert.strictEqual(r1.node.parent, b3);
assert.strictEqual(b3.children[0], w4);
assert.strictEqual(b3.children[1], r1.node);
assert.strictEqual(r1.node.get("W"), "qp");
assert.strictEqual(what_if_origin_node(r1.node), w4);
assert.strictEqual(what_if_origin_node(w4), null);

// Glomming a second drag on that same stone (R4 -> R5 = "qo") simplifies the chain Q4 -> R5!
let prev_id = r1.node.id;
let r1b = move_stone_on_tree(r1.node, "qp", "qo", new_node);
assert.ok(r1b);
assert.strictEqual(r1b.in_place, true);
assert.strictEqual(r1b.node, r1.node);
assert.strictEqual(b3.children.length, 2);
assert.notStrictEqual(r1b.node.id, prev_id);
assert.strictEqual(r1b.node.get("W"), "qo");
let d1b = describe_stone_diff(w4, r1b.node);
assert.strictEqual(d1b.pairs.length, 1);
assert.strictEqual(d1b.pairs[0].from_gtp, "Q4");
assert.strictEqual(d1b.pairs[0].to_gtp, "R5");

// Glomming an earlier-stone drag converts it to a setup sibling in place!
let r1c = move_stone_on_tree(r1b.node, "dp", "cp", new_node);
assert.ok(r1c);
assert.strictEqual(r1c.in_place, true);
assert.strictEqual(r1c.node, r1.node);
assert.strictEqual(r1c.kind, "sibling_setup");
assert.strictEqual(b3.children.length, 2);
assert.strictEqual(is_setup_stone_move(r1c.node), true);
assert.strictEqual(is_stone_move_sibling(r1c.node), true);
assert.strictEqual(r1c.node.has_key("W"), false);
let d1c = describe_stone_diff(w4, r1c.node);
assert.strictEqual(d1c.pairs.length, 2);

// 2. Moving an earlier stone directly from main-line w4 (B D4 -> C4 = "cp")
// creates ONE sibling setup node off b3 (same depth as w4, NOT a child of w4!).
let r2 = move_stone_on_tree(w4, "dp", "cp", new_node);
assert.ok(r2);
assert.strictEqual(r2.kind, "sibling_setup");
assert.strictEqual(r2.in_place, false);
assert.strictEqual(r2.node.parent, b3);
assert.strictEqual(r2.node.depth, w4.depth);
assert.strictEqual(b3.children[0], w4);
assert.strictEqual(r2.node.get_board().state_at("dp"), "");
assert.strictEqual(r2.node.get_board().state_at("cp"), "b");
assert.strictEqual(r2.node.get_board().state_at("pp"), "w");
assert.strictEqual(r2.node.get_board().active, "b");
assert.strictEqual(w4.get_board().state_at("dp"), "b");

// KataGo query on the setup sibling carries C4 (not D4), Q4, and initialPlayer = B.
let q = new_query(r2.node, [1, 17, 2], 100);
assert.strictEqual(q.moves.length, 0);
assert.strictEqual(q.initialPlayer, "B");
let stone_set = new Set(q.initialStones.map(([c, gtp]) => `${c}:${gtp}`));
assert.ok(stone_set.has("B:C4"));
assert.ok(!stone_set.has("B:D4"));
assert.ok(stone_set.has("W:Q4"));

// 3. What-if summary computes position swing (better for B/W) and next-best-move shift.
let orig_a = {
	rootInfo: {scoreLead: 1.2, winrate: 0.56, visits: 400},
	moveInfos: [
		{move: "R14", scoreLead: 1.2, winrate: 0.56, visits: 250, order: 0},
		{move: "Q14", scoreLead: 0.5, winrate: 0.52, visits: 80, order: 1},
	],
};
let mod_a = {
	rootInfo: {scoreLead: 3.6, winrate: 0.62, visits: 350},
	moveInfos: [
		{move: "Q14", scoreLead: 3.6, winrate: 0.62, visits: 210, order: 0},
		{move: "R14", scoreLead: 2.2, winrate: 0.57, visits: 90, order: 1},
	],
};
w4.analysis = orig_a;
r2.node.analysis = mod_a;
let summary = summarize_what_if(w4, r2.node);
assert.ok(summary);
assert.strictEqual(summary.has_orig, true);
assert.strictEqual(summary.has_mod, true);
assert.strictEqual(summary.better_for, "b");
assert.ok(Math.abs(summary.delta_bpov - 2.4) < 1e-6);
assert.ok(Math.abs(summary.delta_wr_bpov - 6.0) < 1e-6);
assert.strictEqual(summary.orig_best, "R14");
assert.strictEqual(summary.mod_best, "Q14");
assert.strictEqual(summary.best_changed, true);
assert.ok(Math.abs(summary.orig_best_new_cost - 1.4) < 1e-6);
assert.strictEqual(summary.summary, "B D4 → C4");

// White gain case:
r2.node.analysis = {
	rootInfo: {scoreLead: -1.3, winrate: 0.44, visits: 300},
	moveInfos: [{move: "R14", scoreLead: -1.3, winrate: 0.44, visits: 200, order: 0}],
};
let summary_w = summarize_what_if(w4, r2.node);
assert.strictEqual(summary_w.better_for, "w");
assert.ok(Math.abs(summary_w.abs_pts - 2.5) < 1e-6);
assert.strictEqual(summary_w.best_changed, false);

// Fallback nearest-neighbour diff when __stone_moves is stripped (SGF reload simulation):
delete r2.node.__stone_moves;
let diff_reload = describe_stone_diff(w4, r2.node);
assert.strictEqual(diff_reload.pairs.length, 1);
assert.strictEqual(diff_reload.pairs[0].from_gtp, "D4");
assert.strictEqual(diff_reload.pairs[0].to_gtp, "C4");

// 4. Chaining a second stone move on r2 gloms IN PLACE into r2!
let siblings_before = b3.children.length;
let r3 = move_stone_on_tree(r2.node, "pd", "pc", new_node);
assert.ok(r3);
assert.strictEqual(r3.in_place, true);
assert.strictEqual(r3.node, r2.node);
assert.strictEqual(b3.children.length, siblings_before);

// 5. Dragging a stone back to match main line w4 collapses the redundant sibling!
let r_tmp = move_stone_on_tree(w4, "dd", "cd", new_node);
let count_with_tmp = b3.children.length;
let r_back = move_stone_on_tree(r_tmp.node, "cd", "dd", new_node);
assert.strictEqual(r_back.node, w4);
assert.strictEqual(r_back.kind, "main_line");
assert.strictEqual(b3.children.length, count_with_tmp - 1);

// 6. If a stone-move sibling already has children, dragging creates a new sibling.
let follow = r3.node.try_move("jj");
assert.ok(follow);
let count_before_branch = b3.children.length;
let r4 = move_stone_on_tree(r3.node, "dd", "cd", new_node);
assert.strictEqual(r4.in_place, false);
assert.strictEqual(r4.node.parent, b3);
assert.notStrictEqual(r4.node, r3.node);
assert.strictEqual(b3.children.length, count_before_branch + 1);

// 7. Invalid moves return null safely.
assert.strictEqual(move_stone_on_tree(w4, "jj", "kk", new_node), null);
assert.strictEqual(move_stone_on_tree(w4, "dp", "pp", new_node), null);
assert.strictEqual(move_stone_on_tree(w4, "dp", "dp", new_node), null);
assert.strictEqual(move_stone_on_tree(null, "dp", "cp", new_node), null);

console.log("stone_move tests passed");
