"use strict";

// The Move Report panel. See PRODUCT.md at the repo root for the requirements
// this implements. The framework rules that matter here:
//
//   - No bare signed numbers: every value is labeled with the color it favors
//     ("B+2.30", "W 61%"). KataGo values arrive in Black POV (see query.js) and
//     are converted to labeled form HERE, at the display layer, nowhere else.
//   - Move quality is "points thrown away by the mover", always >= 0 in text.
//   - Candidate values are relative to the best available move from here,
//     never to the global board value.
//   - Candidate value differences use the Display → Gradient palette,
//     best = start, worst on the current scale = end. Never a special
//     colour for the single top move.
//   - Four chart concepts, never conflated: "quality" (per-move bars: how
//     well each move was played), "status" (who was winning), "breadth"
//     (historical choice shape), and "distribution" (current candidate moves
//     by points worse than best). Breadth and distribution switch together
//     between five paired views.
//
// The panel is made of named sections. Their order and visibility live in
// config.move_report_sections; layout sizes live in config.move_report_width /
// _chart_height, adjustable live from the controls the panel itself renders,
// and every change is saved to config.json immediately.
//
// Typography and styling rules (AGENTS.md "UI conventions"):
//   - Every text size comes from the six-step type scale (type_scale.js),
//     derived from the app-wide info_font_size. DOM text via the --fs-*
//     variables in ogatak.css; canvas text via type_scale.canvas_font().
//   - No inline styles: JS publishes config-driven values only as CSS custom
//     properties (--mr-card-width, --mr-sec-order, ...); every actual style
//     rule lives in ogatak.css classes.

const config_io = require("./config_io");
const colour_gradients = require("./colour_gradients");
const candidate_profile = require("./candidate_profile");
const eval_history = require("./eval_history");
const explored = require("./explored");
const type_scale = require("./type_scale");
const workspace = require("./workspace");
const narrowness = require("./narrowness");
const continuation_prober = require("./continuation_prober");
const {info_cost, loss_text, ZERO_LOSS, safe_html, board_candidates, options_table_infos, fmt_visits} = require("./utils");

const SECTION_TITLES = {
	history:      "EVAL HISTORY",
	options:      "NEXT MOVE OPTIONS",
	corridor:     "VARIATION SPACE",
	tree:         "VARIATION TREE",
	status:       "GAME STATUS",
	quality:      "MOVE QUALITY",
	comments:     "COMMENTS",
	lastmove:     "LAST MOVE",
	outcome:      "OUTCOME",
	breadth:      "CHOICE BREADTH HISTORY",
	distribution: "CURRENT CANDIDATE VALUES",
	turn:         "TURN",
};

const ALL_SECTIONS = workspace.PANEL_IDS;
const CHART_SECTIONS = ["quality", "breadth", "status", "distribution"];
const YSCALE_SECTIONS = ["quality", "status"];
const HTML_SECTIONS = ["turn", "lastmove", "outcome", "options", "corridor"];

const HISTORY_START_VISITS = eval_history.START_VISITS;
const HISTORY_LINES = 24;				// Most lines drawn (the followed move and the game's next move are always added).

const VERDICTS = [
	// [max points lost (exclusive), label, css class (colours live in ogatak.css)]
	[0.5, "EXCELLENT",  "mr_verdict_excellent"],
	[1.5, "GOOD",       "mr_verdict_good"],
	[3.0, "INACCURACY", "mr_verdict_inaccuracy"],
	[6.0, "MISTAKE",    "mr_verdict_mistake"],
	[Infinity, "BLUNDER", "mr_verdict_blunder"],
];

// Candidate colours come from colour_gradients.js (Display → Gradient).

const LIMITS = {
	move_report_distribution_top_n: {min: 0, max: 1000, step: 1},
	move_report_quality_window_n: {min: 1, max: 1000, step: 1},
	move_report_status_window_n: {min: 1, max: 1000, step: 1},
};

// Chart paddings scale with the axis-label font (type scale "caption"), so
// labels always fit whatever the app-wide font setting is...

function chart_pads() {
	let cap = type_scale.px("caption");
	return {
		left: Math.round(cap * 4),			// Room for y-axis labels.
		right: Math.round(cap * 0.9),
		top: Math.round(cap * 1.3),
		bottom: Math.round(cap * 1.8),		// Room for x-axis labels.
	};
}

const CHART_MIN_DEPTH = 20;			// Both charts keep this many x slots so early games aren't stretched.
const BREADTH_VIEW_LABELS = {
	focus_tail: "focus + tail",
	fixed_bands: "fixed bands",
	cumulative: "cumulative",
	rank: "rank landscape",
	summary: "decision summary",
};
const PROFILE_COLOURS = ["#58c98bff", "#9bc653ff", "#d7bb49ff", "#dc9846ff", "#c8684cff", "#a84f4fff", "#783f4fff"];

function symmetric_y_scale(abs_max, mode, linear_step) {

	// Both charts use this same centered scale. Log mode positions values by
	// log2(1 + |value|) and labels powers of two; linear mode uses chart-specific
	// round-number steps because points-lost and score-lead have different ranges.

	let log_mode = mode === "log2";
	let y_max;
	let ticks = [];

	if (log_mode) {
		y_max = Math.pow(2, Math.ceil(Math.log2(Math.max(2, abs_max))));
		for (let v = 1; v <= y_max; v *= 2) {
			ticks.push(v);
		}
	} else {
		let step = linear_step(abs_max);
		y_max = Math.ceil(abs_max / step) * step;
		for (let v = step; v <= y_max; v += step) {
			ticks.push(v);
		}
	}

	let transform = (v) => log_mode ? Math.sign(v) * Math.log2(1 + Math.abs(v)) : v;

	return {y_max, ticks, transform};
}

function chart_plot_rect(canvas) {
	let pads = chart_pads();
	return {
		x0: pads.left,
		x1: canvas.width - pads.right,
		y0: pads.top,
		y1: canvas.height - pads.bottom,
	};
}

function draw_swatch_legend(ctx, items, x, y, x_max) {

	// Each item's colour goes on a swatch and its label stays white: several
	// series colours (the deep reds) are too dark to be legible as text.
	// Items that would pass x_max are left out.

	let px = type_scale.px("fine");
	let size = Math.round(px * 0.7);
	ctx.font = type_scale.canvas_font("fine");
	ctx.textAlign = "left";
	ctx.textBaseline = "top";
	for (let item of items) {
		let width = size + 4 + ctx.measureText(item.label).width;
		if (x + width > x_max) break;
		ctx.fillStyle = item.colour;
		ctx.fillRect(x, y + Math.round((px - size) / 2), size, size);
		ctx.fillStyle = "#ffffffff";
		ctx.fillText(item.label, x + size + 4, y);
		x += width + 12;
	}
}

function chart_x_scale(x0, x1, end_depth, windowed, window_n) {

	// Shared x mapping. A move is the interval (d-1, d]: quality fills that
	// slot, status draws the segment across it. The position *after* the move
	// is the point x(d). The current-position marker is always that point, so
	// the two yellow lines coincide — they sit on the right edge of the
	// current quality bar, which is also the status dot.

	if (typeof windowed !== "boolean") {
		throw new Error("chart_x_scale(): windowed must be boolean");
	}
	if (!Number.isInteger(window_n) || window_n < 1) {
		throw new Error("chart_x_scale(): window_n must be an integer >= 1");
	}

	let first_move = windowed ? Math.max(1, end_depth - window_n + 1) : 1;
	let domain_start = first_move - 1;
	let shown_move_count = end_depth - domain_start;
	let domain_span = windowed && end_depth >= window_n
		? window_n
		: Math.max(CHART_MIN_DEPTH, shown_move_count);
	let span = x1 - x0;
	let slot_w = span / domain_span;
	let x_of = (depth) => x0 + slot_w * (depth - domain_start);
	return {
		first_move,
		domain_start,
		domain_end: domain_start + domain_span,
		slot_w,
		x_of,
	};
}

function stroke_position_marker(ctx, cx, y0, y1) {
	ctx.strokeStyle = "#ffff99ff";
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(cx, y0);
	ctx.lineTo(cx, y1);
	ctx.stroke();
}

function init() {

	let outer = document.getElementById("movereport");

	let parts = [];

	parts.push(`<div id="mr_game_identity"></div>`);
	parts.push(`<div id="mr_controls">`);
	parts.push(`<span class="mr_settings_ctl" title="Every setting in one place (Ctrl+,)">⚙ settings</span>`);
	parts.push(`<span class="mr_presets" title="Switch workspace layout preset">`);
	for (let [key, label] of Object.entries(workspace.PRESETS)) {
		parts.push(`<span class="mr_preset" data-preset="${key}">${label}</span>`);
	}
	parts.push(`</span>`);
	parts.push(`<label class="mr_metric hidden" id="mr_breadth_ctl">breadth <select id="mr_breadth_view">`);
	for (let [value, label] of Object.entries(BREADTH_VIEW_LABELS)) {
		parts.push(`<option value="${value}">${label}</option>`);
	}
	parts.push(`</select></label>`);
	parts.push(`<span class="mr_panels_toggle hidden" id="mr_panels_toggle" title="Open closed workspace panels">+ panels</span>`);
	parts.push(`<span class="mr_reset_layout" title="Reset workspace layout to default">reset</span>`);
	parts.push(`<span class="mr_return_origin hidden" id="mr_return_origin" title="Return to the original position before moving the stone">↩ Return to original</span>`);
	parts.push(`</div>`);
	parts.push(`<div id="mr_hidden_chips" class="hidden"></div>`);
	parts.push(`<div id="mr_dockview"></div>`);

	// Off-screen pool for persistent panel DOM elements so closing or switching
	// layouts never destroys canvases (#treecanvas, charts) or #comments.
	parts.push(`<div id="mr_panel_pool" class="hidden">`);
	for (let sec of ALL_SECTIONS) {
		let is_canvas = CHART_SECTIONS.includes(sec) || sec === "history";
		let body_cls = (is_canvas || sec === "tree" || sec === "comments")
			? "mr_panel_body mr_panel_body_fill"
			: "mr_panel_body mr_panel_body_scroll";
		parts.push(`<div class="mr_panel" id="mr_panel_${sec}" data-sec="${sec}">`);
		if (sec === "history") {
			parts.push(`<div class="mr_panel_bar"><span class="mr_secstatus" id="mr_history_status"></span><span class="mr_secctls"><span class="mr_secctl" id="mr_xscale_ctl_history" data-sec="history" data-act="xscale" title="Toggle log / linear visits axis">log</span></span></div>`);
		} else if (sec === "options") {
			parts.push(`<div class="mr_panel_bar"><span class="mr_secstatus" id="mr_options_status"></span></div>`);
		} else if (sec === "corridor") {
			parts.push(`<div class="mr_panel_bar"><span class="mr_secstatus" id="mr_corridor_status"></span><span class="mr_secctls"><span class="mr_secctl" data-sec="corridor" data-act="probe_deeper" title="Run deeper continuation probes on current candidates">probe deeper</span></span></div>`);
		} else if (YSCALE_SECTIONS.includes(sec)) {
			parts.push(`<div class="mr_panel_bar"><span class="mr_secstatus"></span><span class="mr_secctls">`);
			parts.push(`<span class="mr_secctl" id="mr_yscale_ctl_${sec}" data-sec="${sec}" data-act="yscale" title="Toggle linear / log2 y scale">lin</span>`);
			parts.push(`<span class="mr_secctl" id="mr_window_ctl_${sec}" data-sec="${sec}" data-act="window" title="Toggle full history / sliding window">full</span>`);
			parts.push(`<label class="mr_metric" title="Moves retained when sliding window is enabled">last <input id="mr_window_n_${sec}" type="number" min="1" max="1000" step="1"></label>`);
			parts.push(`</span></div>`);
		} else if (sec === "distribution") {
			parts.push(`<div class="mr_panel_bar"><span class="mr_secstatus"></span><span class="mr_secctls"><label class="mr_metric" title='Enter "all" or an engine-ranked top N'>candidates <input id="mr_distribution_top_n" type="text" inputmode="numeric"></label></span></div>`);
		}
		if (is_canvas) {
			parts.push(`<div class="${body_cls}"><canvas class="mr_chartcanvas" id="mr_canvas_${sec}"></canvas></div>`);
		} else {
			parts.push(`<div class="${body_cls}" id="mr_seccontent_${sec}"></div>`);
		}
		parts.push(`</div>`);
	}
	parts.push(`</div>`);

	outer.innerHTML = parts.join("\n");

	// Adopt stock widgets into their Dockview panels. Their ids stay unchanged,
	// so comment_drawer, tree_drawer and all input handlers work untouched.

	document.getElementById("mr_seccontent_comments").appendChild(document.getElementById("comments"));
	document.getElementById("mr_seccontent_tree").appendChild(document.getElementById("treecanvas"));

	let panel_elements = {};
	let seccontents = {};
	for (let sec of ALL_SECTIONS) {
		panel_elements[sec] = document.getElementById(`mr_panel_${sec}`);
		let content = document.getElementById(`mr_seccontent_${sec}`);
		if (content) {
			seccontents[sec] = content;
		}
	}

	let yscale_ctls = {};
	let window_ctls = {};
	let window_inputs = {};
	for (let sec of YSCALE_SECTIONS) {
		yscale_ctls[sec] = document.getElementById(`mr_yscale_ctl_${sec}`);
		window_ctls[sec] = document.getElementById(`mr_window_ctl_${sec}`);
		window_inputs[sec] = document.getElementById(`mr_window_n_${sec}`);
	}

	let ret = Object.assign(Object.create(move_report_prototype), {

		outer: outer,
		dock_host: document.getElementById("mr_dockview"),
		panel_pool: document.getElementById("mr_panel_pool"),
		chips: document.getElementById("mr_hidden_chips"),
		panels_toggle: document.getElementById("mr_panels_toggle"),
		panels_tray_open: false,
		breadth_ctl: document.getElementById("mr_breadth_ctl"),
		breadth_view_select: document.getElementById("mr_breadth_view"),
		distribution_top_n_input: document.getElementById("mr_distribution_top_n"),
		xscale_ctl_history: document.getElementById("mr_xscale_ctl_history"),
		yscale_ctls: yscale_ctls,
		window_ctls: window_ctls,
		window_inputs: window_inputs,
		seccontents: seccontents,
		return_origin_btn: document.getElementById("mr_return_origin"),
		game_identity: document.getElementById("mr_game_identity"),

		quality_canvas: document.getElementById("mr_canvas_quality"),
		quality_ctx: document.getElementById("mr_canvas_quality").getContext("2d"),
		breadth_canvas: document.getElementById("mr_canvas_breadth"),
		breadth_ctx: document.getElementById("mr_canvas_breadth").getContext("2d"),
		status_canvas: document.getElementById("mr_canvas_status"),
		status_ctx: document.getElementById("mr_canvas_status").getContext("2d"),
		distribution_canvas: document.getElementById("mr_canvas_distribution"),
		distribution_ctx: document.getElementById("mr_canvas_distribution").getContext("2d"),
		history_canvas: document.getElementById("mr_canvas_history"),
		history_ctx: document.getElementById("mr_canvas_history").getContext("2d"),

		content_cache: {},			// section name --> last html set
		chips_cache: "",
		quality_click_map: null,	// Chart geometries for click-to-navigate.
		quality_hover_depth: null,
		breadth_click_map: null,
		breadth_hover_depth: null,
		status_click_map: null,
		distribution_hover_map: null,
		history_board_hover: null,	// GTP move under the mouse on the board, or null.
		history_label_hover: null,	// GTP move whose eval history label is under the mouse, or null.
		history_pin: null,			// {node, move}: a label clicked to keep following that move at that node.
		history_hits: [],			// Eval history label boxes from the last draw: {move, x0, y0, x1, y1}.
		history_status: document.getElementById("mr_history_status"),
		options_status: document.getElementById("mr_options_status"),
		corridor_status: document.getElementById("mr_corridor_status"),
		preview_seq_key: "",

	});

	ret.workspace = workspace.create_workspace(
		ret.dock_host,
		ret.panel_pool,
		panel_elements,
		{
			on_change: () => {
				if (global.tree_drawer) {
					tree_drawer.weak_draw = true;
				}
				if (global.hub && hub.node && !hub.node.destroyed) {
					ret.draw(hub.node);
				}
			},
			on_panel_active: (id) => {
				if (id === "tree" && global.tree_drawer) {
					tree_drawer.weak_draw = true;
				}
				if (global.hub && hub.node && !hub.node.destroyed) {
					ret.draw(hub.node);
				}
			},
		}
	);
	ret.workspace.restore_from_config();

	continuation_prober.on_update(() => {
		if (global.hub && hub.node && !hub.node.destroyed) {
			ret.draw(hub.node);
		}
	});

	outer.addEventListener("mousedown", (event) => {

		if (event.target.closest(".mr_settings_ctl")) {
			event.preventDefault();
			hub.toggle_settings();
			return;
		}

		if (event.target.closest(".mr_return_origin")) {
			event.preventDefault();
			hub.return_to_move_origin();
			return;
		}

		let preset_btn = event.target.closest(".mr_preset");
		if (preset_btn) {
			event.preventDefault();
			ret.workspace.apply_preset(preset_btn.dataset.preset, true);
			if (hub.node && !hub.node.destroyed) {
				ret.draw(hub.node);
			}
			return;
		}

		if (event.target.closest(".mr_reset_layout")) {
			event.preventDefault();
			ret.workspace.apply_preset("review", true);
			if (hub.node && !hub.node.destroyed) {
				ret.draw(hub.node);
			}
			return;
		}

		if (event.target.closest(".mr_panels_toggle")) {
			event.preventDefault();
			ret.panels_tray_open = !ret.panels_tray_open;
			ret.apply_layout();
			return;
		}

		let secctl = event.target.closest(".mr_secctl");
		if (secctl) {
			event.preventDefault();
			ret.section_action(secctl.dataset.sec, secctl.dataset.act);
			return;
		}

		let chip = event.target.closest(".mr_chip");
		if (chip) {
			event.preventDefault();
			ret.workspace.focus_or_open(chip.dataset.sec);
			if (hub.node && !hub.node.destroyed) {
				ret.draw(hub.node);
			}
			return;
		}

		let trace_btn = event.target.closest("[data-trace-gtp]");
		if (trace_btn) {
			event.preventDefault();
			ret.trace_candidate(hub.node, trace_btn.dataset.traceGtp);
			return;
		}

		let play_seq_el = event.target.closest("[data-play-seq]");
		if (play_seq_el) {
			event.preventDefault();
			let seq = play_seq_el.dataset.playSeq.trim().split(/\s+/).filter(Boolean);
			if (seq.length > 0) {
				hub.show_sequence_preview(null);
				ret.preview_seq_key = "";
				hub.play_gtp_sequence(seq);
			}
			return;
		}

		let tr = event.target.closest("tr[data-gtp]");
		if (tr) {
			event.preventDefault();
			let s = hub.node.get_board().parse_gtp_move(tr.dataset.gtp);
			if (s) {
				hub.show_sequence_preview(null);
				ret.preview_seq_key = "";
				hub.try_move(s);
			}
			return;
		}
	});

	outer.addEventListener("mouseover", (event) => {
		let preview_el = event.target.closest("[data-preview-seq]");
		let key = preview_el ? preview_el.dataset.previewSeq.trim() : "";
		if (key !== ret.preview_seq_key) {
			ret.preview_seq_key = key;
			hub.show_sequence_preview(key ? key.split(/\s+/).filter(Boolean) : null);
		}
	});

	outer.addEventListener("mouseleave", () => {
		if (ret.preview_seq_key !== "") {
			ret.preview_seq_key = "";
			hub.show_sequence_preview(null);
		}
	});

	ret.distribution_top_n_input.addEventListener("change", (event) => {
		ret.set_distribution_top_n(event.target.value);
	});

	ret.breadth_view_select.addEventListener("change", (event) => {
		ret.set_breadth_view(event.target.value);
	});

	for (let sec of YSCALE_SECTIONS) {
		let input = ret.window_inputs[sec];
		input.addEventListener("input", (event) => {
			ret.set_chart_window_n(sec, event.target.value, false);
		});
		input.addEventListener("change", (event) => {
			ret.set_chart_window_n(sec, event.target.value, true);
		});
	}

	ret.quality_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_quality_click(event.offsetX);
		if (node) {
			hub.set_node(node, {bless: false});
		}
	});

	ret.quality_canvas.addEventListener("mousemove", (event) => {
		let depth = ret.quality_depth_at(event.offsetX);
		ret.quality_hover_depth = depth;
		ret.quality_canvas.title = ret.quality_title(depth);
	});

	ret.quality_canvas.addEventListener("mouseleave", () => {
		ret.quality_hover_depth = null;
		ret.quality_canvas.title = "";
	});

	ret.breadth_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_breadth_click(event.offsetX);
		if (node) {
			hub.set_node(node, {bless: false});
		}
	});

	ret.breadth_canvas.addEventListener("mousemove", (event) => {
		let depth = ret.breadth_depth_at(event.offsetX);
		if (depth !== ret.breadth_hover_depth) {
			ret.breadth_hover_depth = depth;
			ret.draw_breadth(hub.node);
		}
		ret.breadth_canvas.title = ret.breadth_title(depth);
	});

	ret.breadth_canvas.addEventListener("mouseleave", () => {
		if (ret.breadth_hover_depth !== null) {
			ret.breadth_hover_depth = null;
			ret.draw_breadth(hub.node);
		}
		ret.breadth_canvas.title = "";
	});

	ret.status_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_status_click(event.offsetX);
		if (node) {
			hub.set_node(node, {bless: false});
		}
	});

	ret.distribution_canvas.addEventListener("mousemove", (event) => {
		let detail = ret.distribution_detail_at(event.offsetX);
		ret.distribution_canvas.title = detail
			? `${detail.range}: ${detail.count} candidate ${detail.count === 1 ? "move" : "moves"}`
			: "";
	});

	ret.distribution_canvas.addEventListener("mouseleave", () => {
		ret.distribution_canvas.title = "";
	});

	ret.history_canvas.addEventListener("mousemove", (event) => {
		ret.hover_history_label(ret.history_label_at(event.offsetX, event.offsetY));
	});

	ret.history_canvas.addEventListener("mouseleave", () => {
		ret.hover_history_label(null);
	});

	ret.history_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		ret.click_history_label(ret.history_label_at(event.offsetX, event.offsetY));
	});

	// Canvas backing dimensions do not follow CSS layout automatically. Observe
	// both axes of every chart and tree container so Dockview split drags,
	// tab switches, window resize, maximize, and zoom redraw at exact size.

	let observed_boxes = [
		ret.quality_canvas.parentElement,
		ret.breadth_canvas.parentElement,
		ret.status_canvas.parentElement,
		ret.distribution_canvas.parentElement,
		ret.history_canvas.parentElement,
		ret.seccontents.tree,
	];

	ret.observed_dims = [];
	ret.resize_frame = null;
	ret.resize_observer = new ResizeObserver(() => {
		let dims = observed_boxes.map(el => `${el.clientWidth}x${el.clientHeight}`);
		if (dims.every((d, i) => d === ret.observed_dims[i])) {
			return;
		}
		ret.observed_dims = dims;
		if (global.tree_drawer) {
			tree_drawer.weak_draw = true;
		}
		if (ret.resize_frame !== null) {
			cancelAnimationFrame(ret.resize_frame);
		}
		ret.resize_frame = requestAnimationFrame(() => {
			ret.resize_frame = null;
			if (global.hub && hub.node && !hub.node.destroyed) {
				ret.draw(hub.node);
			}
		});
	});

	for (let el of observed_boxes) {
		ret.resize_observer.observe(el);
	}

	return ret;
}

let move_report_prototype = {

	// ------------------------------------------------------------ live adjustment

	visible_sections: function() {
		return this.workspace ? this.workspace.open_ids() : [];
	},

	sync_sections_from_config: function() {
		if (this.workspace) {
			this.workspace.sync_open_panels(config.move_report_sections);
		}
	},

	set_distribution_top_n: function(raw_value) {

		let cleaned = String(raw_value).trim().toLowerCase();
		let value = cleaned === "all" ? 0 : Number(cleaned);
		let lim = LIMITS.move_report_distribution_top_n;
		let input = this.distribution_top_n_input;

		if (cleaned === "" || !Number.isInteger(value) || value < lim.min || value > lim.max) {
			input.setCustomValidity(`Enter "all" or a whole number from 1 to ${lim.max}.`);
			input.reportValidity();
			return;
		}

		input.setCustomValidity("");
		config.move_report_distribution_top_n = value;
		config_io.save();
		this.draw(hub.node);
	},

	set_breadth_view: function(value) {
		if (!BREADTH_VIEW_LABELS.hasOwnProperty(value)) {
			throw new Error(`set_breadth_view(): unsupported view ${value}`);
		}
		config.move_report_breadth_view = value;
		config_io.save();
		this.draw(hub.node);
	},

	set_chart_window_n: function(sec, raw_value, report_invalid) {

		if (!YSCALE_SECTIONS.includes(sec)) {
			throw new Error(`set_chart_window_n(): unsupported section ${sec}`);
		}
		let key = `move_report_${sec}_window_n`;
		let value = Number(raw_value);
		let lim = LIMITS[key];
		let input = this.window_inputs[sec];

		if (!Number.isInteger(value) || value < lim.min || value > lim.max) {
			if (report_invalid) {
				input.setCustomValidity(`Enter a whole number from ${lim.min} to ${lim.max}.`);
				input.reportValidity();
			}
			return;
		}

		input.setCustomValidity("");
		if (config[key] === value) {
			return;
		}
		config[key] = value;
		config_io.save();
		this.draw(hub.node);
	},

	probe_deeper: function(node) {
		if (!node || node.destroyed || !node.has_valid_analysis()) {
			return;
		}
		let infos = options_table_infos(node);
		let current_visits = config.continuation_probe_visits || 120;
		let target_visits = Math.min(2000, Math.max(current_visits * 2, 240));
		continuation_prober.schedule_for_node(node, infos.map(i => i.move), {force: true, visits: target_visits});
	},

	trace_candidate: function(node, gtp) {
		if (!node || node.destroyed || !gtp) {
			return;
		}
		continuation_prober.trace_corridor(node, gtp, 5);
	},

	section_action: function(sec, act) {

		if (act === "probe_deeper" && sec === "corridor") {
			this.probe_deeper(hub.node);
			return;
		}

		if (act === "yscale" && YSCALE_SECTIONS.includes(sec)) {
			let key = `move_report_${sec}_yscale`;
			config[key] = (config[key] === "log2") ? "linear" : "log2";
			config_io.save();
			this.draw(hub.node);
			return;
		}

		if (act === "window" && YSCALE_SECTIONS.includes(sec)) {
			let key = `move_report_${sec}_windowed`;
			config[key] = !config[key];
			config_io.save();
			this.draw(hub.node);
			return;
		}

		if (act === "xscale" && sec === "history") {
			config.move_report_history_xscale = config.move_report_history_xscale === "log" ? "linear" : "log";
			config_io.save();
			this.draw(hub.node);
			return;
		}
	},

	apply_layout: function() {

		let visible = this.visible_sections();
		let hidden_sections = ALL_SECTIONS.filter(sec => !visible.includes(sec));
		let chips = hidden_sections
			.map(sec => `<span class="mr_chip" data-sec="${sec}" title="Open panel">+ ${SECTION_TITLES[sec].toLowerCase()}</span>`)
			.join(" ");

		if (chips !== this.chips_cache) {
			this.chips.innerHTML = chips;
			this.chips_cache = chips;
		}

		if (hidden_sections.length === 0) {
			this.panels_tray_open = false;
			this.panels_toggle.classList.add("hidden");
			this.chips.classList.add("hidden");
		} else {
			let toggle_label = this.panels_tray_open
				? `− panels (${hidden_sections.length})`
				: `+ panels (${hidden_sections.length})`;
			if (this.panels_toggle.textContent !== toggle_label) {
				this.panels_toggle.textContent = toggle_label;
			}
			this.panels_toggle.classList.remove("hidden");
			this.chips.classList.toggle("hidden", !this.panels_tray_open);
		}

		this.breadth_ctl.classList.toggle("hidden", !visible.includes("breadth") && !visible.includes("distribution"));

		// Show the one-click return button whenever we branched away via Ctrl+click stone move.
		let origin = global.hub ? hub.move_origin : null;
		let show_origin = Boolean(origin && !origin.destroyed && origin !== hub.node);
		this.return_origin_btn.classList.toggle("hidden", !show_origin);
		if (show_origin) {
			let lbl = origin.depth > 0 ? `↩ Return to #${origin.depth}` : `↩ Return to start`;
			if (this.return_origin_btn.textContent !== lbl) {
				this.return_origin_btn.textContent = lbl;
			}
		}

		for (let sec of YSCALE_SECTIONS) {
			let label = config[`move_report_${sec}_yscale`] === "log2" ? "log₂" : "lin";
			let control = this.yscale_ctls[sec];
			if (control.textContent !== label) {
				control.textContent = label;
			}

			let windowed = config[`move_report_${sec}_windowed`];
			if (typeof windowed !== "boolean") {
				throw new Error(`apply_layout(): move_report_${sec}_windowed must be boolean`);
			}
			let window_control = this.window_ctls[sec];
			let window_label = windowed ? "window" : "full";
			if (window_control.textContent !== window_label) {
				window_control.textContent = window_label;
			}

			let window_input = this.window_inputs[sec];
			let window_n = config[`move_report_${sec}_window_n`];
			if (document.activeElement !== window_input &&
				window_input.value !== window_n.toString()) {
				window_input.value = window_n.toString();
			}
		}

		let xscale_control = this.xscale_ctl_history;
		let xscale_label = config.move_report_history_xscale === "log" ? "log visits" : "linear visits";
		if (xscale_control.textContent !== xscale_label) {
			xscale_control.textContent = xscale_label;
		}

		let top_n_input = this.distribution_top_n_input;
		let top_n_label = config.move_report_distribution_top_n === 0
			? "all"
			: config.move_report_distribution_top_n.toString();
		if (document.activeElement !== top_n_input &&
			top_n_input.value !== top_n_label) {
			top_n_input.value = top_n_label;
		}

		let breadth_view = this.breadth_view_select;
		if (breadth_view.value !== config.move_report_breadth_view) {
			breadth_view.value = config.move_report_breadth_view;
		}
	},

	// ------------------------------------------------------------ formatting helpers

	fmt_score: function(lead_bpov) {				// Black-POV number --> "B+2.30" / "W+0.50"
		if (typeof lead_bpov !== "number") {
			return "?";
		}
		return lead_bpov >= 0 ? `B+${lead_bpov.toFixed(2)}` : `W+${(-lead_bpov).toFixed(2)}`;
	},

	fmt_winrate: function(wr_bpov) {				// Black-POV 0..1 --> "B 61%" / "W 55%"
		if (typeof wr_bpov !== "number") {
			return "?";
		}
		return wr_bpov >= 0.5 ? `B ${(wr_bpov * 100).toFixed(0)}%` : `W ${((1 - wr_bpov) * 100).toFixed(0)}%`;
	},

	fmt_visits: function(v) {
		return fmt_visits(v);
	},

	verdict: function(points_lost) {				// --> [label, css class]
		for (let [max, label, klass] of VERDICTS) {
			if (points_lost < max) {
				return [label, klass];
			}
		}
	},

	value_colour: function(cost, cap) {				// cost 0 --> gradient start, cost >= cap --> end
		return colour_gradients.colour_for_cost(config.candidate_gradient, cost, cap);
	},

	bind_row_colours: function(element) {

		// ogatak.html's CSP (style-src 'self') blocks style="" attributes in
		// generated HTML, but not CSSOM writes, so data-* attributes become
		// CSS custom properties here.

		for (let el of element.querySelectorAll("[data-colour]")) {
			el.style.setProperty("--val-colour", el.dataset.colour);
		}
		for (let el of element.querySelectorAll("[data-nar-pct]")) {
			el.style.setProperty("--nar-pct", el.dataset.narPct + "%");
		}
	},

	candidate_costs: function(node, limit = null) {

		if (!node.has_valid_analysis() || node.analysis.moveInfos.length === 0) {
			return [];
		}

		// This position's own search only: the best move's own entry, never its
		// explored value, is the reference here.

		let infos = limit === null
			? node.analysis.moveInfos
			: node.analysis.moveInfos.slice(0, limit);
		let best_lead = node.analysis.moveInfos[explored.node_best(node)].scoreLead;
		let active_is_b = node.get_board().active === "b";

		return infos.map(info => {
			return {info, cost: info_cost(info, best_lead, active_is_b)};
		});
	},

	// Signed points change caused by the move leading into this node, from the
	// MOVER's side: negative = the move lost points vs the best move, positive =
	// the position turned out better than the prior estimate. A position's value
	// is its best move's (Node.stored_score), and the parent lists the played
	// move at this node's value (explored / inherited), so the loss equals the
	// cost the parent shows for the move. Works from stored SGF tags too.
	// Returns null if unknowable.

	points_delta: function(node) {
		if (!node.parent || node.move_count() !== 1) {
			return null;
		}
		let parent_score = node.parent.stored_score();		// Black POV
		let score = node.stored_score();					// Black POV
		if (typeof parent_score !== "number" || typeof score !== "number") {
			return null;
		}
		let delta_bpov = score - parent_score;
		return node.has_key("B") ? delta_bpov : -delta_bpov;
	},

	points_lost: function(node) {					// Always >= 0, for the verdict text.
		let delta = this.points_delta(node);
		if (delta === null) {
			return null;
		}
		return Math.max(0, -delta);
	},

	// ------------------------------------------------------------ main draw

	draw: function(node) {

		if (!node || node.destroyed) {
			return;
		}

		this.apply_layout();

		let players_html = this.html_players(node);
		if (this.content_cache.players !== players_html) {
			this.game_identity.innerHTML = players_html;
			this.content_cache.players = players_html;
		}

		let visible = this.visible_sections();
		let need_probes = visible.includes("options") || visible.includes("corridor");

		if (need_probes && config.continuation_probe && node.has_valid_analysis()) {
			let opt_infos = options_table_infos(node);
			continuation_prober.schedule_for_node(node, opt_infos.map(i => i.move));
		}

		if (visible.includes("options")) {
			let show_opt_visits = !this.workspace.is_visible("history") && node.has_valid_analysis();
			let opt_status = show_opt_visits ? `${this.fmt_visits(node.analysis.rootInfo.visits)} visits` : "";
			if (this.options_status.textContent !== opt_status) {
				this.options_status.textContent = opt_status;
			}
		}

		if (visible.includes("corridor")) {
			let st = continuation_prober.status(node);
			let cor_status = "";
			if (node.has_valid_analysis()) {
				let infos = options_table_infos(node);
				let ready = infos.filter(info => continuation_prober.lookup(node, [info.move])).length;
				let busy = st.in_flight || st.queued > 0;
				cor_status = busy
					? `probing ${ready}/${infos.length} (${st.queued} queued)`
					: `${ready}/${infos.length} continuations`;
			}
			if (this.corridor_status.textContent !== cor_status) {
				this.corridor_status.textContent = cor_status;
			}
		}

		for (let sec of visible) {
			if (sec === "quality") {
				if (this.workspace.is_visible(sec)) this.draw_quality(node);
			} else if (sec === "breadth") {
				if (this.workspace.is_visible(sec)) this.draw_breadth(node);
			} else if (sec === "status") {
				if (this.workspace.is_visible(sec)) this.draw_status(node);
			} else if (sec === "distribution") {
				if (this.workspace.is_visible(sec)) this.draw_distribution(node);
			} else if (sec === "history") {
				if (this.workspace.is_visible(sec)) this.draw_history(node);
			} else if (HTML_SECTIONS.includes(sec)) {
				let html = this[`html_${sec}`](node);
				if (html !== this.content_cache[sec]) {
					let element = this.seccontents[sec];
					element.innerHTML = html;
					this.bind_row_colours(element);
					this.content_cache[sec] = html;
				}
			}
		}

		if (!this.workspace.is_visible("history") && (this.history_pin || this.history_label_hover)) {
			this.history_pin = null;
			this.history_label_hover = null;
			hub.show_chart_point(null);
		}
	},

	html_players: function(node) {

		let root = node.get_root();
		let prop = (key) => root.has_key(key) ? String(root.get(key)).trim() : "";
		let black_name = prop("PB");
		let white_name = prop("PW");

		if (!black_name && !white_name) {
			return "";
		}

		let active = node.get_board().active;
		let player = (colour, name, rank) => {
			let is_black = colour === "b";
			let colour_name = is_black ? "BLACK" : "WHITE";
			let stone = is_black ? "black_stone.png" : "white_stone.png";
			let active_class = active === colour ? " mr_player_active" : "";
			let rank_html = rank ? `<span class="mr_player_rank">${safe_html(rank)}</span>` : "";
			let turn_html = active === colour ? `<span class="mr_player_turn">TO PLAY</span>` : "";
			return [
				`<div class="mr_player mr_player_${colour}${active_class}">`,
				`<img src="./gfx/${stone}" class="mr_player_stone" alt="${colour_name}">`,
				`<span class="mr_player_text">`,
				`<span class="mr_player_colour">${colour_name}${turn_html}</span>`,
				`<span class="mr_player_name">${safe_html(name || colour_name[0] + colour_name.slice(1).toLowerCase() + " player")}${rank_html}</span>`,
				`</span>`,
				`</div>`,
			].join("");
		};

		let event = prop("EV");
		let round = prop("RO");
		let result = prop("RE");
		let context = [event, round ? `Round ${round}` : ""].filter(Boolean).map(safe_html).join("<br>");
		let result_html = result ? `<span class="mr_game_result">${safe_html(result)}</span>` : "";
		let meta_html = context || result_html
			? `<div class="mr_game_meta"><span>${context}</span>${result_html}</div>`
			: `<div class="mr_game_meta"></div>`;

		return `<div class="mr_players">${player("b", black_name, prop("BR"))}${meta_html}${player("w", white_name, prop("WR"))}</div>`;
	},

	html_turn: function(node) {
		let board = node.get_board();
		if (board.active === "b") {
			return `<div class="mr_turn"><img src="./gfx/black_stone.png" class="mr_stone"> BLACK TO PLAY</div>`;
		} else {
			return `<div class="mr_turn"><img src="./gfx/white_stone.png" class="mr_stone"> WHITE TO PLAY</div>`;
		}
	},

	html_lastmove: function(node) {

		let board = node.get_board();
		let parts = [];

		if (node.move_count() === 1) {

			let mover_is_b = node.has_key("B");
			let s = mover_is_b ? node.get("B") : node.get("W");
			let gtp = board.gtp(s);
			let stone = mover_is_b ? "●" : "○";

			parts.push(`<div class="mr_lastmove">#${node.depth}  ${stone} ${mover_is_b ? "Black" : "White"}  <span class="mr_coord">${gtp}</span></div>`);

			let lost = this.points_lost(node);

			if (lost !== null) {

				let [label, klass] = this.verdict(lost);
				let lost_str = lost < 0.005 ? "as good as the best move" : `lost ${lost.toFixed(2)} pts vs best`;
				parts.push(`<div class="mr_verdict ${klass}">${label}</div>`);

				// Where was the best move, and how far away did the mover play?

				let best_detail = "";
				if (node.parent.has_valid_analysis()) {
					let best_gtp = explored.best_info(node.parent).move;
					let best_s = board.parse_gtp_move(best_gtp);
					let played_c = node.parent.canonical_symmetry(s);
					if (best_s !== "" && s !== "" && gtp !== "pass") {
						if (best_s === played_c || best_s === s) {
							best_detail = `played the best move`;
						} else {
							let dx = Math.abs(best_s.charCodeAt(0) - s.charCodeAt(0));
							let dy = Math.abs(best_s.charCodeAt(1) - s.charCodeAt(1));
							let dist = Math.max(dx, dy);
							best_detail = `best was <span class="mr_coord">${best_gtp}</span> (${dist} ${dist === 1 ? "line" : "lines"} away)`;
						}
					} else if (best_gtp === "pass" && gtp === "pass") {
						best_detail = `played the best move`;
					} else if (best_gtp) {
						best_detail = `best was <span class="mr_coord">${best_gtp}</span>`;
					}
				}

				parts.push(`<div class="mr_quality">${lost_str}${best_detail ? " — " + best_detail : ""}</div>`);

			} else {
				parts.push(`<div class="mr_quality mr_dim">no analysis of the previous position yet</div>`);
			}

		} else if (!node.parent) {
			parts.push(`<div class="mr_quality mr_dim">game start</div>`);
		} else {
			parts.push(`<div class="mr_quality mr_dim">setup / edit node</div>`);
		}

		return parts.join("\n");
	},

	html_outcome: function(node) {

		if (node.move_count() !== 1 || !node.parent) {
			return `<div class="mr_quality mr_dim">—</div>`;
		}

		let ps = node.parent.stored_score();
		let cs = node.stored_score();
		let pw = node.parent.stored_winrate();
		let cw = node.stored_winrate();

		if (typeof ps !== "number" && typeof pw !== "number") {
			return `<div class="mr_quality mr_dim">no analysis of the previous position yet</div>`;
		}

		let parts = [];
		parts.push(`<table class="mr_outcome">`);
		if (typeof ps === "number" && typeof cs === "number") {
			parts.push(`<tr><td class="sand">Score</td><td>${this.fmt_score(ps)}</td><td class="sand">→</td><td class="mr_now">${this.fmt_score(cs)}</td></tr>`);
		}
		if (typeof pw === "number" && typeof cw === "number") {
			parts.push(`<tr><td class="sand">Win</td><td>${this.fmt_winrate(pw)}</td><td class="sand">→</td><td class="mr_now">${this.fmt_winrate(cw)}</td></tr>`);
		}
		parts.push(`</table>`);
		return parts.join("\n");
	},

	format_reply_tooltip: function(info, summary) {
		if (!summary) {
			return "Waiting for continuation probe...";
		}
		let lines = [];
		let src_lbl = summary.source === "tree" ? "from explored tree" : "probed";
		lines.push(`After ${info.move} (${this.fmt_visits(summary.visits)} visits, ${src_lbl}):`);
		if (summary.gap2 !== null) {
			lines.push(`2nd-best reply loses ${summary.gap2.toFixed(2)} pts`);
		}
		if (summary.eff_moves !== null) {
			lines.push(`Effective replies (exp H): ${summary.eff_moves.toFixed(2)}`);
		}
		if (summary.policy_cost !== null) {
			lines.push(`Policy-weighted reply loss: ${summary.policy_cost.toFixed(2)} pts`);
		}
		if (summary.top_replies && summary.top_replies.length > 0) {
			let rep_str = summary.top_replies.slice(0, 4).map(r => {
				let c = r.cost <= 0.005 ? "best" : `-${r.cost.toFixed(2)}`;
				let p = typeof r.prior === "number" ? ` ${Math.round(r.prior * 100)}%` : "";
				return `${r.move} (${c}${p})`;
			}).join(" · ");
			lines.push(`Replies: ${rep_str}`);
		}
		return lines.join("\n");
	},

	html_options: function(node) {

		let parts = [];

		if (node.has_valid_analysis()) {

			// Costs are vs the best AVAILABLE move (explored.best_info, the
			// first row), never vs the global board value: if we're losing
			// badly, the best we can do from here is the reference point
			// (PRODUCT.md rule 5)...

			let infos = options_table_infos(node);
			let best = explored.best_info(node);
			let active_is_b = node.get_board().active === "b";
			let costs = infos.map(info => info_cost(info, best.scoreLead, active_is_b));
			let summaries = infos.map(info => continuation_prober.lookup(node, [info.move]));
			let show_nar = config.continuation_probe || summaries.some(Boolean);
			let rel_scale = show_nar ? narrowness.relative_narrowness_scale(summaries) : null;

			// Gradient cap: worst displayed cost, floored at 2 pts so near-equal
			// options stay near-equal in color (PRODUCT.md rule 6)...

			let cap = Math.max(2, ...costs.filter(c => c !== null));

			parts.push(`<table class="mr_cands">`);
			if (show_nar) {
				parts.push(`<tr class="mr_head"><td>move</td><td>score</td><td>win</td><td>costs</td><td title="Points opponent loses on their 2nd-best reply (larger = narrower/forcing)">opp gap</td><td title="Effective opponent replies exp(H) with relative narrowness bar (1.0 = forced)">opp width</td><td>visits</td></tr>`);
			} else {
				parts.push(`<tr class="mr_head"><td>move</td><td>score</td><td>win</td><td>costs</td><td>visits</td></tr>`);
			}

			for (let i = 0; i < infos.length; i++) {

				let info = infos[i];
				let cost_str = loss_text(costs[i], config.basis_point_display, false, info === best);
				if (cost_str === ZERO_LOSS) {
					cost_str = `<span class="mr_zero_loss">${ZERO_LOSS}</span>`;
				}

				// Gradient colours are continuous data, so they can't be classes:
				// the row carries data-colour, bind_row_colours() turns it into
				// --val-colour, and the .mr_val rule consumes it.

				let val_bind = costs[i] === null ? "" : ` data-colour="${this.value_colour(costs[i], cap)}"`;
				let visits_html = info.explored
					? `<td class="mr_explored_visits">${this.fmt_visits(info.visits)} <span class="mr_explored">explored</span></td>`
					: `<td class="mr_dim">${this.fmt_visits(info.visits)}</td>`;

				let nar_html = "";
				if (show_nar) {
					let sum = summaries[i];
					let tip = safe_html(this.format_reply_tooltip(info, sum));
					let preview_seq = [info.move];
					if (sum && Array.isArray(sum.best_pv) && sum.best_pv.length > 0) {
						preview_seq.push(...sum.best_pv.slice(0, 6));
					} else if (Array.isArray(info.pv) && info.pv.length > 1) {
						preview_seq = info.pv.slice(0, 7);
					}
					let preview_attr = ` data-preview-seq="${safe_html(preview_seq.join(" "))}"`;
					let gap_str = sum && sum.gap2 !== null ? `+${sum.gap2.toFixed(2)}` : "…";
					let width_cell = "…";
					if (sum && sum.eff_moves !== null) {
						let ratio = rel_scale && rel_scale.max_eff > 0 ? sum.eff_moves / rel_scale.max_eff : 0.5;
						let pct = Math.round(Math.max(10, Math.min(100, ratio * 100)));
						width_cell = `<span class="mr_nar_wrap"><span class="mr_nar_bar"><span class="mr_nar_fill" data-nar-pct="${pct}"></span></span><span class="mr_nar_num">${sum.eff_moves.toFixed(1)}</span></span>`;
					}
					nar_html = `<td class="mr_nar_gap" title="${tip}"${preview_attr}>${gap_str}</td><td class="mr_nar_width" title="${tip}"${preview_attr}>${width_cell}</td>`;
				}

				parts.push(
					`<tr class="mr_cand" data-gtp="${info.move}"${val_bind}>` +
					`<td class="mr_coord mr_val">${info.move}</td>` +
					`<td>${this.fmt_score(info.scoreLead)}</td>` +
					`<td>${this.fmt_winrate(info.winrate)}</td>` +
					`<td class="mr_val">${cost_str}</td>` +
					nar_html +
					visits_html +
					`</tr>`
				);
			}

			parts.push(`</table>`);
			if (infos.some(info => info.explored)) {
				parts.push(`<div class="mr_small mr_explored_note"><span class="mr_explored">explored</span>: score, win and visits come from searching the position after that move</div>`);
			}

		} else if (hub.engine.desired) {
			parts.push(`<div class="mr_quality mr_dim">analysing...</div>`);
		} else {
			parts.push(`<div class="mr_quality mr_dim">engine is not analysing (press Space)</div>`);
		}

		return parts.join("\n");
	},

	html_corridor: function(node) {

		let parts = [];

		if (!node.has_valid_analysis()) {
			parts.push(`<div class="mr_quality mr_dim">${hub.engine.desired ? "analysing..." : "engine is not analysing (press Space)"}</div>`);
			return parts.join("\n");
		}

		let root_sum = narrowness.summarize_position(node.analysis, node.get_board().active === "b");
		if (root_sum) {
			let gap_s = root_sum.gap2 !== null ? `+${root_sum.gap2.toFixed(2)} pts` : "single";
			let eff_s = root_sum.eff_moves !== null ? root_sum.eff_moves.toFixed(2) : "—";
			let pol_s = root_sum.policy_cost !== null ? `${root_sum.policy_cost.toFixed(2)} pts` : "—";
			parts.push(
				`<div class="mr_corridor_root">` +
				`<span class="mr_cor_label">Current position</span>` +
				`<span title="2nd-best move loss at this position">gap₂ <b>${gap_s}</b></span>` +
				`<span title="Effective moves exp(H) at this position">N_eff <b>${eff_s}</b></span>` +
				`<span title="Policy-weighted expected point loss (higher = sharper/trickier)">π loss <b>${pol_s}</b></span>` +
				`</div>`
			);
		}

		let infos = options_table_infos(node);
		let best = explored.best_info(node);
		let active_is_b = node.get_board().active === "b";
		let costs = infos.map(info => info_cost(info, best.scoreLead, active_is_b));
		let summaries = infos.map(info => continuation_prober.lookup(node, [info.move]));
		let rel_scale = narrowness.relative_narrowness_scale(summaries);
		let cap = Math.max(2, ...costs.filter(c => c !== null));

		parts.push(`<table class="mr_cands mr_corridor_table">`);
		parts.push(
			`<tr class="mr_head">` +
			`<td>move</td>` +
			`<td>cost</td>` +
			`<td title="Points opponent loses on 2nd-best reply">opp gap₂</td>` +
			`<td title="Effective opponent replies exp(H) (1.0 = forced)">opp N_eff</td>` +
			`<td title="Opponent policy-weighted expected loss in pts (low = obvious reply, high = tricky/sharp)">opp π loss</td>` +
			`<td title="Click to play sequence into variation tree; hover to preview on board">continuation</td>` +
			`<td></td>` +
			`</tr>`
		);

		for (let i = 0; i < infos.length; i++) {
			let info = infos[i];
			let sum = summaries[i];
			let cost_str = loss_text(costs[i], config.basis_point_display, false, info === best);
			if (cost_str === ZERO_LOSS) {
				cost_str = `<span class="mr_zero_loss">${ZERO_LOSS}</span>`;
			}
			let val_bind = costs[i] === null ? "" : ` data-colour="${this.value_colour(costs[i], cap)}"`;

			let chain = continuation_prober.corridor_chain(node, info.move, 6);
			let seq = [];
			let seq_html = "";
			if (chain.length > 0) {
				seq = chain.map(step => step.move_played);
				let tail = chain[chain.length - 1];
				let tail_reply = tail.summary && tail.summary.best_move ? tail.summary.best_move : null;
				if (tail_reply) {
					seq.push(tail_reply);
				}
				let parts_seq = chain.map((step, idx) => {
					if (idx === 0) {
						return `<span class="mr_cor_step">${safe_html(step.move_played)}</span>`;
					}
					let g = step.summary && step.summary.gap2 !== null ? ` (gap₂ +${step.summary.gap2.toFixed(1)})` : "";
					return `<span class="mr_cor_step" title="${safe_html(step.move_played)}${safe_html(g)}">${safe_html(step.move_played)}</span>`;
				});
				if (tail_reply) {
					let g = tail.summary && tail.summary.gap2 !== null ? ` (gap₂ +${tail.summary.gap2.toFixed(1)})` : "";
					parts_seq.push(`<span class="mr_cor_step" title="Best reply ${safe_html(tail_reply)}${safe_html(g)}">${safe_html(tail_reply)}</span>`);
				}
				seq_html = parts_seq.join(" → ");
			} else if (sum && Array.isArray(sum.best_pv) && sum.best_pv.length > 0) {
				seq = [info.move, ...sum.best_pv.slice(0, 5)];
				seq_html = seq.map(m => `<span class="mr_cor_step">${safe_html(m)}</span>`).join(" ");
			} else if (Array.isArray(info.pv) && info.pv.length > 0) {
				seq = info.pv.slice(0, 6);
				seq_html = seq.map(m => `<span class="mr_cor_step">${safe_html(m)}</span>`).join(" ");
			} else {
				seq = [info.move];
				seq_html = safe_html(info.move);
			}

			let seq_attr = safe_html(seq.join(" "));
			let tip = safe_html(this.format_reply_tooltip(info, sum));
			let gap_str = sum && sum.gap2 !== null ? `+${sum.gap2.toFixed(2)}` : "…";
			let pol_str = sum && sum.policy_cost !== null ? sum.policy_cost.toFixed(2) : "…";

			let eff_html = "…";
			if (sum && sum.eff_moves !== null) {
				let ratio = rel_scale && rel_scale.max_eff > 0 ? sum.eff_moves / rel_scale.max_eff : 0.5;
				let pct = Math.round(Math.max(10, Math.min(100, ratio * 100)));
				eff_html = `<span class="mr_nar_wrap"><span class="mr_nar_bar"><span class="mr_nar_fill" data-nar-pct="${pct}"></span></span><span class="mr_nar_num">${sum.eff_moves.toFixed(1)}</span></span>`;
			}

			let traced_len = chain.length;
			let trace_label = traced_len > 2 ? `${traced_len}p` : "trace";

			parts.push(
				`<tr class="mr_cand" data-gtp="${info.move}" data-preview-seq="${seq_attr}"${val_bind}>` +
				`<td class="mr_coord mr_val">${info.move}</td>` +
				`<td class="mr_val">${cost_str}</td>` +
				`<td class="mr_nar_gap" title="${tip}">${gap_str}</td>` +
				`<td class="mr_nar_width" title="${tip}">${eff_html}</td>` +
				`<td class="mr_nar_pol" title="${tip}">${pol_str}</td>` +
				`<td class="mr_cor_seq" data-play-seq="${seq_attr}" title="Click to play sequence into variation tree">${seq_html}</td>` +
				`<td><span class="mr_trace_btn" data-trace-gtp="${info.move}" title="Probe 5 plies deep along this corridor">${trace_label}</span></td>` +
				`</tr>`
			);
		}

		parts.push(`</table>`);
		return parts.join("\n");
	},

	// ------------------------------------------------------------ chart shared bits

	size_canvas: function(canvas) {
		let parent = canvas.parentElement;
		if (!parent) {
			return false;
		}
		let want_width = Math.max(0, parent.clientWidth);
		let want_height = Math.max(0, parent.clientHeight);
		if (want_width < 16 || want_height < 16) {
			return false;
		}
		if (canvas.width !== want_width || canvas.height !== want_height) {
			canvas.width = want_width;
			canvas.height = want_height;
		}
		return true;
	},

	// ------------------------------------------------------------ current candidate-value views

	current_candidate_profile: function(node) {
		let all = this.candidate_costs(node).filter(candidate => candidate.cost !== null);
		let limit = config.move_report_distribution_top_n;
		if (!Number.isInteger(limit) || limit < 0) {
			throw new Error("current_candidate_profile(): candidate limit must be an integer >= 0");
		}
		let shown = limit === 0 ? all : all.slice(0, limit);
		return candidate_profile.profile(shown.map(candidate => candidate.cost), all.length);
	},

	distribution_coverage_label: function(profile) {
		if (profile.reported_total === null) {
			return `${profile.total} stored candidates`;
		}
		return profile.truncated
			? `${profile.total} of ${profile.reported_total} reported`
			: `${profile.total} reported candidates`;
	},

	draw_distribution: function(node) {
		let canvas = this.distribution_canvas;
		let ctx = this.distribution_ctx;
		if (!this.size_canvas(canvas)) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let profile = this.current_candidate_profile(node);
		let method = `draw_distribution_${config.move_report_breadth_view}`;
		if (typeof this[method] !== "function") {
			throw new Error(`draw_distribution(): unsupported view ${config.move_report_breadth_view}`);
		}
		this[method](profile);
	},

	distribution_frame: function(profile, bottom_pad_lines = 2.7) {

		// Vertical reservations are in multiples of the axis-label font
		// ("caption" in the type scale), so they hold any app font setting.

		let cap = type_scale.px("caption");
		let canvas = this.distribution_canvas;
		let ctx = this.distribution_ctx;
		let {x0, x1, y0: frame_y0} = chart_plot_rect(canvas);
		let y0 = frame_y0 + Math.round(cap * 1.6);
		let y1 = canvas.height - Math.round(cap * bottom_pad_lines);
		this.distribution_hover_map = null;
		if (x1 - x0 < 40 || y1 - y0 < 24) {
			return null;
		}
		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, frame_y0, x1 - x0, y1 - frame_y0);
		ctx.font = type_scale.canvas_font("caption");
		if (profile.total === 0) {
			ctx.fillStyle = "#ffffffff";
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillText(hub.engine.desired ? "analysing..." : "no candidate analysis", x0 + 6, frame_y0 + 6);
			return null;
		}
		ctx.fillStyle = "#ffffffff";
		ctx.textAlign = "right";
		ctx.textBaseline = "top";
		ctx.fillText(this.distribution_coverage_label(profile), x1 - 6, frame_y0 + 6);
		return {canvas, ctx, x0, x1, y0, y1};
	},

	draw_profile_bars: function(profile, labels, counts, colours, axis_title) {
		let frame = this.distribution_frame(profile, 3.1);
		if (!frame) return;
		let {canvas, ctx, x0, x1, y0, y1} = frame;
		let count_max = Math.max(1, ...counts);
		let count_step = Math.max(1, Math.ceil(count_max / 4));
		let y_max = Math.ceil(count_max / count_step) * count_step;
		let y_of = count => y1 - (y1 - y0) * count / y_max;

		ctx.textBaseline = "middle";
		for (let count = 0; count <= y_max; count += count_step) {
			let y = y_of(count);
			ctx.strokeStyle = count === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.fillText(count.toString(), x0 - 5, y);
		}

		let slot_w = (x1 - x0) / counts.length;
		let regions = [];
		for (let i = 0; i < counts.length; i++) {
			let left = x0 + i * slot_w;
			let right = left + slot_w;
			let top = y_of(counts[i]);
			ctx.fillStyle = colours[i];
			ctx.fillRect(left, top, slot_w, y1 - top);
			ctx.strokeStyle = "#111111ff";
			ctx.strokeRect(left, top, slot_w, y1 - top);
			if (counts[i] > 0) {
				ctx.fillStyle = "#ffffffff";
				ctx.textAlign = "center";
				ctx.textBaseline = "bottom";
				ctx.fillText(counts[i].toString(), (left + right) / 2, Math.max(y0 + type_scale.px("caption") * 2, top - 2));
			}
			ctx.fillStyle = "#e0b872ff";
			ctx.textBaseline = "top";
			if (slot_w >= ctx.measureText(labels[i]).width + 4 || i === 0 || i === labels.length - 1) {
				ctx.fillText(labels[i], (left + right) / 2, y1 + 5);
			}
			regions.push({x0: left, x1: right, range: labels[i], count: counts[i]});
		}
		this.distribution_hover_map = {regions};
		ctx.fillStyle = "#99ff99ff";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText("candidate count", x0 + 6, y0 + 6);
		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.fillText(axis_title, (x0 + x1) / 2, canvas.height - 2);
	},

	draw_distribution_focus_tail: function(profile) {
		let labels = ["best", "0–.05", ".05–.10", ".10–.15", ".15–.20", ".20–.25", ".25–.30", ".30–1", "1–3", "3–10", ">10"];
		let counts = new Array(labels.length).fill(0);
		if (profile.total > 0) counts[0] = 1;
		for (let cost of profile.alternatives) {
			if (cost <= .05 + Number.EPSILON) counts[1]++;
			else if (cost <= .10 + Number.EPSILON) counts[2]++;
			else if (cost <= .15 + Number.EPSILON) counts[3]++;
			else if (cost <= .20 + Number.EPSILON) counts[4]++;
			else if (cost <= .25 + Number.EPSILON) counts[5]++;
			else if (cost <= .30 + Number.EPSILON) counts[6]++;
			else if (cost <= 1 + Number.EPSILON) counts[7]++;
			else if (cost <= 3 + Number.EPSILON) counts[8]++;
			else if (cost <= 10 + Number.EPSILON) counts[9]++;
			else counts[10]++;
		}
		let colours = labels.map((_, i) => this.value_colour(i, labels.length - 1));
		this.draw_profile_bars(profile, labels, counts, colours, "fixed near-best focus · explicit tail");
		let frame = chart_plot_rect(this.distribution_canvas);
		if (profile.nearest_outside_030 !== null) {
			let ctx = this.distribution_ctx;
			ctx.fillStyle = "#ffffffff";
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillText(`nearest outside 0.30: ${profile.nearest_outside_030.toFixed(2)}`, frame.x0 + 6, frame.y0 + 6);
		}
	},

	draw_distribution_fixed_bands: function(profile) {
		this.draw_profile_bars(
			profile,
			candidate_profile.BAND_LABELS,
			profile.bands,
			PROFILE_COLOURS,
			"fixed score-cost bands (points worse than best)"
		);
	},

	draw_distribution_cumulative: function(profile) {
		let frame = this.distribution_frame(profile, 3.1);
		if (!frame) return;
		let {canvas, ctx, x0, x1, y0, y1} = frame;
		let labels = ["best", "0.10", "0.30", "1", "3", "10", "all"];
		let counts = [1, ...profile.within, profile.total];
		let y_max = Math.max(1, profile.total);
		let x_of = i => x0 + (x1 - x0) * i / (counts.length - 1);
		let y_of = count => y1 - (y1 - y0) * count / y_max;

		for (let count = 0; count <= y_max; count += Math.max(1, Math.ceil(y_max / 4))) {
			let y = y_of(count);
			ctx.strokeStyle = count === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(count.toString(), x0 - 5, y);
		}
		ctx.strokeStyle = "#75c9e8ff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i < counts.length; i++) {
			let x = x_of(i);
			let y = y_of(counts[i]);
			if (i === 0) ctx.moveTo(x, y);
			else {
				ctx.lineTo(x, y_of(counts[i - 1]));
				ctx.lineTo(x, y);
			}
		}
		ctx.stroke();
		let regions = [];
		for (let i = 0; i < counts.length; i++) {
			let x = x_of(i);
			let y = y_of(counts[i]);
			ctx.fillStyle = "#b3e5f7ff";
			ctx.beginPath();
			ctx.arc(x, y, 3, 0, 2 * Math.PI);
			ctx.fill();
			ctx.fillStyle = "#ffffffff";
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";
			ctx.fillText(counts[i].toString(), x, Math.max(y0 + type_scale.px("caption") * 2, y - 4));
			ctx.fillStyle = "#e0b872ff";
			ctx.textBaseline = "top";
			ctx.fillText(labels[i], x, y1 + 5);
			let half = (x1 - x0) / (counts.length - 1) / 2;
			regions.push({x0: x - half, x1: x + half, range: `within ${labels[i]} points`, count: counts[i]});
		}
		this.distribution_hover_map = {regions};
		ctx.fillStyle = "#99ff99ff";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText("moves within threshold", x0 + 6, y0 + 6);
		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.fillText("fixed score-cost threshold (points)", (x0 + x1) / 2, canvas.height - 2);
	},

	draw_distribution_rank: function(profile) {
		let frame = this.distribution_frame(profile, 2.5);
		if (!frame) return;
		let {canvas, ctx, x0, x1, y0, y1} = frame;
		let cap = 10;
		let transform = value => Math.log10(1 + value);
		let y_of = cost => y1 - (y1 - y0) * transform(Math.min(cap, cost)) / transform(cap);
		let x_of = rank => profile.total === 1
			? (x0 + x1) / 2
			: x0 + (x1 - x0) * (rank - 1) / (profile.total - 1);
		let label_h = type_scale.px("caption");
		let label_ys = [];
		for (let tick of [0, 10, 1, 3, .3, .1]) {			// Endpoints first; a tick too close to a labelled one keeps only its line.
			let y = y_of(tick);
			ctx.strokeStyle = tick === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			if (label_ys.some(label_y => Math.abs(label_y - y) < label_h)) {
				continue;
			}
			label_ys.push(y);
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(tick.toString(), x0 - 5, y);
		}
		ctx.strokeStyle = "#75c9e8ff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let i = 0; i < profile.costs.length; i++) {
			let x = x_of(i + 1);
			let y = y_of(profile.costs[i]);
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
		let slot_w = (x1 - x0) / Math.max(1, profile.total);
		let regions = [];
		for (let i = 0; i < profile.costs.length; i++) {
			let x = x_of(i + 1);
			let y = y_of(profile.costs[i]);
			ctx.fillStyle = this.value_colour(Math.min(cap, profile.costs[i]), cap);
			ctx.beginPath();
			ctx.arc(x, y, 2.5, 0, 2 * Math.PI);
			ctx.fill();
			regions.push({
				x0: x - slot_w / 2,
				x1: x + slot_w / 2,
				range: `value rank ${i + 1}: ${profile.costs[i].toFixed(2)} points worse`,
				count: 1,
			});
		}
		this.distribution_hover_map = {regions};
		ctx.fillStyle = "#99ff99ff";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText("score cost by value rank", x0 + 6, y0 + 6);
		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "bottom";
		ctx.fillText(`value rank 1–${profile.total} · costs above 10 pin to top`, (x0 + x1) / 2, canvas.height - 2);
	},

	draw_distribution_summary: function(profile) {
		let frame = this.distribution_frame(profile, 1.3);
		if (!frame) return;
		let {ctx, x0, x1, y0, y1} = frame;
		let fmt = value => value === null ? "—" : value.toFixed(2);
		let gap = profile.largest_gap;
		let metrics = [
			["≤0.10", profile.within[0].toString()],
			["≤0.30", profile.within[1].toString()],
			["≤1.00", profile.within[2].toString()],
			["second", fmt(profile.second)],
			["median", fmt(profile.median)],
			["nearest >0.30", fmt(profile.nearest_outside_030)],
			["90th percentile", fmt(profile.p90)],
			["worst shown", fmt(profile.worst)],
			["largest gap", gap ? `${gap.size.toFixed(2)} @ rank ${gap.rank}` : "—"],
		];
		let columns = 3;
		let rows = Math.ceil(metrics.length / columns);
		let cell_w = (x1 - x0) / columns;
		let cell_h = (y1 - y0) / rows;

		// The label uses "fine"; the value takes the biggest scale step whose
		// label + value stack fits the cell (never an ad-hoc size).

		let label_px = type_scale.px("fine");
		let value_size = ["body", "caption", "fine"].find(
			name => 6 + label_px + 3 + type_scale.px(name) <= cell_h
		) || "fine";

		for (let i = 0; i < metrics.length; i++) {
			let col = i % columns;
			let row = Math.floor(i / columns);
			let x = x0 + col * cell_w + 8;
			let y = y0 + row * cell_h;
			ctx.fillStyle = "#ffffffff";
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.font = type_scale.canvas_font("fine");
			ctx.fillText(metrics[i][0], x, y + 6);
			ctx.fillStyle = i < 3 ? "#99ff99ff" : "#ffffffff";
			ctx.font = type_scale.canvas_font(value_size, "bold");
			ctx.fillText(metrics[i][1], x, y + 6 + label_px + 3);
		}
	},

	distribution_detail_at: function(mousex) {
		let map = this.distribution_hover_map;
		if (!map) return null;
		let region = map.regions.find(item => mousex >= item.x0 && mousex < item.x1);
		return region ? {range: region.range, count: region.count} : null;
	},

	// ------------------------------------------------------------ historical choice breadth

	breadth_data: function(node) {
		let history = node.history();
		let end_depth = history.length - 1;
		let {x0, x1, y0, y1} = chart_plot_rect(this.breadth_canvas);
		let xs = chart_x_scale(
			x0,
			x1,
			end_depth,
			config.move_report_quality_windowed,
			config.move_report_quality_window_n
		);
		let records = {};
		for (let d = xs.first_move; d <= end_depth; d++) {
			let costs = history[d].stored_candidate_costs();
			if (costs === null) continue;
			let profile = candidate_profile.profile(costs);
			let width = history[d].stored_position_width();
			if (width !== null) {
				profile.within[1] = width;
				profile.bands[2] = Math.max(0, width - profile.within[0]);
			}
			records[d] = {profile, width};
		}
		return {history, end_depth, x0, x1, y0, y1, xs, records};
	},

	draw_breadth: function(node) {
		let canvas = this.breadth_canvas;
		let ctx = this.breadth_ctx;
		if (!this.size_canvas(canvas)) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		let data = this.breadth_data(node);
		let {x0, x1, y0, y1, xs, end_depth, history} = data;
		if (x1 - x0 < 40 || y1 - y0 < 24) {
			this.breadth_click_map = null;
			return;
		}
		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
		this.breadth_click_map = end_depth >= xs.first_move
			? {x0, slot_w: xs.slot_w, domain_start: xs.domain_start, start_depth: xs.first_move, end_depth, history}
			: null;

		let method = `draw_breadth_${config.move_report_breadth_view}`;
		if (typeof this[method] !== "function") {
			throw new Error(`draw_breadth(): unsupported view ${config.move_report_breadth_view}`);
		}
		this[method](data);
		this.finish_breadth_chart(data);
	},

	finish_breadth_chart: function(data) {
		let {x0, x1, y0, y1, xs, end_depth} = data;
		let ctx = this.breadth_ctx;
		ctx.font = type_scale.canvas_font("caption");
		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		let widest = ctx.measureText(end_depth.toString()).width;
		let step = Math.max(1, Math.ceil((widest + 4) / xs.slot_w));
		for (let d = end_depth; d >= xs.first_move; d -= step) {
			ctx.fillText(d.toString(), xs.x_of(d - 0.5), y1 + 5);
		}
		stroke_position_marker(ctx, xs.x_of(end_depth), y0, y1);
		if (this.breadth_hover_depth !== null &&
			this.breadth_hover_depth >= xs.first_move &&
			this.breadth_hover_depth <= end_depth) {
			let x = xs.x_of(this.breadth_hover_depth);
			ctx.strokeStyle = "rgba(145, 205, 255, 0.75)";
			ctx.beginPath();
			ctx.moveTo(x, y0);
			ctx.lineTo(x, y1);
			ctx.stroke();
		}
	},

	draw_breadth_focus_tail: function(data) {
		let {x0, x1, y0, y1, xs, records} = data;
		let ctx = this.breadth_ctx;
		let series = [
			{index: 0, label: "≤0.10", colour: "#75c9e8ff"},
			{index: 1, label: "≤0.30", colour: "#99ff99ff"},
			{index: 2, label: "≤1.00", colour: "#e0b872ff"},
		];
		let y_max = 1;
		for (let record of Object.values(records)) {
			y_max = Math.max(y_max, ...record.profile.within.slice(0, 3));
		}
		let y_of = count => y1 - (y1 - y0) * count / y_max;
		for (let count = 0; count <= y_max; count += Math.max(1, Math.ceil(y_max / 4))) {
			let y = y_of(count);
			ctx.strokeStyle = count === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.font = type_scale.canvas_font("caption");
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(count.toString(), x0 - 5, y);
		}
		for (let item of series) {
			ctx.strokeStyle = item.colour;
			ctx.lineWidth = item.index === 1 ? 2 : 1;
			ctx.beginPath();
			let started = false;
			for (let d = data.xs.first_move; d <= data.end_depth; d++) {
				let record = records[d];
				if (!record) {
					started = false;
					continue;
				}
				let x = xs.x_of(d);
				let y = y_of(record.profile.within[item.index]);
				if (!started) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
				started = true;
			}
			ctx.stroke();
		}
		draw_swatch_legend(ctx, series, x0 + 6, y0 + 6, x1 - 4);
		ctx.fillStyle = "#ffffffff";
		ctx.textAlign = "right";
		ctx.fillText("candidate count over time", x1 - 6, y0 + 6);
	},

	draw_breadth_fixed_bands: function(data) {
		let {x0, x1, y0, y1, xs, records} = data;
		let ctx = this.breadth_ctx;
		let y_max = 1;
		for (let record of Object.values(records)) {
			y_max = Math.max(y_max, record.profile.bands.reduce((sum, count) => sum + count, 0));
		}
		let y_of = count => y1 - (y1 - y0) * count / y_max;
		for (let count = 0; count <= y_max; count += Math.max(1, Math.ceil(y_max / 4))) {
			let y = y_of(count);
			ctx.strokeStyle = count === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.font = type_scale.canvas_font("caption");
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(count.toString(), x0 - 5, y);
		}
		for (let d = xs.first_move; d <= data.end_depth; d++) {
			let record = records[d];
			if (!record) continue;
			let left = xs.x_of(d - 1);
			let right = xs.x_of(d);
			let running = 0;
			for (let i = 0; i < record.profile.bands.length; i++) {
				let next = running + record.profile.bands[i];
				ctx.fillStyle = PROFILE_COLOURS[i];
				ctx.fillRect(left, y_of(next), Math.max(1, right - left), y_of(running) - y_of(next));
				running = next;
			}
		}
		ctx.fillStyle = "#111111dd";
		ctx.fillRect(x0, y0, x1 - x0, type_scale.px("fine") + 10);
		let bands = candidate_profile.BAND_LABELS.map((label, i) => ({label, colour: PROFILE_COLOURS[i]}));
		draw_swatch_legend(ctx, bands, x0 + 6, y0 + 6, x1 - 4);
	},

	draw_breadth_cumulative: function(data) {
		let {x0, x1, y0, y1, xs, records} = data;
		let ctx = this.breadth_ctx;
		let rows = candidate_profile.THRESHOLDS.length;
		let max_count = 1;
		for (let record of Object.values(records)) {
			max_count = Math.max(max_count, ...record.profile.within);
		}
		let row_h = (y1 - y0) / rows;
		for (let row = 0; row < rows; row++) {
			let top = y0 + row * row_h;
			ctx.fillStyle = "#e0b872ff";
			ctx.font = type_scale.canvas_font("caption");
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(`≤${candidate_profile.THRESHOLDS[row]}`, x0 - 5, top + row_h / 2);
			for (let d = xs.first_move; d <= data.end_depth; d++) {
				let record = records[d];
				if (!record) continue;
				let count = record.profile.within[row];
				let alpha = 0.12 + 0.78 * count / max_count;
				ctx.fillStyle = `rgba(75, 170, 255, ${alpha.toFixed(3)})`;
				ctx.fillRect(xs.x_of(d - 1), top, Math.max(1, xs.slot_w), row_h);
			}
		}
		ctx.fillStyle = "#ffffffff";
		ctx.textAlign = "right";
		ctx.textBaseline = "top";
		ctx.fillText(`darker = more candidates · max ${max_count}`, x1 - 6, y0 + 6);
	},

	draw_breadth_rank: function(data) {
		let {x0, x1, y0, y1, xs, records} = data;
		let ctx = this.breadth_ctx;
		let ranks = 10;
		let row_h = (y1 - y0) / ranks;
		for (let rank = 0; rank < ranks; rank++) {
			let top = y0 + rank * row_h;
			ctx.fillStyle = "#e0b872ff";
			ctx.font = type_scale.canvas_font("fine");
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText((rank + 1).toString(), x0 - 5, top + row_h / 2);
			for (let d = xs.first_move; d <= data.end_depth; d++) {
				let record = records[d];
				if (!record || rank >= record.profile.costs.length) continue;
				ctx.fillStyle = this.value_colour(Math.min(10, record.profile.costs[rank]), 10);
				ctx.fillRect(xs.x_of(d - 1), top, Math.max(1, xs.slot_w), row_h);
			}
		}
		ctx.fillStyle = "#ffffffff";
		ctx.textAlign = "right";
		ctx.textBaseline = "top";
		ctx.fillText("rows = value rank · colour = cost (cap 10)", x1 - 6, y0 + 6);
	},

	draw_breadth_summary: function(data) {
		let {x0, x1, y0, y1, xs, records} = data;
		let ctx = this.breadth_ctx;
		let states = [
			{max: 1, label: "forced", colour: "#a84f4fff"},
			{max: 3, label: "narrow", colour: "#dc9846ff"},
			{max: 7, label: "open", colour: "#9bc653ff"},
			{max: Infinity, label: "broad", colour: "#58c98bff"},
		];
		for (let d = xs.first_move; d <= data.end_depth; d++) {
			let record = records[d];
			if (!record) continue;
			let width = record.profile.within[1];
			let state = states.find(item => width <= item.max);
			ctx.fillStyle = state.colour;
			ctx.fillRect(xs.x_of(d - 1), y0, Math.max(1, xs.slot_w), y1 - y0);
		}
		ctx.fillStyle = "#111111dd";
		ctx.fillRect(x0, y0, x1 - x0, type_scale.px("fine") + 10);
		let legend = states.map(state => ({
			label: `${state.label} ${state.max === Infinity ? "8+" : state.max}`,
			colour: state.colour,
		}));
		draw_swatch_legend(ctx, legend, x0 + 6, y0 + 6, x1 - 4);
		ctx.fillStyle = "#111111cc";
		ctx.fillRect(x0, y1 - 20, x1 - x0, 20);
		ctx.fillStyle = "#ffffffff";
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillText("state = candidates within 0.30 points", x0 + 6, y1 - 10);
	},

	breadth_depth_at: function(mousex) {
		let map = this.breadth_click_map;
		if (!map) return null;
		let depth = Math.round(map.domain_start + (mousex - map.x0) / map.slot_w);
		if (depth < map.start_depth || depth > map.end_depth) return null;
		return depth;
	},

	breadth_title: function(depth) {
		let map = this.breadth_click_map;
		if (!map || depth === null || !map.history[depth]) return "";
		let costs = map.history[depth].stored_candidate_costs();
		if (costs === null) return `#${depth}: candidate values have not been stored`;
		let profile = candidate_profile.profile(costs);
		let width = map.history[depth].stored_position_width();
		let width_text = width === null ? profile.within[1] : width;
		let second = profile.second === null ? "none" : profile.second.toFixed(2);
		let outside = profile.nearest_outside_030 === null ? "none stored" : profile.nearest_outside_030.toFixed(2);
		return `#${depth}: ${width_text} within 0.30; second ${second}; nearest outside ${outside}; ${profile.total} values stored`;
	},

	node_from_breadth_click: function(mousex) {
		let depth = this.breadth_depth_at(mousex);
		if (depth === null || !this.breadth_click_map) return null;
		let node = this.breadth_click_map.history[depth];
		return !node || node.destroyed ? null : node;
	},

	// ------------------------------------------------------------ quality bar chart
	// One bar per move, on a FIXED axis: up = the move gained points for
	// White, down = it gained points for Black (respecified 2026-08-11). Since a
	// mover can only lose points vs best play, White's moves show as zero or
	// down-bars, Black's as zero or up-bars. Says nothing about who is winning
	// (that's the status chart). Y scale is linear or log2, toggled in the header.

	draw_quality: function(node) {

		let canvas = this.quality_canvas;
		let ctx = this.quality_ctx;

		if (!this.size_canvas(canvas)) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let {x0, x1, y0, y1} = chart_plot_rect(canvas);

		if (x1 - x0 < 40 || y1 - y0 < 24) {
			this.quality_click_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		// Only positions already reached on the selected variation belong in
		// this chart. Never append a blessed/main-line future after rewinding.
		let history = node.history();

		let end_depth = history.length - 1;
		let xs = chart_x_scale(
			x0,
			x1,
			end_depth,
			config.move_report_quality_windowed,
			config.move_report_quality_window_n
		);
		let start_depth = xs.first_move;
		let slot_w = xs.slot_w;

		// Bar values on the fixed axis: positive = White gained, negative = Black
		// gained. points_delta is mover-POV, so a Black move's delta flips sign
		// (Black losing points IS White gaining)...

		let w_gains = {};									// depth --> signed points, White-gain POV
		let y_abs_max = 3;
		for (let d = start_depth; d <= end_depth; d++) {
			let delta = this.points_delta(history[d]);
			let wg = delta === null ? null : (history[d].has_key("B") ? -delta : delta);
			w_gains[d] = wg;
			if (wg !== null && Math.abs(wg) > y_abs_max) {
				y_abs_max = Math.abs(wg);
			}
		}

		let scale = symmetric_y_scale(
			y_abs_max,
			config.move_report_quality_yscale,
			(max) => max <= 3 ? 1 : max <= 6 ? 2 : max <= 15 ? 5 : 10
		);
		let t_max = scale.transform(scale.y_max);
		let y_of = (v) => y0 + (y1 - y0) * (1 - (scale.transform(v) + t_max) / (2 * t_max));
		let y_zero = y_of(0);

		this.quality_click_map = end_depth >= start_depth
			? {x0, slot_w, domain_start: xs.domain_start, start_depth, end_depth, history}
			: null;

		// Gridlines and y labels (magnitudes; the regions carry the direction)...

		ctx.font = type_scale.canvas_font("caption");
		ctx.textBaseline = "middle";

		for (let v of [0, ...scale.ticks]) {
			for (let sv of (v === 0 ? [0] : [v, -v])) {
				let y = y_of(sv);
				ctx.strokeStyle = sv === 0 ? "#555555ff" : "#2c2c2cff";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x0, y);
				ctx.lineTo(x1, y);
				ctx.stroke();
				ctx.fillStyle = "#e0b872ff";
				ctx.textAlign = "right";
				ctx.fillText(v.toString(), x0 - 5, y);
			}
		}

		// Bars fill their complete move slots. Adjacent moves share an edge:
		// horizontal spacing would falsely imply that some moves are missing.

		for (let d = start_depth; d <= end_depth; d++) {
			let wg = w_gains[d];
			if (wg === null || history[d].move_count() !== 1) {
				continue;
			}
			let bar_left = xs.x_of(d - 1);
			let bar_right = xs.x_of(d);
			let y_val = y_of(wg);
			ctx.fillStyle = history[d].has_key("B") ? "#888888ff" : "#ffffffee";
			ctx.fillRect(bar_left, Math.min(y_zero, y_val), bar_right - bar_left, Math.max(1, Math.abs(y_val - y_zero)));
		}

		// Fit as many move numbers as the available width allows. Anchor the
		// sequence at the last move so it is labeled in every case.

		ctx.font = type_scale.canvas_font("caption");
		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		let widest_label = ctx.measureText(end_depth.toString()).width;
		let x_step = Math.max(1, Math.ceil((widest_label + 4) / slot_w));
		for (let d = end_depth; d >= start_depth; d -= x_step) {
			ctx.fillText(d.toString(), xs.x_of(d - 0.5), y1 + 5);
		}

		// Region labels: fixed directions, top is always White's, bottom Black's...

		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillStyle = "#ffffffff";
		ctx.fillText("white gains", x0 + 6, y0 + 8);
		ctx.textAlign = "left";
		ctx.fillStyle = "#ffffffff";
		ctx.fillText("black gains", x0 + 6, y1 - 8);

		// Current position: the right edge of this move's bar, matching the
		// status chart's point for the same depth.

		stroke_position_marker(ctx, xs.x_of(end_depth), y0, y1);
	},

	quality_depth_at: function(mousex) {

		let map = this.quality_click_map;
		if (!map) {
			return null;
		}
		let depth = Math.round(map.domain_start + (mousex - map.x0) / map.slot_w);
		if (depth < map.start_depth || depth > map.end_depth) {
			return null;
		}
		return depth;
	},

	quality_title: function(depth) {

		let map = this.quality_click_map;
		if (!map || depth === null || !map.history[depth]) {
			return "";
		}
		let delta = this.points_delta(map.history[depth]);
		return delta === null
			? `#${depth}: move quality unavailable`
			: `#${depth}: ${Math.abs(delta).toFixed(2)} points`;
	},

	node_from_quality_click: function(mousex) {

		if (!this.quality_click_map) {
			return null;
		}

		let {x0, slot_w, domain_start, start_depth, end_depth, history} = this.quality_click_map;

		// Slots are (d-1, d], so the marker at x(d) belongs to move d.
		let depth = Math.ceil(domain_start + (mousex - x0) / slot_w);
		if (depth < start_depth) depth = start_depth;
		if (depth > end_depth) depth = end_depth;

		let node = history[depth];
		if (!node || node.destroyed) {
			return null;
		}
		return node;
	},

	// ------------------------------------------------------------ game status chart
	// Who was winning at each point: the current line of play, scores Black-POV.

	draw_status: function(node) {

		let canvas = this.status_canvas;
		let ctx = this.status_ctx;

		if (!this.size_canvas(canvas)) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let {x0, x1, y0, y1} = chart_plot_rect(canvas);

		if (x1 - x0 < 40 || y1 - y0 < 24) {
			this.status_click_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		// The chart follows this node's ancestors, including variation nodes,
		// and stops at the current position. Replaying forward extends it one
		// freshly analysed position at a time.
		let history = node.history();
		let scores = history.map(n => n.stored_score());

		let end_depth = history.length - 1;
		let xs = chart_x_scale(
			x0,
			x1,
			end_depth,
			config.move_report_status_windowed,
			config.move_report_status_window_n
		);
		let line_start_depth = xs.domain_start;
		let x_of = xs.x_of;

		let abs_max = 5;
		for (let d = line_start_depth; d <= end_depth; d++) {
			let sc = scores[d];
			if (typeof sc === "number" && Math.abs(sc) > abs_max) {
				abs_max = Math.abs(sc);
			}
		}

		let scale = symmetric_y_scale(
			abs_max,
			config.move_report_status_yscale,
			(max) => max <= 10 ? 5 : max <= 20 ? 10 : max <= 60 ? 20 : 50
		);
		let t_max = scale.transform(scale.y_max);

		// White-ahead (negative Black-POV scores) remains the upper half.
		let y_of = (score) => y0 + (y1 - y0) * (scale.transform(score) + t_max) / (2 * t_max);

		this.status_click_map = {
			x0,
			slot_w: xs.slot_w,
			domain_start: xs.domain_start,
			line_start_depth,
			end_depth,
			history,
		};

		// Axes and gridlines...

		ctx.font = type_scale.canvas_font("caption");
		ctx.textBaseline = "middle";

		for (let v of [0, ...scale.ticks]) {
			for (let sv of (v === 0 ? [0] : [v, -v])) {
				let y = y_of(sv);
				ctx.strokeStyle = sv === 0 ? "#555555ff" : "#2c2c2cff";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x0, y);
				ctx.lineTo(x1, y);
				ctx.stroke();
				ctx.fillStyle = "#e0b872ff";
				ctx.textAlign = "right";
				ctx.fillText(sv === 0 ? "0" : (sv > 0 ? `B+${sv}` : `W+${-sv}`), x0 - 5, y);
			}
		}

		let widest_depth = Math.max(Math.abs(line_start_depth), Math.abs(end_depth));
		let widest_label = ctx.measureText(widest_depth.toString()).width;
		let x_step = Math.max(1, Math.ceil((widest_label + 12) / xs.slot_w));

		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (let d = end_depth; d >= line_start_depth; d -= x_step) {
			let x = x_of(d);
			ctx.strokeStyle = "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x, y0);
			ctx.lineTo(x, y1);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.fillText(d.toString(), x, y1 + 5);
		}

		// Filled area between the score line and zero, so "who is ahead" reads as a shape.
		// Black's lead fills grey (a black shape can't show on this background), White's fills white...

		let y_zero = y_of(0);

		ctx.beginPath();
		let region_started = false;
		for (let n = line_start_depth; n <= end_depth; n++) {
			if (typeof scores[n] !== "number") {
				continue;
			}
			if (!region_started) {
				ctx.moveTo(x_of(n), y_zero);
				region_started = true;
			}
			ctx.lineTo(x_of(n), y_of(scores[n]));
		}
		if (region_started) {
			ctx.lineTo(x_of(end_depth), y_zero);
			ctx.closePath();
			ctx.save();
			ctx.clip();
			ctx.fillStyle = "#ffffff55";								// W-lead half
			ctx.fillRect(x0, y0, x1 - x0, y_zero - y0);
			ctx.fillStyle = "#666666aa";								// B-lead half
			ctx.fillRect(x0, y_zero, x1 - x0, y1 - y_zero);
			ctx.restore();
		}

		// The score line itself...

		ctx.strokeStyle = "#efefefff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		let started = false;
		for (let n = line_start_depth; n <= end_depth; n++) {
			if (typeof scores[n] !== "number") {
				continue;
			}
			if (!started) {
				ctx.moveTo(x_of(n), y_of(scores[n]));
				started = true;
			} else {
				ctx.lineTo(x_of(n), y_of(scores[n]));
			}
		}
		if (started) {
			ctx.stroke();
		}

		// Region labels, at the left as in the quality chart: the chart ends at the
		// current position, so its marker and "#N" always sit at the right edge.

		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillText("W ahead", x0 + 6, y0 + 8);
		ctx.fillText("B ahead", x0 + 6, y1 - 8);

		// Current position: same x as the quality chart, the point after this move.

		let cx = x_of(end_depth);
		stroke_position_marker(ctx, cx, y0, y1);

		let cur_score = node.stored_score();
		if (typeof cur_score === "number") {
			ctx.fillStyle = "#ffff99ff";
			ctx.beginPath();
			ctx.arc(cx, y_of(cur_score), 3, 0, 2 * Math.PI);
			ctx.fill();
		}

		ctx.fillStyle = "#ffff99ff";
		ctx.textAlign = cx > (x0 + x1) / 2 ? "right" : "left";
		ctx.textBaseline = "top";
		ctx.fillText(`#${node.depth}`, cx + (cx > (x0 + x1) / 2 ? -4 : 4), y0 + 2);
	},

	node_from_status_click: function(mousex) {

		if (!this.status_click_map) {
			return null;
		}

		let {x0, slot_w, domain_start, line_start_depth, end_depth, history} = this.status_click_map;

		let depth = Math.round(domain_start + (mousex - x0) / slot_w);
		if (depth < line_start_depth) depth = line_start_depth;
		if (depth > end_depth) depth = end_depth;

		let node = history[depth];
		if (!node || node.destroyed) {
			return null;
		}
		return node;
	},

	// ------------------------------------------------------------ eval history

	// How each candidate's value has moved during this position's search, so a
	// long search shows which moves are still "hot" and whether values settle.
	// x is the search's total visits: its real progress, whereas time depends on
	// the machine and whatever else shares the GPU. Values are for the player to
	// move (higher = better for them); every label converts back to "B+" / "W+"
	// form. The history belongs to the search that produced the displayed
	// analysis, so like that analysis it never regresses to a fresher search.

	hover_board_point: function(s) {
		let gtp = null;
		if (s && hub.node && !hub.node.destroyed) {
			gtp = hub.node.get_board().gtp(s);
		}
		if (gtp === this.history_board_hover) {
			return;
		}
		this.history_board_hover = gtp;
		if (this.visible_sections().includes("history")) {
			this.draw_history(hub.node);
		}
	},

	// The other way round: the mouse on a line's label follows that move here
	// and shows its continuation on the board, as hovering it there would.
	// Clicking a label pins it (until clicked again, a click off the labels,
	// or another position); the board mouse still takes over while it is there.

	history_label_at: function(x, y) {
		let hit = this.history_hits.find(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
		return hit ? hit.move : null;
	},

	hover_history_label: function(move) {
		this.history_canvas.style.cursor = move ? "pointer" : "";
		if (move !== this.history_label_hover) {
			this.history_label_hover = move;
			this.draw_history(hub.node);
		}
	},

	click_history_label: function(move) {
		let pinned = this.pinned_history_move(hub.node);
		this.history_pin = move && move !== pinned ? {node: hub.node, move} : null;
		this.draw_history(hub.node);
	},

	pinned_history_move: function(node) {
		return this.history_pin && this.history_pin.node === node ? this.history_pin.move : null;
	},

	history_data: function(node) {

		if (!node.has_valid_analysis() || node.analysis.moveInfos.length === 0) {
			return null;
		}
		let search_id = node.analysis.id;
		let search = eval_history.get(search_id);
		if (!search || search.times.length === 0) {
			return null;
		}

		let board = node.get_board();
		let sign = board.active === "b" ? 1 : -1;
		let candidates = board_candidates(node);
		let on_board = new Set(candidates.infos.map(info => info.move));
		eval_history.note_shown(search_id, on_board, node.analysis.rootInfo.visits);

		// Lines plot this search's own values; colours match the board, which
		// shows explored moves at their own search's value (explored.js).

		let merged = explored.node_infos(node);
		let infos = new Map(node.analysis.moveInfos.map(info => [info.move, info]));
		let shown_infos = new Map(merged.map(info => [info.move, info]));
		let best_lead = explored.best_info(node).scoreLead;

		let tags = Object.create(null);
		node.children.forEach((child, i) => {
			for (let key of ["B", "W"]) {
				for (let s of child.all_values(key)) {
					let gtp = typeof s === "string" && s.length === 2 ? board.gtp(s) : null;
					if (gtp && !tags[gtp]) {
						tags[gtp] = i === 0 ? "played" : "variation";
					}
				}
			}
		});

		// Every move drawn on the board at any point in this search keeps its
		// line; the chart draws those no longer on the board dashed.

		let lines = [...search.shown].map(move => {
			let info = infos.get(move) || null;
			let shown_info = shown_infos.get(move) || null;
			let cost = shown_info ? info_cost(shown_info, best_lead, sign > 0) : null;
			let now = info && typeof info.scoreLead === "number" ? sign * info.scoreLead : null;
			let points = eval_history.points(search, move, HISTORY_START_VISITS, config.candidate_min_visits)
				.map(p => ({x: p.root, v: sign * p.lead}));
			return {
				move,
				info,
				cost,
				points,
				on_board: on_board.has(move),
				tag: tags[move] || "",
				change: points.length > 0 && now !== null ? now - points[0].v : null,
				since: points.length > 0 ? points[0].x : null,
				colour: this.value_colour(cost === null ? candidates.scale : cost, candidates.scale),
			};
		});
		let cost_key = (line) => line.cost === null ? Infinity : line.cost;
		lines.sort((a, b) => (Number(b.on_board) - Number(a.on_board)) || (cost_key(a) - cost_key(b)));

		let explored_marks = merged.filter(info => {
			return info.explored && on_board.has(info.move) && typeof info.scoreLead === "number";
		}).map(info => {
			let cost = info_cost(info, best_lead, sign > 0);
			return {
				move: info.move,
				lead: info.scoreLead,
				v: sign * info.scoreLead,
				visits: info.visits,
				colour: this.value_colour(cost === null ? candidates.scale : cost, candidates.scale),
			};
		});

		return {
			search,
			lines,
			explored: explored_marks,
			sign,
			side: sign > 0 ? "Black" : "White",
			t_now: search.times[search.times.length - 1],
			root_visits: search.roots[search.roots.length - 1],
			live: Boolean(hub.engine.desired) && hub.engine.desired.id === search_id,
		};
	},

	history_x_scale: function(root_now, x0, x1) {
		let lo = HISTORY_START_VISITS;
		let hi = Math.max(lo * 10, root_now);
		if (config.move_report_history_xscale === "log") {
			let span = Math.log(hi / lo);
			return {log: true, lo, hi, x_of: n => x0 + (x1 - x0) * Math.log(Math.max(n, lo) / lo) / span};
		}
		return {log: false, lo: 0, hi, x_of: n => x0 + (x1 - x0) * n / hi};
	},

	fmt_axis_score: function(lead_bpov) {			// Compact axis label: "B+2.5", "W+1", "0"
		let abs = String(Number(Math.abs(lead_bpov).toFixed(2)));
		if (abs === "0") return "0";
		return lead_bpov > 0 ? `B+${abs}` : `W+${abs}`;
	},

	fmt_change: function(change) {					// For the player to move: ▲ = better now, ▼ = worse now.
		if (change === null) return null;
		if (Math.abs(change) < 0.005) return {text: "0.00", colour: "#ffffffff"};
		return change > 0
			? {text: `▲${change.toFixed(2)}`, colour: "#99ff99ff"}
			: {text: `▼${(-change).toFixed(2)}`, colour: "#ff9977ff"};
	},

	fmt_share: function(fraction) {					// Of the search's visits: "12%", "4.5%", "<0.1%"
		let pct = fraction * 100;
		if (pct >= 10) return `${pct.toFixed(0)}%`;
		if (pct >= 0.1) return `${pct.toFixed(1)}%`;
		return "<0.1%";
	},

	fmt_policy: function(prior) {					// Two significant figures however small: "12%", "0.35%", "0.0021%"
		let pct = prior * 100;
		if (pct >= 10) return `${pct.toFixed(0)}%`;
		if (!(pct > 0)) return "0%";
		return `${pct.toFixed(Math.max(1, 1 - Math.floor(Math.log10(pct))))}%`;
	},

	history_rank_text: function(search, move) {		// "#3 by visits (best #1)" or "#3 by visits (from #40)"
		let ranks = eval_history.visit_ranks(search, move, HISTORY_START_VISITS).map(r => r.rank);
		if (ranks.length === 0) return null;
		let now = ranks[ranks.length - 1];
		let best = Math.min(...ranks);
		let text = `#${now} by visits`;
		if (best < now) return `${text} (best #${best})`;
		if (ranks[0] > now) return `${text} (from #${ranks[0]})`;
		return text;
	},

	// The band's contents, as [text, type size, weight, colour]: what the
	// followed move has had and how it got here, else the legend. Most
	// telling first, since a narrow card drops pieces from the end; the line
	// itself already shows its change and where it starts.

	history_follow_pieces: function(data, focus_line, focus_mark) {
		let pieces = [];
		if (focus_mark) {
			pieces.push([focus_mark.move, "body", "bold", this.label_colour(focus_mark.colour)]);
			pieces.push([`■ ${this.fmt_score(focus_mark.lead)}`, "body", "bold", "#ffffffff"]);
			pieces.push(["explored", "ui", "bold", "#e0b872ff"]);
			pieces.push([`${this.fmt_visits(focus_mark.visits)} visits`, "ui", "", "#ffffffff"]);
			if (focus_line && focus_line.info) {
				pieces.push([`this search: ${this.fmt_score(focus_line.info.scoreLead)} on ${this.fmt_visits(focus_line.info.visits)}`, "ui", "", "#ffffffff"]);
			}
			return pieces;
		}
		let info = focus_line.info;
		pieces.push([focus_line.move, "body", "bold", this.label_colour(focus_line.colour)]);
		if (info) {
			pieces.push([this.fmt_score(info.scoreLead), "body", "bold", "#ffffffff"]);
		}
		if (focus_line.tag) {
			pieces.push([focus_line.tag, "ui", "bold", "#e0b872ff"]);
		}
		if (info) {
			pieces.push([`${this.fmt_visits(info.visits)} visits (${this.fmt_share(info.visits / data.root_visits)})`, "ui", "bold", "#ffffffff"]);
		}
		if (info && typeof info.prior === "number") {
			pieces.push([`policy ${this.fmt_policy(info.prior)}`, "ui", "", "#ffffffff"]);
		}
		let rank = this.history_rank_text(data.search, focus_line.move);
		if (rank) {
			pieces.push([rank, "ui", "", "#ffffffff"]);
		}
		let first = eval_history.first_seen(data.search, focus_line.move);
		if (first !== null && first >= HISTORY_START_VISITS && first > data.search.roots[0]) {
			pieces.push([`first searched at ${eval_history.fmt_count(first)}`, "ui", "", "#ffffffff"]);
		}
		let change = this.fmt_change(focus_line.change);
		if (change) {
			pieces.push([`${change.text} since ${eval_history.fmt_count(focus_line.since)}`, "ui", "bold", change.colour]);
		}
		if (!focus_line.on_board) {
			pieces.push(["no longer on the board", "ui", "", "#ffffffff"]);
		}
		return pieces;
	},

	history_legend_pieces: function(data, lines, explored_marks) {
		let pieces = [[`↑ better for ${data.side} (to play)`, "caption", "", "#ffffffff"]];
		if (lines.some(line => !line.on_board)) {
			pieces.push(["dashed: no longer on the board", "caption", "", "#ffffffff"]);
		}
		if (explored_marks.length > 0) {
			pieces.push(["■ explored: search after the move", "caption", "", "#ffffffff"]);
		}
		return pieces;
	},

	label_colour: function(colour) {				// A gradient colour lifted toward white, so text in it stays legible on the dark chart.
		let channel = (i) => {
			let c = parseInt(colour.slice(i, i + 2), 16);
			return Math.round(c + (255 - c) * 0.4).toString(16).padStart(2, "0");
		};
		return `#${channel(1)}${channel(3)}${channel(5)}ff`;
	},

	draw_history: function(node) {
		if (!node || node.destroyed) {
			return;
		}
		if (this.history_pin && this.history_pin.node !== node) {
			this.history_pin = null;
		}

		// The board shows the label under the mouse, else the pinned one.

		let shown = this.history_label_hover || this.pinned_history_move(node);
		hub.show_chart_point(shown ? node.get_board().parse_gtp_move(shown) || null : null);

		let data = this.history_data(node);
		let status = data ? `${data.live ? "" : "stopped · "}${this.fmt_visits(data.root_visits)} visits · ${eval_history.fmt_time(data.t_now)}` : "";
		if (this.history_status.textContent !== status) {
			this.history_status.textContent = status;
		}

		if (!this.size_canvas(this.history_canvas)) return;
		this.history_ctx.clearRect(0, 0, this.history_canvas.width, this.history_canvas.height);
		this.draw_history_chart(data, this.history_label_hover || this.history_board_hover || this.pinned_history_move(node), this.pinned_history_move(node));
	},

	draw_history_chart: function(data, focus, pinned) {

		let canvas = this.history_canvas;
		let ctx = this.history_ctx;
		let cap = type_scale.px("caption");
		let x0 = chart_pads().left;
		let x1 = canvas.width - Math.round(cap * 4.2);			// Room for move names at the line ends.
		let y0 = Math.round(cap * 0.7);							// Room for the top value label.
		let y1 = canvas.height - chart_pads().bottom;

		this.history_hits = [];

		if (x1 - x0 < 60 || y1 - y0 < 30) {
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		let drawable = data ? data.lines.filter(line => line.points.length > 0) : [];
		let focus_line = focus ? drawable.find(line => line.move === focus) || null : null;
		let explored_marks = data ? data.explored : [];
		let focus_mark = focus ? explored_marks.find(mark => mark.move === focus) || null : null;
		let following = Boolean(focus_line || focus_mark);
		let lines = drawable.slice(0, HISTORY_LINES);
		for (let extra of [focus_line, ...drawable.filter(line => line.tag)]) {
			if (extra && !lines.includes(extra)) {
				lines.push(extra);
			}
		}

		if (!data || lines.length === 0) {
			ctx.font = type_scale.canvas_font("ui");
			ctx.fillStyle = "#ffffffff";
			ctx.textAlign = "left";
			ctx.fillText(!data
				? (hub.engine.desired ? "analysing…" : "no search of this position yet (press Space)")
				: `values appear after ${eval_history.fmt_count(HISTORY_START_VISITS)} visits, once a move has ${config.candidate_min_visits} visits…`, x0 + 8, (y0 + y1) / 2);
			return;
		}

		// Scales. The value range covers every line and explored move, at least
		// one point tall.

		let xs = this.history_x_scale(data.root_visits, x0, x1);
		let v_lo = Infinity;
		let v_hi = -Infinity;
		for (let line of lines) {
			for (let p of line.points) {
				v_lo = Math.min(v_lo, p.v);
				v_hi = Math.max(v_hi, p.v);
			}
		}
		for (let mark of explored_marks) {
			v_lo = Math.min(v_lo, mark.v);
			v_hi = Math.max(v_hi, mark.v);
		}
		if (v_hi - v_lo < 1) {
			let mid = (v_hi + v_lo) / 2;
			v_lo = mid - 0.5;
			v_hi = mid + 0.5;
		}
		let pad = (v_hi - v_lo) * 0.08;
		v_lo -= pad;
		v_hi += pad;
		let y_of = (v) => y1 - (y1 - y0) * (v - v_lo) / (v_hi - v_lo);

		let raw_step = (v_hi - v_lo) / 4;
		let mag = Math.pow(10, Math.floor(Math.log10(raw_step)));
		let step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw_step);

		ctx.font = type_scale.canvas_font("caption");
		ctx.lineWidth = 1;
		for (let i = Math.ceil(v_lo / step); i * step <= v_hi + 1e-9; i++) {
			let v = i * step;
			let y = Math.round(y_of(v)) + 0.5;
			ctx.strokeStyle = i === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.textBaseline = "middle";
			ctx.fillText(this.fmt_axis_score(data.sign * v), x0 - 5, y);
		}

		let ticks = eval_history.visit_ticks(xs.lo, xs.hi, xs.log, Math.max(2, Math.floor((x1 - x0) / (cap * 4))));
		let last_right = -Infinity;
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (let n of ticks) {
			let x = Math.round(xs.x_of(n)) + 0.5;
			ctx.strokeStyle = "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x, y0);
			ctx.lineTo(x, y1);
			ctx.stroke();
			let label = eval_history.fmt_count(n);
			let w = ctx.measureText(label).width;
			if (x - w / 2 > last_right + 6) {
				ctx.fillStyle = "#e0b872ff";
				ctx.fillText(label, x, y1 + 5);
				last_right = x + w / 2;
			}
		}

		// A band across the top of the plot holds the followed move's numbers,
		// else the legend. No label is ever placed in it, so following a move
		// never moves a label (out from under the mouse, say). On a narrow card
		// the numbers wrap to a second row over the plot, and then stop.

		let band = {x0: x0 + 1, y0: y0 + 1, x1: x1 - 1, y1: y0 + 1 + Math.round(type_scale.px("body") * 1.5)};
		let pieces = focus_line || focus_mark
			? this.history_follow_pieces(data, focus_line, focus_mark)
			: this.history_legend_pieces(data, lines, explored_marks);
		let rows = [[]];
		let gap = Math.round(cap * 0.9);
		let bx = band.x0 + 5;
		for (let [text, size, weight, colour] of pieces) {
			ctx.font = type_scale.canvas_font(size, weight);
			let w = ctx.measureText(text).width;
			if (bx + w > band.x1 - 5 && rows[rows.length - 1].length > 0) {
				if (rows.length === 2) {
					break;
				}
				rows.push([]);
				bx = band.x0 + 5;
			}
			if (bx + w > band.x1 - 5) {
				break;
			}
			rows[rows.length - 1].push({text, font: ctx.font, colour, x: bx, w});
			bx += w + gap;
		}
		let row_h = band.y1 - band.y0;
		let band_rows = rows.filter(row => row.length > 0).map((row, i) => ({
			row,
			x0: band.x0,
			y0: band.y0 + i * row_h,
			x1: Math.min(band.x1, row[row.length - 1].x + row[row.length - 1].w + 5),
			y1: band.y0 + (i + 1) * row_h,
		}));
		let obstacles = [band];
		let overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

		stroke_position_marker(ctx, Math.round(xs.x_of(data.root_visits)) + 0.5, y0, y1);

		// Lines in their board colours. Moves that have left the board recede
		// (thin, dashed, translucent); a followed move is drawn on top, thick,
		// with the others faded behind it.

		let geometry = new Map(lines.map(line => [line, {
			px: line.points.map(p => xs.x_of(p.x)),
			py: line.points.map(p => y_of(p.v)),
		}]));

		let stroke_line = (line, width, alpha) => {
			let g = geometry.get(line);
			ctx.globalAlpha = alpha;
			ctx.strokeStyle = line.colour;
			ctx.fillStyle = line.colour;
			ctx.lineWidth = width;
			ctx.lineJoin = "round";
			ctx.setLineDash(line.on_board ? [] : [7, 5]);
			ctx.beginPath();
			g.px.forEach((x, i) => {
				if (i === 0) {
					ctx.moveTo(x, g.py[i]);
				} else {
					ctx.lineTo(x, g.py[i]);
				}
			});
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.beginPath();
			ctx.arc(g.px[g.px.length - 1], g.py[g.py.length - 1], width + 1, 0, 2 * Math.PI);
			ctx.fill();
			ctx.globalAlpha = 1;
		};

		for (let line of lines) {
			if (line !== focus_line) {
				stroke_line(line, line.on_board ? 2 : 1.5, following ? 0.3 : line.on_board ? 1 : 0.6);
			}
		}
		if (focus_line) {
			stroke_line(focus_line, 4, 1);
		}

		// Explored moves: their own search's value, as a square (their board
		// shape) just right of the current visits, since it is not a point in
		// this search. A move that also has a line gets a dotted link from that
		// line's end instead of a second label.

		let x_explored = xs.x_of(data.root_visits) + cap * 0.6 + 6;
		let squares = explored_marks.map(mark => {
			let r = mark === focus_mark ? cap * 0.6 : cap * 0.45;
			let y = y_of(mark.v);
			let line = lines.find(l => l.move === mark.move);
			return {mark, x: x_explored, y, r, end: line ? geometry.get(line) : null};
		});
		for (let d of squares) {
			ctx.globalAlpha = !following || d.mark === focus_mark ? 1 : 0.3;
			if (d.end) {
				ctx.strokeStyle = d.mark.colour;
				ctx.lineWidth = d.mark === focus_mark ? 2.5 : 2;
				ctx.setLineDash([3, 3]);
				ctx.beginPath();
				ctx.moveTo(d.end.px[d.end.px.length - 1], d.end.py[d.end.py.length - 1]);
				ctx.lineTo(d.x, d.y);
				ctx.stroke();
				ctx.setLineDash([]);
			}
			ctx.beginPath();
			ctx.roundRect(d.x - d.r, d.y - d.r, 2 * d.r, 2 * d.r, d.r * 0.4);
			ctx.fillStyle = d.mark.colour;
			ctx.fill();
			ctx.lineWidth = 1.5;
			ctx.strokeStyle = "#ffffffff";
			ctx.stroke();
			ctx.globalAlpha = 1;
			let room = cap * 0.6 + 1;							// The followed size, so following never moves a label.
			obstacles.push({x0: d.x - room, y0: d.y - room, x1: d.x + room, y1: d.y + room});
			this.history_hits.push({move: d.mark.move, x0: d.x - room, y0: d.y - room, x1: d.x + room, y1: d.y + room});
		}
		let unlabelled = squares.filter(d => !d.end);

		// Every line is named: at its end where there is room, else on the line
		// itself, else beside the end with a leader. Placed in a fixed order,
		// before anything that depends on what is followed.

		ctx.font = type_scale.canvas_font("caption", "bold");
		let specs = lines.map(line => Object.assign({w: ctx.measureText(line.move).width + 8, h: cap + 6}, geometry.get(line)));
		let mark_specs = unlabelled.map(d => ({w: ctx.measureText(d.mark.move).width + 8, h: cap + 6, px: [d.x + cap * 0.6], py: [d.y]}));
		let placements = eval_history.place_line_labels(specs.concat(mark_specs), obstacles, {x0: x0 + 1, y0: y0 + 1, x1: canvas.width - 1, y1: y1 - 1});
		let label_box = (p, spec) => ({x0: p.x - spec.w / 2, y0: p.y - spec.h / 2, x1: p.x + spec.w / 2, y1: p.y + spec.h / 2});
		lines.forEach((line, i) => {
			obstacles.push(label_box(placements[i], specs[i]));
			this.history_hits.push(Object.assign({move: line.move}, label_box(placements[i], specs[i])));
		});
		unlabelled.forEach((d, k) => {
			obstacles.push(label_box(placements[lines.length + k], mark_specs[k]));
			this.history_hits.push(Object.assign({move: d.mark.move}, label_box(placements[lines.length + k], mark_specs[k])));
		});

		// "After 10k visits it said...": the followed move's value at each tick.

		let annotations = [];
		obstacles.push(...band_rows.slice(1));
		if (focus_line) {
			ctx.font = type_scale.canvas_font("caption", "bold");
			let points = focus_line.points;
			let first_x = points[0].x;
			let last_x = points[points.length - 1].x;
			let apart = (n) => xs.x_of(last_x) - xs.x_of(n) > cap * 4;			// A tick right by the latest value would only repeat it.
			for (let n of [last_x, ...ticks.filter(n => n >= first_x && n < last_x && apart(n))]) {		// The latest value claims its place first.
				let p = eval_history.value_at(points, n);
				if (!p) continue;
				let text = this.fmt_score(data.sign * p.v);
				let w = ctx.measureText(text).width;
				let x = xs.x_of(n);
				let y = y_of(p.v);
				let cx = Math.min(x1 - w / 2, Math.max(x0 + w / 2, x));
				let above = y - 6 - cap / 2;
				let below = y + 6 + cap / 2;
				for (let ty of (y - y0 > cap * 1.6 ? [above, below] : [below, above])) {
					let box = {x0: cx - w / 2 - 2, y0: ty - cap / 2 - 1, x1: cx + w / 2 + 2, y1: ty + cap / 2 + 1};
					if (box.y0 >= y0 && box.y1 <= y1 && !obstacles.some(b => overlaps(box, b))) {
						annotations.push({x, y, text, cx, ty, box});
						obstacles.push(box);
						break;
					}
				}
			}
		}

		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		for (let box of band_rows) {
			ctx.fillStyle = "#181818e6";
			ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
			for (let piece of box.row) {
				ctx.font = piece.font;
				ctx.fillStyle = piece.colour;
				ctx.fillText(piece.text, piece.x, (box.y0 + box.y1) / 2);
			}
		}

		ctx.font = type_scale.canvas_font("caption", "bold");
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		let outline_pin = (move, box) => {
			if (move === pinned) {
				ctx.strokeStyle = "#ffffffff";
				ctx.lineWidth = 1.5;
				ctx.strokeRect(box.x0 - 0.5, box.y0 - 0.5, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1);
			}
		};
		unlabelled.forEach((d, k) => {
			let p = placements[lines.length + k];
			let spec = mark_specs[k];
			ctx.globalAlpha = !following || d.mark === focus_mark ? 1 : 0.55;
			if (p.kind !== "end") {
				ctx.fillStyle = "#181818e6";
				ctx.fillRect(p.x - spec.w / 2, p.y - spec.h / 2, spec.w, spec.h);
			}
			if (p.kind === "leader") {
				ctx.strokeStyle = d.mark.colour;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(spec.px[0], spec.py[0]);
				ctx.lineTo(p.x - spec.w / 2, p.y);
				ctx.stroke();
			}
			ctx.fillStyle = this.label_colour(d.mark.colour);
			ctx.fillText(d.mark.move, p.x, p.y);
			ctx.globalAlpha = 1;
			outline_pin(d.mark.move, label_box(p, spec));
		});
		lines.forEach((line, i) => {
			let p = placements[i];
			let spec = specs[i];
			ctx.globalAlpha = line === focus_line ? 1 : following ? 0.55 : line.on_board ? 1 : 0.75;
			if (p.kind !== "end") {
				ctx.fillStyle = "#181818e6";
				ctx.fillRect(p.x - spec.w / 2, p.y - spec.h / 2, spec.w, spec.h);
			}
			if (p.kind === "leader") {
				ctx.strokeStyle = line.colour;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(spec.px[spec.px.length - 1], spec.py[spec.py.length - 1]);
				ctx.lineTo(p.x - spec.w / 2, p.y);
				ctx.stroke();
			}
			ctx.fillStyle = this.label_colour(line.colour);
			ctx.fillText(line.move, p.x, p.y);
			ctx.globalAlpha = 1;
			outline_pin(line.move, label_box(p, spec));
		});

		ctx.font = type_scale.canvas_font("caption", "bold");
		for (let a of annotations) {
			ctx.fillStyle = "#ffffffff";
			ctx.beginPath();
			ctx.arc(a.x, a.y, 3.5, 0, 2 * Math.PI);
			ctx.fill();
			ctx.fillText(a.text, a.cx, a.ty);
		}
	},

};

module.exports = init();
