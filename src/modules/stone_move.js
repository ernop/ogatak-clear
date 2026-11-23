"use strict";

// Ctrl+click stone moving for what-if board analysis within SGF FF[4].
//
// Two clean SGF representations:
//   1. Moving the exact move played on `node` (when legal from `node.parent`):
//      plays `to_s` as a standard sibling move variation off `node.parent`
//      (;B[to] / ;W[to]). Keeps full move history and exact territory counts.
//   2. Moving any earlier stone (or setup stone): creates (or reuses) a child
//      setup branch off `node` carrying AE[from] + AB[to]/AW[to] + PL[active],
//      leaving the original sequence untouched while letting KataGo analyse
//      the adjusted board directly via query.js's initialStones/initialPlayer.

function is_setup_stone_move(node) {
	return Boolean(node && node.parent && (node.has_key("AE") || node.has_key("AB") || node.has_key("AW")));
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

	let move_key = colour.toUpperCase();

	// Case 1: Moving the exact move just played on `node` --> clean sibling variation.

	let is_last_played_move = Boolean(
		node.parent &&
		node.move_count() === 1 &&
		!node.has_key("AB") &&
		!node.has_key("AW") &&
		!node.has_key("AE") &&
		node.get(move_key) === from_s &&
		node.parent.get_board().active === colour
	);

	if (is_last_played_move) {
		let parent_board = node.parent.get_board();
		if (parent_board.legal_move(to_s, node.rules_allow_self_capture())) {
			let sibling = node.parent.try_move(to_s);
			if (sibling && sibling !== node.parent) {
				return {
					node: sibling,
					kind: "sibling_move",
					colour,
					from: from_s,
					to: to_s,
				};
			}
		}
	}

	// Case 2: Moving an earlier stone (or setup stone) --> SGF child setup branch.

	let add_key = colour === "b" ? "AB" : "AW";
	let active_pl = board.active.toUpperCase();

	for (let child of node.children) {
		if (
			child.move_count() === 0 &&
			child.all_values("AE").length === 1 &&
			child.all_values("AE")[0] === from_s &&
			child.all_values(add_key).length === 1 &&
			child.all_values(add_key)[0] === to_s &&
			child.all_values(add_key === "AB" ? "AW" : "AB").length === 0 &&
			child.get_board().active === board.active
		) {
			return {
				node: child,
				kind: "setup_branch",
				colour,
				from: from_s,
				to: to_s,
			};
		}
	}

	let child = new_node_fn(node);
	child.add_value("AE", from_s);
	child.add_value(add_key, to_s);
	child.set("PL", active_pl);

	let from_gtp = board.gtp(from_s);
	let to_gtp = board.gtp(to_s);
	let colour_name = colour === "b" ? "Black" : "White";
	child.set("C", `Moved ${colour_name} ${from_gtp} -> ${to_gtp}`);

	return {
		node: child,
		kind: "setup_branch",
		colour,
		from: from_s,
		to: to_s,
	};
}

module.exports = {
	move_stone_on_tree,
	is_setup_stone_move,
};
