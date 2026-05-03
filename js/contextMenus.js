/* ============================================================================
 * WebOS — contextMenus.js
 * ----------------------------------------------------------------------------
 * Global context-menu system.
 *
 *   ContextMenu.show({
 *     x, y,                       // viewport coordinates
 *     items: [                    // tree of MenuItem entries
 *       { label, icon, action, accelerator, disabled, separator,
 *         children: [...]  },
 *     ],
 *     target,                     // optional: anchor element or { x, y }
 *     onClose,                    // callback after the menu fully closes
 *   })
 *
 * The system is 100% self-contained: it manages its own DOM, key navigation,
 * sub-menu opening, click-outside-to-dismiss and auto-positioning so the menu
 * never overflows the viewport.
 *
 * Convenience builders are exposed for the common scenarios used elsewhere
 * in WebOS:
 *   - ContextMenu.forDesktop(detail)
 *   - ContextMenu.forFile(path, detail)
 *   - ContextMenu.forFolder(path, detail)
 *   - ContextMenu.forTaskbar(detail)
 *   - ContextMenu.forWindowTitlebar(winId, detail)
 *
 * Public API on  window.ContextMenu
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------------*/
  const ROOT_ID    = "__webos_ctx_root__";
  const Z_INDEX    = 99999;
  const SUB_OFFSET = 2;       // px gap between menu and submenu
  const EDGE_PAD   = 6;       // viewport padding when auto-positioning

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    rootEl:     null,    // the topmost open menu element
    onCloseCb:  null,
    initialized: false,
    suppressedAt: 0,     // small dedupe so we don't reopen on the same event
    keyHandler:  null,
    outsideHandler: null,
    resizeHandler: null,
  };

  /* --------------------------------------------------------------------------
   * Utilities
   * ------------------------------------------------------------------------*/
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function viewport() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function ensureStyles() {
    if (document.getElementById("__webos_ctx_styles__")) return;
    const css = `
      .webos-ctx {
        position: fixed; min-width: 220px; max-width: 320px;
        background: var(--window-bg, rgba(20,24,40,.9));
        border: 1px solid var(--window-border, rgba(255,255,255,.08));
        border-radius: var(--r-sm, 8px);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        box-shadow: 0 16px 36px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.30);
        padding: 6px;
        font: 13px/1.45 var(--font, "Inter", system-ui, sans-serif);
        color: var(--fg-0, #f5f7ff);
        z-index: ${Z_INDEX};
        user-select: none;
        animation: webosCtxIn .12s ease-out;
      }
      @keyframes webosCtxIn {
        from { opacity: 0; transform: scale(.96) translateY(-2px); }
        to   { opacity: 1; transform: none; }
      }
      .webos-ctx-item {
        display: flex; align-items: center; gap: 10px;
        padding: 7px 10px; border-radius: var(--r-xs, 4px);
        cursor: default; white-space: nowrap; position: relative;
      }
      .webos-ctx-item.is-disabled {
        opacity: .42; cursor: not-allowed;
      }
      .webos-ctx-item.is-active,
      .webos-ctx-item:not(.is-disabled):hover {
        background: var(--active-bg, rgba(255,255,255,.10));
      }
      .webos-ctx-item .ctx-ico {
        width: 18px; text-align: center; font-size: 14px;
        flex-shrink: 0; opacity: .9;
      }
      .webos-ctx-item .ctx-label {
        flex: 1; overflow: hidden; text-overflow: ellipsis;
      }
      .webos-ctx-item .ctx-accel {
        opacity: .55; font-size: 11px; padding-left: 12px;
      }
      .webos-ctx-item .ctx-arrow {
        opacity: .7; font-size: 11px; padding-left: 8px;
      }
      .webos-ctx-sep {
        height: 1px; margin: 5px 4px;
        background: var(--window-border, rgba(255,255,255,.10));
      }
      .webos-ctx-header {
        padding: 4px 10px 6px; font-size: 11px; opacity: .55;
        text-transform: uppercase; letter-spacing: .08em;
      }
      .webos-ctx-item.is-danger { color: #fb7185; }
      .webos-ctx-item.is-checked .ctx-ico::before { content: "✓"; }
    `;
    const tag = document.createElement("style");
    tag.id = "__webos_ctx_styles__";
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* --------------------------------------------------------------------------
   * MenuItem normalization
   * ------------------------------------------------------------------------*/
  function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      if (!raw || raw === false) continue;
      if (raw === "---" || raw.separator) {
        out.push({ separator: true });
        continue;
      }
      if (raw.header) {
        out.push({ header: String(raw.header) });
        continue;
      }
      const item = {
        label:    raw.label != null ? String(raw.label) : "",
        icon:     raw.icon != null  ? String(raw.icon)  : "",
        action:   typeof raw.action === "function" ? raw.action : null,
        disabled: !!raw.disabled,
        danger:   !!raw.danger,
        checked:  !!raw.checked,
        accelerator: raw.accelerator || raw.shortcut || "",
        children: Array.isArray(raw.children) ? normalizeItems(raw.children) : null,
        // free-form extras pass through
        data:     raw.data || null,
      };
      out.push(item);
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * Rendering
   * ------------------------------------------------------------------------*/
  function buildMenu(items) {
    const menu = document.createElement("div");
    menu.className = "webos-ctx";
    menu.setAttribute("role", "menu");
    menu.tabIndex = -1;

    items.forEach((item, idx) => {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "webos-ctx-sep";
        menu.appendChild(sep);
        return;
      }
      if (item.header) {
        const h = document.createElement("div");
        h.className = "webos-ctx-header";
        h.textContent = item.header;
        menu.appendChild(h);
        return;
      }
      const el = document.createElement("div");
      el.className = "webos-ctx-item";
      el.setAttribute("role", "menuitem");
      el.dataset.idx = String(idx);
      if (item.disabled) el.classList.add("is-disabled");
      if (item.danger)   el.classList.add("is-danger");
      if (item.checked)  el.classList.add("is-checked");

      const icon = document.createElement("span");
      icon.className = "ctx-ico";
      icon.textContent = item.icon || "";
      el.appendChild(icon);

      const lab = document.createElement("span");
      lab.className = "ctx-label";
      lab.textContent = item.label;
      el.appendChild(lab);

      if (item.children && item.children.length) {
        const arr = document.createElement("span");
        arr.className = "ctx-arrow";
        arr.textContent = "›";
        el.appendChild(arr);
      } else if (item.accelerator) {
        const ac = document.createElement("span");
        ac.className = "ctx-accel";
        ac.textContent = item.accelerator;
        el.appendChild(ac);
      }

      // pointer interactions
      el.addEventListener("pointerenter", () => {
        // mark as active and open submenu (if any) on hover
        Array.from(menu.children).forEach((c) => c.classList && c.classList.remove("is-active"));
        el.classList.add("is-active");
        closeChildOf(menu);
        if (!item.disabled && item.children && item.children.length) {
          openSubmenu(menu, el, item.children);
        }
      });
      el.addEventListener("pointerleave", () => {
        // keep .is-active until pointer enters another item
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        if (item.children && item.children.length) {
          openSubmenu(menu, el, item.children);
          return;
        }
        invokeAndClose(item);
      });
      menu.appendChild(el);
    });
    return menu;
  }

  function openSubmenu(parentMenu, anchorEl, children) {
    closeChildOf(parentMenu);
    const sub = buildMenu(children);
    sub.dataset.parent = "1";
    document.body.appendChild(sub);
    parentMenu._child = sub;
    sub._parent = parentMenu;

    // Position: to the right of anchor, fall back to left if no room.
    const rect = anchorEl.getBoundingClientRect();
    const mw   = sub.offsetWidth;
    const mh   = sub.offsetHeight;
    const vp   = viewport();
    let x = rect.right + SUB_OFFSET;
    let y = rect.top - 4;
    if (x + mw > vp.w - EDGE_PAD) x = rect.left - mw - SUB_OFFSET;
    y = clamp(y, EDGE_PAD, vp.h - mh - EDGE_PAD);
    x = clamp(x, EDGE_PAD, vp.w - mw - EDGE_PAD);
    sub.style.left = x + "px";
    sub.style.top  = y + "px";
  }

  function closeChildOf(menu) {
    const c = menu._child;
    if (!c) return;
    closeChildOf(c);   // recursively
    try { c.remove(); } catch (_) {}
    menu._child = null;
  }

  function invokeAndClose(item) {
    closeAll();
    if (typeof item.action === "function") {
      try { item.action(item); }
      catch (e) { console.error("[ContextMenu] action threw:", e); }
    }
  }

  /* --------------------------------------------------------------------------
   * Show / close
   * ------------------------------------------------------------------------*/
  function show(opts) {
    ensureStyles();
    closeAll();
    const items = normalizeItems(opts && opts.items);
    if (!items.length) return null;

    const menu = buildMenu(items);
    document.body.appendChild(menu);
    state.rootEl    = menu;
    state.onCloseCb = (opts && typeof opts.onClose === "function") ? opts.onClose : null;

    // Position the root menu intelligently
    const vp = viewport();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = (opts && opts.x != null) ? opts.x : Math.round(vp.w / 2);
    let y = (opts && opts.y != null) ? opts.y : Math.round(vp.h / 2);
    if (opts && opts.target) {
      const t = opts.target;
      if (t instanceof Element) {
        const r = t.getBoundingClientRect();
        x = r.left;
        y = r.bottom + 2;
      } else if (typeof t === "object") {
        if (typeof t.x === "number") x = t.x;
        if (typeof t.y === "number") y = t.y;
      }
    }
    if (x + mw > vp.w - EDGE_PAD) x = vp.w - mw - EDGE_PAD;
    if (y + mh > vp.h - EDGE_PAD) y = vp.h - mh - EDGE_PAD;
    x = Math.max(EDGE_PAD, x);
    y = Math.max(EDGE_PAD, y);
    menu.style.left = x + "px";
    menu.style.top  = y + "px";
    menu.focus();

    // Bind global handlers
    state.outsideHandler = (e) => {
      // ignore clicks on any open ContextMenu element
      let n = e.target;
      while (n) {
        if (n.classList && n.classList.contains("webos-ctx")) return;
        n = n.parentNode;
      }
      closeAll();
    };
    state.keyHandler = (e) => onKey(e);
    state.resizeHandler = () => closeAll();

    // Single global click-outside listener pair: both pointerdown (captures
    // clicks on overlays early) and click (covers accessibility / synthetic
    // events). If the click target is not inside any open context menu, we
    // close everything.
    setTimeout(() => {
      document.addEventListener("pointerdown", state.outsideHandler, true);
      document.addEventListener("click",       state.outsideHandler, true);
      document.addEventListener("keydown",     state.keyHandler,      true);
      window.addEventListener("resize",        state.resizeHandler);
      window.addEventListener("blur",          state.resizeHandler);
    }, 0);

    return menu;
  }

  function closeAll() {
    if (state.outsideHandler) {
      document.removeEventListener("pointerdown", state.outsideHandler, true);
      document.removeEventListener("click",       state.outsideHandler, true);
      state.outsideHandler = null;
    }
    if (state.keyHandler) {
      document.removeEventListener("keydown", state.keyHandler, true);
      state.keyHandler = null;
    }
    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
      window.removeEventListener("blur",   state.resizeHandler);
      state.resizeHandler = null;
    }
    if (state.rootEl) {
      closeChildOf(state.rootEl);
      try { state.rootEl.remove(); } catch (_) {}
      state.rootEl = null;
    }
    if (typeof state.onCloseCb === "function") {
      try { state.onCloseCb(); } catch (_) {}
      state.onCloseCb = null;
    }
  }

  /* --------------------------------------------------------------------------
   * Keyboard navigation
   * ------------------------------------------------------------------------*/
  function activeChainFromRoot() {
    // Find the deepest open submenu
    let m = state.rootEl;
    while (m && m._child) m = m._child;
    return m;
  }
  function activeIndexIn(menu) {
    const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
    for (let i = 0; i < items.length; i++) {
      if (items[i].classList.contains("is-active")) return i;
    }
    return -1;
  }
  function setActiveAt(menu, idx) {
    const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
    if (!items.length) return;
    items.forEach((c) => c.classList.remove("is-active"));
    const safe = ((idx % items.length) + items.length) % items.length;
    items[safe].classList.add("is-active");
  }
  function nextEnabled(menu, dir) {
    const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
    if (!items.length) return;
    let cur = activeIndexIn(menu);
    if (cur < 0) cur = dir > 0 ? -1 : items.length;
    for (let step = 0; step < items.length; step++) {
      cur = ((cur + dir) % items.length + items.length) % items.length;
      if (!items[cur].classList.contains("is-disabled")) {
        items.forEach((c) => c.classList.remove("is-active"));
        items[cur].classList.add("is-active");
        return cur;
      }
    }
  }
  function onKey(e) {
    if (!state.rootEl) return;
    const menu = activeChainFromRoot();
    if (!menu) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // close just the deepest submenu, or all if at root
      if (menu._parent) {
        closeChildOf(menu._parent);
        menu._parent.focus && menu._parent.focus();
      } else {
        closeAll();
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); nextEnabled(menu, +1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); nextEnabled(menu, -1); return; }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const idx = activeIndexIn(menu);
      if (idx < 0) return;
      const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
      const el = items[idx];
      if (!el || el.classList.contains("is-disabled")) return;
      // open submenu if any
      if (el.querySelector(".ctx-arrow")) el.click(); // triggers existing handler
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (menu._parent) {
        closeChildOf(menu._parent);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const idx = activeIndexIn(menu);
      if (idx < 0) return;
      const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
      if (items[idx]) items[idx].click();
      return;
    }
    if (e.key === "Home") { e.preventDefault(); setActiveAt(menu, 0); return; }
    if (e.key === "End")  { e.preventDefault(); setActiveAt(menu, -1); return; }
    // single-character mnemonics — jump to next item starting with that letter
    if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
      const ch = e.key.toLowerCase();
      const items = Array.from(menu.querySelectorAll(":scope > .webos-ctx-item"));
      const cur = activeIndexIn(menu);
      for (let i = 1; i <= items.length; i++) {
        const j = (cur + i) % items.length;
        const lab = items[j].querySelector(".ctx-label");
        const text = lab ? lab.textContent.trim().toLowerCase() : "";
        if (text[0] === ch && !items[j].classList.contains("is-disabled")) {
          items.forEach((c) => c.classList.remove("is-active"));
          items[j].classList.add("is-active");
          return;
        }
      }
    }
  }

  /* --------------------------------------------------------------------------
   * Convenience builders for WebOS contexts
   * ------------------------------------------------------------------------*/

  // Desktop (right-click on empty desktop area)
  function forDesktop(detail) {
    const d = detail || {};
    const T = (window.Taskbar && window.Taskbar.toast) || (() => {});
    return [
      { label: "Refresh",      icon: "⟳", accelerator: "F5",
        action: () => window.Desktop && window.Desktop.refresh()
      },
      { separator: true },
      { label: "New folder",   icon: "📁",
        action: () => {
          if (!window.FileSystem) return;
          const base = "/Desktop";
          let name = "New Folder";
          let i = 1;
          while (window.FileSystem.exists(window.FileSystem.joinPath(base, name))) {
            i++; name = "New Folder (" + i + ")";
          }
          try {
            window.FileSystem.createFolder(window.FileSystem.joinPath(base, name));
            T({ title: "Desktop", body: "Created \"" + name + "\"", kind: "success" });
          } catch (e) {
            T({ title: "Error", body: e.message, kind: "error" });
          }
        }
      },
      { label: "New text file", icon: "📝",
        action: () => {
          if (!window.FileSystem) return;
          const base = "/Desktop";
          let name = "New Text Document.txt";
          let i = 1;
          while (window.FileSystem.exists(window.FileSystem.joinPath(base, name))) {
            i++; name = "New Text Document (" + i + ").txt";
          }
          try {
            window.FileSystem.writeFile(window.FileSystem.joinPath(base, name), "");
            T({ title: "Desktop", body: "Created \"" + name + "\"", kind: "success" });
          } catch (e) {
            T({ title: "Error", body: e.message, kind: "error" });
          }
        }
      },
      { separator: true },
      { label: "Paste", icon: "📥",
        disabled: !window.FileSystem || (window.FileSystem.getClipboard && window.FileSystem.getClipboard().empty),
        action: () => {
          if (!window.FileSystem) return;
          try {
            window.FileSystem.pasteClipboard("/Desktop", { uniquify: true });
            T({ title: "Desktop", body: "Pasted from clipboard", kind: "success" });
          } catch (e) { T({ title: "Paste failed", body: e.message, kind: "error" }); }
        }
      },
      { label: "Arrange icons", icon: "▦",
        action: () => window.Desktop && window.Desktop.arrangeIcons()
      },
      { separator: true },
      { label: "Add Widget…", icon: "▦", accelerator: "Ctrl+Alt+W",
        action: () => window.Widgets && window.Widgets.openPicker()
      },
      { label: "Arrange widgets", icon: "⋮⋮",
        disabled: !window.Widgets,
        children: [
          { label: "Snap to grid",           icon: "▦", action: () => window.Widgets && window.Widgets.snapAll() },
          { label: "Row along bottom",       icon: "↧", action: () => window.Widgets && window.Widgets.arrange("row-bottom") },
          { label: "Column on left",         icon: "↤", action: () => window.Widgets && window.Widgets.arrange("column-left") },
          { label: "Column on right",        icon: "↦", action: () => window.Widgets && window.Widgets.arrange("column-right") },
          { separator: true },
          { label: "Distribute horizontally",icon: "⇔", action: () => window.Widgets && window.Widgets.distributeHorizontally() },
          { label: "Distribute vertically",  icon: "⇕", action: () => window.Widgets && window.Widgets.distributeVertically() },
        ]
      },
      { separator: true },
      { header: "Theme" },
      { label: "Dark",       icon: "🌙",
        action: () => window.ThemeEngine && window.ThemeEngine.setTheme("dark") },
      { label: "Light",      icon: "☀",
        action: () => window.ThemeEngine && window.ThemeEngine.setTheme("light") },
      { label: "Cyberpunk",  icon: "🌆",
        action: () => window.ThemeEngine && window.ThemeEngine.setTheme("cyberpunk") },
      { label: "Retro",      icon: "📺",
        action: () => window.ThemeEngine && window.ThemeEngine.setTheme("retro") },
      { label: "Forest",     icon: "🌲",
        action: () => window.ThemeEngine && window.ThemeEngine.setTheme("forest") },
      { separator: true },
      { label: "Open File Manager", icon: "📁", accelerator: "",
        action: () => window.WindowManager && window.WindowManager.openApp("filemanager", { startPath: "/Desktop" })
      },
      { label: "Display settings", icon: "⚙",
        action: () => window.WindowManager && window.WindowManager.openApp("settings")
      },
      { label: "About WebOS", icon: "ⓘ",
        action: () => window.WindowManager && window.WindowManager.openApp("about")
      },
    ];
  }

  // Right-click on a file
  function forFile(path, detail) {
    const d   = detail || {};
    const fs  = window.FileSystem;
    if (!fs) return [];
    let md;
    try { md = fs.getMetadata(path); }
    catch (_) { return []; }
    const ro  = md.readonly;
    const T   = (window.Taskbar && window.Taskbar.toast) || (() => {});

    return [
      { label: "Open",       icon: "📂",
        action: () => {
          if (typeof d.onOpen === "function") d.onOpen(path);
          else openFileWithDefaultApp(path);
        }
      },
      { label: "Open with…", icon: "▸",
        children: openWithChildren(path, d)
      },
      { separator: true },
      { label: "Cut",        icon: "✂", accelerator: "Ctrl+X", disabled: ro,
        action: () => { try { fs.cutToClipboard([path]); T({ title:"Cut", body: md.name, kind:"info" }); } catch (e) { T({ title:"Error", body:e.message, kind:"error" }); } }
      },
      { label: "Copy",       icon: "📋", accelerator: "Ctrl+C",
        action: () => { try { fs.copyToClipboard([path]); T({ title:"Copied", body: md.name, kind:"info" }); } catch (e) { T({ title:"Error", body:e.message, kind:"error" }); } }
      },
      { label: "Duplicate",  icon: "🗂", disabled: ro,
        action: () => { try { fs.duplicate(path); T({ title:"Duplicated", body: md.name, kind:"success" }); } catch (e) { T({ title:"Error", body:e.message, kind:"error" }); } }
      },
      { separator: true },
      { label: "Rename",     icon: "✏", accelerator: "F2", disabled: ro,
        action: () => {
          if (typeof d.onRename === "function") d.onRename(path);
          else simpleRenamePrompt(path);
        }
      },
      { label: "Delete",     icon: "🗑", accelerator: "Del", danger: true, disabled: ro,
        action: () => {
          try { fs.deleteFile(path); T({ title: "Deleted", body: md.name + " moved to Trash", kind: "info" }); }
          catch (e) { T({ title: "Delete failed", body: e.message, kind: "error" }); }
        }
      },
      { separator: true },
      { label: "Properties", icon: "ⓘ",
        action: () => showProperties(path)
      },
    ];
  }

  // Right-click on a folder
  function forFolder(path, detail) {
    const d   = detail || {};
    const fs  = window.FileSystem;
    if (!fs) return [];
    let md;
    try { md = fs.getMetadata(path); }
    catch (_) { return []; }
    const ro  = md.readonly;
    const T   = (window.Taskbar && window.Taskbar.toast) || (() => {});

    return [
      { label: "Open",        icon: "📂",
        action: () => { if (typeof d.onOpen === "function") d.onOpen(path);
                        else window.WindowManager && window.WindowManager.openApp("filemanager", { startPath: path }); }
      },
      { label: "Open in new window", icon: "🗗",
        action: () => window.WindowManager && window.WindowManager.openApp("filemanager", { startPath: path, fresh: true })
      },
      { separator: true },
      { label: "Cut",         icon: "✂", accelerator: "Ctrl+X", disabled: ro,
        action: () => { try { fs.cutToClipboard([path]); T({ title:"Cut", body: md.name, kind:"info" }); } catch (e) { T({ title:"Error", body:e.message, kind:"error" }); } }
      },
      { label: "Copy",        icon: "📋", accelerator: "Ctrl+C",
        action: () => { try { fs.copyToClipboard([path]); T({ title:"Copied", body: md.name, kind:"info" }); } catch (e) { T({ title:"Error", body:e.message, kind:"error" }); } }
      },
      { label: "Paste into",  icon: "📥",
        disabled: ro || (fs.getClipboard && fs.getClipboard().empty),
        action: () => { try { fs.pasteClipboard(path, { uniquify: true }); T({ title:"Pasted", body:"into " + md.name, kind:"success" }); } catch (e) { T({ title:"Paste failed", body:e.message, kind:"error" }); } }
      },
      { separator: true },
      { label: "New folder",  icon: "📁", disabled: ro,
        action: () => {
          let name = "New Folder", i = 1;
          while (fs.exists(fs.joinPath(path, name))) { i++; name = "New Folder (" + i + ")"; }
          try { fs.createFolder(fs.joinPath(path, name)); T({ title:"Created", body:name, kind:"success" }); }
          catch (e) { T({ title:"Error", body:e.message, kind:"error" }); }
        }
      },
      { label: "New text file", icon: "📝", disabled: ro,
        action: () => {
          let name = "New Text Document.txt", i = 1;
          while (fs.exists(fs.joinPath(path, name))) { i++; name = "New Text Document (" + i + ").txt"; }
          try { fs.writeFile(fs.joinPath(path, name), ""); T({ title:"Created", body:name, kind:"success" }); }
          catch (e) { T({ title:"Error", body:e.message, kind:"error" }); }
        }
      },
      { separator: true },
      { label: "Rename",      icon: "✏", accelerator: "F2", disabled: ro || md.path === "/",
        action: () => {
          if (typeof d.onRename === "function") d.onRename(path);
          else simpleRenamePrompt(path);
        }
      },
      { label: "Delete",      icon: "🗑", accelerator: "Del", danger: true, disabled: ro || md.path === "/" || md.path === "/Trash" || md.path === "/System",
        action: () => {
          try { fs.deleteFile(path); T({ title:"Deleted", body: md.name + " moved to Trash", kind:"info" }); }
          catch (e) { T({ title:"Delete failed", body:e.message, kind:"error" }); }
        }
      },
      { separator: true },
      { label: "Properties",  icon: "ⓘ",
        action: () => showProperties(path)
      },
    ];
  }

  // Taskbar — right-click on empty taskbar
  function forTaskbar(detail) {
    const d = detail || {};
    return [
      { label: "Show desktop",       icon: "🖥",
        action: () => window.WindowManager && window.WindowManager.toggleShowDesktop()
      },
      { label: "Cascade windows",    icon: "🗂",
        action: () => cascadeWindows()
      },
      { separator: true },
      { label: "Notifications",      icon: "🔔",
        action: () => window.Taskbar && window.Taskbar.toggleNC()
      },
      { label: "Task manager",       icon: "📊",
        action: () => window.WindowManager && window.WindowManager.openApp("about")
      },
      { separator: true },
      { label: "Taskbar settings",   icon: "⚙",
        action: () => window.WindowManager && window.WindowManager.openApp("settings")
      },
    ];
  }

  // Window titlebar — right-click on titlebar
  function forWindowTitlebar(winId, detail) {
    const wm = window.WindowManager;
    if (!wm) return [];
    const w  = wm.getWindow ? wm.getWindow(winId) : null;
    return [
      { label: "Restore",   icon: "⤺",
        disabled: !w || (!w.minimized && !w.maximized),
        action: () => wm.restoreWindow(winId)
      },
      { label: "Minimize",  icon: "▁",
        disabled: !w || w.minimized,
        action: () => wm.minimizeWindow(winId)
      },
      { label: "Maximize",  icon: "▢",
        disabled: !w || w.maximized,
        action: () => wm.maximizeWindow(winId)
      },
      { separator: true },
      { label: "Snap left",  icon: "⬅",
        action: () => wm.snapTo && wm.snapTo(winId, "left")
      },
      { label: "Snap right", icon: "➡",
        action: () => wm.snapTo && wm.snapTo(winId, "right")
      },
      { separator: true },
      { label: "Close",     icon: "✕", danger: true, accelerator: "Ctrl+W",
        action: () => wm.closeWindow(winId)
      },
    ];
  }

  /* --------------------------------------------------------------------------
   * Helpers used by the convenience builders
   * ------------------------------------------------------------------------*/
  function openWithChildren(path, detail) {
    const fs = window.FileSystem;
    const md = fs.getMetadata(path);
    const apps = (window.WindowManager && window.WindowManager.getApps) ? window.WindowManager.getApps() : [];
    const out = [];
    // Helper: determine if a path matches one of the NoteForge text extensions.
    function isNoteForgeFile(p) {
      if (!p) return false;
      const name = String(p).split("/").pop() || "";
      const i = name.lastIndexOf(".");
      const ext = (i <= 0 ? name : name.slice(i + 1)).toLowerCase();
      return ["txt","js","py","html","htm","css","json","md","markdown",
              "xml","svg","ts","tsx","jsx","log","csv","yaml","yml",
              "sh","bash","ini","cfg","conf","toml"].indexOf(ext) !== -1;
    }
    // NoteForge first for text/code (new Day-3 primary editor)
    if (md.kind === "text" || md.kind === "code" || isNoteForgeFile(path)) {
      out.push({ label: "Open in NoteForge", icon: "📝",
        action: () => window.WindowManager.openApp("textEditor", { openPath: path }) });
      // Legacy Notepad kept as a secondary option
      out.push({ label: "Notepad", icon: "📃",
        action: () => window.WindowManager.openApp("notepad", { docId: path, openPath: path }) });
    }
    // File Manager for folders
    if (md.type === "folder") {
      out.push({ label: "File Manager", icon: "📁",
        action: () => window.WindowManager.openApp("filemanager", { startPath: path }) });
    }
    // Anything registered with a `canOpen` helper (but skip textEditor since we added it explicitly above)
    apps.forEach((a) => {
      if (a.id === "textEditor") return;
      if (typeof a.canOpen === "function") {
        try {
          if (a.canOpen(md)) {
            out.push({ label: a.title, icon: a.icon || "▦",
              action: () => window.WindowManager.openApp(a.id, { openPath: path }) });
          }
        } catch (_) {}
      }
    });
    if (!out.length) {
      out.push({ label: "(No suitable app)", disabled: true });
    }
    return out;
  }

  function openFileWithDefaultApp(path) {
    const fs = window.FileSystem;
    const wm = window.WindowManager;
    if (!fs || !wm) return;
    const md = fs.getMetadata(path);
    if (md.type === "folder") {
      wm.openApp("filemanager", { startPath: path });
      return;
    }
    if (md.kind === "text" || md.kind === "code") {
      // Prefer NoteForge (Day-3) when available, otherwise fall back to the legacy stub.
      const apps = wm.getApps ? wm.getApps() : [];
      const hasEditor = apps.some((a) => a.id === "textEditor");
      if (hasEditor) {
        wm.openApp("textEditor", { openPath: path });
      } else {
        wm.openApp("notepad", { docId: path, openPath: path });
      }
      return;
    }
    // Generic preview window for everything else
    wm.openWindow({
      appId: "viewer",
      title: md.name,
      icon:  md.icon,
      width: 520, height: 380,
      render(body) {
        body.innerHTML = `
          <div style="padding:24px;display:flex;flex-direction:column;align-items:center;gap:10px;">
            <div style="font-size:64px;">${md.icon}</div>
            <h3 style="margin:0;">${escapeHtml(md.name)}</h3>
            <div style="opacity:.7;">${md.kind} · ${fs.formatBytes(md.size)}</div>
            <div style="opacity:.55;font-size:12px;">${escapeHtml(md.path)}</div>
            <div style="margin-top:10px;opacity:.6;text-align:center;max-width:360px;">
              No preview available for this file type.<br/>Try opening it with the File Manager.
            </div>
          </div>`;
      }
    });
  }

  function simpleRenamePrompt(path) {
    const fs = window.FileSystem;
    if (!fs) return;
    const md = fs.getMetadata(path);
    const cur = md.name;
    const next = window.prompt("Rename:", cur);
    if (!next || next === cur) return;
    try { fs.rename(path, next.trim()); }
    catch (e) {
      if (window.Taskbar) window.Taskbar.toast({ title: "Rename failed", body: e.message, kind: "error" });
    }
  }

  function showProperties(path) {
    const fs = window.FileSystem;
    if (!fs) return;
    const md = fs.getMetadata(path);
    const wm = window.WindowManager;
    if (!wm) return;
    wm.openWindow({
      appId: "properties",
      title: "Properties — " + md.name,
      icon:  md.icon,
      width: 380, height: 360, resizable: false, maximizable: false,
      render(body) {
        body.innerHTML = `
          <div style="padding:18px;display:flex;flex-direction:column;gap:14px;">
            <div style="display:flex;align-items:center;gap:14px;">
              <div style="font-size:40px;">${md.icon}</div>
              <div>
                <div style="font-weight:600;font-size:14px;">${escapeHtml(md.name)}</div>
                <div style="opacity:.65;font-size:12px;">${escapeHtml(md.path)}</div>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;">
              <div style="opacity:.6;">Type</div>      <div>${escapeHtml(md.type)}${md.ext ? " (." + escapeHtml(md.ext) + ")" : ""}</div>
              <div style="opacity:.6;">Kind</div>      <div>${escapeHtml(md.kind)}</div>
              <div style="opacity:.6;">Size</div>      <div>${fs.formatBytes(md.size)}</div>
              <div style="opacity:.6;">Created</div>   <div>${fs.formatDate(md.created)}</div>
              <div style="opacity:.6;">Modified</div>  <div>${fs.formatDate(md.modified)}</div>
              <div style="opacity:.6;">Read-only</div> <div>${md.readonly ? "Yes" : "No"}</div>
              <div style="opacity:.6;">Hidden</div>    <div>${md.hidden ? "Yes" : "No"}</div>
              <div style="opacity:.6;">Permissions</div><div>${md.perms}</div>
            </div>
          </div>`;
      }
    });
  }

  function cascadeWindows() {
    const wm = window.WindowManager;
    if (!wm || !wm.listWindows) return;
    const wins = wm.listWindows();
    let x = 60, y = 60;
    wins.forEach((w) => {
      if (w.minimized) return;
      try {
        if (w.maximized && wm.unmaximize) wm.unmaximize(w.id);
        if (w.el) {
          w.el.style.left = x + "px";
          w.el.style.top  = y + "px";
        }
        x += 30; y += 30;
        if (x > window.innerWidth - 200)  x = 60;
        if (y > window.innerHeight - 200) y = 60;
        wm.focusWindow(w.id);
      } catch (_) {}
    });
  }

  /* --------------------------------------------------------------------------
   * Global hookups
   * ------------------------------------------------------------------------*/
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    ensureStyles();

    // Right-click on the taskbar (excluding clickable subsections) -> taskbar menu
    document.addEventListener("contextmenu", (e) => {
      const tb = e.target.closest && e.target.closest("#taskbar");
      // Only trigger when right-clicking the taskbar background, not its
      // interactive children — the existing modules already handle those.
      if (tb &&
          !e.target.closest(".taskbar-app") &&
          !e.target.closest(".start-button") &&
          !e.target.closest(".taskbar-tray") &&
          !e.target.closest(".taskbar-search")) {
        e.preventDefault();
        show({ x: e.clientX, y: e.clientY, items: forTaskbar() });
      }
    });

    console.log("%c[WebOS]%c ContextMenu ready",
      "color:#a78bfa;font-weight:bold","color:inherit");
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.ContextMenu = {
    init, show, close: closeAll, closeAll,
    forDesktop, forFile, forFolder, forTaskbar, forWindowTitlebar,
    // helpers (some apps may want them)
    showProperties,
    openFileWithDefaultApp,
    openWithChildren,
    cascadeWindows,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
