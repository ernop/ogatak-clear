"use strict";

// The Move Report panel. See PRODUCT.md at the repo root for the requirements
// this implements. The framework rules that matter here:
//
//   - No bare signed numbers: every value is labeled with the color it favors
//     ("B+2.3", "W 61%"). KataGo values arrive in Black POV (see query.js) and
//     are converted to labeled form HERE, at the display layer, nowhere else.
//   - Move quality is "points thrown away by the mover", always >= 0.
//   - The chart has real axes, labeled in the same "B+n"/"W+n" form.
//
// The panel is made of named sections. Their order and visibility live in
// config.move_report_sections; sizes live in config.move_report_font_size /
// _width / _chart_height. All are adjustable live from the controls the panel
// itself renders, and every change is saved to config.json immediately.

const config_io = require("./config_io");

const SECTION_TITLES = {
	chart:    "SCORE CHART",
	turn:     "TURN",
	lastmove: "LAST MOVE",
	outcome:  "OUTCOME",
	options:  "NEXT MOVE OPTIONS",
};

const ALL_SECTIONS = Object.keys(SECTION_TITLES);

const VERDICTS = [
	// [max points lost (exclusive), label, colour]
	[0.5, "EXCELLENT",  "#99ff99ff"],
	[1.5, "GOOD",       "#ccee99ff"],
	[3.0, "INACCURACY", "#ffff66ff"],
	[6.0, "MISTAKE",    "#ffaa44ff"],
	[Infinity, "BLUNDER", "#ff5555ff"],
];

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
	// reordered via flexbox "order", so the DOM (and the canvas) stays stable...

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
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="up" title="Move section up">▲</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="down" title="Move section down">▼</span>`);
		parts.push(`<span class="mr_secctl" data-sec="${sec}" data-act="hide" title="Hide section">✕</span>`);
		parts.push(`</span>`);
		parts.push(`</div>`);
		if (sec === "chart") {
			parts.push(`<div class="mr_seccontent" id="mr_seccontent_chart"><canvas id="movereportchart"></canvas></div>`);
		} else {
			parts.push(`<div class="mr_seccontent" id="mr_seccontent_${sec}"></div>`);
		}
		parts.push(`</div>`);
	}
	parts.push(`</div>`);

	outer.innerHTML = parts.join("\n");

	let ret = Object.assign(Object.create(move_report_prototype), {

		outer: outer,
		inner: document.getElementById("mr_inner"),
		chips: document.getElementById("mr_hidden_chips"),
		canvas: document.getElementById("movereportchart"),
		ctx: document.getElementById("movereportchart").getContext("2d"),

		content_cache: {},			// section name --> last html set
		chips_cache: "",
		click_map: null,			// Chart geometry for click-to-navigate.

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

	ret.canvas.addEventListener("mousedown", (event) => {
		event.preventDefault();
		let node = ret.node_from_click(event.offsetX);
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
		this.inner.style.width = config.move_report_width.toString() + "px";

		let visible = this.visible_sections();

		for (let sec of ALL_SECTIONS) {
			let box = document.getElementById(`mr_secbox_${sec}`);
			let i = visible.indexOf(sec);
			box.style.display = (i === -1) ? "none" : "";
			box.style.order = i.toString();
		}

		let chips = ALL_SECTIONS
			.filter(sec => !visible.includes(sec))
			.map(sec => `<span class="mr_chip" data-sec="${sec}" title="Show section">+ ${SECTION_TITLES[sec].toLowerCase()}</span>`)
			.join(" ");

		if (chips !== this.chips_cache) {
			this.chips.innerHTML = chips;
			this.chips_cache = chips;
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

	// Points thrown away by the move leading into this node, vs best play.
	// Root scores assume best play, so (parent - child), from the mover's side,
	// is exactly "how much worse than best". Works from stored SGF tags too.
	// Returns null if unknowable.

	points_lost: function(node) {
		if (!node.parent || node.move_count() !== 1) {
			return null;
		}
		let parent_score = node.parent.stored_score();		// Black POV
		let score = node.stored_score();					// Black POV
		if (typeof parent_score !== "number" || typeof score !== "number") {
			return null;
		}
		let lost_bpov = parent_score - score;
		let lost = node.has_key("B") ? lost_bpov : -lost_bpov;
		return Math.max(0, lost);
	},

	// ------------------------------------------------------------ main draw

	draw: function(node) {

		if (!node || node.destroyed) {
			return;
		}

		this.apply_layout();

		let visible = this.visible_sections();

		for (let sec of visible) {
			if (sec === "chart") {
				this.draw_chart(node);
			} else {
				let html = this[`html_${sec}`](node);
				if (html !== this.content_cache[sec]) {
					document.getElementById(`mr_seccontent_${sec}`).innerHTML = html;
					this.content_cache[sec] = html;
				}
			}
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

		let board = node.get_board();
		let parts = [];

		if (node.has_valid_analysis()) {

			let infos = node.analysis.moveInfos.slice(0, 6);
			let best_lead = infos.length > 0 ? infos[0].scoreLead : null;

			parts.push(`<table class="mr_cands">`);
			parts.push(`<tr class="mr_head"><td>move</td><td>score</td><td>win</td><td>costs</td><td>visits</td></tr>`);

			for (let info of infos) {

				let cost = "";
				let cost_colour = "#efefefff";
				if (typeof best_lead === "number" && typeof info.scoreLead === "number") {
					let c = board.active === "b" ? best_lead - info.scoreLead : info.scoreLead - best_lead;
					c = Math.max(0, c);
					cost = c.toFixed(1);
					cost_colour = this.verdict(c)[1];
				}

				parts.push(
					`<tr class="mr_cand" data-gtp="${info.move}">` +
					`<td class="mr_coord" style="color: ${cost_colour}">${info.move}</td>` +
					`<td>${this.fmt_score(info.scoreLead)}</td>` +
					`<td>${this.fmt_winrate(info.winrate)}</td>` +
					`<td style="color: ${cost_colour}">${cost}</td>` +
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

	// ------------------------------------------------------------ score history chart

	draw_chart: function(node) {

		let canvas = this.canvas;
		let ctx = this.ctx;

		let want_width = Math.max(0, this.canvas.parentElement.clientWidth);
		let want_height = config.move_report_chart_height;
		if (canvas.width !== want_width || canvas.height !== want_height) {
			canvas.width = want_width;
			canvas.height = want_height;
		}

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		let x0 = CHART_PAD_LEFT;
		let x1 = canvas.width - CHART_PAD_RIGHT;
		let y0 = CHART_PAD_TOP;
		let y1 = canvas.height - CHART_PAD_BOTTOM;

		if (x1 - x0 < 40) {
			this.click_map = null;
			return;
		}

		ctx.fillStyle = "#181818ff";
		ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

		// Data: the current line of play, scores in Black POV...

		let history = node.get_end().history();
		let scores = history.map(n => n.stored_score());

		let depth_max = Math.max(20, history.length - 1);		// Unlike the stock grapher, scale to the actual game, not a 60-move minimum.

		let abs_max = 5;
		for (let sc of scores) {
			if (typeof sc === "number" && Math.abs(sc) > abs_max) {
				abs_max = Math.abs(sc);
			}
		}
		let y_max = Math.ceil(abs_max / 5) * 5;						// Symmetric range: +y_max (B) .. -y_max (W)

		let x_of = (depth) => x0 + (x1 - x0) * depth / depth_max;
		let y_of = (score) => y0 + (y1 - y0) * (1 - (score + y_max) / (2 * y_max));

		this.click_map = {x0, x1, depth_max, history};

		// Axes and gridlines...

		let y_step = y_max <= 10 ? 5 : y_max <= 20 ? 10 : y_max <= 50 ? 25 : 50;

		ctx.font = "11px monospace";
		ctx.textBaseline = "middle";

		for (let v = -y_max; v <= y_max; v += y_step) {
			let y = y_of(v);
			ctx.strokeStyle = v === 0 ? "#555555ff" : "#2c2c2cff";
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = "#e0b872ff";
			ctx.textAlign = "right";
			ctx.fillText(v === 0 ? "0" : (v > 0 ? `B+${v}` : `W+${-v}`), x0 - 5, y);
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

	node_from_click: function(mousex) {

		if (!this.click_map) {
			return null;
		}

		let {x0, x1, depth_max, history} = this.click_map;

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
