"use strict";

const THRESHOLDS = [0.10, 0.30, 1.00, 3.00, 10.00];

const BAND_LABELS = [
	"best",
	"≤0.10",
	"0.10–0.30",
	"0.30–1",
	"1–3",
	"3–10",
	">10",
];

function normalized_costs(raw_costs) {
	if (!Array.isArray(raw_costs)) {
		return [];
	}
	return raw_costs
		.filter(cost => typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
		.map(cost => Math.max(0, cost))
		.sort((a, b) => a - b);
}

function quantile(sorted, fraction) {
	if (sorted.length === 0) {
		return null;
	}
	let index = (sorted.length - 1) * fraction;
	let low = Math.floor(index);
	let high = Math.ceil(index);
	if (low === high) {
		return sorted[low];
	}
	return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function profile(raw_costs, reported_total = null) {
	let costs = normalized_costs(raw_costs);
	let alternatives = costs.slice(1);
	let within = THRESHOLDS.map(threshold =>
		costs.reduce((count, cost) => count + (cost <= threshold + Number.EPSILON ? 1 : 0), 0)
	);
	let bands = new Array(BAND_LABELS.length).fill(0);

	if (costs.length > 0) {
		bands[0] = 1;
	}
	for (let cost of alternatives) {
		if (cost <= 0.10 + Number.EPSILON) bands[1]++;
		else if (cost <= 0.30 + Number.EPSILON) bands[2]++;
		else if (cost <= 1.00 + Number.EPSILON) bands[3]++;
		else if (cost <= 3.00 + Number.EPSILON) bands[4]++;
		else if (cost <= 10.00 + Number.EPSILON) bands[5]++;
		else bands[6]++;
	}

	let largest_gap = null;
	for (let i = 1; i < costs.length; i++) {
		let gap = costs[i] - costs[i - 1];
		if (!largest_gap || gap > largest_gap.size) {
			largest_gap = {size: gap, from: costs[i - 1], to: costs[i], rank: i + 1};
		}
	}

	let known_reported_total = Number.isInteger(reported_total) && reported_total >= costs.length
		? reported_total
		: null;

	return {
		costs,
		alternatives,
		within,
		bands,
		total: costs.length,
		reported_total: known_reported_total,
		truncated: known_reported_total !== null && known_reported_total > costs.length,
		second: costs.length > 1 ? costs[1] : null,
		nearest_outside_030: costs.find(cost => cost > 0.30 + Number.EPSILON) ?? null,
		median: quantile(costs, 0.5),
		p90: quantile(costs, 0.9),
		worst: costs.length > 0 ? costs[costs.length - 1] : null,
		largest_gap,
	};
}

module.exports = {
	BAND_LABELS,
	THRESHOLDS,
	normalized_costs,
	profile,
};
