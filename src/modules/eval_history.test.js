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
let d4 = eval_history.points(s, "D4", 1000, 50);
assert.strictEqual(d4[d4.length - 1].lead, 1);
assert.strictEqual(d4[d4.length - 1].root, 60000);
assert.ok(d4[0].root >= 1000);
let c3 = eval_history.points(s, "C3", 1000, 0);
assert.ok(c3[0].t >= 300 && c3[0].t < 330);
assert.strictEqual(eval_history.points(s, "C3", 1000, 1e9).length, 0);
assert.strictEqual(eval_history.points(s, "Z9", 1000, 0).length, 0);

// Moves ever drawn on the board are remembered per search.

eval_history.note_shown("node_2:7", ["Q16"], 999);				// Before the chart starts: not remembered.
eval_history.note_shown("node_2:7", ["D4", "C3"], 1000);
eval_history.note_shown("node_2:7", ["D4"], 5000);
eval_history.note_shown("no such search", ["D4"], 5000);
assert.deepStrictEqual([...s.shown], ["D4", "C3"]);

// value_at is what the engine said at that point: the last sample at or before it.

let pts = [{x: 1000, lead: 3}, {x: 2000, lead: 2}, {x: 4000, lead: 1}];
assert.strictEqual(eval_history.value_at(pts, 500), null);
assert.strictEqual(eval_history.value_at(pts, 2000).lead, 2);
assert.strictEqual(eval_history.value_at(pts, 3999).lead, 2);
assert.strictEqual(eval_history.value_at(pts, 1e9).lead, 1);

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

assert.deepStrictEqual(eval_history.visit_ticks(1000, 45000, true), [1000, 2000, 5000, 10000, 20000]);
assert.deepStrictEqual(eval_history.visit_ticks(1000, 3e6, true).slice(-3), [5e5, 1e6, 2e6]);
assert.deepStrictEqual(eval_history.visit_ticks(0, 45000, false), [0, 10000, 20000, 30000, 40000]);
assert.deepStrictEqual(eval_history.visit_ticks(0, 1e7, false), [0, 2e6, 4e6, 6e6, 8e6, 1e7]);
assert.deepStrictEqual(eval_history.visit_ticks(0, 1e7, false, 11), [0, 1e6, 2e6, 3e6, 4e6, 5e6, 6e6, 7e6, 8e6, 9e6, 1e7]);	// A wider chart takes more.
assert.deepStrictEqual(eval_history.visit_ticks(1000, 45000, true, 11), [1000, 2000, 3000, 5000, 7000, 10000, 20000, 30000]);
assert.deepStrictEqual(eval_history.visit_ticks(1000, 1e7, true, 11).slice(0, 4), [1000, 2000, 5000, 10000]);			// Four decades: 1, 2, 5 still.
assert.strictEqual(eval_history.fmt_count(950), "950");
assert.strictEqual(eval_history.fmt_count(1500), "1.5k");
assert.strictEqual(eval_history.fmt_count(20000), "20k");
assert.strictEqual(eval_history.fmt_count(2000000), "2M");
assert.strictEqual(eval_history.fmt_time(20), "20s");
assert.strictEqual(eval_history.fmt_time(120), "2m");
assert.strictEqual(eval_history.fmt_time(150), "2m30s");
assert.strictEqual(eval_history.fmt_time(5400), "1h30m");

// A move's rank by visits at each sample, and when it was first searched.

eval_history.reset();
eval_history.record(report("node_3:1", 500, [["D4", 1, 300], ["Q16", 0.5, 200]]), 0);
eval_history.record(report("node_3:1", 2000, [["D4", 1, 1200], ["Q16", 0.5, 700], ["C6", 2, 100]]), 10000);
eval_history.record(report("node_3:1", 9000, [["D4", 1, 4000], ["Q16", 0.5, 2000], ["C6", 2, 3000]]), 20000);
let late = eval_history.get("node_3:1");
assert.deepStrictEqual(eval_history.visit_ranks(late, "C6"), [{root: 2000, rank: 3}, {root: 9000, rank: 2}]);
assert.deepStrictEqual(eval_history.visit_ranks(late, "Q16").map(r => r.rank), [2, 2, 3]);
assert.deepStrictEqual(eval_history.visit_ranks(late, "Q16", 1000).map(r => r.root), [2000, 9000]);
assert.deepStrictEqual(eval_history.visit_ranks(late, "K10"), []);
assert.strictEqual(eval_history.first_seen(late, "C6"), 2000);
assert.strictEqual(eval_history.first_seen(late, "D4"), 500);
assert.strictEqual(eval_history.first_seen(late, "K10"), null);

// Every line gets a label, and no two labels (or a label and an obstacle) overlap.

let area = {x0: 0, y0: 0, x1: 500, y1: 200};
let overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
let rect = (p, l) => ({x0: p.x - l.w / 2, y0: p.y - l.h / 2, x1: p.x + l.w / 2, y1: p.y + l.h / 2});
let line = (ys) => ({w: 30, h: 12, px: ys.map((y, i) => i * 40), py: ys});

let converging = [
	line([20, 60, 95, 100]),			// Several lines that end on the same spot...
	line([180, 140, 105, 100]),
	line([100, 100, 100, 100]),
	line([100, 100, 100, 100]),			// ...one of them identical to another all the way along.
	line([50]),							// A single point.
];
let obstacle = {x0: 0, y0: 0, x1: 120, y1: 14};
let placed = eval_history.place_line_labels(converging, [obstacle], area);
assert.strictEqual(placed.length, converging.length);
assert.strictEqual(placed[0].kind, "end");
assert.strictEqual(placed[1].kind, "on");
assert.ok(placed[1].x < 120);			// Moved back along its own line to where it had room.
assert.ok(placed.slice(2).every(p => ["on", "end", "leader"].includes(p.kind)));
let rects = placed.map((p, i) => rect(p, converging[i]));
for (let i = 0; i < rects.length; i++) {
	assert.ok(!overlap(rects[i], obstacle), `label ${i} covers the obstacle`);
	for (let j = i + 1; j < rects.length; j++) {
		assert.ok(!overlap(rects[i], rects[j]), `labels ${i} and ${j} overlap`);
	}
}

console.log("eval_history tests passed");
