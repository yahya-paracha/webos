/* ============================================================================
 * WebOS — widgets.js
 * ----------------------------------------------------------------------------
 * Desktop widget system.
 *
 *   window.Widgets.add("clock")
 *   window.Widgets.remove(id)
 *   window.Widgets.openPicker()
 *   window.Widgets.register({ type, name, render, defaults })
 *
 * Widgets live on a dedicated layer above the wallpaper but below windows.
 *
 * Built-in widgets:
 *   1. Analog + Digital Clock
 *   2. Weather Widget
 *   3. Sticky Note
 *   4. System Monitor
 *   5. Mini Calendar
 *   6. Quick Launch Bar
 *
 * Public API on  window.Widgets
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * Constants & State
   * ========================================================================*/

  const STORAGE_KEY     = "webos.widgets.v1";
  const STORAGE_KEY_WEATHER = "webos.widget.weather.v1";
  const STORAGE_KEY_CAL_NOTES = "webos.widget.calendar.v1";
  const STORAGE_KEY_LAUNCH = "webos.widget.launch.v1";
  const FS_WIDGETS_DIR  = "/.widgets";
  const LAYER_ID        = "wg-layer";
  const UID_PREFIX      = "wg_";
  const MIN_W = 120;
  const MIN_H = 80;

  const state = {
    initialized: false,
    layer:       null,
    registry:    new Map(),   // type -> definition
    instances:   new Map(),   // id -> instance object
    dragging:    null,
    resizing:    null,
    saveTimer:   null,
    idCounter:   0,
    listeners:   new Set(),
  };

  /* ==========================================================================
   * Utilities
   * ========================================================================*/

  function uid() {
    state.idCounter++;
    return UID_PREFIX + Date.now().toString(36) + "_" + state.idCounter.toString(36);
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function viewport() {
    const el = document.getElementById("desktop") || document.body;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  function safeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }

  function safeSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (_) { return false; }
  }

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent("webos:widgets:" + name, { detail }));
    } catch (_) {}
    state.listeners.forEach((fn) => { try { fn(name, detail); } catch (e) { console.error(e); } });
  }

  function on(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  }

  /* ==========================================================================
   * Layer
   * ========================================================================*/

  function ensureLayer() {
    if (state.layer && document.body.contains(state.layer)) return state.layer;
    let el = document.getElementById(LAYER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = LAYER_ID;
      el.className = "wg-layer";
      const desktop = document.getElementById("desktop");
      const wallpaper = document.getElementById("desktop-wallpaper");
      if (desktop && wallpaper && wallpaper.nextSibling) {
        desktop.insertBefore(el, wallpaper.nextSibling);
      } else if (desktop) {
        desktop.appendChild(el);
      } else {
        document.body.appendChild(el);
      }
    }
    state.layer = el;
    return el;
  }

  /* ==========================================================================
   * Persistence
   * ========================================================================*/

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const snapshot = [];
      state.instances.forEach((inst) => {
        snapshot.push({
          id:      inst.id,
          type:    inst.type,
          x:       inst.x,
          y:       inst.y,
          width:   inst.width,
          height:  inst.height,
          opts:    inst.opts || {},
        });
      });
      safeSet(STORAGE_KEY, snapshot);
      state.saveTimer = null;
    }, 200);
  }

  function loadSnapshot() {
    return safeGet(STORAGE_KEY, []) || [];
  }

  /* ==========================================================================
   * Widget registry API
   * ========================================================================*/

  function register(def) {
    if (!def || !def.type) {
      console.warn("[Widgets] register: missing type");
      return false;
    }
    state.registry.set(def.type, Object.assign({
      type:        def.type,
      name:        def.name || def.type,
      description: def.description || "",
      icon:        def.icon || "▦",
      render:      def.render || (() => {}),
      defaults:    def.defaults || { width: 240, height: 180 },
      onDestroy:   def.onDestroy || null,
      minWidth:    def.minWidth  || MIN_W,
      minHeight:   def.minHeight || MIN_H,
      maxInstances: def.maxInstances || Infinity,
    }, def));
    return true;
  }

  function getRegistered() {
    return Array.from(state.registry.values());
  }

  function countType(type) {
    let n = 0;
    state.instances.forEach((i) => { if (i.type === type) n++; });
    return n;
  }

  /* ==========================================================================
   * Instance lifecycle
   * ========================================================================*/

  function add(type, opts) {
    const def = state.registry.get(type);
    if (!def) {
      console.warn("[Widgets] unknown type:", type);
      return null;
    }
    if (countType(type) >= def.maxInstances) {
      if (window.Notifications) {
        window.Notifications.warning(
          "Maximum reached",
          `Only ${def.maxInstances} "${def.name}" widget${def.maxInstances === 1 ? "" : "s"} allowed.`,
          { appName: "Widgets", appIcon: "▦" }
        );
      }
      return null;
    }

    opts = opts || {};
    const vp = viewport();
    const w = clamp(opts.width  || def.defaults.width  || 240, def.minWidth,  vp.w - 40);
    const h = clamp(opts.height || def.defaults.height || 180, def.minHeight, vp.h - 80);
    const defaultX = 24 + (state.instances.size * 16) % Math.max(10, vp.w - w - 40);
    const defaultY = 24 + (state.instances.size * 16) % Math.max(10, vp.h - h - 80);
    const x = clamp(opts.x != null ? opts.x : defaultX, 0, vp.w - w);
    const y = clamp(opts.y != null ? opts.y : defaultY, 0, vp.h - h);

    const inst = {
      id:       opts.id || uid(),
      type:     type,
      def:      def,
      x: x, y: y,
      width: w, height: h,
      opts:     opts.opts || {},
      el:       null,
      bodyEl:   null,
      api:      null,   // set by renderer if needed
    };

    buildDom(inst);
    state.instances.set(inst.id, inst);

    try {
      const ret = def.render(inst.bodyEl, inst);
      if (ret) inst.api = ret;
    } catch (e) {
      console.error("[Widgets] render failed:", e);
      inst.bodyEl.innerHTML = `<div style="padding:12px;color:#fca5a5;font-size:11px;">Widget failed to load.</div>`;
    }

    scheduleSave();
    emit("add", { id: inst.id, type });
    return inst;
  }

  function buildDom(inst) {
    const layer = ensureLayer();
    const el = document.createElement("div");
    el.className = "wg";
    el.dataset.id = inst.id;
    el.dataset.type = inst.type;
    el.style.left   = inst.x + "px";
    el.style.top    = inst.y + "px";
    el.style.width  = inst.width  + "px";
    el.style.height = inst.height + "px";

    el.innerHTML = `
      <div class="wg-header" data-drag>
        <div class="wg-header-title">
          <span>${escapeHtml(inst.def.icon)}</span>
          <span>${escapeHtml(inst.def.name)}</span>
        </div>
        <div class="wg-header-actions">
          <button class="wg-header-btn" data-act="config" title="Configure">⚙</button>
          <button class="wg-header-btn close" data-act="close" title="Remove">✕</button>
        </div>
      </div>
      <div class="wg-body"></div>
      <div class="wg-resize" data-resize></div>
    `;

    layer.appendChild(el);
    inst.el = el;
    inst.bodyEl = el.querySelector(".wg-body");

    // Bind actions
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const a = b.getAttribute("data-act");
      if (a === "close") remove(inst.id);
      else if (a === "config") {
        if (inst.api && typeof inst.api.openConfig === "function") inst.api.openConfig();
      }
    });

    // Right-click: context menu
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWidgetContext(inst, e.clientX, e.clientY);
    });

    bindDrag(inst);
    bindResize(inst);
  }

  function remove(id) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    try { if (inst.def.onDestroy) inst.def.onDestroy(inst); } catch (_) {}
    try { if (inst.api && typeof inst.api.destroy === "function") inst.api.destroy(); } catch (_) {}
    const el = inst.el;
    if (el) {
      el.classList.add("wg-closing");
      const done = () => { try { el.remove(); } catch (_) {} };
      el.addEventListener("animationend", done, { once: true });
      setTimeout(done, 240);
    }
    state.instances.delete(id);
    scheduleSave();
    emit("remove", { id });
    return true;
  }

  function removeAll() {
    Array.from(state.instances.keys()).forEach(remove);
  }

  function getInstances() {
    return Array.from(state.instances.values());
  }

  /* ==========================================================================
   * Drag
   * ========================================================================*/

  function bindDrag(inst) {
    const header = inst.el.querySelector("[data-drag]");
    if (!header) return;
    header.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".wg-header-btn")) return;
      e.preventDefault();
      inst.el.setPointerCapture(e.pointerId);
      inst.el.classList.add("wg-dragging");
      state.dragging = {
        inst,
        startX: e.clientX,
        startY: e.clientY,
        origX:  inst.x,
        origY:  inst.y,
        pid:    e.pointerId,
      };
    });
    inst.el.addEventListener("pointermove", onDragMove);
    inst.el.addEventListener("pointerup", onDragEnd);
    inst.el.addEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(e) {
    const s = state.dragging;
    if (!s) return;
    if (e.pointerId !== s.pid) return;
    const vp = viewport();
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    let nx = s.origX + dx;
    let ny = s.origY + dy;
    nx = clamp(nx, 0, vp.w - s.inst.width);
    ny = clamp(ny, 0, vp.h - s.inst.height - 48);
    s.inst.x = nx;
    s.inst.y = ny;
    s.inst.el.style.left = nx + "px";
    s.inst.el.style.top  = ny + "px";
  }

  function onDragEnd(e) {
    const s = state.dragging;
    if (!s) return;
    try { s.inst.el.releasePointerCapture(s.pid); } catch (_) {}
    s.inst.el.classList.remove("wg-dragging");
    state.dragging = null;
    scheduleSave();
  }

  /* ==========================================================================
   * Resize
   * ========================================================================*/

  function bindResize(inst) {
    const handle = inst.el.querySelector("[data-resize]");
    if (!handle) return;
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      inst.el.classList.add("wg-resizing");
      state.resizing = {
        inst,
        startX: e.clientX,
        startY: e.clientY,
        origW:  inst.width,
        origH:  inst.height,
        pid:    e.pointerId,
        handle,
      };
    });
    handle.addEventListener("pointermove", onResizeMove);
    handle.addEventListener("pointerup", onResizeEnd);
    handle.addEventListener("pointercancel", onResizeEnd);
  }

  function onResizeMove(e) {
    const s = state.resizing;
    if (!s) return;
    if (e.pointerId !== s.pid) return;
    const vp = viewport();
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    let nw = clamp(s.origW + dx, s.inst.def.minWidth, vp.w - s.inst.x - 8);
    let nh = clamp(s.origH + dy, s.inst.def.minHeight, vp.h - s.inst.y - 60);
    s.inst.width  = nw;
    s.inst.height = nh;
    s.inst.el.style.width  = nw + "px";
    s.inst.el.style.height = nh + "px";
    if (s.inst.api && typeof s.inst.api.onResize === "function") {
      try { s.inst.api.onResize(nw, nh); } catch (_) {}
    }
  }

  function onResizeEnd(e) {
    const s = state.resizing;
    if (!s) return;
    try { s.handle.releasePointerCapture(s.pid); } catch (_) {}
    s.inst.el.classList.remove("wg-resizing");
    state.resizing = null;
    scheduleSave();
  }

  /* ==========================================================================
   * Context menu for a widget
   * ========================================================================*/

  function showWidgetContext(inst, x, y) {
    if (!window.ContextMenu || !window.ContextMenu.show) {
      remove(inst.id);
      return;
    }
    const items = [
      { label: "Configure", icon: "⚙",
        disabled: !(inst.api && typeof inst.api.openConfig === "function"),
        action: () => { if (inst.api && inst.api.openConfig) inst.api.openConfig(); } },
      { label: "Bring to top", icon: "⬆",
        action: () => { inst.el.style.zIndex = String(Date.now() % 100000); } },
      { separator: true },
      { label: "Remove Widget", icon: "🗑",
        action: () => remove(inst.id) },
    ];
    window.ContextMenu.show({ x, y, items });
  }

  /* ==========================================================================
   * Picker dialog
   * ========================================================================*/

  function openPicker() {
    const overlay = document.createElement("div");
    overlay.className = "wg-picker-overlay";

    const widgets = getRegistered();
    const cardsHtml = widgets.map((def) => `
      <div class="wg-picker-card" data-type="${escapeHtml(def.type)}">
        <div class="wg-picker-preview">${escapeHtml(def.icon)}</div>
        <div class="wg-picker-name">${escapeHtml(def.name)}</div>
        <div class="wg-picker-desc">${escapeHtml(def.description || "")}</div>
      </div>
    `).join("");

    overlay.innerHTML = `
      <div class="wg-picker" role="dialog" aria-label="Add Widget">
        <div class="wg-picker-header">
          <h2>Add a widget</h2>
          <button class="wg-btn" data-close>✕</button>
        </div>
        <div class="wg-picker-body">
          ${cardsHtml}
        </div>
        <div class="wg-picker-footer">
          <button class="wg-btn" data-close>Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => { try { overlay.remove(); } catch (_) {} };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
      if (e.target.closest("[data-close]")) close();
      const card = e.target.closest(".wg-picker-card");
      if (card) {
        const type = card.getAttribute("data-type");
        close();
        add(type);
      }
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
  }

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: CLOCK =============================
   * ========================================================================*/

  register({
    type: "clock",
    name: "Clock",
    description: "Analog + digital clock",
    icon: "🕐",
    defaults: { width: 220, height: 220 },
    minWidth: 180, minHeight: 180,

    render(body, inst) {
      const opts = inst.opts;
      opts.showSeconds = opts.showSeconds !== false;
      opts.theme = opts.theme || "default";
      opts.digital = opts.digital !== false;

      const themeClass = opts.theme === "default" ? "" : "theme-" + opts.theme;
      body.innerHTML = `
        <div class="wg-clock ${themeClass} ${opts.showSeconds ? "" : "no-seconds"}">
          <svg class="wg-clock-svg" viewBox="0 0 120 120">
            <circle class="wg-clock-face" cx="60" cy="60" r="54"></circle>
            <g class="wg-clock-ticks"></g>
            <line class="wg-clock-hand-h" x1="60" y1="60" x2="60" y2="28"></line>
            <line class="wg-clock-hand-m" x1="60" y1="60" x2="60" y2="20"></line>
            <line class="wg-clock-hand-s" x1="60" y1="60" x2="60" y2="16"></line>
            <circle class="wg-clock-center" cx="60" cy="60" r="3.2"></circle>
          </svg>
          <div class="wg-clock-digital">--:--:--</div>
          <div class="wg-clock-date">—</div>
        </div>
      `;

      const root = body.querySelector(".wg-clock");
      const ticks = body.querySelector(".wg-clock-ticks");
      const handH = body.querySelector(".wg-clock-hand-h");
      const handM = body.querySelector(".wg-clock-hand-m");
      const handS = body.querySelector(".wg-clock-hand-s");
      const digitalEl = body.querySelector(".wg-clock-digital");
      const dateEl    = body.querySelector(".wg-clock-date");

      // Build tick marks
      for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        const r1 = major ? 46 : 49;
        const r2 = 53;
        const angle = (i / 60) * Math.PI * 2;
        const x1 = 60 + Math.sin(angle) * r1;
        const y1 = 60 - Math.cos(angle) * r1;
        const x2 = 60 + Math.sin(angle) * r2;
        const y2 = 60 - Math.cos(angle) * r2;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("class", "wg-clock-tick" + (major ? " major" : ""));
        line.setAttribute("x1", x1); line.setAttribute("y1", y1);
        line.setAttribute("x2", x2); line.setAttribute("y2", y2);
        ticks.appendChild(line);
      }

      function use24h() {
        const s = safeGet("webos.settings.v1", null);
        if (s && s.display && s.display.use24h != null) return !!s.display.use24h;
        return true;
      }

      function tick() {
        const now = new Date();
        const hh = now.getHours();
        const mm = now.getMinutes();
        const ss = now.getSeconds();
        const ms = now.getMilliseconds();

        const hAng = ((hh % 12) + mm / 60 + ss / 3600) * 30;
        const mAng = (mm + ss / 60) * 6;
        const sAng = (ss + ms / 1000) * 6;

        handH.style.transform = `rotate(${hAng}deg)`;
        handM.style.transform = `rotate(${mAng}deg)`;
        handS.style.transform = `rotate(${sAng}deg)`;

        if (opts.digital) {
          const t24 = use24h();
          if (t24) {
            digitalEl.textContent =
              String(hh).padStart(2, "0") + ":" +
              String(mm).padStart(2, "0") +
              (opts.showSeconds ? ":" + String(ss).padStart(2, "0") : "");
          } else {
            const h12 = ((hh + 11) % 12) + 1;
            const suf = hh >= 12 ? " PM" : " AM";
            digitalEl.textContent =
              String(h12) + ":" +
              String(mm).padStart(2, "0") +
              (opts.showSeconds ? ":" + String(ss).padStart(2, "0") : "") +
              suf;
          }
        } else {
          digitalEl.style.display = "none";
        }

        dateEl.textContent = now.toLocaleDateString(undefined, {
          weekday: "short", month: "short", day: "numeric", year: "numeric",
        });
      }

      tick();
      const interval = setInterval(tick, opts.showSeconds ? 250 : 1000);

      return {
        destroy() { clearInterval(interval); },
        openConfig() {
          const newTheme = prompt(
            "Clock theme (default, cyber, crimson, emerald, amber, violet):",
            opts.theme || "default"
          );
          if (newTheme == null) return;
          opts.theme = newTheme.trim() || "default";
          const ss = confirm("Show seconds hand?");
          opts.showSeconds = ss;
          // Re-render
          inst.def.render(body, inst);
          scheduleSave();
        },
      };
    },
  });

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: WEATHER ===========================
   * ========================================================================*/

  const WEATHER_CONDITIONS = [
    { key: "sunny",  label: "Sunny",        icon: "☀", css: "wg-sun-icon"   },
    { key: "cloudy", label: "Cloudy",       icon: "☁", css: "wg-cloud-icon" },
    { key: "rain",   label: "Rain",         icon: "🌧", css: "wg-rain-icon"  },
    { key: "snow",   label: "Snow",         icon: "❄", css: "wg-snow-icon"  },
    { key: "storm",  label: "Thunderstorm", icon: "⛈", css: "wg-storm-icon" },
    { key: "part",   label: "Partly cloudy",icon: "⛅", css: "wg-cloud-icon" },
  ];

  function sessionWeather() {
    // Consistent per session, but randomized per mount
    let saved = safeGet(STORAGE_KEY_WEATHER, null);
    if (saved && saved.ts && (Date.now() - saved.ts) < 1000 * 60 * 60 * 6) {
      return saved;
    }
    const cond = WEATHER_CONDITIONS[Math.floor(Math.random() * WEATHER_CONDITIONS.length)];
    const baseTempC = Math.round(
      cond.key === "snow"  ? (Math.random() * 6 - 6) :
      cond.key === "storm" ? (Math.random() * 10 + 12) :
      cond.key === "rain"  ? (Math.random() * 10 + 8) :
      cond.key === "sunny" ? (Math.random() * 12 + 22) :
                             (Math.random() * 10 + 14)
    );
    const forecast = [];
    for (let i = 0; i < 5; i++) {
      const c = WEATHER_CONDITIONS[Math.floor(Math.random() * WEATHER_CONDITIONS.length)];
      const hi = baseTempC + Math.round(Math.random() * 6 - 2);
      forecast.push({ cond: c.key, icon: c.icon, hi });
    }
    const data = {
      cond: cond.key,
      icon: cond.icon,
      label: cond.label,
      cssClass: cond.css,
      tempC: baseTempC,
      humidity: 30 + Math.round(Math.random() * 50),
      wind: 3 + Math.round(Math.random() * 20),
      city: "San Francisco",
      forecast,
      ts: Date.now(),
    };
    safeSet(STORAGE_KEY_WEATHER, data);
    return data;
  }

  register({
    type: "weather",
    name: "Weather",
    description: "Local forecast snapshot",
    icon: "☀",
    defaults: { width: 300, height: 200 },
    minWidth: 260, minHeight: 180,

    render(body, inst) {
      const opts = inst.opts;
      opts.unit = opts.unit || "C";
      const w = sessionWeather();
      if (opts.city) w.city = opts.city;

      function cToF(c) { return Math.round(c * 9 / 5 + 32); }
      function display(t) { return opts.unit === "F" ? cToF(t) + "°F" : t + "°C"; }

      const daysShort = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
      const today = new Date();
      body.innerHTML = `
        <div class="wg-weather">
          <div class="wg-weather-head">
            <input class="wg-weather-city" value="${escapeHtml(w.city)}" />
            <button class="wg-weather-unit">°${escapeHtml(opts.unit)}</button>
          </div>
          <div class="wg-weather-main">
            <div class="wg-weather-icon ${w.cssClass}">${w.icon}</div>
            <div>
              <div class="wg-weather-temp">${display(w.tempC)}</div>
              <div class="wg-weather-condition">${escapeHtml(w.label)}</div>
            </div>
          </div>
          <div class="wg-weather-stats">
            <span>💧 ${w.humidity}%</span>
            <span>💨 ${w.wind} km/h</span>
          </div>
          <div class="wg-weather-forecast">
            ${w.forecast.map((f, i) => {
              const d = new Date(today.getTime() + (i + 1) * 86400000);
              return `
                <div class="wg-weather-day">
                  <div class="wg-weather-day-name">${daysShort[d.getDay()]}</div>
                  <div class="wg-weather-day-icon">${f.icon}</div>
                  <div class="wg-weather-day-temp">${display(f.hi)}</div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;

      const cityInput = body.querySelector(".wg-weather-city");
      const unitBtn   = body.querySelector(".wg-weather-unit");

      cityInput.addEventListener("change", () => {
        opts.city = cityInput.value.trim() || "Unknown";
        const saved = safeGet(STORAGE_KEY_WEATHER, {}) || {};
        saved.city = opts.city; safeSet(STORAGE_KEY_WEATHER, saved);
        scheduleSave();
      });
      cityInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") cityInput.blur();
      });
      unitBtn.addEventListener("click", () => {
        opts.unit = opts.unit === "C" ? "F" : "C";
        scheduleSave();
        inst.def.render(body, inst);
      });

      return {};
    },
  });

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: STICKY NOTE =======================
   * ========================================================================*/

  const STICKY_COLORS = ["yellow","blue","green","pink","purple","orange"];

  register({
    type: "sticky",
    name: "Sticky Note",
    description: "Editable note",
    icon: "📝",
    defaults: { width: 220, height: 200 },
    minWidth: 160, minHeight: 140,

    render(body, inst) {
      const opts = inst.opts;
      opts.color = STICKY_COLORS.indexOf(opts.color) >= 0 ? opts.color : "yellow";
      opts.font  = opts.font  || 13;
      opts.noteId = opts.noteId || ("n_" + inst.id.slice(-8));

      const filePath = "/.widgets/sticky_" + opts.noteId + ".txt";

      function loadContent() {
        if (window.FileSystem) {
          try {
            if (window.FileSystem.exists(filePath)) {
              return window.FileSystem.readFile(filePath, { noRecent: true }) || "";
            }
          } catch (_) {}
        }
        return safeGet("webos.widget.sticky." + opts.noteId, "");
      }

      function saveContent(text) {
        if (window.FileSystem) {
          try {
            if (!window.FileSystem.exists(FS_WIDGETS_DIR)) {
              window.FileSystem.createFolder(FS_WIDGETS_DIR, { hidden: true });
            }
            window.FileSystem.writeFile(filePath, text, { kind: "text", hidden: true });
          } catch (e) {
            console.warn("[Sticky] FS save failed:", e);
          }
        }
        safeSet("webos.widget.sticky." + opts.noteId, text);
      }

      const initial = loadContent();

      body.innerHTML = `
        <div class="wg-sticky ${opts.color}" style="--sticky-fz:${opts.font}px;">
          <div class="wg-sticky-toolbar">
            <div class="wg-sticky-colors">
              ${STICKY_COLORS.map((c) => `
                <div class="wg-sticky-color ${opts.color === c ? "active" : ""}"
                     data-color="${c}" style="background:${stickyBg(c)};"></div>
              `).join("")}
            </div>
            <select class="wg-sticky-font">
              ${[10,12,13,14,16,18].map((n) => `
                <option value="${n}" ${n === opts.font ? "selected" : ""}>${n}px</option>
              `).join("")}
            </select>
          </div>
          <textarea class="wg-sticky-area" placeholder="Write something...">${escapeHtml(initial)}</textarea>
        </div>
      `;

      const host = body.querySelector(".wg-sticky");
      const area = body.querySelector(".wg-sticky-area");
      const fontSel = body.querySelector(".wg-sticky-font");

      host.querySelectorAll(".wg-sticky-color").forEach((c) => {
        c.addEventListener("click", () => {
          opts.color = c.getAttribute("data-color");
          host.className = "wg-sticky " + opts.color;
          host.querySelectorAll(".wg-sticky-color").forEach((x) => x.classList.remove("active"));
          c.classList.add("active");
          scheduleSave();
        });
      });

      fontSel.addEventListener("change", () => {
        opts.font = parseInt(fontSel.value, 10) || 13;
        host.style.setProperty("--sticky-fz", opts.font + "px");
        scheduleSave();
      });

      let saveTimer = null;
      area.addEventListener("input", () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveContent(area.value), 400);
      });

      return {
        destroy() {
          if (saveTimer) clearTimeout(saveTimer);
          saveContent(area.value);
        },
      };
    },
  });

  function stickyBg(color) {
    return ({
      yellow: "#fde68a", blue: "#bfdbfe", green: "#bbf7d0",
      pink:   "#fbcfe8", purple: "#ddd6fe", orange: "#fed7aa",
    })[color] || "#fde68a";
  }

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: SYSTEM MONITOR ====================
   * ========================================================================*/

  register({
    type: "sysmon",
    name: "System Monitor",
    description: "CPU, RAM, disk & network",
    icon: "📊",
    defaults: { width: 260, height: 220 },
    minWidth: 220, minHeight: 180,

    render(body, inst) {
      body.innerHTML = `
        <div class="wg-sysmon">
          <div class="wg-sysmon-row">
            <div class="wg-sysmon-label">CPU</div>
            <div class="wg-sysmon-bar"><div class="wg-sysmon-bar-fill" data-cpu></div></div>
            <div class="wg-sysmon-value" data-cpu-val>0%</div>
          </div>
          <div class="wg-sysmon-row">
            <div class="wg-sysmon-label">RAM</div>
            <div class="wg-sysmon-bar"><div class="wg-sysmon-bar-fill" data-ram></div></div>
            <div class="wg-sysmon-value" data-ram-val>0%</div>
          </div>
          <div class="wg-sysmon-row">
            <div class="wg-sysmon-label">DISK</div>
            <div class="wg-sysmon-bar"><div class="wg-sysmon-bar-fill" data-disk></div></div>
            <div class="wg-sysmon-value" data-disk-val>0%</div>
          </div>
          <div class="wg-sysmon-row">
            <div class="wg-sysmon-label">NET ↓</div>
            <div class="wg-sysmon-bar"><div class="wg-sysmon-bar-fill" data-net-in></div></div>
            <div class="wg-sysmon-value" data-net-in-val>0 KB/s</div>
          </div>
          <div class="wg-sysmon-row">
            <div class="wg-sysmon-label">NET ↑</div>
            <div class="wg-sysmon-bar"><div class="wg-sysmon-bar-fill" data-net-out></div></div>
            <div class="wg-sysmon-value" data-net-out-val>0 KB/s</div>
          </div>
          <svg class="wg-sysmon-spark" viewBox="0 0 120 40" preserveAspectRatio="none">
            <path d="" stroke="url(#spark-grad)" stroke-width="1.4" fill="none" data-spark />
            <defs>
              <linearGradient id="spark-grad" x1="0" x2="1">
                <stop offset="0%" stop-color="#06b6d4" />
                <stop offset="100%" stop-color="#7c3aed" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      `;

      const cpuEl    = body.querySelector("[data-cpu]");
      const cpuVal   = body.querySelector("[data-cpu-val]");
      const ramEl    = body.querySelector("[data-ram]");
      const ramVal   = body.querySelector("[data-ram-val]");
      const diskEl   = body.querySelector("[data-disk]");
      const diskVal  = body.querySelector("[data-disk-val]");
      const inEl     = body.querySelector("[data-net-in]");
      const inVal    = body.querySelector("[data-net-in-val]");
      const outEl    = body.querySelector("[data-net-out]");
      const outVal   = body.querySelector("[data-net-out-val]");
      const spark    = body.querySelector("[data-spark]");

      let cpu = 20, ram = 42, netIn = 20, netOut = 8;
      const history = [];
      const HISTORY_MAX = 30;

      function realisticCpu(prev) {
        // Random walk with occasional spikes
        let delta = (Math.random() - 0.5) * 14;
        if (Math.random() < 0.06) delta += (Math.random() - 0.5) * 50;
        let next = prev + delta;
        return clamp(next, 3, 98);
      }
      function realisticRam(prev) {
        const delta = (Math.random() - 0.5) * 4;
        return clamp(prev + delta, 25, 88);
      }
      function realisticNet(prev, max) {
        const delta = (Math.random() - 0.5) * (max * 0.3);
        return clamp(prev + delta, 0, max);
      }

      function diskUsage() {
        if (window.FileSystem && typeof window.FileSystem.diskUsage === "function") {
          try {
            const du = window.FileSystem.diskUsage();
            if (du && typeof du.usedPercent === "number") {
              return clamp(du.usedPercent, 0, 100);
            }
            if (du && du.total && du.used) {
              return clamp((du.used / du.total) * 100, 0, 100);
            }
          } catch (_) {}
        }
        // Fallback to a pseudo estimate
        return 38 + (Math.random() * 4);
      }

      function pctBar(el, val) {
        el.style.width = val.toFixed(1) + "%";
        if (val > 85) el.classList.add("warn");
        else el.classList.remove("warn");
      }

      function updateSpark() {
        // Normalize to 0..40
        if (history.length < 2) { spark.setAttribute("d", ""); return; }
        const step = 120 / (HISTORY_MAX - 1);
        const pts = history.slice(-HISTORY_MAX);
        const start = HISTORY_MAX - pts.length;
        const d = pts.map((v, i) => {
          const x = (start + i) * step;
          const y = 40 - (v / 100) * 36 - 2;
          return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
        }).join(" ");
        spark.setAttribute("d", d);
      }

      function tick() {
        cpu = realisticCpu(cpu);
        ram = realisticRam(ram);
        netIn  = realisticNet(netIn,  1024);
        netOut = realisticNet(netOut, 512);
        const disk = diskUsage();

        pctBar(cpuEl, cpu);   cpuVal.textContent  = cpu.toFixed(1) + "%";
        pctBar(ramEl, ram);   ramVal.textContent  = ram.toFixed(1) + "%";
        pctBar(diskEl, disk); diskVal.textContent = disk.toFixed(1) + "%";
        const inPct  = (netIn  / 1024) * 100;
        const outPct = (netOut / 512)  * 100;
        pctBar(inEl,  inPct);  inVal.textContent  = netIn.toFixed(0)  + " KB/s";
        pctBar(outEl, outPct); outVal.textContent = netOut.toFixed(0) + " KB/s";

        history.push(cpu);
        if (history.length > HISTORY_MAX) history.shift();
        updateSpark();
      }

      tick();
      const interval = setInterval(tick, 2000);

      return {
        destroy() { clearInterval(interval); },
      };
    },
  });

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: MINI CALENDAR =====================
   * ========================================================================*/

  register({
    type: "calendar",
    name: "Calendar",
    description: "Month view with notes",
    icon: "📅",
    defaults: { width: 280, height: 260 },
    minWidth: 240, minHeight: 220,

    render(body, inst) {
      let viewDate = new Date();
      viewDate.setDate(1);

      function loadNotes() { return safeGet(STORAGE_KEY_CAL_NOTES, {}) || {}; }
      function saveNotes(n) { safeSet(STORAGE_KEY_CAL_NOTES, n); }

      function keyFor(year, month, day) {
        return year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
      }

      function render() {
        const y = viewDate.getFullYear();
        const m = viewDate.getMonth();
        const firstDow = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const daysPrev    = new Date(y, m, 0).getDate();
        const today = new Date();
        const monthName = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        const dows = ["S","M","T","W","T","F","S"];
        const notes = loadNotes();

        const cells = [];
        // Leading days (previous month)
        for (let i = firstDow - 1; i >= 0; i--) {
          const d = daysPrev - i;
          cells.push({ day: d, muted: true, date: new Date(y, m - 1, d) });
        }
        // Current month days
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push({ day: d, muted: false, date: new Date(y, m, d) });
        }
        // Trailing days (next month) to fill 6 weeks
        while (cells.length % 7 !== 0 || cells.length < 42) {
          const lastCell = cells[cells.length - 1];
          const last = lastCell ? lastCell.date : new Date(y, m, daysInMonth);
          const next = new Date(last.getTime() + 86400000);
          cells.push({ day: next.getDate(), muted: true, date: next });
          if (cells.length >= 42) break;
        }

        body.innerHTML = `
          <div class="wg-cal">
            <div class="wg-cal-head">
              <div class="wg-cal-title">${escapeHtml(monthName)}</div>
              <div class="wg-cal-nav">
                <button class="wg-cal-nav-btn" data-prev>‹</button>
                <button class="wg-cal-nav-btn" data-today>•</button>
                <button class="wg-cal-nav-btn" data-next>›</button>
              </div>
            </div>
            <div class="wg-cal-grid">
              ${dows.map((x) => `<div class="wg-cal-dow">${x}</div>`).join("")}
              ${cells.map((c) => {
                const isToday = c.date.toDateString() === today.toDateString();
                const k = keyFor(c.date.getFullYear(), c.date.getMonth(), c.day);
                const has = !!notes[k];
                return `<div class="wg-cal-day ${c.muted ? "muted" : ""} ${isToday ? "today" : ""} ${has ? "has-note" : ""}"
                             data-key="${k}" data-day="${c.day}" title="${escapeHtml(notes[k] || "")}">
                          ${c.day}
                        </div>`;
              }).join("")}
            </div>
          </div>
        `;

        body.querySelector("[data-prev]").onclick = () => {
          viewDate = new Date(y, m - 1, 1); render();
        };
        body.querySelector("[data-next]").onclick = () => {
          viewDate = new Date(y, m + 1, 1); render();
        };
        body.querySelector("[data-today]").onclick = () => {
          viewDate = new Date();
          viewDate.setDate(1);
          render();
        };
        body.querySelectorAll(".wg-cal-day").forEach((el) => {
          el.addEventListener("click", () => {
            const k = el.getAttribute("data-key");
            const n = loadNotes();
            const existing = n[k] || "";
            const next = prompt("Note for " + k + ":", existing);
            if (next == null) return;
            if (next.trim() === "") delete n[k];
            else n[k] = next.trim();
            saveNotes(n);
            render();
          });
        });
      }

      render();

      return {};
    },
  });

  /* ==========================================================================
   * ===================== BUILT-IN WIDGET: QUICK LAUNCH ======================
   * ========================================================================*/

  register({
    type: "launch",
    name: "Quick Launch",
    description: "Horizontal app launcher",
    icon: "🚀",
    defaults: { width: 360, height: 70 },
    minWidth: 160, minHeight: 60,
    maxInstances: 2,

    render(body, inst) {
      const opts = inst.opts;
      opts.apps = Array.isArray(opts.apps) && opts.apps.length
        ? opts.apps
        : safeGet(STORAGE_KEY_LAUNCH, null)
          || defaultLaunchItems();

      function saveItems() {
        scheduleSave();
        safeSet(STORAGE_KEY_LAUNCH, opts.apps.slice());
      }

      function defaultLaunchItems() {
        const pref = ["filemanager","notepad","browser","calculator","paint","terminal","settings","aria"];
        if (!window.WindowManager || !window.WindowManager.getApps) return pref.slice(0, 5);
        const all = window.WindowManager.getApps().map((a) => a.id);
        return pref.filter((p) => all.indexOf(p) >= 0).slice(0, 6);
      }

      function render() {
        const apps = opts.apps;
        const wm = window.WindowManager;
        const html = apps.map((aid) => {
          const def = wm && wm.getApp && wm.getApp(aid);
          const icon = def ? def.icon : "▦";
          const title = def ? def.title : aid;
          return `
            <div class="wg-launch-item" draggable="true" data-app="${escapeHtml(aid)}" title="${escapeHtml(title)}">
              ${escapeHtml(icon)}
              <div class="wg-launch-item-label">${escapeHtml(title)}</div>
            </div>
          `;
        }).join("");

        body.innerHTML = `
          <div class="wg-launch">
            ${html}
            <div class="wg-launch-add" data-add title="Add app">+</div>
          </div>
        `;

        body.querySelectorAll(".wg-launch-item").forEach((el) => {
          const aid = el.getAttribute("data-app");
          el.addEventListener("click", (e) => {
            if (el.classList.contains("wg-launch-drag")) return;
            if (window.WindowManager && window.WindowManager.openApp) {
              window.WindowManager.openApp(aid);
            }
          });
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!window.ContextMenu || !window.ContextMenu.show) return;
            window.ContextMenu.show({
              x: e.clientX, y: e.clientY,
              items: [
                { label: "Launch", icon: "▶", action: () => window.WindowManager && window.WindowManager.openApp(aid) },
                { separator: true },
                { label: "Remove from Quick Launch", icon: "✕",
                  action: () => {
                    opts.apps = opts.apps.filter((x) => x !== aid);
                    saveItems();
                    render();
                  }
                },
              ],
            });
          });
          // Drag to reorder
          el.addEventListener("dragstart", (e) => {
            el.classList.add("wg-launch-drag");
            e.dataTransfer.setData("text/plain", aid);
            e.dataTransfer.effectAllowed = "move";
          });
          el.addEventListener("dragend", () => el.classList.remove("wg-launch-drag"));
          el.addEventListener("dragover", (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          });
          el.addEventListener("drop", (e) => {
            e.preventDefault();
            const src = e.dataTransfer.getData("text/plain");
            if (!src || src === aid) return;
            const arr = opts.apps.slice();
            const sIdx = arr.indexOf(src);
            const dIdx = arr.indexOf(aid);
            if (sIdx < 0 || dIdx < 0) return;
            arr.splice(sIdx, 1);
            arr.splice(dIdx, 0, src);
            opts.apps = arr;
            saveItems();
            render();
          });
        });

        body.querySelector("[data-add]").addEventListener("click", (e) => {
          e.stopPropagation();
          showAppPickerMenu(e.clientX, e.clientY);
        });
      }

      function showAppPickerMenu(x, y) {
        if (!window.ContextMenu || !window.ContextMenu.show) return;
        const wm = window.WindowManager;
        const all = (wm && wm.getApps) ? wm.getApps() : [];
        const current = new Set(opts.apps);
        const items = all
          .filter((a) => !current.has(a.id))
          .map((a) => ({
            label: a.title || a.id,
            icon: a.icon || "▦",
            action: () => {
              opts.apps.push(a.id);
              saveItems();
              render();
            },
          }));
        if (items.length === 0) {
          items.push({ label: "All apps already added", disabled: true });
        }
        window.ContextMenu.show({ x, y, items });
      }

      render();

      return {
        onResize() { /* CSS handles */ },
      };
    },
  });

  /* ==========================================================================
   * Restore from storage
   * ========================================================================*/

  function restoreAll() {
    const snap = loadSnapshot();
    if (!Array.isArray(snap)) return;
    snap.forEach((entry) => {
      if (!entry || !entry.type) return;
      try {
        add(entry.type, {
          id:     entry.id,
          x:      entry.x,
          y:      entry.y,
          width:  entry.width,
          height: entry.height,
          opts:   entry.opts || {},
        });
      } catch (e) {
        console.warn("[Widgets] restore failed:", e);
      }
    });
  }

  /* ==========================================================================
   * Integration: desktop right-click menu
   * ========================================================================*/

  function hookDesktopContextMenu() {
    // Intercept clicks on the desktop: when user right-clicks empty space,
    // the existing context menu opens. We also listen for a custom event
    // so other modules can trigger the picker.
    document.addEventListener("webos:widgets:open-picker", openPicker);

    // Also add a global shortcut: Ctrl+Alt+W → picker
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "w" || e.key === "W")) {
        const tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        openPicker();
      }
    }, true);
  }

  /* ==========================================================================
   * Integrate with existing desktop context menu
   *
   * The Desktop right-click menu is built by contextMenus.js via
   * ContextMenu.forDesktop(). We patch it by attaching an extra handler to
   * the "contextmenu" event on the desktop background that shows our own
   * "Add Widget" item.
   * ========================================================================*/

  function interceptDesktopContextMenu() {
    const desktop = document.getElementById("desktop");
    if (!desktop) return;
    desktop.addEventListener("contextmenu", (e) => {
      // Only show widget shortcut when right-clicking on empty desktop
      const onIcon = e.target.closest(".desktop-icon");
      const onWidget = e.target.closest(".wg");
      const onWindow = e.target.closest(".window");
      const onTaskbar = e.target.closest(".taskbar");
      if (onIcon || onWidget || onWindow || onTaskbar) return;
      // Attach a small follow-up: after base menu opens, append our item
      setTimeout(addWidgetItemToBaseMenu, 0);
    }, true);
  }

  function addWidgetItemToBaseMenu() {
    const menus = document.querySelectorAll(".webos-ctx");
    if (!menus.length) return;
    const menu = menus[menus.length - 1];
    if (menu.querySelector("[data-wg-entry]")) return;

    const sep = document.createElement("div");
    sep.className = "webos-ctx-sep";
    sep.setAttribute("data-wg-entry", "sep");

    const item = document.createElement("div");
    item.className = "webos-ctx-item";
    item.setAttribute("data-wg-entry", "add");
    item.innerHTML = `
      <span class="webos-ctx-ico">▦</span>
      <span class="webos-ctx-label">Add Widget…</span>
      <span class="webos-ctx-acc"></span>
    `;
    item.addEventListener("click", () => {
      // Try to close the existing ctx menu
      if (window.ContextMenu && window.ContextMenu.hide) {
        try { window.ContextMenu.hide(); } catch (_) {}
      }
      openPicker();
    });

    // Insert after the first separator if possible, otherwise at end
    menu.appendChild(sep);
    menu.appendChild(item);
  }

  /* ==========================================================================
   * Public getInstance / config helpers
   * ========================================================================*/

  function getInstance(id) {
    return state.instances.get(id) || null;
  }

  function update(id, patch) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    if (patch.x != null) { inst.x = patch.x; inst.el.style.left = inst.x + "px"; }
    if (patch.y != null) { inst.y = patch.y; inst.el.style.top  = inst.y + "px"; }
    if (patch.width  != null) { inst.width  = patch.width;  inst.el.style.width  = inst.width  + "px"; }
    if (patch.height != null) { inst.height = patch.height; inst.el.style.height = inst.height + "px"; }
    if (patch.opts) Object.assign(inst.opts, patch.opts);
    scheduleSave();
    return true;
  }

  function rerender(id) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    try { if (inst.api && inst.api.destroy) inst.api.destroy(); } catch (_) {}
    inst.bodyEl.innerHTML = "";
    try {
      const ret = inst.def.render(inst.bodyEl, inst);
      if (ret) inst.api = ret;
    } catch (e) {
      console.error(e);
    }
    return true;
  }

  /* ==========================================================================
   * Collision detection (best-effort non-overlap on drop)
   * ========================================================================*/

  function rectsOverlap(a, b) {
    return !(
      a.x + a.width  <= b.x ||
      b.x + b.width  <= a.x ||
      a.y + a.height <= b.y ||
      b.y + b.height <= a.y
    );
  }

  function findFreePosition(width, height, preferred) {
    const vp = viewport();
    const pref = preferred || { x: 24, y: 24 };
    const others = [];
    state.instances.forEach((i) => {
      others.push({ x: i.x, y: i.y, width: i.width, height: i.height });
    });
    // Try preferred first
    const first = { x: pref.x, y: pref.y, width, height };
    if (!others.some((o) => rectsOverlap(first, o))) return { x: pref.x, y: pref.y };
    // Scan in a grid
    const step = 16;
    for (let y = 16; y < vp.h - height - 60; y += step) {
      for (let x = 16; x < vp.w - width - 16; x += step) {
        const r = { x, y, width, height };
        if (!others.some((o) => rectsOverlap(r, o))) return { x, y };
      }
    }
    return { x: pref.x, y: pref.y };
  }

  /* ==========================================================================
   * Grid snapping
   * ========================================================================*/

  const GRID_SIZE = 8;

  function snapToGrid(n) {
    return Math.round(n / GRID_SIZE) * GRID_SIZE;
  }

  function snapInstance(id) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    inst.x = snapToGrid(inst.x);
    inst.y = snapToGrid(inst.y);
    inst.width  = Math.max(inst.def.minWidth,  snapToGrid(inst.width));
    inst.height = Math.max(inst.def.minHeight, snapToGrid(inst.height));
    inst.el.style.left   = inst.x + "px";
    inst.el.style.top    = inst.y + "px";
    inst.el.style.width  = inst.width + "px";
    inst.el.style.height = inst.height + "px";
    scheduleSave();
    return true;
  }

  function snapAll() {
    state.instances.forEach((_, id) => snapInstance(id));
  }

  /* ==========================================================================
   * Arrange
   * ========================================================================*/

  function arrange(direction) {
    // direction: "row-top" | "row-bottom" | "column-left" | "column-right"
    const vp = viewport();
    const list = Array.from(state.instances.values());
    if (list.length === 0) return 0;
    let cursor = 16;

    if (direction === "row-bottom" || !direction) {
      // Bottom row, left to right
      let x = 16;
      const rowY = Math.max(40, vp.h - 48 - 240);
      list.forEach((inst) => {
        if (x + inst.width > vp.w - 16) {
          cursor += 260;
          x = 16;
        }
        inst.x = x;
        inst.y = rowY;
        inst.el.style.left = inst.x + "px";
        inst.el.style.top  = inst.y + "px";
        x += inst.width + 16;
      });
    } else if (direction === "row-top") {
      let x = 16;
      const rowY = 16;
      list.forEach((inst) => {
        if (x + inst.width > vp.w - 16) { x = 16; cursor += 260; }
        inst.x = x;
        inst.y = rowY + cursor - 16;
        inst.el.style.left = inst.x + "px";
        inst.el.style.top  = inst.y + "px";
        x += inst.width + 16;
      });
    } else if (direction === "column-left") {
      let y = 16;
      list.forEach((inst) => {
        inst.x = 16;
        inst.y = y;
        inst.el.style.left = inst.x + "px";
        inst.el.style.top  = inst.y + "px";
        y += inst.height + 16;
      });
    } else if (direction === "column-right") {
      list.forEach((inst) => {
        inst.x = vp.w - inst.width - 16;
        inst.el.style.left = inst.x + "px";
      });
      let y = 16;
      list.forEach((inst) => {
        inst.y = y;
        inst.el.style.top = inst.y + "px";
        y += inst.height + 16;
      });
    }
    scheduleSave();
    return list.length;
  }

  /* ==========================================================================
   * Duplicate
   * ========================================================================*/

  function duplicate(id) {
    const inst = state.instances.get(id);
    if (!inst) return null;
    const newOpts = JSON.parse(JSON.stringify(inst.opts || {}));
    // Ensure sticky notes get a fresh noteId so content is independent
    if (inst.type === "sticky") newOpts.noteId = null;
    const newInst = add(inst.type, {
      x: Math.min(inst.x + 24, viewport().w - inst.width - 8),
      y: Math.min(inst.y + 24, viewport().h - inst.height - 60),
      width: inst.width,
      height: inst.height,
      opts: newOpts,
    });
    return newInst ? newInst.id : null;
  }

  /* ==========================================================================
   * Keyboard move / resize (when a widget is hovered and Ctrl+arrow pressed)
   *
   * We don't actually give widgets keyboard focus, but we do track the
   * last-hovered widget id so the user can nudge with the keyboard.
   * ========================================================================*/

  let lastHoveredId = null;

  function trackHover() {
    document.addEventListener("mouseover", (e) => {
      const w = e.target.closest && e.target.closest(".wg");
      if (w) lastHoveredId = w.dataset.id;
    });
    document.addEventListener("mouseout", (e) => {
      const w = e.target.closest && e.target.closest(".wg");
      if (!w) return;
      // leaving
    });
    document.addEventListener("keydown", (e) => {
      if (!lastHoveredId) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!(e.key === "ArrowLeft" || e.key === "ArrowRight" ||
            e.key === "ArrowUp"   || e.key === "ArrowDown")) return;
      const inst = state.instances.get(lastHoveredId);
      if (!inst) return;
      e.preventDefault();
      const step = e.shiftKey ? 32 : 8;
      const vp = viewport();
      if (e.key === "ArrowLeft")  inst.x = Math.max(0, inst.x - step);
      if (e.key === "ArrowRight") inst.x = Math.min(vp.w - inst.width, inst.x + step);
      if (e.key === "ArrowUp")    inst.y = Math.max(0, inst.y - step);
      if (e.key === "ArrowDown")  inst.y = Math.min(vp.h - inst.height - 48, inst.y + step);
      inst.el.style.left = inst.x + "px";
      inst.el.style.top  = inst.y + "px";
      scheduleSave();
    }, true);
  }

  /* ==========================================================================
   * Tiling helpers (quadrant snap)
   * ========================================================================*/

  function tile(id, quadrant) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    const vp = viewport();
    const halfW = Math.floor(vp.w / 2) - 16;
    const halfH = Math.floor((vp.h - 48) / 2) - 16;
    switch (quadrant) {
      case "tl": inst.x = 8;             inst.y = 8;             break;
      case "tr": inst.x = vp.w - halfW - 8; inst.y = 8;          break;
      case "bl": inst.x = 8;             inst.y = vp.h - 48 - halfH - 8; break;
      case "br": inst.x = vp.w - halfW - 8; inst.y = vp.h - 48 - halfH - 8; break;
      default: return false;
    }
    inst.width  = halfW;
    inst.height = halfH;
    inst.el.style.left   = inst.x + "px";
    inst.el.style.top    = inst.y + "px";
    inst.el.style.width  = inst.width  + "px";
    inst.el.style.height = inst.height + "px";
    scheduleSave();
    return true;
  }

  /* ==========================================================================
   * Inter-widget messaging bus
   *
   * Widgets can broadcast small messages (e.g. theme swap, re-sync) that
   * any registered subscriber can listen to. Used internally for the
   * calendar → sticky note integration and potential future features.
   * ========================================================================*/

  const busSubscribers = new Map();

  function publish(topic, data) {
    const subs = busSubscribers.get(topic);
    if (!subs) return 0;
    let called = 0;
    subs.forEach((fn) => {
      try { fn(data); called++; } catch (e) { console.error(e); }
    });
    return called;
  }

  function subscribe(topic, fn) {
    if (!topic || typeof fn !== "function") return () => {};
    if (!busSubscribers.has(topic)) busSubscribers.set(topic, new Set());
    busSubscribers.get(topic).add(fn);
    return () => {
      const s = busSubscribers.get(topic);
      if (s) s.delete(fn);
    };
  }

  /* ==========================================================================
   * Distribution helpers (evenly space selected widgets)
   * ========================================================================*/

  function distributeHorizontally() {
    const list = Array.from(state.instances.values()).sort((a, b) => a.x - b.x);
    if (list.length < 3) return 0;
    const first = list[0];
    const last  = list[list.length - 1];
    const totalSpan = (last.x + last.width) - first.x;
    const usedSpan  = list.reduce((sum, i) => sum + i.width, 0);
    const gap = Math.max(8, (totalSpan - usedSpan) / (list.length - 1));
    let cursor = first.x + first.width + gap;
    for (let i = 1; i < list.length - 1; i++) {
      list[i].x = Math.round(cursor);
      list[i].el.style.left = list[i].x + "px";
      cursor += list[i].width + gap;
    }
    scheduleSave();
    return list.length;
  }

  function distributeVertically() {
    const list = Array.from(state.instances.values()).sort((a, b) => a.y - b.y);
    if (list.length < 3) return 0;
    const first = list[0];
    const last  = list[list.length - 1];
    const totalSpan = (last.y + last.height) - first.y;
    const usedSpan  = list.reduce((sum, i) => sum + i.height, 0);
    const gap = Math.max(8, (totalSpan - usedSpan) / (list.length - 1));
    let cursor = first.y + first.height + gap;
    for (let i = 1; i < list.length - 1; i++) {
      list[i].y = Math.round(cursor);
      list[i].el.style.top = list[i].y + "px";
      cursor += list[i].height + gap;
    }
    scheduleSave();
    return list.length;
  }

  /* ==========================================================================
   * Auto-arrange along edges (alignment helpers)
   * ========================================================================*/

  function alignToEdge(id, edge) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    const vp = viewport();
    if (edge === "left")   inst.x = 16;
    if (edge === "right")  inst.x = vp.w - inst.width - 16;
    if (edge === "top")    inst.y = 16;
    if (edge === "bottom") inst.y = vp.h - inst.height - 64;
    if (edge === "center-x") inst.x = Math.round((vp.w - inst.width)  / 2);
    if (edge === "center-y") inst.y = Math.round((vp.h - inst.height) / 2);
    inst.el.style.left = inst.x + "px";
    inst.el.style.top  = inst.y + "px";
    scheduleSave();
    return true;
  }

  function centerAll() {
    const vp = viewport();
    state.instances.forEach((inst) => {
      inst.x = Math.max(0, Math.round((vp.w - inst.width) / 2));
      inst.y = Math.max(0, Math.round((vp.h - inst.height) / 2));
      inst.el.style.left = inst.x + "px";
      inst.el.style.top  = inst.y + "px";
    });
    scheduleSave();
  }

  /* ==========================================================================
   * Widget metadata helpers
   * ========================================================================*/

  function getCategory(type) {
    const map = {
      clock:    "Time",
      calendar: "Time",
      weather:  "Information",
      sticky:   "Productivity",
      sysmon:   "System",
      launch:   "Launchers",
    };
    return map[type] || "Misc";
  }

  function getRegisteredByCategory() {
    const grouped = {};
    state.registry.forEach((def) => {
      const cat = getCategory(def.type);
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(def);
    });
    return grouped;
  }

  function getTotalCount() {
    return state.instances.size;
  }

  function getCountByType() {
    const out = {};
    state.instances.forEach((inst) => {
      out[inst.type] = (out[inst.type] || 0) + 1;
    });
    return out;
  }

  /* ==========================================================================
   * Bring to front / send to back
   * ========================================================================*/

  function bringToFront(id) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    const maxZ = Math.max(
      0,
      ...Array.from(state.instances.values())
        .map((i) => parseInt(i.el.style.zIndex || "0", 10))
    );
    inst.el.style.zIndex = String(maxZ + 1);
    return true;
  }

  function sendToBack(id) {
    const inst = state.instances.get(id);
    if (!inst) return false;
    const minZ = Math.min(
      0,
      ...Array.from(state.instances.values())
        .map((i) => parseInt(i.el.style.zIndex || "0", 10))
    );
    inst.el.style.zIndex = String(minZ - 1);
    return true;
  }

  /* ==========================================================================
   * Presets (handy starter layouts)
   * ========================================================================*/

  const PRESETS = {
    minimal: [
      { type: "clock",  x: 24,  y: 24 },
      { type: "sticky", x: 260, y: 24 },
    ],
    productivity: [
      { type: "clock",    x: 24,  y: 24 },
      { type: "calendar", x: 260, y: 24 },
      { type: "sticky",   x: 560, y: 24 },
      { type: "launch",   x: 24,  y: 300 },
    ],
    monitoring: [
      { type: "sysmon",  x: 24,  y: 24 },
      { type: "weather", x: 300, y: 24 },
      { type: "clock",   x: 620, y: 24 },
    ],
  };

  function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return false;
    removeAll();
    setTimeout(() => {
      preset.forEach((p) => {
        try { add(p.type, { x: p.x, y: p.y }); } catch (_) {}
      });
    }, 120);
    return true;
  }

  function getPresets() {
    return Object.keys(PRESETS);
  }

  /* ==========================================================================
   * Theme change propagation
   *
   * When the OS theme changes, widgets using pure CSS adapt automatically.
   * Some widgets (clock, sysmon) may want to refresh.
   * ========================================================================*/

  function onThemeChange() {
    // Do nothing heavy — CSS vars handle most visuals.
  }

  function wireThemeEvent() {
    document.addEventListener("webos:themechange", onThemeChange);
    document.addEventListener("webos:theme:change", onThemeChange);
  }

  /* ==========================================================================
   * Visibility toggle (show/hide all widgets)
   * ========================================================================*/

  function setVisible(visible) {
    const layer = ensureLayer();
    layer.style.display = visible === false ? "none" : "";
  }

  function isVisible() {
    const layer = ensureLayer();
    return layer.style.display !== "none";
  }

  /* ==========================================================================
   * Export / import configuration
   * ========================================================================*/

  function exportConfig() {
    const snap = [];
    state.instances.forEach((inst) => {
      snap.push({
        id: inst.id, type: inst.type,
        x: inst.x, y: inst.y,
        width: inst.width, height: inst.height,
        opts: inst.opts || {},
      });
    });
    return JSON.stringify({ version: 1, widgets: snap }, null, 2);
  }

  function importConfig(json) {
    try {
      const obj = typeof json === "string" ? JSON.parse(json) : json;
      if (!obj || !Array.isArray(obj.widgets)) return false;
      removeAll();
      setTimeout(() => {
        obj.widgets.forEach((w) => {
          try {
            add(w.type, {
              id: w.id, x: w.x, y: w.y,
              width: w.width, height: w.height,
              opts: w.opts || {},
            });
          } catch (_) {}
        });
      }, 100);
      return true;
    } catch (e) {
      console.warn("[Widgets] import failed:", e);
      return false;
    }
  }

  /* ==========================================================================
   * Settings dialog helper (reusable by widgets for their configuration)
   * ========================================================================*/

  function openSettingsDialog(opts) {
    const o = opts || {};
    const overlay = document.createElement("div");
    overlay.className = "wg-picker-overlay";
    overlay.innerHTML = `
      <div class="wg-picker" role="dialog" style="width:420px;">
        <div class="wg-picker-header">
          <h2>${escapeHtml(o.title || "Widget Settings")}</h2>
          <button class="wg-btn" data-close>✕</button>
        </div>
        <div class="wg-picker-body" style="display:block;" data-form></div>
        <div class="wg-picker-footer">
          <button class="wg-btn" data-close>Cancel</button>
          <button class="wg-btn primary" data-save>Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const form = overlay.querySelector("[data-form]");
    const close = () => { try { overlay.remove(); } catch (_) {} };

    const fields = o.fields || [];
    const values = {};
    fields.forEach((f) => {
      values[f.key] = f.value;
      const row = document.createElement("div");
      row.style.marginBottom = "10px";
      const lab = document.createElement("label");
      lab.style.cssText = "display:block;font-size:11px;color:var(--text-dim);margin-bottom:4px;font-weight:600;";
      lab.textContent = f.label || f.key;
      row.appendChild(lab);
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        (f.options || []).forEach((opt) => {
          const o = document.createElement("option");
          o.value = opt.value != null ? opt.value : opt;
          o.textContent = opt.label != null ? opt.label : String(opt);
          if (o.value == f.value) o.selected = true;
          input.appendChild(o);
        });
      } else if (f.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!f.value;
      } else if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = 4;
        input.value = f.value || "";
      } else {
        input = document.createElement("input");
        input.type = f.type || "text";
        input.value = f.value != null ? f.value : "";
      }
      input.style.cssText = "width:100%;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:inherit;font-family:inherit;";
      input.addEventListener("change", () => {
        values[f.key] = input.type === "checkbox" ? input.checked : input.value;
      });
      input.addEventListener("input", () => {
        values[f.key] = input.type === "checkbox" ? input.checked : input.value;
      });
      row.appendChild(input);
      form.appendChild(row);
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
      if (e.target.closest("[data-close]")) close();
      if (e.target.closest("[data-save]")) {
        if (typeof o.onSave === "function") {
          try { o.onSave(values); } catch (err) { console.error(err); }
        }
        close();
      }
    });
    document.addEventListener("keydown", function k(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); }
    });
  }

  /* ==========================================================================
   * Init
   * ========================================================================*/

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    ensureLayer();
    hookDesktopContextMenu();
    interceptDesktopContextMenu();
    trackHover();
    wireThemeEvent();

    // Restore after a short delay so WindowManager / apps have registered
    setTimeout(restoreAll, 250);

    console.log("%c[WebOS]%c Widgets ready (%d types registered)",
      "color:#f59e0b;font-weight:bold", "color:inherit", state.registry.size);

    emit("ready", { types: state.registry.size });
  }

  /* ==========================================================================
   * Expose
   * ========================================================================*/

  window.Widgets = {
    init,
    add, remove, removeAll,
    register, getRegistered,
    getInstances, getInstance,
    update, rerender, duplicate,
    openPicker, openSettingsDialog,
    snapInstance, snapAll, snapToGrid,
    arrange, applyPreset, getPresets,
    setVisible, isVisible,
    findFreePosition,
    bringToFront, sendToBack,
    alignToEdge, centerAll,
    distributeHorizontally, distributeVertically,
    tile, publish, subscribe,
    getCategory, getRegisteredByCategory,
    getTotalCount, getCountByType,
    exportConfig, importConfig,
    on,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
