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
const {summarize_position, build_probe_query, relative_narrowness_scale} = require("./narrowness");

// 1. Strictly forced position: 1 reply takes almost all visits, 2nd loses 4.5 pts.
let forced = summarize_position({
	rootInfo: {visits: 200},
	moveInfos: [
		{move: "D16", scoreLead: -0.5, visits: 192, prior: 0.90},
		{move: "C14", scoreLead: 4.0, visits: 6, prior: 0.06},		// White to play: higher Black-POV lead = worse for White (+4.5 cost).
		{move: "Q10", scoreLead: 5.5, visits: 2, prior: 0.04},
	],
}, false);

assert.strictEqual(forced.best_move, "D16");
assert.ok(Math.abs(forced.gap2 - 4.5) < 1e-9);
assert.ok(forced.eff_moves < 1.25, `expected narrow eff_moves, got ${forced.eff_moves}`);
assert.ok(forced.policy_cost < 0.6, `obvious forcing move should have low policy_cost, got ${forced.policy_cost}`);

// 2. Sharp/tricky forcing position: best reply has low prior (0.08), intuitive top-policy reply loses 3.0 pts.
let tricky = summarize_position({
	rootInfo: {visits: 200},
	moveInfos: [
		{move: "R14", scoreLead: 0.0, visits: 150, prior: 0.08},
		{move: "Q14", scoreLead: 3.0, visits: 40, prior: 0.72},
		{move: "S15", scoreLead: 5.0, visits: 10, prior: 0.20},
	],
}, false);

assert.strictEqual(tricky.best_move, "R14");
assert.ok(Math.abs(tricky.gap2 - 3.0) < 1e-9);
assert.strictEqual(tricky.top_policy_move, "Q14");
assert.ok(Math.abs(tricky.top_policy_cost - 3.0) < 1e-9);
assert.ok(tricky.policy_cost > 2.5, `tricky move should have high policy_cost, got ${tricky.policy_cost}`);

// 3. Equal 2-way split: eff_moves == 2.0, gap2 == 0.
let split2 = summarize_position({
	rootInfo: {visits: 100},
	moveInfos: [
		{move: "D4", scoreLead: 1.0, visits: 50, prior: 0.45},
		{move: "Q16", scoreLead: 1.0, visits: 50, prior: 0.45},
	],
}, true);
assert.ok(Math.abs(split2.eff_moves - 2.0) < 1e-9);
assert.strictEqual(split2.gap2, 0);

// 4. Wide 6-way fuseki: eff_moves == 6.0, tiny gap2.
let wide = summarize_position({
	rootInfo: {visits: 600},
	moveInfos: [
		{move: "C17", scoreLead: 0.00, visits: 100, prior: 0.16},
		{move: "F17", scoreLead: -0.05, visits: 100, prior: 0.16},
		{move: "Q11", scoreLead: -0.08, visits: 100, prior: 0.16},
		{move: "Q10", scoreLead: -0.10, visits: 100, prior: 0.16},
		{move: "K3",  scoreLead: -0.12, visits: 100, prior: 0.16},
		{move: "R11", scoreLead: -0.15, visits: 100, prior: 0.16},
	],
}, true);
assert.ok(Math.abs(wide.eff_moves - 6.0) < 1e-9);
assert.ok(Math.abs(wide.gap2 - 0.05) < 1e-9);

// 5. build_probe_query appends alternating colors cleanly on normal and setup nodes.
let root = new_node(null);
root.set("SZ", "19");
root.set("RU", "Japanese");
root.set("KM", "6.5");
let b1 = root.try_move("dp");		// B D4, now White to play.

let p1 = build_probe_query(b1, ["Q16"], [1, 17, 2], 120);
assert.strictEqual(p1.next_active_is_b, true);
assert.strictEqual(p1.query.priority, -10);
assert.strictEqual(p1.query.maxVisits, 120);
assert.strictEqual(p1.query.includeOwnership, false);
assert.deepStrictEqual(p1.query.moves, [["B", "D4"], ["W", "Q16"]]);

let p2 = build_probe_query(b1, ["Q16", "D16"], [1, 17, 2], 80);
assert.strictEqual(p2.next_active_is_b, false);
assert.deepStrictEqual(p2.query.moves, [["B", "D4"], ["W", "Q16"], ["B", "D16"]]);

// Setup branch node (empty moves, initialStones + initialPlayer -> moves added cleanly).
let setup = new_node(b1);
setup.add_value("AE", "dp");
setup.add_value("AB", "cp");
setup.set("PL", "W");
let p3 = build_probe_query(setup, ["Q16"], [1, 17, 2], 100);
assert.strictEqual(p3.next_active_is_b, true);
assert.strictEqual(p3.query.initialPlayer, undefined);
assert.deepStrictEqual(p3.query.moves, [["W", "Q16"]]);

// 6. Relative scaling across summaries.
let scale = relative_narrowness_scale([forced, wide]);
assert.strictEqual(scale.max_gap2, 4.5);
assert.ok(Math.abs(scale.max_eff - 6.0) < 1e-9);

console.log("narrowness tests passed");
