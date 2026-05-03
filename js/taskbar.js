/* ============================================================================
 * WebOS — taskbar.js
 * ----------------------------------------------------------------------------
 * Manages the bottom taskbar:
 *   - Live clock (time + date) with locale formatting
 *   - Active windows list with icons, hover preview, click-to-toggle
 *   - System tray (network, volume, battery, notifications)
 *   - Notification center pop-out
 *   - Toast notifications (info/success/warn/danger)
 *   - Show desktop button
 *   - Public API on window.Taskbar
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Config
   * ------------------------------------------------------------------------*/
  const CONFIG = Object.freeze({
    CLOCK_INTERVAL_MS:  1000,
    DATE_FORMAT_LONG:   { weekday:"short", month:"short", day:"numeric" },
    TIME_FORMAT_24:     { hour:"2-digit", minute:"2-digit", hour12:false },
    TIME_FORMAT_12:     { hour:"numeric", minute:"2-digit", hour12:true },
    USE_24H:            true,
    TOAST_DEFAULT_MS:   3500,
    NC_MAX_ITEMS:       50,
    APP_FLASH_MS:       1500,
    PREVIEW_DELAY_MS:   500,
  });

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    initialized:     false,
    clockTimer:      null,
    notifications:   [],
    nextNotifId:     1,
    appsContainer:   null,
    clockTimeEl:     null,
    clockDateEl:     null,
    appButtons:      new Map(), // winId -> button el
    ncOpen:          false,
    listeners:       new Set(),
  };

  /* --------------------------------------------------------------------------
   * Utility
   * ------------------------------------------------------------------------*/
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function $(sel, root) { return (root || document).querySelector(sel); }

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent("webos:" + name, { detail }));
    } catch (_) {}
    state.listeners.forEach((fn) => {
      try { fn(name, detail); } catch (e) { console.error(e); }
    });
  }

  /* --------------------------------------------------------------------------
   * Clock
   * ------------------------------------------------------------------------*/
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function formatTime(date) {
    if (CONFIG.USE_24H) {
      return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }
    let h = date.getHours();
    const m = pad2(date.getMinutes());
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + m + " " + ampm;
  }

  function formatDate(date) {
    try { return date.toLocaleDateString(undefined, CONFIG.DATE_FORMAT_LONG); }
    catch (_) {
      const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][date.getDay()];
      const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getMonth()];
      return d + " " + mo + " " + date.getDate();
    }
  }

  function tickClock() {
    const now = new Date();
    if (state.clockTimeEl) state.clockTimeEl.textContent = formatTime(now);
    if (state.clockDateEl) state.clockDateEl.textContent = formatDate(now);
    const wrapper = document.getElementById("taskbar-clock");
    if (wrapper) wrapper.title = now.toLocaleString();
  }

  function startClock() {
    stopClock();
    tickClock();
    // Align to next minute boundary for snappier first tick after second-precision ticks
    state.clockTimer = setInterval(tickClock, CONFIG.CLOCK_INTERVAL_MS);
  }

  function stopClock() {
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
  }

  /* --------------------------------------------------------------------------
   * Active windows list
   * ------------------------------------------------------------------------*/
  function ensureAppsContainer() {
    state.appsContainer = state.appsContainer || document.getElementById("taskbar-apps");
    return state.appsContainer;
  }

  function buildAppButton(win) {
    const btn = document.createElement("button");
    btn.className = "taskbar-app running";
    btn.dataset.winId = win.id;
    btn.dataset.appId = win.appId || "";
    btn.setAttribute("role", "tab");
    // Native tooltip (shown on hover by the browser) alongside the custom
    // .ta-tooltip element, so the app name is always discoverable.
    const displayName = win.title || "Untitled";
    btn.title = displayName;
    btn.setAttribute("aria-label", displayName);
    btn.innerHTML = `
      <span class="ta-ico">${escapeHtml(win.icon || "▦")}</span>
      <span class="ta-label">${escapeHtml(displayName)}</span>
      <span class="ta-indicator"></span>
      <span class="ta-tooltip">${escapeHtml(displayName)}</span>
    `;
    btn.addEventListener("click", () => {
      // toggle minimize/restore/focus
      const wm = window.WindowManager;
      const w = wm && wm.getWindow(win.id);
      if (!w) return;
      const focused = wm.getFocused();
      if (w.minimized) wm.restoreWindow(win.id);
      else if (focused && focused.id === win.id) wm.minimizeWindow(win.id);
      else wm.focusWindow(win.id);
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const wm = window.WindowManager;
      if (!wm) return;
      const w = wm.getWindow(win.id);
      if (!w) return;
      // Trigger built-in window context menu
      try {
        const evt = new MouseEvent("contextmenu", { bubbles: true, clientX: e.clientX, clientY: e.clientY });
        const tb = w.el && w.el.querySelector(".window-titlebar");
        if (tb) tb.dispatchEvent(evt);
      } catch (_) {}
    });

    // Middle-click = close
    btn.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        if (window.WindowManager) window.WindowManager.closeWindow(win.id);
      }
    });

    return btn;
  }

  function addApp(win) {
    const c = ensureAppsContainer();
    if (!c || !win) return;
    if (state.appButtons.has(win.id)) return;
    const btn = buildAppButton(win);
    c.appendChild(btn);
    state.appButtons.set(win.id, btn);
    refreshApp(win);
  }

  function removeApp(winId) {
    const btn = state.appButtons.get(winId);
    if (!btn) return;
    btn.classList.add("ta-out");
    btn.style.transition = "opacity .15s ease, transform .15s ease";
    btn.style.opacity = "0";
    btn.style.transform = "scale(.92)";
    setTimeout(() => { try { btn.remove(); } catch (_) {} }, 150);
    state.appButtons.delete(winId);
  }

  function refreshApp(win) {
    if (!win) return;
    const btn = state.appButtons.get(win.id);
    if (!btn) return;
    const label = btn.querySelector(".ta-label");
    const tip   = btn.querySelector(".ta-tooltip");
    const ico   = btn.querySelector(".ta-ico");
    const name  = win.title || "Untitled";
    if (label) label.textContent = name;
    if (tip)   tip.textContent   = name;
    if (ico)   ico.textContent   = win.icon || "▦";
    btn.title = name;
    btn.setAttribute("aria-label", name);
    const focused = window.WindowManager && window.WindowManager.getFocused();
    const isActive = !!(focused && focused.id === win.id && !win.minimized);
    // Mark the currently-focused (active) window in the taskbar. Only one
    // taskbar entry should be .active at any time, so the CSS highlight is
    // unambiguous.
    btn.classList.toggle("active",    isActive);
    btn.classList.toggle("minimized", !!win.minimized);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }

  function flashApp(winId) {
    const btn = state.appButtons.get(winId);
    if (!btn) return;
    btn.classList.add("flash");
    setTimeout(() => btn.classList.remove("flash"), CONFIG.APP_FLASH_MS);
  }

  function refreshAll() {
    if (!window.WindowManager) return;
    window.WindowManager.listWindows().forEach(refreshApp);
  }

  /* --------------------------------------------------------------------------
   * Notification center
   * ------------------------------------------------------------------------*/
  function ensureNC() {
    return document.getElementById("notification-center");
  }

  function renderNC() {
    const nc = ensureNC();
    if (!nc) return;
    const list = nc.querySelector("#nc-list");
    if (!list) return;
    list.innerHTML = "";
    if (state.notifications.length === 0) {
      list.innerHTML = `<div class="nc-empty">No notifications. You're all caught up. ✨</div>`;
      return;
    }
    state.notifications.slice(0, CONFIG.NC_MAX_ITEMS).forEach((n) => {
      const item = document.createElement("div");
      item.className = "nc-item";
      item.style.borderLeftColor = ({
        success: "var(--ok)",
        warn:    "var(--warn)",
        danger:  "var(--danger)",
        info:    "var(--info)",
      })[n.kind] || "var(--accent-1)";
      const ago = relativeTime(n.timestamp);
      item.innerHTML = `
        <div class="nc-title">${escapeHtml(n.title || "Notification")}</div>
        <div class="nc-body">${escapeHtml(n.body || "")}</div>
        <div class="nc-time">${escapeHtml(ago)}</div>
      `;
      list.appendChild(item);
    });
  }

  function relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5)    return "just now";
    if (diff < 60)   return diff + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400)return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function updateBadge() {
    const badge = document.getElementById("tray-badge");
    if (!badge) return;
    const n = state.notifications.length;
    if (n === 0) {
      badge.hidden = true;
      badge.textContent = "0";
    } else {
      badge.hidden = false;
      badge.textContent = n > 99 ? "99+" : String(n);
    }
  }

  function openNC() {
    const nc = ensureNC();
    if (!nc) return;
    renderNC();
    nc.hidden = false;
    state.ncOpen = true;
    setTimeout(() => document.addEventListener("pointerdown", outsideNC, true), 0);
  }

  function closeNC() {
    const nc = ensureNC();
    if (!nc) return;
    nc.hidden = true;
    state.ncOpen = false;
    document.removeEventListener("pointerdown", outsideNC, true);
  }

  function toggleNC() { state.ncOpen ? closeNC() : openNC(); }

  function outsideNC(e) {
    const nc = ensureNC();
    const tray = document.getElementById("tray-notifications");
    if (!nc) return;
    if (nc.contains(e.target)) return;
    if (tray && tray.contains(e.target)) return;
    closeNC();
  }

  function pushNotification(opts) {
    const o = opts || {};
    const n = {
      id:        state.nextNotifId++,
      title:     o.title || "Notification",
      body:      o.body  || "",
      kind:      o.kind  || "info",
      timestamp: Date.now(),
      read:      false,
    };
    state.notifications.unshift(n);
    if (state.notifications.length > CONFIG.NC_MAX_ITEMS) {
      state.notifications.length = CONFIG.NC_MAX_ITEMS;
    }
    updateBadge();
    if (state.ncOpen) renderNC();
    if (o.toast !== false) toast({ title: n.title, body: n.body, kind: n.kind, duration: o.duration });
    return n;
  }

  function clearNotifications() {
    state.notifications = [];
    updateBadge();
    renderNC();
  }

  /* --------------------------------------------------------------------------
   * Toasts
   * ------------------------------------------------------------------------*/
  function ensureToastRoot() {
    let r = document.getElementById("toast-root");
    if (!r) {
      r = document.createElement("div");
      r.id = "toast-root";
      r.className = "toast-root";
      document.body.appendChild(r);
    }
    return r;
  }

  function toast(opts) {
    const o = opts || {};
    const r = ensureToastRoot();
    const el = document.createElement("div");
    el.className = "toast " + (o.kind || "info");
    el.innerHTML = `
      ${o.title ? `<div class="t-title">${escapeHtml(o.title)}</div>` : ""}
      ${o.body  ? `<div class="t-body">${escapeHtml(o.body)}</div>`  : ""}
    `;
    r.appendChild(el);
    const t = setTimeout(() => dismissToast(el), o.duration || CONFIG.TOAST_DEFAULT_MS);
    el.addEventListener("click", () => { clearTimeout(t); dismissToast(el); });
    return el;
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.add("toast-out");
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 240);
  }

  /* --------------------------------------------------------------------------
   * Tray icons (battery, volume, network)
   * ------------------------------------------------------------------------*/
  function bindTray() {
    const network = document.getElementById("tray-network");
    const volume  = document.getElementById("tray-volume");
    const battery = document.getElementById("tray-battery");
    const notif   = document.getElementById("tray-notifications");

    if (network) network.addEventListener("click", () => toast({ title: "Network", body: "Connected — WebOS Wi-Fi", kind: "info" }));
    if (volume)  volume .addEventListener("click", () => {
      // simple cycle 🔇 -> 🔉 -> 🔊
      const v = volume.textContent.trim();
      volume.textContent = v === "🔊" ? "🔉" : v === "🔉" ? "🔇" : "🔊";
      toast({ title: "Volume", body: "Now: " + volume.textContent, kind: "info" });
    });
    if (battery) battery.addEventListener("click", () => toast({ title: "Battery", body: "100% — Plenty of juice 🔋", kind: "success" }));
    if (notif)   notif  .addEventListener("click", toggleNC);

    // Battery API integration if available
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        function update() {
          if (!battery) return;
          const pct = Math.round(b.level * 100);
          battery.title = "Battery: " + pct + "%" + (b.charging ? " (charging)" : "");
          battery.textContent = b.charging ? "🔌" : (pct > 60 ? "🔋" : pct > 20 ? "🪫" : "🪫");
        }
        update();
        b.addEventListener("levelchange",    update);
        b.addEventListener("chargingchange", update);
      }).catch(() => {});
    }

    // NC clear button
    const clear = document.getElementById("nc-clear");
    if (clear) clear.addEventListener("click", clearNotifications);

    // Show desktop
    const sd = document.getElementById("show-desktop");
    if (sd) sd.addEventListener("click", () => {
      if (window.WindowManager) window.WindowManager.toggleShowDesktop();
    });

    // Clock click toggles NC
    const clock = document.getElementById("taskbar-clock");
    if (clock) clock.addEventListener("click", toggleNC);
  }

  /* --------------------------------------------------------------------------
   * Subscribe to window manager events
   * ------------------------------------------------------------------------*/
  function bindWMEvents() {
    document.addEventListener("webos:windowopen", (e) => {
      const id = e.detail && e.detail.id;
      if (!id) return;
      const wm = window.WindowManager;
      const win = wm && wm.getWindow(id);
      if (win) addApp(win);
    });
    document.addEventListener("webos:windowclose", (e) => {
      const id = e.detail && e.detail.id;
      if (id) removeApp(id);
    });
    document.addEventListener("webos:windowfocus",   () => refreshAll());
    document.addEventListener("webos:windowminimize",() => refreshAll());
    document.addEventListener("webos:windowrestore", () => refreshAll());
    document.addEventListener("webos:windowtitle",   (e) => {
      const wm = window.WindowManager;
      const win = wm && wm.getWindow(e.detail.id);
      if (win) refreshApp(win);
    });
  }

  /* --------------------------------------------------------------------------
   * Search box (taskbar)
   * ------------------------------------------------------------------------*/
  function bindSearch() {
    const input = document.getElementById("taskbar-search");
    if (!input) return;
    input.addEventListener("focus", () => {
      // forward to start menu search
      if (window.StartMenu) window.StartMenu.open();
      const sm = document.getElementById("sm-search-input");
      if (sm) { sm.value = input.value; sm.focus(); }
    });
    input.addEventListener("input", () => {
      const sm = document.getElementById("sm-search-input");
      if (sm) {
        sm.value = input.value;
        sm.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
  }

  /* --------------------------------------------------------------------------
   * Bind start button
   * ------------------------------------------------------------------------*/
  function bindStartButton() {
    const btn = document.getElementById("start-button");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (window.StartMenu) window.StartMenu.toggle();
    });
  }

  /* --------------------------------------------------------------------------
   * Public — listeners
   * ------------------------------------------------------------------------*/
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
   * Initialize
   * ------------------------------------------------------------------------*/
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    state.clockTimeEl = document.getElementById("clock-time");
    state.clockDateEl = document.getElementById("clock-date");
    ensureAppsContainer();
    startClock();
    bindTray();
    bindWMEvents();
    bindSearch();
    bindStartButton();
    // Pre-populate any windows that already exist
    if (window.WindowManager) window.WindowManager.listWindows().forEach(addApp);
    console.log("%c[WebOS]%c Taskbar ready", "color:#10b981;font-weight:bold","color:inherit");
    emit("taskbarready", {});
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.Taskbar = {
    init,
    // clock
    startClock, stopClock, tickClock,
    // apps
    addApp, removeApp, refreshApp, refreshAll, flashApp,
    // notifications
    pushNotification, clearNotifications,
    openNC, closeNC, toggleNC,
    // toasts
    toast, dismissToast,
    // events
    on, subscribe,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
