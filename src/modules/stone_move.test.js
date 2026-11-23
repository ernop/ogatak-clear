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
const {move_stone_on_tree, is_setup_stone_move} = require("./stone_move");

// Build a short 4-move opening sequence: B D4 -> W Q16 -> B D16 -> W Q4.
let root = new_node(null);
root.set("SZ", "19");
root.set("RU", "Japanese");
root.set("KM", "6.5");

let b1 = root.try_move("dp");		// B D4
let w2 = b1.try_move("pd");			// W Q16
let b3 = w2.try_move("dd");			// B D16
let w4 = b3.try_move("pp");			// W Q4

// 1. Moving the exact last move (W Q4 -> R4 = "qp") creates a clean sibling move variation off b3.
let r1 = move_stone_on_tree(w4, "pp", "qp", new_node);
assert.ok(r1);
assert.strictEqual(r1.kind, "sibling_move");
assert.strictEqual(r1.node.parent, b3);
assert.strictEqual(r1.node.get("W"), "qp");
assert.strictEqual(r1.node.get_board().state_at("pp"), "");
assert.strictEqual(r1.node.get_board().state_at("qp"), "w");
assert.strictEqual(r1.node.get_board().active, "b");
assert.strictEqual(w4.get_board().state_at("pp"), "w");		// Original sequence untouched.

// Repeating the same sibling move reuses the existing sibling instead of duplicating.
let r1_again = move_stone_on_tree(w4, "pp", "qp", new_node);
assert.strictEqual(r1_again.node, r1.node);

// 2. Moving an earlier stone (B D4 = "dp" -> C4 = "cp") while at w4 (Black to play)
// creates a child setup branch with AE[dp], AB[cp], PL[B].
let r2 = move_stone_on_tree(w4, "dp", "cp", new_node);
assert.ok(r2);
assert.strictEqual(r2.kind, "setup_branch");
assert.strictEqual(r2.node.parent, w4);
assert.strictEqual(is_setup_stone_move(r2.node), true);
assert.deepStrictEqual(r2.node.all_values("AE"), ["dp"]);
assert.deepStrictEqual(r2.node.all_values("AB"), ["cp"]);
assert.strictEqual(r2.node.get("PL"), "B");
assert.strictEqual(r2.node.get_board().state_at("dp"), "");
assert.strictEqual(r2.node.get_board().state_at("cp"), "b");
assert.strictEqual(r2.node.get_board().state_at("pp"), "w");
assert.strictEqual(r2.node.get_board().active, "b");			// Preserves Black to play.
assert.strictEqual(w4.get_board().state_at("dp"), "b");			// Original position untouched.

// Query built for KataGo on the setup branch has initialStones with C4 (not D4) and initialPlayer = B.
let q = new_query(r2.node, [1, 17, 2], 100);
assert.strictEqual(q.moves.length, 0);
assert.strictEqual(q.initialPlayer, "B");
let stone_set = new Set(q.initialStones.map(([c, gtp]) => `${c}:${gtp}`));
assert.ok(stone_set.has("B:C4"));
assert.ok(!stone_set.has("B:D4"));
assert.ok(stone_set.has("W:Q4"));

// Repeating the same earlier-stone move reuses the existing child branch.
let r2_again = move_stone_on_tree(w4, "dp", "cp", new_node);
assert.strictEqual(r2_again.node, r2.node);

// 3. Chaining a second stone move off r2 (move W Q16 = "pd" -> Q17 = "pc") preserves both edits and turn.
let r3 = move_stone_on_tree(r2.node, "pd", "pc", new_node);
assert.ok(r3);
assert.strictEqual(r3.kind, "setup_branch");
assert.strictEqual(r3.node.get_board().state_at("cp"), "b");
assert.strictEqual(r3.node.get_board().state_at("dp"), "");
assert.strictEqual(r3.node.get_board().state_at("pd"), "");
assert.strictEqual(r3.node.get_board().state_at("pc"), "w");
assert.strictEqual(r3.node.get_board().active, "b");

// 4. Invalid moves return null safely.
assert.strictEqual(move_stone_on_tree(w4, "jj", "kk", new_node), null);		// Empty origin.
assert.strictEqual(move_stone_on_tree(w4, "dp", "pp", new_node), null);		// Occupied destination.
assert.strictEqual(move_stone_on_tree(w4, "dp", "dp", new_node), null);		// Same intersection.
assert.strictEqual(move_stone_on_tree(null, "dp", "cp", new_node), null);

console.log("stone_move tests passed");
