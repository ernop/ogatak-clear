"use strict";

const assert = require("assert");

global.user_data_path = require("os").tmpdir();			// config_io wants it outside Electron.
const config_io = require("./config_io");
global.config = JSON.parse(JSON.stringify(config_io.defaults));

const schema = require("./settings_schema");
const rows = schema.all_rows();
const row = (key) => rows.find(r => r.key === key);
const options_of = (r) => typeof r.options === "function" ? r.options() : r.options;

// Every keyed row names a real config key (save() drops unknown keys), once each.

let keys = rows.filter(r => r.key).map(r => r.key);
for (let key of keys) {
	assert.ok(config_io.defaults.hasOwnProperty(key), `${key} is not in config_io.defaults`);
}
assert.strictEqual(new Set(keys).size, keys.length, "a config key has two rows");

// Every default is presentable by its row.

for (let r of rows) {
	assert.ok(r.key || typeof r.get === "function", `"${r.label}" needs a key or get()`);
	assert.ok(["toggle", "number", "choice", "select", "path"].includes(r.type), `"${r.label}": unknown type ${r.type}`);
	if (!r.key) {
		continue;
	}
	let value = config_io.defaults[r.key];
	if (r.type === "toggle") {
		assert.strictEqual(typeof value, "boolean", `${r.key}: a toggle needs a boolean`);
	} else if ((r.type === "choice" || r.type === "select") && !r.options_from) {
		assert.ok(options_of(r).some(o => o[0] === value), `${r.key}: default ${JSON.stringify(value)} is not an option`);
	} else if (r.type === "number") {
		assert.strictEqual(schema.problem_with(value, r), null, `${r.key}: default out of range`);
		assert.strictEqual(schema.parse_value(schema.format_value(value, r), r), value, `${r.key}: format / parse round trip`);
		assert.ok(schema.presets_of(r).length > 0 || typeof r.step === "number", `${r.key}: needs presets or a step`);
	}
}

// Typing a visit limit.

let visits = row("ponder_visits");
assert.strictEqual(schema.parse_value("1,000,000", visits), 1000000);
assert.strictEqual(schema.parse_value(" 250 000 ", visits), 250000);
assert.strictEqual(schema.parse_value("2.5k", visits), 2500);
assert.strictEqual(schema.parse_value("3M", visits), 3000000);
assert.strictEqual(schema.parse_value("1e6", visits), 1000000);
assert.strictEqual(schema.parse_value("lots", visits), null);
assert.strictEqual(schema.parse_value("1.000.000", visits), null);
assert.ok(schema.problem_with(null, visits).startsWith("Type a number"));
assert.ok(schema.problem_with(1, visits).includes("2–1,000,000,000 visits"));
assert.strictEqual(schema.problem_with(2, visits), null);
assert.strictEqual(schema.format_value(1000000, visits), "1,000,000");

// − / + walk the presets from any value; past the last one only typing goes further.

assert.strictEqual(schema.step_value(1000000, visits, 1), 2000000);
assert.strictEqual(schema.step_value(1000000, visits, -1), 500000);
assert.strictEqual(schema.step_value(300000, visits, 1), 500000);
assert.strictEqual(schema.step_value(300000, visits, -1), 250000);
assert.strictEqual(schema.step_value(5000000, visits, 1), 5000000);
assert.strictEqual(schema.step_value(20000000, visits, -1), 5000000);

// "all" (0) sorts above every points cutoff; a decimal comma is a decimal point.

let cutoff = row("cost_threshold");
assert.strictEqual(schema.step_value(8, cutoff, 1), 0);
assert.strictEqual(schema.step_value(0, cutoff, -1), 8);
assert.strictEqual(schema.step_value(0, cutoff, 1), 0);
assert.strictEqual(schema.step_value(0.3, cutoff, -1), 0.3);
assert.strictEqual(schema.format_value(0, cutoff), "all");
assert.strictEqual(schema.parse_value("ALL", cutoff), 0);
assert.strictEqual(schema.parse_value("0,5", cutoff), 0.5);
assert.deepStrictEqual(cutoff.then, {candidate_filter: "cost"});

// UI zoom is read and typed as a percentage.

let zoom = row("zoom_factor");
assert.strictEqual(schema.format_value(0.61, zoom), "61");
assert.strictEqual(schema.parse_value("61%", zoom), 0.61);
assert.strictEqual(schema.step_value(0.61, zoom, 1), 0.7);
assert.strictEqual(schema.step_value(0.61, zoom, -1), 0.6);
assert.ok(schema.problem_with(0.4, zoom).includes("50–300 %"));

// Without presets, a fixed step, clamped.

let tree = row("tree_pane_height");
assert.strictEqual(schema.step_value(280, tree, 1), 320);
assert.strictEqual(schema.step_value(100, tree, -1), 80);

// How long a limit takes at a measured speed.

assert.strictEqual(schema.estimate(1000000, 1000), "≈17 min");
assert.strictEqual(schema.estimate(10000, 1000), "≈10 s");
assert.strictEqual(schema.estimate(10000000, 1000), "≈2.8 h");
assert.strictEqual(schema.estimate(1000000, 25000), "≈40 s");
assert.strictEqual(schema.estimate(1000000, null), "");
assert.strictEqual(schema.format_rate(990.4), "990");
assert.strictEqual(schema.format_rate(25400), "25k");

console.log(`settings_schema tests passed (${rows.length} rows)`);
