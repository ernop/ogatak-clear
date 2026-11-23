"use strict";

// Background continuation prober for scale-free narrowness & corridor tracing.
//
// Reads any existing analyzed child nodes from the game tree first (instant,
// zero GPU queries, leveraging pre-analysis or manual exploration). For
// unanalyzed candidates (natural top moves union any played/variation moves),
// runs polite sequential priority=-10 KataGo probes once the root position's
// search has warmed up (default >= 250 visits), caching results by
// (position context, move sequence).

const {summarize_position, build_probe_query} = require("./narrowness");

const MAX_CACHE_ENTRIES = 600;
const AUTO_PROBE_MIN_ROOT_VISITS = 250;

function init() {
	return Object.assign(Object.create(prober_prototype), {
		cache: new Map(),				// key --> summary (LRU order)
		queue: [],						// [{node, node_key, seq, target_visits, trace_remaining}]
		in_flight: null,				// {id, node, node_key, seq, target_visits, trace_remaining}
		active_node_id: null,
		listeners: [],
	});
}

function node_cache_key(node) {
	if (!node) return "";
	return node.analysis_context || `${node.id}:${node.get_board().zobrist_string()}`;
}

function seq_cache_key(node_key, seq) {
	return `${node_key}|${seq.join(",")}`;
}

// Walk existing SGF tree children along `gtp_sequence`. If every step exists
// and the leaf node has a valid analysis snapshot, summarize it directly.

function lookup_in_tree(node, gtp_sequence) {
	let cur = node;
	for (let gtp of gtp_sequence) {
		if (!cur || cur.destroyed) return null;
		let board = cur.get_board();
		let key = board.active.toUpperCase();
		let is_pass = String(gtp).toLowerCase() === "pass";
		let target_s = is_pass ? "" : board.parse_gtp_move(gtp);
		let next = null;
		for (let child of cur.children) {
			if (!child.has_key(key)) continue;
			let val = child.get(key);
			if (is_pass ? !board.in_bounds(val) : val === target_s) {
				next = child;
				break;
			}
		}
		if (!next) return null;
		cur = next;
	}
	if (!cur || !cur.has_valid_analysis()) {
		return null;
	}
	let summary = summarize_position(cur.analysis, cur.get_board().active === "b");
	if (summary) {
		summary.source = "tree";
	}
	return summary;
}

let prober_prototype = {

	on_update: function(fn) {
		this.listeners.push(fn);
	},

	emit_update: function() {
		for (let fn of this.listeners) {
			fn();
		}
	},

	put_cache: function(key, summary) {
		let prev = this.cache.get(key);
		if (prev && prev.visits > summary.visits) {
			return;
		}
		this.cache.delete(key);
		this.cache.set(key, summary);
		while (this.cache.size > MAX_CACHE_ENTRIES) {
			let oldest = this.cache.keys().next().value;
			this.cache.delete(oldest);
		}
	},

	lookup: function(node, gtp_sequence) {
		if (!node || node.destroyed || !Array.isArray(gtp_sequence) || gtp_sequence.length === 0) {
			return null;
		}
		let from_tree = lookup_in_tree(node, gtp_sequence);
		let key = seq_cache_key(node_cache_key(node), gtp_sequence);
		let from_cache = this.cache.get(key) || null;
		if (from_tree && from_cache) {
			return from_tree.visits >= from_cache.visits ? from_tree : from_cache;
		}
		return from_tree || from_cache;
	},

	corridor_chain: function(node, gtp_move, max_plies = 4) {
		if (!node || node.destroyed || !gtp_move) {
			return [];
		}
		let chain = [];
		let seq = [gtp_move];
		let mover_is_b = node.get_board().active === "b";

		for (let ply = 0; ply < max_plies; ply++) {
			let summary = this.lookup(node, seq);
			if (!summary) {
				break;
			}
			chain.push({
				ply: ply + 1,
				move_played: seq[seq.length - 1],
				mover_is_b,
				seq: seq.slice(),
				summary,
			});
			if (!summary.best_move) {
				break;
			}
			seq.push(summary.best_move);
			mover_is_b = !mover_is_b;
		}
		return chain;
	},

	is_busy_for: function(node) {
		if (!node) return false;
		if (this.in_flight && this.in_flight.node === node) return true;
		return this.queue.some(item => item.node === node);
	},

	status: function(node) {
		if (!node) {
			return {in_flight: false, queued: 0};
		}
		return {
			in_flight: Boolean(this.in_flight && this.in_flight.node === node),
			queued: this.queue.filter(item => item.node === node).length,
		};
	},

	on_node_change: function(node) {
		let next_id = node ? node.id : null;
		if (next_id === this.active_node_id) {
			return;
		}
		this.active_node_id = next_id;
		this.queue = [];
		this.in_flight = null;
		if (typeof hub !== "undefined" && hub && hub.engine && typeof hub.engine.cancel_probes === "function") {
			hub.engine.cancel_probes();
		}
	},

	enqueue_seq: function(node, seq, target_visits, trace_remaining = 0) {
		if (!node || node.destroyed || !Array.isArray(seq) || seq.length === 0) {
			return;
		}
		let existing = this.lookup(node, seq);
		if (existing && existing.visits >= target_visits) {
			if (trace_remaining > 0 && existing.best_move) {
				this.enqueue_seq(node, seq.concat([existing.best_move]), target_visits, trace_remaining - 1);
			}
			return;
		}
		let node_key = node_cache_key(node);
		let full_key = seq_cache_key(node_key, seq);
		if (this.in_flight && this.in_flight.full_key === full_key && this.in_flight.target_visits >= target_visits) {
			this.in_flight.trace_remaining = Math.max(this.in_flight.trace_remaining, trace_remaining);
			return;
		}
		let queued = this.queue.find(item => item.full_key === full_key);
		if (queued) {
			queued.target_visits = Math.max(queued.target_visits, target_visits);
			queued.trace_remaining = Math.max(queued.trace_remaining, trace_remaining);
			return;
		}
		this.queue.push({node, node_key, full_key, seq: seq.slice(), target_visits, trace_remaining});
		this.pump();
	},

	schedule_for_node: function(node, candidates_gtp, opts = {}) {
		if (!node || node.destroyed || !Array.isArray(candidates_gtp) || candidates_gtp.length === 0) {
			return;
		}
		if (!opts.force) {
			if (!config.continuation_probe) {
				return;
			}
			if (!node.has_valid_analysis() || node.analysis.rootInfo.visits < AUTO_PROBE_MIN_ROOT_VISITS) {
				return;
			}
		}
		if (this.active_node_id !== node.id) {
			this.on_node_change(node);
		}
		let target_visits = opts.visits || config.continuation_probe_visits || 120;
		let trace_plies = typeof opts.trace_plies === "number" ? opts.trace_plies : 0;

		for (let gtp of candidates_gtp) {
			if (gtp) {
				this.enqueue_seq(node, [gtp], target_visits, trace_plies);
			}
		}
	},

	trace_corridor: function(node, gtp_move, max_plies = 4, target_visits = null) {
		if (!node || node.destroyed || !gtp_move) {
			return;
		}
		if (this.active_node_id !== node.id) {
			this.on_node_change(node);
		}
		let visits = target_visits || config.continuation_probe_visits || 120;
		this.enqueue_seq(node, [gtp_move], visits, Math.max(0, max_plies - 1));
	},

	pump: function() {
		if (this.in_flight || this.queue.length === 0) {
			return;
		}
		if (typeof hub === "undefined" || !hub || !hub.engine || hub.engine.is_gtp || !hub.engine.exe || !hub.engine.received_version) {
			return;
		}

		while (this.queue.length > 0) {
			let job = this.queue.shift();
			if (!job.node || job.node.destroyed || job.node.id !== this.active_node_id) {
				continue;
			}
			let existing = this.lookup(job.node, job.seq);
			if (existing && existing.visits >= job.target_visits) {
				if (job.trace_remaining > 0 && existing.best_move) {
					this.enqueue_seq(job.node, job.seq.concat([existing.best_move]), job.target_visits, job.trace_remaining - 1);
				}
				continue;
			}

			let built;
			try {
				built = build_probe_query(job.node, job.seq, hub.engine.version, job.target_visits);
			} catch (err) {
				console.log("continuation_prober:", err.toString());
				continue;
			}

			this.in_flight = Object.assign({id: built.query.id}, job);
			let sent_id = hub.engine.probe(built.query, (result) => {
				if (!this.in_flight || this.in_flight.id !== built.query.id) {
					return;
				}
				let finished = this.in_flight;
				this.in_flight = null;
				if (result && Array.isArray(result.moveInfos) && result.moveInfos.length > 0) {
					let summary = summarize_position(result, built.next_active_is_b);
					if (summary) {
						summary.source = "probe";
						this.put_cache(finished.full_key, summary);
						if (finished.trace_remaining > 0 && summary.best_move && finished.node.id === this.active_node_id) {
							this.enqueue_seq(
								finished.node,
								finished.seq.concat([summary.best_move]),
								finished.target_visits,
								finished.trace_remaining - 1
							);
						}
						this.emit_update();
					}
				}
				this.pump();
			});

			if (!sent_id) {
				this.in_flight = null;
			}
			return;
		}
	},
};

module.exports = init();
