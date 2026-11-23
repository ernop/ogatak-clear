"use strict";

// Dockview-backed unified workspace for the Go board, analysis panels, and
// Settings in ogatak-clear.
//
// Owns panel mounting, split/tab/float/maximize layout, built-in presets, and
// JSON persistence into config.workspace_layout. Persistent panel DOM elements
// (including #boardinfo, #gridder_board_graph, #treecanvas, #comments, #settings,
// and chart canvases) live in an off-screen pool whenever their panel is closed,
// so closing or rearranging panels never destroys canvases, textarea contents,
// or event listeners.

const dockview = require("../vendor/dockview/dockview-core.min.js");
const config_io = require("./config_io");

const LAYOUT_VERSION = 2;		// v2 unifies the Go board and Settings into Dockview.

const OGATAK_THEME = {
	name: "ogatak",
	className: "dockview-theme-ogatak",
	colorScheme: "dark",
	gap: 2,
};

const PANEL_SPECS = [
	{id: "board",        title: "Board"},
	{id: "history",      title: "Eval History"},
	{id: "options",      title: "Next Move Options"},
	{id: "corridor",     title: "Variation Space"},
	{id: "tree",         title: "Variation Tree"},
	{id: "status",       title: "Game Status"},
	{id: "quality",      title: "Move Quality"},
	{id: "comments",     title: "Comments"},
	{id: "lastmove",     title: "Last Move"},
	{id: "outcome",      title: "Outcome"},
	{id: "breadth",      title: "Choice Breadth"},
	{id: "distribution", title: "Candidate Profile"},
	{id: "turn",         title: "Turn"},
	{id: "settings",     title: "Settings", tray: false},
];

const PANEL_IDS = PANEL_SPECS.map(p => p.id);
const TRAY_PANEL_IDS = PANEL_SPECS.filter(p => p.tray !== false).map(p => p.id);
const PANEL_TITLES = Object.fromEntries(PANEL_SPECS.map(p => [p.id, p.title]));

const PRESETS = {
	review: "Review",
	explore: "Explore",
	compact: "Minimal",
};

function create_workspace(host_el, pool_el, panel_elements, callbacks) {

	let on_change = callbacks && callbacks.on_change ? callbacks.on_change : () => {};
	let on_panel_active = callbacks && callbacks.on_panel_active ? callbacks.on_panel_active : () => {};
	let on_panel_removed = callbacks && callbacks.on_panel_removed ? callbacks.on_panel_removed : () => {};
	let suppress_save = false;
	let save_timer = null;

	function park_element(id) {
		let el = panel_elements[id];
		if (el && el.parentElement !== pool_el) {
			pool_el.appendChild(el);
		}
	}

	let api = dockview.createDockview(host_el, {
		theme: OGATAK_THEME,
		defaultRenderer: "always",
		disableFloatingGroups: false,
		createComponent: (options) => {
			let panel_id = options.id;
			let wrapper = document.createElement("div");
			wrapper.className = "dv_panel_slot";
			return {
				element: wrapper,
				init: () => {
					let el = panel_elements[panel_id];
					if (el) {
						wrapper.appendChild(el);
					}
				},
				dispose: () => {
					park_element(panel_id);
				},
			};
		},
		getTabContextMenuItems: () => [
			"maximize",
			"float",
			"separator",
			"close",
			"closeOthers",
		],
	});

	function open_ids() {
		return api.panels.map(p => p.id).filter(id => PANEL_IDS.includes(id));
	}

	function schedule_save() {
		if (suppress_save) {
			return;
		}
		if (save_timer) {
			clearTimeout(save_timer);
		}
		save_timer = setTimeout(() => {
			save_timer = null;
			try {
				let json = api.toJSON();
				json.ogatak_version = LAYOUT_VERSION;
				config.workspace_layout = json;
				config.move_report_sections = open_ids().filter(id => id !== "settings");
				config_io.save_soon();
			} catch (err) {
				console.log("workspace save error:", err.toString());
			}
		}, 250);
	}

	function notify() {
		schedule_save();
		on_change(open_ids());
	}

	api.onDidLayoutChange(() => {
		notify();
	});

	api.onDidAddPanel(() => {
		notify();
	});

	api.onDidRemovePanel((panel) => {
		if (panel && PANEL_IDS.includes(panel.id)) {
			on_panel_removed(panel.id);
		}
		notify();
	});

	api.onDidActivePanelChange((panel) => {
		if (panel && PANEL_IDS.includes(panel.id)) {
			on_panel_active(panel.id);
		}
	});

	function add_panel(id, opts = {}) {
		if (!PANEL_IDS.includes(id)) {
			return null;
		}
		let existing = api.getPanel(id);
		if (existing) {
			if (!opts.inactive) {
				existing.api.setActive();
			}
			return existing;
		}
		let add_opts = {
			id,
			component: id,
			title: PANEL_TITLES[id],
			inactive: Boolean(opts.inactive),
		};
		if (opts.position) {
			add_opts.position = opts.position;
		}
		if (typeof opts.initialWidth === "number") {
			add_opts.initialWidth = opts.initialWidth;
		}
		if (typeof opts.initialHeight === "number") {
			add_opts.initialHeight = opts.initialHeight;
		}
		return api.addPanel(add_opts);
	}

	function remove_panel(id) {
		let panel = api.getPanel(id);
		if (panel) {
			api.removePanel(panel);
		}
	}

	function apply_preset(preset_name = "review", persist = true) {
		suppress_save = true;
		try {
			api.clear();
			for (let id of PANEL_IDS) {
				park_element(id);
			}

			let w = Math.max(800, host_el.clientWidth || 1280);
			let h = Math.max(460, host_el.clientHeight || 700);
			if (host_el.clientWidth > 0 && host_el.clientHeight > 0) {
				api.layout(host_el.clientWidth, host_el.clientHeight);
			}

			// Size the Go board column to fit a clean square board without empty
			// side margins on ultrawide screens, while giving analysis plenty of room.
			let board_w = Math.max(400, Math.min(Math.round(w * 0.54), Math.round(h + 40)));
			let right_w = Math.max(360, w - board_w);

			let p_board = add_panel("board");

			if (preset_name === "explore") {
				// Left: Go Board
				// Right-Top: Eval History + Move Quality (left) | Variation Space (right)
				// Right-Bottom: Next Move Options (left) | Variation Tree + Game Status + Comments (right)
				let p_hist = add_panel("history", {
					position: {referencePanel: p_board, direction: "right"},
					initialWidth: right_w,
				});
				add_panel("quality", {
					position: {referencePanel: p_hist, direction: "within"},
					inactive: true,
				});
				add_panel("corridor", {
					position: {referencePanel: p_hist, direction: "right"},
					initialWidth: Math.round(right_w * 0.48),
				});
				let p_opts = add_panel("options", {
					position: {referencePanel: p_hist, direction: "below"},
					initialHeight: Math.round(h * 0.48),
				});
				let p_tree = add_panel("tree", {
					position: {referencePanel: p_opts, direction: "right"},
					initialWidth: Math.round(right_w * 0.48),
				});
				add_panel("status", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
				add_panel("comments", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
			} else if (preset_name === "compact") {
				// Larger Go Board on the left, compact 2-stack on the right.
				let compact_board_w = Math.max(460, Math.min(Math.round(w * 0.64), Math.round(h + 40)));
				let compact_right_w = Math.max(320, w - compact_board_w);
				let p_opts = add_panel("options", {
					position: {referencePanel: p_board, direction: "right"},
					initialWidth: compact_right_w,
				});
				add_panel("corridor", {
					position: {referencePanel: p_opts, direction: "within"},
					inactive: true,
				});
				let p_tree = add_panel("tree", {
					position: {referencePanel: p_opts, direction: "below"},
					initialHeight: Math.round(h * 0.50),
				});
				add_panel("status", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
				add_panel("comments", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
			} else {
				// "review" (Default): fits 100% in viewport with zero outer scrollbars.
				// Left: Go Board (resizable by dragging splitter!)
				// Right-Top (50%): Eval History (active) + Move Quality
				// Right-Bottom-Left (52%): Next Move Options (active) + Variation Space
				// Right-Bottom-Right (48%): Variation Tree (active) + Game Status + Comments
				let p_hist = add_panel("history", {
					position: {referencePanel: p_board, direction: "right"},
					initialWidth: right_w,
				});
				add_panel("quality", {
					position: {referencePanel: p_hist, direction: "within"},
					inactive: true,
				});
				let p_opts = add_panel("options", {
					position: {referencePanel: p_hist, direction: "below"},
					initialHeight: Math.round(h * 0.50),
				});
				add_panel("corridor", {
					position: {referencePanel: p_opts, direction: "within"},
					inactive: true,
				});
				let p_tree = add_panel("tree", {
					position: {referencePanel: p_opts, direction: "right"},
					initialWidth: Math.round(right_w * 0.48),
				});
				add_panel("status", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
				add_panel("comments", {
					position: {referencePanel: p_tree, direction: "within"},
					inactive: true,
				});
			}
		} finally {
			suppress_save = false;
		}
		if (persist) {
			notify();
		} else {
			on_change(open_ids());
		}
	}

	function restore_from_config() {
		let saved = config.workspace_layout;
		if (saved && typeof saved === "object" && saved.ogatak_version === LAYOUT_VERSION && saved.grid && saved.panels) {
			let valid_panels = Object.keys(saved.panels).filter(id => PANEL_IDS.includes(id));
			if (valid_panels.length > 0) {
				let clean = {...saved};
				delete clean.ogatak_version;
				suppress_save = true;
				try {
					api.fromJSON(clean);
					if (open_ids().length > 0) {
						suppress_save = false;
						on_change(open_ids());
						return true;
					}
				} catch (err) {
					console.log("workspace restore failed, loading default preset:", err.toString());
				} finally {
					suppress_save = false;
				}
			}
		}
		apply_preset("review", true);
		return false;
	}

	function sync_open_panels(desired_ids) {
		if (!Array.isArray(desired_ids)) {
			return;
		}
		let wanted = new Set(desired_ids.filter(id => PANEL_IDS.includes(id)));
		let current = new Set(open_ids().filter(id => id !== "settings"));

		let changed = false;
		for (let id of current) {
			if (!wanted.has(id)) {
				remove_panel(id);
				changed = true;
			}
		}
		for (let id of wanted) {
			if (!current.has(id)) {
				add_panel(id);
				changed = true;
			}
		}
		if (changed) {
			notify();
		}
	}

	function focus_or_open(id) {
		let existing = api.getPanel(id);
		if (existing) {
			existing.api.setActive();
			return;
		}
		if (id === "board") {
			let first = api.panels[0];
			if (first) {
				add_panel("board", {position: {referencePanel: first, direction: "left"}});
			} else {
				add_panel("board");
			}
		} else {
			let non_board = api.panels.find(p => p.id !== "board" && p.id !== "settings");
			if (non_board) {
				add_panel(id, {position: {referencePanel: non_board, direction: "within"}});
			} else {
				let board_p = api.getPanel("board");
				if (board_p) {
					add_panel(id, {position: {referencePanel: board_p, direction: "right"}});
				} else {
					add_panel(id);
				}
			}
		}
		notify();
	}

	// Open Settings beside the Go board (never covering it!) so every change can
	// be judged live on the board while adjusting.

	function open_settings() {
		let existing = api.getPanel("settings");
		if (existing) {
			existing.api.setActive();
			return;
		}
		let anchor = api.panels.find(p => p.id !== "board" && p.id !== "settings");
		if (anchor) {
			add_panel("settings", {position: {referencePanel: anchor, direction: "within"}});
		} else {
			let board_p = api.getPanel("board");
			if (board_p) {
				add_panel("settings", {position: {referencePanel: board_p, direction: "right"}});
			} else {
				add_panel("settings");
			}
		}
		notify();
	}

	function close_settings() {
		remove_panel("settings");
	}

	return {
		api,
		open_ids,
		add_panel,
		remove_panel,
		focus_or_open,
		open_settings,
		close_settings,
		apply_preset,
		restore_from_config,
		sync_open_panels,
		is_open: (id) => Boolean(api.getPanel(id)),
		is_visible: (id) => {
			let p = api.getPanel(id);
			return Boolean(p && p.api.isVisible);
		},
	};
}

module.exports = {
	LAYOUT_VERSION,
	PANEL_SPECS,
	PANEL_IDS,
	TRAY_PANEL_IDS,
	PANEL_TITLES,
	PRESETS,
	create_workspace,
};
