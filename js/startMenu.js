/* ============================================================================
 * WebOS — startMenu.js
 * ----------------------------------------------------------------------------
 * Animated start menu:
 *   - Pinned tile grid
 *   - All apps list (alphabetical, with category headers)
 *   - Recent apps tracking (persisted)
 *   - Quick settings pane (theme/animations/sound)
 *   - Live search across apps + actions + commands
 *   - Power options (lock / restart / shutdown)
 *   - Public API on window.StartMenu
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Config
   * ------------------------------------------------------------------------*/
  const STORAGE_KEY_RECENT = "webos.recent";
  const STORAGE_KEY_PINNED = "webos.pinned";
  const RECENT_MAX = 12;
  const SEARCH_DEBOUNCE_MS = 80;

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    initialized: false,
    open:        false,
    activePane:  "pinned",
    recent:      [],
    pinned:      ["about","settings","notepad","calculator","files","browser","terminal","paint","clock"],
    searchTimer: null,
    rootEl:      null,
    sidebar:     null,
    main:        null,
    searchEl:    null,
    listeners:   new Set(),
  };

  /* --------------------------------------------------------------------------
   * Helpers
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
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent("webos:" + name, { detail })); }
    catch (_) {}
    state.listeners.forEach((fn) => { try { fn(name, detail); } catch (e) { console.error(e); } });
  }

  function safeGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      if (v === null) return fallback;
      try { return JSON.parse(v); } catch (_) { return v; }
    } catch (_) { return fallback; }
  }

  function safeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (_) { return false; }
  }

  /* --------------------------------------------------------------------------
   * Recent / pinned management
   * ------------------------------------------------------------------------*/
  function loadPersisted() {
    const r = safeGet(STORAGE_KEY_RECENT, null);
    if (Array.isArray(r)) state.recent = r.slice(0, RECENT_MAX);
    const p = safeGet(STORAGE_KEY_PINNED, null);
    if (Array.isArray(p)) state.pinned = p;
  }

  function savePersisted() {
    safeSet(STORAGE_KEY_RECENT, state.recent);
    safeSet(STORAGE_KEY_PINNED, state.pinned);
  }

  function recordRecent(appId, title) {
    if (!appId) return;
    state.recent = state.recent.filter((r) => r.id !== appId);
    state.recent.unshift({ id: appId, title: title || appId, ts: Date.now() });
    if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
    savePersisted();
    if (state.activePane === "recent") renderRecent();
  }

  function pinApp(appId) {
    if (!state.pinned.includes(appId)) state.pinned.push(appId);
    savePersisted();
    if (state.activePane === "pinned") renderPinned();
  }

  function unpinApp(appId) {
    state.pinned = state.pinned.filter((id) => id !== appId);
    savePersisted();
    if (state.activePane === "pinned") renderPinned();
  }

  /* --------------------------------------------------------------------------
   * Renderers
   * ------------------------------------------------------------------------*/
  function getApps() {
    return (window.WindowManager && window.WindowManager.getApps()) || [];
  }

  function getAppById(id) {
    return window.WindowManager && window.WindowManager.getApp(id);
  }

  function renderPinned() {
    const grid = document.getElementById("sm-grid-pinned");
    if (!grid) return;
    grid.innerHTML = "";
    state.pinned.forEach((id) => {
      const app = getAppById(id);
      if (!app) return;
      grid.appendChild(buildTile(app));
    });
    if (!grid.children.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:18px;text-align:center;color:var(--fg-3);">No pinned apps. Right-click an app to pin it.</div>`;
    }
  }

  function renderAll() {
    const list = document.getElementById("sm-list-all");
    if (!list) return;
    const apps = getApps().slice().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    if (apps.length === 0) {
      list.innerHTML = `<div style="padding:18px;text-align:center;color:var(--fg-3);">No apps registered.</div>`;
      return;
    }
    // group by category
    const groups = new Map();
    apps.forEach((a) => {
      const cat = a.category || "Apps";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(a);
    });
    list.innerHTML = "";
    Array.from(groups.keys()).sort().forEach((cat) => {
      const header = document.createElement("h3");
      header.className = "sm-pane-title";
      header.style.cssText = "margin-top:14px;";
      header.textContent = cat;
      list.appendChild(header);
      groups.get(cat).forEach((a) => list.appendChild(buildRow(a)));
    });
  }

  function renderRecent() {
    const list = document.getElementById("sm-list-recent");
    if (!list) return;
    list.innerHTML = "";

    // ----- Recent files (top section, last 5 from FileSystem) -----
    const fs = window.FileSystem;
    const recentFiles = (fs && fs.getRecent) ? fs.getRecent(5) : [];
    if (recentFiles.length) {
      const head = document.createElement("div");
      head.style.cssText = "padding:6px 12px 4px;font-size:10px;letter-spacing:.10em;text-transform:uppercase;opacity:.55;";
      head.textContent = "Recent files";
      list.appendChild(head);
      recentFiles.forEach((rf) => {
        const row = document.createElement("div");
        row.className = "sm-row";
        row.title = rf.path;
        row.innerHTML = `
          <span class="sm-row-ico">${(rf.icon || "📄")}</span>
          <span class="sm-row-label" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rf.name}</span>
          <span class="sm-row-meta" style="font-size:10px;opacity:.55;">${relativeTime(rf.ts)}</span>
        `;
        row.addEventListener("click", () => {
          if (window.ContextMenu && window.ContextMenu.openFileWithDefaultApp) {
            window.ContextMenu.openFileWithDefaultApp(rf.path);
          } else if (window.WindowManager) {
            window.WindowManager.openApp("notepad", { docId: rf.path, openPath: rf.path });
          }
          if (typeof close === "function") close();
        });
        list.appendChild(row);
      });
      // separator
      const sep = document.createElement("div");
      sep.style.cssText = "height:1px;background:var(--window-border, rgba(255,255,255,.10));margin:6px 12px;";
      list.appendChild(sep);
    }

    // ----- Recent apps -----
    const head2 = document.createElement("div");
    head2.style.cssText = "padding:6px 12px 4px;font-size:10px;letter-spacing:.10em;text-transform:uppercase;opacity:.55;";
    head2.textContent = "Recent apps";
    list.appendChild(head2);

    if (state.recent.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:14px;text-align:center;color:var(--fg-3);";
      empty.textContent = "Apps you open will appear here.";
      list.appendChild(empty);
      return;
    }
    state.recent.forEach((entry) => {
      const a = getAppById(entry.id);
      if (!a) return;
      const r = buildRow(a);
      const meta = document.createElement("span");
      meta.className = "sm-row-meta";
      meta.textContent = relativeTime(entry.ts);
      r.appendChild(meta);
      list.appendChild(r);
    });
  }

  function relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)    return "just now";
    if (diff < 3600)  return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function buildTile(app) {
    const el = document.createElement("button");
    el.className = "sm-tile";
    el.dataset.appId = app.id;
    el.title = app.title;
    el.innerHTML = `
      <span class="sm-tile-ico">${escapeHtml(app.icon || "▦")}</span>
      <span class="sm-tile-label">${escapeHtml(app.title || app.id)}</span>
    `;
    el.addEventListener("click", () => launch(app.id));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showAppMenu(app, e.clientX, e.clientY, /* pinned */ true);
    });
    return el;
  }

  function buildRow(app) {
    const el = document.createElement("button");
    el.className = "sm-row";
    el.dataset.appId = app.id;
    el.innerHTML = `
      <span class="sm-row-ico">${escapeHtml(app.icon || "▦")}</span>
      <span class="sm-row-label">${escapeHtml(app.title || app.id)}</span>
    `;
    el.addEventListener("click", () => launch(app.id));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showAppMenu(app, e.clientX, e.clientY, /* pinned */ state.pinned.includes(app.id));
    });
    return el;
  }

  /* --------------------------------------------------------------------------
   * Per-app context menu (pin/unpin/open)
   * ------------------------------------------------------------------------*/
  function showAppMenu(app, x, y, isPinned) {
    closeAppMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.id = "sm-app-menu";
    menu.innerHTML = `
      <div class="context-item" data-act="open"><span class="ci-ico">▶</span> Open</div>
      <div class="context-item" data-act="${isPinned ? "unpin" : "pin"}">
        <span class="ci-ico">${isPinned ? "📍" : "📌"}</span> ${isPinned ? "Unpin from start" : "Pin to start"}
      </div>
      <div class="context-separator"></div>
      <div class="context-item" data-act="info"><span class="ci-ico">ⓘ</span> About this app</div>
    `;
    document.body.appendChild(menu);
    menu.style.left = Math.min(x, window.innerWidth - 240) + "px";
    menu.style.top  = Math.min(y, window.innerHeight - 200) + "px";

    menu.querySelectorAll(".context-item").forEach((it) => {
      it.addEventListener("click", () => {
        const a = it.dataset.act;
        if (a === "open") launch(app.id);
        if (a === "pin") pinApp(app.id);
        if (a === "unpin") unpinApp(app.id);
        if (a === "info") {
          if (window.Taskbar) window.Taskbar.toast({ title: app.title, body: app.id + " — category: " + (app.category || "Apps"), kind: "info" });
        }
        closeAppMenu();
      });
    });

    setTimeout(() => document.addEventListener("pointerdown", outsideAppMenu, true), 0);
  }

  function outsideAppMenu(e) {
    const m = document.getElementById("sm-app-menu");
    if (m && !m.contains(e.target)) closeAppMenu();
  }

  function closeAppMenu() {
    const m = document.getElementById("sm-app-menu");
    if (m) m.remove();
    document.removeEventListener("pointerdown", outsideAppMenu, true);
  }

  /* --------------------------------------------------------------------------
   * Launching
   * ------------------------------------------------------------------------*/
  function launch(appId) {
    const wm = window.WindowManager;
    if (!wm) return;
    const app = wm.getApp(appId);
    if (!app) {
      if (window.Taskbar) window.Taskbar.toast({ title: "App not found", body: appId, kind: "danger" });
      return;
    }
    wm.openApp(appId);
    recordRecent(appId, app.title);
    close();
    emit("startlaunch", { appId });
  }

  /* --------------------------------------------------------------------------
   * Search
   * ------------------------------------------------------------------------*/
  function performSearch(q) {
    const list = document.getElementById("sm-list-all");
    if (!list) return;
    const main = document.querySelector(".sm-main");
    const panes = $$(".sm-pane", main);
    panes.forEach((p) => p.classList.remove("active"));
    const allPane = panes.find((p) => p.dataset.pane === "all");
    if (allPane) allPane.classList.add("active");

    setActiveSidebar("all");

    const norm = (q || "").trim().toLowerCase();
    if (!norm) { renderAll(); return; }

    const apps = getApps();
    const matches = apps.filter((a) =>
      (a.title || "").toLowerCase().includes(norm) ||
      (a.id    || "").toLowerCase().includes(norm) ||
      (a.category || "").toLowerCase().includes(norm)
    );

    list.innerHTML = "";
    const head = document.createElement("h3");
    head.className = "sm-pane-title";
    head.textContent = `Results for “${q}” (${matches.length})`;
    list.appendChild(head);

    if (matches.length === 0) {
      // Fall back to commands
      list.innerHTML += `
        <div style="padding:18px;text-align:center;color:var(--fg-3);">
          No apps matched. Try one of these:
        </div>`;
    } else {
      matches.forEach((a) => list.appendChild(buildRow(a)));
    }

    // Action commands (theme switches etc.)
    const cmds = buildCommandSuggestions(norm);
    if (cmds.length) {
      const ch = document.createElement("h3");
      ch.className = "sm-pane-title";
      ch.style.marginTop = "14px";
      ch.textContent = "Commands";
      list.appendChild(ch);
      cmds.forEach((c) => list.appendChild(buildCommandRow(c)));
    }
  }

  function buildCommandSuggestions(q) {
    const out = [];
    const themes = ["dark","light","cyberpunk","retro","forest"];
    themes.forEach((t) => {
      if (("theme " + t).includes(q) || t.includes(q)) {
        out.push({
          icon: "🎨",
          title: "Switch theme: " + t,
          run: () => { window.ThemeEngine.setTheme(t); }
        });
      }
    });
    if ("settings".includes(q) || "preferences".includes(q)) {
      out.push({ icon: "⚙", title: "Open Settings", run: () => launch("settings") });
    }
    if ("shutdown".includes(q) || "restart".includes(q) || "lock".includes(q) || "power".includes(q)) {
      out.push({ icon: "⏻", title: "Power options", run: () => setActivePane("settings") });
    }
    if ("about".includes(q) || "version".includes(q)) {
      out.push({ icon: "ⓘ", title: "About WebOS", run: () => launch("about") });
    }
    return out.slice(0, 8);
  }

  function buildCommandRow(c) {
    const el = document.createElement("button");
    el.className = "sm-row";
    el.innerHTML = `
      <span class="sm-row-ico">${escapeHtml(c.icon || "▶")}</span>
      <span class="sm-row-label">${escapeHtml(c.title)}</span>
    `;
    el.addEventListener("click", () => { try { c.run(); } finally { close(); } });
    return el;
  }

  function bindSearch() {
    const input = document.getElementById("sm-search-input");
    if (!input) return;
    state.searchEl = input;
    input.addEventListener("input", (e) => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => performSearch(e.target.value), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") {
        const list = document.getElementById("sm-list-all");
        const first = list && list.querySelector(".sm-row");
        if (first) first.click();
      }
    });
  }

  /* --------------------------------------------------------------------------
   * Sidebar / pane switching
   * ------------------------------------------------------------------------*/
  function setActivePane(name) {
    state.activePane = name;
    setActiveSidebar(name);
    const main = document.querySelector(".sm-main");
    if (!main) return;
    $$(".sm-pane", main).forEach((p) => {
      p.classList.toggle("active", p.dataset.pane === name);
    });
    if (name === "pinned")   renderPinned();
    if (name === "all")      renderAll();
    if (name === "recent")   renderRecent();
    if (name === "settings") highlightThemeChips();
  }

  function setActiveSidebar(name) {
    $$(".sm-side-btn").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
  }

  function bindSidebar() {
    $$(".sm-side-btn").forEach((b) => {
      b.addEventListener("click", () => setActivePane(b.dataset.pane));
    });
  }

  function highlightThemeChips() {
    const cur = window.ThemeEngine && window.ThemeEngine.getTheme();
    $$(".sm-theme-chip").forEach((c) => c.classList.toggle("active", c.dataset.theme === cur));
  }

  /* --------------------------------------------------------------------------
   * Power buttons
   * ------------------------------------------------------------------------*/
  function bindPower() {
    $$(".sm-power-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const a = b.dataset.action;
        close();
        if (a === "lock")     doLock();
        if (a === "restart")  doRestart();
        if (a === "shutdown") doShutdown();
      });
    });
  }

  function doLock() {
    showOverlay({
      title: "Locked",
      body: "Press any key to unlock.",
      icon: "🔒",
      key: "lock",
      onUnlock: removeOverlay,
    });
  }

  function doRestart() {
    showOverlay({
      title: "Restarting…",
      body: "WebOS is restarting.",
      icon: "⟳",
      spinner: true,
      key: "restart",
    });
    if (window.WindowManager) window.WindowManager.closeAll();
    setTimeout(() => {
      removeOverlay();
      if (window.WebOSBoot && typeof window.WebOSBoot.run === "function") window.WebOSBoot.run();
      else location.reload();
    }, 1500);
  }

  function doShutdown() {
    showOverlay({
      title: "Shutting down…",
      body: "It is now safe to close this tab.",
      icon: "⏻",
      spinner: true,
      key: "shutdown",
    });
    if (window.WindowManager) window.WindowManager.closeAll();
    setTimeout(() => {
      const ov = document.getElementById("__webos_overlay__");
      if (ov) {
        ov.querySelector("[data-spinner]").style.display = "none";
        ov.querySelector("[data-body]").textContent = "It is now safe to close this tab. Click to power on.";
        ov.style.cursor = "pointer";
        ov.addEventListener("click", () => {
          removeOverlay();
          if (window.WebOSBoot && typeof window.WebOSBoot.run === "function") window.WebOSBoot.run();
        }, { once: true });
      }
    }, 1200);
  }

  function showOverlay(opts) {
    removeOverlay();
    const ov = document.createElement("div");
    ov.id = "__webos_overlay__";
    ov.style.cssText = `
      position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;
      flex-direction:column;gap:14px;background:rgba(5,7,20,0.92);backdrop-filter:blur(16px);
      color:#f5f7ff;font-family:var(--font-sans);text-align:center;
      animation: bootFadeIn 280ms ease;
    `;
    ov.innerHTML = `
      <div style="font-size:64px;${opts.spinner ? "animation: bootRingSpin 1.4s linear infinite;" : ""}">${escapeHtml(opts.icon || "")}</div>
      <h2 style="margin:0;letter-spacing:2px;">${escapeHtml(opts.title || "")}</h2>
      <div data-body style="opacity:.75;">${escapeHtml(opts.body || "")}</div>
      ${opts.spinner ? `<div data-spinner class="boot-progress" style="width:240px;height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;"><div style="width:60%;height:100%;background:var(--grad-accent);animation: bootGlowSlide 1.6s ease-in-out infinite;"></div></div>` : ""}
    `;
    document.body.appendChild(ov);

    if (opts.key === "lock") {
      const onAny = () => {
        if (typeof opts.onUnlock === "function") opts.onUnlock();
        document.removeEventListener("keydown", onAny);
        document.removeEventListener("pointerdown", onAny);
      };
      setTimeout(() => {
        document.addEventListener("keydown", onAny);
        document.addEventListener("pointerdown", onAny);
      }, 200);
    }
  }

  function removeOverlay() {
    const ov = document.getElementById("__webos_overlay__");
    if (ov) ov.remove();
  }

  /* --------------------------------------------------------------------------
   * Open/close
   * ------------------------------------------------------------------------*/
  function open() {
    const root = document.getElementById("start-menu");
    if (!root) return;
    if (state.open) return;
    state.open = true;
    root.classList.remove("hiding");
    root.hidden = false;
    setActivePane(state.activePane || "pinned");
    setTimeout(() => {
      const inp = document.getElementById("sm-search-input");
      if (inp) inp.focus();
    }, 60);
    const sb = document.getElementById("start-button");
    if (sb) { sb.classList.add("active"); sb.setAttribute("aria-expanded", "true"); }

    setTimeout(() => {
      document.addEventListener("pointerdown", outsideStart, true);
      document.addEventListener("click",       outsideStart, true);
    }, 0);
    document.addEventListener("keydown", onEscClose);
    emit("startopen", {});
  }

  function close() {
    const root = document.getElementById("start-menu");
    if (!root) return;
    if (!state.open) return;
    state.open = false;
    root.classList.add("hiding");
    setTimeout(() => { root.hidden = true; root.classList.remove("hiding"); }, 200);
    const sb = document.getElementById("start-button");
    if (sb) { sb.classList.remove("active"); sb.setAttribute("aria-expanded", "false"); }
    document.removeEventListener("pointerdown", outsideStart, true);
    document.removeEventListener("click",       outsideStart, true);
    document.removeEventListener("keydown", onEscClose);
    closeAppMenu();
    emit("startclose", {});
  }

  function toggle() { state.open ? close() : open(); }

  // Single global click-outside listener: if the click target isn't inside
  // the Start Menu or the Start button, close the menu.
  function outsideStart(e) {
    if (!state.open) return;
    const root = document.getElementById("start-menu");
    const sb   = document.getElementById("start-button");
    if (!root) return;
    const t = e.target;
    if (root.contains(t)) return;
    if (sb && sb.contains(t)) return;
    // Don't fight other popups that might be on screen (e.g. context menus)
    if (t && t.closest && t.closest(".webos-ctx, .context-menu, #sm-app-menu")) return;
    close();
  }

  function onEscClose(e) {
    if (e.key === "Escape") close();
  }

  /* --------------------------------------------------------------------------
   * Subscribe to system events
   * ------------------------------------------------------------------------*/
  function bindSystemEvents() {
    document.addEventListener("webos:windowopen", (e) => {
      const id = e.detail && e.detail.appId;
      if (id) recordRecent(id, e.detail.title);
    });
    document.addEventListener("webos:themechange", () => highlightThemeChips());
  }

  /* --------------------------------------------------------------------------
   * Keyboard shortcut: Win key / Ctrl+Esc opens menu
   * ------------------------------------------------------------------------*/
  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "Escape") { e.preventDefault(); toggle(); }
      // Standalone Meta key (Win/Cmd) — toggle if not part of a chord
      if (e.key === "Meta" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // many browsers don't fire this — kept for completeness
      }
    });
  }

  /* --------------------------------------------------------------------------
   * Public listeners
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
    state.rootEl  = document.getElementById("start-menu");
    state.sidebar = document.querySelector(".sm-sidebar");
    state.main    = document.querySelector(".sm-main");

    loadPersisted();

    bindSidebar();
    bindSearch();
    bindPower();
    bindSystemEvents();
    bindKeyboard();

    // Initial render so opening is instant
    renderPinned();
    renderAll();
    renderRecent();
    highlightThemeChips();

    // Live-update the Recent pane when filesystem recent-files change
    document.addEventListener("fs:recent", () => {
      if (state.activePane === "recent" || !state.activePane) renderRecent();
    });

    console.log("%c[WebOS]%c Start menu ready", "color:#f59e0b;font-weight:bold","color:inherit");
    emit("startready", {});
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.StartMenu = {
    init,
    open, close, toggle,
    launch,
    pinApp, unpinApp,
    setActivePane,
    isOpen: () => state.open,
    on, subscribe,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
