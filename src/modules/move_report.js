"use strict";

// The Move Report panel. See PRODUCT.md at the repo root for the requirements
// this implements. The framework rules that matter here:
//
//   - No bare signed numbers: every value is labeled with the color it favors
//     ("B+2.3", "W 61%"). KataGo values arrive in Black POV (see query.js) and
//     are converted to labeled form HERE, at the display layer, nowhere else.
//   - Move quality is "points thrown away by the mover", always >= 0 in text.
//   - Candidate values are relative to the best available move from here,
//     never to the global board value.
//   - Candidate value differences use one pure green gradient, brightest =
//     best available, spending a wide brightness range.
//   - Two charts, never merged: "quality" (per-move bars: how well was each
//     recent move played) and "status" (who was winning at each point).
//
// The panel is made of named sections. Their order and visibility live in
// config.move_report_sections; sizes live in config.move_report_font_size /
// _width / _chart_height. All are adjustable live from the controls the panel
// itself renders, and every change is saved to config.json immediately.

const config_io = require("./config_io");

const SECTION_TITLES = {
	quality:  "MOVE QUALITY",
	status:   "GAME STATUS",
	turn:     "TURN",
	lastmove: "LAST MOVE",
	outcome:  "OUTCOME",
	options:  "NEXT MOVE OPTIONS",
	comments: "COMMENTS",
};

const ALL_SECTIONS = Object.keys(SECTION_TITLES);
const CHART_SECTIONS = ["quality", "status"];
const HTML_SECTIONS = ["turn", "lastmove", "outcome", "options"];		// Rendered via html_* methods; "comments" hosts the stock textarea instead.

const VERDICTS = [
	// [max points lost (exclusive), label, colour]
	[0.5, "EXCELLENT",  "#99ff99ff"],
	[1.5, "GOOD",       "#ccee99ff"],
	[3.0, "INACCURACY", "#ffff66ff"],
	[6.0, "MISTAKE",    "#ffaa44ff"],
	[Infinity, "BLUNDER", "#ff5555ff"],
];

// Green gradient endpoints for candidate values (rule: pure green, wide
// brightness range, brightest = best available from here)...

const GREEN_BRIGHT = [102, 255, 102];
const GREEN_DARK = [30, 85, 30];

const LIMITS = {
	move_report_font_size:    {min: 9,   max: 28,   step: 1},
	move_report_width:        {min: 320, max: 1280, step: 40},
	move_report_chart_height: {min: 90,  max: 400,  step: 20},
};

const CHART_PAD_LEFT = 44;			// Room for y-axis labels.
const CHART_PAD_RIGHT = 10;
const CHART_PAD_TOP = 14;
const CHART_PAD_BOTTOM = 20;		// Room for x-axis labels.

function init() {

	let outer = document.getElementById("movereport");

	// Build the skeleton: a controls bar, then one box per section. Sections are
	// reordered via flexbox "order", so the DOM (and the canvases) stays stable...

	let parts = [];

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
		if (sec === "quality") {
			parts.push(`<span class="mr_secctl" id="mr_yscale_ctl" data-sec="quality" data-act="yscale" title="Toggle linear / log2 y scale">lin</span>`);
		}
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="up" title="Move section up">▲</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="down" title="Move section down">▼</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="hide" title="Hide section">✕</span>`);
		parts.push(`</span>`);
		parts.push(`</div>`);
		if (CHART_SECTIONS.includes(sec)) {
			parts.push(`<div class="mr_seccontent"><canvas class="mr_chartcanvas" id="mr_canvas_${sec}"></canvas></div>`);
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

		quality_canvas: document.getElementById("mr_canvas_quality"),
		quality_ctx: document.getElementById("mr_canvas_quality").getContext("2d"),
		status_canvas: document.getElementById("mr_canvas_status"),
		status_ctx: document.getElementById("mr_canvas_status").getContext("2d"),

		content_cache: {},			// section name --> last html set
		chips_cache: "",
		quality_click_map: null,	// Chart geometries for click-to-navigate.
		status_click_map: null,

	});

	outer.addEventListener("mousedown", (event) => {

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

	ret.quality_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_quality_click(event.offsetX);
		if (node) {
			hub.set_node(node, {bless: false});
		}
	});

	ret.status_canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_status_click(event.offsetX);
		if (node) {
			hub.set_node(node, {bless: false});
		}
	});

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

	section_action: function(sec, act) {

		if (act === "yscale") {
			config.move_report_quality_yscale = (config.move_report_quality_yscale === "log2") ? "linear" : "log2";
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
			box.style.width = config.move_report_width.toString() + "px";		// Cards wrap side by side when the panel is wide.
		}

		let chips = ALL_SECTIONS
			.filter(sec => !visible.includes(sec))
			.map(sec => `<span class="mr_chip" data-sec="${sec}" title="Show section">+ ${SECTION_TITLES[sec].toLowerCase()}</span>`)
			.join(" ");

		if (chips !== this.chips_cache) {
			this.chips.innerHTML = chips;
			this.chips_cache = chips;
		}

		let yscale_label = config.move_report_quality_yscale === "log2" ? "log₂" : "lin";
		let yscale_ctl = document.getElementById("mr_yscale_ctl");
		if (yscale_ctl.textContent !== yscale_label) {
			yscale_ctl.textContent = yscale_label;
		}
	},

	// ------------------------------------------------------------ formatting helpers

	fmt_score: function(lead_bpov) {				// Black-POV number --> "B+2.3" / "W+0.5"
		if (typeof lead_bpov !== "number") {
			return "?";
		}
		return lead_bpov >= 0 ? `B+${lead_bpov.toFixed(1)}` : `W+${(-lead_bpov).toFixed(1)}`;
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

	green: function(cost, cap) {					// cost 0 --> brightest, cost >= cap --> darkest
		let t = Math.min(1, Math.max(0, cost / cap));
		let c = GREEN_BRIGHT.map((b, i) => Math.round(b + (GREEN_DARK[i] - b) * t));
		return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
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

		let visible = this.visible_sections();

		for (let sec of visible) {
			if (sec === "quality") {
				this.draw_quality(node);
			} else if (sec === "status") {
				this.draw_status(node);
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
				let lost_str = lost < 0.05 ? "as good as the engine's best" : `lost ${lost.toFixed(1)} pts vs best`;
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

			let infos = node.analysis.moveInfos.slice(0, 6);
			let best_lead = infos.length > 0 ? infos[0].scoreLead : null;
			let active_is_b = node.get_board().active === "b";

			// Costs are vs the best AVAILABLE move (infos[0]), never vs the
			// global board value: if we're losing badly, the best we can do
			// from here is the reference point (PRODUCT.md rule 5)...

			let costs = infos.map(info => {
				if (typeof best_lead !== "number" || typeof info.scoreLead !== "number") {
					return null;
				}
				let c = active_is_b ? best_lead - info.scoreLead : info.scoreLead - best_lead;
				return Math.max(0, c);
			});

			// Gradient cap: worst displayed cost, floored at 2 pts so near-equal
			// options stay near-equal in color (PRODUCT.md rule 6)...

			let cap = Math.max(2, ...costs.filter(c => c !== null));

			parts.push(`<table class="mr_cands">`);
			parts.push(`<tr class="mr_head"><td>move</td><td>score</td><td>win</td><td>costs</td><td>visits</td></tr>`);

			for (let i = 0; i < infos.length; i++) {

				let info = infos[i];
				let colour = costs[i] === null ? "#efefefff" : this.green(costs[i], cap);
				let cost_str = costs[i] === null ? "" : costs[i].toFixed(1);

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

	// ------------------------------------------------------------ quality bar chart
	// One bar per recent move, on a FIXED axis: up = the move gained points for
	// White, down = it gained points for Black (respecified 2026-08-11). Since a
	// mover can only lose points vs best play, White's moves show as zero or
	// down-bars, Black's as zero or up-bars. Says nothing about who is winning
	// (that's the status chart). Y scale is linear or log2, toggled in the header.

	draw_quality: function(node) {

		let canvas = this.quality_canvas;
		let ctx = this.quality_ctx;

		this.size_canvas(canvas);
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let x0 = CHART_PAD_LEFT;
		let x1 = canvas.width - CHART_PAD_RIGHT;
		let y0 = CHART_PAD_TOP;
		let y1 = canvas.height - CHART_PAD_BOTTOM;

		if (x1 - x0 < 40) {
			this.quality_click_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		let history = node.get_end().history();

		// Window: as many recent moves as fit at a readable bar spacing,
		// ending at the end of the current line...

		let end_depth = history.length - 1;
		let max_bars = Math.max(5, Math.floor((x1 - x0) / 12));
		let start_depth = Math.max(1, end_depth - max_bars + 1);
		let n_slots = Math.max(1, end_depth - start_depth + 1);
		let slot_w = (x1 - x0) / n_slots;

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

		// Y scale: linear, or log2 (position by log2(1+|pts|), gridlines at
		// powers of two) so one blunder doesn't flatten every ordinary move...

		let log_mode = config.move_report_quality_yscale === "log2";
		let y_max;
		let ticks = [];			// Positive tick values; each also drawn mirrored.

		if (log_mode) {
			y_max = Math.pow(2, Math.ceil(Math.log2(Math.max(2, y_abs_max))));
			for (let v = 1; v <= y_max; v *= 2) {
				ticks.push(v);
			}
		} else {
			let y_step = y_abs_max <= 3 ? 1 : y_abs_max <= 6 ? 2 : y_abs_max <= 15 ? 5 : 10;
			y_max = Math.ceil(y_abs_max / y_step) * y_step;
			for (let v = y_step; v <= y_max; v += y_step) {
				ticks.push(v);
			}
		}

		let t = (v) => log_mode ? Math.sign(v) * Math.log2(1 + Math.abs(v)) : v;
		let t_max = t(y_max);
		let y_of = (v) => y0 + (y1 - y0) * (1 - (t(v) + t_max) / (2 * t_max));
		let y_zero = y_of(0);

		this.quality_click_map = {x0, slot_w, start_depth, end_depth, history};

		// Gridlines and y labels (magnitudes; the regions carry the direction)...

		ctx.font = "11px monospace";
		ctx.textBaseline = "middle";

		for (let v of [0, ...ticks]) {
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

		// Bars, colored by mover...

		for (let d = start_depth; d <= end_depth; d++) {
			let wg = w_gains[d];
			if (wg === null || history[d].move_count() !== 1) {
				continue;
			}
			let cx = x0 + (d - start_depth) * slot_w + slot_w / 2;
			let bar_w = Math.min(18, Math.max(2, slot_w * 0.7));
			let y_val = y_of(wg);
			ctx.fillStyle = history[d].has_key("B") ? "#888888ff" : "#ffffffee";
			ctx.fillRect(cx - bar_w / 2, Math.min(y_zero, y_val), bar_w, Math.max(1, Math.abs(y_val - y_zero)));
		}

		// X labels (move numbers)...

		let x_step = n_slots <= 25 ? 5 : 10;

		ctx.fillStyle = "#e0b872ff";
		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (let d = start_depth; d <= end_depth; d++) {
			if (d % x_step === 0) {
				ctx.fillText(d.toString(), x0 + (d - start_depth) * slot_w + slot_w / 2, y1 + 5);
			}
		}

		// Region labels: fixed directions, top is always White's, bottom Black's...

		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillStyle = "#ffffffff";
		ctx.fillText("white gains", x0 + 6, y0 + 8);
		ctx.fillStyle = "#999999ff";
		ctx.fillText("black gains", x0 + 6, y1 - 8);

		// Current position marker...

		if (node.depth >= start_depth && node.depth <= end_depth) {
			let cx = x0 + (node.depth - start_depth) * slot_w + slot_w / 2;
			ctx.strokeStyle = "#ffff99ff";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(cx, y0);
			ctx.lineTo(cx, y1);
			ctx.stroke();
		}
	},

	node_from_quality_click: function(mousex) {

		if (!this.quality_click_map) {
			return null;
		}

		let {x0, slot_w, start_depth, end_depth, history} = this.quality_click_map;

		let depth = start_depth + Math.floor((mousex - x0) / slot_w);
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

		let x0 = CHART_PAD_LEFT;
		let x1 = canvas.width - CHART_PAD_RIGHT;
		let y0 = CHART_PAD_TOP;
		let y1 = canvas.height - CHART_PAD_BOTTOM;

		if (x1 - x0 < 40) {
			this.status_click_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		let history = node.get_end().history();
		let scores = history.map(n => n.stored_score());

		let depth_max = Math.max(20, history.length - 1);		// Unlike the stock grapher, scale to the actual game, not a 60-move minimum.

		let abs_max = 5;
		for (let sc of scores) {
			if (typeof sc === "number" && Math.abs(sc) > abs_max) {
				abs_max = Math.abs(sc);
			}
		}

		// Round the range up to a whole number of gridline steps, so the axis
		// always has lines at 0, ±step, ... including a labeled top and bottom.
		// Symmetric range: +y_max (B) .. -y_max (W)...

		let y_step = abs_max <= 10 ? 5 : abs_max <= 20 ? 10 : abs_max <= 60 ? 20 : 50;
		let y_max = Math.ceil(abs_max / y_step) * y_step;

		let x_of = (depth) => x0 + (x1 - x0) * depth / depth_max;
		let y_of = (score) => y0 + (y1 - y0) * (1 - (score + y_max) / (2 * y_max));

		this.status_click_map = {x0, x1, depth_max, history};

		// Axes and gridlines...

		ctx.font = "11px monospace";
		ctx.textBaseline = "middle";

		for (let v = 0; v <= y_max; v += y_step) {
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

		let x_step = depth_max <= 60 ? 10 : depth_max <= 150 ? 25 : 50;

		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		for (let d = 0; d <= depth_max; d += x_step) {
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
		for (let n = 0; n < scores.length; n++) {
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
			ctx.lineTo(x_of(Math.min(scores.length - 1, depth_max)), y_zero);
			ctx.closePath();
			ctx.save();
			ctx.clip();
			ctx.fillStyle = "#666666aa";								// B-lead half
			ctx.fillRect(x0, y0, x1 - x0, y_zero - y0);
			ctx.fillStyle = "#ffffff55";								// W-lead half
			ctx.fillRect(x0, y_zero, x1 - x0, y1 - y_zero);
			ctx.restore();
		}

		// The score line itself...

		ctx.strokeStyle = "#efefefff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		let started = false;
		for (let n = 0; n < scores.length; n++) {
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
		ctx.fillText("B ahead", x1 - 6, y0 + 8);
		ctx.fillText("W ahead", x1 - 6, y1 - 8);

		// Current position marker...

		let cx = x_of(Math.min(node.depth, depth_max));
		ctx.strokeStyle = "#ffff99ff";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(cx, y0);
		ctx.lineTo(cx, y1);
		ctx.stroke();

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

		let {x0, x1, depth_max, history} = this.status_click_map;

		let depth = Math.round((mousex - x0) / (x1 - x0) * depth_max);
		if (depth < 0) depth = 0;
		if (depth >= history.length) depth = history.length - 1;

		let node = history[depth];
		if (!node || node.destroyed) {
			return null;
		}
		return node;
	},

};

module.exports = init();
