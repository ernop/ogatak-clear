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
//   - Three chart concepts, never conflated: "quality" (per-move bars: how
//     well each move was played), "status" (who was winning), and "distribution"
//     (current candidate moves by points worse than best). Position width is a
//     separate count series overlaid on quality; its blue candidate spray shows
//     the underlying historical move values without changing the quality axis.
//
// The panel is made of named sections. Their order and visibility live in
// config.move_report_sections; sizes live in config.move_report_font_size /
// _width / _chart_height. All are adjustable live from the controls the panel
// itself renders, and every change is saved to config.json immediately.

const config_io = require("./config_io");
const colour_gradients = require("./colour_gradients");
const {info_cost, safe_html} = require("./utils");

const SECTION_TITLES = {
	quality:  "MOVE QUALITY",
	status:   "GAME STATUS",
	distribution: "MOVE VALUE DISTRIBUTION",
	turn:     "TURN",
	lastmove: "LAST MOVE",
	outcome:  "OUTCOME",
	options:  "NEXT MOVE OPTIONS",
	comments: "COMMENTS",
};

const ALL_SECTIONS = Object.keys(SECTION_TITLES);
const CHART_SECTIONS = ["quality", "status", "distribution"];
const YSCALE_SECTIONS = ["quality", "status"];
const HTML_SECTIONS = ["turn", "lastmove", "outcome", "options"];		// Rendered via html_* methods; "comments" hosts the stock textarea instead.

const VERDICTS = [
	// [max points lost (exclusive), label, colour]
	[0.5, "EXCELLENT",  "#99ff99ff"],
	[1.5, "GOOD",       "#ccee99ff"],
	[3.0, "INACCURACY", "#ffff66ff"],
	[6.0, "MISTAKE",    "#ffaa44ff"],
	[Infinity, "BLUNDER", "#ff5555ff"],
];

// Candidate colours come from colour_gradients.js (Display → Gradient).

const LIMITS = {
	move_report_font_size:    {min: 9,   max: 28,   step: 1},
	move_report_width:        {min: 320, max: 1280, step: 40},
	move_report_chart_height: {min: 90,  max: 400,  step: 20},
	move_report_distribution_top_n: {min: 1, max: 1000, step: 1},
	move_report_width_spray_top_n: {min: 1, max: 50, step: 1},
	move_report_quality_window_n: {min: 1, max: 1000, step: 1},
	move_report_status_window_n: {min: 1, max: 1000, step: 1},
};

const CHART_PAD_LEFT = 44;			// Room for y-axis labels.
const CHART_PAD_RIGHT = 10;
const CHART_PAD_TOP = 14;
const CHART_PAD_BOTTOM = 20;		// Room for x-axis labels.
const CHART_MIN_DEPTH = 20;			// Both charts keep this many x slots so early games aren't stretched.
const DISTRIBUTION_BUCKET_COUNT = 10;
const WIDTH_SPRAY_CLUSTER_PX = 10;
const WIDTH_SPRAY_LABEL_WIDTH = 64;

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
	return {
		x0: CHART_PAD_LEFT,
		x1: canvas.width - CHART_PAD_RIGHT,
		y0: CHART_PAD_TOP,
		y1: canvas.height - CHART_PAD_BOTTOM,
	};
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

	// Build the skeleton: a controls bar, then one box per section. Sections are
	// reordered via flexbox "order", so the DOM (and the canvases) stays stable...

	let parts = [];

	parts.push(`<div id="mr_game_identity"></div>`);
	parts.push(`<div id="mr_controls">`);
	parts.push(`<span class="mr_ctlgroup">text <span class="mr_ctl" data-act="font_down">–</span><span class="mr_ctl" data-act="font_up">+</span></span>`);
	parts.push(`<span class="mr_ctlgroup">width <span class="mr_ctl" data-act="width_down">–</span><span class="mr_ctl" data-act="width_up">+</span></span>`);
	parts.push(`<span class="mr_ctlgroup">chart <span class="mr_ctl" data-act="chart_down">–</span><span class="mr_ctl" data-act="chart_up">+</span></span>`);
	parts.push(`<span id="mr_hidden_chips"></span>`);
	parts.push(`</div>`);

	parts.push(`<div id="mr_inner">`);
	for (let sec of ALL_SECTIONS) {
		parts.push(`<div class="mr_secbox" id="mr_secbox_${sec}">`);
		parts.push(`<div class="mr_sechead">`);
		parts.push(`<span class="mr_sectitle">${SECTION_TITLES[sec]}</span>`);
		parts.push(`<span class="mr_secctls">`);
		if (YSCALE_SECTIONS.includes(sec)) {
			parts.push(`<span class="mr_secctl" id="mr_yscale_ctl_${sec}" data-sec="${sec}" data-act="yscale" title="Toggle linear / log2 y scale">lin</span>`);
			parts.push(`<span class="mr_secctl" id="mr_window_ctl_${sec}" data-sec="${sec}" data-act="window" title="Toggle full history / sliding window">full</span>`);
			parts.push(`<label class="mr_metric" title="Moves retained when sliding window is enabled">last <input id="mr_window_n_${sec}" type="number" min="1" max="1000" step="1"></label>`);
		}
		if (sec === "quality") {
			parts.push(`<label class="mr_metric" title="Engine-ranked candidate values drawn per historical position">spray <input id="mr_width_spray_top_n" type="number" min="1" max="50" step="1"></label>`);
		}
		if (sec === "distribution") {
			parts.push(`<label class="mr_metric" title="Use only the engine-ranked top N moves">top <input id="mr_distribution_top_n" type="number" min="1" max="1000" step="1"></label>`);
		}
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="up" title="Move section up">▲</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="down" title="Move section down">▼</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="hide" title="Hide section">✕</span>`);
		parts.push(`</span>`);
		parts.push(`</div>`);
		if (CHART_SECTIONS.includes(sec)) {
			parts.push(`<div class="mr_seccontent"><canvas class="mr_chartcanvas" id="mr_canvas_${sec}"></canvas></div>`);
			parts.push(`<div class="mr_width_drag" title="Drag to resize all sections"></div>`);
		} else {
			parts.push(`<div class="mr_seccontent" id="mr_seccontent_${sec}"></div>`);
		}
		parts.push(`</div>`);
	}
	parts.push(`</div>`);

	outer.innerHTML = parts.join("\n");

	// Adopt the stock comments textarea into our comments section. It keeps its
	// id, so comment_drawer and the input handlers keep working untouched.

	document.getElementById("mr_seccontent_comments").appendChild(document.getElementById("comments"));

	let ret = Object.assign(Object.create(move_report_prototype), {

		outer: outer,
		inner: document.getElementById("mr_inner"),
		chips: document.getElementById("mr_hidden_chips"),
		game_identity: document.getElementById("mr_game_identity"),

		quality_canvas: document.getElementById("mr_canvas_quality"),
		quality_ctx: document.getElementById("mr_canvas_quality").getContext("2d"),
		status_canvas: document.getElementById("mr_canvas_status"),
		status_ctx: document.getElementById("mr_canvas_status").getContext("2d"),
		distribution_canvas: document.getElementById("mr_canvas_distribution"),
		distribution_ctx: document.getElementById("mr_canvas_distribution").getContext("2d"),

		content_cache: {},			// section name --> last html set
		chips_cache: "",
		quality_click_map: null,	// Chart geometries for click-to-navigate.
		quality_hover_depth: null,
		status_click_map: null,
		distribution_hover_map: null,

	});

	outer.addEventListener("mousedown", (event) => {

		let width_drag = event.target.closest(".mr_width_drag");
		if (width_drag) {
			event.preventDefault();
			ret.start_width_drag(event);
			return;
		}

		let ctl = event.target.closest(".mr_ctl");
		if (ctl) {
			event.preventDefault();
			ret.adjust(ctl.dataset.act);
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
			ret.section_action(chip.dataset.sec, "show");
			return;
		}

		let tr = event.target.closest("tr[data-gtp]");
		if (tr) {
			event.preventDefault();
			let s = hub.node.get_board().parse_gtp_move(tr.dataset.gtp);
			if (s) {
				hub.try_move(s);
			}
			return;
		}
	});

	document.getElementById("mr_distribution_top_n").addEventListener("change", (event) => {
		ret.set_distribution_top_n(event.target.value);
	});

	document.getElementById("mr_width_spray_top_n").addEventListener("input", (event) => {
		ret.set_width_spray_top_n(event.target.value, false);
	});

	document.getElementById("mr_width_spray_top_n").addEventListener("change", (event) => {
		ret.set_width_spray_top_n(event.target.value, true);
	});

	for (let sec of YSCALE_SECTIONS) {
		let input = document.getElementById(`mr_window_n_${sec}`);
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
		if (depth !== ret.quality_hover_depth) {
			ret.quality_hover_depth = depth;
			ret.draw_quality(hub.node);
		}
		ret.quality_canvas.title = ret.quality_spray_title(depth);
	});

	ret.quality_canvas.addEventListener("mouseleave", () => {
		if (ret.quality_hover_depth !== null) {
			ret.quality_hover_depth = null;
			ret.draw_quality(hub.node);
		}
		ret.quality_canvas.title = "";
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

	// Canvas backing dimensions do not follow CSS layout automatically. Observe
	// the chart containers so window resize, maximize, zoom, and flex reflow all
	// redraw at their final widths.

	ret.observed_chart_widths = [];
	ret.resize_frame = null;
	ret.resize_observer = new ResizeObserver(() => {
		let widths = [
			ret.quality_canvas,
			ret.status_canvas,
			ret.distribution_canvas,
		].map(canvas => canvas.parentElement.clientWidth);

		if (widths.every((width, i) => width === ret.observed_chart_widths[i])) {
			return;
		}
		ret.observed_chart_widths = widths;
		if (ret.resize_frame !== null) {
			cancelAnimationFrame(ret.resize_frame);
		}
		ret.resize_frame = requestAnimationFrame(() => {
			ret.resize_frame = null;
			if (hub.node && !hub.node.destroyed) {
				ret.draw(hub.node);
			}
		});
	});

	for (let canvas of [ret.quality_canvas, ret.status_canvas, ret.distribution_canvas]) {
		ret.resize_observer.observe(canvas.parentElement);
	}

	return ret;
}

let move_report_prototype = {

	// ------------------------------------------------------------ live adjustment

	visible_sections: function() {

		// Validate what's in the config (it's user-editable) without silently
		// rewriting the file; invalid entries just don't display.

		let arr = config.move_report_sections;
		if (!Array.isArray(arr)) {
			return Array.from(ALL_SECTIONS);
		}
		return arr.filter((sec, i) => ALL_SECTIONS.includes(sec) && arr.indexOf(sec) === i);
	},

	adjust: function(act) {

		let [key, dir] = {
			font_down:  ["move_report_font_size",    -1],
			font_up:    ["move_report_font_size",    +1],
			width_down: ["move_report_width",        -1],
			width_up:   ["move_report_width",        +1],
			chart_down: ["move_report_chart_height", -1],
			chart_up:   ["move_report_chart_height", +1],
		}[act];

		let lim = LIMITS[key];
		let val = config[key] + (dir * lim.step);
		config[key] = Math.max(lim.min, Math.min(lim.max, val));

		config_io.save();
		this.draw(hub.node);
	},

	start_width_drag: function(event) {

		let start_x = event.clientX;
		let start_width = config.move_report_width;
		let lim = LIMITS.move_report_width;

		let move = (move_event) => {
			let width = Math.round(start_width + move_event.clientX - start_x);
			config.move_report_width = Math.max(lim.min, Math.min(lim.max, width));
			this.draw(hub.node);
		};

		let end = () => {
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", end);
			document.documentElement.classList.remove("mr_resizing");
			config_io.save();
		};

		document.documentElement.classList.add("mr_resizing");
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", end);
	},

	set_distribution_top_n: function(raw_value) {

		let value = Number(raw_value);
		let lim = LIMITS.move_report_distribution_top_n;
		let input = document.getElementById("mr_distribution_top_n");

		if (!Number.isInteger(value) || value < lim.min || value > lim.max) {
			input.setCustomValidity(`Enter a whole number from ${lim.min} to ${lim.max}.`);
			input.reportValidity();
			return;
		}

		input.setCustomValidity("");
		config.move_report_distribution_top_n = value;
		config_io.save();
		this.draw(hub.node);
	},

	set_width_spray_top_n: function(raw_value, report_invalid) {

		let value = Number(raw_value);
		let lim = LIMITS.move_report_width_spray_top_n;
		let input = document.getElementById("mr_width_spray_top_n");

		if (!Number.isInteger(value) || value < lim.min || value > lim.max) {
			if (report_invalid) {
				input.setCustomValidity(`Enter a whole number from ${lim.min} to ${lim.max}.`);
				input.reportValidity();
			}
			return;
		}

		input.setCustomValidity("");
		if (config.move_report_width_spray_top_n === value) {
			return;
		}
		config.move_report_width_spray_top_n = value;
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
		let input = document.getElementById(`mr_window_n_${sec}`);

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

	section_action: function(sec, act) {

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

		let visible = this.visible_sections();
		let i = visible.indexOf(sec);

		if (act === "up" && i > 0) {
			[visible[i - 1], visible[i]] = [visible[i], visible[i - 1]];
		} else if (act === "down" && i >= 0 && i < visible.length - 1) {
			[visible[i], visible[i + 1]] = [visible[i + 1], visible[i]];
		} else if (act === "hide" && i >= 0) {
			visible.splice(i, 1);
		} else if (act === "show" && i === -1 && ALL_SECTIONS.includes(sec)) {
			visible.push(sec);
		}

		config.move_report_sections = visible;
		config_io.save();
		this.draw(hub.node);
	},

	apply_layout: function() {

		this.outer.style.fontSize = config.move_report_font_size.toString() + "px";

		let visible = this.visible_sections();

		for (let sec of ALL_SECTIONS) {
			let box = document.getElementById(`mr_secbox_${sec}`);
			let i = visible.indexOf(sec);
			box.style.display = (i === -1) ? "none" : "";
			box.style.order = i.toString();
			box.style.width = "";
			box.style.flex = `1 1 ${config.move_report_width}px`;		// Preferred wrap width; the final row expands to fill the panel.
		}

		let chips = ALL_SECTIONS
			.filter(sec => !visible.includes(sec))
			.map(sec => `<span class="mr_chip" data-sec="${sec}" title="Show section">+ ${SECTION_TITLES[sec].toLowerCase()}</span>`)
			.join(" ");

		if (chips !== this.chips_cache) {
			this.chips.innerHTML = chips;
			this.chips_cache = chips;
		}

		for (let sec of YSCALE_SECTIONS) {
			let label = config[`move_report_${sec}_yscale`] === "log2" ? "log₂" : "lin";
			let control = document.getElementById(`mr_yscale_ctl_${sec}`);
			if (control.textContent !== label) {
				control.textContent = label;
			}

			let windowed = config[`move_report_${sec}_windowed`];
			if (typeof windowed !== "boolean") {
				throw new Error(`apply_layout(): move_report_${sec}_windowed must be boolean`);
			}
			let window_control = document.getElementById(`mr_window_ctl_${sec}`);
			let window_label = windowed ? "window" : "full";
			if (window_control.textContent !== window_label) {
				window_control.textContent = window_label;
			}

			let window_input = document.getElementById(`mr_window_n_${sec}`);
			let window_n = config[`move_report_${sec}_window_n`];
			if (document.activeElement !== window_input &&
				window_input.value !== window_n.toString()) {
				window_input.value = window_n.toString();
			}
		}

		let top_n_input = document.getElementById("mr_distribution_top_n");
		if (document.activeElement !== top_n_input &&
			top_n_input.value !== config.move_report_distribution_top_n.toString()) {
			top_n_input.value = config.move_report_distribution_top_n.toString();
		}

		let spray_top_n_input = document.getElementById("mr_width_spray_top_n");
		if (document.activeElement !== spray_top_n_input &&
			spray_top_n_input.value !== config.move_report_width_spray_top_n.toString()) {
			spray_top_n_input.value = config.move_report_width_spray_top_n.toString();
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
		if (typeof v !== "number") return "?";
		if (v >= 100000) return `${(v / 1000).toFixed(0)}k`;
		if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
		return v.toString();
	},

	verdict: function(points_lost) {				// --> [label, colour]
		for (let [max, label, colour] of VERDICTS) {
			if (points_lost < max) {
				return [label, colour];
			}
		}
	},

	value_colour: function(cost, cap) {				// cost 0 --> gradient start, cost >= cap --> end
		return colour_gradients.colour_for_cost(config.candidate_gradient, cost, cap);
	},

	candidate_costs: function(node, limit = null) {

		if (!node.has_valid_analysis() || node.analysis.moveInfos.length === 0) {
			return [];
		}

		let infos = limit === null
			? node.analysis.moveInfos
			: node.analysis.moveInfos.slice(0, limit);
		let best_lead = node.analysis.moveInfos[0].scoreLead;
		let active_is_b = node.get_board().active === "b";

		return infos.map(info => {
			return {info, cost: info_cost(info, best_lead, active_is_b)};
		});
	},

	// Signed points change caused by the move leading into this node, from the
	// MOVER's side: negative = the move lost points vs best play, positive = the
	// position turned out better than the prior estimate. Root scores assume
	// best play, so (child - parent) from the mover's side is exactly this.
	// Works from stored SGF tags too. Returns null if unknowable.

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

		for (let sec of visible) {
			if (sec === "quality") {
				this.draw_quality(node);
			} else if (sec === "status") {
				this.draw_status(node);
			} else if (sec === "distribution") {
				this.draw_distribution(node);
			} else if (HTML_SECTIONS.includes(sec)) {
				let html = this[`html_${sec}`](node);
				if (html !== this.content_cache[sec]) {
					document.getElementById(`mr_seccontent_${sec}`).innerHTML = html;
					this.content_cache[sec] = html;
				}
			}
			// "comments" needs no drawing here: comment_drawer owns the textarea inside it.
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

				let [label, colour] = this.verdict(lost);
				let lost_str = lost < 0.005 ? "as good as the engine's best" : `lost ${lost.toFixed(2)} pts vs best`;
				parts.push(`<div class="mr_verdict" style="color: ${colour}">${label}</div>`);

				// Where was the best move, and how far away did the mover play?

				let best_detail = "";
				if (node.parent.has_valid_analysis() && node.parent.analysis.moveInfos.length > 0) {
					let best_gtp = node.parent.analysis.moveInfos[0].move;
					let best_s = board.parse_gtp_move(best_gtp);
					let played_c = node.parent.canonical_symmetry(s);
					if (best_s !== "" && s !== "" && gtp !== "pass") {
						if (best_s === played_c || best_s === s) {
							best_detail = `played the engine's top choice`;
						} else {
							let dx = Math.abs(best_s.charCodeAt(0) - s.charCodeAt(0));
							let dy = Math.abs(best_s.charCodeAt(1) - s.charCodeAt(1));
							let dist = Math.max(dx, dy);
							best_detail = `best was <span class="mr_coord">${best_gtp}</span> (${dist} ${dist === 1 ? "line" : "lines"} away)`;
						}
					} else if (best_gtp === "pass" && gtp === "pass") {
						best_detail = `played the engine's top choice`;
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

	html_options: function(node) {

		let parts = [];

		if (node.has_valid_analysis()) {

			// Costs are vs the best AVAILABLE move (infos[0]), never vs the
			// global board value: if we're losing badly, the best we can do
			// from here is the reference point (PRODUCT.md rule 5)...

			let candidates = this.candidate_costs(node, 6);
			let infos = candidates.map(candidate => candidate.info);
			let costs = candidates.map(candidate => candidate.cost);

			// Gradient cap: worst displayed cost, floored at 2 pts so near-equal
			// options stay near-equal in color (PRODUCT.md rule 6)...

			let cap = Math.max(2, ...costs.filter(c => c !== null));

			parts.push(`<table class="mr_cands">`);
			parts.push(`<tr class="mr_head"><td>move</td><td>score</td><td>win</td><td>costs</td><td>visits</td></tr>`);

			for (let i = 0; i < infos.length; i++) {

				let info = infos[i];
				let colour = costs[i] === null ? "#efefefff" : this.value_colour(costs[i], cap);
				let cost_str = costs[i] === null ? "" : costs[i].toFixed(2);

				parts.push(
					`<tr class="mr_cand" data-gtp="${info.move}">` +
					`<td class="mr_coord" style="color: ${colour}">${info.move}</td>` +
					`<td>${this.fmt_score(info.scoreLead)}</td>` +
					`<td>${this.fmt_winrate(info.winrate)}</td>` +
					`<td style="color: ${colour}">${cost_str}</td>` +
					`<td class="mr_dim">${this.fmt_visits(info.visits)}</td>` +
					`</tr>`
				);
			}

			parts.push(`</table>`);
			parts.push(`<div class="mr_dim mr_small">total visits: ${this.fmt_visits(node.analysis.rootInfo.visits)} — click a row to play it</div>`);

		} else if (hub.engine.desired) {
			parts.push(`<div class="mr_quality mr_dim">analysing...</div>`);
		} else {
			parts.push(`<div class="mr_quality mr_dim">engine is not analysing (press Space)</div>`);
		}

		return parts.join("\n");
	},

	// ------------------------------------------------------------ chart shared bits

	size_canvas: function(canvas) {
		let want_width = Math.max(0, canvas.parentElement.clientWidth);
		let want_height = config.move_report_chart_height;
		if (canvas.width !== want_width || canvas.height !== want_height) {
			canvas.width = want_width;
			canvas.height = want_height;
		}
	},

	// ------------------------------------------------------------ move-value distribution histogram
	// Top-N root candidates grouped by score cost versus the current best move.
	// There are always ten buckets. Bucket 0 contains exactly the engine's
	// top-ranked move; the other nine use identical dynamically-sized ranges.

	draw_distribution: function(node) {

		let canvas = this.distribution_canvas;
		let ctx = this.distribution_ctx;

		this.size_canvas(canvas);
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let {x0, x1, y0} = chart_plot_rect(canvas);
		let y1 = canvas.height - 34;		// Range labels plus an explicit x-axis title.

		if (x1 - x0 < 40) {
			this.distribution_hover_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		let top_n = config.move_report_distribution_top_n;
		if (!Number.isInteger(top_n) || top_n < 1) {
			throw new Error("draw_distribution(): config.move_report_distribution_top_n must be an integer >= 1");
		}

		let candidates = this.candidate_costs(node, top_n)
			.filter(candidate => candidate.cost !== null);

		if (candidates.length === 0) {
			this.distribution_hover_map = null;
			ctx.font = "11px monospace";
			ctx.fillStyle = "#999999ff";
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillText(hub.engine.desired ? "analysing..." : "no candidate analysis", x0 + 6, y0 + 6);
			return;
		}

		let rounded_costs = candidates.slice(1).map(candidate =>
			Math.max(0, Math.round(candidate.cost * 100))
		);
		let range_start_hundredths = rounded_costs.includes(0) ? 0 : 1;
		let max_hundredths = Math.max(range_start_hundredths, ...rounded_costs);
		let bucket_width_hundredths = Math.max(
			1,
			Math.ceil((max_hundredths - range_start_hundredths + 1) / (DISTRIBUTION_BUCKET_COUNT - 1))
		);
		let bin_indexes = [
			0,
			...rounded_costs.map(hundredths =>
				1 + Math.min(
					DISTRIBUTION_BUCKET_COUNT - 2,
					Math.floor((hundredths - range_start_hundredths) / bucket_width_hundredths)
				)
			),
		];
		let bins = new Array(DISTRIBUTION_BUCKET_COUNT).fill(0);
		for (let index of bin_indexes) {
			bins[index]++;
		}

		let bucket_range = (index) => {
			if (index === 0) {
				return {label: "top"};
			}
			let low_hundredths = range_start_hundredths + (index - 1) * bucket_width_hundredths;
			let high_hundredths = low_hundredths + bucket_width_hundredths - 1;
			let low = (low_hundredths / 100).toFixed(2);
			let high = (high_hundredths / 100).toFixed(2);
			return {
				label: low === high ? low : `${low}–${high}`,
				detail: low === high
					? `${low} points worse`
					: `${low}–${high} points worse`,
			};
		};

		// Count axis: about five round-number intervals.

		let count_max = Math.max(...bins);
		let raw_step = Math.max(1, count_max / 5);
		let magnitude = Math.pow(10, Math.floor(Math.log10(raw_step)));
		let normalized = raw_step / magnitude;
		let count_step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
		let y_max = Math.max(1, Math.ceil(count_max / count_step) * count_step);
		let y_of = (count) => y1 - (y1 - y0) * count / y_max;

		ctx.font = "11px monospace";
		ctx.textBaseline = "middle";
		for (let count = 0; count <= y_max; count += count_step) {
			let y = y_of(count);
			ctx.strokeStyle = count === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.fillText(count.toString(), x0 - 5, y);
		}

		// Histogram bars use the same best-to-worst gradient as candidate
		// values elsewhere: near-best bins sit at the start of the palette.

		let slot_w = (x1 - x0) / bins.length;
		this.distribution_hover_map = {
			x0,
			x1,
			slot_w,
			bins,
			bucket_width_hundredths,
			range_start_hundredths,
		};
		for (let i = 0; i < bins.length; i++) {
			let left = x0 + i * slot_w;
			let right = x0 + (i + 1) * slot_w;
			let top = y_of(bins[i]);
			ctx.fillStyle = this.value_colour(i, DISTRIBUTION_BUCKET_COUNT - 1);
			ctx.fillRect(left, top, right - left, y1 - top);
			ctx.strokeStyle = "#111111ff";
			ctx.strokeRect(left, top, right - left, y1 - top);

			if (bins[i] > 0) {
				let count_label = bins[i].toString();
				if (slot_w >= ctx.measureText(count_label).width + 4) {
					ctx.fillStyle = "#ffffffff";
					ctx.textAlign = "center";
					ctx.textBaseline = "bottom";
					ctx.fillText(count_label, (left + right) / 2, Math.max(y0 + 11, top - 2));
				}
			}
		}

		let range_label = (index) => bucket_range(index).label;

		// Keep the first bin's required "0" label. Thin out later range labels
		// according to measured text width, while retaining the final range.

		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		let widest_range = Math.max(...bins.map((_, i) => ctx.measureText(range_label(i)).width));
		let x_step = Math.max(1, Math.ceil((widest_range + 5) / slot_w));
		let label_indexes = [0];
		for (let i = x_step; i < DISTRIBUTION_BUCKET_COUNT; i += x_step) {
			label_indexes.push(i);
		}
		let last_bin = DISTRIBUTION_BUCKET_COUNT - 1;
		if (!label_indexes.includes(last_bin)) {
			if (label_indexes.length > 1 && last_bin - label_indexes[label_indexes.length - 1] < x_step) {
				label_indexes.pop();
			}
			label_indexes.push(last_bin);
		}
		for (let i of label_indexes) {
			ctx.fillText(range_label(i), x0 + (i + 0.5) * slot_w, y1 + 5);
		}

		// Explanatory corner labels survive even when the bins become narrow.

		ctx.textBaseline = "top";
		ctx.textAlign = "left";
		ctx.fillStyle = "#99ff99ff";
		ctx.fillText("candidate count", x0 + 6, y0 + 6);
		ctx.textAlign = "right";
		ctx.fillStyle = "#999999ff";
		ctx.fillText(`${candidates.length} of top ${top_n} reported`, x1 - 6, y0 + 6);

		ctx.textBaseline = "bottom";
		ctx.textAlign = "center";
		ctx.fillStyle = "#e0b872ff";
		ctx.fillText("score diff from best found move", (x0 + x1) / 2, canvas.height - 2);
	},

	distribution_detail_at: function(mousex) {

		let map = this.distribution_hover_map;
		if (!map || mousex < map.x0 || mousex >= map.x1) {
			return null;
		}
		let index = Math.floor((mousex - map.x0) / map.slot_w);
		if (index === 0) {
			return {range: "top move (0.00 points worse)", count: map.bins[index]};
		}
		let low_hundredths = map.range_start_hundredths + (index - 1) * map.bucket_width_hundredths;
		let high_hundredths = low_hundredths + map.bucket_width_hundredths - 1;
		let low = (low_hundredths / 100).toFixed(2);
		let high = (high_hundredths / 100).toFixed(2);
		let range = low === high
			? `${low} points worse`
			: `${low}–${high} points worse`;
		return {range, count: map.bins[index]};
	},

	width_spray_clusters: function(costs, y_of) {

		let points = costs
			.map(cost => ({cost, y: y_of(cost)}))
			.sort((a, b) => a.y - b.y);
		let clusters = [];

		for (let point of points) {
			let cluster = clusters[clusters.length - 1];
			if (!cluster || Math.abs(point.y - cluster.last_y) > WIDTH_SPRAY_CLUSTER_PX) {
				clusters.push({
					costs: [point.cost],
					y_sum: point.y,
					last_y: point.y,
				});
			} else {
				cluster.costs.push(point.cost);
				cluster.y_sum += point.y;
				cluster.last_y = point.y;
			}
		}

		return clusters.map(cluster => {
			return {
				costs: cluster.costs,
				y: cluster.y_sum / cluster.costs.length,
			};
		});
	},

	fmt_candidate_relative: function(cost) {
		return cost <= Number.EPSILON ? "0.00" : `−${cost.toFixed(2)}`;
	},

	fmt_width_spray_cluster: function(cluster) {
		let low = Math.min(...cluster.costs);
		let high = Math.max(...cluster.costs);
		if (cluster.costs.length === 1) {
			return this.fmt_candidate_relative(low);
		}
		let range = low.toFixed(2) === high.toFixed(2)
			? this.fmt_candidate_relative(low)
			: `${this.fmt_candidate_relative(low)}…${this.fmt_candidate_relative(high)}`;
		return `${range} ×${cluster.costs.length}`;
	},

	fit_width_spray_label_clusters: function(clusters, max_count) {

		let fitted = clusters.map(cluster => {
			return {costs: Array.from(cluster.costs), y: cluster.y};
		});

		while (fitted.length > max_count) {
			let merge_at = 0;
			let closest = Infinity;
			for (let i = 0; i < fitted.length - 1; i++) {
				let distance = Math.abs(fitted[i + 1].y - fitted[i].y);
				if (distance < closest) {
					closest = distance;
					merge_at = i;
				}
			}
			let a = fitted[merge_at];
			let b = fitted[merge_at + 1];
			let count = a.costs.length + b.costs.length;
			fitted.splice(merge_at, 2, {
				costs: [...a.costs, ...b.costs],
				y: (a.y * a.costs.length + b.y * b.costs.length) / count,
			});
		}
		return fitted;
	},

	layout_width_spray_labels: function(clusters, min_y, max_y) {

		let gap = 11;
		let labels = clusters
			.map(cluster => ({cluster, y: cluster.y}))
			.sort((a, b) => a.y - b.y);

		for (let i = 0; i < labels.length; i++) {
			labels[i].y = Math.max(labels[i].y, i === 0 ? min_y : labels[i - 1].y + gap);
		}
		if (labels.length > 0 && labels[labels.length - 1].y > max_y) {
			labels[labels.length - 1].y = max_y;
			for (let i = labels.length - 2; i >= 0; i--) {
				labels[i].y = Math.min(labels[i].y, labels[i + 1].y - gap);
			}
		}
		return labels;
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

		this.size_canvas(canvas);
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let {x0, x1, y0, y1} = chart_plot_rect(canvas);

		if (x1 - x0 < 40) {
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
		let position_widths = {};
		let position_width_max = 1;
		let position_candidate_costs = {};
		let candidate_cost_max = 1;
		for (let d = start_depth; d <= end_depth; d++) {
			let delta = this.points_delta(history[d]);
			let wg = delta === null ? null : (history[d].has_key("B") ? -delta : delta);
			w_gains[d] = wg;
			if (wg !== null && Math.abs(wg) > y_abs_max) {
				y_abs_max = Math.abs(wg);
			}
		}
		for (let d = start_depth; d <= end_depth; d++) {
			let width = history[d].stored_position_width();
			position_widths[d] = width;
			if (width !== null && width > position_width_max) {
				position_width_max = width;
			}
			let costs = history[d].stored_candidate_costs();
			position_candidate_costs[d] = costs === null
				? null
				: costs
					.sort((a, b) => a - b)
					.slice(0, config.move_report_width_spray_top_n);
			if (position_candidate_costs[d] !== null) {
				for (let cost of position_candidate_costs[d]) {
					if (cost > candidate_cost_max) {
						candidate_cost_max = cost;
					}
				}
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

		ctx.font = "11px monospace";
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

		// Candidate spray uses the same linear/log2 transform selected for Move
		// Quality, but an independent positive-only range. Zero sits on the
		// centerline; moves farther below the best found move rise upward.

		let candidate_scale = symmetric_y_scale(
			candidate_cost_max,
			config.move_report_quality_yscale,
			(max) => max <= 3 ? 1 : max <= 6 ? 2 : max <= 15 ? 5 : 10
		);
		let candidate_t_max = candidate_scale.transform(candidate_scale.y_max);
		let candidate_y_of = (cost) => {
			return y_zero - (y_zero - y0) * candidate_scale.transform(cost) / candidate_t_max;
		};
		let spray_clusters = {};

		ctx.fillStyle = "rgba(75, 170, 255, 0.62)";
		for (let d = start_depth; d <= end_depth; d++) {
			let costs = position_candidate_costs[d];
			if (costs === null || costs.length === 0) {
				continue;
			}
			let clusters = this.width_spray_clusters(costs, candidate_y_of);
			spray_clusters[d] = clusters;
			let x = xs.x_of(d);
			for (let cluster of clusters) {
				ctx.beginPath();
				ctx.arc(x, cluster.y, cluster.costs.length > 1 ? 3.5 : 2.25, 0, 2 * Math.PI);
				ctx.fill();
			}
		}

		// Labels thin by whole columns as horizontal space contracts. The
		// current and hovered columns remain labeled at every density.

		let spray_label_step = Math.max(1, Math.ceil(WIDTH_SPRAY_LABEL_WIDTH / Math.max(1, slot_w)));
		let labeled_depths = new Set([end_depth]);
		for (let d = end_depth; d >= start_depth; d -= spray_label_step) {
			labeled_depths.add(d);
		}
		if (this.quality_hover_depth !== null) {
			labeled_depths.add(this.quality_hover_depth);
		}

		ctx.font = "9px monospace";
		ctx.textBaseline = "middle";
		for (let d of labeled_depths) {
			let clusters = spray_clusters[d];
			if (!clusters) {
				continue;
			}
			let x = xs.x_of(d);
			let on_right = x > (x0 + x1) / 2;
			ctx.textAlign = on_right ? "right" : "left";
			let label_min_y = y0 + 32;
			let label_max_y = y_zero - 6;
			let max_labels = Math.max(1, Math.floor((label_max_y - label_min_y) / 11) + 1);
			let fitted = this.fit_width_spray_label_clusters(clusters, max_labels);
			let labels = this.layout_width_spray_labels(fitted, label_min_y, label_max_y);
			for (let label of labels) {
				let text = this.fmt_width_spray_cluster(label.cluster);
				let text_x = x + (on_right ? -5 : 5);
				let text_width = ctx.measureText(text).width;

				if (Math.abs(label.y - label.cluster.y) > 1) {
					ctx.strokeStyle = "rgba(75, 170, 255, 0.45)";
					ctx.beginPath();
					ctx.moveTo(x, label.cluster.y);
					ctx.lineTo(x + (on_right ? -3 : 3), label.y);
					ctx.stroke();
				}

				ctx.fillStyle = "rgba(15, 15, 15, 0.82)";
				ctx.fillRect(
					on_right ? text_x - text_width - 2 : text_x - 2,
					label.y - 5,
					text_width + 4,
					10
				);
				ctx.fillStyle = "rgba(145, 205, 255, 0.92)";
				ctx.fillText(text, text_x, label.y);
			}
		}

		// Position width is the number of candidates within 0.30 points of the
		// best found move at that node. It has its own positive-only scale from
		// the center line to the chart top and does not alter the quality axis.

		let width_scale_max = Math.max(5, position_width_max);
		ctx.font = "9px monospace";
		ctx.textBaseline = "bottom";
		for (let d = start_depth; d <= end_depth; d++) {
			let width = position_widths[d];
			if (width === null) {
				continue;
			}
			let x = xs.x_of(d);
			let y = y_zero - (y_zero - y0) * width / width_scale_max;

			ctx.fillStyle = "rgba(102, 255, 102, 0.55)";
			ctx.beginPath();
			ctx.arc(x, y, 3, 0, 2 * Math.PI);
			ctx.fill();

			ctx.fillStyle = "rgba(153, 255, 153, 0.75)";
			ctx.textAlign = d === start_depth ? "left" : d === end_depth ? "right" : "center";
			ctx.fillText(width.toString(), x, y - 4);
		}

		// Fit as many move numbers as the available width allows. Anchor the
		// sequence at the last move so it is labeled in every case.

		ctx.font = "11px monospace";
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
		ctx.textAlign = "right";
		ctx.fillStyle = "rgba(153, 255, 153, 0.75)";
		ctx.fillText("width: moves ≤0.30", x1 - 6, y0 + 8);
		ctx.fillStyle = "rgba(145, 205, 255, 0.88)";
		ctx.fillText(`blue: top ${config.move_report_width_spray_top_n} values vs best`, x1 - 6, y0 + 20);
		ctx.textAlign = "left";
		ctx.fillStyle = "#999999ff";
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

	quality_spray_title: function(depth) {

		let map = this.quality_click_map;
		if (!map || depth === null || !map.history[depth]) {
			return "";
		}
		let costs = map.history[depth].stored_candidate_costs();
		if (costs === null || costs.length === 0) {
			return `#${depth}: candidate values have not been stored`;
		}
		let shown = costs
			.slice(0, config.move_report_width_spray_top_n)
			.map(cost => this.fmt_candidate_relative(cost))
			.join(", ");
		return `#${depth} candidate values vs best: ${shown}`;
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

		this.size_canvas(canvas);
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let {x0, x1, y0, y1} = chart_plot_rect(canvas);

		if (x1 - x0 < 40) {
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

		ctx.font = "11px monospace";
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

		// Region labels...

		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "right";
		ctx.textBaseline = "middle";
		ctx.fillText("W ahead", x1 - 6, y0 + 8);
		ctx.fillText("B ahead", x1 - 6, y1 - 8);

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

};

module.exports = init();
