"use strict";

// Explored moves (PRODUCT.md, "Explored moves"). A search of the position after
// a move is an evaluation of that move. Back at the parent, a move whose own
// position was searched with more visits than the parent's search gave it shows
// that search's result in place of the parent's estimate.

const SETTINGS_KEYS = ["rules", "komi", "boardXSize", "boardYSize", "overrideSettings"];
const SETTINGS_CACHE_LIMIT = 1000;

const settings_cache = new Map();		// analysis context --> settings_of() result

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

// Root results of node's children that are single moves by the side to move,
// searched with the same settings as node's own search.

function child_results(node) {

	if (!node.has_valid_analysis()) {
		return [];
	}

	let board = node.get_board();
	let key = board.active === "b" ? "B" : "W";
	let ret = [];

	for (let child of node.children) {
		if (child.move_count() !== 1 || !child.has_key(key) || child.has_key("AB") || child.has_key("AW") || child.has_key("AE")) {
			continue;
		}
		if (!child.has_valid_analysis() || !same_settings(node.analysis_context, child.analysis_context)) {
			continue;
		}
		let root = child.analysis.rootInfo;
		let top = child.analysis.moveInfos[0];
		ret.push({
			move: board.gtp(child.get(key)),
			visits: root.visits,
			winrate: root.winrate,
			scoreLead: root.scoreLead,
			scoreSelfplay: root.scoreSelfplay,
			pv: top && Array.isArray(top.pv) ? top.pv : [],
			ownership: child.analysis.ownership,
		});
	}

	return ret;
}

// node's moveInfos with its explored children merged in. Without explored
// children this is node.analysis.moveInfos itself.

function node_infos(node) {

	if (!node.has_valid_analysis()) {
		return [];
	}

	let results = child_results(node);
	if (results.length === 0) {
		return node.analysis.moveInfos;
	}

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

	return merge(node.analysis.moveInfos, results, prior_of);
}

module.exports = {same_settings, merge, child_results, node_infos};
