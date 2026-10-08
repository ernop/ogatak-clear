"use strict";

// Every user-facing setting the Settings pane shows, grouped into cards, plus the
// pure helpers the pane uses to parse, step, and format values. No DOM code here,
// so it runs under plain Node (settings_schema.test.js). See PRODUCT-workspace.md
// "Settings pane".
//
// Row types:
//   toggle   on / off
//   number   a typed value; − / + (and the arrow keys) step through its presets,
//            or by its step when it has none
//   choice   a few options, all visible as buttons
//   select   a longer list
//   path     a file, chosen through the matching menu item's dialog
//
// A number row with an estimate gets a read-only row under it: how long that
// many visits take at the engine's measured speed.
//
// A row either names a config key, or supplies get() and set() for values that
// aren't a single key. Changes go through hub.set(), so every follow-up action
// (redraws, restarting a search, menu checkmarks, saving) is the menu's own.

const colour_choices = require("./colour_choices");
const colour_gradients = require("./colour_gradients");

// ---------------------------------------------------------------------------------------------------------------------------
// Option lists.

const NUMBER_TYPES = [
	"Winrate + Visits", "LCB + Visits", "Score + Visits", "Delta + Visits", "Order + Visits",
	"Winrate", "LCB", "Score", "Delta", "Visits", "Visits (%)", "Order", "Policy",
	"Winrate + Visits + Score", "LCB + Visits + Score",
];

const NUMBER_TYPE_KEYS = {
	"Winrate": "MENU_NUM_WINRATE",
	"LCB": "MENU_NUM_LCB",
	"Score": "MENU_NUM_SCORE",
	"Delta": "MENU_NUM_DELTA",
	"Visits": "MENU_NUM_VISITS",
	"Visits (%)": "MENU_NUM_VISITS_PC",
	"Order": "MENU_NUM_ORDER",
	"Policy": "MENU_NUM_POLICY",
};

function number_type_options() {
	let {translate} = require("./translate");
	return NUMBER_TYPES.map(value => [value, value.split(" + ").map(s => translate(NUMBER_TYPE_KEYS[s])).join(" + ")]);
}

function gradient_options() {
	return colour_gradients.items.filter(item => item.id).map(item => [item.id, item.label || colour_gradients.label_of(item.id)]);
}

function colour_pair_options() {
	return colour_choices.items.map((item, i) => item.opts ? [i, item.label] : null).filter(Boolean);
}

function current_colour_pair() {
	let i = colour_choices.items.findIndex(item => item.opts && Object.entries(item.opts).every(([k, v]) => config[k] === v));
	return i === -1 ? null : i;
}

function language_options() {
	return require("./translate").all_languages().map(language => [language, language]);
}

const INFO_BAR_ITEMS = [
	["rules", "Info bar: rules"],
	["toplay", "Info bar: whose turn"],
	["caps", "Info bar: captures"],
	["komi", "Info bar: komi"],
	["score", "Info bar: score"],
	["show", "Info bar: number type"],
	["visits", "Info bar: visits"],
];

const SECTIONS = [
	["quality", "Move quality"],
	["breadth", "Choice breadth history"],
	["status", "Game status"],
	["distribution", "Current candidate values"],
	["turn", "Turn"],
	["lastmove", "Last move"],
	["outcome", "Outcome"],
	["options", "Next move options"],
	["history", "Eval history"],
	["comments", "Comments"],
	["tree", "Variation tree"],
];

const CHARSETS = ["utf-8", "shift_jis", "euc-jp", "euc-kr", "gbk", "big5", "latin1", "windows-1251", "koi8-r"];

const SCALE_OPTIONS = [["linear", "linear"], ["log2", "log₂"]];

function info_item_row(id, label) {
	return {
		type: "toggle", label, find: "info bar",
		get: () => board_drawer.visible_info_items().includes(id),
		set: (on) => {
			let items = board_drawer.visible_info_items().filter(x => x !== id);
			if (on) {
				items.push(id);
			}
			hub.set("info_bar_items", items);
		},
	};
}

function section_row(sec, label) {
	return {
		type: "toggle", label, find: "move report card section panel",
		get: () => move_report.visible_sections().includes(sec),
		set: (on) => {
			let visible = move_report.visible_sections().filter(s => s !== sec);
			if (on) {
				visible.push(sec);
			}
			hub.set("move_report_sections", visible);
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------------------
// The cards, in display order.

exports.groups = [
	{
		id: "analysis",
		title: "Analysis",
		rows: [
			{type: "number", key: "ponder_visits", label: "Visit limit per position", unit: "visits", format: "count", integer: true,
				min: 2, max: 1000000000, presets: () => config.ponder_visit_options, estimate: "per position",
				find: "nodes playouts maxvisits ponder search stop space"},
			{type: "number", key: "autoanalysis_visits", label: "Autoanalysis / engine visits", unit: "visits", format: "count", integer: true,
				min: 2, max: 1000000000, presets: () => config.visit_options, estimate: "per move",
				find: "nodes playouts maxvisits self-play autoplay engine plays"},
			{type: "number", key: "wide_root_noise", label: "Wide root noise", decimals: 2, min: 0, max: 1,
				presets: [0, 0.01, 0.02, 0.03, 0.04, 0.05]},
			{type: "select", key: "ownership_marks", label: "Ownership",
				options: [[0, "none"], [1, "dead stones"], [2, "whole board"], [3, "whole board (alt)"]]},
			{type: "toggle", key: "ownership_per_move", label: "Per-move ownership (costly)"},
			{type: "number", key: "analysis_pv_len", label: "Variation length shown (max)", unit: "moves", integer: true, min: 1, max: 32,
				presets: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30], find: "pv principal"},
		],
	},
	{
		id: "candidates",
		title: "Candidates on the board",
		rows: [
			{type: "toggle", key: "candidate_moves", label: "Show candidate moves"},
			{type: "choice", key: "candidate_filter", label: "Which candidates",
				options: [["cost", "points from best"], ["count", "best + N"]], find: "filter cutoff"},
			{type: "number", key: "cost_threshold", label: "Points from best: at most", unit: "pts", decimals: 2, min: 0, max: 100,
				zero_label: "all", presets: () => [0, ...require("./config_io").cost_threshold_options],
				then: {candidate_filter: "cost"}, find: "filter cutoff threshold"},
			{type: "number", key: "candidate_count", label: "Best + N: extra moves", unit: "moves", integer: true, min: 0, max: 1000,
				presets: () => require("./config_io").candidate_count_options, then: {candidate_filter: "count"}, find: "filter count"},
			{type: "number", key: "candidate_min_visits", label: "Best + N: visits needed", unit: "visits", format: "count", integer: true,
				min: 0, max: 1000000000, presets: [0, 10, 25, 50, 100, 250, 500, 1000], find: "filter minimum flicker"},
			{type: "toggle", key: "always_show_next_move_eval", label: "Show every variation's next move",
				find: "next move eval played game tree subtree continuation options table"},
			{type: "toggle", key: "mark_explored_moves", label: "Mark explored moves", find: "explored searched rounded square shape"},
			{type: "toggle", key: "basis_point_display", label: "Use basis point display",
				find: "loss cost delta hundredths points decimal star"},
			{type: "select", key: "numbers", label: "Numbers on candidates", options: number_type_options, find: "delta winrate score visits"},
			{type: "select", key: "candidate_gradient", label: "Colour gradient", options: gradient_options, find: "palette colours"},
			{type: "select", label: "Classic colour pair", options: colour_pair_options, get: current_colour_pair,
				set: (i) => hub.apply_colour_settings(colour_choices.items[i].opts), find: "colours menu top off"},
			{type: "toggle", key: "visit_colours", label: "Fade low-visit candidates"},
			{type: "toggle", key: "no_ponder_no_candidates", label: "Only while analysing"},
			{type: "toggle", key: "black_pov", label: "Numbers from Black's view"},
			{type: "toggle", key: "mouseover_pv", label: "Show variation on hover", find: "pv mouseover"},
			{type: "number", key: "mouseover_delay", label: "Hover delay before variation", unit: "s", decimals: 1, min: 0, max: 10,
				presets: [0, 0.2, 0.4, 0.6, 0.8], find: "pv mouseover"},
			{type: "toggle", key: "next_move_markers", label: "Mark the game's next move"},
		],
	},
	{
		id: "board",
		title: "Board and info bar",
		rows: [
			{type: "toggle", key: "coordinates", label: "Coordinates"},
			{type: "toggle", key: "embiggen_small_boards", label: "Enlarge small boards", find: "embiggen"},
			{type: "number", key: "board_line_width", label: "Grid line width", unit: "px", integer: true, min: 1, max: 8, presets: [1, 2, 3, 4]},
			{type: "toggle", key: "stone_counts", label: "Stone counts instead of captures"},
			{type: "toggle", key: "info_bar_show_players", label: "Info bar: player names", find: "info bar"},
			...INFO_BAR_ITEMS.map(([id, label]) => info_item_row(id, label)),
		],
	},
	{
		id: "engine",
		title: "Engine",
		rows: [
			{type: "path", key: "engine", label: "KataGo", menu: ["MENU_SETUP", "MENU_LOCATE_KATAGO"], find: "executable binary"},
			{type: "path", key: "engineconfig", label: "Analysis config", menu: ["MENU_SETUP", "MENU_LOCATE_KATAGO_ANALYSIS_CONFIG"], find: "cfg"},
			{type: "path", key: "weights", label: "Network", menu: ["MENU_SETUP", "MENU_CHOOSE_WEIGHTS"], find: "weights model net"},
			{type: "number", key: "report_every", label: "Report interval", unit: "s", decimals: 2, min: 0.02, max: 5,
				presets: [0.1, 0.15, 0.2, 0.3, 0.4], find: "rate"},
			{type: "toggle", key: "fast_first_report", label: "Fast first report"},
		],
	},
	{
		id: "layout",
		title: "Layout and text",
		rows: [
			{type: "number", key: "zoom_factor", label: "UI zoom", unit: "%", scale: 100, decimals: 0, min: 0.5, max: 3,
				presets: [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3], find: "scale size"},
			{type: "number", key: "info_font_size", label: "Text size", unit: "px", integer: true, min: 8, max: 64,
				presets: [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32], find: "font info"},
			{type: "toggle", key: "show_tab_strip", label: "Tab strip", find: "thumbnails"},
			{type: "number", key: "thumbnail_square_size", label: "Tab thumbnail point size", unit: "px", integer: true, min: 1, max: 16,
				presets: [4, 6, 8]},
			{type: "number", key: "comment_box_height", label: "Comment box height", unit: "px", integer: true, min: 0, max: 4000,
				presets: [0, 128, 256, 384, 512]},
			{type: "number", key: "tree_pane_height", label: "Variation tree height", unit: "px", integer: true, min: 80, max: 4000, step: 40},
			{type: "number", key: "tree_spacing", label: "Variation tree spacing", unit: "px", integer: true, min: 8, max: 96,
				presets: [24, 28, 32, 36, 40, 44, 48]},
		],
	},
	{
		id: "move_report",
		title: "Move Report",
		rows: [
			// Width and chart height use the same limits as the panel's own −/+ controls (LIMITS in move_report.js).
			{type: "number", key: "move_report_width", label: "Card width", unit: "px", integer: true, min: 320, max: 1280, step: 40},
			{type: "number", key: "move_report_chart_height", label: "Chart height", unit: "px", integer: true, min: 90, max: 4000, step: 20},
			{type: "select", key: "move_report_breadth_view", label: "Breadth view", options_from: "mr_breadth_view"},
			{type: "number", key: "move_report_distribution_top_n", label: "Candidate values: top N", integer: true, min: 0, max: 1000,
				zero_label: "all", presets: [0, 5, 10, 20, 50, 100], find: "distribution"},
			{type: "choice", key: "move_report_quality_yscale", label: "Move quality scale", options: SCALE_OPTIONS},
			{type: "toggle", key: "move_report_quality_windowed", label: "Move quality: last N moves only", find: "window"},
			{type: "number", key: "move_report_quality_window_n", label: "Move quality: N", unit: "moves", integer: true, min: 1, max: 1000,
				presets: [10, 20, 40, 60, 100, 200], find: "window"},
			{type: "choice", key: "move_report_status_yscale", label: "Game status scale", options: SCALE_OPTIONS},
			{type: "toggle", key: "move_report_status_windowed", label: "Game status: last N moves only", find: "window"},
			{type: "number", key: "move_report_status_window_n", label: "Game status: N", unit: "moves", integer: true, min: 1, max: 1000,
				presets: [10, 20, 40, 60, 100, 200], find: "window"},
			{type: "choice", key: "move_report_history_xscale", label: "Eval history visits axis", options: [["log", "log"], ["linear", "linear"]]},
		],
	},
	{
		id: "move_report_cards",
		title: "Move Report cards shown",
		rows: SECTIONS.map(([sec, label]) => section_row(sec, label)),
	},
	{
		id: "games",
		title: "Games",
		rows: [
			{type: "toggle", key: "load_at_end", label: "Open games at the final position"},
			{type: "toggle", key: "guess_ruleset", label: "Guess rules from komi"},
			{type: "toggle", key: "tygem_3", label: "Tygem handicap-3 layout"},
			{type: "choice", key: "default_rules", label: "Rules if unspecified",
				options: [["Chinese", "Chinese"], ["Japanese", "Japanese"], ["Stone Scoring", "stone scoring"]],
				find: "default new games unknown sgf"},
			{type: "number", key: "default_komi", label: "Komi for new boards", decimals: 1, min: -150, max: 150,
				presets: () => config.komi_options, find: "default"},
		],
	},
	{
		id: "charsets",
		title: "SGF charset detection",
		rows: CHARSETS.map(name => ({type: "toggle", key: `charset_${name}`, label: name, find: "sgf encoding charset"})),
	},
	{
		id: "app",
		title: "App",
		rows: [
			{type: "select", key: "language", label: "Language (needs restart)", options: language_options},
			{type: "toggle", key: "confirm_quit", label: "Confirm before quitting"},
			{type: "toggle", key: "enable_hw_accel", label: "GUI hardware acceleration (needs restart)"},
			{type: "number", key: "autoscroll_delay", label: "Autoscroll delay", unit: "s", decimals: 1, min: 0.1, max: 60,
				presets: [0.5, 1, 2, 3, 4, 5]},
			{type: "toggle", key: "zobrist_checks", label: "Zobrist mismatch checks"},
			{type: "path", label: "config.json", get: () => require("./config_io").filepath, menu: ["MENU_DEV", "MENU_SHOW_CONFIG_FILE"],
				button: "show", find: "file settings"},
		],
	},
];

// ---------------------------------------------------------------------------------------------------------------------------
// Number helpers. Values are in config units; "display" numbers are what the user
// reads and types (the same, except UI zoom, shown as a percentage).

const EPSILON = 1e-9;

function presets_of(row) {
	let list = typeof row.presets === "function" ? row.presets() : row.presets;
	return Array.isArray(list) ? list.filter(n => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b) : [];
}

exports.presets_of = presets_of;

exports.format_count = function(n) {
	return Math.round(n).toLocaleString("en-US");
};

exports.format_value = function(value, row) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return "";
	}
	if (row.zero_label && value === 0) {
		return row.zero_label;
	}
	let n = row.scale ? value * row.scale : value;
	if (row.format === "count") {
		return exports.format_count(n);
	}
	if (typeof row.decimals === "number") {
		return n.toFixed(row.decimals);
	}
	return String(n);
};

// Accepts what people type: "1,000,000", "1 000 000", "1m", "2.5k", "1e6", "0,5", "61%", "all".
// Returns a config-unit number, or null when the text isn't a number.

exports.parse_value = function(text, row) {
	let s = String(text).trim().toLowerCase().replace(/[\s_]/g, "");
	if (row.zero_label && s === row.zero_label) {
		return 0;
	}
	if (row.unit === "%" && s.endsWith("%")) {
		s = s.slice(0, -1);
	}
	let multiplier = 1;
	if (row.format === "count") {
		s = s.replace(/,/g, "");
		if (s.endsWith("k")) {
			multiplier = 1000;
			s = s.slice(0, -1);
		} else if (s.endsWith("m")) {
			multiplier = 1000000;
			s = s.slice(0, -1);
		}
	} else {
		s = s.replace(/,/g, ".");						// A decimal comma.
	}
	if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) {
		return null;
	}
	let n = Number(s) * multiplier;
	if (row.scale) {
		n /= row.scale;
	}
	if (!Number.isFinite(n)) {
		return null;
	}
	if (row.integer) {
		n = Math.round(n);
	} else if (typeof row.decimals === "number") {
		let places = row.decimals + (row.scale ? Math.round(Math.log10(row.scale)) : 0);
		n = Number(n.toFixed(places));
	}
	return n;
};

// Why a value can't be used, or null when it can.

exports.problem_with = function(value, row) {
	let range = `${exports.format_value(row.min, {...row, zero_label: null})}–${exports.format_value(row.max, {...row, zero_label: null})}`;
	if (value === null) {
		return `Type a number (${range}${row.zero_label ? `, or "${row.zero_label}"` : ""}).`;
	}
	if (value < row.min - EPSILON || value > row.max + EPSILON) {
		return `Must be ${range}${row.unit ? " " + row.unit : ""}${row.zero_label ? `, or "${row.zero_label}"` : ""}.`;
	}
	return null;
};

// The next value above (dir > 0) or below (dir < 0): the nearest preset beyond the
// current value, else a fixed step. A zero that means "all" sorts above every number.

exports.step_value = function(value, row, dir) {
	let infinite_zero = Boolean(row.zero_label);
	let rank = (n) => (infinite_zero && n === 0) ? Infinity : n;
	let presets = presets_of(row).map(rank).sort((a, b) => a - b);
	let current = rank(value);
	let result;

	if (presets.length > 0) {
		let candidates = dir > 0 ? presets.filter(p => p > current + EPSILON) : presets.filter(p => p < current - EPSILON);
		if (candidates.length === 0) {
			return value;
		}
		result = dir > 0 ? candidates[0] : candidates[candidates.length - 1];
	} else if (typeof row.step === "number" && Number.isFinite(current)) {
		result = current + (dir > 0 ? row.step : -row.step);
	} else {
		return value;
	}

	if (result === Infinity) {
		return 0;
	}
	result = Math.max(row.min, Math.min(row.max, result));
	return row.integer ? Math.round(result) : Number(result.toFixed(10));
};

// How long a visit limit takes at a measured speed: "≈17 min", at "990" visits/s.

exports.format_duration = function(seconds) {
	if (seconds < 90) {
		return `${Math.max(1, Math.round(seconds))} s`;
	}
	if (seconds < 90 * 60) {
		return `${Math.round(seconds / 60)} min`;
	}
	if (seconds < 48 * 3600) {
		return `${(seconds / 3600).toFixed(1)} h`;
	}
	return `${(seconds / 86400).toFixed(1)} days`;
};

exports.format_rate = function(visits_per_second) {
	return visits_per_second < 10000
		? exports.format_count(visits_per_second)
		: `${Math.round(visits_per_second / 1000)}k`;
};

exports.estimate = function(limit, visits_per_second) {
	if (typeof limit !== "number" || !(visits_per_second > 0)) {
		return "";
	}
	return `≈${exports.format_duration(limit / visits_per_second)}`;
};

// Every row, flattened, for the pane and the tests.

exports.all_rows = function() {
	let ret = [];
	for (let group of exports.groups) {
		for (let row of group.rows) {
			ret.push(Object.assign({group: group.id}, row));
		}
	}
	return ret;
};
