"use strict";

// Scale-free continuation narrowness & forcing analysis.
//
// Avoids arbitrary fixed point cutoffs (e.g. "within 0.5 pt"). Instead every
// metric is either in raw Go points or a dimensionless effective move count:
//
//   - gap2        (points): cost of the 2nd-best distinct reply. Directly
//                           measures the penalty for missing the unique best
//                           reply (0 = wide tie, +3.0 = strictly forcing).
//   - eff_moves   (count):  Shannon effective number of choices exp(H) over
//                           MCTS visit shares (Hill number ^1D). 1.0 = one
//                           forced reply took all search; 5.0 = ~5 real options.
//   - policy_cost (points): expected point loss weighted by KataGo's raw NN
//                           policy priors sum(pi_j * cost_j) / sum(pi_j).
//                           Separates obvious forcing moves (low policy_cost)
//                           from sharp/tricky continuations (high policy_cost).
//   - top_replies:          actual top replies with cost, visits, and prior so
//                           the reviewer can read the cliff directly.

const {info_cost} = require("./utils");
const {best_index} = require("./explored");
const {new_query} = require("./query");

let next_probe_id = 1;

function summarize_position(analysis, active_is_b) {

	if (!analysis || !Array.isArray(analysis.moveInfos) || analysis.moveInfos.length === 0) {
		return null;
	}

	let infos = analysis.moveInfos;
	let root_visits = analysis.rootInfo && typeof analysis.rootInfo.visits === "number"
		? analysis.rootInfo.visits
		: infos.reduce((acc, info) => acc + (typeof info.visits === "number" ? info.visits : 0), 0);

	// Best move uses a small relative visit floor (2% of root, min 2 when root >= 20)
	// so a 1-visit noise outlier cannot skew gap2 or reference score.
	let min_v = root_visits >= 20 ? Math.max(2, Math.floor(root_visits * 0.02)) : 0;
	let bi = best_index(infos, active_is_b, min_v);
	let best = infos[bi];
	let best_lead = typeof best.scoreLead === "number" ? best.scoreLead : null;

	let entries = infos.map((info, i) => ({
		move: info.move,
		visits: typeof info.visits === "number" ? info.visits : 0,
		scoreLead: typeof info.scoreLead === "number" ? info.scoreLead : null,
		winrate: typeof info.winrate === "number" ? info.winrate : null,
		prior: typeof info.prior === "number" && info.prior >= 0 ? info.prior : null,
		cost: best_lead !== null ? info_cost(info, best_lead, active_is_b) : null,
		is_best: i === bi,
		pv: Array.isArray(info.pv) ? info.pv.slice() : [],
	}));

	let total_visits = entries.reduce((acc, e) => acc + e.visits, 0);

	// Shannon effective number of choices exp(H) over MCTS visit shares.
	let eff_moves = 1;
	if (total_visits > 0) {
		let h = 0;
		for (let e of entries) {
			if (e.visits > 0) {
				let p = e.visits / total_visits;
				h -= p * Math.log(p);
			}
		}
		eff_moves = Math.exp(h);
	}

	// Second-best penalty in points: smallest cost among other moves meeting
	// the relative visit floor (falling back to any other scored move).
	let others_reliable = entries.filter(e => !e.is_best && e.cost !== null && e.visits >= min_v);
	let others_any = entries.filter(e => !e.is_best && e.cost !== null);
	let pool = others_reliable.length > 0 ? others_reliable : others_any;
	let gap2 = null;
	if (pool.length > 0) {
		gap2 = pool.reduce((min, e) => Math.min(min, e.cost), Infinity);
	}

	// Policy-weighted expected point loss across searched moves (pure points, zero cutoff).
	let policy_mass = 0;
	let policy_weighted_loss = 0;
	let top_policy = null;
	for (let e of entries) {
		if (e.prior !== null && e.cost !== null) {
			policy_mass += e.prior;
			policy_weighted_loss += e.prior * e.cost;
			if (!top_policy || e.prior > top_policy.prior) {
				top_policy = e;
			}
		}
	}
	let policy_cost = policy_mass > 0 ? policy_weighted_loss / policy_mass : null;

	// Sort top replies: best first, then ascending cost (tie-break by visits desc).
	let sorted = entries.slice().sort((a, b) => {
		if (a.is_best !== b.is_best) return a.is_best ? -1 : 1;
		let ca = a.cost === null ? Infinity : a.cost;
		let cb = b.cost === null ? Infinity : b.cost;
		if (ca !== cb) return ca - cb;
		return b.visits - a.visits;
	});

	let top_replies = sorted.slice(0, 4).map(e => ({
		move: e.move,
		cost: e.cost,
		visits: e.visits,
		share: total_visits > 0 ? e.visits / total_visits : 0,
		prior: e.prior,
		is_best: e.is_best,
	}));

	return {
		visits: root_visits,
		active_is_b,
		best_move: best.move,
		best_pv: entries[bi].pv,
		best_lead,
		best_prior: entries[bi].prior,
		gap2,
		eff_moves,
		policy_cost,
		policy_mass,
		top_policy_move: top_policy ? top_policy.move : null,
		top_policy_cost: top_policy ? top_policy.cost : null,
		top_replies,
	};
}

// Build a polite background KataGo analysis query for `parent_node` followed by
// `gtp_sequence` (e.g. ["C17"] or ["C17", "D16"]). Uses priority -10 so the
// interactive root search always takes precedence on single-thread configs,
// while running in parallel on multi-thread configs (numAnalysisThreads >= 2).

function build_probe_query(parent_node, gtp_sequence, eng_version, maxvisits) {

	if (!parent_node || !Array.isArray(gtp_sequence) || gtp_sequence.length === 0) {
		throw new Error("build_probe_query(): requires parent_node and non-empty gtp_sequence");
	}

	let visits = Math.max(2, Math.round(maxvisits));
	let q = new_query(parent_node, eng_version, visits, null);

	q.id = `probe:${next_probe_id++}`;
	q.maxVisits = visits;
	q.priority = -10;
	q.includeOwnership = false;
	q.includeMovesOwnership = false;
	q.includePolicy = true;
	q.analysisPVLen = 12;
	delete q.reportDuringSearchEvery;
	delete q.firstReportDuringSearchAfter;

	let side = parent_node.get_board().active;		// "b" or "w"
	let seq_moves = [];
	for (let gtp of gtp_sequence) {
		let m = String(gtp).toLowerCase() === "pass" ? "pass" : String(gtp).toUpperCase();
		seq_moves.push([side.toUpperCase(), m]);
		side = side === "b" ? "w" : "b";
	}

	// If parent query had no moves, initialPlayer was set for parent_node.active.
	// Appending seq_moves starts from parent_node.active, so KataGo follows the
	// explicit colors in moves and leaves `side` to play next.
	if (q.moves.length === 0 && q.initialPlayer) {
		delete q.initialPlayer;
	}
	q.moves = q.moves.concat(seq_moves);

	return {
		query: q,
		next_active_is_b: side === "b",
	};
}

// Relative comparison of opponent narrowness across a position's candidates
// (used for visual bar scaling — always relative to this position's own spread,
// never hard-coded to an arbitrary point threshold).

function relative_narrowness_scale(summaries) {
	let max_gap2 = 0;
	let max_eff = 1;
	for (let s of summaries) {
		if (!s) continue;
		if (typeof s.gap2 === "number" && s.gap2 > max_gap2) max_gap2 = s.gap2;
		if (typeof s.eff_moves === "number" && s.eff_moves > max_eff) max_eff = s.eff_moves;
	}
	return {
		max_gap2: Math.max(0.5, max_gap2),
		max_eff: Math.max(2, max_eff),
	};
}

module.exports = {
	summarize_position,
	build_probe_query,
	relative_narrowness_scale,
};
