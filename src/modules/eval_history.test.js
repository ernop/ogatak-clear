"use strict";

const assert = require("assert");
const eval_history = require("./eval_history");

let report = (id, visits, moves) => ({
	id,
	rootInfo: {visits},
	moveInfos: moves.map(([move, scoreLead, v]) => ({move, scoreLead, visits: v})),
});

// Every report is kept for the first few seconds (reports every 0.1 s)...

eval_history.reset();
for (let i = 0; i <= 20; i++) {
	eval_history.record(report("node_1:1", i * 100, [["D4", 1 + i / 100, i * 10], ["Q16", 0.5, i * 5]]), 1000 + i * 100);
}
let s = eval_history.get("node_1:1");
assert.strictEqual(s.times.length, 21);
assert.ok(Math.abs(s.times[20] - 2.0) < 1e-9);
assert.strictEqual(s.moves.get("D4").lead.length, 21);

// ...then samples thin out to ~4% of elapsed time, and the last one is always the latest report.

eval_history.reset();
for (let i = 0; i <= 6000; i++) {			// Ten minutes of 0.1 s reports.
	let moves = [["D4", 2 - i / 6000, i * 10]];
	if (i >= 3000) moves.push(["C3", -1, (i - 3000) * 2]);			// Appears halfway through.
	eval_history.record(report("node_2:7", i * 10, moves), i * 100);
}
s = eval_history.get("node_2:7");
assert.ok(s.times.length > 150 && s.times.length < 260, `kept ${s.times.length} samples`);
assert.ok(Math.abs(s.times[s.times.length - 1] - 600) < 1e-9);
assert.strictEqual(s.roots[s.roots.length - 1], 60000);
for (let k = 2; k < s.times.length - 1; k++) {
	assert.ok(s.times[k] - s.times[k - 1] >= Math.max(0.05, s.times[k - 1] * 0.04) - 1e-6);
}
let d4 = eval_history.points(s, "D4", 1, 50);
assert.strictEqual(d4[d4.length - 1].lead, 1);
assert.ok(d4[0].t >= 1);
let c3 = eval_history.points(s, "C3", 1, 0);
assert.ok(c3[0].t >= 300 && c3[0].t < 330);
assert.strictEqual(eval_history.points(s, "C3", 1, 1e9).length, 0);
assert.strictEqual(eval_history.points(s, "Z9", 1, 0).length, 0);

// value_at is what the engine said at that time: the last sample at or before it.

let pts = [{t: 1, lead: 3}, {t: 2, lead: 2}, {t: 4, lead: 1}];
assert.strictEqual(eval_history.value_at(pts, 0.5), null);
assert.strictEqual(eval_history.value_at(pts, 2).lead, 2);
assert.strictEqual(eval_history.value_at(pts, 3.9).lead, 2);
assert.strictEqual(eval_history.value_at(pts, 100).lead, 1);

// Old searches are forgotten, least recently used first.

eval_history.reset();
for (let i = 0; i < 45; i++) {
	eval_history.record(report(`node_${i}:${i}`, 10, [["D4", 0, 10]]), 0);
	if (i === 30) eval_history.get("node_0:0");				// Recently viewed, so kept.
}
assert.ok(eval_history.get("node_0:0"));
assert.strictEqual(eval_history.get("node_1:1"), null);
assert.ok(eval_history.get("node_44:44"));

eval_history.record({id: "x"}, 0);						// Malformed reports are ignored.
eval_history.record(null, 0);

assert.deepStrictEqual(eval_history.time_ticks(1, 45, true), [1, 2, 5, 10, 20, 30]);
assert.deepStrictEqual(eval_history.time_ticks(1, 3600, true).slice(-3), [1200, 1800, 3600]);
assert.deepStrictEqual(eval_history.time_ticks(0, 45, false), [0, 10, 20, 30, 40]);
assert.strictEqual(eval_history.fmt_time(20), "20s");
assert.strictEqual(eval_history.fmt_time(120), "2m");
assert.strictEqual(eval_history.fmt_time(150), "2m30s");
assert.strictEqual(eval_history.fmt_time(5400), "1h30m");

console.log("eval_history tests passed");
