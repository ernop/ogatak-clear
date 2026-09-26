"use strict";

// The Settings pane: every setting in one place. It covers the Move Report in the
// right-hand column, so the board stays live beside it and a change can be judged
// the moment it is made. Rows come from settings_schema.js; every change goes
// through hub.set() exactly like a menu click, so it applies at once and saves
// itself. See PRODUCT-workspace.md "Settings pane".
//
// Styling follows agents.md "UI conventions": text sizes come from the --fs-*
// type scale, and JS only toggles classes or publishes CSS custom properties;
// every style rule lives in ogatak.css.

const {ipcRenderer} = require("electron");
const schema = require("./settings_schema");
const eval_history = require("./eval_history");
const {translate} = require("./translate");
const {safe_html} = require("./utils");

const MIN_ESTIMATE_SECONDS = 2;			// A search younger than this hasn't settled to its real speed.
const MIN_ESTIMATE_VISITS = 1000;

function options_of(row) {
	if (row.options_from) {
		return Array.from(document.getElementById(row.options_from).options, o => [o.value, o.textContent]);
	}
	return typeof row.options === "function" ? row.options() : row.options;
}

function input_chars(row) {
	let samples = schema.presets_of(row).map(n => schema.format_value(n, row));
	if (samples.length === 0) {
		samples.push(schema.format_value(row.max, row));
	}
	return Math.max(3, ...samples.map(s => s.length)) + 1;
}

function row_html(row, i, options) {

	let label = `<span class="st_label_text">${safe_html(row.label)}</span>`;
	let ctl = "";

	if (row.type === "toggle") {
		ctl = `<button class="st_btn st_toggle" data-i="${i}"></button>`;
	} else if (row.type === "choice") {
		ctl = `<span class="st_seg">` +
			options.map((o, j) => `<button class="st_btn st_seg_btn" data-i="${i}" data-j="${j}">${safe_html(o[1])}</button>`).join("") +
			`</span>`;
	} else if (row.type === "select") {
		ctl = `<select class="st_select" data-i="${i}">` +
			options.map((o, j) => `<option value="${j}">${safe_html(o[1])}</option>`).join("") +
			`<option value="custom" class="hidden"></option>` +
			`</select>`;
	} else if (row.type === "number") {
		ctl = `<button class="st_btn st_step" data-i="${i}" data-dir="-1" tabindex="-1" title="Previous value">−</button>` +
			`<input class="st_num" data-i="${i}" type="text" spellcheck="false" autocomplete="off" aria-label="${safe_html(row.label)}">` +
			`<button class="st_btn st_step" data-i="${i}" data-dir="1" tabindex="-1" title="Next value">+</button>` +
			`<span class="st_unit">${safe_html(row.unit || "")}</span>`;
	} else if (row.type === "path") {
		label = `<span class="st_label_text st_keep">${safe_html(row.label)}</span><span class="st_path"><bdi></bdi></span>`;
		ctl = `<button class="st_btn st_menu" data-i="${i}">${safe_html(row.button || "choose…")}</button>`;
	} else {
		throw new Error(`settings_pane: unknown row type "${row.type}"`);
	}

	let html = `<div class="st_row" data-i="${i}"><span class="st_label">${label}</span><span class="st_ctl">${ctl}</span></div>`;

	if (row.estimate) {
		html += `<div class="st_row st_info" data-for="${i}"><span class="st_label"><span class="st_label_text"></span></span>` +
			`<span class="st_ctl"><span class="st_value"></span><span class="st_unit"></span></span></div>`;
	}

	return html;
}

function init() {

	let outer = document.getElementById("settings");
	let rows = [];			// {def, el, ...controls}, indexed by data-i.
	let cards = [];
	let parts = [];

	parts.push(`<div class="st_head">`);
	parts.push(`<span class="st_title">SETTINGS</span>`);
	parts.push(`<span class="st_saved">saved automatically</span>`);
	parts.push(`<label class="st_find">find <input id="st_find" type="text" spellcheck="false" autocomplete="off"></label>`);
	parts.push(`<button class="st_btn st_close" data-act="close" title="Close (Esc, Ctrl+,)">close ✕</button>`);
	parts.push(`</div>`);
	parts.push(`<div class="st_cards">`);

	for (let group of schema.groups) {
		parts.push(`<section class="st_card" data-group="${group.id}">`);
		parts.push(`<div class="st_card_title">${safe_html(group.title)}</div>`);
		for (let def of group.rows) {
			let options = (def.type === "choice" || def.type === "select") ? options_of(def) : null;
			let i = rows.length;
			rows.push({def, options, group});
			parts.push(row_html(def, i, options));
		}
		parts.push(`</section>`);
	}

	parts.push(`</div>`);
	parts.push(`<div class="st_empty hidden"></div>`);

	outer.innerHTML = parts.join("\n");

	for (let [i, r] of rows.entries()) {
		r.el = outer.querySelector(`.st_row[data-i="${i}"]`);
		r.button = r.el.querySelector(".st_toggle");
		r.buttons = Array.from(r.el.querySelectorAll(".st_seg_btn"));
		r.select = r.el.querySelector(".st_select");
		r.input = r.el.querySelector(".st_num");
		r.path = r.el.querySelector(".st_path bdi");
		r.info_el = outer.querySelector(`.st_info[data-for="${i}"]`);
		if (r.info_el) {
			r.info_label = r.info_el.querySelector(".st_label_text");
			r.info_value = r.info_el.querySelector(".st_value");
		}
		r.haystack = [
			r.def.label, r.def.key || "", r.def.find || "", r.def.unit || "", r.group.title,
			...(r.options || []).map(o => o[1]),
		].join(" ").toLowerCase();
		if (r.input) {
			r.input.style.setProperty("--st-chars", input_chars(r.def).toString());
		}
	}

	for (let el of outer.querySelectorAll(".st_card")) {
		cards.push({el, rows: rows.filter(r => r.el.parentElement === el)});
	}

	let ret = Object.assign(Object.create(settings_pane_prototype), {
		outer,
		rows,
		cards,
		find: document.getElementById("st_find"),
		empty: outer.querySelector(".st_empty"),
		visible: false,
		refresh_frame: null,
		note_timer: null,
	});

	// Buttons act on click but never take focus from a mouse press, so Space afterwards
	// still reaches the board (Go / halt) instead of pressing the same button again.

	outer.addEventListener("mousedown", (event) => {
		if (event.target.closest("button")) {
			event.preventDefault();
		}
	});

	outer.addEventListener("click", (event) => {
		let button = event.target.closest("button");
		if (!button) {
			return;
		}
		if (button.dataset.act === "close") {
			ret.hide();
			return;
		}
		let r = rows[button.dataset.i];
		if (!r) {
			return;
		}
		if (button.classList.contains("st_toggle")) {
			ret.apply(r, !ret.value_of(r));
		} else if (button.classList.contains("st_seg_btn")) {
			ret.apply(r, r.options[button.dataset.j][0]);
		} else if (button.classList.contains("st_step")) {
			ret.step(r, Number(button.dataset.dir));
		} else if (button.classList.contains("st_menu")) {
			ipcRenderer.send("menu_click", r.def.menu.map(k => translate(k)));
		}
	});

	outer.addEventListener("change", (event) => {
		let select = event.target.closest(".st_select");
		if (select && select.value !== "custom") {
			let r = rows[select.dataset.i];
			ret.apply(r, r.options[select.value][0]);
		}
	});

	outer.addEventListener("focusout", (event) => {
		if (event.target.classList.contains("st_num")) {
			ret.commit(rows[event.target.dataset.i], false);
		}
	});

	outer.addEventListener("keydown", (event) => {
		let target = event.target;
		if (target === ret.find) {
			if (event.code === "Escape" && ret.find.value !== "") {
				event.preventDefault();						// Clears the filter; a second Esc closes the pane.
				ret.find.value = "";
				ret.filter();
			}
			return;
		}
		if (!target.classList.contains("st_num")) {
			return;
		}
		let r = rows[target.dataset.i];
		if (event.code === "Enter" || event.code === "NumpadEnter") {
			event.preventDefault();
			if (ret.commit(r, true)) {
				target.select();
			}
		} else if (event.code === "Escape") {
			event.preventDefault();						// Undoes the typing; a second Esc closes the pane.
			ret.refresh_row(r, true);
			target.blur();
		} else if (event.code === "ArrowUp" || event.code === "ArrowDown") {
			event.preventDefault();
			ret.step(r, event.code === "ArrowUp" ? 1 : -1);
			target.select();
		}
	});

	ret.find.addEventListener("input", () => {
		ret.filter();
	});

	// A press anywhere outside the pane gives the keyboard back to the board.

	window.addEventListener("mousedown", (event) => {
		if (ret.visible && !outer.contains(event.target) && outer.contains(document.activeElement)) {
			document.activeElement.blur();
		}
	});

	return ret;
}

let settings_pane_prototype = {

	show: function() {
		if (this.visible) {
			return;
		}
		this.visible = true;
		this.outer.classList.remove("hidden");
		move_report.outer.inert = true;					// Covered; keep Tab and clicks out of it.
		this.refresh();
		this.note_timer = setInterval(() => this.refresh_notes(), 1000);
	},

	hide: function() {
		if (!this.visible) {
			return;
		}
		if (this.outer.contains(document.activeElement)) {
			document.activeElement.blur();
		}
		this.visible = false;
		this.outer.classList.add("hidden");
		move_report.outer.inert = false;
		clearInterval(this.note_timer);
		this.note_timer = null;
	},

	toggle: function() {
		if (this.visible) {
			this.hide();
		} else {
			this.show();
		}
	},

	// ------------------------------------------------------------ values

	value_of: function(r) {
		return r.def.get ? r.def.get() : config[r.def.key];
	},

	apply: function(r, value) {
		let def = r.def;
		if (def.set) {
			def.set(value);
		} else {
			if (config[def.key] !== value) {
				hub.set(def.key, value);
			}
			for (let [key, v] of Object.entries(def.then || {})) {		// Even when the value was unchanged: typing it says "use this".
				if (config[key] !== v) {
					hub.set(key, v);
				}
			}
		}
		this.refresh();
	},

	step: function(r, dir) {
		let saved = this.value_of(r);
		let from = saved;
		if (document.activeElement === r.input) {						// Step from what's typed, if it's usable.
			let typed = schema.parse_value(r.input.value, r.def);
			if (schema.problem_with(typed, r.def) === null) {
				from = typed;
			}
		}
		let next = schema.step_value(from, r.def, dir);
		if (next !== saved) {
			this.apply(r, next);
		}
		this.refresh_row(r, true);
	},

	// Reads the typed text. When it can't be used: with report, says why and keeps the
	// text for fixing; without (focus left the field), goes back to the current value.

	commit: function(r, report) {
		let input = r.input;
		let value = schema.parse_value(input.value, r.def);
		let problem = schema.problem_with(value, r.def);
		if (problem) {
			if (report) {
				input.classList.add("st_invalid");
				input.setCustomValidity(problem);
				input.reportValidity();
			} else {
				this.refresh_row(r, true);
			}
			return false;
		}
		this.apply(r, value);
		this.refresh_row(r, true);
		return true;
	},

	// ------------------------------------------------------------ drawing

	refresh_soon: function() {
		if (!this.visible || this.refresh_frame !== null) {
			return;
		}
		this.refresh_frame = requestAnimationFrame(() => {
			this.refresh_frame = null;
			this.refresh();
		});
	},

	refresh: function() {
		if (!this.visible) {
			return;
		}
		for (let r of this.rows) {
			this.refresh_row(r, false);
		}
		this.refresh_notes();
	},

	refresh_row: function(r, overwrite_typing) {

		let def = r.def;
		let value = this.value_of(r);

		if (def.type === "toggle") {
			r.button.textContent = value ? "on" : "off";
			r.button.classList.toggle("st_on", Boolean(value));
			r.button.setAttribute("aria-pressed", value ? "true" : "false");

		} else if (def.type === "choice") {
			for (let [j, button] of r.buttons.entries()) {
				button.classList.toggle("st_on", r.options[j][0] === value);
			}

		} else if (def.type === "select") {
			let j = r.options.findIndex(o => o[0] === value);
			let custom = r.select.querySelector(`option[value="custom"]`);
			custom.classList.toggle("hidden", j !== -1);
			if (j === -1) {
				custom.textContent = value === null || value === undefined ? "custom" : `${value} (custom)`;
			}
			let wanted = j === -1 ? "custom" : j.toString();
			if (r.select.value !== wanted) {
				r.select.value = wanted;
			}

		} else if (def.type === "number") {
			if (overwrite_typing || document.activeElement !== r.input) {
				let text = schema.format_value(value, def);
				if (r.input.value !== text) {
					r.input.value = text;
				}
				r.input.classList.remove("st_invalid");
				r.input.setCustomValidity("");
			}

		} else if (def.type === "path") {
			let text = value || "not set";
			if (r.path.textContent !== text) {
				r.path.textContent = text;
				r.path.parentElement.title = value || "";
			}
		}
	},

	refresh_notes: function() {
		let rate = this.visits_per_second();
		for (let r of this.rows) {
			if (!r.info_el) {
				continue;
			}
			let label = rate ? `Time ${r.def.estimate} at ${schema.format_rate(rate)} visits/s` : `Time ${r.def.estimate}`;
			let value = rate ? schema.estimate(this.value_of(r), rate) : "not measured yet";
			if (r.info_label.textContent !== label) {
				r.info_label.textContent = label;
			}
			if (r.info_value.textContent !== value) {
				r.info_value.textContent = value;
			}
		}
	},

	// The engine's speed, measured on the search behind the analysis now displayed.

	visits_per_second: function() {
		let analysis = hub.node && hub.node.analysis;
		let search = analysis ? eval_history.get(analysis.id) : null;
		if (!search || search.times.length === 0) {
			return null;
		}
		let n = search.times.length;
		let seconds = search.times[n - 1];
		let visits = search.roots[n - 1];
		if (seconds < MIN_ESTIMATE_SECONDS || visits < MIN_ESTIMATE_VISITS) {
			return null;
		}
		return visits / seconds;
	},

	// ------------------------------------------------------------ find

	filter: function() {
		let words = this.find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		let shown = 0;
		for (let r of this.rows) {
			let match = words.every(w => r.haystack.includes(w));
			r.el.classList.toggle("hidden", !match);
			if (r.info_el) {
				r.info_el.classList.toggle("hidden", !match);
			}
			if (match) {
				shown++;
			}
		}
		for (let card of this.cards) {
			card.el.classList.toggle("hidden", !card.rows.some(r => !r.el.classList.contains("hidden")));
		}
		this.empty.classList.toggle("hidden", shown > 0);
		this.empty.textContent = shown > 0 ? "" : `No setting matches “${this.find.value.trim()}”.`;
	},
};

module.exports = init();
