/* ============================================================================
 * WebOS — settings.js (SystemSettings)
 * ----------------------------------------------------------------------------
 * Complete settings application providing seven tabs:
 *
 *   1. Appearance  — theme, wallpaper, accent, animations, transparency,
 *                     font size, taskbar position, clock format
 *   2. Account     — display name, username, password, avatar, dates
 *                     (uses window.Backend when online)
 *   3. Display     — zoom level, color temperature, motion, contrast,
 *                     screen reader hints
 *   4. Sound       — master volume, UI sounds, notifications, boot sound,
 *                     sound theme
 *   5. Privacy     — clear histories, hidden files, diagnostic data
 *   6. Keyboard    — full shortcuts reference + customizable shortcuts +
 *                     repeat speed/delay
 *   7. About       — ASCII logo, version, build info, installed apps,
 *                     storage usage, credits
 *
 * All settings:
 *   - Persist to localStorage immediately under "webos.settings.all"
 *   - Apply live (theme, wallpaper, etc.) without page refresh
 *   - Sync to backend (window.Backend) when online
 *
 * Self-registers with WindowManager as app id "settings".
 * Public API on window.SystemSettings.
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * 0. Constants
   * ========================================================================*/

  const APP_ID         = "settings";
  const APP_TITLE      = "Settings";
  const APP_ICON       = "⚙";
  const STORAGE_KEY    = "webos.settings.all";
  const STORAGE_SHORTC = "webos.settings.shortcuts";
  const STORAGE_HIDDEN = "webos.settings.showHidden";
  const SAVE_DEBOUNCE  = 350;

  const DEFAULTS = {
    "appearance.theme":           "dark",
    "appearance.wallpaper":       "aurora",
    "appearance.accent":          "#7c3aed",
    "appearance.animations":      true,
    "appearance.transparency":    true,
    "appearance.fontsize":        "medium",
    "appearance.taskbarPos":      "bottom",
    "appearance.clockFormat":     "24h",

    "display.zoom":               100,
    "display.colorTemp":          "normal",
    "display.reduceMotion":       false,
    "display.highContrast":       false,
    "display.screenReader":       false,

    "sound.master":               70,
    "sound.uiSounds":             true,
    "sound.notifSounds":          true,
    "sound.bootSound":            true,
    "sound.theme":                "default",

    "privacy.showHidden":         false,
    "privacy.diagnostics":        false,

    "keyboard.repeatSpeed":       50,
    "keyboard.repeatDelay":       450,
  };

  const THEME_LIST = [
    { id: "dark",      name: "Dark",      tag: "Default",        bg: "#0f1422", accent: "#7c3aed", accent2: "#06b6d4" },
    { id: "light",     name: "Light",     tag: "Daytime",        bg: "#f6f8fa", accent: "#0969da", accent2: "#1f883d" },
    { id: "midnight",  name: "Midnight",  tag: "Cool",           bg: "#0a0e1a", accent: "#3b82f6", accent2: "#8b5cf6" },
    { id: "sunset",    name: "Sunset",    tag: "Warm",           bg: "#1a1024", accent: "#f97316", accent2: "#ec4899" },
    { id: "forest",    name: "Forest",    tag: "Nature",         bg: "#0f1f15", accent: "#22c55e", accent2: "#84cc16" },
  ];

  const WALLPAPER_LIST = [
    { id: "aurora",  name: "Aurora",   gradient: "linear-gradient(135deg,#1e1b4b,#7c3aed,#06b6d4)" },
    { id: "cosmos",  name: "Cosmos",   gradient: "radial-gradient(ellipse at top,#1e293b,#0f172a)" },
    { id: "nebula",  name: "Nebula",   gradient: "linear-gradient(135deg,#831843,#6b21a8,#1e3a8a)" },
    { id: "sunset",  name: "Sunset",   gradient: "linear-gradient(135deg,#fbbf24,#f97316,#dc2626)" },
    { id: "ocean",   name: "Ocean",    gradient: "linear-gradient(135deg,#0c4a6e,#0369a1,#0891b2)" },
    { id: "forest",  name: "Forest",   gradient: "linear-gradient(135deg,#14532d,#15803d,#22c55e)" },
    { id: "neon",    name: "Neon",     gradient: "linear-gradient(135deg,#7e22ce,#db2777,#facc15)" },
    { id: "mono",    name: "Mono",     gradient: "linear-gradient(135deg,#1f2937,#374151,#6b7280)" },
    { id: "candy",   name: "Candy",    gradient: "linear-gradient(135deg,#fbcfe8,#a5f3fc,#bae6fd)" },
    { id: "abyss",   name: "Abyss",    gradient: "radial-gradient(circle at 30% 30%,#0f172a,#020617)" },
    { id: "solid",   name: "Solid",    gradient: "linear-gradient(135deg,#111827,#111827)" },
  ];

  const ACCENT_PRESETS = [
    "#7c3aed", "#06b6d4", "#10b981", "#f59e0b",
    "#ef4444", "#ec4899", "#8b5cf6", "#0ea5e9",
  ];

  const AVATARS = [
    "🐧", "🦊", "🐱", "🐶", "🐼", "🦁", "🐸", "🐙",
    "🤖", "👾", "🧙", "🧑‍💻", "🦄", "🐝", "🦉", "🦋",
  ];

  const CLOCK_FORMATS = [
    { id: "12h", name: "12-hour (1:30 PM)" },
    { id: "24h", name: "24-hour (13:30)" },
  ];

  const TASKBAR_POSITIONS = [
    { id: "bottom", name: "Bottom" },
    { id: "top",    name: "Top" },
  ];

  const FONTSIZE_OPTIONS = [
    { id: "small",  name: "Small",  px: 13 },
    { id: "medium", name: "Medium", px: 14 },
    { id: "large",  name: "Large",  px: 15 },
    { id: "xl",     name: "XL",     px: 17 },
  ];

  const ZOOM_LEVELS = [75, 100, 125, 150];

  const COLOR_TEMPS = [
    { id: "warm",   name: "Warm",   filter: "sepia(0.18) saturate(1.05)" },
    { id: "normal", name: "Normal", filter: "none" },
    { id: "cool",   name: "Cool",   filter: "hue-rotate(-8deg) saturate(1.03)" },
  ];

  const SOUND_THEMES = [
    { id: "default", name: "Default" },
    { id: "minimal", name: "Minimal" },
    { id: "retro",   name: "Retro" },
  ];

  const SHORTCUTS_REFERENCE = [
    { group: "Window Manager", items: [
      ["Alt + Tab",                  "Cycle through open windows"],
      ["Win + Up",                   "Maximize window"],
      ["Win + Down",                 "Minimize / restore window"],
      ["Win + Left / Right",         "Snap window left / right"],
      ["F11",                        "Toggle fullscreen window"],
      ["Esc",                        "Close active dialog"],
    ]},
    { group: "Apps", items: [
      ["Win + E",                    "Open File Manager"],
      ["Win + I",                    "Open Settings"],
      ["Win + T",                    "Open Terminal"],
      ["Win + R",                    "Run command (in Terminal)"],
      ["Win + Space",                "Open Start Menu"],
    ]},
    { group: "Terminal", items: [
      ["Tab",                        "Autocomplete command/path"],
      ["Up / Down",                  "Navigate command history"],
      ["Ctrl + R",                   "Reverse-search history"],
      ["Ctrl + L",                   "Clear screen"],
      ["Ctrl + C",                   "Interrupt / clear input"],
      ["Ctrl + Shift + T",           "New terminal tab"],
      ["Ctrl + + / -",               "Increase / decrease font"],
    ]},
    { group: "Text Editor", items: [
      ["Ctrl + S",                   "Save"],
      ["Ctrl + N",                   "New file"],
      ["Ctrl + O",                   "Open file"],
      ["Ctrl + F",                   "Find"],
      ["Ctrl + Z / Y",               "Undo / Redo"],
    ]},
    { group: "File Manager", items: [
      ["Enter",                      "Open file/folder"],
      ["Backspace",                  "Go up one directory"],
      ["F2",                         "Rename"],
      ["Delete",                     "Move to trash"],
      ["Ctrl + C / X / V",           "Copy / Cut / Paste"],
      ["Ctrl + A",                   "Select all"],
    ]},
  ];

  const TABS = [
    { id: "appearance", name: "Appearance", icon: "🎨", title: "Appearance",      subtitle: "Customise how WebOS looks." },
    { id: "account",    name: "Account",    icon: "👤", title: "Account",         subtitle: "Manage your user profile and credentials." },
    { id: "display",    name: "Display",    icon: "🖥",  title: "Display",         subtitle: "Visual zoom, color and accessibility." },
    { id: "sound",      name: "Sound",      icon: "🔊", title: "Sound",           subtitle: "System audio levels and theme." },
    { id: "privacy",    name: "Privacy",    icon: "🔒", title: "Privacy",         subtitle: "Clear local data and review options." },
    { id: "keyboard",   name: "Keyboard",   icon: "⌨",  title: "Keyboard",        subtitle: "Shortcuts and key behaviour." },
    { id: "about",      name: "About",      icon: "ℹ",  title: "About WebOS",     subtitle: "System information and credits." },
  ];

  /* ==========================================================================
   * 1. Tiny utility helpers
   * ========================================================================*/

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;")
      .replace(/'/g,  "&#39;");
  }

  function safeJSON(s) { if (!s) return null; try { return JSON.parse(s); } catch (_) { return null; } }

  function lsRead(key, def) {
    try {
      const v = localStorage.getItem(key);
      if (v == null) return def;
      return JSON.parse(v);
    } catch (_) { return def; }
  }

  function lsWrite(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const ctx  = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function fmtBytes(b) {
    if (!b && b !== 0) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
    return (b / 1024 / 1024 / 1024).toFixed(1) + " GB";
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    return d.toLocaleString();
  }

  /* ==========================================================================
   * 2. Settings store — single source of truth
   * ========================================================================*/

  const Store = (function () {
    const state = Object.assign({}, DEFAULTS, lsRead(STORAGE_KEY, {}));
    const listeners = [];

    function get(key) { return state[key]; }
    function getAll() { return Object.assign({}, state); }

    function set(key, value, opts) {
      opts = opts || {};
      const old = state[key];
      state[key] = value;
      lsWrite(STORAGE_KEY, state);
      listeners.forEach((fn) => {
        try { fn(key, value, old); } catch (e) { console.error("[Settings] listener:", e); }
      });
      // Sync to backend (debounced internally)
      if (!opts.skipBackend) syncOne(key, value);
    }

    function bulkSet(map, opts) {
      opts = opts || {};
      Object.keys(map).forEach((k) => {
        const old = state[k];
        state[k] = map[k];
        listeners.forEach((fn) => { try { fn(k, map[k], old); } catch (_) {} });
      });
      lsWrite(STORAGE_KEY, state);
      if (!opts.skipBackend) syncBulk(map);
    }

    function reset(prefix) {
      const removed = {};
      Object.keys(state).forEach((k) => {
        if (!prefix || k.startsWith(prefix)) {
          removed[k] = state[k];
          if (DEFAULTS[k] !== undefined) state[k] = DEFAULTS[k];
          else delete state[k];
        }
      });
      lsWrite(STORAGE_KEY, state);
      listeners.forEach((fn) => {
        Object.keys(removed).forEach((k) => {
          try { fn(k, state[k], removed[k]); } catch (_) {}
        });
      });
      // Best-effort: tell backend to reset that prefix
      if (window.Backend && window.Backend.isOnline()) {
        const keys = Object.keys(removed);
        if (keys.length) window.Backend.settings.reset(keys).catch(() => {});
      }
    }

    function on(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; }

    /* Backend sync helpers — debounced */
    const syncOne = debounce((key, value) => {
      if (!window.Backend || !window.Backend.isOnline() || !window.Backend.isAuthenticated()) return;
      window.Backend.settings.set(key, value).catch((e) => {
        console.warn("[Settings] backend set failed:", e.message);
      });
    }, SAVE_DEBOUNCE);

    const syncBulk = debounce((map) => {
      if (!window.Backend || !window.Backend.isOnline() || !window.Backend.isAuthenticated()) return;
      window.Backend.settings.bulk(map, false).catch((e) => {
        console.warn("[Settings] backend bulk failed:", e.message);
      });
    }, SAVE_DEBOUNCE);

    return { get, getAll, set, bulkSet, reset, on };
  })();

  /* When backend pushes settings down (e.g. on login), fold them in. */
  window.addEventListener("webos:settingsapplied", (e) => {
    const map = (e.detail && e.detail.map) || {};
    if (Object.keys(map).length === 0) return;
    Store.bulkSet(map, { skipBackend: true });
  });

  /* ==========================================================================
   * 3. Live appliers — the bridge that turns store changes into UI changes
   * ========================================================================*/

  function applyAll() {
    applyTheme(Store.get("appearance.theme"));
    applyWallpaper(Store.get("appearance.wallpaper"));
    applyAccent(Store.get("appearance.accent"));
    applyAnimations(!!Store.get("appearance.animations"));
    applyTransparency(!!Store.get("appearance.transparency"));
    applyFontSize(Store.get("appearance.fontsize"));
    applyTaskbarPos(Store.get("appearance.taskbarPos"));
    applyClockFormat(Store.get("appearance.clockFormat"));
    applyZoom(Store.get("display.zoom"));
    applyColorTemp(Store.get("display.colorTemp"));
    applyReduceMotion(!!Store.get("display.reduceMotion"));
    applyHighContrast(!!Store.get("display.highContrast"));
    applyShowHidden(!!Store.get("privacy.showHidden"));
  }

  function applyTheme(id) {
    if (!id) return;
    document.documentElement.setAttribute("data-theme", id);
    if (window.ThemeEngine && window.ThemeEngine.setTheme) {
      try { window.ThemeEngine.setTheme(id); } catch (_) {}
    }
  }

  function applyWallpaper(id) {
    if (!id) return;
    if (window.ThemeEngine && window.ThemeEngine.setWallpaper) {
      try { window.ThemeEngine.setWallpaper(id); return; } catch (_) {}
    }
    const wp = WALLPAPER_LIST.find((w) => w.id === id);
    if (wp) document.documentElement.style.setProperty("--wallpaper-bg", wp.gradient);
  }

  function applyAccent(color) {
    if (!color) return;
    document.documentElement.style.setProperty("--accent-1", color);
    if (window.ThemeEngine && window.ThemeEngine.setAccent) {
      try { window.ThemeEngine.setAccent(color); } catch (_) {}
    }
  }

  function applyAnimations(on) {
    document.documentElement.classList.toggle("no-anim", !on);
    if (window.ThemeEngine && window.ThemeEngine.setAnimations) {
      try { window.ThemeEngine.setAnimations(on); } catch (_) {}
    }
  }

  function applyTransparency(on) {
    document.documentElement.classList.toggle("no-glass", !on);
    document.documentElement.style.setProperty(
      "--glass-blur", on ? "12px" : "0px"
    );
  }

  function applyFontSize(id) {
    const f = FONTSIZE_OPTIONS.find((x) => x.id === id) || FONTSIZE_OPTIONS[1];
    document.documentElement.style.setProperty("--ui-font-size", f.px + "px");
    document.body.style.fontSize = f.px + "px";
  }

  function applyTaskbarPos(pos) {
    const tb = document.getElementById("taskbar");
    if (tb) tb.setAttribute("data-position", pos === "top" ? "top" : "bottom");
    document.documentElement.setAttribute("data-taskbar", pos === "top" ? "top" : "bottom");
  }

  function applyClockFormat(fmt) {
    document.documentElement.setAttribute("data-clock", fmt);
    if (window.Taskbar && window.Taskbar.tickClock) {
      try { window.Taskbar.tickClock(fmt); } catch (_) {}
    }
  }

  function applyZoom(pct) {
    const v = clamp(parseInt(pct, 10) || 100, 50, 200);
    document.documentElement.style.zoom = (v / 100).toString();
  }

  function applyColorTemp(id) {
    const t = COLOR_TEMPS.find((x) => x.id === id) || COLOR_TEMPS[1];
    document.documentElement.style.filter = t.filter;
  }

  function applyReduceMotion(on) {
    document.documentElement.classList.toggle("reduce-motion", on);
  }

  function applyHighContrast(on) {
    document.documentElement.classList.toggle("high-contrast", on);
  }

  function applyShowHidden(on) {
    try {
      lsWrite(STORAGE_HIDDEN, on);
      window.dispatchEvent(new CustomEvent("webos:showhiddenchange", { detail: { on } }));
    } catch (_) {}
  }

  /* Apply on load and on every store change */
  Store.on((key) => {
    if (key.startsWith("appearance."))     applyAll();
    else if (key.startsWith("display."))   applyAll();
    else if (key.startsWith("privacy."))   applyAll();
  });

  /* ==========================================================================
   * 4. SettingsApp — the window-bound UI
   * ========================================================================*/

  class SettingsApp {

    constructor(root, win) {
      this.root = root;
      this.win = win;
      this.activeTab = (win.opts && win.opts.tab) || "appearance";
      this._mounted = false;
      this._docHandlers = [];
      this._unsubStore = null;
      this._saveTimer = null;
      this._searchQuery = "";
    }

    /* ------------------------------------------------------------------ */
    /* Mount                                                              */
    /* ------------------------------------------------------------------ */

    async mount() {
      if (this._mounted) return;
      this._mounted = true;
      await this._injectHtml();
      this._injectCssOnce();
      this._cacheDom();
      this._wireSidebar();
      this._wireSearch();
      this._wireFooter();
      this._wireBackendEvents();

      this.renderTab(this.activeTab);
      this.renderAccountPill();
    }

    destroy() {
      if (this._unsubStore) this._unsubStore();
      this._docHandlers.forEach((fn) => document.removeEventListener("keydown", fn, true));
      this._docHandlers = [];
    }

    async _injectHtml() {
      try {
        const res = await fetch("apps/settings/settings.html");
        const txt = await res.text();
        this.root.innerHTML = txt;
      } catch (e) {
        // Fallback: build minimal shell inline
        this.root.innerHTML =
          '<div class="ossettings-root">' +
            '<aside class="osset-sidebar"><div class="osset-sidebar-header"><div class="osset-brand">' +
              '<span class="osset-brand-glyph">⚙</span><div class="osset-brand-text"><strong>System Settings</strong>' +
              '<small id="osset-brand-sub">WebOS 1.0</small></div></div></div>' +
              '<div class="osset-search"><input id="osset-search" class="osset-search-input" placeholder="Search…"/></div>' +
              '<nav id="osset-nav" class="osset-nav"></nav>' +
              '<footer class="osset-sidebar-footer"><div id="osset-account-pill" class="osset-account-pill" hidden>' +
              '<span class="osset-account-avatar" id="osset-account-avatar">🙂</span>' +
              '<span class="osset-account-text"><strong id="osset-account-name">—</strong>' +
              '<small id="osset-account-status">Offline</small></span></div>' +
              '<div class="osset-version" id="osset-version">v1.0</div></footer>' +
            '</aside>' +
            '<main class="osset-main">' +
              '<header class="osset-header"><div class="osset-header-left"><h2 id="osset-title">Settings</h2>' +
              '<p id="osset-subtitle" class="osset-subtitle">Loading…</p></div>' +
              '<div class="osset-header-right">' +
              '<span id="osset-savestate" class="osset-savestate" data-state="idle">All changes saved</span>' +
              '</div></header>' +
              '<div id="osset-panel" class="osset-panel"></div>' +
              '<footer class="osset-footer"><button id="osset-reset" class="osset-btn osset-btn-ghost">Reset category</button>' +
              '<div class="osset-footer-spacer"></div><span class="osset-hint" id="osset-footer-hint">Changes apply immediately.</span>' +
              '</footer>' +
            '</main></div>';
      }
    }

    _injectCssOnce() {
      if (document.getElementById("osset-css")) return;
      const link = document.createElement("link");
      link.id = "osset-css";
      link.rel = "stylesheet";
      link.href = "apps/settings/settings.css";
      document.head.appendChild(link);
    }

    _cacheDom() {
      this.rootEl     = $(".ossettings-root", this.root);
      this.navEl      = $("#osset-nav", this.root);
      this.searchEl   = $("#osset-search", this.root);
      this.titleEl    = $("#osset-title", this.root);
      this.subtitleEl = $("#osset-subtitle", this.root);
      this.panelEl    = $("#osset-panel", this.root);
      this.saveStateEl = $("#osset-savestate", this.root);
      this.resetBtn   = $("#osset-reset", this.root);
      this.acctPillEl = $("#osset-account-pill", this.root);
      this.acctAvEl   = $("#osset-account-avatar", this.root);
      this.acctNameEl = $("#osset-account-name", this.root);
      this.acctStatEl = $("#osset-account-status", this.root);
      this.footerHint = $("#osset-footer-hint", this.root);

      this.tplSection = $("#osset-tpl-section", this.root);
      this.tplRow     = $("#osset-tpl-row", this.root);
      this.tplToggle  = $("#osset-tpl-toggle", this.root);
      this.tplConfirm = $("#osset-tpl-confirm", this.root);

      this._renderSidebarItems();
    }

    _renderSidebarItems() {
      if (!this.navEl) return;
      this.navEl.innerHTML = "";
      const groupSystem = document.createElement("div");
      groupSystem.className = "osset-nav-group";
      groupSystem.textContent = "Categories";
      this.navEl.appendChild(groupSystem);
      TABS.forEach((tab) => {
        const btn = document.createElement("button");
        btn.className = "osset-nav-item";
        btn.dataset.tab = tab.id;
        btn.innerHTML =
          '<span class="osset-nav-icon">' + escapeHtml(tab.icon) + '</span>' +
          '<span class="osset-nav-label">' + escapeHtml(tab.name) + '</span>';
        btn.addEventListener("click", () => this.renderTab(tab.id));
        this.navEl.appendChild(btn);
      });
    }

    _wireSidebar() { /* already done in _renderSidebarItems */ }

    _wireSearch() {
      if (!this.searchEl) return;
      this.searchEl.addEventListener("input", () => {
        this._searchQuery = this.searchEl.value.trim().toLowerCase();
        this._applySearchHighlight();
      });
    }

    _applySearchHighlight() {
      const q = this._searchQuery;
      // Filter sidebar items by tab name + tab id
      $$(".osset-nav-item", this.navEl).forEach((b) => {
        if (!q) { b.style.display = ""; return; }
        const tab = TABS.find((t) => t.id === b.dataset.tab);
        const hay = (tab.name + " " + tab.id + " " + tab.title + " " + tab.subtitle).toLowerCase();
        b.style.display = hay.indexOf(q) >= 0 ? "" : "none";
      });
      // Highlight rows in the active panel
      $$(".osset-row", this.panelEl).forEach((r) => {
        if (!q) { r.style.display = ""; r.style.background = ""; return; }
        const hay = (r.textContent || "").toLowerCase();
        const match = hay.indexOf(q) >= 0;
        r.style.display = match ? "" : "none";
        r.style.background = match ? "rgba(124, 58, 237, 0.06)" : "";
      });
    }

    _wireFooter() {
      if (this.resetBtn) {
        this.resetBtn.addEventListener("click", () => {
          this._confirm({
            title: "Reset this category?",
            body: 'This will revert "' + this._tabTitle(this.activeTab) + '" settings to their defaults.',
            okText: "Reset",
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            Store.reset(this.activeTab + ".");
            this.renderTab(this.activeTab);
            this.flashSaved();
          });
        });
      }
    }

    _wireBackendEvents() {
      if (window.Backend && window.Backend.on) {
        const updates = ["online", "offline", "login", "logout"];
        updates.forEach((ev) => {
          window.Backend.on(ev, () => this.renderAccountPill());
        });
      }
    }

    _tabTitle(id) {
      const t = TABS.find((x) => x.id === id);
      return t ? t.title : id;
    }

    /* ------------------------------------------------------------------ */
    /* Save state badge                                                   */
    /* ------------------------------------------------------------------ */

    flashSaving() {
      if (!this.saveStateEl) return;
      this.saveStateEl.dataset.state = "saving";
      this.saveStateEl.textContent = "Saving…";
    }

    flashSaved() {
      if (!this.saveStateEl) return;
      this.saveStateEl.dataset.state = "idle";
      this.saveStateEl.textContent = "All changes saved";
    }

    flashError(msg) {
      if (!this.saveStateEl) return;
      this.saveStateEl.dataset.state = "error";
      this.saveStateEl.textContent = msg || "Save failed";
    }

    flagDirty() {
      this.flashSaving();
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.flashSaved(), 700);
    }

    /* ------------------------------------------------------------------ */
    /* Account pill                                                       */
    /* ------------------------------------------------------------------ */

    renderAccountPill() {
      if (!this.acctPillEl) return;
      const isAuthed = !!(window.Backend && window.Backend.isAuthenticated && window.Backend.isAuthenticated());
      const online = !!(window.Backend && window.Backend.isOnline && window.Backend.isOnline());
      this.acctPillEl.hidden = false;
      if (isAuthed) {
        const u = window.Backend.user();
        this.acctAvEl.textContent  = u.avatar || "🙂";
        this.acctNameEl.textContent = u.display_name || u.username || "User";
        this.acctStatEl.textContent = online ? "Connected" : "Offline cache";
        this.acctStatEl.style.color = online ? "var(--osset-success)" : "var(--osset-fg-faint)";
      } else if (online) {
        this.acctAvEl.textContent  = "👤";
        this.acctNameEl.textContent = "Not signed in";
        this.acctStatEl.textContent = "Backend online";
        this.acctStatEl.style.color = "var(--osset-success)";
      } else {
        this.acctAvEl.textContent  = "🙂";
        this.acctNameEl.textContent = "Local user";
        this.acctStatEl.textContent = "Backend offline";
        this.acctStatEl.style.color = "var(--osset-fg-faint)";
      }
    }

    /* ------------------------------------------------------------------ */
    /* Tab rendering dispatch                                             */
    /* ------------------------------------------------------------------ */

    renderTab(id) {
      if (!TABS.find((t) => t.id === id)) id = "appearance";
      this.activeTab = id;
      $$(".osset-nav-item", this.navEl).forEach((b) => b.classList.toggle("is-active", b.dataset.tab === id));
      const tab = TABS.find((t) => t.id === id);
      this.titleEl.textContent = tab.title;
      this.subtitleEl.textContent = tab.subtitle;
      this.panelEl.innerHTML = "";

      switch (id) {
        case "appearance": this.renderAppearance(); break;
        case "account":    this.renderAccount(); break;
        case "display":    this.renderDisplay(); break;
        case "sound":      this.renderSound(); break;
        case "privacy":    this.renderPrivacy(); break;
        case "keyboard":   this.renderKeyboard(); break;
        case "about":      this.renderAbout(); break;
      }
      this._applySearchHighlight();
    }

    /* ==================================================================== */
    /* SECTION + ROW BUILDERS                                                */
    /* ==================================================================== */

    _section(title, help) {
      let sec;
      if (this.tplSection && this.tplSection.content) {
        sec = this.tplSection.content.firstElementChild.cloneNode(true);
      } else {
        sec = document.createElement("section");
        sec.className = "osset-section";
        sec.innerHTML =
          '<h3 class="osset-section-title"></h3>' +
          '<p class="osset-section-help"></p>' +
          '<div class="osset-section-body"></div>';
      }
      $(".osset-section-title", sec).textContent = title;
      const helpEl = $(".osset-section-help", sec);
      if (help) helpEl.textContent = help;
      else helpEl.remove();
      this.panelEl.appendChild(sec);
      return $(".osset-section-body", sec);
    }

    _row(parent, label, help) {
      let row;
      if (this.tplRow && this.tplRow.content) {
        row = this.tplRow.content.firstElementChild.cloneNode(true);
      } else {
        row = document.createElement("div");
        row.className = "osset-row";
        row.innerHTML =
          '<div class="osset-row-info"><div class="osset-row-label"></div><div class="osset-row-help"></div></div>' +
          '<div class="osset-row-control"></div>';
      }
      $(".osset-row-label", row).textContent = label;
      const helpEl = $(".osset-row-help", row);
      if (help) helpEl.textContent = help;
      else helpEl.remove();
      parent.appendChild(row);
      return $(".osset-row-control", row);
    }

    _toggle(initial, onChange) {
      let btn;
      if (this.tplToggle && this.tplToggle.content) {
        btn = this.tplToggle.content.firstElementChild.cloneNode(true);
      } else {
        btn = document.createElement("button");
        btn.className = "osset-toggle";
        btn.setAttribute("role", "switch");
        btn.innerHTML = '<span class="osset-toggle-track"><span class="osset-toggle-thumb"></span></span>';
      }
      btn.setAttribute("aria-checked", String(!!initial));
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("aria-checked") !== "true";
        btn.setAttribute("aria-checked", String(next));
        try { onChange(next); } catch (_) {}
        this.flagDirty();
      });
      return btn;
    }

    _select(options, current, onChange, opts) {
      const sel = document.createElement("select");
      sel.className = "osset-select";
      options.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = (typeof o === "object") ? o.id : o;
        opt.textContent = (typeof o === "object") ? o.name : String(o);
        if ((typeof o === "object" ? o.id : o) === current) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => {
        try { onChange(sel.value); } catch (_) {}
        this.flagDirty();
      });
      if (opts && opts.minWidth) sel.style.minWidth = opts.minWidth + "px";
      return sel;
    }

    _slider(min, max, step, current, onChange, suffix) {
      const wrap = document.createElement("div");
      wrap.className = "osset-slider";
      const input = document.createElement("input");
      input.type = "range";
      input.className = "osset-slider-input";
      input.min = min; input.max = max; input.step = step || 1;
      input.value = String(current);
      const val = document.createElement("span");
      val.className = "osset-slider-value";
      val.textContent = current + (suffix || "");
      input.addEventListener("input", () => {
        val.textContent = input.value + (suffix || "");
      });
      input.addEventListener("change", () => {
        try { onChange(parseInt(input.value, 10)); } catch (_) {}
        this.flagDirty();
      });
      wrap.appendChild(input);
      wrap.appendChild(val);
      return wrap;
    }

    _button(text, onClick, variant) {
      const b = document.createElement("button");
      b.className = "osset-btn" + (variant ? " osset-btn-" + variant : "");
      b.textContent = text;
      b.addEventListener("click", () => onClick(b));
      return b;
    }

    _input(value, onChange, opts) {
      const inp = document.createElement("input");
      inp.className = "osset-input";
      inp.type = (opts && opts.type) || "text";
      if (opts && opts.placeholder) inp.placeholder = opts.placeholder;
      inp.value = value || "";
      let timer;
      inp.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { onChange(inp.value); } catch (_) {}
          this.flagDirty();
        }, 300);
      });
      return inp;
    }

    _confirm(opts) {
      return new Promise((resolve) => {
        let modal;
        if (this.tplConfirm && this.tplConfirm.content) {
          modal = this.tplConfirm.content.firstElementChild.cloneNode(true);
        } else {
          modal = document.createElement("div");
          modal.className = "osset-modal-backdrop";
          modal.innerHTML =
            '<div class="osset-modal"><h4 class="osset-modal-title"></h4>' +
            '<p class="osset-modal-body"></p>' +
            '<div class="osset-modal-actions">' +
              '<button class="osset-btn osset-btn-ghost" data-act="cancel">Cancel</button>' +
              '<button class="osset-btn osset-btn-danger" data-act="ok">Confirm</button>' +
            '</div></div>';
        }
        $(".osset-modal-title", modal).textContent = opts.title || "Confirm";
        $(".osset-modal-body",  modal).textContent = opts.body || "";
        const ok = $('[data-act="ok"]', modal);
        ok.textContent = opts.okText || "Confirm";
        if (!opts.danger) ok.classList.replace("osset-btn-danger", "osset-btn-primary");
        const close = (val) => { document.body.removeChild(modal); resolve(val); };
        ok.addEventListener("click", () => close(true));
        $('[data-act="cancel"]', modal).addEventListener("click", () => close(false));
        modal.addEventListener("click", (e) => { if (e.target === modal) close(false); });
        document.body.appendChild(modal);
      });
    }

    /* ==================================================================== */
    /* TAB: APPEARANCE                                                       */
    /* ==================================================================== */

    renderAppearance() {
      // ---- Theme ----
      let body = this._section("Theme", "Pick the colour palette WebOS uses for windows, panels and accents.");
      const themeGrid = document.createElement("div");
      themeGrid.className = "osset-theme-grid";
      THEME_LIST.forEach((t) => {
        const sw = document.createElement("button");
        sw.className = "osset-swatch";
        sw.dataset.value = t.id;
        if (Store.get("appearance.theme") === t.id) sw.classList.add("is-active");
        sw.innerHTML =
          '<div class="osset-swatch-preview" style="background:' +
            'linear-gradient(135deg,' + t.bg + ',' + t.accent + ')"></div>' +
          '<div class="osset-swatch-name">' + escapeHtml(t.name) + '</div>' +
          '<div class="osset-swatch-tag">' + escapeHtml(t.tag) + '</div>';
        sw.addEventListener("click", () => {
          $$(".osset-swatch", themeGrid).forEach((s) => s.classList.remove("is-active"));
          sw.classList.add("is-active");
          Store.set("appearance.theme", t.id);
          this.flagDirty();
        });
        themeGrid.appendChild(sw);
      });
      body.appendChild(themeGrid);

      // ---- Wallpaper ----
      body = this._section("Wallpaper", "Background image for the desktop. Combine with a theme for the best effect.");
      const wpGrid = document.createElement("div");
      wpGrid.className = "osset-wp-grid";
      WALLPAPER_LIST.forEach((w) => {
        const it = document.createElement("button");
        it.className = "osset-wp-item";
        it.dataset.value = w.id;
        it.style.background = w.gradient;
        if (Store.get("appearance.wallpaper") === w.id) it.classList.add("is-active");
        it.innerHTML = '<div class="osset-wp-name">' + escapeHtml(w.name) + '</div>';
        it.addEventListener("click", () => {
          $$(".osset-wp-item", wpGrid).forEach((s) => s.classList.remove("is-active"));
          it.classList.add("is-active");
          Store.set("appearance.wallpaper", w.id);
          this.flagDirty();
        });
        wpGrid.appendChild(it);
      });
      body.appendChild(wpGrid);

      // ---- Accent color ----
      body = this._section("Accent", "Used for highlights, focus rings and primary buttons.");
      const accentRow = this._row(body, "Accent colour", "Pick a custom colour or one of the presets.");
      const colorPickerWrap = document.createElement("div");
      colorPickerWrap.className = "osset-color";
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = Store.get("appearance.accent") || "#7c3aed";
      colorInput.addEventListener("change", () => {
        Store.set("appearance.accent", colorInput.value);
        $$(".osset-color-chip", colorPickerWrap).forEach((c) =>
          c.classList.toggle("is-active", c.dataset.color === colorInput.value));
        this.flagDirty();
      });
      const swatches = document.createElement("span");
      swatches.className = "osset-color-swatches";
      ACCENT_PRESETS.forEach((c) => {
        const chip = document.createElement("span");
        chip.className = "osset-color-chip";
        chip.dataset.color = c;
        chip.style.background = c;
        if (Store.get("appearance.accent") === c) chip.classList.add("is-active");
        chip.addEventListener("click", () => {
          colorInput.value = c;
          Store.set("appearance.accent", c);
          $$(".osset-color-chip", swatches).forEach((s) => s.classList.toggle("is-active", s.dataset.color === c));
          this.flagDirty();
        });
        swatches.appendChild(chip);
      });
      colorPickerWrap.appendChild(colorInput);
      colorPickerWrap.appendChild(swatches);
      accentRow.appendChild(colorPickerWrap);

      // ---- Window animations ----
      body = this._section("Effects", "Subtle visual effects throughout WebOS.");
      const animRow = this._row(body, "Window animations", "Slide, fade and grow when windows open/close.");
      animRow.appendChild(this._toggle(!!Store.get("appearance.animations"), (v) => Store.set("appearance.animations", v)));

      const transRow = this._row(body, "Glassmorphism", "Frosted-glass blur for translucent panels.");
      transRow.appendChild(this._toggle(!!Store.get("appearance.transparency"), (v) => Store.set("appearance.transparency", v)));

      // ---- Typography ----
      body = this._section("Typography & layout", "Font size and clock format.");
      const fsRow = this._row(body, "Font size", "Affects toolbars, menus and most apps.");
      fsRow.appendChild(this._select(FONTSIZE_OPTIONS, Store.get("appearance.fontsize"), (v) => Store.set("appearance.fontsize", v)));

      const tbRow = this._row(body, "Taskbar position", "Place the taskbar at the top or bottom of the screen.");
      tbRow.appendChild(this._select(TASKBAR_POSITIONS, Store.get("appearance.taskbarPos"), (v) => Store.set("appearance.taskbarPos", v)));

      const clkRow = this._row(body, "Clock format", "12-hour or 24-hour clock display.");
      clkRow.appendChild(this._select(CLOCK_FORMATS, Store.get("appearance.clockFormat"), (v) => Store.set("appearance.clockFormat", v)));
    }

    /* ==================================================================== */
    /* TAB: ACCOUNT                                                          */
    /* ==================================================================== */

    renderAccount() {
      const isOnline = !!(window.Backend && window.Backend.isOnline());
      const isAuthed = !!(window.Backend && window.Backend.isAuthenticated && window.Backend.isAuthenticated());
      const u = isAuthed ? window.Backend.user() : null;

      if (!isOnline) {
        const body = this._section("Backend offline",
          "Account features require the WebOS backend server. Start it with " +
          "`python backend/server.py` and reload to enable signing in.");
        const r = this._row(body, "Status", "Backend connection status.");
        const pill = document.createElement("span");
        pill.className = "osset-pill is-offline";
        pill.textContent = "Offline";
        r.appendChild(pill);
        return;
      }

      if (!isAuthed) {
        // Sign-in / register form
        const body = this._section("Sign in",
          "Sign in to sync settings, files and preferences across devices.");
        const userRow = this._row(body, "Username", "");
        const userInp = this._input("", (v) => { this._authForm = this._authForm || {}; this._authForm.username = v; }, { placeholder: "username" });
        userRow.appendChild(userInp);
        const passRow = this._row(body, "Password", "");
        const passInp = this._input("", (v) => { this._authForm = this._authForm || {}; this._authForm.password = v; }, { type: "password", placeholder: "password" });
        passRow.appendChild(passInp);

        const actionRow = this._row(body, "Actions", "Sign in to your account, or register a new one.");
        const loginBtn = this._button("Sign in", async (b) => {
          b.disabled = true; b.textContent = "Signing in…";
          try {
            const f = this._authForm || {};
            await window.Backend.login(f.username || userInp.value, f.password || passInp.value);
            this.renderTab("account");
            this.renderAccountPill();
          } catch (e) {
            this.flashError(e.message || "Login failed");
          } finally {
            b.disabled = false; b.textContent = "Sign in";
          }
        }, "primary");
        const regBtn = this._button("Create account", async (b) => {
          b.disabled = true; b.textContent = "Registering…";
          try {
            const f = this._authForm || {};
            await window.Backend.register(f.username || userInp.value, f.password || passInp.value, {});
            this.renderTab("account");
            this.renderAccountPill();
          } catch (e) {
            this.flashError(e.message || "Registration failed");
          } finally {
            b.disabled = false; b.textContent = "Create account";
          }
        });
        actionRow.appendChild(loginBtn);
        actionRow.appendChild(regBtn);
        return;
      }

      // ---- Profile section ----
      let body = this._section("Profile", "Your visible identity in WebOS.");
      const dnRow = this._row(body, "Display name", "Shown in the taskbar tray and Settings sidebar.");
      const dnInp = this._input(u.display_name || "", async (v) => {
        try { await window.Backend.updateProfile({ displayName: v }); this.renderAccountPill(); }
        catch (e) { this.flashError(e.message); }
      });
      dnRow.appendChild(dnInp);

      const unRow = this._row(body, "Username", "Used when signing in. Lowercase recommended.");
      const unInp = this._input(u.username || "", async (v) => {
        if (!v || v === u.username) return;
        try { await window.Backend.updateProfile({ username: v }); this.renderAccountPill(); }
        catch (e) { this.flashError(e.message); }
      });
      unRow.appendChild(unInp);

      const avRow = this._row(body, "Avatar", "Pick a built-in icon for your profile.");
      const avGrid = document.createElement("div");
      avGrid.className = "osset-avatar-grid";
      AVATARS.forEach((emoji) => {
        const sp = document.createElement("button");
        sp.className = "osset-avatar-item";
        sp.textContent = emoji;
        if (u.avatar === emoji) sp.classList.add("is-active");
        sp.addEventListener("click", async () => {
          $$(".osset-avatar-item", avGrid).forEach((b) => b.classList.remove("is-active"));
          sp.classList.add("is-active");
          try { await window.Backend.updateAvatar(emoji); this.renderAccountPill(); this.flagDirty(); }
          catch (e) { this.flashError(e.message); }
        });
        avGrid.appendChild(sp);
      });
      avRow.appendChild(avGrid);

      // ---- Password section ----
      body = this._section("Password", "Change your account password. You'll stay signed in here.");
      const pwForm = { old: "", neu: "", confirm: "" };
      const oldR = this._row(body, "Current password", "");
      const oldI = this._input("", (v) => pwForm.old = v, { type: "password", placeholder: "current password" });
      oldR.appendChild(oldI);
      const newR = this._row(body, "New password", "Minimum 4 characters.");
      const newI = this._input("", (v) => pwForm.neu = v, { type: "password", placeholder: "new password" });
      newR.appendChild(newI);
      const cfR = this._row(body, "Confirm new password", "");
      const cfI = this._input("", (v) => pwForm.confirm = v, { type: "password", placeholder: "confirm" });
      cfR.appendChild(cfI);
      const actR = this._row(body, "Update", "Other sessions will be signed out.");
      actR.appendChild(this._button("Change password", async (b) => {
        if (pwForm.neu !== pwForm.confirm) { this.flashError("New passwords do not match"); return; }
        b.disabled = true; b.textContent = "Updating…";
        try {
          await window.Backend.changePassword(pwForm.old, pwForm.neu);
          oldI.value = newI.value = cfI.value = "";
          this.flashSaved();
        } catch (e) { this.flashError(e.message); }
        finally { b.disabled = false; b.textContent = "Change password"; }
      }, "primary"));

      // ---- Account info ----
      body = this._section("Account info", "Read-only details about your account.");
      const r1 = this._row(body, "Account created", ""); 
      r1.innerHTML = '<span style="color:var(--osset-fg-muted)">' + escapeHtml(fmtDate(u.created_at)) + '</span>';
      const r2 = this._row(body, "Last login", "");
      r2.innerHTML = '<span style="color:var(--osset-fg-muted)">' + escapeHtml(fmtDate(u.last_login)) + '</span>';
      const r3 = this._row(body, "Role", "");
      r3.innerHTML = '<span class="osset-pill">' + escapeHtml(u.role || "user") + '</span>';

      // ---- Sign out ----
      body = this._section("Sign out", "End the current session on this device.");
      const soRow = this._row(body, "Sign out", "Your local files remain in localStorage.");
      soRow.appendChild(this._button("Sign out", async () => {
        await window.Backend.logout();
        this.renderTab("account");
        this.renderAccountPill();
      }, "ghost"));
    }

    /* ==================================================================== */
    /* TAB: DISPLAY                                                          */
    /* ==================================================================== */

    renderDisplay() {
      let body = this._section("Display", "Visual scaling and colour adjustments.");

      const zoomRow = this._row(body, "Zoom level", "Scales every UI element. Useful on high-DPI screens.");
      zoomRow.appendChild(this._select(
        ZOOM_LEVELS.map((z) => ({ id: z, name: z + "%" })),
        Store.get("display.zoom"),
        (v) => Store.set("display.zoom", parseInt(v, 10))
      ));

      const tempRow = this._row(body, "Color temperature", "Warm shifts towards red; Cool towards blue.");
      tempRow.appendChild(this._select(COLOR_TEMPS, Store.get("display.colorTemp"), (v) => Store.set("display.colorTemp", v)));

      body = this._section("Accessibility", "Reduce motion or increase contrast for easier reading.");
      const motRow = this._row(body, "Reduce motion", "Disable non-essential animations and transitions.");
      motRow.appendChild(this._toggle(!!Store.get("display.reduceMotion"), (v) => Store.set("display.reduceMotion", v)));

      const hcRow = this._row(body, "High contrast", "Boosts the contrast of text and borders.");
      hcRow.appendChild(this._toggle(!!Store.get("display.highContrast"), (v) => Store.set("display.highContrast", v)));

      const srRow = this._row(body, "Screen reader hints", "Adds extra ARIA labels for assistive technology.");
      srRow.appendChild(this._toggle(!!Store.get("display.screenReader"), (v) => Store.set("display.screenReader", v)));

      // ---- Detected display info ----
      body = this._section("Detected display", "Information about the current viewport.");
      const dpr = (window.devicePixelRatio || 1).toFixed(2);
      const r1 = this._row(body, "Resolution", "");
      r1.innerHTML = '<span style="color:var(--osset-fg-muted)">' +
        escapeHtml(window.innerWidth + " × " + window.innerHeight + " (DPR " + dpr + ")") + '</span>';
      const r2 = this._row(body, "Color depth", "");
      r2.innerHTML = '<span style="color:var(--osset-fg-muted)">' +
        escapeHtml((screen.colorDepth || 24) + "-bit") + '</span>';
      const r3 = this._row(body, "Reduced motion (system)", "");
      const sysReduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      r3.innerHTML = '<span class="osset-pill">' + (sysReduce ? "ON" : "OFF") + '</span>';
      const r4 = this._row(body, "Dark mode (system)", "");
      const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      r4.innerHTML = '<span class="osset-pill">' + (sysDark ? "ON" : "OFF") + '</span>';
    }

    /* ==================================================================== */
    /* TAB: SOUND                                                            */
    /* ==================================================================== */

    renderSound() {
      let body = this._section("Sound", "System volume and audio behaviour.");

      const vol = this._row(body, "Master volume", "Affects every WebOS sound effect.");
      vol.appendChild(this._slider(0, 100, 1, Store.get("sound.master"), (v) => Store.set("sound.master", v), "%"));

      const ui = this._row(body, "UI sounds", "Click, hover and notification chimes.");
      ui.appendChild(this._toggle(!!Store.get("sound.uiSounds"), (v) => Store.set("sound.uiSounds", v)));

      const not = this._row(body, "Notification sounds", "Play a sound when new notifications arrive.");
      not.appendChild(this._toggle(!!Store.get("sound.notifSounds"), (v) => Store.set("sound.notifSounds", v)));

      const boot = this._row(body, "Boot sound", "Play the startup chime when WebOS launches.");
      boot.appendChild(this._toggle(!!Store.get("sound.bootSound"), (v) => Store.set("sound.bootSound", v)));

      body = this._section("Sound theme", "Pick a sound pack used for system events.");
      const th = this._row(body, "Theme", "Default plays bright modern sounds; Retro mimics classic OSes.");
      th.appendChild(this._select(SOUND_THEMES, Store.get("sound.theme"), (v) => Store.set("sound.theme", v)));

      const test = this._row(body, "Test sound", "Hear a preview using the current settings.");
      test.appendChild(this._button("Play test", () => this._playTestSound(), "primary"));
    }

    _playTestSound() {
      try {
        if (!this._audioCtx) {
          const A = window.AudioContext || window.webkitAudioContext;
          if (!A) return;
          this._audioCtx = new A();
        }
        const ctx = this._audioCtx;
        const v = clamp((Store.get("sound.master") || 70) / 100, 0, 1);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        const theme = Store.get("sound.theme");
        const freq = (theme === "retro") ? 660 : (theme === "minimal" ? 440 : 880);
        osc.type = (theme === "retro") ? "square" : "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.15 * v, ctx.currentTime + 0.02);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      } catch (e) {
        this.flashError("Audio unavailable");
      }
    }

    /* ==================================================================== */
    /* TAB: PRIVACY                                                          */
    /* ==================================================================== */

    renderPrivacy() {
      let body = this._section("Clear data", "Each button affects only the named history.");

      const browseRow = this._row(body, "Browser history", "Clear the in-WebOS browser's history list.");
      browseRow.appendChild(this._button("Clear browser history", () => {
        try {
          localStorage.removeItem("webos.browser.history");
          localStorage.removeItem("webos.browser.recent");
          this.flashSaved();
        } catch (_) { this.flashError(); }
      }, "ghost"));

      const fmRow = this._row(body, "File Manager history", "Clear address-bar / breadcrumb history.");
      fmRow.appendChild(this._button("Clear FM history", () => {
        try {
          localStorage.removeItem("webos.fileManager.history");
          localStorage.removeItem("webos.fileManager.recentDirs");
          this.flashSaved();
        } catch (_) { this.flashError(); }
      }, "ghost"));

      const recRow = this._row(body, "Recent files", "Empty the global recent-files list.");
      recRow.appendChild(this._button("Clear recent files", () => {
        try {
          if (window.FileSystem && window.FileSystem.clearRecent) window.FileSystem.clearRecent();
          else localStorage.removeItem("webos.fs.recent");
          this.flashSaved();
        } catch (_) { this.flashError(); }
      }, "ghost"));

      // Danger zone
      body = this._section("Danger zone", "Operations that cannot be undone.");
      const allRow = this._row(body, "Clear all localStorage", "Reset WebOS to factory defaults. Files in the virtual FS will be lost unless backed up.");
      allRow.appendChild(this._button("Clear localStorage", async () => {
        const ok = await this._confirm({
          title: "Clear all WebOS local data?",
          body: "Every preference, file and saved app state on this device will be erased. The page will reload.",
          okText: "Erase everything",
          danger: true,
        });
        if (!ok) return;
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("webos.")) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        setTimeout(() => location.reload(), 200);
      }, "danger"));

      // Privacy preferences
      body = this._section("Preferences", "Privacy-related toggles for the rest of WebOS.");
      const showRow = this._row(body, "Show hidden files", "Display files starting with a dot in File Manager and Terminal.");
      showRow.appendChild(this._toggle(!!Store.get("privacy.showHidden"), (v) => Store.set("privacy.showHidden", v)));

      const diagRow = this._row(body, "Diagnostic data", "Send anonymous performance metrics to the (fake) telemetry endpoint.");
      diagRow.appendChild(this._toggle(!!Store.get("privacy.diagnostics"), (v) => Store.set("privacy.diagnostics", v)));
    }

    /* ==================================================================== */
    /* TAB: KEYBOARD                                                         */
    /* ==================================================================== */

    renderKeyboard() {
      // Shortcuts reference table
      let body = this._section("Keyboard shortcuts", "Reference of every shortcut WebOS recognises.");
      const tableWrap = document.createElement("div");
      tableWrap.style.maxHeight = "320px";
      tableWrap.style.overflowY = "auto";
      tableWrap.style.border = "1px solid var(--osset-border)";
      tableWrap.style.borderRadius = "8px";
      const table = document.createElement("table");
      table.className = "osset-table";
      let html = "<thead><tr><th>Shortcut</th><th>Action</th></tr></thead><tbody>";
      SHORTCUTS_REFERENCE.forEach((sec) => {
        html += '<tr><td colspan="2" style="background:var(--osset-bg-soft);font-weight:700;">' + escapeHtml(sec.group) + '</td></tr>';
        sec.items.forEach((it) => {
          const keys = String(it[0]).split(/\s+\+\s+/).map((k) =>
            '<kbd class="osset-kbd">' + escapeHtml(k) + '</kbd>').join(" + ");
          html += '<tr><td>' + keys + '</td><td>' + escapeHtml(it[1]) + '</td></tr>';
        });
      });
      html += "</tbody>";
      table.innerHTML = html;
      tableWrap.appendChild(table);
      body.appendChild(tableWrap);

      // Customizable shortcuts
      body = this._section("Customisable shortcuts", "Bind these to your favourite actions.");
      const stored = lsRead(STORAGE_SHORTC, {
        custom1: { keys: "Ctrl+Alt+1", action: "open-terminal", label: "Custom #1" },
        custom2: { keys: "Ctrl+Alt+2", action: "open-files",    label: "Custom #2" },
        custom3: { keys: "Ctrl+Alt+3", action: "open-browser",  label: "Custom #3" },
      });

      const ACTIONS = [
        { id: "open-terminal", name: "Open Terminal" },
        { id: "open-files",    name: "Open File Manager" },
        { id: "open-browser",  name: "Open Browser" },
        { id: "open-paint",    name: "Open Paint" },
        { id: "open-music",    name: "Open Music Player" },
        { id: "open-settings", name: "Open Settings" },
        { id: "show-desktop",  name: "Show desktop" },
      ];

      const persist = () => lsWrite(STORAGE_SHORTC, stored);

      ["custom1", "custom2", "custom3"].forEach((sid) => {
        const r = this._row(body, stored[sid].label, "");
        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.gap = "6px";

        const keysInp = this._input(stored[sid].keys, (v) => { stored[sid].keys = v; persist(); });
        keysInp.style.minWidth = "140px";

        const actSel = this._select(ACTIONS, stored[sid].action, (v) => { stored[sid].action = v; persist(); });

        wrap.appendChild(keysInp);
        wrap.appendChild(actSel);
        r.appendChild(wrap);
      });

      // Repeat speed/delay
      body = this._section("Key repeat", "How fast a held key repeats.");
      const sp = this._row(body, "Repeat speed", "Higher = faster repeat after the initial delay.");
      sp.appendChild(this._slider(1, 100, 1, Store.get("keyboard.repeatSpeed"),
        (v) => Store.set("keyboard.repeatSpeed", v), ""));
      const dl = this._row(body, "Repeat delay", "Milliseconds before a held key starts repeating.");
      dl.appendChild(this._slider(150, 1000, 50, Store.get("keyboard.repeatDelay"),
        (v) => Store.set("keyboard.repeatDelay", v), "ms"));
    }

    /* ==================================================================== */
    /* TAB: ABOUT                                                            */
    /* ==================================================================== */

    renderAbout() {
      // ASCII logo
      const logo =
        "  __        __   _      ___  ____  \n" +
        "  \\ \\      / /__| |__  / _ \\/ ___| \n" +
        "   \\ \\ /\\ / / _ \\ '_ \\| | | \\___ \\ \n" +
        "    \\ V  V /  __/ |_) | |_| |___) |\n" +
        "     \\_/\\_/ \\___|_.__/ \\___/|____/ \n";

      let body = this._section("WebOS", "A fully-functional desktop operating system that runs in your browser.");
      const logoEl = document.createElement("div");
      logoEl.className = "osset-about-logo";
      logoEl.textContent = logo;
      body.appendChild(logoEl);

      // System info
      const grid = document.createElement("div");
      grid.className = "osset-about-grid";
      const items = [
        ["Version",          "WebOS 1.0 (Day 5 Build)"],
        ["Build date",       new Date().toDateString()],
        ["Kernel",           "WebKernel 5.0"],
        ["Shell",            "WeBash 2.0"],
        ["Window Manager",   "wmgr (focus stacking + snap)"],
        ["Theme engine",     "ThemeEngine v1"],
        ["Resolution",       window.innerWidth + " × " + window.innerHeight + " (DPR " + (window.devicePixelRatio || 1).toFixed(2) + ")"],
        ["User agent",       (navigator.userAgent.split(") ")[0] + ")").slice(0, 80)],
        ["Backend",          this._backendStatusString()],
        ["Backend URL",      (window.Backend && window.Backend.getBaseURL && window.Backend.getBaseURL()) || "—"],
      ];
      items.forEach(([k, v]) => {
        const kEl = document.createElement("div"); kEl.className = "k"; kEl.textContent = k;
        const vEl = document.createElement("div"); vEl.className = "v"; vEl.textContent = v;
        grid.appendChild(kEl); grid.appendChild(vEl);
      });
      body.appendChild(grid);

      // Storage usage
      body = this._section("Storage", "Disk usage and file counts (virtual filesystem).");
      const lsBytes = this._localStorageBytes();
      const lsLimit = 5 * 1024 * 1024;
      const pct = clamp(Math.round((lsBytes / lsLimit) * 100), 0, 100);
      const stRow = this._row(body, "localStorage usage", "Approximate. Browsers typically allow ~5 MB per origin.");
      const sw = document.createElement("div");
      sw.style.display = "flex"; sw.style.flexDirection = "column"; sw.style.gap = "4px";
      const bar = document.createElement("div");
      bar.className = "osset-storage-bar";
      bar.innerHTML = '<i style="width:' + pct + '%"></i>';
      const lbl = document.createElement("small");
      lbl.style.color = "var(--osset-fg-faint)";
      lbl.textContent = fmtBytes(lsBytes) + " / ~" + fmtBytes(lsLimit) + "  (" + pct + "%)";
      sw.appendChild(bar); sw.appendChild(lbl);
      stRow.appendChild(sw);

      // FS counts
      const fsCounts = this._fsCounts();
      const r1 = this._row(body, "Files",   "Total files in the virtual filesystem.");
      r1.innerHTML = '<span class="osset-pill">' + fsCounts.files + '</span>';
      const r2 = this._row(body, "Folders", "Total folders in the virtual filesystem.");
      r2.innerHTML = '<span class="osset-pill">' + fsCounts.folders + '</span>';
      const r3 = this._row(body, "Size",    "Sum of every file's content size.");
      r3.innerHTML = '<span style="color:var(--osset-fg-muted)">' + escapeHtml(fmtBytes(fsCounts.bytes)) + '</span>';

      // Installed apps
      body = this._section("Installed apps", "Every app currently registered with the WindowManager.");
      const wm = window.WindowManager;
      const apps = (wm && wm.getApps) ? wm.getApps() : [];
      const appsList = document.createElement("div");
      appsList.className = "osset-apps-list";
      apps.forEach((a) => {
        const card = document.createElement("div");
        card.className = "osset-apps-card";
        card.innerHTML =
          '<span class="glyph">' + escapeHtml(a.icon || "▦") + '</span>' +
          '<span class="meta"><strong>' + escapeHtml(a.title) + '</strong>' +
          '<small>' + escapeHtml(a.category || "Apps") + '</small></span>';
        card.addEventListener("click", () => {
          if (wm && wm.openApp) wm.openApp(a.id);
        });
        appsList.appendChild(card);
      });
      if (apps.length === 0) {
        const empty = document.createElement("div");
        empty.style.color = "var(--osset-fg-faint)";
        empty.textContent = "No apps registered yet.";
        appsList.appendChild(empty);
      }
      body.appendChild(appsList);

      // Credits
      body = this._section("Credits", "Built as part of the WebOS project.");
      const credits = document.createElement("div");
      credits.style.fontSize = "12.5px";
      credits.style.lineHeight = "1.6";
      credits.style.color = "var(--osset-fg-muted)";
      credits.innerHTML =
        "<p>WebOS — A 5-day exploration of building a desktop operating system entirely in the browser.</p>" +
        "<ul style='margin:6px 0 0 18px;padding:0'>" +
        "<li>Day 1 — Boot, Desktop, Window Manager, Taskbar, Start Menu, Theme Engine</li>" +
        "<li>Day 2 — Virtual Filesystem + File Manager + Context Menus</li>" +
        "<li>Day 3 — Text Editor, Calculator, Browser</li>" +
        "<li>Day 4 — OsPaint and SoundWave Music Player</li>" +
        "<li><strong>Day 5 — OsTerminal, Python Backend, System Settings</strong></li>" +
        "</ul>" +
        "<p style='margin-top:8px;color:var(--osset-fg-faint);'>Fonts: " +
          "<em>Inter</em>, <em>JetBrains Mono</em>, <em>Press Start 2P</em>. " +
          "Built with vanilla JavaScript — zero runtime dependencies.</p>";
      body.appendChild(credits);

      // Reset all settings button
      body = this._section("Diagnostics", "Reset every setting back to its default.");
      const resAll = this._row(body, "Reset all settings", "Reverts every category. Local files are not touched.");
      resAll.appendChild(this._button("Reset everything", async () => {
        const ok = await this._confirm({
          title: "Reset every setting?",
          body: "All categories will be returned to their factory defaults. Files in the virtual filesystem are not touched.",
          okText: "Reset all",
          danger: true,
        });
        if (!ok) return;
        Store.reset();
        applyAll();
        this.renderTab(this.activeTab);
        this.flashSaved();
      }, "danger"));
    }

    _backendStatusString() {
      if (!window.Backend) return "Module not loaded";
      const online = window.Backend.isOnline && window.Backend.isOnline();
      const auth   = window.Backend.isAuthenticated && window.Backend.isAuthenticated();
      if (auth)   return "Connected (signed in)";
      if (online) return "Connected (anonymous)";
      return "Offline (localStorage only)";
    }

    _localStorageBytes() {
      let n = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          if (k) n += k.length;
          if (v) n += v.length;
        }
      } catch (_) {}
      return n * 2; // rough UTF-16 bytes
    }

    _fsCounts() {
      let files = 0, folders = 0, bytes = 0;
      try {
        const tree = window.FileSystem && window.FileSystem.tree && window.FileSystem.tree("/");
        function walk(n) {
          if (!n) return;
          if (n.type === "file") {
            files++;
            bytes += (n.content ? String(n.content).length : 0);
          } else if (n.type === "folder") {
            folders++;
            if (n.children) Object.values(n.children).forEach(walk);
          }
        }
        if (tree) walk(tree);
      } catch (_) {}
      return { files, folders, bytes };
    }
  }

  /* ==========================================================================
   * 5. WindowManager registration
   * ========================================================================*/

  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id:        APP_ID,
      title:     APP_TITLE,
      icon:      APP_ICON,
      width:     880,
      height:    600,
      minWidth:  640,
      minHeight: 420,
      category:  "System",
      pinned:    true,

      render(body, win) {
        const app = new SettingsApp(body, win);
        win._settingsApp = app;
        app.mount();
      },
      onClose(win) {
        if (win._settingsApp) win._settingsApp.destroy();
      },
    });

    console.log("%c[WebOS]%c System Settings registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* ==========================================================================
   * 6. Win+I global shortcut
   * ========================================================================*/

  document.addEventListener("keydown", (e) => {
    // Win+I — open Settings
    if ((e.metaKey || e.getModifierState && e.getModifierState("Meta")) && (e.key === "i" || e.key === "I")) {
      // Only trigger if no input element is focused
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (window.WindowManager && window.WindowManager.openApp) {
        window.WindowManager.openApp(APP_ID);
      }
    }
  }, true);

  /* ==========================================================================
   * 7. Apply settings on initial load
   * ========================================================================*/

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyAll);
  } else {
    applyAll();
  }

  /* ==========================================================================
   * 8. Public API
   * ========================================================================*/

  window.SystemSettings = {
    open(opts) { return window.WindowManager.openApp(APP_ID, opts || {}); },

    /* programmatic getters/setters */
    get(key) { return Store.get(key); },
    set(key, value) { Store.set(key, value); },
    getAll() { return Store.getAll(); },
    bulkSet(map) { Store.bulkSet(map); },
    reset(prefix) { Store.reset(prefix); },
    on(fn) { return Store.on(fn); },

    /* re-apply (e.g. after backend pull) */
    applyAll,

    /* constants for other apps */
    THEME_LIST, WALLPAPER_LIST, ACCENT_PRESETS, AVATARS,
    DEFAULTS, TABS,

    /* exposed below */
    Validator: null,    // populated after definition
    Migrator:  null,    // populated after definition
    Exporter:  null,    // populated after definition
    Importer:  null,    // populated after definition
    SchemaDoc: null,    // populated after definition
  };

  /* ==========================================================================
   * 9. Validator — runtime guard for incoming settings (especially from
   *    backend pulls or user JSON imports). Each entry maps a settings key
   *    to a {type, allowed, range, default} record. Anything that fails
   *    validation is dropped (with a console.warn) rather than throwing,
   *    so a bad server payload cannot brick the local installation.
   * ========================================================================*/

  const SCHEMA = {
    /* ---------------- Appearance ---------------- */
    "appearance.theme": {
      type: "string",
      allowed: THEME_LIST.map((t) => t.id),
      default: DEFAULTS["appearance.theme"],
      help: "Active visual theme id.",
    },
    "appearance.wallpaper": {
      type: "string",
      allowed: WALLPAPER_LIST.map((w) => w.id),
      default: DEFAULTS["appearance.wallpaper"],
      help: "Selected desktop wallpaper id.",
    },
    "appearance.accent": {
      type: "string",
      pattern: /^#[0-9a-fA-F]{6}$/,
      default: DEFAULTS["appearance.accent"],
      help: "Custom accent colour as #rrggbb hex.",
    },
    "appearance.animations":     { type: "boolean", default: true,  help: "Enable window/menu animations." },
    "appearance.transparency":   { type: "boolean", default: true,  help: "Enable glassmorphism blur." },
    "appearance.fontsize": {
      type: "string",
      allowed: FONTSIZE_OPTIONS.map((f) => f.id),
      default: DEFAULTS["appearance.fontsize"],
      help: "UI font size preset.",
    },
    "appearance.taskbarPos": {
      type: "string",
      allowed: TASKBAR_POSITIONS.map((p) => p.id),
      default: DEFAULTS["appearance.taskbarPos"],
      help: "Taskbar location on screen.",
    },
    "appearance.clockFormat": {
      type: "string",
      allowed: CLOCK_FORMATS.map((c) => c.id),
      default: DEFAULTS["appearance.clockFormat"],
      help: "12-hour or 24-hour clock format.",
    },

    /* ---------------- Display ---------------- */
    "display.zoom": {
      type: "number",
      min: 50, max: 200,
      default: DEFAULTS["display.zoom"],
      help: "Page-level zoom percentage.",
    },
    "display.colorTemp": {
      type: "string",
      allowed: COLOR_TEMPS.map((c) => c.id),
      default: DEFAULTS["display.colorTemp"],
      help: "Screen colour temperature preset.",
    },
    "display.reduceMotion": { type: "boolean", default: false, help: "Reduce non-essential motion." },
    "display.highContrast": { type: "boolean", default: false, help: "Boost text/border contrast." },
    "display.screenReader": { type: "boolean", default: false, help: "Add extra ARIA labels." },

    /* ---------------- Sound ---------------- */
    "sound.master":      { type: "number", min: 0, max: 100, default: 70, help: "Master volume (0-100)." },
    "sound.uiSounds":    { type: "boolean", default: true,  help: "Play UI click/hover sounds." },
    "sound.notifSounds": { type: "boolean", default: true,  help: "Play sound for notifications." },
    "sound.bootSound":   { type: "boolean", default: true,  help: "Play startup chime." },
    "sound.theme": {
      type: "string",
      allowed: SOUND_THEMES.map((s) => s.id),
      default: DEFAULTS["sound.theme"],
      help: "Audio theme pack.",
    },

    /* ---------------- Privacy ---------------- */
    "privacy.showHidden":   { type: "boolean", default: false, help: "Show dotfiles in File Manager." },
    "privacy.diagnostics":  { type: "boolean", default: false, help: "Send anonymous metrics (mock)." },

    /* ---------------- Keyboard ---------------- */
    "keyboard.repeatSpeed": { type: "number", min: 1, max: 100, default: 50,  help: "Key-repeat rate." },
    "keyboard.repeatDelay": { type: "number", min: 150, max: 1000, default: 450, help: "Initial repeat delay (ms)." },
  };

  const Validator = (function () {

    /**
     * Validate a single (key, value) pair against SCHEMA.
     * Returns { ok: true, value: cleaned } or { ok: false, reason: string }.
     * Unknown keys are accepted as-is (so apps can store their own settings
     * with custom prefixes without registering with this schema).
     */
    function validateOne(key, value) {
      if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
        return { ok: true, value, unknown: true };
      }
      const def = SCHEMA[key];
      // Type check
      if (def.type === "boolean") {
        if (typeof value === "boolean") return { ok: true, value };
        if (value === "true" || value === 1)  return { ok: true, value: true };
        if (value === "false" || value === 0) return { ok: true, value: false };
        return { ok: false, reason: "expected boolean" };
      }
      if (def.type === "number") {
        const n = (typeof value === "number") ? value : Number(value);
        if (!isFinite(n)) return { ok: false, reason: "expected number" };
        if (def.min != null && n < def.min) return { ok: false, reason: "below min " + def.min };
        if (def.max != null && n > def.max) return { ok: false, reason: "above max " + def.max };
        return { ok: true, value: n };
      }
      if (def.type === "string") {
        const s = (value == null) ? "" : String(value);
        if (def.pattern && !def.pattern.test(s))    return { ok: false, reason: "pattern mismatch" };
        if (def.allowed && def.allowed.indexOf(s) === -1)
          return { ok: false, reason: "not in allowed list" };
        return { ok: true, value: s };
      }
      return { ok: true, value };
    }

    /**
     * Validate every key in `obj`. Returns:
     *   { cleaned: {good keys}, errors: [{key, reason}] }
     */
    function validateAll(obj) {
      const cleaned = {};
      const errors = [];
      Object.keys(obj || {}).forEach((k) => {
        const r = validateOne(k, obj[k]);
        if (r.ok) cleaned[k] = r.value;
        else errors.push({ key: k, reason: r.reason });
      });
      return { cleaned, errors };
    }

    /**
     * Coerce: like validateOne but on failure returns the SCHEMA default
     * (or undefined if there is none). Useful for defensive reads from
     * untrusted sources that should never bubble an error up.
     */
    function coerce(key, value) {
      const r = validateOne(key, value);
      if (r.ok) return r.value;
      const def = SCHEMA[key];
      return def ? def.default : value;
    }

    /**
     * Return the schema entry for a key (or undefined). Other modules can
     * use this to render help text or build documentation pages.
     */
    function describe(key) {
      return SCHEMA[key];
    }

    /**
     * List every known key in the schema.
     */
    function listKeys() { return Object.keys(SCHEMA).sort(); }

    return { validateOne, validateAll, coerce, describe, listKeys, SCHEMA };

  })();

  /* Auto-coerce loaded settings against the schema once at boot — protects
   * against corrupted localStorage from older versions of WebOS or from a
   * malformed backend pull. */
  (function _coerceOnBoot() {
    const all = Store.getAll();
    const next = {};
    let dirty = false;
    Object.keys(all).forEach((k) => {
      const v = all[k];
      const c = Validator.coerce(k, v);
      next[k] = c;
      if (c !== v) dirty = true;
    });
    if (dirty) Store.bulkSet(next, { skipBackend: true });
  })();

  /* ==========================================================================
   * 10. Migrator — handle settings shape changes between WebOS versions.
   *     Each migration is { from, to, run(state) -> state } and is applied
   *     in order whenever the stored "webos.settings.version" disagrees
   *     with CURRENT_VERSION. This lets us evolve the schema without
   *     breaking existing installations.
   * ========================================================================*/

  const CURRENT_VERSION = 5;   // bumped each time the schema changes
  const STORAGE_VERSION = "webos.settings.version";

  const MIGRATIONS = [
    {
      from: 0, to: 1,
      run(state) {
        // v0 -> v1: rename "theme" to "appearance.theme"
        if (state.theme && !state["appearance.theme"]) {
          state["appearance.theme"] = state.theme;
          delete state.theme;
        }
        return state;
      },
    },
    {
      from: 1, to: 2,
      run(state) {
        // v1 -> v2: introduce wallpaper key
        if (!state["appearance.wallpaper"]) state["appearance.wallpaper"] = "aurora";
        return state;
      },
    },
    {
      from: 2, to: 3,
      run(state) {
        // v2 -> v3: split sound.enabled -> sound.uiSounds + sound.notifSounds
        if (state["sound.enabled"] != null) {
          state["sound.uiSounds"] = !!state["sound.enabled"];
          state["sound.notifSounds"] = !!state["sound.enabled"];
          delete state["sound.enabled"];
        }
        return state;
      },
    },
    {
      from: 3, to: 4,
      run(state) {
        // v3 -> v4: add display.zoom default if missing
        if (state["display.zoom"] == null) state["display.zoom"] = 100;
        return state;
      },
    },
    {
      from: 4, to: 5,
      run(state) {
        // v4 -> v5: add keyboard.repeatSpeed/Delay defaults
        if (state["keyboard.repeatSpeed"] == null) state["keyboard.repeatSpeed"] = 50;
        if (state["keyboard.repeatDelay"] == null) state["keyboard.repeatDelay"] = 450;
        return state;
      },
    },
  ];

  const Migrator = (function () {
    function currentVersion() {
      const v = lsRead(STORAGE_VERSION, 0);
      return (typeof v === "number") ? v : 0;
    }

    function setCurrentVersion(v) { lsWrite(STORAGE_VERSION, v); }

    function applyAllMigrations() {
      let v = currentVersion();
      if (v === CURRENT_VERSION) return { migrated: 0, version: v };
      const before = v;
      let state = Store.getAll();
      for (const mig of MIGRATIONS) {
        if (mig.from === v) {
          try {
            state = mig.run(state) || state;
            v = mig.to;
          } catch (e) {
            console.error("[Settings] migration failed:", mig, e);
            break;
          }
        }
      }
      Store.bulkSet(state, { skipBackend: true });
      setCurrentVersion(v);
      return { migrated: v - before, version: v };
    }

    return { applyAllMigrations, currentVersion, CURRENT_VERSION };
  })();

  Migrator.applyAllMigrations();

  /* ==========================================================================
   * 11. Exporter / Importer — JSON file-based settings transfer
   *     Useful for backing up settings, sharing them with another machine,
   *     or seeding a fresh install with someone else's preferences.
   * ========================================================================*/

  const Exporter = (function () {

    /**
     * Build a portable settings document. Includes a magic marker so the
     * importer can detect malformed files.
     */
    function build() {
      return {
        magic:   "webos-settings-v1",
        version: Migrator.CURRENT_VERSION,
        exported_at: Date.now(),
        settings: Store.getAll(),
        shortcuts: lsRead(STORAGE_SHORTC, null),
      };
    }

    function toJSON() {
      return JSON.stringify(build(), null, 2);
    }

    /**
     * Trigger a browser download of the settings document.
     */
    function download(filename) {
      const blob = new Blob([toJSON()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || ("webos-settings-" + new Date().toISOString().slice(0, 10) + ".json");
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 50);
    }

    /**
     * Save the settings document into the virtual FileSystem.
     */
    function saveToVFS(path) {
      try {
        if (!window.FileSystem || !window.FileSystem.writeFile) return false;
        path = path || ("/home/user/webos-settings-" + Date.now() + ".json");
        window.FileSystem.writeFile(path, toJSON());
        return path;
      } catch (e) {
        console.error("[Settings] saveToVFS failed:", e);
        return false;
      }
    }

    return { build, toJSON, download, saveToVFS };
  })();

  const Importer = (function () {

    /**
     * Import a settings document. The argument may be a string (JSON), an
     * already-parsed object, or a File from a file picker. Returns a
     * promise resolving to {ok, applied: <int>, errors: [...]}.
     */
    async function importDocument(input) {
      let doc;
      if (typeof input === "string") {
        try { doc = JSON.parse(input); }
        catch (e) { return { ok: false, error: "invalid JSON: " + e.message }; }
      } else if (input && typeof input.text === "function") {
        const txt = await input.text();
        try { doc = JSON.parse(txt); }
        catch (e) { return { ok: false, error: "invalid JSON file: " + e.message }; }
      } else if (input && typeof input === "object") {
        doc = input;
      } else {
        return { ok: false, error: "unsupported input type" };
      }

      if (!doc || doc.magic !== "webos-settings-v1") {
        return { ok: false, error: "not a WebOS settings document" };
      }
      if (!doc.settings || typeof doc.settings !== "object") {
        return { ok: false, error: "settings field missing" };
      }
      const { cleaned, errors } = Validator.validateAll(doc.settings);
      Store.bulkSet(cleaned);
      if (doc.shortcuts && typeof doc.shortcuts === "object") {
        lsWrite(STORAGE_SHORTC, doc.shortcuts);
      }
      applyAll();
      return { ok: true, applied: Object.keys(cleaned).length, errors };
    }

    /**
     * Load a document from the virtual FileSystem and import it.
     */
    async function importFromVFS(path) {
      if (!window.FileSystem || !window.FileSystem.readFile) {
        return { ok: false, error: "FileSystem unavailable" };
      }
      let txt;
      try { txt = window.FileSystem.readFile(path); }
      catch (e) { return { ok: false, error: e.message || String(e) }; }
      return importDocument(txt);
    }

    /**
     * Open a hidden file picker; returns a promise resolving with the
     * importDocument result.
     */
    function openFilePicker() {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.style.display = "none";
        input.addEventListener("change", async () => {
          const file = input.files && input.files[0];
          document.body.removeChild(input);
          if (!file) { resolve({ ok: false, error: "no file selected" }); return; }
          const r = await importDocument(file);
          resolve(r);
        });
        document.body.appendChild(input);
        input.click();
      });
    }

    return { importDocument, importFromVFS, openFilePicker };
  })();

  /* ==========================================================================
   * 12. SchemaDoc — autogenerated documentation page builder.
   *     Returns an HTML string describing every known setting; used by the
   *     Settings app's About tab footer (and could be embedded in docs).
   * ========================================================================*/

  const SchemaDoc = (function () {
    function html() {
      const groups = {};
      Validator.listKeys().forEach((k) => {
        const cat = k.split(".", 1)[0];
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(k);
      });
      let out = "<dl class='osset-schema'>";
      Object.keys(groups).sort().forEach((g) => {
        out += "<dt><strong>" + escapeHtml(g) + "</strong></dt>";
        groups[g].forEach((k) => {
          const d = Validator.describe(k);
          out += "<dd><code>" + escapeHtml(k) + "</code>";
          if (d) {
            out += " — <em>" + escapeHtml(d.type) + "</em>";
            if (d.allowed) out += " (one of " + d.allowed.map(escapeHtml).join(", ") + ")";
            if (d.min != null || d.max != null) out += " [" + (d.min || 0) + "…" + (d.max || "∞") + "]";
            if (d.default != null) out += " — default: <code>" + escapeHtml(JSON.stringify(d.default)) + "</code>";
            if (d.help) out += "<br><small>" + escapeHtml(d.help) + "</small>";
          }
          out += "</dd>";
        });
      });
      out += "</dl>";
      return out;
    }

    function lines() {
      return Validator.listKeys().map((k) => {
        const d = Validator.describe(k) || {};
        const parts = [k, d.type || ""];
        if (d.default != null) parts.push("default=" + JSON.stringify(d.default));
        return parts.join("  ");
      });
    }

    return { html, lines, count: () => Validator.listKeys().length };
  })();

  /* ==========================================================================
   * 13. Test hook — sanity-check every Validator branch so a regression in
   *     a future refactor surfaces immediately in the developer console.
   *     Runs only in a dev-style page (skipped if `?nodevtest` is in the
   *     URL or if window.__webosNoDevTest is set).
   * ========================================================================*/

  function _devSelfTest() {
    try {
      if (location.search.indexOf("nodevtest") >= 0) return;
      if (window.__webosNoDevTest) return;
      let pass = 0, fail = 0;
      const ok = (cond, name) => { if (cond) pass++; else { fail++; console.warn("[Settings test FAIL]", name); } };

      // boolean coercion
      ok(Validator.coerce("appearance.animations", "true")  === true,  "bool from 'true'");
      ok(Validator.coerce("appearance.animations", "false") === false, "bool from 'false'");
      ok(Validator.coerce("appearance.animations", true)    === true,  "bool true");

      // numeric clamping
      ok(Validator.coerce("display.zoom", 9999) === DEFAULTS["display.zoom"], "zoom out-of-range");
      ok(Validator.coerce("display.zoom", 125)  === 125,  "zoom in-range");
      ok(Validator.coerce("sound.master", -1)   === DEFAULTS["sound.master"] || Validator.coerce("sound.master", -1) === 70, "volume below min");
      ok(Validator.coerce("sound.master", 50)   === 50,   "volume in-range");

      // allowed list
      ok(Validator.coerce("appearance.theme", "dark")        === "dark",  "theme allowed");
      ok(Validator.coerce("appearance.theme", "made-up")     !== "made-up", "theme rejected");

      // pattern
      ok(Validator.coerce("appearance.accent", "#abcdef") === "#abcdef", "accent valid");
      ok(Validator.coerce("appearance.accent", "red")     === DEFAULTS["appearance.accent"], "accent invalid coerces to default");

      // unknown key passthrough
      ok(Validator.coerce("app.custom.key", { a: 1 }).a === 1, "unknown passthrough");

      console.log("[Settings] dev self-test:", pass, "pass,", fail, "fail");
    } catch (e) { console.warn("[Settings] dev test exception:", e); }
  }
  _devSelfTest();

  /* ==========================================================================
   * 14. Wire helpers into public API
   * ========================================================================*/

  window.SystemSettings.Validator = Validator;
  window.SystemSettings.Migrator  = Migrator;
  window.SystemSettings.Exporter  = Exporter;
  window.SystemSettings.Importer  = Importer;
  window.SystemSettings.SchemaDoc = SchemaDoc;

  /* Convenience top-level methods so callers don't have to dig. */
  window.SystemSettings.exportToJSON   = () => Exporter.toJSON();
  window.SystemSettings.exportDownload = (fname) => Exporter.download(fname);
  window.SystemSettings.exportToVFS    = (path) => Exporter.saveToVFS(path);
  window.SystemSettings.importJSON     = (s)  => Importer.importDocument(s);
  window.SystemSettings.importFromVFS  = (p)  => Importer.importFromVFS(p);
  window.SystemSettings.importPicker   = ()   => Importer.openFilePicker();

  /* ==========================================================================
   * 15. Notify other apps when key settings change (in addition to the in-
   *     module Store.on listeners already wired). External apps can listen
   *     for these CustomEvents on `window` instead of having to import the
   *     SystemSettings module.
   * ========================================================================*/

  Store.on((key, value, old) => {
    if (value === old) return;
    try {
      window.dispatchEvent(new CustomEvent("webos:settingschange", {
        detail: { key, value, old },
      }));
    } catch (_) {}
  });

  /* ==========================================================================
   * 16. Cross-tab synchronisation. If the user opens WebOS in two tabs and
   *     changes a setting in one, the other tab should pick it up.
   *     The browser fires a `storage` event for every cross-tab write.
   * ========================================================================*/

  window.addEventListener("storage", (e) => {
    if (!e.key || e.key !== STORAGE_KEY) return;
    try {
      const next = JSON.parse(e.newValue || "{}");
      if (next && typeof next === "object") {
        Store.bulkSet(next, { skipBackend: true });
        applyAll();
      }
    } catch (_) {}
  });

  /* ==========================================================================
   * 17. Keyboard-driven shortcut runner. Reads the customisable shortcuts
   *     map from localStorage and matches it against keydown events. This
   *     intentionally lives outside the SettingsApp class so the shortcuts
   *     work even when the Settings window is not open.
   * ========================================================================*/

  const ShortcutRunner = (function () {
    function normalize(combo) {
      return String(combo || "")
        .split("+")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("+");
    }

    function eventCombo(e) {
      const parts = [];
      if (e.ctrlKey)  parts.push("ctrl");
      if (e.altKey)   parts.push("alt");
      if (e.shiftKey) parts.push("shift");
      if (e.metaKey)  parts.push("meta");
      // Use e.key for printable; the keys we accept are mostly digits/letters
      const key = e.key || "";
      if (key && key.length === 1)         parts.push(key.toLowerCase());
      else if (key && key.length > 1)      parts.push(key.toLowerCase());
      return parts.sort().join("+");
    }

    function runAction(actionId) {
      const wm = window.WindowManager;
      if (!wm || !wm.openApp) return;
      switch (actionId) {
        case "open-terminal": wm.openApp("terminal"); break;
        case "open-files":    wm.openApp("filemanager"); break;
        case "open-browser":  wm.openApp("browser"); break;
        case "open-paint":    wm.openApp("paint"); break;
        case "open-music":    wm.openApp("musicPlayer"); break;
        case "open-settings": wm.openApp("settings"); break;
        case "show-desktop":
          if (wm.toggleShowDesktop) wm.toggleShowDesktop();
          break;
      }
    }

    function handleKeydown(e) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const map = lsRead(STORAGE_SHORTC, null);
      if (!map) return;
      const combo = eventCombo(e);
      Object.keys(map).forEach((k) => {
        const want = normalize(map[k].keys);
        if (want && want === combo) {
          e.preventDefault();
          runAction(map[k].action);
        }
      });
    }

    document.addEventListener("keydown", handleKeydown, true);

    return { handleKeydown, runAction, normalize };
  })();

  window.SystemSettings.ShortcutRunner = ShortcutRunner;

  /* ==========================================================================
   * 18. Periodic diagnostics — only emits when privacy.diagnostics is on.
   *     This is intentionally a no-op networking call: the data is logged
   *     to the console rather than sent to a server. It exists so the
   *     toggle has a visible effect and to demonstrate the pattern.
   * ========================================================================*/

  const Diagnostics = (function () {
    let timer = null;

    function tick() {
      if (!Store.get("privacy.diagnostics")) return;
      const snap = {
        ts: Date.now(),
        viewport: window.innerWidth + "x" + window.innerHeight,
        memory: (performance.memory && performance.memory.usedJSHeapSize) || 0,
        windows: (window.WindowManager && window.WindowManager.listWindows && window.WindowManager.listWindows().length) || 0,
        backend: (window.Backend && window.Backend.isOnline && window.Backend.isOnline()) ? "online" : "offline",
      };
      console.log("%c[diagnostics]%c", "color:#9ca3af;font-weight:bold", "color:inherit", snap);
    }

    function start() {
      stop();
      timer = setInterval(tick, 60_000);
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    Store.on((key) => {
      if (key === "privacy.diagnostics") {
        if (Store.get("privacy.diagnostics")) start();
        else stop();
      }
    });
    if (Store.get("privacy.diagnostics")) start();

    return { start, stop, tick };
  })();

  window.SystemSettings.Diagnostics = Diagnostics;

  /* ==========================================================================
   * 19. Performance hints — when reduce-motion or low-memory devices are
   *     detected, automatically suggest disabling animations.
   *     This runs once on load and is purely informational.
   * ========================================================================*/

  (function _perfHints() {
    try {
      const lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 2);
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce && Store.get("appearance.animations")) {
        console.log("[Settings] System reports reduced-motion preference. Consider disabling 'Window animations'.");
      }
      if (lowMem && Store.get("appearance.transparency")) {
        console.log("[Settings] Low-memory device detected. Consider disabling 'Glassmorphism'.");
      }
    } catch (_) {}
  })();

  /* ==========================================================================
   * 20. Final boot log
   * ========================================================================*/

  console.log("%c[WebOS]%c Settings module ready (" +
    SchemaDoc.count() + " documented keys, schema v" + Migrator.CURRENT_VERSION + ")",
    "color:#7c3aed;font-weight:bold", "color:inherit");

})();
