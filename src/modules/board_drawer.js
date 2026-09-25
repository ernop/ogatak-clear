"use strict";

// Overview:
//  - Single-purpose div:   wood texture
//  - Table TD elements:    nothing / grid / black stone / white stone
//  - Canvas:               everything else
//
// To avoid conflicts when using the canvas:
//  - We plan everything to be drawn, placing objects in the .needed_marks array.
//  - Since only 1 object can be at each spot, conflicts are avoided.
//
// Complications:
//  - Next-move-markers can coincide with various stuff.
//  - Flicker introduced by death marks when stepping forward.

const path = require("path");

const board_font_chooser = require("./board_font_chooser");
const gridlines = require("./gridlines");
const {translate} = require("./translate");

const colour_gradients = require("./colour_gradients");

const {handicap_stones, moveinfo_filter, board_candidates, pad, new_2d_array, xy_to_s, float_to_hex_ff,
	points_list, is_valid_rgb_or_rgba_colour, colour_curve, clamp, safe_html} = require("./utils");

// ------------------------------------------------------------------------------------------------

const t = {};

function do_translations(lang) {			// Leave the arg as undefined to use the startup language.
	Object.assign(t, {
		Rules: translate("INFO_PANEL_RULES", lang),
		Unknown: translate("INFO_PANEL_UNKNOWN", lang),
		Komi: translate("INFO_PANEL_KOMI", lang),
		Editing: translate("INFO_PANEL_EDITING", lang),
		Escape: translate("INFO_PANEL_ESCAPE", lang),
		Show: translate("INFO_PANEL_SHOW", lang),
		B: translate("INFO_PANEL_B", lang),
		W: translate("INFO_PANEL_W", lang),
		Stn: translate("INFO_PANEL_STN", lang),
		Caps: translate("INFO_PANEL_CAPS", lang),
		Score: translate("INFO_PANEL_SCORE", lang),
		Visits: translate("INFO_PANEL_VISITS", lang),
	});
}

do_translations();

const INFO_BAR_ITEM_IDS = ["rules", "toplay", "caps", "komi", "score", "show", "visits"];
const INFO_BAR_LABELS = {
	rules: "rules",
	toplay: "to play",
	caps: "caps",
	komi: "komi",
	score: "score",
	show: "show",
	visits: "visits",
	players: "players",
};

// ------------------------------------------------------------------------------------------------

let mouseenter_handlers = new_2d_array(19, 19, null);

for (let x = 0; x < 19; x++) {				// Create the event handlers for all usable values of x,y...
	for (let y = 0; y < 19; y++) {			// These will be attached to TD elements, firing on "mouseenter" events.
		let s = xy_to_s(x, y);
		mouseenter_handlers[x][y] = () => {
			hub.mouse_entering_point(s);
		};
	}
}

let coord_enter_handler = () => {
	hub.mouse_entering_point(null);
};

// ------------------------------------------------------------------------------------------------

const black_stone = new Image();	black_stone.src = "./gfx/black_stone.png";		const black_stone_url = `url("${black_stone.src}")`;
const white_stone = new Image();	white_stone.src = "./gfx/white_stone.png";		const white_stone_url = `url("${white_stone.src}")`;

// ------------------------------------------------------------------------------------------------

function init() {

	let ret = Object.assign(Object.create(board_drawer_prototype), {

		backgrounddiv: document.getElementById("boardbg"),
		ownercanvas:   document.getElementById("ownershipcanvas"),
		htmltable:     document.getElementById("boardtable"),
		canvas:        document.getElementById("boardcanvas"),
		infodiv:       document.getElementById("boardinfo"),
		info1span:     document.getElementById("info1"),
		info2span:     document.getElementById("info2"),

		ctx: document.getElementById("boardcanvas").getContext("2d"),
		ownerctx: document.getElementById("ownershipcanvas").getContext("2d"),

		pv: null,									// The PV drawn, or null if there isn't one.
		has_drawn_ownership: false,					// Whether any ownership stuff is being shown on either canvas.
		has_drawn_candidates: false,				// Whether any candidate moves are being shown.
		table_state: new_2d_array(19, 19, ""),		// "", "b", "w", "?" ... what TD contains ("" for grid, "?" for nothing at all).
		needed_marks: new_2d_array(19, 19, null),	// Objects representing stuff waiting to be drawn to the main canvas.
		hoshi_points: new_2d_array(19, 19, false),	// Lookup table for whether x,y is hoshi, this is a bit lazy.

		has_handlers: false,
		gridlines: null,

		width: null,								// We need to store width, height, and square_size
		height: null,
		square_size: null,
		board_line_width: null,						// This other stuff is stored so we can detect when they
		grid_colour: null,							// don't match config and a rebuild() call is needed.
		coordinates: null,

		infodiv_displaying_stats: false,			// Becomes true when normal (i.e. non-error) stuff is shown.

		grid_has_half_pixel_shift: false,

		rebuild_count: 0,							// For debugging.
		draw_count: 0,								// Used by hub to avoid redundant draws.

	});

	// The infodiv's font-size comes from the type scale (--fs-body in
	// ogatak.css); nothing is set from JS.

	return ret;
}

let board_drawer_prototype = {

	rebuild: function(width, height) {

		this.rebuild_count++;

		// Reset or rebuild various things... REMEMBER though that this isn't even called unless certain conditions are met.

		if (!width || !height || width > 19 || height > 19) {
			throw new Error("rebuild(): needs valid board sizes");
		}

		let desired_square_size = this.desired_square_size(width, height, config.coordinates);

		// We may or may not need to remake the gridline PNG images that we draw...

		if (this.square_size !== desired_square_size || this.board_line_width !== config.board_line_width || this.grid_colour !== config.grid_colour) {
			this.gridlines = gridlines(desired_square_size, config.board_line_width, config.grid_colour);
		}

		// We may or may not need to remake the hoshi array...

		if (this.width !== width || this.height !== height) {

			for (let x = 0; x < 19; x++) {
				for (let y = 0; y < 19; y++) {
					this.hoshi_points[x][y] = false;
				}
			}

			for (let s of handicap_stones(Math.min(width, height) > 13 ? 9 : 5, width, height, false)) {
				let x = s.charCodeAt(0) - 97;
				let y = s.charCodeAt(1) - 97;
				this.hoshi_points[x][y] = true;
			}
		}

		// We may or may not need to remake the table...

		if (this.width !== width || this.height !== height || this.coordinates !== config.coordinates) {

			// Full rebuild. First we detach event handlers in the table...
			// This might be rather unnecessary, they should get GC'd anyway.

			if (this.has_handlers) {
				for (let x = 0; x < this.width; x++) {				// Note: use this.width & this.height here; iterating over what was, not what will be.
					for (let y = 0; y < this.height; y++) {
						let td = this.htmltable.getElementsByClassName("td_" + xy_to_s(x, y))[0];
						td.removeEventListener("mouseenter", mouseenter_handlers[x][y]);
					}
				}
				for (let td of this.htmltable.getElementsByClassName("coords")) {		// Possibly an empty array.
					td.removeEventListener("mouseenter", coord_enter_handler);
				}
			}

			// Now remake...

			this.htmltable.innerHTML = "";

			let table_width = config.coordinates ? width + 1 : width;
			let table_height = config.coordinates ? height + 1 : height;

			for (let y = 0; y < table_height; y++) {
				let tr = document.createElement("tr");
				this.htmltable.appendChild(tr);
				for (let x = 0; x < table_width; x++) {
					let td = document.createElement("td");
					td.width = desired_square_size;
					td.height = desired_square_size;
					if (!config.coordinates) {
						let s = xy_to_s(x, y);
						td.className = "td_" + s;
						td.addEventListener("mouseenter", mouseenter_handlers[x][y]);
					} else if (x > 0 && y < height) {
						let s = xy_to_s(x - 1, y);
						td.className = "td_" + s;
						td.addEventListener("mouseenter", mouseenter_handlers[x - 1][y]);
					} else if (x > 0 && y === height) {
						td.innerHTML = "ABCDEFGHJKLMNOPQRSTUVWXYZ"[x - 1];
						td.className = "coords";
						td.style.font = board_font_chooser.get_big(desired_square_size);
						td.addEventListener("mouseenter", coord_enter_handler);
					} else if (x === 0 && y < height) {
						td.innerHTML = (height - y).toString();
						td.className = "coords";
						td.style.font = board_font_chooser.get_big(desired_square_size);
						td.addEventListener("mouseenter", coord_enter_handler);
					} else {
						td.className = "coords";
						td.addEventListener("mouseenter", coord_enter_handler);
					}
					tr.appendChild(td);
				}
			}

			this.has_handlers = true;

		} else if (this.square_size !== desired_square_size) {

			// Just set the TDs' width and height... while it might be possible not to ever set these,
			// doing so may help the compositor or whatnot prevent flicker when changing size...

			for (let td of this.htmltable.getElementsByTagName("td")) {
				td.width = desired_square_size;
				td.height = desired_square_size;
			}

			for (let td of this.htmltable.getElementsByClassName("coords")) {			// Possibly an empty array.
				td.style.font = board_font_chooser.get_big(desired_square_size);
			}
		}

		// Mark every TD as requiring redrawing...

		for (let x = 0; x < 19; x++) {
			for (let y = 0; y < 19; y++) {
				this.table_state[x][y] = "?";
			}
		}

		// Obviously we want to save the width / height / square_size... but we also save the state of relevant
		// config vars at the time of the rebuild, so we can detect if a new rebuild is needed later...

		this.width = width;
		this.height = height;
		this.square_size = desired_square_size;
		this.board_line_width = config.board_line_width;
		this.grid_colour = config.grid_colour;
		this.coordinates = config.coordinates;

		// Misc logic...

		this.has_drawn_ownership = false;
		this.has_drawn_candidates = false;
		this.pv = null;

		this.grid_has_half_pixel_shift = (config.board_line_width + desired_square_size) % 2 === 1;

		// Set sizes of the big elements...

		let adjust = this.coordinates ? 1 : 0;

		this.backgrounddiv.style.width = ((this.width + adjust) * this.square_size).toString() + "px";
		this.backgrounddiv.style.height = ((this.height + adjust) * this.square_size).toString() + "px";

		this.htmltable.style.width = ((this.width + adjust) * this.square_size).toString() + "px";
		this.htmltable.style.height = ((this.height + adjust) * this.square_size).toString() + "px";

		if (config.embiggen_small_boards) {
			this.canvas.width = Math.max(this.width + adjust, this.height + adjust) * this.square_size;
			this.canvas.height = Math.max(this.width + adjust, this.height + adjust) * this.square_size;
		} else {
			this.canvas.width = Math.max(this.width + adjust, this.height + adjust, 19 + adjust) * this.square_size;
			this.canvas.height = Math.max(this.width + adjust, this.height + adjust, 19 + adjust) * this.square_size;
		}

		this.ownercanvas.width = this.canvas.width;
		this.ownercanvas.height = this.canvas.height;
	},

	rebuild_if_needed: function(board) {
		if (this.width !== board.width ||
			this.height !== board.height ||
			this.square_size !== this.desired_square_size(board.width, board.height, config.coordinates) ||
			this.board_line_width !== config.board_line_width ||
			this.grid_colour !== config.grid_colour ||
			this.coordinates !== config.coordinates
		) {
			this.rebuild(board.width, board.height);
		}
	},

	desired_square_size: function(width, height, coordinates) {
		if (coordinates === undefined) {
			throw new Error("desired_square_size(): bad call");
		}
		let dy = window.innerHeight - this.canvas.getBoundingClientRect().top;
		let adjust = coordinates ? 1 : 0;
		let border = coordinates ? 0 : 10;
		if (config.embiggen_small_boards) {
			return Math.max(10, Math.floor((dy - border) / Math.max(width + adjust, height + adjust)));
		} else {
			return Math.max(10, Math.floor((dy - border) / Math.max(width + adjust, height + adjust, 19 + adjust)));
		}
	},

	redo_translations: function() {			// Unused in code, purely for dev purposes.
		do_translations(config.language);
		hub.draw();
	},

	// --------------------------------------------------------------------------------------------
	// Low-level canvas methods. Methods that call for "fractions" want a number between 0 and 1 to
	// set the size of something, relative to the square size...
	//
	// Note that, when square_size is even but board_line_width is odd, or vice versa, the gridlines
	// are shifted down and right half a pixel. However, in such cases the stones themselves do not
	// quite align to the grid.

	_fcircle: function(x, y, fraction, colour, adjust) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.fillStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		if (adjust && this.grid_has_half_pixel_shift) {
			gx += 0.5;
			gy += 0.5;
		}
		ctx.beginPath();
		ctx.arc(gx, gy, fraction * this.square_size / 2, 0, 2 * Math.PI);
		ctx.fill();
	},

	fcircle: function(...args) {
		this._fcircle(...args, false);
	},

	fcircle_adjusted: function(...args) {
		this._fcircle(...args, true);
	},

	circle: function(x, y, line_fraction, fraction, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.lineWidth = line_fraction * this.square_size;
		ctx.strokeStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		ctx.beginPath();
		ctx.arc(gx, gy, (fraction * this.square_size / 2) - (line_fraction * this.square_size / 2), 0, 2 * Math.PI);
		ctx.stroke();
	},

	fsquare: function(x, y, fraction, colour, ownership_canvas_flag) {
		if (this.coordinates) x++;
		let ctx = !ownership_canvas_flag ? this.ctx : this.ownerctx;
		ctx.fillStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2) - (this.square_size * fraction / 2);
		let gy = y * this.square_size + (this.square_size / 2) - (this.square_size * fraction / 2);
		ctx.fillRect(gx, gy, this.square_size * fraction, this.square_size * fraction);
	},

	square: function(x, y, line_fraction, fraction, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.lineWidth = line_fraction * this.square_size;
		ctx.strokeStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		ctx.beginPath();
		ctx.moveTo(gx - (fraction * this.square_size / 2), gy - (fraction * this.square_size / 2));
		ctx.lineTo(gx + (fraction * this.square_size / 2), gy - (fraction * this.square_size / 2));
		ctx.lineTo(gx + (fraction * this.square_size / 2), gy + (fraction * this.square_size / 2));
		ctx.lineTo(gx - (fraction * this.square_size / 2), gy + (fraction * this.square_size / 2));
		ctx.closePath();
		ctx.stroke();
	},

	cross: function(x, y, line_fraction, fraction, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.lineWidth = line_fraction * this.square_size;
		ctx.strokeStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		ctx.beginPath();
		ctx.moveTo(gx - (this.square_size * fraction / 2), gy - (this.square_size * fraction / 2));
		ctx.lineTo(gx + (this.square_size * fraction / 2), gy + (this.square_size * fraction / 2));
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(gx - (this.square_size * fraction / 2), gy + (this.square_size * fraction / 2));
		ctx.lineTo(gx + (this.square_size * fraction / 2), gy - (this.square_size * fraction / 2));
		ctx.stroke();
	},

	triangle: function(x, y, line_fraction, fraction, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.lineWidth = line_fraction * this.square_size;
		ctx.strokeStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		let unit = this.square_size * fraction / 2;
		ctx.beginPath();
		ctx.moveTo(gx, 1 + gy - unit);
		ctx.lineTo(gx + unit * 0.866, 1 + gy + unit / 2);
		ctx.lineTo(gx - unit * 0.866, 1 + gy + unit / 2);
		ctx.closePath();
		ctx.stroke();
	},

	text: function(x, y, msg, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = board_font_chooser.get_big(this.square_size);
		ctx.fillStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 2);
		ctx.fillText(msg, gx, gy + 2);
	},

	text_two: function(x, y, msg, msg2, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = board_font_chooser.get_medium(this.square_size);
		ctx.fillStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy = y * this.square_size + (this.square_size / 3) - 0.5;
		ctx.fillText(msg, gx, gy + 1);
		gy = y * this.square_size + (this.square_size * 2 / 3) + 0.5;
		ctx.fillText(msg2, gx, gy + 1);
	},

	text_three: function(x, y, msg, msg2, msg3, colour) {
		if (this.coordinates) x++;
		let ctx = this.ctx;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.font = board_font_chooser.get_small(this.square_size);
		ctx.fillStyle = colour;
		let gx = x * this.square_size + (this.square_size / 2);
		let gy;

		gy = y * this.square_size + (this.square_size * 0.22);
		ctx.fillText(msg, gx, gy);
		gy = y * this.square_size + (this.square_size * 0.5);
		ctx.fillText(msg2, gx, gy + 1);
		gy = y * this.square_size + (this.square_size * 0.78);
		ctx.fillText(msg3, gx, gy + 1);
	},

	// --------------------------------------------------------------------------------------------
	// Low-level table TD methods...

	set_td: function(x, y, foo) {

		let td = this.htmltable.getElementsByClassName("td_" + xy_to_s(x, y))[0];
		if (!td) throw new Error("set_td(): bad x/y");

		if (foo === "") {
			if (this.hoshi_points[x][y]) {
				td.style["background-image"] = `url("${this.gridlines.hoshi}")`;
			} else if (x === 0) {
				if (y === 0) {
					td.style["background-image"] = `url("${this.gridlines.topleft}")`;
				} else if (y === this.height - 1) {
					td.style["background-image"] = `url("${this.gridlines.bottomleft}")`;
				} else {
					td.style["background-image"] = `url("${this.gridlines.left}")`;
				}
			} else if (x === this.width - 1) {
				if (y === 0) {
					td.style["background-image"] = `url("${this.gridlines.topright}")`;
				} else if (y === this.height - 1) {
					td.style["background-image"] = `url("${this.gridlines.bottomright}")`;
				} else {
					td.style["background-image"] = `url("${this.gridlines.right}")`;
				}
			} else {
				if (y === 0) {
					td.style["background-image"] = `url("${this.gridlines.top}")`;
				} else if (y === this.height - 1) {
					td.style["background-image"] = `url("${this.gridlines.bottom}")`;
				} else {
					td.style["background-image"] = `url("${this.gridlines.mid}")`;
				}
			}
		} else if (foo === "b") {
			td.style["background-image"] = black_stone_url;
		} else if (foo === "w") {
			td.style["background-image"] = white_stone_url;
		} else {
			throw new Error("set_td(): bad call");
		}

		this.table_state[x][y] = foo;
	},

	wood: function(x, y) {		// Clears the TD so the wood is visible...

		let td = this.htmltable.getElementsByClassName("td_" + xy_to_s(x, y))[0];
		if (!td) throw new Error("set_td(): bad x/y");

		td.style["background-image"] = "none";
		this.table_state[x][y] = "?";
	},

	// --------------------------------------------------------------------------------------------
	// The 2 methods here are the main methods called by the hub...

	draw_standard: function(node, caller_suggests_antiflicker = false) {

		this.clear_canvases();
		this.draw_board(node.get_board());

		if (node.has_valid_analysis() && node.analysis.ownership) {

			// If possible, use this node's analysis.

			this.handle_ownership(node.get_board(), node.analysis.ownership);

		} else if (caller_suggests_antiflicker) {

			// To avoid flicker, we can use some nearby node's analysis...

			let analysis_node = node.anc_dec_with_valid_analysis(8);
			if (analysis_node && analysis_node.analysis.ownership) {
				this.handle_ownership(node.get_board(), analysis_node.analysis.ownership);
			}
		}

		this.plan_ko_marker(node);
		this.plan_avoid_markers();
		this.plan_previous_markers(node);
		this.plan_shapes(node);
		this.plan_labels(node);
		this.plan_analysis_circles(node);
		this.plan_next_markers(node);					// Should be last, since it can adjust other planned objects.

		this.draw_canvas();
		this.draw_node_info(node);
		this.pv = null;

		this.draw_count++;
	},

	draw_pv: function(node, point) {					// Returns true / false indicating whether this happened.

		if (config.editing || !point || !config.candidate_moves || !config.mouseover_pv || !node.has_valid_analysis()) {
			return false;
		}

		if (config.avoid_set[point]) {					// We right-clicked this spot.
			return false;
		}

		if (config.no_ponder_no_candidates && !hub.engine.desired) {
			return false;
		}

		let startboard = node.get_board();
		let gtp = startboard.gtp(point);				// Gets a string like "K10" from the mouse point argument (which is like "jj").

		let info;

		for (let foo of moveinfo_filter(node)) {		// Of all the moves in our list, is one of them the one we're interested in?
			if (foo.move === gtp) {
				if (Array.isArray(foo.pv) && foo.pv.length > 0) {
					info = foo;
				}
				break;
			}
		}

		if (!info) {
			return false;
		}

		// We have a valid info, so the draw will proceed..........................................

		let finalboard = startboard.copy();
		let points = [];

		for (let move of info.pv.slice(0, config.analysis_pv_len)) {
			let s = finalboard.parse_gtp_move(move);	// "K10" --> "jj" (off-board becomes "")
			finalboard.play(s);
			points.push(s);								// Passes are included as "" (so our numbering works below)
		}

		this.clear_canvases();
		this.draw_board(finalboard);

		if (config.ownership_per_move && info.ownership) {
			this.handle_ownership(finalboard, info.ownership);
		} else if (node.analysis.ownership) {
			this.handle_ownership(finalboard, node.analysis.ownership);
		}

		this.plan_pv_labels(points);

		this.draw_canvas();
		this.draw_node_info(node, info);
		this.pv = points;

		this.draw_count++;
		return true;
	},

	// --------------------------------------------------------------------------------------------
	// Not to be called directly from the hub, these are mid-level helpers...

	clear_canvases: function() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ownerctx.clearRect(0, 0, this.ownercanvas.width, this.ownercanvas.height);
		this.has_drawn_ownership = false;
		this.has_drawn_candidates = false;
	},

	draw_board: function(board) {

		this.rebuild_if_needed(board);

		// Aside from possibly triggering a rebuild, this function solely deals with TD elements...

		for (let x = 0; x < board.width; x++) {
			for (let y = 0; y < board.height; y++) {
				let desired = board.state[x][y];
				if (this.table_state[x][y] !== desired) {
					this.set_td(x, y, desired);
				}
			}
		}
	},

	draw_canvas: function() {

		// Based solely on whatever objects are in this.needed_marks...
		// All planning functions have to be called before this.

		for (let x = 0; x < this.width; x++) {
			for (let y = 0; y < this.height; y++) {
				let o = this.needed_marks[x][y];
				if (o) {
					this.draw_planned_canvas_object(o, x, y);
					this.needed_marks[x][y] = null;					// Deleting items as they are drawn.
				}
			}
		}
	},

	draw_planned_canvas_object(o, x, y) {

		// Assumes whatever board is being drawn has already been drawn,
		// therefore this.table_state is correct. Colours are mostly
		// determined based on what is actually drawn in the table.

		let tstate = this.table_state[x][y];

		switch (o.type) {

			case "analysis":

				this.wood(x, y);

				if (o.fill) {
					this.fcircle(x, y, 1, o.fill);
				}

				if (o.next_mark_colour) {
					this.circle(x, y, 0.085, 1, o.next_mark_colour);
				}

				if (o.text.length >= 3) {
					this.text_three(x, y, o.text[0], o.text[1], o.text[2], "#000000ff");
				} else if (o.text.length >= 2) {
					this.text_two(x, y, o.text[0], o.text[1], "#000000ff");
				} else if (o.text.length === 1) {
					this.text(x, y, o.text[0], "#000000ff");
				}

				this.has_drawn_candidates = true;

				break;

			case "ko":

				this.fcircle_adjusted(x, y, 0.4, "#00000080");
				break;

			case "avoid":

				this.fcircle_adjusted(x, y, 0.4, "#00000040");
				break;

			case "death":

				this.has_drawn_ownership = true;
				this.fsquare(x, y, 1/6, mark_colour_from_state(tstate, "#00000080"));
				break;

			case "owner_square":

				this.has_drawn_ownership = true;
				this.fsquare(x, y, 1/3, o.colour);
				break;

			case "previous":

				this.fcircle(x, y, 0.4, config.previous_marker);
				break;

			case "pv":

				if (tstate !== "b" && tstate !== "w") {
					this.wood(x, y);
				}
				this.text(x, y, o.text, mark_colour_from_state(tstate, "#ff0000ff"));
				break;

			case "label":

				if (tstate !== "b" && tstate !== "w") {
					this.wood(x, y);
				}
				this.text(x, y, o.text, mark_colour_from_state(tstate, "#000000ff"));
				break;

			case "SQ":

				this.square(x, y, 0.085, 0.45, mark_colour_from_state(tstate, "#00000080"));
				break;

			case "CR":

				this.circle(x, y, 0.085, 0.55, mark_colour_from_state(tstate, "#00000080"));
				break;

			case "MA":

				this.cross(x, y, 0.085, 0.5, mark_colour_from_state(tstate, "#00000080"));
				break;

			case "TR":

				this.triangle(x, y, 0.085, 0.6, mark_colour_from_state(tstate, "#00000080"));
				break;
		}

		// If the object has a next_mark_colour flag, it's fine to draw it
		// at the end, except "analysis" objects need to finesse it...

		if (o.next_mark_colour && o.type !== "analysis") {
			this.circle(x, y, 0.085, 1, o.next_mark_colour);
		}

	},

	// --------------------------------------------------------------------------------------------

	handle_ownership: function(board, ownership) {
		this.draw_ownership_canvas(ownership);					// Each function is responsible
		this.plan_ownership_marks(board, ownership);			// for knowing whether to act,
		this.plan_death_marks(board, ownership);				// just like other planners.
	},

	draw_ownership_canvas: function(ownership) {

		if (config.ownership_marks !== 3) {						// i.e. return if it's not "Whole board (alt)"
			return;
		}

		this.has_drawn_ownership = true;

		for (let x = 0; x < this.width; x++) {
			for (let y = 0; y < this.height; y++) {
				let own = ownership[x + (y * this.width)];
				if (own > 0) {
					this.fsquare(x, y, 1, "#000000" + float_to_hex_ff(own / 2), true);
				} else if (own < 0) {
					this.fsquare(x, y, 1, "#ffffff" + float_to_hex_ff(-own / 2), true);
				}
			}
		}
	},

	// --------------------------------------------------------------------------------------------
	// Planning methods that add stuff to this.needed_marks to be drawn later. Doing it this way
	// helps avoid conflicts: i.e. 2 things won't be drawn at the same place, since only 1 thing
	// can be at each spot in the needed_marks array. We could also use a map of point --> object.

	plan_ownership_marks: function(board, ownership) {

		if (config.ownership_marks !== 2) {										// i.e. return if it's not "Whole board"
			return;
		}

		for (let x = 0; x < board.width; x++) {
			for (let y = 0; y < board.height; y++) {

				let state = board.state[x][y];

				let own = ownership[x + (y * board.width)];

				if (own > 0 && state !== "b") {
					this.needed_marks[x][y] = {type: "owner_square", colour: "#000000" + float_to_hex_ff(own)};
				} else if (own < 0 && state !== "w") {
					this.needed_marks[x][y] = {type: "owner_square", colour: "#ffffff" + float_to_hex_ff(-own)};
				}
			}
		}
	},

	plan_death_marks: function(board, ownership) {

		if (config.ownership_marks !== 1 && config.ownership_marks !== 3) {		// i.e. return if it's not "Dead stones" or "Whole board (alt)".
			return;
		}

		for (let x = 0; x < board.width; x++) {

			for (let y = 0; y < board.height; y++) {

				let state = board.state[x][y];

				if (state !== "b" && state !== "w") {
					continue;
				}

				let own = ownership[x + (y * board.width)];

				if (own > 0 && state === "w") {
					this.needed_marks[x][y] = {type: "death"};
				} else if (own < 0 && state === "b") {
					this.needed_marks[x][y] = {type: "death"};
				}
			}
		}
	},

	plan_pv_labels: function(points) {		// Where points is an array of the moves played in the PV, in order.

		for (let n = 0; n < points.length; n++) {

			let s = points[n];

			if (s.length === 2) {			// Otherwise, it's a pass and we don't draw it.

				let x = s.charCodeAt(0) - 97;
				let y = s.charCodeAt(1) - 97;

				if (x >= 0 && x < this.width && y >= 0 && y < this.height) {

					// let already_exists = (this.needed_marks[x][y] && this.needed_marks[x][y].type === "pv") ? true : false;		// Could use for stuff.

					this.needed_marks[x][y] = {
						type: "pv",
						text: (n + 1).toString(),
					};
				}
			}
		}
	},

	plan_ko_marker: function(node) {
		let board = node.get_board();
		let ko = board.get_ko();
		if (ko) {
			let x = ko.charCodeAt(0) - 97;
			let y = ko.charCodeAt(1) - 97;
			this.needed_marks[x][y] = {type: "ko"};
		}
	},

	plan_avoid_markers: function() {

		for (let s of Object.keys(config.avoid_set)) {
			let x = s.charCodeAt(0) - 97;
			let y = s.charCodeAt(1) - 97;
			this.needed_marks[x][y] = {type: "avoid"};
		}
	},

	plan_previous_markers: function(node) {

		let moves_played = node.all_values("B").concat(node.all_values("W"));

		for (let s of moves_played) {			// Probably just one (but illegal SGF is possible).

			if (s.length === 2) {

				let x = s.charCodeAt(0) - 97;
				let y = s.charCodeAt(1) - 97;

				if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
					this.needed_marks[x][y] = {type: "previous"};
				}
			}
		}
	},

	plan_analysis_circles: function(node) {

		if (config.editing || !config.candidate_moves) {
			return;
		}

		if (config.no_ponder_no_candidates && !hub.engine.desired) {
			return;
		}

		let candidates = board_candidates(node);
		let filtered_infos = candidates.infos;
		let costs = candidates.costs;
		let gradient_cap = candidates.scale;
		let board = node.get_board();
		let number_types = config.numbers.split(" + ");
		let got_bad_analysis_text = false;
		let needs_flip = !config.black_pov && board.active === "w";		// Whether values like LCB, score etc need flipped to show from White POV.
		let active_is_b = board.active === "b";
		let use_classic = colour_gradients.is_classic(config.candidate_gradient);

		for (let i = 0; i < filtered_infos.length; i++) {

			let info = filtered_infos[i];

			let s = board.parse_gtp_move(info.move);

			if (s.length !== 2) {				// This is a pass.
				continue;
			}

			if (config.avoid_set[s]) {			// We right-clicked this spot.
				continue;
			}

			let x = s.charCodeAt(0) - 97;
			let y = s.charCodeAt(1) - 97;

			if (x < 0 || x >= board.width || y < 0 || y >= board.height) {
				continue;
			}

			let o = {
				type: "analysis",
				text: [],
				fill: null,
			};

			let colour;

			if (!use_classic && costs[i] !== null) {
				colour = colour_gradients.colour_for_cost(config.candidate_gradient, costs[i], gradient_cap);
			} else if (info.order === 0) {
				colour = active_is_b ? config.top_colour_black : config.top_colour_white;
			} else {
				colour = active_is_b ? config.off_colour_black : config.off_colour_white;
			}

			if (!is_valid_rgb_or_rgba_colour(colour)) {
				o.fill = colour;
			} else if (colour.length === 9 && colour.endsWith("00")) {
				o.fill = null;		// the colour is transparent, as a special case we never do alpha adjustment for these, or even draw them
			} else if (info.order === 0 || !config.visit_colours) {
				o.fill = colour;
			} else {
				o.fill = colour.slice(0, 7) + float_to_hex_ff(colour_curve(info.visits / filtered_infos[0].visits));
			}

			for (let nt of number_types) {
				let z = string_from_info(info, node, nt, needs_flip);
				if (z === "?") {
					got_bad_analysis_text = true;
				}
				o.text.push(z);
			}

			this.needed_marks[x][y] = o;
		}

		if (got_bad_analysis_text) {
			setTimeout(() => {					// Lame hack to fix bad values in config.json
				hub.cycle_numbers();
			}, 0);
		}
	},

	plan_shapes: function(node) {

		for (let key of ["TR", "SQ", "CR", "MA"]) {			// So in the event of coinciding stuff, MA has highest priority.
			for (let val of node.all_values(key)) {
				for (let s of points_list(val)) {
					let x = s.charCodeAt(0) - 97;
					let y = s.charCodeAt(1) - 97;
					if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
						this.needed_marks[x][y] = {type: key};
					}
				}
			}
		}
	},

	plan_labels: function(node) {

		for (let val of node.all_values("LB")) {

			if (val.length < 4) {
				continue;
			}

			let s = val.slice(0, 2);
			let text = val.slice(3).trim();

			let x = s.charCodeAt(0) - 97;
			let y = s.charCodeAt(1) - 97;

			if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
				this.needed_marks[x][y] = {
					type: "label",
					text: text,
				};
			}
		}
	},

	plan_next_markers: function(node) {

		// Note that, since these can coincide with various things, if an object is already
		// present at the location, we simply add a next_mark_colour property to it. This
		// function should be called last of the planners.

		if (!config.next_move_markers) {
			return;
		}

		let board = node.get_board();

		for (let n = 0; n < node.children.length; n++) {

			for (let key of ["B", "W"]) {

				let draw_colour = (key === "B") ? "#00000080" : "#ffffffa0";

				let moves_played = node.children[n].all_values(key);

				for (let s of moves_played) {			// Probably just one per child.

					if (s.length === 2) {

						let x = s.charCodeAt(0) - 97;
						let y = s.charCodeAt(1) - 97;

						if (x >= 0 && x < board.width && y >= 0 && y < board.height) {

							if (this.needed_marks[x][y]) {
								if (!this.needed_marks[x][y].next_mark_colour) {
									this.needed_marks[x][y].next_mark_colour = draw_colour;
								} else {
									// We already have this mark due to some sibling, do nothing.
								}
							} else {
								this.needed_marks[x][y] = {
									type: "next",
									next_mark_colour: draw_colour,
								};
							}
						}
					}
				}
			}
		}
	},

	// --------------------------------------------------------------------------------------------

	draw_node_info: function(node, override_moveinfo) {

		this.infodiv_displaying_stats = false;		// Stays false if we early-abort.

		if (hub.engine.problem_text()) {
			this.draw_engine_problem();
			return;
		}

		if (!hub.engine.received_version) {			// The version query hasn't succeeded yet, engine hasn't finished startup.
			this.draw_engine_starting();
			return;
		}

		this.infodiv_displaying_stats = true;		// We are in a normal-enough mode (including drawing the editing message, below).

		if (config.editing) {
			this.draw_gui_editing();
			return;
		}

		this.infodiv.innerHTML = this.info_bar_html(node, override_moveinfo);
	},

	visible_info_items: function() {
		let arr = config.info_bar_items;
		if (!Array.isArray(arr)) {
			return Array.from(INFO_BAR_ITEM_IDS);
		}
		return arr.filter((id, i) => INFO_BAR_ITEM_IDS.includes(id) && arr.indexOf(id) === i);
	},

	info_bar_html: function(node, override_moveinfo) {

		let short_strings = {
			"Winrate": "Win",
			"Visits": "Visit",
			"Visits (%)": "Vis %",
		};

		let board = node.get_board();
		let root = node.get_root();
		let prop = (key) => root.has_key(key) ? String(root.get(key)).trim() : "";
		let visible = this.visible_info_items();
		let hide = (id) => `<span class="info_hide" data-item="${id}" title="Hide">✕</span>`;

		let item_html = {
			rules: () => {
				let rules = safe_html(node.rules());
				let long_rules = "";
				if (rules.length > 14) {
					long_rules = rules;
					rules = rules.slice(0, 11) + "...";
				} else if (rules === "") {
					rules = t.Unknown;
				}
				let inner = `<span class="info_label">${t.Rules}:</span> <span class="info_value">${pad(rules, 14)}</span>`;
				if (long_rules) {
					inner = `<span title="${long_rules}">${inner}</span>`;
				}
				return `<span class="info_item boardinfo_rules">${inner}${hide("rules")}</span>`;
			},
			komi: () => {
				return `<span class="info_item boardinfo_komi"><span class="info_label">${t.Komi}:</span> ` +
					`<span class="info_value">${pad(node.komi(), 5)}</span>${hide("komi")}</span>`;
			},
			show: () => {
				let numbers_string;
				if (!config.candidate_moves) {
					numbers_string = "(nothing)";
				} else if (config.no_ponder_no_candidates && !hub.engine.desired) {
					numbers_string = "(not pondering)";
				} else {
					let arr = config.numbers.split(" + ");
					if (arr.length === 3) {
						numbers_string = arr.map(s => short_strings[s] || s).join(", ");
					} else {
						numbers_string = arr.join(", ");
					}
				}
				return `<span class="info_item boardinfo_numbers"><span class="info_label">${t.Show}:</span> ` +
					`<span class="info_value">${numbers_string}</span>${hide("show")}</span>`;
			},
			toplay: () => {
				let active = (board.active === "b")
					? `[<span class="white">${t.B}</span>|${t.W}]`
					: `[${t.B}|<span class="white">${t.W}</span>]`;
				return `<span class="info_item boardinfo_active">${active}${hide("toplay")}</span>`;
			},
			caps: () => {
				let stone_counts = `${board.stones_b} : ${board.stones_w}`;
				let capstring = `${board.caps_by_b} : ${board.caps_by_w}`;
				let label = config.stone_counts ? t.Stn : t.Caps;
				let value = config.stone_counts ? stone_counts : capstring;
				return `<span class="info_item boardinfo_stone_counts"><span class="info_label">${label}:</span> ` +
					`<span class="info_value">${pad(value, 10)}</span>${hide("caps")}</span>`;
			},
			score: () => {
				let score = "";
				if (node.has_valid_analysis()) {
					let lead = override_moveinfo ? override_moveinfo.scoreLead : node.analysis.rootInfo.scoreLead;
					if (typeof lead === "number") {
						let leader = lead >= 0 ? "B" : "W";
						if (lead < 0) lead *= -1;
						score = `${leader}+${lead.toFixed(2)}`;
					}
				} else if (node.has_key("OGSC")) {
					let lead = parseFloat(node.get("OGSC"));
					if (!Number.isNaN(lead)) {
						let leader = lead >= 0 ? "B" : "W";
						if (lead < 0) lead *= -1;
						score = `${leader}+${lead.toFixed(2)}`;
					}
				}
				return `<span class="info_item"><span class="info_label">${t.Score}:</span> ` +
					`<span class="info_value">${pad(score, 7)}</span>${hide("score")}</span>`;
			},
			visits: () => {
				let visits = "";
				if (node.has_valid_analysis()) {
					visits = `${override_moveinfo ? override_moveinfo.visits : node.analysis.moveInfos[0].visits} / ${node.analysis.rootInfo.visits}`;
				}
				return `<span class="info_item"><span class="info_label">${t.Visits}:</span> ` +
					`<span class="info_value">${pad(visits, 13)}</span>${hide("visits")}</span>`;
			},
		};

		let parts = [`<div class="info_bar">`];

		let black_name = prop("PB");
		let white_name = prop("PW");
		if (config.info_bar_show_players && (black_name || white_name)) {
			let player = (colour, name, rank) => {
				if (!name) {
					return `<div class="info_player info_player_${colour}"></div>`;
				}
				let stone = colour === "b" ? "black_stone.png" : "white_stone.png";
				let rank_html = rank ? `<span class="info_player_rank">${safe_html(rank)}</span>` : "";
				return `<div class="info_player info_player_${colour}">` +
					`<img src="./gfx/${stone}" class="info_player_stone" alt="">` +
					`<span class="info_player_name">${safe_html(name)}${rank_html}</span></div>`;
			};
			parts.push(`<div class="info_players">`);
			parts.push(player("b", black_name, prop("BR")));
			parts.push(`<span class="info_hide" data-item="players" title="Hide players">✕</span>`);
			parts.push(player("w", white_name, prop("WR")));
			parts.push(`</div>`);
		}

		parts.push(`<div class="info_stats">`);
		for (let id of visible) {
			parts.push(item_html[id]());
		}

		let chips = [];
		if (!config.info_bar_show_players) {
			chips.push(`<span class="info_chip" data-item="players">+ players</span>`);
		}
		for (let id of INFO_BAR_ITEM_IDS) {
			if (!visible.includes(id)) {
				chips.push(`<span class="info_chip" data-item="${id}">+ ${INFO_BAR_LABELS[id]}</span>`);
			}
		}
		if (chips.length) {
			parts.push(`<span class="info_chips">${chips.join(" ")}</span>`);
		}
		parts.push(`</div>`);
		parts.push(`</div>`);
		return parts.join("");
	},

	draw_engine_problem: function() {
		let s1 = `<span class="fullmsg">${hub.engine.problem_text()}</span>`;
		let s2 = `<span class="fullmsg">${translate("GUI_RESOLVE_THIS")}</span>`;
		this.infodiv.innerHTML = s1 + s2;
	},

	draw_engine_starting: function() {
		if (hub.engine.is_gtp) {
			let s1 = `<span class="fullmsg">${translate("GUI_AWAITING_GTP_RESPONSE_1")} <span class="yellow">(${path.basename(hub.engine.filepath)})</span></span>`;
			let s2 = `<span class="fullmsg">${translate("GUI_AWAITING_GTP_RESPONSE_2")}</span>`;
			this.infodiv.innerHTML = s1 + s2;
		} else {
			let s1 = `<span class="fullmsg">${translate("GUI_AWAITING_RESPONSE_1")}</span>`;
			let s2 = `<span class="fullmsg">${translate("GUI_AWAITING_RESPONSE_2")}</span>`;
			this.infodiv.innerHTML = s1 + s2;
		}
	},

	draw_gui_editing: function() {
		let s1 = `<span class="fullmsg">`;
		s1 += `<span class="boardinfo_editing yellow"> --> ${t.Editing}:  <span class="white">${config.editing}</span></span>`;
		s1 += `</span>`;
		let s2 = `<span class="fullmsg">`;
		s2 += `<span class="yellow"> --> ${t.Escape}</span>`;
		s2 += `</span>`;
		this.infodiv.innerHTML = s1 + s2;
	},

};

// ------------------------------------------------------------------------------------------------

function mark_colour_from_state(state, dflt) {
	if (!dflt) throw new Error("mark_colour_from_state(): bad call");
	if (state === "b") return "#ffffffff";
	if (state === "w") return "#000000ff";
	return dflt;
}

function string_from_info(info, node, type, flip) {

	let val;			// It seems using let inside a switch is dubious.
	let text;
	let absl;

	switch (type) {

		case "Winrate":
			val = Math.round(info.winrate * 100);
			if (flip) {
				val = 100 - val;
			}
			val = clamp(0, val, 99);
			return val.toString();
		case "LCB":
			val = Math.round(info.lcb * 100);
			if (flip) {
				val = 100 - val;
			}
			val = clamp(0, val, 99);
			return val.toString();
		case "Visits (%)":
			return Math.floor(info.visits / node.analysis.rootInfo.visits * 100).toString();
		case "Policy":
			val = Math.round(info.prior * 1000);	// We want some integer between 0 and 1000.
			val = clamp(0, val, 999);
			text = val.toString();
			while (text.length < 3) {
				text = "0" + text;					// i.e.  5 out of 1000  means  .005
			}
			return "." + text;
		case "Score":
			val = info.scoreLead;
			if (typeof val !== "number") {			// scoreLead might not be present if it's a GTP engine.
				return "??";						// Don't return "?" which is special...
			}
			if (flip) {
				val = -val;
			}
			text = val < 0 ? "-" : "+";
			absl = Math.abs(val);
			text += absl.toFixed(2);
			return text;
		case "Delta":
			if (typeof info.scoreLead !== "number" || typeof node.analysis.moveInfos[0].scoreLead !== "number") {		// See above.
				return "??";						// Don't return "?" which is special...
			}
			val = info.scoreLead - node.analysis.moveInfos[0].scoreLead;
			if (flip) {
				val = -val;
			}
			text = val < 0 ? "-" : "+";
			absl = Math.abs(val);
			text += absl.toFixed(2);
			if (text === "+0.00" || text === "-0.00") text = "0";
			return text;
		case "Visits":
			if (info.visits > 9950) {
				return (info.visits / 1000).toFixed(0) + "k";
			} else if (info.visits > 999) {
				return (info.visits / 1000).toFixed(1) + "k";
			}
			return info.visits.toString();
		case "Order":
			return info.order.toString();
		default:
			return "?";
	}
}



module.exports = init();
