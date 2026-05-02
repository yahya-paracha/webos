/* ============================================================================
 * WebOS — windowManager.js
 * ----------------------------------------------------------------------------
 * Full-featured window manager:
 *   - create / open / close / focus
 *   - drag (with momentum-free snapping)
 *   - resize (8 handles: n, s, e, w, ne, nw, se, sw)
 *   - minimize / maximize / restore
 *   - z-index stacking with focus
 *   - snap previews (Aero-style): left half, right half, top maximize,
 *     corners (top-left/top-right/bottom-left/bottom-right quarter)
 *   - keyboard shortcuts (Alt+Tab, Win+Up/Down/Left/Right, F11)
 *   - app registry (any module can register an app type)
 *   - emits "webos:windowopen|close|focus|minimize|maximize|restore|move|resize"
 *   - public API on window.WindowManager
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------------*/
  const ROOT_ID         = "windows-root";
  const Z_BASE          = 100;
  const Z_STEP          = 1;
  const SNAP_THRESHOLD  = 12;      // px from edge to trigger snap preview
  const SNAP_CORNER_MIN = 60;      // px corner zone size
  const MIN_W           = 280;
  const MIN_H           = 180;

  const SNAP_REGIONS = Object.freeze({
    NONE:   "none",
    LEFT:   "left",
    RIGHT:  "right",
    TOP:    "top",     // -> maximize
    TL:     "tl",
    TR:     "tr",
    BL:     "bl",
    BR:     "br",
  });

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    windows:   new Map(),  // id -> Window instance
    order:     [],         // z-order, last is topmost
    focused:   null,       // id of focused window
    apps:      new Map(),  // appId -> AppDef
    nextId:    1,
    nextZ:     Z_BASE,
    snapPreview: null,
    initialized: false,
    root:       null,
  };

  /* --------------------------------------------------------------------------
   * Utilities
   * ------------------------------------------------------------------------*/
  function uid(prefix) {
    return (prefix || "win") + "_" + (state.nextId++) + "_" + Date.now().toString(36);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent("webos:" + name, { detail }));
    } catch (_) {}
  }

  function ensureRoot() {
    if (state.root && document.body.contains(state.root)) return state.root;
    let r = document.getElementById(ROOT_ID);
    if (!r) {
      r = document.createElement("div");
      r.id = ROOT_ID;
      r.className = "windows-root";
      document.body.appendChild(r);
    }
    state.root = r;
    return r;
  }

  function viewport() {
    const tb = document.getElementById("taskbar");
    const taskbarH = tb ? tb.offsetHeight : 52;
    return {
      x: 0,
      y: 0,
      w: window.innerWidth,
      h: window.innerHeight - taskbarH,
      taskbarH,
    };
  }

  function svgIcon(emoji) {
    // Use plain emoji wrapped in span; allows CSS theming.
    return emoji || "▦";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* --------------------------------------------------------------------------
   * App Registry
   * ------------------------------------------------------------------------*/
  function registerApp(def) {
    if (!def || !def.id) {
      console.warn("[WindowManager] registerApp: missing id", def);
      return false;
    }
    state.apps.set(def.id, Object.assign({
      id:          def.id,
      title:       def.title || def.id,
      icon:        def.icon  || "▦",
      width:       def.width  || 720,
      height:      def.height || 480,
      minWidth:    def.minWidth  || MIN_W,
      minHeight:   def.minHeight || MIN_H,
      resizable:   def.resizable !== false,
      draggable:   def.draggable !== false,
      maximizable: def.maximizable !== false,
      minimizable: def.minimizable !== false,
      singleton:   !!def.singleton,
      render:      def.render || defaultRender,
      onClose:     def.onClose || null,
      onFocus:     def.onFocus || null,
      onResize:    def.onResize || null,
      category:    def.category || "Apps",
      pinned:      !!def.pinned,
    }, def));
    emit("appregister", { id: def.id });
    return true;
  }

  function unregisterApp(id) {
    state.apps.delete(id);
    emit("appunregister", { id });
  }

  function getApps() { return Array.from(state.apps.values()); }
  function getApp(id) { return state.apps.get(id); }

  function defaultRender(body, win) {
    body.innerHTML = `
      <div class="window-empty">
        <div class="we-glyph">${escapeHtml(win.icon || "▦")}</div>
        <div><b>${escapeHtml(win.title)}</b></div>
        <div style="opacity:.7">No content has been provided for this window.</div>
      </div>
    `;
  }

  /* --------------------------------------------------------------------------
   * Window class
   * ------------------------------------------------------------------------*/
  class WebOSWindow {
    constructor(opts) {
      const o = opts || {};
      this.id        = o.id || uid("win");
      this.appId     = o.appId || null;
      this.title     = o.title || "Untitled";
      this.icon      = o.icon  || "▦";
      this.width     = o.width  || 720;
      this.height    = o.height || 480;
      this.x         = (o.x != null) ? o.x : null; // null -> auto-cascade
      this.y         = (o.y != null) ? o.y : null;
      this.minWidth  = o.minWidth  || MIN_W;
      this.minHeight = o.minHeight || MIN_H;
      this.resizable = o.resizable !== false;
      this.draggable = o.draggable !== false;
      this.maximizable = o.maximizable !== false;
      this.minimizable = o.minimizable !== false;

      this.maximized = false;
      this.minimized = false;
      this.snapped   = SNAP_REGIONS.NONE;
      this.prev      = null; // last non-maximized rect

      this.zIndex    = 0;
      this.render    = o.render || defaultRender;
      this.onClose   = o.onClose || null;
      this.onFocus   = o.onFocus || null;
      this.onResize  = o.onResize || null;

      this.el        = null;
      this.bodyEl    = null;
      this.titleEl   = null;
      this.opts      = o;
      this.createdAt = Date.now();
    }

    /* ----------  DOM build  ---------- */
    mount(root) {
      const el = document.createElement("div");
      el.className = "window";
      el.dataset.id = this.id;
      el.dataset.appId = this.appId || "";
      el.tabIndex = -1;

      // Auto-cascade position if not set
      const vp = viewport();
      if (this.x == null) {
        const offset = (state.windows.size * 28) % 240;
        this.x = clamp(80 + offset, 8, vp.w - this.width - 8);
      }
      if (this.y == null) {
        const offset = (state.windows.size * 28) % 200;
        this.y = clamp(60 + offset, 8, vp.h - this.height - 8);
      }
      el.style.left   = this.x + "px";
      el.style.top    = this.y + "px";
      el.style.width  = this.width + "px";
      el.style.height = this.height + "px";

      // Titlebar
      const titlebar = document.createElement("div");
      titlebar.className = "window-titlebar";
      titlebar.innerHTML = `
        <span class="window-icon">${escapeHtml(svgIcon(this.icon))}</span>
        <span class="window-title">${escapeHtml(this.title)}</span>
        <span class="window-controls">
          ${this.minimizable ? `<button class="window-control minimize" title="Minimize">▁</button>` : ""}
          ${this.maximizable ? `<button class="window-control maximize" title="Maximize">▢</button>` : ""}
          <button class="window-control close" title="Close">✕</button>
        </span>
      `;
      el.appendChild(titlebar);

      // Body
      const body = document.createElement("div");
      body.className = "window-body";
      el.appendChild(body);

      // Resize handles
      if (this.resizable) {
        ["n","s","e","w","ne","nw","se","sw"].forEach((dir) => {
          const h = document.createElement("div");
          h.className = "window-resize " + dir;
          h.dataset.dir = dir;
          el.appendChild(h);
        });
      }

      this.el      = el;
      this.bodyEl  = body;
      this.titleEl = titlebar.querySelector(".window-title");
      this.iconEl  = titlebar.querySelector(".window-icon");

      // Render content
      try {
        this.render(body, this);
      } catch (e) {
        console.error("[WindowManager] render failed:", e);
        defaultRender(body, this);
      }

      // Bind interactions
      this._bindTitlebar(titlebar);
      this._bindControls(titlebar);
      this._bindResize();
      this._bindFocus();

      root.appendChild(el);

      // Initial focus
      requestAnimationFrame(() => focusWindow(this.id));
      return el;
    }

    /* ----------  Titlebar (drag + double-click maximize)  ---------- */
    _bindTitlebar(titlebar) {
      let dragging = false;
      let startX = 0, startY = 0;
      let origX = 0, origY = 0;
      let lastX = 0, lastY = 0;
      const self = this;

      titlebar.addEventListener("dblclick", (e) => {
        if (e.target.closest(".window-control")) return;
        if (this.maximizable) toggleMaximize(this.id);
      });

      titlebar.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showWindowContextMenu(this, e.clientX, e.clientY);
      });

      titlebar.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".window-control")) return;
        if (!this.draggable) return;

        focusWindow(this.id);

        // If maximized, restore at the click point and continue dragging
        if (this.maximized || this.snapped !== SNAP_REGIONS.NONE) {
          const ratio = this.prev ? this.prev.w / this.el.offsetWidth : 0.5;
          unmaximize(this.id, /* silent */ true);
          // Position so cursor remains roughly over the titlebar
          const newW = this.prev ? this.prev.w : this.width;
          const newH = this.prev ? this.prev.h : this.height;
          this.width = newW;
          this.height = newH;
          this.x = e.clientX - newW * ratio;
          this.y = e.clientY - 12;
          this.applyRect();
        }

        dragging = true;
        startX = e.clientX; startY = e.clientY;
        origX = this.x;     origY = this.y;
        lastX = e.clientX;  lastY = e.clientY;
        this.el.classList.add("dragging");
        titlebar.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
          if (!dragging) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          const vp = viewport();
          self.x = clamp(origX + dx, -self.width + 80, vp.w - 80);
          self.y = clamp(origY + dy, 0, vp.h - 32);
          self.applyRect();

          lastX = ev.clientX; lastY = ev.clientY;
          updateSnapPreview(ev.clientX, ev.clientY);
          emit("windowmove", { id: self.id, x: self.x, y: self.y });
        };

        const onUp = (ev) => {
          if (!dragging) return;
          dragging = false;
          self.el.classList.remove("dragging");
          try { titlebar.releasePointerCapture(ev.pointerId); } catch (_) {}
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup",   onUp);

          // Apply snap if one is active
          const region = computeSnapRegion(ev.clientX, ev.clientY);
          if (region !== SNAP_REGIONS.NONE) snapTo(self.id, region);
          hideSnapPreview();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup",   onUp);
      });
    }

    /* ----------  Window controls  ---------- */
    _bindControls(titlebar) {
      const close = titlebar.querySelector(".window-control.close");
      const max   = titlebar.querySelector(".window-control.maximize");
      const min   = titlebar.querySelector(".window-control.minimize");

      if (close) close.addEventListener("click", (e) => { e.stopPropagation(); closeWindow(this.id); });
      if (max)   max.addEventListener("click",   (e) => { e.stopPropagation(); toggleMaximize(this.id); });
      if (min)   min.addEventListener("click",   (e) => { e.stopPropagation(); minimizeWindow(this.id); });
    }

    /* ----------  Resize handles  ---------- */
    _bindResize() {
      if (!this.resizable) return;
      const self = this;
      this.el.querySelectorAll(".window-resize").forEach((handle) => {
        handle.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          if (self.maximized) return;
          e.preventDefault();
          e.stopPropagation();
          focusWindow(self.id);

          const dir = handle.dataset.dir;
          const startX = e.clientX, startY = e.clientY;
          const origX = self.x, origY = self.y;
          const origW = self.width, origH = self.height;
          self.el.classList.add("resizing");
          handle.setPointerCapture(e.pointerId);

          const onMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let nx = origX, ny = origY, nw = origW, nh = origH;

            if (dir.includes("e")) nw = Math.max(self.minWidth, origW + dx);
            if (dir.includes("s")) nh = Math.max(self.minHeight, origH + dy);
            if (dir.includes("w")) {
              nw = Math.max(self.minWidth, origW - dx);
              nx = origX + (origW - nw);
            }
            if (dir.includes("n")) {
              nh = Math.max(self.minHeight, origH - dy);
              ny = origY + (origH - nh);
            }

            const vp = viewport();
            nx = clamp(nx, -nw + 80, vp.w - 80);
            ny = clamp(ny, 0, vp.h - 32);

            self.x = nx; self.y = ny;
            self.width = nw; self.height = nh;
            self.applyRect();
            emit("windowresize", { id: self.id, w: nw, h: nh });
            if (typeof self.onResize === "function") {
              try { self.onResize(self, nw, nh); } catch (er) { console.error(er); }
            }
          };

          const onUp = (ev) => {
            self.el.classList.remove("resizing");
            try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup",   onUp);
          };

          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup",   onUp);
        });
      });
    }

    /* ----------  Click-to-focus  ---------- */
    _bindFocus() {
      this.el.addEventListener("pointerdown", () => focusWindow(this.id), true);
    }

    /* ----------  Apply geometry to DOM  ---------- */
    applyRect() {
      if (!this.el) return;
      this.el.style.left   = this.x + "px";
      this.el.style.top    = this.y + "px";
      this.el.style.width  = this.width + "px";
      this.el.style.height = this.height + "px";
    }

    /* ----------  Update title / icon  ---------- */
    setTitle(t) {
      this.title = t || "";
      if (this.titleEl) this.titleEl.textContent = this.title;
      emit("windowtitle", { id: this.id, title: this.title });
    }

    setIcon(i) {
      this.icon = i || "▦";
      if (this.iconEl) this.iconEl.textContent = this.icon;
    }

    setBadge(text) {
      if (!this.titleEl) return;
      let badge = this.titleEl.querySelector(".w-badge");
      if (!text) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "w-badge";
        badge.style.cssText = "display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:var(--accent-1);color:#fff;font-size:10px;";
        this.titleEl.appendChild(badge);
      }
      badge.textContent = text;
    }
  }

  /* --------------------------------------------------------------------------
   * Snap preview overlay
   * ------------------------------------------------------------------------*/
  function ensureSnapPreview() {
    if (state.snapPreview) return state.snapPreview;
    const el = document.createElement("div");
    el.className = "snap-preview";
    el.hidden = true;
    document.body.appendChild(el);
    state.snapPreview = el;
    return el;
  }

  function computeSnapRegion(x, y) {
    const vp = viewport();
    if (y <= SNAP_THRESHOLD) {
      // Top corners or top
      if (x <= SNAP_CORNER_MIN) return SNAP_REGIONS.TL;
      if (x >= vp.w - SNAP_CORNER_MIN) return SNAP_REGIONS.TR;
      return SNAP_REGIONS.TOP;
    }
    if (y >= vp.h - SNAP_THRESHOLD) {
      if (x <= SNAP_CORNER_MIN) return SNAP_REGIONS.BL;
      if (x >= vp.w - SNAP_CORNER_MIN) return SNAP_REGIONS.BR;
      // bottom-edge full doesn't snap; ignore
      return SNAP_REGIONS.NONE;
    }
    if (x <= SNAP_THRESHOLD)         return SNAP_REGIONS.LEFT;
    if (x >= vp.w - SNAP_THRESHOLD)  return SNAP_REGIONS.RIGHT;
    return SNAP_REGIONS.NONE;
  }

  function rectForRegion(region) {
    const vp = viewport();
    const halfW = Math.floor(vp.w / 2);
    const halfH = Math.floor(vp.h / 2);
    switch (region) {
      case SNAP_REGIONS.LEFT:  return { x: 0,        y: 0,     w: halfW, h: vp.h };
      case SNAP_REGIONS.RIGHT: return { x: halfW,    y: 0,     w: vp.w - halfW, h: vp.h };
      case SNAP_REGIONS.TOP:   return { x: 0,        y: 0,     w: vp.w, h: vp.h }; // maximize
      case SNAP_REGIONS.TL:    return { x: 0,        y: 0,     w: halfW, h: halfH };
      case SNAP_REGIONS.TR:    return { x: halfW,    y: 0,     w: vp.w - halfW, h: halfH };
      case SNAP_REGIONS.BL:    return { x: 0,        y: halfH, w: halfW, h: vp.h - halfH };
      case SNAP_REGIONS.BR:    return { x: halfW,    y: halfH, w: vp.w - halfW, h: vp.h - halfH };
      default: return null;
    }
  }

  function updateSnapPreview(x, y) {
    const region = computeSnapRegion(x, y);
    if (region === SNAP_REGIONS.NONE) {
      hideSnapPreview();
      return;
    }
    const rect = rectForRegion(region);
    if (!rect) { hideSnapPreview(); return; }
    const el = ensureSnapPreview();
    el.hidden = false;
    el.style.left = rect.x + "px";
    el.style.top  = rect.y + "px";
    el.style.width  = rect.w + "px";
    el.style.height = rect.h + "px";
  }

  function hideSnapPreview() {
    if (state.snapPreview) state.snapPreview.hidden = true;
  }

  function snapTo(id, region) {
    const win = state.windows.get(id);
    if (!win) return;
    if (region === SNAP_REGIONS.TOP) { maximizeWindow(id); return; }
    const rect = rectForRegion(region);
    if (!rect) return;
    if (!win.prev) {
      win.prev = { x: win.x, y: win.y, w: win.width, h: win.height };
    }
    win.x = rect.x;
    win.y = rect.y;
    win.width = rect.w;
    win.height = rect.h;
    win.snapped = region;
    win.maximized = false;
    win.applyRect();
    emit("windowsnap", { id, region });
  }

  /* --------------------------------------------------------------------------
   * Window context menu (titlebar right-click)
   * ------------------------------------------------------------------------*/
  function showWindowContextMenu(win, x, y) {
    const menu = document.getElementById("window-context-menu");
    if (!menu) return;
    menu.hidden = false;
    // Position
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = menu.offsetWidth || 200, h = menu.offsetHeight || 160;
    menu.style.left = clamp(x, 4, vw - w - 4) + "px";
    menu.style.top  = clamp(y, 4, vh - h - 4) + "px";

    function close() { menu.hidden = true; document.removeEventListener("pointerdown", onDoc, true); }
    function onDoc(e) { if (!menu.contains(e.target)) close(); }
    setTimeout(() => document.addEventListener("pointerdown", onDoc, true), 0);

    menu.querySelectorAll(".context-item").forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        const action = item.dataset.action;
        switch (action) {
          case "minimize": minimizeWindow(win.id); break;
          case "maximize": maximizeWindow(win.id); break;
          case "restore":  unmaximize(win.id); break;
          case "close":    closeWindow(win.id); break;
        }
        close();
      };
    });
  }

  /* --------------------------------------------------------------------------
   * Public — open / create
   * ------------------------------------------------------------------------*/
  function openApp(appId, opts) {
    const def = state.apps.get(appId);
    if (!def) {
      console.warn("[WindowManager] Unknown app:", appId);
      return null;
    }
    if (def.singleton) {
      const existing = Array.from(state.windows.values()).find((w) => w.appId === appId);
      if (existing) {
        if (existing.minimized) restoreWindow(existing.id);
        else focusWindow(existing.id);
        return existing;
      }
    }
    const o = Object.assign({}, def, opts || {});
    o.appId = appId;
    return openWindow(o);
  }

  function openWindow(opts) {
    ensureRoot();
    const win = new WebOSWindow(opts || {});
    state.windows.set(win.id, win);
    win.mount(state.root);
    state.order.push(win.id);
    bumpZ(win);
    emit("windowopen", { id: win.id, appId: win.appId, title: win.title });
    return win;
  }

  /* --------------------------------------------------------------------------
   * Public — close
   * ------------------------------------------------------------------------*/
  function closeWindow(id) {
    const win = state.windows.get(id);
    if (!win) return false;
    if (typeof win.onClose === "function") {
      try {
        const r = win.onClose(win);
        if (r === false) return false; // cancel
      } catch (e) { console.error(e); }
    }
    if (win.el) {
      win.el.classList.add("closing");
      const remove = () => {
        try { win.el.remove(); } catch (_) {}
        state.windows.delete(id);
        state.order = state.order.filter((wid) => wid !== id);
        if (state.focused === id) state.focused = null;
        emit("windowclose", { id, appId: win.appId });
        // focus next topmost
        const top = state.order[state.order.length - 1];
        if (top) focusWindow(top);
      };
      win.el.addEventListener("animationend", remove, { once: true });
      // Safety fallback
      setTimeout(() => { if (state.windows.has(id)) remove(); }, 400);
    } else {
      state.windows.delete(id);
      state.order = state.order.filter((wid) => wid !== id);
      emit("windowclose", { id, appId: win.appId });
    }
    return true;
  }

  function closeAll() {
    Array.from(state.windows.keys()).forEach(closeWindow);
  }

  /* --------------------------------------------------------------------------
   * Public — focus / z-order
   * ------------------------------------------------------------------------*/
  function bumpZ(win) {
    state.nextZ += Z_STEP;
    win.zIndex = state.nextZ;
    if (win.el) win.el.style.zIndex = win.zIndex;
  }

  function focusWindow(id) {
    const win = state.windows.get(id);
    if (!win) return false;
    if (win.minimized) restoreWindow(id);
    // Move to top of order
    state.order = state.order.filter((wid) => wid !== id);
    state.order.push(id);
    bumpZ(win);
    state.windows.forEach((w) => w.el && w.el.classList.toggle("focused", w.id === id));
    state.focused = id;
    if (typeof win.onFocus === "function") {
      try { win.onFocus(win); } catch (e) { console.error(e); }
    }
    emit("windowfocus", { id, appId: win.appId });
    return true;
  }

  function getFocused() {
    return state.focused ? state.windows.get(state.focused) : null;
  }

  /* --------------------------------------------------------------------------
   * Public — minimize / restore
   * ------------------------------------------------------------------------*/
  function minimizeWindow(id) {
    const win = state.windows.get(id);
    if (!win || win.minimized) return false;
    win.minimized = true;
    if (win.el) {
      win.el.classList.remove("restoring");
      win.el.classList.add("minimizing");
      const after = () => {
        win.el.style.display = "none";
        win.el.classList.remove("minimizing");
      };
      win.el.addEventListener("animationend", after, { once: true });
      setTimeout(after, 320);
    }
    if (state.focused === id) {
      state.focused = null;
      // focus next topmost not minimized
      for (let i = state.order.length - 1; i >= 0; i--) {
        const wid = state.order[i];
        if (wid === id) continue;
        const w = state.windows.get(wid);
        if (w && !w.minimized) { focusWindow(wid); break; }
      }
    }
    emit("windowminimize", { id, appId: win.appId });
    return true;
  }

  function restoreWindow(id) {
    const win = state.windows.get(id);
    if (!win) return false;
    if (!win.minimized) { focusWindow(id); return true; }
    win.minimized = false;
    if (win.el) {
      win.el.style.display = "";
      win.el.classList.add("restoring");
      const after = () => win.el.classList.remove("restoring");
      win.el.addEventListener("animationend", after, { once: true });
      setTimeout(after, 320);
    }
    focusWindow(id);
    emit("windowrestore", { id, appId: win.appId });
    return true;
  }

  function toggleMinimized(id) {
    const win = state.windows.get(id);
    if (!win) return;
    if (win.minimized) restoreWindow(id);
    else if (state.focused === id) minimizeWindow(id);
    else focusWindow(id);
  }

  /* --------------------------------------------------------------------------
   * Public — maximize / restore
   * ------------------------------------------------------------------------*/
  function maximizeWindow(id) {
    const win = state.windows.get(id);
    if (!win || !win.maximizable) return false;
    if (win.maximized) return true;
    win.prev = { x: win.x, y: win.y, w: win.width, h: win.height };
    const vp = viewport();
    win.x = 0; win.y = 0;
    win.width = vp.w; win.height = vp.h;
    win.maximized = true;
    win.snapped = SNAP_REGIONS.NONE;
    if (win.el) {
      win.el.classList.add("maximized");
      win.applyRect();
    }
    emit("windowmaximize", { id, appId: win.appId });
    return true;
  }

  function unmaximize(id, silent) {
    const win = state.windows.get(id);
    if (!win) return false;
    if (!win.maximized && win.snapped === SNAP_REGIONS.NONE) return false;
    if (win.prev) {
      win.x = win.prev.x;
      win.y = win.prev.y;
      win.width = win.prev.w;
      win.height = win.prev.h;
    }
    win.maximized = false;
    win.snapped = SNAP_REGIONS.NONE;
    if (win.el) {
      win.el.classList.remove("maximized");
      win.applyRect();
    }
    if (!silent) emit("windowrestore", { id, appId: win.appId });
    return true;
  }

  function toggleMaximize(id) {
    const win = state.windows.get(id);
    if (!win) return;
    if (win.maximized || win.snapped !== SNAP_REGIONS.NONE) unmaximize(id);
    else maximizeWindow(id);
  }

  /* --------------------------------------------------------------------------
   * Public — show desktop / minimize all
   * ------------------------------------------------------------------------*/
  function minimizeAll() {
    state.windows.forEach((w) => { if (!w.minimized) minimizeWindow(w.id); });
  }

  function restoreAll() {
    state.windows.forEach((w) => { if (w.minimized) restoreWindow(w.id); });
  }

  function toggleShowDesktop() {
    const anyVisible = Array.from(state.windows.values()).some((w) => !w.minimized);
    if (anyVisible) minimizeAll();
    else restoreAll();
  }

  /* --------------------------------------------------------------------------
   * Public — list / get
   * ------------------------------------------------------------------------*/
  function listWindows() { return Array.from(state.windows.values()); }
  function getWindow(id)  { return state.windows.get(id); }
  function exists(id)     { return state.windows.has(id); }

  /* --------------------------------------------------------------------------
   * Keyboard shortcuts
   * ------------------------------------------------------------------------*/
  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      // Alt+Tab: cycle windows
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        cycleFocus(!e.shiftKey ? 1 : -1);
        return;
      }
      // Ctrl+W close focused
      if (e.ctrlKey && (e.key === "w" || e.key === "W") && state.focused) {
        e.preventDefault();
        closeWindow(state.focused);
        return;
      }
      // Win key shortcuts (meta)
      if ((e.metaKey || e.key === "Meta") && state.focused) {
        if (e.key === "ArrowUp")    { e.preventDefault(); maximizeWindow(state.focused); return; }
        if (e.key === "ArrowDown")  { e.preventDefault(); minimizeWindow(state.focused); return; }
        if (e.key === "ArrowLeft")  { e.preventDefault(); snapTo(state.focused, SNAP_REGIONS.LEFT); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); snapTo(state.focused, SNAP_REGIONS.RIGHT); return; }
      }
      if (e.key === "F11" && state.focused) {
        e.preventDefault();
        toggleMaximize(state.focused);
      }
    });
  }

  function cycleFocus(dir) {
    if (state.order.length === 0) return;
    const cur = state.focused;
    const visible = state.order.filter((id) => {
      const w = state.windows.get(id); return w && !w.minimized;
    });
    if (visible.length === 0) {
      // restore latest
      const last = state.order[state.order.length - 1];
      if (last) restoreWindow(last);
      return;
    }
    const i = visible.indexOf(cur);
    const next = visible[(i + dir + visible.length) % visible.length];
    focusWindow(next);
  }

  /* --------------------------------------------------------------------------
   * Window state on viewport resize: keep windows in bounds
   * ------------------------------------------------------------------------*/
  function bindResize() {
    let raf = null;
    window.addEventListener("resize", () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const vp = viewport();
        state.windows.forEach((w) => {
          if (w.maximized) {
            w.width = vp.w; w.height = vp.h; w.applyRect();
            return;
          }
          if (w.snapped !== SNAP_REGIONS.NONE) {
            const r = rectForRegion(w.snapped);
            if (r) {
              w.x = r.x; w.y = r.y; w.width = r.w; w.height = r.h; w.applyRect();
            }
            return;
          }
          // Clamp normal windows
          w.x = clamp(w.x, -w.width + 80, vp.w - 80);
          w.y = clamp(w.y, 0, vp.h - 32);
          w.applyRect();
        });
      });
    });
  }

  /* --------------------------------------------------------------------------
   * Built-in default apps (registered for convenience)
   * ------------------------------------------------------------------------*/
  function registerBuiltIns() {
    registerApp({
      id: "about",
      title: "About WebOS",
      icon: "ⓘ",
      width: 460, height: 360,
      singleton: true,
      category: "System",
      pinned: true,
      render(body) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px;">
            <div style="font-size:48px;">🪐</div>
            <h2 style="margin:0;background:var(--grad-accent);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">WebOS</h2>
            <div style="opacity:.75">v1.0.0 “Aurora”</div>
            <p style="text-align:center;max-width:340px;opacity:.85;">
              A fully functional desktop operating system that runs entirely in
              your browser. Drag, resize, snap, and theme to your heart's content.
            </p>
            <div class="app-section" style="width:100%;">
              <h4>Hotkeys</h4>
              <div class="app-row"><kbd>Alt</kbd>+<kbd>Tab</kbd> — Cycle windows</div>
              <div class="app-row"><kbd>Win</kbd>+<kbd>↑</kbd> — Maximize · <kbd>↓</kbd> — Minimize</div>
              <div class="app-row"><kbd>Win</kbd>+<kbd>←</kbd>/<kbd>→</kbd> — Snap left/right</div>
              <div class="app-row"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> — Cycle theme</div>
              <div class="app-row"><kbd>F11</kbd> — Toggle maximize</div>
            </div>
          </div>
        `;
      }
    });

    registerApp({
      id: "settings",
      title: "Settings",
      icon: "⚙",
      width: 560, height: 460,
      singleton: true,
      category: "System",
      pinned: true,
      render(body) {
        const themes = ["dark","light","cyberpunk","retro","forest"];
        const wallpapers = ["aurora","nebula","mountain","grid","solid"];
        body.innerHTML = `
          <div class="app-section">
            <h4>Theme</h4>
            <div class="app-row" style="flex-wrap:wrap;gap:6px;">
              ${themes.map((t) => `<button class="app-btn" data-theme="${t}">${t}</button>`).join("")}
            </div>
          </div>
          <div class="app-section">
            <h4>Wallpaper</h4>
            <div class="app-row" style="flex-wrap:wrap;gap:6px;">
              ${wallpapers.map((w) => `<button class="app-btn" data-wallpaper="${w}">${w}</button>`).join("")}
            </div>
          </div>
          <div class="app-section">
            <h4>Animations</h4>
            <div class="app-row">
              <label><input type="checkbox" id="set-anim" ${window.ThemeEngine.getAnimations() ? "checked" : ""}> Enable smooth animations</label>
            </div>
          </div>
          <div class="app-section">
            <h4>Reset</h4>
            <button class="app-btn primary" id="set-reset">Restore defaults</button>
          </div>
        `;
        body.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => window.ThemeEngine.setTheme(b.dataset.theme)));
        body.querySelectorAll("[data-wallpaper]").forEach((b) => b.addEventListener("click", () => window.ThemeEngine.setWallpaper(b.dataset.wallpaper)));
        body.querySelector("#set-anim").addEventListener("change", (e) => window.ThemeEngine.setAnimations(e.target.checked));
        body.querySelector("#set-reset").addEventListener("click", () => window.ThemeEngine.reset());
      }
    });

    registerApp({
      id: "notepad",
      title: "Notepad",
      icon: "📝",
      width: 560, height: 420,
      category: "Productivity",
      pinned: true,
      render(body, win) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%;gap:8px;">
            <div class="app-row" style="margin:0;">
              <button class="app-btn" data-act="new">New</button>
              <button class="app-btn" data-act="save">Save</button>
              <button class="app-btn" data-act="clear">Clear</button>
              <span style="margin-left:auto;opacity:.7;font-size:12px;" id="np-stats">0 chars</span>
            </div>
            <textarea class="app-textarea" style="flex:1;" placeholder="Start typing…"></textarea>
          </div>
        `;
        const ta = body.querySelector("textarea");
        const stats = body.querySelector("#np-stats");
        const KEY = "webos.notepad." + (win.opts.docId || "default");
        try { ta.value = localStorage.getItem(KEY) || ""; } catch (_) {}
        const update = () => stats.textContent = ta.value.length + " chars · " + ta.value.split(/\s+/).filter(Boolean).length + " words";
        ta.addEventListener("input", update); update();
        body.querySelector('[data-act="new"]').addEventListener("click", () => { ta.value = ""; update(); });
        body.querySelector('[data-act="save"]').addEventListener("click", () => { try { localStorage.setItem(KEY, ta.value); } catch (_) {} });
        body.querySelector('[data-act="clear"]').addEventListener("click", () => { ta.value = ""; update(); });
      }
    });

    registerApp({
      id: "calculator",
      title: "Calculator",
      icon: "🧮",
      width: 280, height: 380,
      resizable: false,
      category: "Productivity",
      pinned: true,
      render(body) {
        const keys = [
          "C","±","%","÷",
          "7","8","9","×",
          "4","5","6","−",
          "1","2","3","+",
          "0",".","=",
        ];
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%;gap:8px;">
            <div id="calc-screen" style="flex:0 0 auto;text-align:right;font-family:var(--font-mono);font-size:28px;padding:12px;background:var(--hover-bg);border-radius:var(--r-md);">0</div>
            <div id="calc-keys" style="flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
              ${keys.map((k) => `<button class="app-btn ${k==="="?"primary":""}" data-k="${k}" style="${k==="0"?"grid-column:span 2;":""}">${k}</button>`).join("")}
            </div>
          </div>
        `;
        const screen = body.querySelector("#calc-screen");
        let cur = "0", prev = null, op = null, reset = false;
        const ops = { "÷":"/", "×":"*", "−":"-", "+":"+" };
        function setScreen(s) { cur = s; screen.textContent = s; }
        body.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => {
          const k = b.dataset.k;
          if (k === "C") { setScreen("0"); prev=null; op=null; reset=false; return; }
          if (k === "±") { setScreen(String(parseFloat(cur)*-1)); return; }
          if (k === "%") { setScreen(String(parseFloat(cur)/100)); return; }
          if (ops[k]) { prev = parseFloat(cur); op = ops[k]; reset = true; return; }
          if (k === "=") {
            if (prev != null && op) {
              try {
                const r = Function(`"use strict";return (${prev}${op}${parseFloat(cur)})`)();
                setScreen(String(r));
              } catch (_) { setScreen("Err"); }
              prev = null; op = null; reset = true;
            }
            return;
          }
          if (k === ".") { if (!cur.includes(".")) setScreen(cur + "."); return; }
          if (reset) { setScreen(k); reset = false; }
          else setScreen(cur === "0" ? k : cur + k);
        }));
      }
    });

    // NOTE: The real File Manager registers itself in js/fileManager.js with
    // the id "filemanager" (and a thin alias under the legacy id "files").
    // Here we only register a minimal placeholder so a click before fileManager.js
    // has finished loading still produces a polite "loading…" window. As soon as
    // fileManager.js calls unregisterApp("filemanager") and registers the real
    // app, this stub is replaced.
    registerApp({
      id: "filemanager",
      title: "File Manager",
      icon: "📁",
      width: 900, height: 580,
      category: "System",
      pinned: true,
      render(body) {
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100%;
                      flex-direction:column;gap:8px;color:var(--fg-2);font-size:13px;">
            <div style="font-size:40px;">📁</div>
            <div>Loading File Manager…</div>
          </div>`;
      }
    });
    // legacy id alias — kept so any old desktop icons keep working
    registerApp({
      id: "files",
      title: "File Manager",
      icon: "📁",
      hidden: true,
      render(body) {
        body.innerHTML = `<div style="padding:20px;">Use "filemanager" instead.</div>`;
      }
    });

    registerApp({
      id: "browser",
      title: "Browser",
      icon: "🌐",
      width: 800, height: 540,
      category: "Internet",
      pinned: true,
      render(body) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%;">
            <div class="window-toolbar">
              <button class="tb-btn">←</button>
              <button class="tb-btn">→</button>
              <button class="tb-btn">⟳</button>
              <input class="app-input" style="flex:1;" placeholder="Search or enter URL" value="https://webos.local/welcome" />
              <button class="tb-btn">⭐</button>
            </div>
            <div style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--fg-2);">
              <div style="font-size:48px;">🌐</div>
              <h2 style="margin:0;">WebOS Browser</h2>
              <p style="max-width:380px;text-align:center;">A simulated browser shell — wire up your own engine here.</p>
            </div>
          </div>
        `;
      }
    });

    registerApp({
      id: "terminal",
      title: "Terminal",
      icon: "⌨",
      width: 640, height: 380,
      category: "Developer",
      pinned: true,
      render(body) {
        body.innerHTML = `
          <div style="height:100%;font-family:var(--font-mono);font-size:13px;color:#9cffae;background:#000;padding:10px;overflow:auto;border-radius:var(--r-md);">
            <div>WebOS Terminal v1.0 — type 'help'</div>
            <div id="term-out"></div>
            <div style="display:flex;gap:6px;align-items:center;">
              <span style="color:#67e8f9;">user@webos:~$</span>
              <input id="term-in" style="flex:1;background:transparent;border:none;color:#9cffae;outline:none;" autofocus />
            </div>
          </div>
        `;
        const out = body.querySelector("#term-out");
        const inp = body.querySelector("#term-in");
        const cmds = {
          help: () => "Available: help, about, theme [name], clear, date, echo [text], whoami, ls, exit",
          about: () => "WebOS v1.0.0 — running entirely in your browser.",
          whoami: () => "user",
          date: () => new Date().toString(),
          ls: () => "Desktop  Documents  Downloads  Pictures  Music  Videos",
          theme: (a) => { if (a) { window.ThemeEngine.setTheme(a); return "theme -> " + a; } return "current: " + window.ThemeEngine.getTheme(); },
          echo: (...a) => a.join(" "),
          clear: () => { out.innerHTML = ""; return ""; },
        };
        inp.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          const line = inp.value.trim();
          inp.value = "";
          if (!line) return;
          const [cmd, ...args] = line.split(/\s+/);
          let res = "";
          if (cmds[cmd]) {
            try { res = cmds[cmd].apply(null, args) || ""; } catch (er) { res = String(er); }
          } else {
            res = "command not found: " + cmd;
          }
          const line1 = document.createElement("div"); line1.innerHTML = `<span style="color:#67e8f9;">user@webos:~$</span> ${escapeHtml(line)}`;
          out.appendChild(line1);
          if (res) {
            const r = document.createElement("div"); r.textContent = res; out.appendChild(r);
          }
          out.parentElement.scrollTop = 99999;
        });
      }
    });

    registerApp({
      id: "clock",
      title: "Clock",
      icon: "🕒",
      width: 320, height: 380,
      resizable: false,
      category: "Utilities",
      render(body) {
        body.innerHTML = `<div id="clock-app" style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
          <div id="clk-time" style="font-family:var(--font-mono);font-size:48px;font-weight:700;background:var(--grad-accent);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">--:--:--</div>
          <div id="clk-date" style="opacity:.75;"></div>
        </div>`;
        const t = body.querySelector("#clk-time");
        const d = body.querySelector("#clk-date");
        function tick() {
          const now = new Date();
          t.textContent = now.toTimeString().slice(0,8);
          d.textContent = now.toDateString();
        }
        tick();
        const i = setInterval(tick, 1000);
        // cleanup hook (close)
      }
    });

    registerApp({
      id: "paint",
      title: "Paint",
      icon: "🎨",
      width: 640, height: 480,
      category: "Creative",
      render(body) {
        body.innerHTML = `
          <div style="display:flex;flex-direction:column;height:100%;gap:6px;">
            <div class="window-toolbar">
              <input type="color" id="pc" value="#7c3aed" />
              <input type="range" id="pw" min="1" max="40" value="6" />
              <button class="tb-btn" data-act="clear">Clear</button>
            </div>
            <canvas id="pcv" style="flex:1;background:#fff;border-radius:var(--r-sm);cursor:crosshair;"></canvas>
          </div>
        `;
        const cv = body.querySelector("#pcv");
        const ctx = cv.getContext("2d");
        const resize = () => { cv.width = cv.clientWidth; cv.height = cv.clientHeight; };
        requestAnimationFrame(resize);
        let drawing = false, last = null;
        cv.addEventListener("pointerdown", (e) => { drawing = true; last = { x: e.offsetX, y: e.offsetY }; });
        cv.addEventListener("pointermove", (e) => {
          if (!drawing) return;
          ctx.strokeStyle = body.querySelector("#pc").value;
          ctx.lineWidth = parseInt(body.querySelector("#pw").value, 10);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(e.offsetX, e.offsetY);
          ctx.stroke();
          last = { x: e.offsetX, y: e.offsetY };
        });
        window.addEventListener("pointerup", () => drawing = false);
        body.querySelector('[data-act="clear"]').addEventListener("click", () => ctx.clearRect(0,0,cv.width,cv.height));
        window.addEventListener("resize", resize);
      }
    });
  }

  /* --------------------------------------------------------------------------
   * Initialize
   * ------------------------------------------------------------------------*/
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureRoot();
    bindKeyboard();
    bindResize();
    registerBuiltIns();
    console.log("%c[WebOS]%c WindowManager ready (apps: %d)",
      "color:#06b6d4;font-weight:bold","color:inherit", state.apps.size);
    emit("wmready", {});
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.WindowManager = {
    init,
    // app registry
    registerApp, unregisterApp, getApps, getApp,
    // window lifecycle
    openApp, openWindow, closeWindow, closeAll,
    focusWindow, getFocused,
    minimizeWindow, restoreWindow, toggleMinimized,
    maximizeWindow, unmaximize, toggleMaximize,
    minimizeAll, restoreAll, toggleShowDesktop,
    snapTo,
    // queries
    listWindows, getWindow, exists,
    // constants
    SNAP_REGIONS,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
