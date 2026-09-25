"use strict";

// Per-search value history of every candidate move, for the Move Report's Eval
// history card (PRODUCT.md). Each KataGo report is recorded under its query id,
// so each search of a position has its own history. Samples are log-spaced:
// every report for the first few seconds, then each kept sample at least 4% of
// the elapsed time after the one before, so an hour-long search keeps only a
// few hundred. The newest sample always holds the latest report.

const MAX_SEARCHES = 40;
const MIN_GAP = 0.05;			// Seconds: under the default 0.1 s report interval, so jitter never drops early reports.
const LOG_GAP = 0.04;			// Fraction of the elapsed time.

const searches = new Map();		// query id --> search, least recently used first.

function touch(id, search) {
	searches.delete(id);
	searches.set(id, search);
	while (searches.size > MAX_SEARCHES) {
		searches.delete(searches.keys().next().value);
	}
}

function gap_after(t) {
	return Math.max(MIN_GAP, t * LOG_GAP);
}

exports.record = function(o, now_ms) {

	if (!o || typeof o.id !== "string" || !o.rootInfo || !Array.isArray(o.moveInfos)) {
		return;
	}

	let search = searches.get(o.id);
	if (!search) {
		search = {t0: now_ms, times: [], roots: [], moves: new Map()};
	}
	touch(o.id, search);

	// The last sample is live: each report overwrites it until it is a full gap
	// after the sample before it, and then the next report starts a new one.

	let t = Math.max(0, (now_ms - search.t0) / 1000);
	let n = search.times.length;
	let live = n >= 2 && search.times[n - 1] - search.times[n - 2] < gap_after(search.times[n - 2]) - 1e-6;
	let k = live ? n - 1 : n;

	search.times[k] = t;
	search.roots[k] = o.rootInfo.visits;

	for (let info of o.moveInfos) {
		if (typeof info.move !== "string" || typeof info.scoreLead !== "number") {
			continue;
		}
		let m = search.moves.get(info.move);
		if (!m) {
			m = {k: [], lead: [], visits: []};
			search.moves.set(info.move, m);
		}
		let j = m.k.length;
		if (j > 0 && m.k[j - 1] === k) {
			j--;
		}
		m.k[j] = k;
		m.lead[j] = info.scoreLead;
		m.visits[j] = info.visits;
	}
};

exports.get = function(id) {
	let search = searches.get(id);
	if (!search) {
		return null;
	}
	touch(id, search);
	return search;
};

// A move's samples from min_t seconds on, once it has at least min_visits visits
// (a move's first few visits give a noisy score). Scores stay Black-POV.

exports.points = function(search, move, min_t, min_visits) {
	let m = search.moves.get(move);
	let ret = [];
	if (!m) {
		return ret;
	}
	for (let j = 0; j < m.k.length; j++) {
		let t = search.times[m.k[j]];
		if (t >= min_t && !(m.visits[j] < min_visits)) {
			ret.push({t, lead: m.lead[j], visits: m.visits[j]});
		}
	}
	return ret;
};

// What the engine said at time t: the last sample at or before it.

exports.value_at = function(points, t) {
	let ret = null;
	for (let p of points) {
		if (p.t > t + 1e-9) {
			break;
		}
		ret = p;
	}
	return ret;
};

const LOG_TICKS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18000, 36000];
const LINEAR_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

exports.time_ticks = function(t_lo, t_hi, log) {
	if (log) {
		return LOG_TICKS.filter(t => t >= t_lo - 1e-9 && t <= t_hi + 1e-9);
	}
	let step = LINEAR_STEPS.find(s => t_hi / s <= 6) || LINEAR_STEPS[LINEAR_STEPS.length - 1];
	let ret = [];
	for (let t = Math.ceil(t_lo / step) * step; t <= t_hi + 1e-9; t += step) {
		ret.push(t);
	}
	return ret;
};

exports.fmt_time = function(t) {
	if (t < 60) {
		return `${Math.round(t)}s`;
	}
	if (t < 3600) {
		let m = Math.floor(t / 60);
		let s = Math.round(t - m * 60);
		return s === 0 ? `${m}m` : `${m}m${s}s`;
	}
	let h = Math.floor(t / 3600);
	let m = Math.round((t - h * 3600) / 60);
	return m === 0 ? `${h}h` : `${h}h${m}m`;
};

exports.reset = function() {			// For tests.
	searches.clear();
};
