"use strict";

// Explored moves (PRODUCT.md, "Explored moves"). A search of the position after
// a move is an evaluation of that move. Back at the parent, a move whose own
// position was searched with more visits than the parent's search gave it shows
// that search's result in place of the parent's estimate.
//
// Inherited values (PRODUCT.md, "Inherited values") read the same fact the other
// way: the parent's search of a move is a search of the position after it.
//
// The best move (PRODUCT.md, "One best move"): a position's own search picks it,
// and its value, explored when the position after it was searched more, is the
// position's value. An explored move therefore carries the value of the
// position after it, which can itself come from a search further down the line.

const SETTINGS_KEYS = ["rules", "komi", "boardXSize", "boardYSize", "overrideSettings"];
const SETTINGS_CACHE_LIMIT = 1000;

const settings_cache = new Map();		// analysis context --> settings_of() result

// Per-node lists and best moves, valid until any node changes (Node calls
// invalidate()) or the visit minimum does. Values pass up explored lines, so
// one report can change every ancestor's list.

let generation = 0;
const memo = new WeakMap();				// node --> {generation, min_visits, infos, best}

function invalidate() {
	generation++;
}

function min_visits() {
	let n = config.candidate_min_visits;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

// Index of the best move in infos (Black-POV moveInfos): the entry leaving the
// side to move the most points among those with at least min visits, ties to
// the earlier entry; KataGo's first entry when none qualifies. -1 when empty.

function best_index(infos, active_is_b, min) {
	let best = -1;
	for (let i = 0; i < infos.length; i++) {
		let lead = infos[i].scoreLead;
		if (typeof lead !== "number" || (min > 0 && !(infos[i].visits >= min))) {
			continue;
		}
		if (best === -1 || (active_is_b ? lead > infos[best].scoreLead : lead < infos[best].scoreLead)) {
			best = i;
		}
	}
	return best !== -1 ? best : (infos.length > 0 ? 0 : -1);
}

// The parts of an analysis context (query.js) that must match between two
// searches for one to stand in for the other: the engine and every search
// setting except the position. The engine's version is left out: it reads
// [1, 0, 0] until KataGo answers the version query, and the executable's path
// already identifies it. A search restricted by avoidMoves or allowMoves did
// not evaluate its position freely, which is reported as `restricted`.

function settings_of(context) {

	if (typeof context !== "string") {
		return null;
	}
	if (settings_cache.has(context)) {
		return settings_cache.get(context);
	}

	let ret = null;
	try {
		let o = JSON.parse(context);
		let search = o.search || {};
		let engine = Object.assign({}, o.engine);
		delete engine.version;
		let picked = {};
		for (let key of SETTINGS_KEYS) {
			if (Object.prototype.hasOwnProperty.call(search, key)) {
				picked[key] = search[key];
			}
		}
		ret = {
			key: JSON.stringify({engine, search: picked}),
			restricted: Object.prototype.hasOwnProperty.call(search, "avoidMoves") || Object.prototype.hasOwnProperty.call(search, "allowMoves"),
		};
	} catch (err) {
		ret = null;
	}

	if (settings_cache.size >= SETTINGS_CACHE_LIMIT) {
		settings_cache.clear();
	}
	settings_cache.set(context, ret);
	return ret;
}

function same_settings(parent_context, child_context) {
	let parent = settings_of(parent_context);
	let child = settings_of(child_context);
	return Boolean(parent && child && !child.restricted && parent.key === child.key);
}

// results: [{move, visits, winrate, scoreLead, scoreSelfplay, pv, ownership}],
// each the root of a search of the position after `move`, values Black-POV like
// moveInfos. The result is a moveInfos-like list in engine order: a move whose
// result had more visits than the parent's own entry gets the result in that
// entry's place, and moves the parent's search never reported follow, most
// visits first. Explored entries carry `explored: {own}`, where own is the
// parent's entry they replaced (null when it reported none).

function merge(infos, results, prior_of = null) {

	let best = new Map();
	for (let r of results) {
		if (!Number.isFinite(r.visits) || r.visits <= 0) {
			continue;
		}
		let have = best.get(r.move);
		if (!have || r.visits > have.visits) {
			best.set(r.move, r);
		}
	}

	let reported = new Set();
	let merged = infos.map(info => {
		reported.add(info.move);
		let r = best.get(info.move);
		if (r && r.visits > info.visits) {
			return explored_info(r, info.order, info.prior, info);
		}
		return info;
	});

	let extra = [...best.values()].filter(r => !reported.has(r.move)).sort((a, b) => b.visits - a.visits);
	for (let r of extra) {
		merged.push(explored_info(r, merged.length, prior_of ? prior_of(r.move) : undefined, null));
	}

	return merged;
}

function explored_info(r, order, prior, own) {
	let info = {
		move: r.move,
		order: order,
		visits: r.visits,
		winrate: r.winrate,
		scoreLead: r.scoreLead,
		pv: [r.move].concat(Array.isArray(r.pv) ? r.pv : []),
		explored: {own},
	};
	if (typeof prior === "number") {
		info.prior = prior;
	}
	if (typeof r.scoreSelfplay === "number") {
		info.scoreSelfplay = r.scoreSelfplay;
	}
	if (r.ownership) {
		info.ownership = r.ownership;
	}
	return info;
}

// The move into node in GTP form ("pass" for a pass) when node is a single move
// by its parent's side to move with no setup stones; otherwise null.

function move_into(node) {

	let parent = node.parent;
	if (!parent || node.move_count() !== 1 || node.has_key("AB") || node.has_key("AW") || node.has_key("AE")) {
		return null;
	}

	let board = parent.get_board();
	let key = board.active === "b" ? "B" : "W";
	return node.has_key(key) ? board.gtp(node.get(key)) : null;
}

// Results of node's children that are single moves by the side to move,
// searched with the same settings as node's own search and with more visits
// than it gave the move (only those can replace an entry). Each carries the
// child's value, its best move as the child lists it, so what was explored
// below the child counts too; visits are the child's own search's.

function child_results(node) {

	if (!node.has_valid_analysis()) {
		return [];
	}

	let ret = [];

	for (let child of node.children) {
		let move = move_into(child);
		if (move === null || !child.has_valid_analysis() || !same_settings(node.analysis_context, child.analysis_context)) {
			continue;
		}
		let visits = child.analysis.rootInfo.visits;
		let own = node.analysis.moveInfos.find(o => o.move === move);
		if (own && !(visits > own.visits)) {
			continue;
		}
		let best = best_info(child);
		ret.push({
			move: move,
			visits: visits,
			winrate: best.winrate,
			scoreLead: best.scoreLead,
			scoreSelfplay: best.scoreSelfplay,
			pv: Array.isArray(best.pv) ? best.pv : [],
			ownership: child.analysis.ownership,
		});
	}

	return ret;
}

function entry(node) {

	let min = min_visits();
	let m = memo.get(node);
	if (m && m.generation === generation && m.min_visits === min) {
		return m;
	}

	let own = node.analysis.moveInfos;
	let results = child_results(node);
	let board = node.get_board();
	let policy = node.analysis.policy;

	let prior_of = (gtp) => {
		if (!Array.isArray(policy)) {
			return undefined;
		}
		let s = board.parse_gtp_move(gtp);
		let i = s.length === 2
			? (s.charCodeAt(1) - 97) * board.width + (s.charCodeAt(0) - 97)
			: board.width * board.height;
		return typeof policy[i] === "number" && policy[i] >= 0 ? policy[i] : undefined;
	};

	m = {
		generation: generation,
		min_visits: min,
		infos: results.length === 0 ? own : merge(own, results, prior_of),
		best: best_index(own, board.active === "b", min),
	};
	memo.set(node, m);
	return m;
}

// node's moveInfos with its explored children merged in. Without explored
// children this is node.analysis.moveInfos itself.

function node_infos(node) {
	return node.has_valid_analysis() ? entry(node).infos : [];
}

// The index of node's best move, chosen from its own search: the same in
// node_infos(node) and node.analysis.moveInfos, since explored values replace
// entries in place. -1 without a search.

function node_best(node) {
	return node.has_valid_analysis() ? entry(node).best : -1;
}

// node's best move as node_infos(node) lists it, explored value included: the
// value the position's own search leads to. Null without a search.

function best_info(node) {
	if (!node.has_valid_analysis()) {
		return null;
	}
	let m = entry(node);
	return m.infos[m.best];
}

// The parent's own search of the move into node, as a root of node's position:
// {visits, winrate, scoreLead, scoreSelfplay}, Black-POV like rootInfo. Null
// unless it searched node's position more than node's own search did, with the
// same settings. Without a search of its own, node takes it unless its SGF
// carries saved values, whose visit counts are unknown.

function inherited_root(node) {

	let parent = node.parent;
	if (!parent || !parent.has_valid_analysis()) {
		return null;
	}

	let move = move_into(node);
	let info = move === null ? null : parent.analysis.moveInfos.find(o => o.move === move);
	if (!info || !Number.isFinite(info.visits) || info.visits <= 0) {
		return null;
	}

	if (node.has_valid_analysis()) {
		if (info.visits <= node.analysis.rootInfo.visits || !same_settings(parent.analysis_context, node.analysis_context)) {
			return null;
		}
	} else if (node.has_key("SBKV") || node.has_key("OGSC")) {
		return null;
	}

	return {visits: info.visits, winrate: info.winrate, scoreLead: info.scoreLead, scoreSelfplay: info.scoreSelfplay};
}

module.exports = {same_settings, merge, child_results, node_infos, inherited_root, best_index, node_best, best_info, min_visits, invalidate};
