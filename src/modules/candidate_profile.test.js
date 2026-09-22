"use strict";

const assert = require("assert");
const {profile} = require("./candidate_profile");

let cliff = profile([0, ...Array(100).fill(0.31)]);
assert.strictEqual(cliff.within[1], 1);
assert.strictEqual(cliff.bands[3], 100);
assert.strictEqual(cliff.nearest_outside_030, 0.31);

let forced = profile([0, 10]);
assert.strictEqual(forced.second, 10);
assert.strictEqual(forced.largest_gap.size, 10);

let tied = profile([0, 0, 0.1, 0.3, 1, 3, 10, 11], 20);
assert.deepStrictEqual(tied.bands, [1, 2, 1, 1, 1, 1, 1]);
assert.strictEqual(tied.truncated, true);

let invalid = profile([0, -1, NaN, Infinity, "0.2"]);
assert.deepStrictEqual(invalid.costs, [0]);

console.log("candidate_profile tests passed");
