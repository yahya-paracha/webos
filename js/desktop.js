/* ============================================================================
 * WebOS — desktop.js
 * ----------------------------------------------------------------------------
 * Manages the desktop surface:
 *   - Desktop icon grid (rendering, drag-to-arrange, double-click-to-open)
 *   - Selection box (click & drag empty desktop to multi-select icons)
 *   - Right-click context menu (refresh, new file/folder, theme, wallpaper, …)
 *   - Persistent icon positions in localStorage
 *   - Coordinates with WindowManager for app launching
 *   - Public API on window.Desktop
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Config
   * ------------------------------------------------------------------------*/
  const STORAGE_KEY_ICONS    = "webos.desktopIcons";
  const STORAGE_KEY_POSITION = "webos.desktopIconPositions";
  const ICON_W = 96;
  const ICON_H = 100;
  const ICON_GAP = 6;
  const DBLCLICK_MS = 350;

  /* --------------------------------------------------------------------------
   * Default app-launcher icons (always present unless explicitly hidden by
   * the user). Folder/file icons under /Desktop in the filesystem are merged
   * in on top of these via syncFromFs().
   * ------------------------------------------------------------------------*/
  const DEFAULT_ICONS = Object.freeze([
    { id: "ico_about",      label: "About",        icon: "ⓘ", appId: "about",      kind: "app" },
    { id: "ico_settings",   label: "Settings",     icon: "⚙", appId: "settings",   kind: "app" },
    { id: "ico_files",      label: "Files",        icon: "📁", appId: "filemanager", kind: "app" },
    { id: "ico_browser",    label: "Browser",      icon: "🌐", appId: "browser",    kind: "app" },
    { id: "ico_notepad",    label: "Notepad",      icon: "📝", appId: "notepad",    kind: "app" },
    { id: "ico_calc",       label: "Calculator",   icon: "🧮", appId: "calculator", kind: "app" },
    { id: "ico_terminal",   label: "Terminal",     icon: "⌨", appId: "terminal",   kind: "app" },
    { id: "ico_paint",      label: "Paint",        icon: "🎨", appId: "paint",      kind: "app" },
    { id: "ico_clock",      label: "Clock",        icon: "🕒", appId: "clock",      kind: "app" },
    { id: "ico_recycle",    label: "Recycle Bin",  icon: "🗑", appId: "filemanager", kind: "app",
      // "Open" the recycle bin = navigate File Manager to /Trash
      onOpen: () => window.WindowManager && window.WindowManager.openApp("filemanager", { startPath: "/Trash" })
    },
  ]);

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    initialized:  false,
    icons:        [],     // [{id,label,icon,appId,x?,y?}]
    selection:    new Set(),
    rootEl:       null,
    selBoxEl:     null,
    contextEl:    null,
    lastClickAt:  0,
    lastClickId:  null,
    listeners:    new Set(),
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

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent("webos:" + name, { detail })); } catch (_) {}
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

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* --------------------------------------------------------------------------
   * Persistence
   * ------------------------------------------------------------------------*/
  // ID prefix used for FS-backed icons — distinct from "ico_*" so a system
  // app icon never collides with a user file at /Desktop with the same name.
  const FS_ICON_PREFIX = "fs_";
  function fsIconId(path) { return FS_ICON_PREFIX + (path || "").replace(/[^a-zA-Z0-9]+/g, "_"); }

  function loadIcons() {
    // Static system shortcuts — always shown unless the user hid them.
    const hidden = safeGet("webos.desktopHiddenLaunchers", []);
    const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
    let icons = DEFAULT_ICONS
      .filter((i) => !hiddenSet.has(i.id))
      .map((i) => Object.assign({}, i));

    // Filesystem-backed icons — anything sitting in /Desktop
    const fs = window.FileSystem;
    if (fs && fs.exists && fs.exists("/Desktop")) {
      try {
        const entries = fs.listDir("/Desktop");
        for (const e of entries) {
          icons.push({
            id:    fsIconId(e.path),
            label: e.name,
            icon:  e.icon || (e.type === "folder" ? "📁" : "📄"),
            appId: null,
            kind:  "fs",
            type:  e.type,            // "file" | "folder"
            path:  e.path,            // FS path — source of truth
          });
        }
      } catch (err) {
        console.warn("[Desktop] could not list /Desktop:", err);
      }
    }

    // Apply persisted positions (keyed by icon id)
    const pos = safeGet(STORAGE_KEY_POSITION, {});
    icons.forEach((i) => {
      if (pos && pos[i.id]) {
        i.x = pos[i.id].x;
        i.y = pos[i.id].y;
      }
    });

    state.icons = icons;
    // We no longer persist the icon list itself — the source of truth is the
    // filesystem for fs-backed icons + DEFAULT_ICONS for system launchers.
    // STORAGE_KEY_ICONS remains in localStorage from older builds; we leave
    // it untouched but stop reading it.
  }

  function saveIcons() {
    // Persist icon positions only. The list itself is derived.
    const pos = {};
    state.icons.forEach((i) => {
      if (typeof i.x === "number") pos[i.id] = { x: i.x, y: i.y };
    });
    safeSet(STORAGE_KEY_POSITION, pos);
  }

  function syncFromFs() {
    // Reload icon list from FS, preserve current selection where possible.
    const previousSel = new Set(state.selection);
    loadIcons();
    state.selection = new Set();
    state.icons.forEach((i) => { if (previousSel.has(i.id)) state.selection.add(i.id); });
    render();
    syncSelection();
  }

  /* --------------------------------------------------------------------------
   * Render
   * ------------------------------------------------------------------------*/
  function ensureRoot() {
    state.rootEl = state.rootEl || document.getElementById("desktop-icons");
    return state.rootEl;
  }

  function render() {
    const root = ensureRoot();
    if (!root) return;
    root.innerHTML = "";
    state.icons.forEach((ic) => root.appendChild(buildIcon(ic)));
    applyAbsolutePositions();
  }

  function buildIcon(ic) {
    const el = document.createElement("div");
    el.className = "desktop-icon";
    el.dataset.id = ic.id;
    el.setAttribute("role", "listitem");
    el.tabIndex = 0;
    el.innerHTML = `
      <div class="icon-glyph">${escapeHtml(ic.icon || "▦")}</div>
      <div class="icon-label">${escapeHtml(ic.label || ic.id)}</div>
    `;
    bindIconEvents(el, ic);
    return el;
  }

  function applyAbsolutePositions() {
    const root = ensureRoot();
    if (!root) return;
    let anyAbs = false;
    state.icons.forEach((ic) => {
      const el = root.querySelector(`[data-id="${cssEscape(ic.id)}"]`);
      if (!el) return;
      if (typeof ic.x === "number" && typeof ic.y === "number") {
        anyAbs = true;
        el.style.position = "absolute";
        el.style.left = ic.x + "px";
        el.style.top  = ic.y + "px";
      } else {
        el.style.position = "";
        el.style.left = "";
        el.style.top  = "";
      }
    });
    // If at least one icon is positioned absolutely, use absolute layout for grid
    root.style.gridAutoFlow  = anyAbs ? "unset" : "";
    root.style.gridTemplateRows    = anyAbs ? "unset" : "";
    root.style.gridTemplateColumns = anyAbs ? "unset" : "";
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, (c) => "\\" + c);
  }

  /* --------------------------------------------------------------------------
   * Selection
   * ------------------------------------------------------------------------*/
  function selectOnly(id) {
    state.selection.clear();
    if (id) state.selection.add(id);
    syncSelection();
  }

  function selectAdd(id) {
    if (id) state.selection.add(id);
    syncSelection();
  }

  function selectToggle(id) {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    syncSelection();
  }

  function clearSelection() {
    state.selection.clear();
    syncSelection();
  }

  function selectAll() {
    state.icons.forEach((i) => state.selection.add(i.id));
    syncSelection();
  }

  function syncSelection() {
    const root = ensureRoot();
    if (!root) return;
    $$(".desktop-icon", root).forEach((el) => {
      el.classList.toggle("selected", state.selection.has(el.dataset.id));
    });
  }

  /* --------------------------------------------------------------------------
   * Per-icon events
   * ------------------------------------------------------------------------*/
  function bindIconEvents(el, ic) {
    let dragging = false;
    let startX = 0, startY = 0;
    let origX = 0, origY = 0;
    let movedFar = false;

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // don't start desktop selection
      hideContextMenu();

      // Selection logic (with shift/ctrl for multi-select)
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        selectToggle(ic.id);
      } else if (!state.selection.has(ic.id)) {
        selectOnly(ic.id);
      }

      // Detect double-click manually for reliability across browsers
      const now = Date.now();
      if (state.lastClickId === ic.id && (now - state.lastClickAt) < DBLCLICK_MS) {
        openIcon(ic);
        state.lastClickAt = 0;
        state.lastClickId = null;
        return;
      }
      state.lastClickAt = now;
      state.lastClickId = ic.id;

      // Begin potential drag
      dragging = true;
      movedFar = false;
      const rect = el.getBoundingClientRect();
      const parentRect = ensureRoot().getBoundingClientRect();
      origX = rect.left - parentRect.left;
      origY = rect.top  - parentRect.top;
      startX = e.clientX;
      startY = e.clientY;

      el.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!movedFar && Math.hypot(dx, dy) > 4) {
          movedFar = true;
          el.classList.add("dragging");
        }
        if (!movedFar) return;

        const root = ensureRoot();
        const rb = root.getBoundingClientRect();
        const nx = clamp(origX + dx, 0, rb.width  - ICON_W);
        const ny = clamp(origY + dy, 0, rb.height - ICON_H);
        el.style.position = "absolute";
        el.style.left = nx + "px";
        el.style.top  = ny + "px";
        ic.x = nx; ic.y = ny;
        // ensure parent uses absolute layout
        root.style.gridAutoFlow = "unset";
        root.style.gridTemplateRows = "unset";
        root.style.gridTemplateColumns = "unset";
      };

      const onUp = () => {
        dragging = false;
        el.classList.remove("dragging");
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup",   onUp);
        if (movedFar) saveIcons();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup",   onUp);
    });

    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openIcon(ic);
    });

    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIcon(ic); }
      if (e.key === "Delete") { deleteSelected(); }
      if (e.key === "F2")     { renameIcon(ic.id); }
    });

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selection.has(ic.id)) selectOnly(ic.id);
      showIconContextMenu(ic, e.clientX, e.clientY);
    });
  }

  function openIcon(ic) {
    // FS-backed icon — delegate to the filesystem-aware default opener.
    if (ic.kind === "fs" && ic.path) {
      if (window.ContextMenu && window.ContextMenu.openFileWithDefaultApp) {
        window.ContextMenu.openFileWithDefaultApp(ic.path);
      } else if (ic.type === "folder" && window.WindowManager) {
        window.WindowManager.openApp("filemanager", { startPath: ic.path });
      } else if (window.WindowManager) {
        window.WindowManager.openApp("notepad", { docId: ic.path, openPath: ic.path });
      }
      if (window.FileSystem && window.FileSystem.pushRecent) {
        window.FileSystem.pushRecent(ic.path, "open");
      }
      return;
    }
    if (typeof ic.onOpen === "function") {
      try { ic.onOpen(ic); } catch (e) { console.error(e); }
      return;
    }
    if (ic.appId && window.WindowManager) {
      window.WindowManager.openApp(ic.appId);
      return;
    }
    if (window.Taskbar) {
      window.Taskbar.toast({ title: ic.label || "Item", body: "Nothing to open here.", kind: "info" });
    }
  }

  /* --------------------------------------------------------------------------
   * Selection rectangle (drag on empty desktop)
   * ------------------------------------------------------------------------*/
  function bindSelectionBox() {
    const root = ensureRoot();
    if (!root) return;
    state.selBoxEl = state.selBoxEl || document.getElementById("selection-box");

    const desktop = document.getElementById("desktop");
    if (!desktop) return;

    desktop.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // Only when clicking the desktop itself (not an icon, window, taskbar, etc.)
      const t = e.target;
      if (t.closest(".desktop-icon")) return;
      if (t.closest(".window"))       return;
      if (t.closest(".taskbar"))      return;
      if (t.closest(".start-menu"))   return;
      if (t.closest(".context-menu")) return;

      hideContextMenu();
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) clearSelection();

      const startX = e.clientX, startY = e.clientY;
      const box = state.selBoxEl;
      box.hidden = false;
      box.style.left = startX + "px";
      box.style.top  = startY + "px";
      box.style.width = "0px";
      box.style.height = "0px";

      const onMove = (ev) => {
        const x = Math.min(ev.clientX, startX);
        const y = Math.min(ev.clientY, startY);
        const w = Math.abs(ev.clientX - startX);
        const h = Math.abs(ev.clientY - startY);
        box.style.left = x + "px";
        box.style.top  = y + "px";
        box.style.width  = w + "px";
        box.style.height = h + "px";

        // hit-test icons
        const r1 = { l: x, t: y, r: x + w, b: y + h };
        $$(".desktop-icon", root).forEach((el) => {
          const r = el.getBoundingClientRect();
          const hit = !(r.right < r1.l || r.left > r1.r || r.bottom < r1.t || r.top > r1.b);
          if (hit) state.selection.add(el.dataset.id);
          else if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) state.selection.delete(el.dataset.id);
        });
        syncSelection();
      };

      const onUp = () => {
        box.hidden = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup",   onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup",   onUp);
    });
  }

  /* --------------------------------------------------------------------------
   * Context menu — desktop
   * ------------------------------------------------------------------------*/
  function bindContextMenu() {
    state.contextEl = document.getElementById("context-menu");
    const desktop = document.getElementById("desktop");
    if (!desktop) return;

    desktop.addEventListener("contextmenu", (e) => {
      const t = e.target;
      if (t.closest(".desktop-icon")) return;     // icon menu handles it
      if (t.closest(".window"))       return;
      if (t.closest(".taskbar"))      return;
      if (t.closest(".start-menu"))   return;
      e.preventDefault();
      showDesktopContextMenu(e.clientX, e.clientY);
    });

    // Bind menu items once
    const menu = state.contextEl;
    if (!menu) return;
    menu.querySelectorAll(".context-item[data-action]").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (item.classList.contains("has-sub")) return; // submenu handled by hover
        const a = item.dataset.action;
        runDesktopAction(a);
        hideContextMenu();
      });
    });
    menu.querySelectorAll("[data-theme]").forEach((it) => {
      it.addEventListener("click", () => { window.ThemeEngine.setTheme(it.dataset.theme); hideContextMenu(); });
    });
    menu.querySelectorAll("[data-wallpaper]").forEach((it) => {
      it.addEventListener("click", () => { window.ThemeEngine.setWallpaper(it.dataset.wallpaper); hideContextMenu(); });
    });

    document.addEventListener("pointerdown", (e) => {
      if (state.contextEl && !state.contextEl.hidden && !state.contextEl.contains(e.target)) {
        hideContextMenu();
      }
    }, true);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideContextMenu();
    });
  }

  function showDesktopContextMenu(x, y) {
    const menu = state.contextEl;
    if (!menu) return;
    menu.hidden = false;
    const w = menu.offsetWidth || 220, h = menu.offsetHeight || 320;
    menu.style.left = clamp(x, 4, window.innerWidth  - w - 4) + "px";
    menu.style.top  = clamp(y, 4, window.innerHeight - h - 4) + "px";
  }

  function hideContextMenu() {
    if (state.contextEl) state.contextEl.hidden = true;
    const ic = document.getElementById("__desktop_icon_menu__");
    if (ic) ic.remove();
  }

  function runDesktopAction(action) {
    switch (action) {
      case "refresh":   refresh(); break;
      case "newfolder": addNewFolder(); break;
      case "newfile":   addNewFile(); break;
      case "arrange":   arrangeIcons(); break;
      case "settings":  if (window.WindowManager) window.WindowManager.openApp("settings"); break;
      case "about":     if (window.WindowManager) window.WindowManager.openApp("about"); break;
    }
  }

  /* --------------------------------------------------------------------------
   * Context menu — icon
   * ------------------------------------------------------------------------*/
  function showIconContextMenu(ic, x, y) {
    const existing = document.getElementById("__desktop_icon_menu__");
    if (existing) existing.remove();
    const menu = document.createElement("div");
    menu.id = "__desktop_icon_menu__";
    menu.className = "context-menu";
    menu.innerHTML = `
      <div class="context-item" data-act="open"><span class="ci-ico">▶</span> Open</div>
      <div class="context-item" data-act="rename"><span class="ci-ico">✎</span> Rename</div>
      <div class="context-separator"></div>
      <div class="context-item" data-act="delete"><span class="ci-ico">🗑</span> Delete</div>
      <div class="context-separator"></div>
      <div class="context-item" data-act="properties"><span class="ci-ico">ⓘ</span> Properties</div>
    `;
    document.body.appendChild(menu);
    const w = menu.offsetWidth || 200, h = menu.offsetHeight || 200;
    menu.style.left = clamp(x, 4, window.innerWidth  - w - 4) + "px";
    menu.style.top  = clamp(y, 4, window.innerHeight - h - 4) + "px";

    menu.querySelectorAll("[data-act]").forEach((it) => {
      it.addEventListener("click", () => {
        const a = it.dataset.act;
        if (a === "open")       openIcon(ic);
        if (a === "rename")     renameIcon(ic.id);
        if (a === "delete")     deleteSelected();
        if (a === "properties") {
          if (window.Taskbar) window.Taskbar.toast({ title: "Properties", body: ic.label + " (id: " + ic.id + ")", kind: "info" });
        }
        menu.remove();
      });
    });
    setTimeout(() => document.addEventListener("pointerdown", outsideIconMenu, true), 0);
  }

  function outsideIconMenu(e) {
    const m = document.getElementById("__desktop_icon_menu__");
    if (m && !m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", outsideIconMenu, true);
    }
  }

  /* --------------------------------------------------------------------------
   * Icon CRUD
   * ------------------------------------------------------------------------*/
  function addIcon(opts) {
    const o = opts || {};
    const ic = {
      id:    o.id || ("ico_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)),
      label: o.label || "New Item",
      icon:  o.icon  || "📄",
      appId: o.appId || null,
      kind:  o.kind  || "app",
    };
    if (typeof o.x === "number") ic.x = o.x;
    if (typeof o.y === "number") ic.y = o.y;
    state.icons.push(ic);
    saveIcons();
    render();
    syncSelection();
    return ic;
  }

  function addNewFolder() {
    const fs = window.FileSystem;
    if (fs) {
      let name = "New Folder", i = 1;
      while (fs.exists(fs.joinPath("/Desktop", name))) { i++; name = "New Folder (" + i + ")"; }
      try {
        fs.createFolder(fs.joinPath("/Desktop", name));
        // syncFromFs will fire from fs:create event handler; explicit too:
        syncFromFs();
        const id = fsIconId(fs.joinPath("/Desktop", name));
        selectOnly(id);
        setTimeout(() => renameIcon(id), 80);
      } catch (e) {
        if (window.Taskbar) window.Taskbar.toast({ title: "Error", body: e.message, kind: "error" });
      }
      return;
    }
    // Fallback when FS is unavailable
    const ic = addIcon({ label: "New Folder", icon: "📁" });
    selectOnly(ic.id);
    setTimeout(() => renameIcon(ic.id), 60);
  }

  function addNewFile() {
    const fs = window.FileSystem;
    if (fs) {
      let name = "New File.txt", i = 1;
      while (fs.exists(fs.joinPath("/Desktop", name))) { i++; name = "New File (" + i + ").txt"; }
      try {
        fs.writeFile(fs.joinPath("/Desktop", name), "");
        syncFromFs();
        const id = fsIconId(fs.joinPath("/Desktop", name));
        selectOnly(id);
        setTimeout(() => renameIcon(id), 80);
      } catch (e) {
        if (window.Taskbar) window.Taskbar.toast({ title: "Error", body: e.message, kind: "error" });
      }
      return;
    }
    const ic = addIcon({ label: "New File.txt", icon: "📄" });
    selectOnly(ic.id);
    setTimeout(() => renameIcon(ic.id), 60);
  }

  function deleteSelected() {
    if (!state.selection.size) return;
    const fs = window.FileSystem;
    let trashedCount = 0, hiddenCount = 0;
    const remainingHidden = new Set(safeGet("webos.desktopHiddenLaunchers", []) || []);
    state.icons.forEach((i) => {
      if (!state.selection.has(i.id)) return;
      if (i.kind === "fs" && i.path && fs) {
        try { fs.deleteFile(i.path); trashedCount++; }
        catch (e) { console.warn("[Desktop] delete failed for", i.path, e); }
      } else {
        // Hide the system launcher rather than removing it permanently
        remainingHidden.add(i.id);
        hiddenCount++;
      }
    });
    safeSet("webos.desktopHiddenLaunchers", Array.from(remainingHidden));
    state.selection.clear();
    syncFromFs();
    if (window.Taskbar) {
      const parts = [];
      if (trashedCount) parts.push(trashedCount + " item" + (trashedCount > 1 ? "s" : "") + " moved to Trash");
      if (hiddenCount)  parts.push(hiddenCount  + " launcher" + (hiddenCount  > 1 ? "s" : "") + " hidden");
      window.Taskbar.toast({ title: "Deleted", body: parts.join(" · ") || "Removed", kind: "info" });
    }
  }

  function renameIcon(id) {
    const ic = state.icons.find((i) => i.id === id);
    if (!ic) return;
    // System app launchers shouldn't be renamed (would lose the appId binding)
    if (ic.kind !== "fs") {
      if (window.Taskbar) window.Taskbar.toast({
        title: "Cannot rename",
        body: "System shortcuts are read-only. Try a file or folder instead.",
        kind: "info",
      });
      return;
    }
    const root = ensureRoot();
    const el = root.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (!el) return;
    const labelEl = el.querySelector(".icon-label");
    const original = ic.label;
    const input = document.createElement("input");
    input.type = "text";
    input.value = original;
    input.style.cssText = `
      width: 92px; font-size: 12px; text-align: center;
      background: var(--window-bg); color: var(--fg-0);
      border: 1px solid var(--accent-1); border-radius: var(--r-xs);
      padding: 2px 4px; outline: none;
    `;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (save) => {
      const v = input.value.trim();
      const fs = window.FileSystem;
      if (save && v && v !== original && fs && ic.path) {
        try { fs.rename(ic.path, v); }
        catch (e) {
          if (window.Taskbar) window.Taskbar.toast({ title: "Rename failed", body: e.message, kind: "error" });
        }
      }
      // Re-render — syncFromFs will pick up the rename anyway
      syncFromFs();
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  { e.preventDefault(); commit(true); }
      if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
  }

  /* --------------------------------------------------------------------------
   * Arrange icons (auto-grid)
   * ------------------------------------------------------------------------*/
  function arrangeIcons() {
    state.icons.forEach((i) => { delete i.x; delete i.y; });
    saveIcons();
    render();
    if (window.Taskbar) window.Taskbar.toast({ title: "Desktop", body: "Icons rearranged.", kind: "info" });
  }

  /* --------------------------------------------------------------------------
   * Refresh
   * ------------------------------------------------------------------------*/
  function refresh() {
    const desk = document.getElementById("desktop");
    if (desk) {
      desk.style.transition = "opacity .25s ease";
      desk.style.opacity = "0.6";
      setTimeout(() => { desk.style.opacity = "1"; }, 220);
    }
    render();
    if (window.Taskbar) window.Taskbar.toast({ title: "Refreshed", body: "Desktop refreshed.", kind: "info" });
  }

  /* --------------------------------------------------------------------------
   * Keyboard shortcuts on desktop
   * ------------------------------------------------------------------------*/
  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      // Only when no input is focused
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

      if (e.key === "Delete" && state.selection.size) {
        e.preventDefault(); deleteSelected();
      }
      if (e.key === "F2" && state.selection.size === 1) {
        e.preventDefault(); renameIcon(Array.from(state.selection)[0]);
      }
      if (e.key === "F5") {
        e.preventDefault(); refresh();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault(); selectAll();
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
    loadIcons();
    render();
    bindSelectionBox();
    bindContextMenu();
    bindKeyboard();

    // Re-sync when the filesystem changes anything under /Desktop or when the
    // recycle bin is emptied / restored.
    if (window.FileSystem && window.FileSystem.watch) {
      window.FileSystem.watch("/Desktop", () => {
        // simple debounce
        if (state._syncT) clearTimeout(state._syncT);
        state._syncT = setTimeout(() => syncFromFs(), 50);
      });
      window.FileSystem.watch("/Trash", () => {
        // For the recycle-bin icon visual cue (future: change icon when empty)
      });
    }

    console.log("%c[WebOS]%c Desktop ready (%d icons)",
      "color:#ec4899;font-weight:bold","color:inherit", state.icons.length);
    emit("desktopready", {});
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.Desktop = {
    init,
    addIcon, deleteSelected, renameIcon, arrangeIcons, refresh,
    addNewFolder, addNewFile,
    selectAll, clearSelection, selectOnly, selectAdd, selectToggle,
    syncFromFs,
    getIcons: () => state.icons.slice(),
    getSelection: () => Array.from(state.selection),
    // Restore previously hidden launcher icons
    restoreLauncher(id) {
      const list = safeGet("webos.desktopHiddenLaunchers", []) || [];
      const next = list.filter((x) => x !== id);
      safeSet("webos.desktopHiddenLaunchers", next);
      syncFromFs();
    },
    restoreAllLaunchers() {
      safeSet("webos.desktopHiddenLaunchers", []);
      syncFromFs();
    },
    on, subscribe,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
