"use strict";

// Per-search value history of every candidate move, for the Move Report's Eval
// history card (PRODUCT.md). Each KataGo report is recorded under its query id,
// so each search of a position has its own history. Samples are log-spaced:
// every report for the first few seconds, then each kept sample at least 4% of
// the elapsed time after the one before, so an hour-long search keeps only a
// few hundred. The newest sample always holds the latest report.

exports.START_VISITS = 1000;	// Search visits before anything is plotted: the first second or so is mostly noise.

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
		search = {t0: now_ms, times: [], roots: [], moves: new Map(), shown: new Set()};
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

// Moves drawn as candidates at any point since the chart started (START_VISITS);
// the chart keeps their lines. Earlier board membership is just exploration order.

exports.note_shown = function(id, moves, root_visits) {
	let search = searches.get(id);
	if (search && root_visits >= exports.START_VISITS) {
		for (let move of moves) {
			search.shown.add(move);
		}
	}
};

// A move's samples once the search has min_root visits and the move itself has
// min_visits (a move's first few visits give a noisy score). Scores stay Black-POV.

exports.points = function(search, move, min_root, min_visits) {
	let m = search.moves.get(move);
	let ret = [];
	if (!m) {
		return ret;
	}
	for (let j = 0; j < m.k.length; j++) {
		let root = search.roots[m.k[j]];
		if (root >= min_root && !(m.visits[j] < min_visits)) {
			ret.push({t: search.times[m.k[j]], root, lead: m.lead[j], visits: m.visits[j]});
		}
	}
	return ret;
};

// What the engine said at x (in whatever units the points' x use): the last sample at or before it.

exports.value_at = function(points, x) {
	let ret = null;
	for (let p of points) {
		if (p.x > x + 1e-9) {
			break;
		}
		ret = p;
	}
	return ret;
};

// A move's rank by visits among every move the search reported, at each sample
// from min_root root visits on. KataGo's own order is mostly by visits.

exports.visit_ranks = function(search, move, min_root = 0) {
	let m = search.moves.get(move);
	if (!m) {
		return [];
	}
	let mine = new Map();
	for (let j = 0; j < m.k.length; j++) {
		if (search.roots[m.k[j]] >= min_root) {
			mine.set(m.k[j], {root: search.roots[m.k[j]], visits: m.visits[j], rank: 1});
		}
	}
	for (let [other, o] of search.moves) {
		if (other === move) {
			continue;
		}
		for (let j = 0; j < o.k.length; j++) {
			let r = mine.get(o.k[j]);
			if (r && o.visits[j] > r.visits) {
				r.rank++;
			}
		}
	}
	return [...mine.values()].map(r => ({root: r.root, rank: r.rank}));
};

// The search's root visits at the first sample reporting the move at all
// (KataGo reports every move with a visit), or null.

exports.first_seen = function(search, move) {
	let m = search.moves.get(move);
	return m && m.k.length > 0 ? search.roots[m.k[0]] : null;
};

// About max_ticks ticks, at round numbers; on a log axis 1, 2, 5 per decade,
// or 1, 2, 3, 5, 7 when there is room for that many.

exports.visit_ticks = function(lo, hi, log, max_ticks = 6) {
	let ret = [];
	if (log) {
		let decades = Math.log10(hi / Math.max(1, lo));
		let mults = max_ticks / Math.max(1, decades) >= 5 ? [1, 2, 3, 5, 7] : [1, 2, 5];
		for (let decade = 1; decade <= hi; decade *= 10) {
			for (let m of mults) {
				let n = decade * m;
				if (n >= lo && n <= hi) {
					ret.push(n);
				}
			}
		}
		return ret;
	}
	let steps = [];
	for (let decade = 1; decade <= hi; decade *= 10) {
		steps.push(decade, decade * 2, decade * 5);
	}
	let step = steps.find(s => hi / s <= max_ticks) || Math.max(1, hi);
	for (let n = Math.ceil(lo / step) * step; n <= hi; n += step) {
		ret.push(n);
	}
	return ret;
};

exports.fmt_count = function(n) {						// 1500 --> "1.5k", 20000 --> "20k", 2000000 --> "2M"
	let trim = (x) => String(Number(x.toFixed(1)));
	if (n >= 1e6) return `${trim(n / 1e6)}M`;
	if (n >= 1e3) return `${trim(n / 1e3)}k`;
	return String(Math.round(n));
};

// Chooses a place for every line's label, in priority order: just right of the
// line's end if free; else on the line itself, as far right as there is room;
// else beside the end, shifted up or down to the nearest free spot (drawn with a
// leader). Never leaves a line unlabelled. Lines are {w, h, px: [], py: []} in
// canvas coordinates; obstacles and area are {x0, y0, x1, y1}.

exports.place_line_labels = function(lines, obstacles, area) {

	let taken = obstacles.slice();
	let fits = (r) => r.x0 >= area.x0 && r.x1 <= area.x1 && r.y0 >= area.y0 && r.y1 <= area.y1 &&
		!taken.some(t => r.x0 < t.x1 && t.x0 < r.x1 && r.y0 < t.y1 && t.y0 < r.y1);

	return lines.map(line => {

		let n = line.px.length;
		let ex = line.px[n - 1];
		let ey = line.py[n - 1];
		let box = (x, y) => ({x0: x - line.w / 2, y0: y - line.h / 2, x1: x + line.w / 2, y1: y + line.h / 2});
		let take = (x, y, kind) => {
			taken.push(box(x, y));
			return {x, y, kind};
		};
		let end_x = ex + 6 + line.w / 2;

		if (fits(box(end_x, ey))) {
			return take(end_x, ey, "end");
		}

		let j = n - 1;
		for (let x = ex - line.w / 2 - 2; n > 1 && x >= line.px[0] + line.w / 2; x -= 3) {
			while (j > 0 && line.px[j - 1] > x) {
				j--;
			}
			let i = Math.max(0, j - 1);
			let span = line.px[j] - line.px[i];
			let y = span > 0 ? line.py[i] + (line.py[j] - line.py[i]) * (x - line.px[i]) / span : line.py[j];
			if (fits(box(x, y))) {
				return take(x, y, "on");
			}
		}

		for (let step = 1; step * line.h / 2 <= area.y1 - area.y0; step++) {
			for (let dir of [-1, 1]) {
				let y = ey + dir * step * line.h / 2;
				if (fits(box(end_x, y))) {
					return take(end_x, y, "leader");
				}
			}
		}

		return take(end_x, ey, "end");
	});
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
