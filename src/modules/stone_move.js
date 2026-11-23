"use strict";

// Ctrl+drag stone moving for what-if board analysis within SGF FF[4].
//
// Moving one or more stones from a position produces a SIBLING variation to
// the current node (off `node.parent`), keeping the untouched original position
// as the main line (`parent.children[0]`). Consecutive stone moves on a
// childless stone-move sibling glom together into that single sibling in place,
// emitting either a clean single move (;B[to] / ;W[to]) when the board equals
// a legal move from `parent`, or the exact minimal setup diff (AE/AB/AW + PL).
// At the root node (which has no parent in SGF), the variation is created as a
// child off root and subsequent drags glom into it in place.

const {xy_to_s} = require("./utils");

function is_setup_stone_move(node) {
	return Boolean(node && node.parent && (node.has_key("AE") || node.has_key("AB") || node.has_key("AW")));
}

function is_stone_move_sibling(node) {
	return Boolean(node && (node.__stone_move_sibling || is_setup_stone_move(node)));
}

function what_if_origin_node(node) {
	if (!is_stone_move_sibling(node) || !node.parent) {
		return null;
	}
	let orig = node.parent.children[0];
	if (!orig || orig === node || orig.destroyed) {
		return null;
	}
	return orig;
}

function boards_equal(a, b) {
	if (!a || !b || a.width !== b.width || a.height !== b.height || a.active !== b.active) {
		return false;
	}
	for (let x = 0; x < a.width; x++) {
		for (let y = 0; y < a.height; y++) {
			if (a.state[x][y] !== b.state[x][y]) {
				return false;
			}
		}
	}
	return true;
}

function diff_boards(parent_board, target_board) {
	let ae = [];
	let ab = [];
	let aw = [];
	for (let x = 0; x < target_board.width; x++) {
		for (let y = 0; y < target_board.height; y++) {
			let prev = parent_board.state[x][y];
			let next = target_board.state[x][y];
			if (prev === next) {
				continue;
			}
			let s = xy_to_s(x, y);
			if (next === "") {
				ae.push(s);
			} else if (next === "b") {
				ab.push(s);
			} else if (next === "w") {
				aw.push(s);
			}
		}
	}
	return {ae, ab, aw};
}

// Check if `target_board` can be represented cleanly as a single legal move
// played from `parent_board` (producing identical stones and active player).

function as_single_move(parent_board, target_board, allow_self_capture) {
	let mover = parent_board.active;
	if (mover !== "b" && mover !== "w") {
		return null;
	}
	let expected_next = mover === "b" ? "w" : "b";
	if (target_board.active !== expected_next) {
		return null;
	}

	let candidate = null;
	for (let x = 0; x < target_board.width; x++) {
		for (let y = 0; y < target_board.height; y++) {
			let prev = parent_board.state[x][y];
			let next = target_board.state[x][y];
			if (prev === next) {
				continue;
			}
			if (prev === "" && next === mover) {
				if (candidate !== null) {
					return null;
				}
				candidate = xy_to_s(x, y);
			} else if (next !== "") {
				return null;
			}
		}
	}

	if (!candidate || !parent_board.legal_move(candidate, allow_self_capture)) {
		return null;
	}

	let played = parent_board.copy();
	played.play(candidate);
	if (!boards_equal(played, target_board)) {
		return null;
	}

	return {key: mover.toUpperCase(), s: candidate};
}

function find_matching_child(parent, target_board) {
	for (let child of parent.children) {
		if (boards_equal(child.get_board(), target_board)) {
			return child;
		}
	}
	return null;
}

function clear_board_keys(node) {
	for (let key of ["B", "W", "AB", "AW", "AE", "PL"]) {
		node.delete_key(key);
	}
}

function chain_stone_moves(existing_pairs, colour, from_s, to_s) {
	let list = Array.isArray(existing_pairs) ? existing_pairs.map(p => ({...p})) : [];
	let chained = list.find(p => p.colour === colour && p.to === from_s);
	if (chained) {
		chained.to = to_s;
		if (chained.from === chained.to) {
			list = list.filter(p => p !== chained);
		}
	} else {
		list.push({colour, from: from_s, to: to_s});
	}
	return list;
}

function format_pairs_comment(pairs, board) {
	if (!pairs || pairs.length === 0) {
		return "";
	}
	let parts = pairs.map(p => `${p.colour === "b" ? "Black" : "White"} ${board.gtp(p.from)} -> ${board.gtp(p.to)}`);
	return `Moved ${parts.join("; ")}`;
}

function write_board_node(target_node, parent_board, target_board, allow_self_capture, pairs) {
	clear_board_keys(target_node);

	let single = as_single_move(parent_board, target_board, allow_self_capture);
	let kind;

	if (single) {
		target_node.set(single.key, single.s);
		kind = "sibling_move";
	} else {
		let {ae, ab, aw} = diff_boards(parent_board, target_board);
		for (let s of ae) target_node.add_value("AE", s);
		for (let s of ab) target_node.add_value("AB", s);
		for (let s of aw) target_node.add_value("AW", s);
		target_node.set("PL", target_board.active.toUpperCase());
		kind = "sibling_setup";
	}

	let comment = format_pairs_comment(pairs, target_board);
	if (comment) {
		target_node.set("C", comment);
	}
	target_node.__stone_move_sibling = true;
	target_node.__stone_moves = pairs;
	return kind;
}

function can_glom_in_place(node) {
	if (!node || !node.parent) {
		return false;
	}
	if (node.children.length > 0) {
		return false;
	}
	if (node.parent.children[0] === node) {
		return false;
	}
	return is_stone_move_sibling(node);
}

function move_stone_on_tree(node, from_s, to_s, new_node_fn) {

	if (!node || typeof from_s !== "string" || typeof to_s !== "string" || from_s === to_s) {
		return null;
	}

	let board = node.get_board();
	if (!board.in_bounds(from_s) || !board.in_bounds(to_s)) {
		return null;
	}

	let colour = board.state_at(from_s);
	if (colour !== "b" && colour !== "w") {
		return null;
	}

	if (board.state_at(to_s) !== "") {
		return null;
	}

	let fx = from_s.charCodeAt(0) - 97;
	let fy = from_s.charCodeAt(1) - 97;
	let tx = to_s.charCodeAt(0) - 97;
	let ty = to_s.charCodeAt(1) - 97;

	let target_board = board.copy();
	target_board.state[fx][fy] = "";
	target_board.state[tx][ty] = colour;

	let allow_self_capture = node.rules_allow_self_capture();
	let branch_parent = node.parent || node;
	let parent_board = branch_parent.get_board();
	let glom = can_glom_in_place(node);

	let existing = find_matching_child(branch_parent, target_board);
	if (existing) {
		if (glom && existing !== node) {
			node.detach();
		}
		return {
			node: existing,
			kind: existing === branch_parent.children[0] ? "main_line" : "existing_sibling",
			in_place: false,
			colour,
			from: from_s,
			to: to_s,
		};
	}

	let target_node;
	let in_place = false;
	let base_pairs = [];

	if (glom) {
		target_node = node;
		in_place = true;
		base_pairs = Array.isArray(node.__stone_moves) ? node.__stone_moves : [];
	} else {
		target_node = new_node_fn(branch_parent);
		if (is_stone_move_sibling(node) && Array.isArray(node.__stone_moves)) {
			base_pairs = node.__stone_moves;
		}
	}

	let pairs = chain_stone_moves(base_pairs, colour, from_s, to_s);
	let kind = write_board_node(target_node, parent_board, target_board, allow_self_capture, pairs);

	if (in_place) {
		target_node.forget_analysis();
		target_node.change_id();
		target_node.__board = null;
	}

	return {
		node: target_node,
		kind,
		in_place,
		colour,
		from: from_s,
		to: to_s,
	};
}

// Compute moved stone pairs between an original position and a stone-move sibling.
// Prefers exact recorded drag history when consistent with the board diff; falls
// back to nearest-neighbour pairing per colour for SGFs loaded from disk.

function describe_stone_diff(orig_node, mod_node) {
	if (!orig_node || !mod_node) {
		return {pairs: [], summary: ""};
	}
	let orig_b = orig_node.get_board();
	let mod_b = mod_node.get_board();

	let pairs = [];
	if (Array.isArray(mod_node.__stone_moves) && mod_node.__stone_moves.length > 0) {
		let valid = mod_node.__stone_moves.every(p =>
			orig_b.in_bounds(p.from) && mod_b.in_bounds(p.to) &&
			orig_b.state_at(p.from) === p.colour && mod_b.state_at(p.to) === p.colour &&
			mod_b.state_at(p.from) !== p.colour
		);
		if (valid) {
			pairs = mod_node.__stone_moves.map(p => ({
				colour: p.colour,
				from: p.from,
				to: p.to,
				from_gtp: orig_b.gtp(p.from),
				to_gtp: mod_b.gtp(p.to),
			}));
		}
	}

	if (pairs.length === 0) {
		for (let colour of ["b", "w"]) {
			let removed = [];
			let added = [];
			for (let x = 0; x < orig_b.width; x++) {
				for (let y = 0; y < orig_b.height; y++) {
					let o = orig_b.state[x][y];
					let m = mod_b.state[x][y];
					if (o === colour && m !== colour) removed.push({x, y, s: xy_to_s(x, y)});
					if (m === colour && o !== colour) added.push({x, y, s: xy_to_s(x, y)});
				}
			}
			let used_added = new Set();
			for (let r of removed) {
				let best_i = -1;
				let best_d = Infinity;
				for (let i = 0; i < added.length; i++) {
					if (used_added.has(i)) continue;
					let dx = r.x - added[i].x;
					let dy = r.y - added[i].y;
					let d = dx * dx + dy * dy;
					if (d < best_d) {
						best_d = d;
						best_i = i;
					}
				}
				if (best_i >= 0) {
					used_added.add(best_i);
					let a = added[best_i];
					pairs.push({
						colour,
						from: r.s,
						to: a.s,
						from_gtp: orig_b.gtp(r.s),
						to_gtp: mod_b.gtp(a.s),
					});
				}
			}
		}
	}

	let summary = pairs.map(p => `${p.colour === "b" ? "B" : "W"} ${p.from_gtp} → ${p.to_gtp}`).join(", ");
	return {pairs, summary};
}

function best_move_info(analysis, active) {
	if (!analysis || !Array.isArray(analysis.moveInfos) || analysis.moveInfos.length === 0) {
		return null;
	}
	let sign = active === "b" ? 1 : -1;
	let best = null;
	for (let info of analysis.moveInfos) {
		if (!info || typeof info.scoreLead !== "number") continue;
		if (!best || sign * info.scoreLead > sign * best.scoreLead) {
			best = info;
		}
	}
	return best || analysis.moveInfos[0];
}

// Pure comparison between an original game node and a stone-move what-if sibling:
//   1. Position swing: is the modified board better or worse for Black / White?
//   2. Next-best-move shift: did the best move change, and how much does the
//      original best move now lose on the modified board?

function summarize_what_if(orig_node, mod_node, orig_analysis_override = null) {
	if (!orig_node || !mod_node) {
		return null;
	}
	let diff = describe_stone_diff(orig_node, mod_node);
	let orig_a = orig_node.has_valid_analysis() ? orig_node.analysis : orig_analysis_override;
	let mod_a = mod_node.has_valid_analysis() ? mod_node.analysis : null;

	let has_orig = Boolean(orig_a && orig_a.rootInfo && typeof orig_a.rootInfo.scoreLead === "number");
	let has_mod = Boolean(mod_a && mod_a.rootInfo && typeof mod_a.rootInfo.scoreLead === "number");

	let out = {
		orig_node,
		mod_node,
		pairs: diff.pairs,
		summary: diff.summary,
		has_orig,
		has_mod,
		orig_visits: has_orig ? (orig_a.rootInfo.visits || 0) : 0,
		mod_visits: has_mod ? (mod_a.rootInfo.visits || 0) : 0,
		orig_lead: has_orig ? orig_a.rootInfo.scoreLead : null,
		mod_lead: has_mod ? mod_a.rootInfo.scoreLead : null,
		orig_wr: has_orig && typeof orig_a.rootInfo.winrate === "number" ? orig_a.rootInfo.winrate * 100 : null,
		mod_wr: has_mod && typeof mod_a.rootInfo.winrate === "number" ? mod_a.rootInfo.winrate * 100 : null,
		delta_bpov: null,
		abs_pts: null,
		better_for: null,
		delta_wr_bpov: null,
		orig_best: null,
		mod_best: null,
		best_changed: false,
		orig_best_new_cost: null,
	};

	let active = mod_node.get_board().active;
	let sign = active === "b" ? 1 : -1;

	let ob = has_orig ? best_move_info(orig_a, orig_node.get_board().active) : null;
	let mb = has_mod ? best_move_info(mod_a, active) : null;
	out.orig_best = ob ? ob.move : null;
	out.mod_best = mb ? mb.move : null;

	if (has_orig && has_mod) {
		out.delta_bpov = out.mod_lead - out.orig_lead;
		out.abs_pts = Math.abs(out.delta_bpov);
		out.better_for = out.abs_pts < 0.05 ? "even" : (out.delta_bpov > 0 ? "b" : "w");
		if (out.orig_wr !== null && out.mod_wr !== null) {
			out.delta_wr_bpov = out.mod_wr - out.orig_wr;
		}
		out.best_changed = Boolean(out.orig_best && out.mod_best && out.orig_best !== out.mod_best);
		if (out.best_changed && mb && Array.isArray(mod_a.moveInfos)) {
			let ob_in_mod = mod_a.moveInfos.find(m => m && m.move === out.orig_best && typeof m.scoreLead === "number");
			if (ob_in_mod) {
				out.orig_best_new_cost = Math.max(0, sign * (mb.scoreLead - ob_in_mod.scoreLead));
			}
		}
	}

	return out;
}

module.exports = {
	move_stone_on_tree,
	is_setup_stone_move,
	is_stone_move_sibling,
	what_if_origin_node,
	describe_stone_diff,
	summarize_what_if,
};
