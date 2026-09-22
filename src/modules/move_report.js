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
// Typography and styling rules (agents.md "UI conventions"):
//   - Every text size comes from the six-step type scale (type_scale.js),
//     derived from the app-wide info_font_size. DOM text via the --fs-*
//     variables in ogatak.css; canvas text via type_scale.canvas_font().
//   - No inline styles: JS publishes config-driven values only as CSS custom
//     properties (--mr-card-width, --mr-sec-order, ...); every actual style
//     rule lives in ogatak.css classes.

const config_io = require("./config_io");
const colour_gradients = require("./colour_gradients");
const candidate_profile = require("./candidate_profile");
const type_scale = require("./type_scale");
const {info_cost, safe_html} = require("./utils");

const SECTION_TITLES = {
	quality:  "MOVE QUALITY",
	breadth:  "CHOICE BREADTH HISTORY",
	status:   "GAME STATUS",
	distribution: "CURRENT CANDIDATE VALUES",
	turn:     "TURN",
	lastmove: "LAST MOVE",
	outcome:  "OUTCOME",
	options:  "NEXT MOVE OPTIONS",
	comments: "COMMENTS",
	tree:     "VARIATION TREE",
};

const ALL_SECTIONS = Object.keys(SECTION_TITLES);
const CHART_SECTIONS = ["quality", "breadth", "status", "distribution"];
const YSCALE_SECTIONS = ["quality", "status"];
const HTML_SECTIONS = ["turn", "lastmove", "outcome", "options"];		// Rendered via html_* methods; "comments" hosts the stock textarea instead.

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
	move_report_width:        {min: 320, max: 1280, step: 40},
	move_report_chart_height: {min: 90,  max: 400,  step: 20},
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
	parts.push(`<span class="mr_ctlgroup">width <span class="mr_ctl" data-act="width_down">–</span><span class="mr_ctl" data-act="width_up">+</span></span>`);
	parts.push(`<span class="mr_ctlgroup">chart <span class="mr_ctl" data-act="chart_down">–</span><span class="mr_ctl" data-act="chart_up">+</span></span>`);
	parts.push(`<label class="mr_metric">breadth <select id="mr_breadth_view">`);
	for (let [value, label] of Object.entries(BREADTH_VIEW_LABELS)) {
		parts.push(`<option value="${value}">${label}</option>`);
	}
	parts.push(`</select></label>`);
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
		if (sec === "distribution") {
			parts.push(`<label class="mr_metric" title='Enter "all" or an engine-ranked top N'>candidates <input id="mr_distribution_top_n" type="text" inputmode="numeric"></label>`);
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
			if (sec === "tree") {
				parts.push(`<div class="mr_width_drag" title="Drag to resize all sections"></div>`);
			}
		}
		parts.push(`</div>`);
	}
	parts.push(`</div>`);

	outer.innerHTML = parts.join("\n");

	// Adopt the stock comments textarea into our comments section. It keeps its
	// id, so comment_drawer and the input handlers keep working untouched.

	document.getElementById("mr_seccontent_comments").appendChild(document.getElementById("comments"));
	document.getElementById("mr_seccontent_tree").appendChild(document.getElementById("treecanvas"));

	let ret = Object.assign(Object.create(move_report_prototype), {

		outer: outer,
		inner: document.getElementById("mr_inner"),
		chips: document.getElementById("mr_hidden_chips"),
		game_identity: document.getElementById("mr_game_identity"),

		quality_canvas: document.getElementById("mr_canvas_quality"),
		quality_ctx: document.getElementById("mr_canvas_quality").getContext("2d"),
		breadth_canvas: document.getElementById("mr_canvas_breadth"),
		breadth_ctx: document.getElementById("mr_canvas_breadth").getContext("2d"),
		status_canvas: document.getElementById("mr_canvas_status"),
		status_ctx: document.getElementById("mr_canvas_status").getContext("2d"),
		distribution_canvas: document.getElementById("mr_canvas_distribution"),
		distribution_ctx: document.getElementById("mr_canvas_distribution").getContext("2d"),

		content_cache: {},			// section name --> last html set
		chips_cache: "",
		quality_click_map: null,	// Chart geometries for click-to-navigate.
		quality_hover_depth: null,
		breadth_click_map: null,
		breadth_hover_depth: null,
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

	document.getElementById("mr_breadth_view").addEventListener("change", (event) => {
		ret.set_breadth_view(event.target.value);
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

	// Canvas backing dimensions do not follow CSS layout automatically. Observe
	// the chart containers so window resize, maximize, zoom, and flex reflow all
	// redraw at their final widths.

	ret.observed_chart_widths = [];
	ret.resize_frame = null;
	ret.resize_observer = new ResizeObserver(() => {
		let widths = [
			ret.quality_canvas,
			ret.breadth_canvas,
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

	for (let canvas of [ret.quality_canvas, ret.breadth_canvas, ret.status_canvas, ret.distribution_canvas]) {
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

		let cleaned = String(raw_value).trim().toLowerCase();
		let value = cleaned === "all" ? 0 : Number(cleaned);
		let lim = LIMITS.move_report_distribution_top_n;
		let input = document.getElementById("mr_distribution_top_n");

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

		// No concrete styles are ever set from JS: config-driven layout values
		// are published as CSS custom properties, and every actual style rule
		// (including all font sizes, via the --fs-* scale) lives in ogatak.css.

		this.outer.style.setProperty("--mr-card-width", config.move_report_width.toString() + "px");
		this.outer.style.setProperty("--mr-tree-height", config.tree_pane_height.toString() + "px");

		let visible = this.visible_sections();

		for (let sec of ALL_SECTIONS) {
			let box = document.getElementById(`mr_secbox_${sec}`);
			let i = visible.indexOf(sec);
			box.classList.toggle("hidden", i === -1);
			box.style.setProperty("--mr-sec-order", i.toString());
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
		let top_n_label = config.move_report_distribution_top_n === 0
			? "all"
			: config.move_report_distribution_top_n.toString();
		if (document.activeElement !== top_n_input &&
			top_n_input.value !== top_n_label) {
			top_n_input.value = top_n_label;
		}

		let breadth_view = document.getElementById("mr_breadth_view");
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
		if (typeof v !== "number") return "?";
		if (v >= 100000) return `${(v / 1000).toFixed(0)}k`;
		if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
		return v.toString();
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
			} else if (sec === "breadth") {
				this.draw_breadth(node);
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
			// "comments" and "tree" are stock widgets adopted into their cards.
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
				let lost_str = lost < 0.005 ? "as good as the engine's best" : `lost ${lost.toFixed(2)} pts vs best`;
				parts.push(`<div class="mr_verdict ${klass}">${label}</div>`);

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
				let cost_str = costs[i] === null ? "" : costs[i].toFixed(2);

				// Gradient colours are continuous data, so they can't be classes:
				// the row binds --val-colour and the .mr_val rule consumes it.

				let val_bind = costs[i] === null ? "" : ` style="--val-colour: ${this.value_colour(costs[i], cap)}"`;

				parts.push(
					`<tr class="mr_cand" data-gtp="${info.move}"${val_bind}>` +
					`<td class="mr_coord mr_val">${info.move}</td>` +
					`<td>${this.fmt_score(info.scoreLead)}</td>` +
					`<td>${this.fmt_winrate(info.winrate)}</td>` +
					`<td class="mr_val">${cost_str}</td>` +
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
		this.size_canvas(canvas);
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
		if (x1 - x0 < 40) {
			return null;
		}
		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, frame_y0, x1 - x0, y1 - frame_y0);
		ctx.font = type_scale.canvas_font("caption");
		if (profile.total === 0) {
			ctx.fillStyle = "#999999ff";
			ctx.textAlign = "left";
			ctx.textBaseline = "top";
			ctx.fillText(hub.engine.desired ? "analysing..." : "no candidate analysis", x0 + 6, frame_y0 + 6);
			return null;
		}
		ctx.fillStyle = "#999999ff";
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
			ctx.fillStyle = "#b9cde0ff";
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
		for (let tick of [0, .1, .3, 1, 3, 10]) {
			let y = y_of(tick);
			ctx.strokeStyle = tick === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
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
			ctx.fillStyle = "#888888ff";
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
		this.size_canvas(canvas);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		let data = this.breadth_data(node);
		let {x0, x1, y0, y1, xs, end_depth, history} = data;
		if (x1 - x0 < 40) {
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
		ctx.font = type_scale.canvas_font("fine");
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		let legend_x = x0 + 6;
		for (let item of series) {
			ctx.fillStyle = item.colour;
			ctx.fillText(item.label, legend_x, y0 + 6);
			legend_x += ctx.measureText(item.label).width + 14;
		}
		ctx.fillStyle = "#999999ff";
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
		ctx.font = type_scale.canvas_font("fine");
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		let legend_x = x0 + 6;
		for (let i = 0; i < candidate_profile.BAND_LABELS.length; i++) {
			let label = candidate_profile.BAND_LABELS[i];
			if (legend_x + ctx.measureText(label).width > x1 - 4) break;
			ctx.fillStyle = PROFILE_COLOURS[i];
			ctx.fillText(label, legend_x, y0 + 6);
			legend_x += ctx.measureText(label).width + 10;
		}
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
		ctx.fillStyle = "#999999ff";
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
		ctx.fillStyle = "#999999ff";
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
		ctx.font = type_scale.canvas_font("fine");
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		let legend_x = x0 + 6;
		for (let state of states) {
			let suffix = state.max === Infinity ? "8+" : state.max.toString();
			let text = `${state.label} ${suffix}`;
			ctx.fillStyle = state.colour;
			ctx.fillText(text, legend_x, y0 + 6);
			legend_x += ctx.measureText(text).width + 12;
		}
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
