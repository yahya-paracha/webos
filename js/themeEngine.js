/* ============================================================================
 * WebOS — themeEngine.js
 * ----------------------------------------------------------------------------
 * Manages theme switching and persistence.
 *   - 5 themes: dark, light, cyberpunk, retro, forest
 *   - 5 wallpapers: aurora, nebula, mountain, grid, solid
 *   - Persists choice to localStorage
 *   - Emits a "themechange" CustomEvent on document
 *   - Public API on window.ThemeEngine
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------------*/
  const STORAGE_KEY_THEME     = "webos.theme";
  const STORAGE_KEY_WALLPAPER = "webos.wallpaper";
  const STORAGE_KEY_ANIM      = "webos.animations";
  const STORAGE_KEY_SOUND     = "webos.sound";
  const STORAGE_KEY_ACCENT    = "webos.accent";

  const THEMES = Object.freeze({
    dark:      { id: "dark",      label: "Dark",      icon: "🌙" },
    light:     { id: "light",     label: "Light",     icon: "☀"  },
    cyberpunk: { id: "cyberpunk", label: "Cyberpunk", icon: "🌆" },
    retro:     { id: "retro",     label: "Retro",     icon: "📺" },
    forest:    { id: "forest",    label: "Forest",    icon: "🌲" },
  });

  const WALLPAPERS = Object.freeze({
    aurora:   { id: "aurora",   label: "Aurora"   },
    nebula:   { id: "nebula",   label: "Nebula"   },
    mountain: { id: "mountain", label: "Mountain" },
    grid:     { id: "grid",     label: "Grid"     },
    solid:    { id: "solid",    label: "Solid"    },
  });

  const DEFAULTS = Object.freeze({
    theme:      "dark",
    wallpaper:  "aurora",
    animations: true,
    sound:      false,
    accent:     null,
  });

  /* --------------------------------------------------------------------------
   * Storage helpers
   * ------------------------------------------------------------------------*/
  function safeGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v === null || v === undefined) return fallback;
      // Try JSON first (booleans / numbers), fall back to raw string
      try { return JSON.parse(v); } catch (_) { return v; }
    } catch (e) {
      console.warn("[ThemeEngine] localStorage read failed:", e);
      return fallback;
    }
  }

  function safeSet(key, value) {
    try {
      const v = (typeof value === "string") ? value : JSON.stringify(value);
      localStorage.setItem(key, v);
      return true;
    } catch (e) {
      console.warn("[ThemeEngine] localStorage write failed:", e);
      return false;
    }
  }

  function safeRemove(key) {
    try { localStorage.removeItem(key); return true; }
    catch (e) { return false; }
  }

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    theme:      DEFAULTS.theme,
    wallpaper:  DEFAULTS.wallpaper,
    animations: DEFAULTS.animations,
    sound:      DEFAULTS.sound,
    accent:     DEFAULTS.accent,
    listeners:  new Set(),
    initialized:false,
  };

  /* --------------------------------------------------------------------------
   * Internal — apply DOM changes
   * ------------------------------------------------------------------------*/
  function applyTheme(themeId, opts) {
    const o = opts || {};
    if (!THEMES[themeId]) {
      console.warn("[ThemeEngine] Unknown theme:", themeId, "— falling back to dark.");
      themeId = "dark";
    }
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme") || "dark";
    root.setAttribute("data-theme", themeId);

    // Helpful body class for CSS :has() fallbacks
    document.body.classList.remove(
      "theme-dark","theme-light","theme-cyberpunk","theme-retro","theme-forest"
    );
    document.body.classList.add("theme-" + themeId);

    state.theme = themeId;
    if (o.persist !== false) safeSet(STORAGE_KEY_THEME, themeId);

    emit("themechange", { theme: themeId, previous: prev });
    return themeId;
  }

  function applyWallpaper(wpId, opts) {
    const o = opts || {};
    if (!WALLPAPERS[wpId]) {
      console.warn("[ThemeEngine] Unknown wallpaper:", wpId, "— falling back to aurora.");
      wpId = "aurora";
    }
    const wp = document.getElementById("desktop-wallpaper");
    if (wp) wp.setAttribute("data-wallpaper", wpId);

    state.wallpaper = wpId;
    if (o.persist !== false) safeSet(STORAGE_KEY_WALLPAPER, wpId);

    emit("wallpaperchange", { wallpaper: wpId });
    return wpId;
  }

  function applyAnimations(enabled, opts) {
    const o = opts || {};
    state.animations = !!enabled;
    document.documentElement.classList.toggle("no-anim", !enabled);
    // soft-disable transitions/animations globally if needed
    if (!enabled) {
      let s = document.getElementById("__webos_no_anim__");
      if (!s) {
        s = document.createElement("style");
        s.id = "__webos_no_anim__";
        s.textContent = `
          *, *::before, *::after {
            animation-duration: 0.001ms !important;
            transition-duration: 0.001ms !important;
          }`;
        document.head.appendChild(s);
      }
    } else {
      const s = document.getElementById("__webos_no_anim__");
      if (s) s.remove();
    }
    if (o.persist !== false) safeSet(STORAGE_KEY_ANIM, !!enabled);
    emit("animationschange", { enabled: !!enabled });
    return !!enabled;
  }

  function applySound(enabled, opts) {
    const o = opts || {};
    state.sound = !!enabled;
    if (o.persist !== false) safeSet(STORAGE_KEY_SOUND, !!enabled);
    emit("soundchange", { enabled: !!enabled });
    return !!enabled;
  }

  function applyAccent(color, opts) {
    const o = opts || {};
    state.accent = color || null;
    const root = document.documentElement;
    if (color) {
      root.style.setProperty("--accent-1", color);
    } else {
      root.style.removeProperty("--accent-1");
    }
    if (o.persist !== false) safeSet(STORAGE_KEY_ACCENT, color || "");
    emit("accentchange", { color: color || null });
    return color || null;
  }

  /* --------------------------------------------------------------------------
   * Event helpers
   * ------------------------------------------------------------------------*/
  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent("webos:" + name, { detail }));
    } catch (e) { /* ignore */ }
    state.listeners.forEach((fn) => {
      try { fn(name, detail); } catch (err) { console.error(err); }
    });
  }

  function on(name, handler) {
    const evt = "webos:" + name;
    document.addEventListener(evt, handler);
    return () => document.removeEventListener(evt, handler);
  }

  function subscribe(handler) {
    state.listeners.add(handler);
    return () => state.listeners.delete(handler);
  }

  /* --------------------------------------------------------------------------
   * Public — getters
   * ------------------------------------------------------------------------*/
  function getTheme()      { return state.theme; }
  function getWallpaper()  { return state.wallpaper; }
  function getAnimations() { return state.animations; }
  function getSound()      { return state.sound; }
  function getAccent()     { return state.accent; }

  function listThemes()    { return Object.values(THEMES); }
  function listWallpapers(){ return Object.values(WALLPAPERS); }

  function isTheme(id)     { return id === state.theme; }
  function isWallpaper(id) { return id === state.wallpaper; }

  /* --------------------------------------------------------------------------
   * Public — actions
   * ------------------------------------------------------------------------*/
  function setTheme(themeId, opts)   { return applyTheme(themeId, opts); }
  function setWallpaper(wpId, opts)  { return applyWallpaper(wpId, opts); }
  function setAnimations(en, opts)   { return applyAnimations(en, opts); }
  function setSound(en, opts)        { return applySound(en, opts); }
  function setAccent(color, opts)    { return applyAccent(color, opts); }

  function nextTheme() {
    const ids = Object.keys(THEMES);
    const i = ids.indexOf(state.theme);
    const next = ids[(i + 1) % ids.length];
    return applyTheme(next, { persist: true });
  }

  function prevTheme() {
    const ids = Object.keys(THEMES);
    const i = ids.indexOf(state.theme);
    const prev = ids[(i - 1 + ids.length) % ids.length];
    return applyTheme(prev, { persist: true });
  }

  function nextWallpaper() {
    const ids = Object.keys(WALLPAPERS);
    const i = ids.indexOf(state.wallpaper);
    const next = ids[(i + 1) % ids.length];
    return applyWallpaper(next, { persist: true });
  }

  function reset() {
    applyTheme(DEFAULTS.theme, { persist: true });
    applyWallpaper(DEFAULTS.wallpaper, { persist: true });
    applyAnimations(DEFAULTS.animations, { persist: true });
    applySound(DEFAULTS.sound, { persist: true });
    applyAccent(null, { persist: true });
  }

  function exportSettings() {
    return {
      theme:      state.theme,
      wallpaper:  state.wallpaper,
      animations: state.animations,
      sound:      state.sound,
      accent:     state.accent,
      version:    1,
    };
  }

  function importSettings(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.theme)              applyTheme(obj.theme, { persist: true });
    if (obj.wallpaper)          applyWallpaper(obj.wallpaper, { persist: true });
    if ("animations" in obj)    applyAnimations(!!obj.animations, { persist: true });
    if ("sound" in obj)         applySound(!!obj.sound, { persist: true });
    if ("accent" in obj)        applyAccent(obj.accent || null, { persist: true });
    return true;
  }

  /* --------------------------------------------------------------------------
   * Color helpers (used by other subsystems for tinted UI)
   * ------------------------------------------------------------------------*/
  function readVar(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || "").trim();
  }

  function getAccentRGB() {
    const hex = readVar("--accent-1");
    return hexToRgb(hex);
  }

  function hexToRgb(hex) {
    if (!hex) return { r: 124, g: 58, b: 237 };
    let h = hex.trim().replace("#","");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6) return { r: 124, g: 58, b: 237 };
    const num = parseInt(h, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(
      Math.round(A.r + (B.r - A.r) * t),
      Math.round(A.g + (B.g - A.g) * t),
      Math.round(A.b + (B.b - A.b) * t)
    );
  }

  function withAlpha(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* --------------------------------------------------------------------------
   * System theme detection
   * ------------------------------------------------------------------------*/
  function getSystemPrefersDark() {
    try {
      return window.matchMedia &&
             window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (_) { return true; }
  }

  function followSystem(enable) {
    if (!enable) {
      if (state._mq) {
        try { state._mq.removeEventListener("change", state._mqHandler); } catch (_) {}
        state._mq = null;
        state._mqHandler = null;
      }
      return false;
    }
    try {
      state._mq = window.matchMedia("(prefers-color-scheme: dark)");
      state._mqHandler = (e) => applyTheme(e.matches ? "dark" : "light", { persist: false });
      state._mq.addEventListener("change", state._mqHandler);
      // initial
      applyTheme(state._mq.matches ? "dark" : "light", { persist: false });
      return true;
    } catch (e) {
      console.warn("[ThemeEngine] followSystem failed", e);
      return false;
    }
  }

  /* --------------------------------------------------------------------------
   * Bind UI controls (start menu chips, context menu items)
   * ------------------------------------------------------------------------*/
  function bindUIControls() {
    // Start menu theme chips
    document.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = btn.getAttribute("data-theme");
        if (id) {
          applyTheme(id, { persist: true });
          highlightActiveChips();
        }
      });
    });

    // Wallpaper picker (data-wallpaper attributes)
    document.querySelectorAll("[data-wallpaper]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.getAttribute("data-wallpaper");
        if (id) applyWallpaper(id, { persist: true });
      });
    });

    // Animations toggle
    const animToggle = document.getElementById("sm-toggle-anim");
    if (animToggle) {
      animToggle.checked = !!state.animations;
      animToggle.addEventListener("change", (e) => applyAnimations(e.target.checked, { persist: true }));
    }

    // Sound toggle
    const soundToggle = document.getElementById("sm-toggle-sound");
    if (soundToggle) {
      soundToggle.checked = !!state.sound;
      soundToggle.addEventListener("change", (e) => applySound(e.target.checked, { persist: true }));
    }

    highlightActiveChips();
  }

  function highlightActiveChips() {
    document.querySelectorAll(".sm-theme-chip[data-theme]").forEach((btn) => {
      const isActive = btn.getAttribute("data-theme") === state.theme;
      btn.classList.toggle("active", isActive);
    });
  }

  /* --------------------------------------------------------------------------
   * Keyboard shortcut: Ctrl + Shift + T cycles themes
   * ------------------------------------------------------------------------*/
  function bindKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        nextTheme();
      }
      if (e.ctrlKey && e.shiftKey && (e.key === "W" || e.key === "w")) {
        e.preventDefault();
        nextWallpaper();
      }
    });
  }

  /* --------------------------------------------------------------------------
   * Initialize
   * ------------------------------------------------------------------------*/
  function init() {
    if (state.initialized) return;
    state.initialized = true;

    // Load persisted prefs
    const t  = safeGet(STORAGE_KEY_THEME,     DEFAULTS.theme);
    const w  = safeGet(STORAGE_KEY_WALLPAPER, DEFAULTS.wallpaper);
    const a  = safeGet(STORAGE_KEY_ANIM,      DEFAULTS.animations);
    const s  = safeGet(STORAGE_KEY_SOUND,     DEFAULTS.sound);
    const ac = safeGet(STORAGE_KEY_ACCENT,    DEFAULTS.accent);

    applyTheme(typeof t === "string" ? t : DEFAULTS.theme,           { persist: false });
    applyWallpaper(typeof w === "string" ? w : DEFAULTS.wallpaper,   { persist: false });
    applyAnimations(typeof a === "boolean" ? a : DEFAULTS.animations,{ persist: false });
    applySound(typeof s === "boolean" ? s : DEFAULTS.sound,          { persist: false });
    if (ac && typeof ac === "string") applyAccent(ac, { persist: false });

    // Wait for DOM if needed before binding controls
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bindUIControls);
    } else {
      bindUIControls();
    }
    bindKeyboardShortcuts();

    console.log(
      "%c[WebOS]%c Theme engine ready — theme: %s, wallpaper: %s",
      "color:#7c3aed;font-weight:bold","color:inherit",
      state.theme, state.wallpaper
    );
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.ThemeEngine = {
    init,
    // getters
    getTheme, getWallpaper, getAnimations, getSound, getAccent,
    listThemes, listWallpapers, isTheme, isWallpaper,
    // setters
    setTheme, setWallpaper, setAnimations, setSound, setAccent,
    nextTheme, prevTheme, nextWallpaper,
    reset, exportSettings, importSettings,
    // events
    on, subscribe, emit,
    // helpers
    getAccentRGB, hexToRgb, rgbToHex, mix, withAlpha,
    getSystemPrefersDark, followSystem,
    // raw
    THEMES, WALLPAPERS, DEFAULTS,
    state: () => Object.assign({}, state, { listeners: undefined }),
  };

  // Auto-init now (defer ensures DOM order)
  init();
})();
