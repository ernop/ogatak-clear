"use strict";

// Continuous palettes for candidate-move value. t = 0 is the best available
// move, t = 1 is the worst currently on the scale (the Distance-from-best
// cutoff, or the worst displayed move when that filter is All).
//
// Stops are designed, not two-point lerps: mid colours are pushed off the
// wood (#d0ad75) so a circle never disappears into the board. Interpolation
// is linear-sRGB between adjacent stops.
//
// "classic" is not a palette: the board uses the Colours-menu top/off pair.

const CLASSIC = "classic";
const FALLBACK = "green_red";

const palettes = {
	green_red: {
		label: "Green → Dull red",
		stops: ["#12b86a", "#6fbf44", "#d2c247", "#d47b42", "#b14c46"],
	},
	teal_coral: {
		label: "Teal → Coral",
		stops: ["#2a9d8f", "#57c5a0", "#e9c46a", "#f4a261", "#e76f51"],
	},
	rdylgn: {
		label: "Green → Yellow → Red",
		stops: ["#1a9850", "#91cf60", "#d9ef8b", "#fc8d59", "#d73027"],
	},
	forest_brick: {
		label: "Forest → Brick",
		stops: ["#40916c", "#74c69d", "#e9d66d", "#d08c60", "#ae4334"],
	},
	viridis: {
		label: "Viridis",
		stops: ["#fde725", "#5ec962", "#21918c", "#3b528b", "#440154"],
	},
	cividis: {
		label: "Cividis",
		stops: ["#fdea45", "#d2c832", "#7f7b5c", "#213d6b", "#00204c"],
	},
	mint_rose: {
		label: "Mint → Rose",
		stops: ["#2ec4b6", "#7bd389", "#f4d35e", "#ee964b", "#e85d4c"],
	},
	ice_ember: {
		label: "Ice → Ember",
		stops: ["#56cfe1", "#72efdd", "#f2e863", "#f4a261", "#c44536"],
	},
};

function hex_to_rgb(hex) {
	return [
		parseInt(hex.slice(1, 3), 16),
		parseInt(hex.slice(3, 5), 16),
		parseInt(hex.slice(5, 7), 16),
	];
}

function srgb_to_linear(c) {
	let x = c / 255;
	return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linear_to_srgb(x) {
	let y = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
	return Math.max(0, Math.min(255, Math.round(y * 255)));
}

function mix_rgb(a, b, t) {
	let la = a.map(srgb_to_linear);
	let lb = b.map(srgb_to_linear);
	return [
		linear_to_srgb(la[0] + (lb[0] - la[0]) * t),
		linear_to_srgb(la[1] + (lb[1] - la[1]) * t),
		linear_to_srgb(la[2] + (lb[2] - la[2]) * t),
	];
}

function rgb_to_hex(rgb) {
	return "#" + rgb.map(c => {
		let s = c.toString(16);
		return s.length === 1 ? "0" + s : s;
	}).join("") + "ff";
}

function stops_of(id) {
	let palette = palettes[id] || palettes[FALLBACK];
	return palette.stops.map(hex_to_rgb);
}

exports.CLASSIC = CLASSIC;
exports.FALLBACK = FALLBACK;

exports.items = [
	{id: "green_red"},
	{id: "teal_coral"},
	{id: "rdylgn"},
	{id: "forest_brick"},
	{type: "separator"},
	{id: "viridis"},
	{id: "cividis"},
	{type: "separator"},
	{id: "mint_rose"},
	{id: "ice_ember"},
	{type: "separator"},
	{id: CLASSIC, label: "Classic (Colours menu)"},
];

exports.label_of = function(id) {
	if (id === CLASSIC) {
		return "Classic (Colours menu)";
	}
	return palettes[id] ? palettes[id].label : "?";
};

exports.has = function(id) {
	return id === CLASSIC || palettes.hasOwnProperty(id);
};

exports.is_classic = function(id) {
	return id === CLASSIC;
};

exports.colour_at = function(id, t) {
	if (typeof t !== "number" || !Number.isFinite(t)) {
		t = 0;
	}
	if (t < 0) t = 0;
	if (t > 1) t = 1;

	let stops = stops_of(id === CLASSIC ? FALLBACK : id);
	if (stops.length === 1) {
		return rgb_to_hex(stops[0]);
	}

	let scaled = t * (stops.length - 1);
	let i = Math.min(stops.length - 2, Math.floor(scaled));
	return rgb_to_hex(mix_rgb(stops[i], stops[i + 1], scaled - i));
};

exports.colour_for_cost = function(id, cost, cap) {
	let t = 0;
	if (typeof cost === "number" && cap > 0) {
		t = Math.min(1, Math.max(0, cost / cap));
	}
	return exports.colour_at(id, t);
};
