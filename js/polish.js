/* ============================================================================
 * WebOS — polish.js
 * ----------------------------------------------------------------------------
 * Day 7 final polish pass.  This file is loaded after all other managers
 * and progressively enhances WindowManager / Taskbar / Desktop / StartMenu
 * behaviour without touching their internal implementations beyond clearly
 * documented hook points.
 *
 *   • Window shake when trying to drag a maximized window
 *   • Window minimize/restore animations targeting taskbar pill positions
 *   • Alt+Tab switcher with live window thumbnails
 *   • Aero Peek — hovering taskbar pill shows ghost outline of window pos
 *   • Desktop icon slow-double-click rename
 *   • Drag-from-File-Manager-onto-Desktop drop handler
 *   • Power menu animations (shutdown/restart/lock)
 *   • "Recently installed" tracking + badges in start menu
 *   • Konami code easter egg
 *   • Boot screen percentage counter + BIOS pre-screen
 *   • Wallpaper parallax + softer desktop icon selection glow
 *   • Taskbar clock tooltip + right-click context menu
 *   • Taskbar "unsaved changes" running indicator
 *
 * Public API on  window.Polish
 * ==========================================================================*/

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
   * Constants
   * --------------------------------------------------------------------- */
  const KONAMI = [
    "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
    "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
    "b", "a"
  ];
  const KONAMI_KEY = "webos.easter.konami_found";
  const RECENT_INSTALL_KEY = "webos.store.recent_installs.v1";
  const RECENT_WINDOW_DAYS = 7;

  /* -----------------------------------------------------------------------
   * Utility
   * --------------------------------------------------------------------- */
  function once(fn) {
    let done = false, val = null;
    return function () {
      if (done) return val;
      done = true;
      val = fn.apply(this, arguments);
      return val;
    };
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function injectStyle(id, css) {
    if (document.getElementById(id)) return;
    const s = document.createElement("style");
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function toast(text) {
    try {
      if (window.Notifications && window.Notifications.info) {
        window.Notifications.info("WebOS", text);
      } else {
        console.log("[WebOS toast]", text);
      }
    } catch {}
  }

  /* =======================================================================
   * 1. STYLES — added once for the new effects
   * ===================================================================== */
  function installStyles() {
    injectStyle("polish-style", `
      /* --- window shake -------------------------------------------------- */
      @keyframes wm-shake {
        0%, 100% { transform: translate(0,0); }
        15%      { transform: translate(-8px, 0); }
        30%      { transform: translate(8px, 0); }
        45%      { transform: translate(-6px, 0); }
        60%      { transform: translate(6px, 0); }
        75%      { transform: translate(-3px, 0); }
        90%      { transform: translate(3px, 0); }
      }
      .window.maximized.wm-shake {
        animation: wm-shake .45s ease-in-out;
      }

      /* --- minimize/restore travel toward taskbar ------------------------- */
      .window.minimize-fly {
        animation: wm-fly-min 320ms cubic-bezier(.5,0,.95,.55) forwards;
        transform-origin: center center;
      }
      @keyframes wm-fly-min {
        to {
          opacity: 0;
          transform:
            translate(var(--mx, 0px), var(--my, 0px))
            scale(0.06);
          filter: blur(3px);
        }
      }
      .window.restore-fly {
        animation: wm-fly-res 320ms cubic-bezier(.2,.7,.3,1.05) forwards;
        transform-origin: center center;
      }
      @keyframes wm-fly-res {
        from {
          opacity: 0;
          transform:
            translate(var(--mx, 0px), var(--my, 0px))
            scale(0.06);
          filter: blur(3px);
        }
        to {
          opacity: 1;
          transform: translate(0,0) scale(1);
          filter: none;
        }
      }

      /* --- Alt+Tab switcher --------------------------------------------- */
      #alt-tab-overlay {
        position: fixed;
        inset: 0;
        z-index: 100000;
        background: rgba(8,10,22,0.65);
        backdrop-filter: blur(10px);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: at-fade .12s ease;
      }
      @keyframes at-fade { from { opacity: 0; } to { opacity: 1; } }
      .at-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        max-width: min(80vw, 1100px);
        max-height: 70vh;
        overflow: auto;
        padding: 24px;
        background: rgba(20,24,46,0.85);
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 16px;
        box-shadow: 0 30px 80px rgba(0,0,0,0.6);
      }
      .at-card {
        width: 220px;
        height: 160px;
        border-radius: 10px;
        overflow: hidden;
        background: rgba(0,0,0,0.4);
        border: 2px solid transparent;
        display: flex;
        flex-direction: column;
        cursor: pointer;
        transition: transform .15s, border-color .15s, box-shadow .15s;
      }
      .at-card:hover { transform: translateY(-3px); }
      .at-card.selected {
        border-color: var(--accent-1, #7c3aed);
        box-shadow: 0 0 0 4px rgba(124,58,237,0.25);
      }
      .at-card .at-thumb {
        flex: 1 1 auto;
        background: rgba(255,255,255,0.04);
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 56px;
        color: rgba(255,255,255,0.6);
      }
      .at-card .at-thumb-clone {
        position: absolute;
        inset: 0;
        transform-origin: top left;
        pointer-events: none;
      }
      .at-card .at-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: rgba(0,0,0,0.45);
        font-size: 12px;
        color: #fff;
      }
      .at-card .at-meta-icon { font-size: 14px; }
      .at-card .at-meta-title {
        flex: 1 1 auto;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* --- Aero Peek ghost outline --------------------------------------- */
      #aero-peek {
        position: fixed;
        z-index: 999;
        pointer-events: none;
        border: 2px solid rgba(124,58,237,0.85);
        border-radius: 8px;
        background: rgba(124,58,237,0.10);
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,0.18),
          0 0 22px rgba(124,58,237,0.5);
        opacity: 0;
        transition: opacity .12s ease, left .15s, top .15s, width .15s, height .15s;
      }
      #aero-peek.visible { opacity: 1; }

      /* --- desktop icon polish ------------------------------------------- */
      .desktop-icon.selected,
      .desktop-icon[aria-selected="true"] {
        background: radial-gradient(ellipse at center,
          rgba(124,58,237,0.22) 0%,
          rgba(124,58,237,0.08) 50%,
          transparent 100%) !important;
        box-shadow:
          0 0 0 1px rgba(124,58,237,0.45),
          0 0 16px rgba(124,58,237,0.35) !important;
      }
      .desktop-icon.editing-label {
        outline: 2px solid var(--accent-1, #7c3aed);
        outline-offset: 2px;
      }
      .desktop-icon-label-edit {
        background: rgba(0,0,0,0.7);
        color: white;
        border: 1px solid rgba(255,255,255,0.5);
        border-radius: 4px;
        padding: 1px 4px;
        text-align: center;
        font: inherit;
        width: 100%;
        outline: none;
      }

      /* --- floating konami pieces --------------------------------------- */
      .konami-floater {
        animation: konami-bounce 4.8s ease-in-out;
        z-index: 999 !important;
        pointer-events: none;
      }
      @keyframes konami-bounce {
        0%   { transform: translate(0,0) rotate(0); }
        100% { transform: translate(0,0) rotate(360deg); }
      }
      .konami-particle {
        position: fixed;
        font-size: 24px;
        pointer-events: none;
        animation: konami-particle 1.8s ease-out forwards;
        z-index: 99998;
      }
      @keyframes konami-particle {
        0%   { transform: translate(0,0) scale(0.5); opacity: 1; }
        100% { transform: translate(var(--dx), var(--dy)) scale(1.5) rotate(540deg); opacity: 0; }
      }

      /* --- shutdown/restart/lock overlays ------------------------------- */
      #power-overlay {
        position: fixed;
        inset: 0;
        z-index: 100001;
        background: black;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 18px;
        color: white;
        font-family: 'Inter', system-ui, sans-serif;
        opacity: 0;
        transition: opacity .8s ease;
      }
      #power-overlay.show { opacity: 1; }
      #power-overlay .po-text {
        font-size: 18px;
        opacity: .85;
        letter-spacing: 1px;
      }
      #power-overlay .po-spinner {
        width: 36px; height: 36px;
        border: 3px solid rgba(255,255,255,0.2);
        border-top-color: white;
        border-radius: 50%;
        animation: po-spin 0.9s linear infinite;
      }
      @keyframes po-spin { to { transform: rotate(360deg); } }
      #power-overlay.flash {
        background: white;
        animation: po-flash .5s ease;
      }
      @keyframes po-flash {
        0%   { opacity: 0; }
        20%  { opacity: 1; }
        100% { opacity: 0; }
      }

      #lock-overlay {
        position: fixed;
        inset: 0;
        z-index: 99000;
        backdrop-filter: blur(20px) saturate(1.1);
        background: rgba(8,10,22,0.55);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: white;
        animation: lock-fade .35s ease;
      }
      @keyframes lock-fade { from { opacity: 0; } to { opacity: 1; } }
      .lock-clock {
        font-family: 'Inter', sans-serif;
        font-size: 96px;
        font-weight: 200;
        letter-spacing: -2px;
        text-shadow: 0 4px 30px rgba(0,0,0,0.6);
      }
      .lock-date {
        font-size: 18px;
        opacity: .85;
        margin-top: 4px;
      }
      .lock-hint {
        margin-top: 40px;
        font-size: 13px;
        opacity: .7;
        letter-spacing: 2px;
        text-transform: uppercase;
      }

      /* --- "NEW" badge in start menu ------------------------------------ */
      .start-app-tile { position: relative; }
      .start-app-tile.is-new::after {
        content: "NEW";
        position: absolute;
        top: 4px;
        right: 4px;
        font-family: 'Inter', sans-serif;
        font-size: 8px;
        font-weight: 800;
        letter-spacing: 1px;
        background: linear-gradient(180deg, #ff5252, #c62828);
        color: white;
        padding: 1px 5px;
        border-radius: 6px;
        box-shadow: 0 0 8px rgba(255,82,82,0.7);
        pointer-events: none;
        z-index: 2;
      }

      /* --- pending-changes indicator on taskbar pills ------------------- */
      .taskbar-app.has-pending::after,
      .taskbar-pill.has-pending::after,
      [data-app].has-pending::after {
        content: "";
        position: absolute;
        bottom: 1px;
        left: 50%;
        transform: translateX(-50%);
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #ff8a00;
        box-shadow: 0 0 8px #ff8a00;
        z-index: 2;
      }

      /* --- BIOS boot screen --------------------------------------------- */
      #bios-screen {
        position: fixed;
        inset: 0;
        z-index: 100002;
        background: black;
        color: #c0c0c0;
        font-family: 'JetBrains Mono', 'Press Start 2P', monospace;
        font-size: 14px;
        padding: 28px;
        line-height: 1.7;
        animation: bios-flicker 0.1s steps(3) infinite;
      }
      @keyframes bios-flicker {
        0% { opacity: 1; }
        50% { opacity: 0.97; }
        100% { opacity: 1; }
      }
      #bios-screen .bios-title {
        color: #fff;
        font-size: 16px;
        margin-bottom: 16px;
        letter-spacing: 1px;
      }
      #bios-screen .bios-line { display: block; }
      #bios-screen .bios-ok { color: #4ade80; }
      #bios-screen .bios-prompt {
        margin-top: 20px;
        opacity: .85;
      }
      #bios-screen .bios-cursor::after {
        content: "_";
        animation: bios-blink 1s steps(2) infinite;
      }
      @keyframes bios-blink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
    `);
  }

  /* =======================================================================
   * 2. WINDOW SHAKE + MIN/RESTORE FLY ANIMATIONS
   * ===================================================================== */
  function installWindowEnhancements() {
    if (!window.WindowManager) return;
    const WM = window.WindowManager;

    // Shake when trying to drag maximized
    document.addEventListener("mousedown", (e) => {
      const titlebar = e.target.closest && e.target.closest(".window-titlebar");
      if (!titlebar) return;
      const winEl = titlebar.closest(".window");
      if (!winEl || !winEl.classList.contains("maximized")) return;
      // Wait a tick — only shake when user actually tries to *drag* (move ≥ 5px)
      const startX = e.clientX, startY = e.clientY;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) {
          shakeWindow(winEl);
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Override minimize / restore animations so they fly toward the taskbar
    // pill of the related app.
    function pillRectFor(appId) {
      const pill =
        document.querySelector(`.taskbar-app[data-app-id="${appId}"]`) ||
        document.querySelector(`.taskbar-app[data-id="${appId}"]`) ||
        document.querySelector(`[data-app="${appId}"]`) ||
        document.querySelector(".taskbar-app");
      if (!pill) return null;
      return pill.getBoundingClientRect();
    }
    function applyFlyAnim(winEl, appId, kind) {
      const wr = winEl.getBoundingClientRect();
      const pr = pillRectFor(appId);
      if (!pr) return;
      const dx = (pr.left + pr.width / 2) - (wr.left + wr.width / 2);
      const dy = (pr.top  + pr.height / 2) - (wr.top  + wr.height / 2);
      winEl.style.setProperty("--mx", dx + "px");
      winEl.style.setProperty("--my", dy + "px");
      winEl.classList.remove("minimize-fly", "restore-fly");
      // force reflow
      void winEl.offsetWidth;
      winEl.classList.add(kind === "min" ? "minimize-fly" : "restore-fly");
      const remove = () => winEl.classList.remove("minimize-fly", "restore-fly");
      winEl.addEventListener("animationend", remove, { once: true });
      setTimeout(remove, 400);
    }

    window.addEventListener("webos:windowminimize", (e) => {
      try {
        const id = e && e.detail && e.detail.id;
        const appId = e && e.detail && e.detail.appId;
        if (!id) return;
        const win = WM.getWindow && WM.getWindow(id);
        if (!win || !win.el) return;
        applyFlyAnim(win.el, appId, "min");
      } catch (err) { /* ignore */ }
    });
    window.addEventListener("webos:windowrestore", (e) => {
      try {
        const id = e && e.detail && e.detail.id;
        const appId = e && e.detail && e.detail.appId;
        if (!id) return;
        const win = WM.getWindow && WM.getWindow(id);
        if (!win || !win.el) return;
        applyFlyAnim(win.el, appId, "res");
      } catch (err) { /* ignore */ }
    });
  }

  function shakeWindow(winEl) {
    if (!winEl) return;
    winEl.classList.remove("wm-shake");
    void winEl.offsetWidth;
    winEl.classList.add("wm-shake");
    setTimeout(() => winEl.classList.remove("wm-shake"), 480);
  }

  /* =======================================================================
   * 3. ALT+TAB SWITCHER WITH THUMBNAILS
   * ===================================================================== */
  let _altTabState = null;
  function altTabOpen(direction) {
    if (!window.WindowManager) return;
    const WM = window.WindowManager;
    const wins = (WM.listWindows ? WM.listWindows() : []).slice();
    if (wins.length === 0) return;

    // close any existing
    altTabClose();

    const overlay = document.createElement("div");
    overlay.id = "alt-tab-overlay";
    const grid = document.createElement("div");
    grid.className = "at-grid";

    const cards = wins.map((w) => {
      const card = document.createElement("div");
      card.className = "at-card";
      card.dataset.id = w.id;

      const thumb = document.createElement("div");
      thumb.className = "at-thumb";
      // Make a CSS-scaled clone of the body when possible
      try {
        if (w.el) {
          const clone = w.el.cloneNode(true);
          clone.style.position = "absolute";
          clone.style.top = "0";
          clone.style.left = "0";
          clone.style.right = "auto";
          clone.style.bottom = "auto";
          clone.style.margin = "0";
          clone.style.boxShadow = "none";
          clone.classList.add("at-thumb-clone");
          // remove animation classes
          clone.classList.remove(
            "minimize-fly", "restore-fly", "wm-shake",
            "minimizing", "restoring", "closing"
          );
          // remove any controls listeners by virtue of cloning
          // Compute scale
          const wr = w.el.getBoundingClientRect();
          const tw = 220, th = 130;
          const scale = Math.min(tw / Math.max(1, wr.width),
                                 th / Math.max(1, wr.height));
          clone.style.transform = "scale(" + scale + ")";
          clone.style.width  = wr.width + "px";
          clone.style.height = wr.height + "px";
          thumb.appendChild(clone);
        } else {
          thumb.textContent = (w.icon || "🪟");
        }
      } catch {
        thumb.textContent = (w.icon || "🪟");
      }
      card.appendChild(thumb);

      const meta = document.createElement("div");
      meta.className = "at-meta";
      meta.innerHTML = `
        <span class="at-meta-icon">${w.icon || "🪟"}</span>
        <span class="at-meta-title">${w.title || w.appId || "Window"}</span>`;
      card.appendChild(meta);

      card.addEventListener("click", () => {
        WM.focusWindow(w.id);
        altTabClose();
      });
      grid.appendChild(card);
      return card;
    });

    overlay.appendChild(grid);
    document.body.appendChild(overlay);

    let idx = 0;
    // Pre-select next/prev relative to currently focused
    const focused = WM.getFocused && WM.getFocused();
    const focusIdx = focused ? wins.findIndex(w => w.id === focused.id) : -1;
    if (focusIdx >= 0) {
      idx = (focusIdx + (direction || 1) + wins.length) % wins.length;
    }
    function refresh() {
      cards.forEach((c, i) => c.classList.toggle("selected", i === idx));
      cards[idx] && cards[idx].scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    refresh();

    function onKey(e) {
      if (e.key === "Tab") {
        e.preventDefault();
        idx = (idx + (e.shiftKey ? -1 : 1) + cards.length) % cards.length;
        refresh();
      } else if (e.key === "ArrowLeft") {
        idx = (idx - 1 + cards.length) % cards.length; refresh();
      } else if (e.key === "ArrowRight") {
        idx = (idx + 1) % cards.length; refresh();
      } else if (e.key === "Enter") {
        e.preventDefault();
        WM.focusWindow(wins[idx].id);
        altTabClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        altTabClose();
      }
    }
    function onUp(e) {
      if (e.key === "Alt" || e.key === "Meta") {
        WM.focusWindow(wins[idx].id);
        altTabClose();
      }
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onUp, true);

    _altTabState = {
      overlay,
      cleanup: () => {
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("keyup", onUp, true);
      }
    };
  }
  function altTabClose() {
    if (!_altTabState) return;
    _altTabState.cleanup();
    _altTabState.overlay.remove();
    _altTabState = null;
  }

  function installAltTab() {
    document.addEventListener("keydown", (e) => {
      if (e.altKey && e.key === "Tab") {
        // Only open the overlay if there are 2+ windows
        const list = window.WindowManager && window.WindowManager.listWindows
          ? window.WindowManager.listWindows() : [];
        if (list.length < 2) return;
        if (_altTabState) return; // existing handler will move selection
        e.preventDefault();
        e.stopPropagation();
        altTabOpen(e.shiftKey ? -1 : 1);
      }
    }, true);
  }

  /* =======================================================================
   * 4. AERO PEEK — taskbar pill hover ghosts the window's screen position
   * ===================================================================== */
  function installAeroPeek() {
    let peek = document.getElementById("aero-peek");
    if (!peek) {
      peek = document.createElement("div");
      peek.id = "aero-peek";
      document.body.appendChild(peek);
    }
    let raf = null;
    let lastEl = null;
    const findApp = (el) =>
      el.closest("[data-app-id], .taskbar-app, .taskbar-pill, [data-app]");

    function show(target) {
      const appId = target.dataset.appId || target.dataset.app || target.dataset.id;
      if (!appId || !window.WindowManager || !window.WindowManager.listWindows) return;
      const wins = window.WindowManager.listWindows().filter(w => w.appId === appId && !w.minimized);
      if (wins.length === 0) { hide(); return; }
      const w = wins[0];
      if (!w.el) { hide(); return; }
      const r = w.el.getBoundingClientRect();
      peek.style.left = r.left + "px";
      peek.style.top  = r.top  + "px";
      peek.style.width  = r.width  + "px";
      peek.style.height = r.height + "px";
      peek.classList.add("visible");
    }
    function hide() {
      peek.classList.remove("visible");
      lastEl = null;
    }

    document.addEventListener("mouseover", (e) => {
      const t = e.target && findApp(e.target);
      if (!t) return;
      if (t === lastEl) return;
      lastEl = t;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => show(t));
    });
    document.addEventListener("mouseout", (e) => {
      const t = e.target && findApp(e.target);
      if (!t) return;
      // hide if leaving without entering another pill
      const r = e.relatedTarget && findApp(e.relatedTarget);
      if (!r) hide();
    });
    window.addEventListener("blur", hide);
  }

  /* =======================================================================
   * 5. PARALLAX WALLPAPER + CLOCK TOOLTIP/CONTEXT MENU
   * ===================================================================== */
  function installWallpaperParallax() {
    const wp = document.getElementById("desktop-wallpaper")
           || document.querySelector(".desktop-wallpaper")
           || document.querySelector(".desktop-bg")
           || document.querySelector(".desktop");
    if (!wp) return;
    let raf = null, mx = 0, my = 0;
    document.addEventListener("mousemove", (e) => {
      const w = window.innerWidth, h = window.innerHeight;
      mx = ((e.clientX / w) - 0.5) * -3; // -1.5 .. 1.5 px (scaled)
      my = ((e.clientY / h) - 0.5) * -3;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        wp.style.backgroundPosition = `calc(50% + ${mx}px) calc(50% + ${my}px)`;
        raf = null;
      });
    });
  }

  function installClockEnhancements() {
    const clock = document.getElementById("taskbar-clock");
    if (!clock) return;
    const updateTooltip = () => {
      const now = new Date();
      const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      const day = days[now.getDay()];
      const dStr = day + ", " + months[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear();
      clock.title = dStr + "\n" + now.toLocaleTimeString();
    };
    updateTooltip();
    setInterval(updateTooltip, 30000);

    clock.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const now = new Date();
      const items = [
        { label: "Open Calendar Widget", action: () => {
          if (window.Widgets && window.Widgets.openWidget) window.Widgets.openWidget("calendar");
          else if (window.Widgets && window.Widgets.toggle) window.Widgets.toggle();
          else if (window.WindowManager) window.WindowManager.openApp("settings");
        }},
        { label: "Copy Time", action: () => {
          navigator.clipboard && navigator.clipboard.writeText(now.toLocaleTimeString());
          toast("Time copied: " + now.toLocaleTimeString());
        }},
        { label: "Copy Date", action: () => {
          navigator.clipboard && navigator.clipboard.writeText(now.toLocaleDateString());
          toast("Date copied: " + now.toLocaleDateString());
        }},
        { label: "Date & Time Settings", action: () => {
          if (window.WindowManager) window.WindowManager.openApp("settings");
        }},
      ];
      if (window.ContextMenu && window.ContextMenu.show) {
        window.ContextMenu.show(items, e.clientX, e.clientY);
      } else {
        // fallback inline menu
        showInlineMenu(items, e.clientX, e.clientY);
      }
    });
  }

  function showInlineMenu(items, x, y) {
    const m = document.createElement("div");
    m.style.cssText = `
      position: fixed; z-index: 100000; left: ${x}px; top: ${y}px;
      background: rgba(20,24,46,0.97); color: #fff;
      border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
      padding: 4px; min-width: 180px; font-size: 13px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    `;
    items.forEach(it => {
      const row = document.createElement("div");
      row.textContent = it.label;
      row.style.cssText = "padding: 6px 12px; cursor: pointer; border-radius: 4px;";
      row.addEventListener("mouseenter", () => row.style.background = "rgba(124,58,237,0.3)");
      row.addEventListener("mouseleave", () => row.style.background = "");
      row.addEventListener("click", () => { it.action(); m.remove(); });
      m.appendChild(row);
    });
    document.body.appendChild(m);
    const close = (e) => {
      if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", close); }
    };
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  /* =======================================================================
   * 6. TASKBAR PENDING-CHANGES INDICATOR
   * ===================================================================== */
  function installPendingIndicator() {
    function refresh() {
      try {
        if (!window.WindowManager || !window.WindowManager.listWindows) return;
        const wins = window.WindowManager.listWindows();
        const pendingApps = new Set();
        for (const w of wins) {
          if (typeof w.hasPendingChanges === "function") {
            try { if (w.hasPendingChanges()) pendingApps.add(w.appId); } catch {}
          } else if (w.opts && w.opts.hasPendingChanges) {
            try { if (w.opts.hasPendingChanges()) pendingApps.add(w.appId); } catch {}
          }
        }
        $$(".taskbar-app, .taskbar-pill, [data-app-id]").forEach(el => {
          const id = el.dataset.appId || el.dataset.app || el.dataset.id;
          if (!id) return;
          el.classList.toggle("has-pending", pendingApps.has(id));
        });
      } catch {}
    }
    setInterval(refresh, 1500);
  }

  /* =======================================================================
   * 7. DESKTOP ICON RENAME (slow double-click)
   * ===================================================================== */
  function installDesktopIconRename() {
    const desktop = document.getElementById("desktop")
                 || document.querySelector(".desktop");
    if (!desktop) return;
    const lastClick = new WeakMap();
    desktop.addEventListener("click", (e) => {
      const icon = e.target.closest && e.target.closest(".desktop-icon");
      if (!icon) return;
      const now = Date.now();
      const prev = lastClick.get(icon) || 0;
      lastClick.set(icon, now);
      // slow double-click: between 400 and 1100 ms
      if (prev && (now - prev) > 400 && (now - prev) < 1100) {
        beginRename(icon);
      }
    });
  }
  function beginRename(icon) {
    const labelEl = icon.querySelector(".desktop-icon-label, .icon-label, .label");
    if (!labelEl) return;
    if (icon.classList.contains("editing-label")) return;
    icon.classList.add("editing-label");
    const oldText = labelEl.textContent;
    const input = document.createElement("input");
    input.className = "desktop-icon-label-edit";
    input.value = oldText;
    input.spellcheck = false;
    labelEl.style.display = "none";
    labelEl.parentNode.insertBefore(input, labelEl);
    input.focus();
    input.select();
    const finish = (commit) => {
      icon.classList.remove("editing-label");
      const newName = input.value.trim();
      input.remove();
      labelEl.style.display = "";
      if (commit && newName && newName !== oldText) {
        labelEl.textContent = newName;
        const path = icon.dataset.path;
        if (path && window.FileSystem && window.FileSystem.rename) {
          try {
            const dir = window.FileSystem.dirname(path);
            const newPath = window.FileSystem.joinPath(dir, newName);
            window.FileSystem.rename(path, newPath);
            icon.dataset.path = newPath;
          } catch (err) { console.warn(err); }
        }
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  /* =======================================================================
   * 8. DRAG FROM FILE-MANAGER → DESKTOP
   * ===================================================================== */
  function installDesktopDrop() {
    const desktop = document.getElementById("desktop")
                 || document.querySelector(".desktop");
    if (!desktop) return;
    desktop.addEventListener("dragover", (e) => {
      const types = e.dataTransfer && Array.from(e.dataTransfer.types || []);
      if (!types) return;
      if (types.includes("application/x-webos-file") ||
          types.includes("text/plain")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    desktop.addEventListener("drop", (e) => {
      try {
        const json = e.dataTransfer.getData("application/x-webos-file");
        if (!json) return;
        e.preventDefault();
        const data = JSON.parse(json);
        const paths = Array.isArray(data) ? data : data.paths || [data.path];
        if (!paths || paths.length === 0) return;
        if (!window.FileSystem) return;
        for (const p of paths) {
          if (!p) continue;
          const name = window.FileSystem.basename(p);
          const target = window.FileSystem.joinPath("/Desktop", name);
          if (p === target) continue;
          try {
            const uniq = window.FileSystem.uniquifyName
              ? window.FileSystem.uniquifyName(target)
              : target;
            window.FileSystem.moveFile(p, uniq);
          } catch (err) { console.warn(err); }
        }
        toast(paths.length + " file(s) moved to Desktop");
      } catch (err) {
        console.warn("[polish] desktop drop error:", err);
      }
    });
  }

  /* =======================================================================
   * 9. KONAMI EASTER EGG
   * ===================================================================== */
  function installKonami() {
    let buf = [];
    document.addEventListener("keydown", (e) => {
      if (e.target && e.target.matches && e.target.matches("input, textarea, [contenteditable]")) return;
      const k = e.key;
      buf.push(k);
      if (buf.length > KONAMI.length) buf.shift();
      // case-insensitive compare for letters
      const ok = buf.length === KONAMI.length &&
        buf.every((v, i) => v === KONAMI[i] || v.toLowerCase() === KONAMI[i].toLowerCase());
      if (ok) {
        triggerKonami();
        buf = [];
      }
    });
  }

  function triggerKonami() {
    try { localStorage.setItem(KONAMI_KEY, "1"); } catch {}
    const desktop = document.getElementById("desktop")
                 || document.querySelector(".desktop")
                 || document.body;
    const icons = $$(".desktop-icon, [data-icon-id]");
    if (icons.length === 0) {
      toast("You found it! 🎮");
      return;
    }
    const positions = icons.map(i => {
      const r = i.getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
    icons.forEach((icon, i) => {
      const start = positions[i];
      icon.classList.add("konami-floater");
      icon.style.position = "fixed";
      icon.style.left = start.x + "px";
      icon.style.top  = start.y + "px";
      icon.style.zIndex = 999;
      const dx = (Math.random() - 0.5) * 2;
      const dy = (Math.random() - 0.5) * 2;
      const speed = 1.2 + Math.random() * 1.5;
      let vx = dx * speed * 60;
      let vy = dy * speed * 60;
      let x = start.x, y = start.y;
      const r = icon.getBoundingClientRect();
      const w = r.width, h = r.height;
      const W = window.innerWidth - w, H = window.innerHeight - h;
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(50, now - last) / 1000;
        last = now;
        x += vx * dt;
        y += vy * dt;
        if (x < 0)   { x = 0;   vx = -vx; }
        if (x > W)   { x = W;   vx = -vx; }
        if (y < 0)   { y = 0;   vy = -vy; }
        if (y > H-50){ y = H-50; vy = -vy; }
        icon.style.left = x + "px";
        icon.style.top  = y + "px";
        if (icon._konamiActive) requestAnimationFrame(tick);
      };
      icon._konamiActive = true;
      requestAnimationFrame(tick);
    });

    // particle burst
    const emojis = ["🎵", "🎶", "♬", "✨", "🌟", "💫", "⭐", "🎮", "🎯", "🚀"];
    let particleId = 0;
    const partTimer = setInterval(() => {
      const p = document.createElement("div");
      p.className = "konami-particle";
      p.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      p.style.left = (Math.random() * window.innerWidth) + "px";
      p.style.top  = (Math.random() * window.innerHeight) + "px";
      p.style.setProperty("--dx", ((Math.random() - 0.5) * 200) + "px");
      p.style.setProperty("--dy", ((Math.random() - 0.5) * 200 - 100) + "px");
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 1800);
      particleId++;
    }, 90);

    setTimeout(() => clearInterval(partTimer), 5000);

    // settle back
    setTimeout(() => {
      icons.forEach((icon, i) => {
        icon._konamiActive = false;
        icon.classList.remove("konami-floater");
        icon.style.position = "";
        icon.style.left = "";
        icon.style.top  = "";
        icon.style.zIndex = "";
      });
      toast("You found it! 🎮");
    }, 5000);
  }

  /* =======================================================================
   * 10. RECENTLY INSTALLED TRACKING + START MENU "NEW" BADGE
   * ===================================================================== */
  function loadRecentInstalls() {
    try {
      const raw = localStorage.getItem(RECENT_INSTALL_KEY);
      if (raw) return JSON.parse(raw) || {};
    } catch {}
    return {};
  }
  function saveRecentInstalls(map) {
    try { localStorage.setItem(RECENT_INSTALL_KEY, JSON.stringify(map)); } catch {}
  }
  function markRecentInstall(appId) {
    const m = loadRecentInstalls();
    m[appId] = Date.now();
    saveRecentInstalls(m);
    refreshNewBadges();
  }
  function refreshNewBadges() {
    const m = loadRecentInstalls();
    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 3600 * 1000;
    Object.keys(m).forEach(k => { if (m[k] < cutoff) delete m[k]; });
    saveRecentInstalls(m);
    const ids = new Set(Object.keys(m));
    $$(".start-app-tile, [data-app-id]").forEach(el => {
      const id = el.dataset.appId || el.dataset.app || el.dataset.id;
      if (!id) return;
      el.classList.toggle("is-new", ids.has(id));
    });
  }
  function installRecentInstallTracking() {
    window.addEventListener("webos:appinstalled", (e) => {
      try {
        const id = (e.detail && (e.detail.id || e.detail.appId)) || null;
        if (id) markRecentInstall(id);
      } catch {}
    });
    setInterval(refreshNewBadges, 30000);
    refreshNewBadges();
  }

  /* =======================================================================
   * 11. POWER MENU ANIMATIONS
   * ===================================================================== */
  function showPowerOverlay(text) {
    const ov = document.createElement("div");
    ov.id = "power-overlay";
    ov.innerHTML = `
      <div class="po-spinner"></div>
      <div class="po-text">${text}</div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("show"));
    return ov;
  }
  function flashScreen() {
    const ov = document.createElement("div");
    ov.id = "power-overlay";
    ov.classList.add("flash", "show");
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 500);
  }
  function showLockScreen() {
    if (document.getElementById("lock-overlay")) return;
    const ov = document.createElement("div");
    ov.id = "lock-overlay";
    const update = () => {
      const now = new Date();
      const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const t = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const d = days[now.getDay()] + ", " + months[now.getMonth()] + " " + now.getDate();
      ov.innerHTML = `
        <div class="lock-clock">${t}</div>
        <div class="lock-date">${d}</div>
        <div class="lock-hint">Click or press any key to unlock</div>`;
    };
    update();
    document.body.appendChild(ov);
    const t = setInterval(update, 30000);
    const unlock = () => {
      clearInterval(t);
      ov.style.transition = "opacity .3s ease";
      ov.style.opacity = "0";
      setTimeout(() => ov.remove(), 320);
    };
    ov.addEventListener("click", unlock);
    document.addEventListener("keydown", unlock, { once: true });
  }

  function installPowerActions() {
    // Provide global power API
    window.Polish = window.Polish || {};
    Object.assign(window.Polish, {
      shutdown() {
        const ov = showPowerOverlay("Shutting down…");
        setTimeout(() => {
          ov.querySelector(".po-text").textContent = "It is now safe to refresh.";
          ov.querySelector(".po-spinner").style.display = "none";
        }, 2200);
      },
      restart() {
        flashScreen();
        setTimeout(() => {
          // re-run boot sequence if available
          if (window.Boot && typeof window.Boot.run === "function") {
            window.Boot.run();
          } else {
            const boot = document.getElementById("boot-screen");
            if (boot) {
              boot.style.display = "";
              boot.style.opacity = "1";
              boot.removeAttribute("aria-hidden");
              setTimeout(() => {
                boot.style.transition = "opacity .8s";
                boot.style.opacity = "0";
                setTimeout(() => boot.style.display = "none", 800);
              }, 1500);
            }
          }
        }, 600);
      },
      lock() { showLockScreen(); },
      konami() { triggerKonami(); },
      altTab(dir) { altTabOpen(dir || 1); },
      shake(el) { shakeWindow(el); },
      markRecentInstall,
      refreshNewBadges,
    });

    // Hook up start-menu power buttons if they exist
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-power]");
      if (!btn) return;
      const which = btn.dataset.power;
      if (which === "shutdown") { e.preventDefault(); window.Polish.shutdown(); }
      if (which === "restart")  { e.preventDefault(); window.Polish.restart();  }
      if (which === "lock")     { e.preventDefault(); window.Polish.lock();     }
    });
  }

  /* =======================================================================
   * 12. BIOS SCREEN  (used by enhanced boot — see boot.js polish edits)
   * ===================================================================== */
  function showBiosScreen(durationMs) {
    return new Promise(resolve => {
      const existing = document.getElementById("bios-screen");
      if (existing) existing.remove();
      const ov = document.createElement("div");
      ov.id = "bios-screen";
      ov.innerHTML = `
        <div class="bios-title">WebOS BIOS v2.0 (C) WebOS Project — All rights reserved</div>
        <span class="bios-line">Performing memory test...</span>
        <span class="bios-line">CPU: WebCore i9 @ 4.2GHz   <span class="bios-ok">OK</span></span>
        <span class="bios-line">RAM: 16384 MB   <span class="bios-ok">OK</span></span>
        <span class="bios-line">GPU: WebGL Compositor   <span class="bios-ok">OK</span></span>
        <span class="bios-line">Storage: localStorage + AI Drive   <span class="bios-ok">OK</span></span>
        <span class="bios-line">Boot device: index.html</span>
        <div class="bios-prompt">Press DEL to enter setup... <span class="bios-cursor"></span></div>
      `;
      document.body.appendChild(ov);
      setTimeout(() => {
        ov.style.transition = "opacity .25s ease";
        ov.style.opacity = "0";
        setTimeout(() => { ov.remove(); resolve(); }, 280);
      }, durationMs || 1000);
    });
  }
  // Expose so boot.js can call it
  window.Polish = window.Polish || {};
  window.Polish.showBiosScreen = showBiosScreen;

  /* =======================================================================
   * INIT  — install everything once DOM ready
   * ===================================================================== */
  function init() {
    installStyles();
    installWindowEnhancements();
    installAltTab();
    installAeroPeek();
    installWallpaperParallax();
    installClockEnhancements();
    installPendingIndicator();
    installDesktopIconRename();
    installDesktopDrop();
    installKonami();
    installRecentInstallTracking();
    installPowerActions();
    console.log("%c[WebOS]%c Polish layer ready",
      "color:#06b6d4;font-weight:bold", "color:inherit");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // wait one tick so other managers register first
    setTimeout(init, 50);
  }

  /* =======================================================================
   * PUBLIC API merge
   * ===================================================================== */
  window.Polish = Object.assign(window.Polish || {}, {
    altTabOpen, altTabClose,
    shakeWindow, showBiosScreen, showLockScreen,
    markRecentInstall, refreshNewBadges,
    triggerKonami,
    showInlineMenu,
  });

})();
