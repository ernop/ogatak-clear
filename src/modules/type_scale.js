"use strict";

// The app's entire type system. There are exactly SIX font sizes, all derived
// from the single user setting config.info_font_size (Sizes → Info font).
// Nothing anywhere may use an ad-hoc font size: DOM styling consumes the
// --fs-* CSS variables published here (see ogatak.css), and canvas text uses
// px() / canvas_font() below. See agents.md "UI conventions".
//
// JS never sets concrete style properties on our UI elements — it only
// publishes data as CSS custom properties; every actual style rule lives in
// ogatak.css.

const FACTORS = {
	hero:    1.6,		// The loudest element in a pane: turn banner, verdict, player names.
	emph:    1.25,		// Emphasised results: last-move line, game result, outcome table, toasts.
	body:    1.0,		// Default reading size (== info_font_size): tables, comments, board info bar.
	ui:      0.9,		// Chrome: controls bars, section headers, metadata.
	caption: 0.8,		// Secondary data: ranks, table headers, chart axis labels.
	fine:    0.7,		// Floor. Dense in-chart annotations only.
};

exports.px = (name) => {
	if (!FACTORS.hasOwnProperty(name)) {
		throw new Error(`type_scale.px(): unknown size "${name}"`);
	}
	return Math.round(config.info_font_size * FACTORS[name]);
};

exports.canvas_font = (name, weight = "") => {
	return `${weight ? weight + " " : ""}${exports.px(name)}px monospace`;
};

// Publish the scale to CSS. Called at startup (below) and whenever
// info_font_size changes (hub_settings.js).

exports.apply_to_css = () => {
	for (let name of Object.keys(FACTORS)) {
		document.documentElement.style.setProperty(`--fs-${name}`, exports.px(name) + "px");
	}
};

exports.apply_to_css();
