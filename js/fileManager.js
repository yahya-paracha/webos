/* ============================================================================
 * WebOS — fileManager.js
 * ----------------------------------------------------------------------------
 * The File Manager application.
 *
 * Wires together:
 *   - apps/fileManager/fileManager.html (skeleton)
 *   - apps/fileManager/fileManager.css  (styles)
 *   - js/fileSystem.js                  (data layer)
 *   - js/contextMenus.js                (right-click menus)
 *   - js/windowManager.js               (window framework)
 *
 * Features
 * --------
 *   - Navigation with breadcrumbs + back/forward history
 *   - Sort by name / size / modified / type / extension (asc + desc)
 *   - Grid view + list view, persisted per-window
 *   - Cut / copy / paste, even across folders
 *   - Inline rename (F2) and delete (Del)
 *   - New folder (Ctrl+Shift+N) and new file
 *   - Drag-and-drop between folders + onto sidebar entries
 *   - Right-click context menus per file/folder
 *   - File preview panel (right side):
 *       text/code → content
 *       image     → rendered image / SVG
 *       folder    → child counts
 *       other     → big icon + metadata
 *   - Search within current folder
 *   - Multi-select with Ctrl+Click and Shift+Click
 *   - Keyboard navigation (arrow keys, Home/End)
 *   - Bookmarks persisted in localStorage
 *   - Live updates: subscribes to fs:* events and re-renders the view
 *
 * Each File Manager window is an independent FmController instance, so users
 * can open multiple windows pointing at different folders.
 *
 * Public API on  window.FileManagerApp
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------------*/
  const APP_ID                = "filemanager";
  const APP_TITLE             = "File Manager";
  const APP_ICON              = "📁";
  const HTML_URL              = "apps/fileManager/fileManager.html";
  const CSS_URL               = "apps/fileManager/fileManager.css";
  const STORAGE_KEY_VIEW      = "webos.fm.view";       // "grid" | "list"
  const STORAGE_KEY_SORT      = "webos.fm.sort";       // { by, dir }
  const STORAGE_KEY_PREVIEW   = "webos.fm.showPreview";// bool
  const STORAGE_KEY_BOOKMARKS = "webos.fm.bookmarks";  // [{path,name,icon}]
  const STORAGE_KEY_LASTPATH  = "webos.fm.lastPath";

  const HISTORY_MAX           = 64;

  /* --------------------------------------------------------------------------
   * Module-level state (shared across all FM windows)
   * ------------------------------------------------------------------------*/
  const moduleState = {
    htmlCache:     null,    // string of fileManager.html
    cssInjected:   false,
    initialized:   false,
    instances:     new Set(),
    bookmarks:     null,    // lazy-loaded
  };

  /* --------------------------------------------------------------------------
   * Tiny utilities
   * ------------------------------------------------------------------------*/
  function $(sel, root)  { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function loadCss() {
    if (moduleState.cssInjected) return;
    if (document.querySelector('link[data-fm-css]')) {
      moduleState.cssInjected = true;
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_URL;
    link.setAttribute("data-fm-css", "1");
    document.head.appendChild(link);
    moduleState.cssInjected = true;
  }

  // Built-in HTML fallback (so the app works even if file:// blocks fetch).
  // Kept identical to apps/fileManager/fileManager.html — used only if fetch fails.
  const FALLBACK_HTML = `
<div class="fm-root" data-view="grid" data-show-preview="false">
  <header class="fm-toolbar">
    <div class="fm-tb-group fm-tb-nav">
      <button class="fm-tb-btn" data-act="back"     title="Back"><span class="fm-tb-ico">◀</span></button>
      <button class="fm-tb-btn" data-act="forward"  title="Forward"><span class="fm-tb-ico">▶</span></button>
      <button class="fm-tb-btn" data-act="up"       title="Up"><span class="fm-tb-ico">▲</span></button>
      <button class="fm-tb-btn" data-act="refresh"  title="Refresh"><span class="fm-tb-ico">⟳</span></button>
    </div>
    <div class="fm-tb-group fm-tb-path-group">
      <div class="fm-breadcrumbs" id="fm-breadcrumbs"></div>
    </div>
    <div class="fm-tb-group fm-tb-search">
      <span class="fm-search-ico">🔎</span>
      <input type="text" class="fm-search-input" id="fm-search" placeholder="Search current folder…" />
      <button class="fm-tb-btn fm-search-clear" data-act="search-clear" hidden>✕</button>
    </div>
    <div class="fm-tb-group fm-tb-view">
      <button class="fm-tb-btn" data-act="view-grid" title="Grid view"><span class="fm-tb-ico">▦</span></button>
      <button class="fm-tb-btn" data-act="view-list" title="List view"><span class="fm-tb-ico">≡</span></button>
      <button class="fm-tb-btn" data-act="toggle-preview" title="Toggle preview"><span class="fm-tb-ico">▤</span></button>
    </div>
    <div class="fm-tb-group fm-tb-sort">
      <label class="fm-sort-label" for="fm-sort">Sort</label>
      <select class="fm-sort-select" id="fm-sort">
        <option value="name">Name</option>
        <option value="size">Size</option>
        <option value="modified">Date modified</option>
        <option value="type">Type</option>
        <option value="ext">Extension</option>
      </select>
      <button class="fm-tb-btn fm-sort-dir" data-act="sort-dir"><span class="fm-tb-ico" id="fm-sort-dir-ico">↑</span></button>
    </div>
    <div class="fm-tb-group fm-tb-actions">
      <button class="fm-tb-btn" data-act="new-folder" title="New folder"><span class="fm-tb-ico">📁</span><span class="fm-tb-text">New</span></button>
      <button class="fm-tb-btn" data-act="new-file"   title="New file"><span class="fm-tb-ico">📝</span></button>
      <button class="fm-tb-btn" data-act="upload"     title="Upload"><span class="fm-tb-ico">⬆</span></button>
    </div>
  </header>
  <div class="fm-body">
    <aside class="fm-sidebar" id="fm-sidebar">
      <section class="fm-side-section">
        <h4 class="fm-side-title">Quick access</h4>
        <ul class="fm-side-list" id="fm-side-quick">
          <li class="fm-side-item" data-path="/Desktop"><span class="fm-side-ico">🖥</span><span class="fm-side-label">Desktop</span></li>
          <li class="fm-side-item" data-path="/Documents"><span class="fm-side-ico">📄</span><span class="fm-side-label">Documents</span></li>
          <li class="fm-side-item" data-path="/Downloads"><span class="fm-side-ico">⬇</span><span class="fm-side-label">Downloads</span></li>
          <li class="fm-side-item" data-path="/Pictures"><span class="fm-side-ico">🖼</span><span class="fm-side-label">Pictures</span></li>
          <li class="fm-side-item" data-path="/Music"><span class="fm-side-ico">🎵</span><span class="fm-side-label">Music</span></li>
        </ul>
      </section>
      <section class="fm-side-section">
        <h4 class="fm-side-title">This PC</h4>
        <ul class="fm-side-list" id="fm-side-drives">
          <li class="fm-side-item" data-path="/"><span class="fm-side-ico">💽</span><span class="fm-side-label">Local Disk (C:)</span><span class="fm-side-meta" id="fm-side-disk-usage">—</span></li>
          <li class="fm-side-item" data-path="/System"><span class="fm-side-ico">⚙</span><span class="fm-side-label">System</span><span class="fm-side-tag">read-only</span></li>
        </ul>
      </section>
      <section class="fm-side-section">
        <h4 class="fm-side-title">Bookmarks</h4>
        <ul class="fm-side-list" id="fm-side-bookmarks"></ul>
        <button class="fm-side-add" id="fm-bookmark-add"><span>＋</span><span>Add current folder</span></button>
      </section>
      <section class="fm-side-section">
        <h4 class="fm-side-title">System</h4>
        <ul class="fm-side-list" id="fm-side-system">
          <li class="fm-side-item" data-path="/Trash"><span class="fm-side-ico">🗑</span><span class="fm-side-label">Recycle Bin</span><span class="fm-side-meta" id="fm-side-trash-count">0</span></li>
        </ul>
      </section>
    </aside>
    <main class="fm-main" id="fm-main">
      <div class="fm-drop-overlay" id="fm-drop-overlay" hidden>
        <div class="fm-drop-card">
          <div class="fm-drop-ico">📥</div>
          <div class="fm-drop-text">Drop here to move</div>
        </div>
      </div>
      <section class="fm-content" id="fm-content" tabindex="0">
        <div class="fm-empty" id="fm-empty" hidden>
          <div class="fm-empty-ico">📂</div>
          <div class="fm-empty-title">This folder is empty</div>
          <div class="fm-empty-sub">Use the toolbar to create something new.</div>
        </div>
        <div class="fm-grid" id="fm-grid"></div>
        <table class="fm-list" id="fm-list" hidden>
          <thead><tr>
            <th data-sort="name">Name</th>
            <th data-sort="modified">Date modified</th>
            <th data-sort="type">Type</th>
            <th data-sort="size">Size</th>
          </tr></thead>
          <tbody id="fm-list-body"></tbody>
        </table>
        <div class="fm-search-results" id="fm-search-results" hidden>
          <h4 class="fm-search-title">Search results</h4>
          <div class="fm-search-list" id="fm-search-list"></div>
        </div>
      </section>
      <aside class="fm-preview" id="fm-preview" hidden>
        <header class="fm-prev-head">
          <div class="fm-prev-icon" id="fm-prev-icon">📄</div>
          <div class="fm-prev-meta">
            <div class="fm-prev-name" id="fm-prev-name">No selection</div>
            <div class="fm-prev-path" id="fm-prev-path">—</div>
          </div>
          <button class="fm-prev-close" id="fm-prev-close">✕</button>
        </header>
        <div class="fm-prev-body" id="fm-prev-body">
          <div class="fm-prev-empty">Select a file to see its preview here.</div>
        </div>
        <footer class="fm-prev-foot">
          <div class="fm-prev-row"><span>Type</span><strong id="fm-prev-type">—</strong></div>
          <div class="fm-prev-row"><span>Size</span><strong id="fm-prev-size">—</strong></div>
          <div class="fm-prev-row"><span>Modified</span><strong id="fm-prev-modified">—</strong></div>
        </footer>
      </aside>
    </main>
  </div>
  <footer class="fm-statusbar">
    <div class="fm-st-left"><span id="fm-st-count">0 items</span></div>
    <div class="fm-st-mid"><span id="fm-st-selected"></span></div>
    <div class="fm-st-right"><span id="fm-st-disk">—</span></div>
  </footer>
  <input type="file" id="fm-file-picker" multiple hidden />
</div>
`;

  /* --------------------------------------------------------------------------
   * HTML loading (with fallback)
   * ------------------------------------------------------------------------*/
  async function loadHtml() {
    if (moduleState.htmlCache) return moduleState.htmlCache;
    try {
      const r = await fetch(HTML_URL, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const txt = await r.text();
      if (txt && txt.indexOf("fm-root") !== -1) {
        moduleState.htmlCache = txt;
        return txt;
      }
    } catch (e) {
      console.warn("[FileManager] failed to fetch HTML, using fallback:", e);
    }
    moduleState.htmlCache = FALLBACK_HTML;
    return FALLBACK_HTML;
  }

  /* --------------------------------------------------------------------------
   * Bookmarks
   * ------------------------------------------------------------------------*/
  function getBookmarks() {
    if (moduleState.bookmarks) return moduleState.bookmarks;
    const stored = safeGet(STORAGE_KEY_BOOKMARKS, null);
    moduleState.bookmarks = Array.isArray(stored) ? stored : defaultBookmarks();
    return moduleState.bookmarks;
  }
  function defaultBookmarks() {
    return [
      { path: "/Documents", name: "Documents", icon: "📄" },
    ];
  }
  function saveBookmarks() {
    safeSet(STORAGE_KEY_BOOKMARKS, moduleState.bookmarks || []);
    moduleState.instances.forEach((inst) => inst.renderBookmarks && inst.renderBookmarks());
  }
  function isBookmarked(path) {
    return getBookmarks().some((b) => b.path === path);
  }
  function addBookmark(path, name, icon) {
    const list = getBookmarks();
    if (isBookmarked(path)) return false;
    list.push({ path, name: name || path.split("/").pop() || path, icon: icon || "📁" });
    saveBookmarks();
    return true;
  }
  function removeBookmark(path) {
    const list = getBookmarks();
    const idx = list.findIndex((b) => b.path === path);
    if (idx === -1) return false;
    list.splice(idx, 1);
    saveBookmarks();
    return true;
  }

  /* --------------------------------------------------------------------------
   * FmController — one instance per File Manager window
   * ------------------------------------------------------------------------*/
  class FmController {
    constructor(body, win, opts) {
      this.body = body;          // window body element (already contains html)
      this.win  = win;           // WebOSWindow instance
      this.opts = opts || {};
      this.fs   = window.FileSystem;

      // navigation state
      this.cwd        = window.FileSystem
        ? window.FileSystem.normalizePath(opts.startPath || safeGet(STORAGE_KEY_LASTPATH, "/Documents"))
        : (opts.startPath || "/Documents");
      this.history    = [this.cwd];
      this.historyIdx = 0;

      // view state
      const view = safeGet(STORAGE_KEY_VIEW, "grid");
      const sort = safeGet(STORAGE_KEY_SORT, { by: "name", dir: "asc" });
      this.viewMode  = (view === "list") ? "list" : "grid";
      this.sortBy    = sort && sort.by  ? sort.by  : "name";
      this.sortDir   = sort && sort.dir ? sort.dir : "asc";
      this.showPrev  = !!safeGet(STORAGE_KEY_PREVIEW, false);

      // selection state
      this.selection      = new Set();   // set of paths
      this.lastSelected   = null;        // for shift-click anchor
      this.searchQuery    = "";
      this.entries        = [];          // current rendered entries
      this.lastClickAt    = 0;
      this.lastClickPath  = null;

      // event bookkeeping
      this.unsubFs = null;

      // Cached element references
      this.refs = {};

      // bind methods that get used as event handlers
      this.onContentClick     = this.onContentClick.bind(this);
      this.onContentDblClick  = this.onContentDblClick.bind(this);
      this.onContentContext   = this.onContentContext.bind(this);
      this.onKeyDown          = this.onKeyDown.bind(this);
      this.onSearchInput      = debounce(this.applySearch.bind(this), 100);
      this.onWindowFocus      = this.onWindowFocus.bind(this);
      this.handleFsEvent      = this.handleFsEvent.bind(this);
      this.refresh            = this.refresh.bind(this);

      this.init();
    }

    /* ---------------------------------------------------------------------- */
    init() {
      this.cacheRefs();
      this.applyInitialState();
      this.bindToolbar();
      this.bindSidebar();
      this.bindContent();
      this.bindKeyboard();
      this.bindDragAndDrop();
      this.bindPreviewClose();
      this.bindFsEvents();
      this.renderBookmarks();
      this.navigate(this.cwd, { replace: true });
    }

    cacheRefs() {
      const r = this.refs;
      const $b = (id) => this.body.querySelector("#" + id);
      r.root        = this.body.querySelector(".fm-root");
      r.toolbar     = this.body.querySelector(".fm-toolbar");
      r.crumbs      = $b("fm-breadcrumbs");
      r.search      = $b("fm-search");
      r.searchClear = this.body.querySelector('[data-act="search-clear"]');
      r.sortSel     = $b("fm-sort");
      r.sortDirIco  = $b("fm-sort-dir-ico");
      r.content     = $b("fm-content");
      r.empty       = $b("fm-empty");
      r.grid        = $b("fm-grid");
      r.list        = $b("fm-list");
      r.listBody    = $b("fm-list-body");
      r.searchPane  = $b("fm-search-results");
      r.searchList  = $b("fm-search-list");
      r.dropOverlay = $b("fm-drop-overlay");
      r.preview     = $b("fm-preview");
      r.prevIcon    = $b("fm-prev-icon");
      r.prevName    = $b("fm-prev-name");
      r.prevPath    = $b("fm-prev-path");
      r.prevBody    = $b("fm-prev-body");
      r.prevType    = $b("fm-prev-type");
      r.prevSize    = $b("fm-prev-size");
      r.prevMod     = $b("fm-prev-modified");
      r.prevClose   = $b("fm-prev-close");
      r.statCount   = $b("fm-st-count");
      r.statSel     = $b("fm-st-selected");
      r.statDisk    = $b("fm-st-disk");
      r.sideQuick   = $b("fm-side-quick");
      r.sideDrives  = $b("fm-side-drives");
      r.sideBooks   = $b("fm-side-bookmarks");
      r.sideSystem  = $b("fm-side-system");
      r.bmAdd       = $b("fm-bookmark-add");
      r.diskUsage   = $b("fm-side-disk-usage");
      r.trashCount  = $b("fm-side-trash-count");
      r.filePicker  = $b("fm-file-picker");
    }

    applyInitialState() {
      const r = this.refs;
      r.root.dataset.view = this.viewMode;
      r.root.dataset.showPreview = this.showPrev ? "true" : "false";
      if (r.preview) r.preview.hidden = !this.showPrev;
      if (r.sortSel) r.sortSel.value = this.sortBy;
      if (r.sortDirIco) r.sortDirIco.textContent = this.sortDir === "asc" ? "↑" : "↓";
    }

    /* ---------------------------------------------------------------------- *
     * Sidebar / toolbar bindings
     * ---------------------------------------------------------------------- */
    bindSidebar() {
      const r = this.refs;

      const sideClick = (ul) => {
        if (!ul) return;
        ul.addEventListener("click", (e) => {
          const li = e.target.closest(".fm-side-item");
          if (!li) return;
          const path = li.dataset.path;
          if (!path) return;
          this.navigate(path);
        });
      };
      sideClick(r.sideQuick);
      sideClick(r.sideDrives);
      sideClick(r.sideSystem);
      sideClick(r.sideBooks);

      // bookmark add
      if (r.bmAdd) {
        r.bmAdd.addEventListener("click", () => {
          if (this.cwd === "/") return;
          if (isBookmarked(this.cwd)) {
            removeBookmark(this.cwd);
            this.flash("Bookmark removed");
          } else {
            const md = this.fs.getMetadata(this.cwd);
            addBookmark(this.cwd, md.name || this.cwd, md.icon || "📁");
            this.flash("Bookmark added");
          }
        });
      }

      // sidebar drag-over: dropping selection moves into that folder
      [r.sideQuick, r.sideDrives, r.sideSystem, r.sideBooks].forEach((ul) => {
        if (!ul) return;
        ul.addEventListener("dragover", (e) => {
          const li = e.target.closest(".fm-side-item");
          if (!li) return;
          const dest = li.dataset.path;
          if (!dest) return;
          // don't allow dropping onto System
          if (dest === "/System") return;
          e.preventDefault();
          li.classList.add("is-drop-target");
        });
        ul.addEventListener("dragleave", (e) => {
          const li = e.target.closest(".fm-side-item");
          if (li) li.classList.remove("is-drop-target");
        });
        ul.addEventListener("drop", (e) => {
          const li = e.target.closest(".fm-side-item");
          if (!li) return;
          li.classList.remove("is-drop-target");
          const dest = li.dataset.path;
          if (!dest) return;
          e.preventDefault();
          this.dropOntoFolder(dest, e);
        });
      });

      // right-click on bookmarks → remove
      if (r.sideBooks) {
        r.sideBooks.addEventListener("contextmenu", (e) => {
          const li = e.target.closest(".fm-side-item");
          if (!li) return;
          e.preventDefault();
          const path = li.dataset.path;
          window.ContextMenu && window.ContextMenu.show({
            x: e.clientX, y: e.clientY,
            items: [
              { label: "Open",         icon: "📂", action: () => this.navigate(path) },
              { separator: true },
              { label: "Remove bookmark", icon: "✕", danger: true,
                action: () => { removeBookmark(path); this.flash("Bookmark removed"); } },
            ],
          });
        });
      }
    }

    bindToolbar() {
      const r = this.refs;
      r.toolbar.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        switch (act) {
          case "back":            this.goBack(); break;
          case "forward":         this.goForward(); break;
          case "up":              this.goUp(); break;
          case "refresh":         this.refresh(); break;
          case "view-grid":       this.setView("grid"); break;
          case "view-list":       this.setView("list"); break;
          case "toggle-preview":  this.togglePreview(); break;
          case "sort-dir":        this.toggleSortDir(); break;
          case "search-clear":    this.clearSearch(); break;
          case "new-folder":      this.newFolder(); break;
          case "new-file":        this.newFile(); break;
          case "upload":          this.openFilePicker(); break;
        }
      });
      r.sortSel && r.sortSel.addEventListener("change", () => {
        this.sortBy = r.sortSel.value;
        this.persistSort();
        this.render();
      });
      // Header click in list view → sort by that column
      if (r.list) {
        const thead = r.list.querySelector("thead");
        if (thead) {
          thead.addEventListener("click", (e) => {
            const th = e.target.closest("th[data-sort]");
            if (!th) return;
            const by = th.dataset.sort;
            if (this.sortBy === by) this.toggleSortDir();
            else { this.sortBy = by; r.sortSel.value = by; this.persistSort(); this.render(); }
          });
        }
      }
      // Search input
      if (r.search) {
        r.search.addEventListener("input", () => {
          this.searchQuery = r.search.value || "";
          if (r.searchClear) r.searchClear.hidden = !this.searchQuery;
          this.onSearchInput();
        });
        r.search.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.preventDefault(); this.clearSearch(); }
          if (e.key === "Enter") {
            // open the first result
            const first = this.refs.searchList.querySelector(".fm-search-row");
            if (first) first.click();
          }
        });
      }
      // File picker (upload) bindings — files become text reads
      if (r.filePicker) {
        r.filePicker.addEventListener("change", (e) => this.onFilesChosen(e.target.files));
      }
    }

    bindContent() {
      const r = this.refs;
      r.content.addEventListener("click",       this.onContentClick);
      r.content.addEventListener("dblclick",    this.onContentDblClick);
      r.content.addEventListener("contextmenu", this.onContentContext);
      // selection rectangle (drag on empty space)
      r.content.addEventListener("pointerdown", (e) => this.onContentPointerDown(e));
    }

    bindKeyboard() {
      this.body.addEventListener("keydown", this.onKeyDown);
    }

    bindPreviewClose() {
      if (this.refs.prevClose) {
        this.refs.prevClose.addEventListener("click", () => this.togglePreview(false));
      }
    }

    bindFsEvents() {
      if (!this.fs || !this.fs.watch) return;
      // watch the root, since users may move things across folders
      this.unsubFs = this.fs.watch("/", this.handleFsEvent);
    }

    handleFsEvent(name, detail) {
      // crude but effective: any change → re-render current cwd
      // also if the cwd was itself moved/renamed, follow the rename.
      if (!this.fs) return;
      if (detail && detail.from && (detail.from === this.cwd || this.cwd.indexOf(detail.from + "/") === 0)) {
        if (detail.to) {
          const newCwd = this.cwd === detail.from
            ? detail.to
            : detail.to + this.cwd.slice(detail.from.length);
          this.cwd = this.fs.normalizePath(newCwd);
          // patch history entries
          this.history = this.history.map((h) =>
            h === detail.from ? detail.to :
            h.indexOf(detail.from + "/") === 0 ? detail.to + h.slice(detail.from.length) : h);
        }
      }
      // if cwd no longer exists, climb up
      if (!this.fs.exists(this.cwd)) {
        const parent = this.fs.dirname(this.cwd);
        this.cwd = this.fs.exists(parent) ? parent : "/";
      }
      this.render();
      this.updateBadges();
    }

    onWindowFocus() {
      // Refresh on focus in case something changed externally
      this.render();
    }

    /* ---------------------------------------------------------------------- *
     * Navigation
     * ---------------------------------------------------------------------- */
    navigate(path, opts) {
      const o = opts || {};
      if (!this.fs) return;
      const p = this.fs.normalizePath(path);
      if (!this.fs.exists(p)) {
        this.flash("Folder not found: " + p, "error");
        return false;
      }
      if (!this.fs.isFolder(p)) {
        // open file with default app
        return this.openFile(p);
      }

      if (o.replace) {
        this.history    = [p];
        this.historyIdx = 0;
      } else if (p !== this.cwd) {
        // truncate forward history
        this.history = this.history.slice(0, this.historyIdx + 1);
        this.history.push(p);
        if (this.history.length > HISTORY_MAX) {
          this.history.shift();
        } else {
          this.historyIdx++;
        }
      }
      this.cwd = p;
      safeSet(STORAGE_KEY_LASTPATH, p);

      // clear selection on navigate
      this.selection.clear();
      this.lastSelected = null;
      // clear search on navigate
      if (this.searchQuery) {
        this.searchQuery = "";
        if (this.refs.search) this.refs.search.value = "";
        if (this.refs.searchClear) this.refs.searchClear.hidden = true;
      }
      // update window title
      try {
        const md = this.fs.getMetadata(p);
        const title = (p === "/") ? "File Manager — Root" : "File Manager — " + md.name;
        if (this.win && this.win.setTitle) this.win.setTitle(title);
        else if (this.win && this.win.el) {
          const t = this.win.el.querySelector(".window-title-text");
          if (t) t.textContent = title;
        }
      } catch (_) {}

      this.render();
      this.updateBadges();
      return true;
    }

    canGoBack()    { return this.historyIdx > 0; }
    canGoForward() { return this.historyIdx < this.history.length - 1; }

    goBack() {
      if (!this.canGoBack()) return;
      this.historyIdx--;
      this.cwd = this.history[this.historyIdx];
      this.selection.clear();
      this.render();
    }
    goForward() {
      if (!this.canGoForward()) return;
      this.historyIdx++;
      this.cwd = this.history[this.historyIdx];
      this.selection.clear();
      this.render();
    }
    goUp() {
      if (!this.fs) return;
      const parent = this.fs.dirname(this.cwd);
      if (parent === this.cwd) return;
      this.navigate(parent);
    }

    refresh() {
      this.render();
      this.updateBadges();
    }

    /* ---------------------------------------------------------------------- *
     * Render
     * ---------------------------------------------------------------------- */
    render() {
      if (!this.fs) return;
      const r = this.refs;
      // search mode?
      if (this.searchQuery) {
        r.root.classList.add("is-searching");
        this.renderSearchResults();
        this.renderBreadcrumbs();
        this.updateNavButtons();
        this.updateStatusBar();
        this.renderSidebarHighlight();
        return;
      }
      r.root.classList.remove("is-searching");

      let entries = [];
      try {
        entries = this.fs.listDir(this.cwd, { sortBy: this.sortBy, sortDir: this.sortDir, computeFolderSize: false });
      } catch (e) {
        this.flash(e.message || "Cannot read folder", "error");
        entries = [];
      }
      this.entries = entries;

      this.renderBreadcrumbs();
      this.updateNavButtons();
      this.renderSidebarHighlight();

      // render grid
      r.grid.innerHTML = entries.map((e) => this.gridItemHtml(e)).join("");
      // render list
      r.listBody.innerHTML = entries.map((e) => this.listRowHtml(e)).join("");
      // empty?
      r.empty.hidden = entries.length > 0;

      // bind per-item event handlers (delegation already done on container)
      this.applySelectionStyles();
      this.applyClipboardCutStyles();
      this.updatePreview();
      this.updateStatusBar();
    }

    renderBreadcrumbs() {
      const r = this.refs;
      if (!r.crumbs || !this.fs) return;
      const parts = this.fs.breadcrumbs(this.cwd);
      const html = parts.map((c, i) => {
        const last = i === parts.length - 1;
        return `${i > 0 ? '<span class="fm-crumb-sep">›</span>' : ""}` +
               `<span class="fm-crumb${last ? " is-current" : ""}" data-path="${escapeHtml(c.path)}">${escapeHtml(c.name === "Root" ? "💽 Root" : c.name)}</span>`;
      }).join("");
      r.crumbs.innerHTML = html;
      r.crumbs.querySelectorAll(".fm-crumb").forEach((el) => {
        el.addEventListener("click", () => this.navigate(el.dataset.path));
      });
    }

    gridItemHtml(e) {
      const sel = this.selection.has(e.path) ? " is-selected" : "";
      const ro  = e.readonly ? `<span class="fm-item-ro-badge">RO</span>` : "";
      const meta= e.type === "folder"
        ? (e.childCount + (e.childCount === 1 ? " item" : " items"))
        : this.fs.formatBytes(e.size || 0);
      return `
        <div class="fm-item${sel}" role="listitem" tabindex="0"
             data-path="${escapeHtml(e.path)}" data-type="${e.type}" draggable="true">
          <div class="fm-item-icon" data-kind="${escapeHtml(e.kind || (e.type === "folder" ? "folder" : "binary"))}">
            ${escapeHtml(e.icon || (e.type === "folder" ? "📁" : "📄"))}
            ${ro}
          </div>
          <div class="fm-item-label">${escapeHtml(e.name)}</div>
          <div class="fm-item-meta">${escapeHtml(meta)}</div>
        </div>
      `;
    }

    listRowHtml(e) {
      const sel = this.selection.has(e.path) ? " is-selected" : "";
      const typeLabel = e.type === "folder" ? "Folder" : (e.kind || "file");
      return `
        <tr class="fm-list-row${sel}" data-path="${escapeHtml(e.path)}" data-type="${e.type}" draggable="true">
          <td class="fm-list-name">
            <span class="fm-list-icon" data-kind="${escapeHtml(e.kind || (e.type === "folder" ? "folder" : "binary"))}">${escapeHtml(e.icon || (e.type === "folder" ? "📁" : "📄"))}</span>
            <span class="fm-list-label">${escapeHtml(e.name)}</span>
          </td>
          <td>${escapeHtml(this.fs.formatDate(e.modified))}</td>
          <td>${escapeHtml(typeLabel)}</td>
          <td>${e.type === "folder" ? "—" : escapeHtml(this.fs.formatBytes(e.size || 0))}</td>
        </tr>
      `;
    }

    renderSearchResults() {
      const r = this.refs;
      if (!r.searchList || !this.fs) return;
      const results = this.fs.searchFiles(this.searchQuery, {
        root: this.cwd,
        limit: 200,
        showHidden: false,
        inContent: true,
      });
      r.searchList.innerHTML = results.length
        ? results.map((res) => `
            <div class="fm-search-row${this.selection.has(res.path) ? " is-selected" : ""}"
                 data-path="${escapeHtml(res.path)}"
                 data-type="${res.type}">
              <span class="fm-search-row-ico" data-kind="${escapeHtml(res.kind || (res.type === "folder" ? "folder" : "binary"))}">${escapeHtml(res.icon || (res.type === "folder" ? "📁" : "📄"))}</span>
              <span class="fm-search-row-label">${escapeHtml(res.name)}</span>
              <span class="fm-search-row-path">${escapeHtml(this.fs.dirname(res.path))}</span>
            </div>
          `).join("")
        : `<div class="fm-prev-empty" style="padding:24px;">No matches in this folder.</div>`;
    }

    applySelectionStyles() {
      const r = this.refs;
      r.grid.querySelectorAll(".fm-item").forEach((el) => {
        el.classList.toggle("is-selected", this.selection.has(el.dataset.path));
      });
      r.listBody.querySelectorAll(".fm-list-row").forEach((el) => {
        el.classList.toggle("is-selected", this.selection.has(el.dataset.path));
      });
      if (this.refs.searchList) {
        this.refs.searchList.querySelectorAll(".fm-search-row").forEach((el) => {
          el.classList.toggle("is-selected", this.selection.has(el.dataset.path));
        });
      }
    }

    applyClipboardCutStyles() {
      if (!this.fs || !this.fs.getClipboard) return;
      const clip = this.fs.getClipboard();
      const cutSet = new Set(clip.op === "cut" ? clip.paths : []);
      const r = this.refs;
      r.grid.querySelectorAll(".fm-item").forEach((el) => {
        el.classList.toggle("is-cut", cutSet.has(el.dataset.path));
      });
      r.listBody.querySelectorAll(".fm-list-row").forEach((el) => {
        el.classList.toggle("is-cut", cutSet.has(el.dataset.path));
      });
    }

    updateNavButtons() {
      const r = this.refs;
      r.toolbar.querySelectorAll('[data-act="back"]').forEach((b) => b.disabled = !this.canGoBack());
      r.toolbar.querySelectorAll('[data-act="forward"]').forEach((b) => b.disabled = !this.canGoForward());
      r.toolbar.querySelectorAll('[data-act="up"]').forEach((b) => b.disabled = this.cwd === "/");
      r.toolbar.querySelectorAll('[data-act="view-grid"]').forEach((b) => b.classList.toggle("is-active", this.viewMode === "grid"));
      r.toolbar.querySelectorAll('[data-act="view-list"]').forEach((b) => b.classList.toggle("is-active", this.viewMode === "list"));
      r.toolbar.querySelectorAll('[data-act="toggle-preview"]').forEach((b) => b.classList.toggle("is-active", this.showPrev));
      if (r.sortDirIco) r.sortDirIco.textContent = this.sortDir === "asc" ? "↑" : "↓";
    }

    renderSidebarHighlight() {
      const r = this.refs;
      [r.sideQuick, r.sideDrives, r.sideSystem, r.sideBooks].forEach((ul) => {
        if (!ul) return;
        ul.querySelectorAll(".fm-side-item").forEach((li) => {
          li.classList.toggle("is-current", li.dataset.path === this.cwd);
        });
      });
    }

    renderBookmarks() {
      const r = this.refs;
      if (!r.sideBooks) return;
      const list = getBookmarks();
      if (!list.length) {
        r.sideBooks.innerHTML = `<li class="fm-side-empty" style="padding:6px 12px;font-size:11px;opacity:.55;">No bookmarks yet.</li>`;
        return;
      }
      r.sideBooks.innerHTML = list.map((b) => `
        <li class="fm-side-item" data-path="${escapeHtml(b.path)}">
          <span class="fm-side-ico">${escapeHtml(b.icon || "📁")}</span>
          <span class="fm-side-label">${escapeHtml(b.name || b.path)}</span>
          <button class="fm-side-bookmark-remove" data-remove="${escapeHtml(b.path)}" title="Remove bookmark">✕</button>
        </li>
      `).join("");
      // re-bind remove buttons
      r.sideBooks.querySelectorAll(".fm-side-bookmark-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          removeBookmark(btn.dataset.remove);
          this.flash("Bookmark removed");
        });
      });
      // selection class
      this.renderSidebarHighlight();
    }

    updateBadges() {
      const r = this.refs;
      if (!this.fs) return;
      try {
        if (r.diskUsage) {
          const du = this.fs.diskUsage();
          r.diskUsage.textContent = du.pretty;
          if (r.statDisk) r.statDisk.textContent = du.files + " files · " + du.pretty;
        }
        if (r.trashCount) {
          const t = this.fs.listTrash();
          r.trashCount.textContent = String(t.length);
        }
      } catch (_) {}
    }

    /* ---------------------------------------------------------------------- *
     * Selection
     * ---------------------------------------------------------------------- */
    selectOnly(path) {
      this.selection.clear();
      if (path) this.selection.add(path);
      this.lastSelected = path || null;
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    selectAdd(path) {
      this.selection.add(path);
      this.lastSelected = path;
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    selectToggle(path) {
      if (this.selection.has(path)) this.selection.delete(path);
      else this.selection.add(path);
      this.lastSelected = path;
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    selectRange(toPath) {
      // shift-click: select from lastSelected to toPath inclusive (within current entries)
      const ids = this.entries.map((e) => e.path);
      if (!this.lastSelected || !ids.includes(this.lastSelected)) {
        this.selection.add(toPath);
        this.lastSelected = toPath;
      } else {
        const a = ids.indexOf(this.lastSelected);
        const b = ids.indexOf(toPath);
        if (a === -1 || b === -1) { this.selection.add(toPath); }
        else {
          const [from, to] = a < b ? [a, b] : [b, a];
          for (let i = from; i <= to; i++) this.selection.add(ids[i]);
        }
      }
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    selectAll() {
      this.entries.forEach((e) => this.selection.add(e.path));
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    clearSelection() {
      this.selection.clear();
      this.lastSelected = null;
      this.applySelectionStyles();
      this.updatePreview();
      this.updateStatusBar();
    }
    getSelection() { return Array.from(this.selection); }

    /* ---------------------------------------------------------------------- *
     * Click handling
     * ---------------------------------------------------------------------- */
    onContentClick(e) {
      const item = e.target.closest(".fm-item, .fm-list-row, .fm-search-row");
      if (!item) {
        // empty area click → clear selection (unless modifier)
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) this.clearSelection();
        return;
      }
      const path = item.dataset.path;
      if (e.shiftKey) {
        this.selectRange(path);
      } else if (e.ctrlKey || e.metaKey) {
        this.selectToggle(path);
      } else {
        this.selectOnly(path);
        // Double-click detection (some browsers don't fire dblclick on items)
        const now = Date.now();
        if (this.lastClickPath === path && (now - this.lastClickAt) < 350) {
          this.openPath(path);
          this.lastClickAt = 0;
          this.lastClickPath = null;
          return;
        }
        this.lastClickAt = now;
        this.lastClickPath = path;
      }
    }
    onContentDblClick(e) {
      const item = e.target.closest(".fm-item, .fm-list-row, .fm-search-row");
      if (!item) return;
      this.openPath(item.dataset.path);
    }

    onContentContext(e) {
      const item = e.target.closest(".fm-item, .fm-list-row, .fm-search-row");
      e.preventDefault();
      if (!window.ContextMenu) return;
      if (!item) {
        // empty area
        const items = this.buildEmptyAreaMenu();
        window.ContextMenu.show({ x: e.clientX, y: e.clientY, items });
        return;
      }
      const path = item.dataset.path;
      // ensure the right-clicked item is selected (without clobbering existing selection if it is one of them)
      if (!this.selection.has(path)) this.selectOnly(path);

      const md = this.fs.getMetadata(path);
      const detail = {
        onOpen:   (p) => this.openPath(p),
        onRename: (p) => this.beginRename(p),
      };
      let items = md.type === "folder"
        ? window.ContextMenu.forFolder(path, detail)
        : window.ContextMenu.forFile(path, detail);

      // If browsing /Trash, prepend Restore to the menu.
      if (this.isInTrash()) {
        items = [
          { label: "Restore", icon: "↩",
            action: () => this.restoreSelection() },
          { separator: true },
          { label: "Delete permanently", icon: "🗑", danger: true,
            action: () => {
              const sel = this.getSelection();
              if (!sel.length) return;
              if (!window.confirm("Delete " + sel.length + " item(s) permanently?")) return;
              sel.forEach((p) => { try { this.fs.deleteFile(p, { permanent: true }); } catch (_) {} });
              this.selection.clear();
              this.render();
              this.updateBadges();
            },
          },
          { separator: true },
          { label: "Properties", icon: "ⓘ",
            action: () => this.showInlineProperties(path) },
        ];
      } else {
        // Replace the generic Properties handler with our inline one
        items = items.map((it) => {
          if (it && it.label === "Properties") {
            return { label: "Properties", icon: "ⓘ",
              action: () => this.showInlineProperties(path) };
          }
          return it;
        });
      }
      window.ContextMenu.show({ x: e.clientX, y: e.clientY, items });
    }

    buildEmptyAreaMenu() {
      const fs = this.fs;
      const cwd = this.cwd;
      const ro = (() => {
        try { return fs.getMetadata(cwd).readonly; } catch (_) { return true; }
      })();
      const inTrash = this.isInTrash();
      const items = [
        { label: "Refresh",     icon: "⟳", accelerator: "F5", action: () => this.refresh() },
        { separator: true },
        { label: "New folder",  icon: "📁", accelerator: "Ctrl+Shift+N", disabled: ro,
          action: () => this.newFolder() },
        { label: "New text file", icon: "📝", disabled: ro,
          action: () => this.newFile() },
        { separator: true },
        { label: "Paste",       icon: "📥", accelerator: "Ctrl+V",
          disabled: ro || (fs.getClipboard && fs.getClipboard().empty),
          action: () => this.pasteHere() },
        { label: "Paste with options…", icon: "⋮",
          disabled: ro || (fs.getClipboard && fs.getClipboard().empty),
          action: () => this.pasteWithOptions() },
        { label: "Select all",  icon: "▣", accelerator: "Ctrl+A",
          action: () => this.selectAll() },
        { separator: true },
      ];
      if (inTrash) {
        items.push({ label: "Empty Trash", icon: "🗑", danger: true,
          action: () => this.emptyTrash() });
        items.push({ separator: true });
      }
      items.push(
        { label: "Open in Terminal", icon: "⌨",
          action: () => window.WindowManager && window.WindowManager.openApp("terminal", { cwd }) },
        { label: "Properties",  icon: "ⓘ",
          action: () => this.showInlineProperties(cwd) }
      );
      return items;
    }

    /* ---------------------------------------------------------------------- *
     * Open
     * ---------------------------------------------------------------------- */
    openPath(path) {
      if (!this.fs.exists(path)) return;
      const md = this.fs.getMetadata(path);
      if (md.type === "folder") {
        this.navigate(path);
      } else {
        this.openFile(path);
      }
    }
    openFile(path) {
      if (window.ContextMenu && window.ContextMenu.openFileWithDefaultApp) {
        window.ContextMenu.openFileWithDefaultApp(path);
        if (this.fs && this.fs.pushRecent) this.fs.pushRecent(path, "open");
      }
    }

    /* ---------------------------------------------------------------------- *
     * Rename
     * ---------------------------------------------------------------------- */
    beginRename(path) {
      const r = this.refs;
      if (this.viewMode === "grid") {
        const el = r.grid.querySelector(`.fm-item[data-path="${cssEscape(path)}"]`);
        if (!el) return;
        const labelEl = el.querySelector(".fm-item-label");
        this._inlineRename(labelEl, path, "input");
      } else {
        const tr = r.listBody.querySelector(`tr[data-path="${cssEscape(path)}"]`);
        if (!tr) return;
        const labelEl = tr.querySelector(".fm-list-label");
        this._inlineRename(labelEl, path, "input-list");
      }
    }
    _inlineRename(labelEl, path, mode) {
      if (!labelEl) return;
      const md = this.fs.getMetadata(path);
      const original = md.name;
      const input = document.createElement("input");
      input.type = "text";
      input.value = original;
      input.className = "fm-item-rename";
      // adapt to view
      if (mode === "input-list") {
        input.style.width = "100%";
        input.style.textAlign = "left";
      }
      labelEl.replaceWith(input);
      input.focus();
      // Pre-select stem only (before extension), like real OSes
      const dot = original.lastIndexOf(".");
      if (md.type === "file" && dot > 0) input.setSelectionRange(0, dot);
      else input.select();

      const commit = (save) => {
        const v = input.value.trim();
        if (save && v && v !== original) {
          try {
            this.fs.rename(path, v);
            this.flash("Renamed", "success");
          } catch (e) {
            this.flash(e.message || "Rename failed", "error");
          }
        }
        this.render();
      };
      input.addEventListener("blur", () => commit(true));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter")  { e.preventDefault(); commit(true); }
        if (e.key === "Escape") { e.preventDefault(); commit(false); }
      });
    }

    /* ---------------------------------------------------------------------- *
     * Create / delete / clipboard
     * ---------------------------------------------------------------------- */
    newFolder() {
      let name = "New Folder", i = 1;
      while (this.fs.exists(this.fs.joinPath(this.cwd, name))) {
        i++; name = "New Folder (" + i + ")";
      }
      try {
        const md = this.fs.createFolder(this.fs.joinPath(this.cwd, name));
        this.render();
        // begin rename on the new item
        setTimeout(() => {
          this.selectOnly(md.path);
          this.beginRename(md.path);
        }, 50);
      } catch (e) { this.flash(e.message, "error"); }
    }
    newFile() {
      let name = "New Text Document.txt", i = 1;
      while (this.fs.exists(this.fs.joinPath(this.cwd, name))) {
        i++; name = "New Text Document (" + i + ").txt";
      }
      try {
        const md = this.fs.writeFile(this.fs.joinPath(this.cwd, name), "");
        this.render();
        setTimeout(() => {
          this.selectOnly(md.path);
          this.beginRename(md.path);
        }, 50);
      } catch (e) { this.flash(e.message, "error"); }
    }

    deleteSelected(opts) {
      const o = opts || {};
      const sel = this.getSelection();
      if (!sel.length) return;
      const ok = o.skipConfirm ? true : window.confirm(
        sel.length === 1
          ? `Move "${this.fs.basename(sel[0])}" to Trash?`
          : `Move ${sel.length} items to Trash?`
      );
      if (!ok) return;
      const results = this.fs.batchDelete(sel, { continueOnError: true });
      const failed = results.filter((r) => !r.ok);
      if (failed.length) this.flash(failed.length + " item(s) failed to delete", "error");
      else this.flash(sel.length + " item(s) moved to Trash", "success");
      this.selection.clear();
      this.render();
      this.updateBadges();
    }

    cutSelected() {
      const sel = this.getSelection();
      if (!sel.length) return;
      try {
        this.fs.cutToClipboard(sel);
        this.flash("Cut " + sel.length + " item(s)", "info");
        this.applyClipboardCutStyles();
      } catch (e) { this.flash(e.message, "error"); }
    }
    copySelected() {
      const sel = this.getSelection();
      if (!sel.length) return;
      try {
        this.fs.copyToClipboard(sel);
        this.flash("Copied " + sel.length + " item(s)", "info");
        this.applyClipboardCutStyles();
      } catch (e) { this.flash(e.message, "error"); }
    }
    pasteHere() {
      try {
        const out = this.fs.pasteClipboard(this.cwd, { uniquify: true, continueOnError: true });
        this.flash("Pasted " + out.length + " item(s)", "success");
        this.render();
        this.applyClipboardCutStyles();
      } catch (e) { this.flash(e.message, "error"); }
    }

    duplicateSelected() {
      const sel = this.getSelection();
      if (!sel.length) return;
      try {
        sel.forEach((p) => this.fs.duplicate(p));
        this.flash("Duplicated", "success");
        this.render();
      } catch (e) { this.flash(e.message, "error"); }
    }

    /* ---------------------------------------------------------------------- *
     * Search
     * ---------------------------------------------------------------------- */
    applySearch() {
      this.render();
    }
    clearSearch() {
      this.searchQuery = "";
      if (this.refs.search) this.refs.search.value = "";
      if (this.refs.searchClear) this.refs.searchClear.hidden = true;
      this.render();
    }

    /* ---------------------------------------------------------------------- *
     * View / sort persistence
     * ---------------------------------------------------------------------- */
    setView(mode) {
      this.viewMode = (mode === "list") ? "list" : "grid";
      this.refs.root.dataset.view = this.viewMode;
      safeSet(STORAGE_KEY_VIEW, this.viewMode);
      this.updateNavButtons();
    }
    togglePreview(force) {
      this.showPrev = (typeof force === "boolean") ? force : !this.showPrev;
      this.refs.root.dataset.showPreview = this.showPrev ? "true" : "false";
      if (this.refs.preview) this.refs.preview.hidden = !this.showPrev;
      safeSet(STORAGE_KEY_PREVIEW, this.showPrev);
      this.updateNavButtons();
      this.updatePreview();
    }
    toggleSortDir() {
      this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
      this.persistSort();
      this.render();
    }
    persistSort() {
      safeSet(STORAGE_KEY_SORT, { by: this.sortBy, dir: this.sortDir });
    }

    /* ---------------------------------------------------------------------- *
     * Preview
     * ---------------------------------------------------------------------- */
    updatePreview() {
      const r = this.refs;
      if (!this.showPrev) return;
      const sel = this.getSelection();
      if (!sel.length) {
        r.prevIcon.textContent = "📄";
        r.prevName.textContent = "No selection";
        r.prevPath.textContent = "—";
        r.prevType.textContent = "—";
        r.prevSize.textContent = "—";
        r.prevMod.textContent  = "—";
        r.prevBody.innerHTML   = `<div class="fm-prev-empty">Select a file to see its preview here.</div>`;
        return;
      }
      if (sel.length > 1) {
        const fs = this.fs;
        let total = 0;
        sel.forEach((p) => { try { total += fs.getMetadata(p).size || 0; } catch (_) {} });
        r.prevIcon.textContent = "🗂";
        r.prevName.textContent = sel.length + " items selected";
        r.prevPath.textContent = "—";
        r.prevType.textContent = "Multiple";
        r.prevSize.textContent = fs.formatBytes(total);
        r.prevMod.textContent  = "—";
        r.prevBody.innerHTML   = `<div class="fm-prev-empty">${sel.length} items · ${fs.formatBytes(total)}</div>`;
        return;
      }
      const path = sel[0];
      let md;
      try { md = this.fs.getMetadata(path); }
      catch (e) { return; }
      r.prevIcon.textContent = md.icon;
      r.prevName.textContent = md.name;
      r.prevPath.textContent = md.path;
      r.prevType.textContent = md.type === "folder" ? "Folder" : (md.kind + (md.ext ? " (." + md.ext + ")" : ""));
      r.prevSize.textContent = md.type === "folder" ? "—" : this.fs.formatBytes(md.size);
      r.prevMod.textContent  = this.fs.formatDate(md.modified);

      if (md.type === "folder") {
        const children = this.fs.listDir(path);
        const folders = children.filter((c) => c.type === "folder").length;
        const files   = children.length - folders;
        r.prevBody.innerHTML = `
          <div class="fm-prev-folder">
            <div class="fm-prev-folder-ico">${escapeHtml(md.icon)}</div>
            <div class="fm-prev-folder-stats">${folders} folder${folders !== 1 ? "s" : ""}, ${files} file${files !== 1 ? "s" : ""}</div>
          </div>`;
        return;
      }
      // file
      if (md.kind === "image") {
        try {
          const text = this.fs.readFile(path, { noRecent: true });
          if (md.ext === "svg") {
            r.prevBody.innerHTML = `<div class="fm-prev-image-holder">${text}</div>`;
          } else {
            // base64 embedded? show placeholder
            r.prevBody.innerHTML = `<div class="fm-prev-image-holder"><div style="font-size:48px;">${escapeHtml(md.icon)}</div></div>`;
          }
        } catch (_) {
          r.prevBody.innerHTML = `<div class="fm-prev-empty">Preview unavailable.</div>`;
        }
        return;
      }
      if (md.kind === "text" || md.kind === "code") {
        try {
          const text = this.fs.readFile(path, { noRecent: true });
          const truncated = text.length > 5000 ? text.slice(0, 5000) + "\n\n…(truncated)" : text;
          r.prevBody.innerHTML = `<pre class="fm-prev-text">${escapeHtml(truncated)}</pre>`;
        } catch (_) {
          r.prevBody.innerHTML = `<div class="fm-prev-empty">Preview unavailable.</div>`;
        }
        return;
      }
      // generic
      r.prevBody.innerHTML = `
        <div class="fm-prev-folder">
          <div class="fm-prev-folder-ico">${escapeHtml(md.icon)}</div>
          <div class="fm-prev-folder-stats">${escapeHtml(md.kind)} · ${this.fs.formatBytes(md.size)}</div>
        </div>`;
    }

    /* ---------------------------------------------------------------------- *
     * Status bar
     * ---------------------------------------------------------------------- */
    updateStatusBar() {
      const r = this.refs;
      const fs = this.fs;
      const total = this.entries.length;
      r.statCount.textContent = total === 1 ? "1 item" : (total + " items");
      const sel = this.getSelection();
      if (sel.length === 0) {
        r.statSel.textContent = "";
      } else if (sel.length === 1) {
        try {
          const md = fs.getMetadata(sel[0]);
          r.statSel.textContent = md.type === "folder"
            ? '"' + md.name + '" selected'
            : '"' + md.name + '" — ' + fs.formatBytes(md.size);
        } catch (_) { r.statSel.textContent = "1 item selected"; }
      } else {
        let totalSize = 0;
        sel.forEach((p) => { try { totalSize += fs.getMetadata(p).size || 0; } catch (_) {} });
        r.statSel.textContent = sel.length + " items selected — " + fs.formatBytes(totalSize);
      }
    }

    /* ---------------------------------------------------------------------- *
     * Drag & drop (between FM items and onto sidebar / desktop)
     * ---------------------------------------------------------------------- */
    bindDragAndDrop() {
      const r = this.refs;

      // Source: file/list rows. Use HTML5 DnD with a JSON payload describing paths.
      r.content.addEventListener("dragstart", (e) => {
        const item = e.target.closest(".fm-item, .fm-list-row");
        if (!item) return;
        const path = item.dataset.path;
        // ensure dragged item is in selection
        if (!this.selection.has(path)) this.selectOnly(path);
        const paths = this.getSelection();
        const payload = JSON.stringify({ kind: "webos-fs-paths", paths });
        try {
          e.dataTransfer.setData("application/x-webos-fs", payload);
          e.dataTransfer.setData("text/plain", paths.join("\n"));
          e.dataTransfer.effectAllowed = "copyMove";
          // Custom drag image: small badge with count
          const ghost = document.createElement("div");
          ghost.className = "fm-drag-ghost";
          ghost.innerHTML = `<span>${escapeHtml(this.fs.basename(paths[0]) || "Item")}</span>` +
                            (paths.length > 1 ? `<span class="fm-drag-count">+${paths.length - 1}</span>` : "");
          document.body.appendChild(ghost);
          this._dragGhost = ghost;
          // place off-screen so we can use it as the drag image; modern browsers
          // freeze the appearance immediately
          ghost.style.left = "-9999px";
          ghost.style.top  = "-9999px";
          if (e.dataTransfer.setDragImage) {
            e.dataTransfer.setDragImage(ghost, 10, 10);
          }
          // remove after the next frame; the browser captured the visual already
          setTimeout(() => { try { ghost.remove(); } catch (_) {} this._dragGhost = null; }, 50);
        } catch (_) {}
      });

      // Target: items that are folders + the empty content area.
      const isFolderItem = (el) => el && el.dataset && el.dataset.type === "folder";

      r.content.addEventListener("dragover", (e) => {
        // anything draggable is okay — show drop overlay
        if (!e.dataTransfer.types || !e.dataTransfer.types.length) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        const item = e.target.closest(".fm-item, .fm-list-row");
        // clear previous folder highlights
        r.grid.querySelectorAll(".fm-item.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        r.listBody.querySelectorAll(".fm-list-row.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        if (isFolderItem(item)) {
          item.classList.add("is-drop-target");
          r.dropOverlay.hidden = true;
          r.content.classList.remove("is-drop-active");
        } else {
          // dropping on empty area → drop into cwd
          r.dropOverlay.hidden = false;
          r.content.classList.add("is-drop-active");
        }
      });
      r.content.addEventListener("dragleave", (e) => {
        if (e.target === r.content) {
          r.dropOverlay.hidden = true;
          r.content.classList.remove("is-drop-active");
        }
      });
      r.content.addEventListener("drop", (e) => {
        e.preventDefault();
        r.dropOverlay.hidden = true;
        r.content.classList.remove("is-drop-active");
        const item = e.target.closest(".fm-item, .fm-list-row");
        const dest = (isFolderItem(item)) ? item.dataset.path : this.cwd;
        // clear highlights
        r.grid.querySelectorAll(".fm-item.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        r.listBody.querySelectorAll(".fm-list-row.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        this.handleDrop(e, dest);
      });

      r.content.addEventListener("dragend", () => {
        r.dropOverlay.hidden = true;
        r.content.classList.remove("is-drop-active");
        r.grid.querySelectorAll(".fm-item.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        r.listBody.querySelectorAll(".fm-list-row.is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
        if (this._dragGhost) { try { this._dragGhost.remove(); } catch (_) {} this._dragGhost = null; }
      });
    }

    handleDrop(e, dest) {
      // 1. Internal payload (from inside file manager)
      let internal = null;
      try {
        const raw = e.dataTransfer.getData("application/x-webos-fs");
        if (raw) internal = JSON.parse(raw);
      } catch (_) {}
      if (internal && internal.kind === "webos-fs-paths" && Array.isArray(internal.paths)) {
        this.moveOrCopyTo(internal.paths, dest, e.ctrlKey);
        return;
      }
      // 2. External files (from OS) — read text-y ones into VFS
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        this.ingestExternalFiles(e.dataTransfer.files, dest);
      }
    }

    moveOrCopyTo(paths, dest, asCopy) {
      // Disallow dropping a folder into itself or descendants
      const filtered = paths.filter((p) => !this.fs.isAncestor(p, dest) && p !== dest);
      if (!filtered.length) {
        this.flash("Cannot drop here", "error");
        return;
      }
      try {
        const opts = { uniquify: true, continueOnError: true };
        const results = asCopy
          ? this.fs.batchCopy(filtered, dest, opts)
          : this.fs.batchMove(filtered, dest, opts);
        const ok = results.filter((r) => r.ok).length;
        this.flash((asCopy ? "Copied " : "Moved ") + ok + " item(s) to " + this.fs.basename(dest), "success");
        this.render();
        this.updateBadges();
      } catch (err) {
        this.flash(err.message, "error");
      }
    }

    dropOntoFolder(dest, e) {
      // sidebar drop entry-point
      let payload = null;
      try {
        const raw = e.dataTransfer.getData("application/x-webos-fs");
        if (raw) payload = JSON.parse(raw);
      } catch (_) {}
      if (payload && Array.isArray(payload.paths)) {
        this.moveOrCopyTo(payload.paths, dest, e.ctrlKey);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length) {
        this.ingestExternalFiles(e.dataTransfer.files, dest);
      }
    }

    onFilesChosen(fileList) {
      if (!fileList || !fileList.length) return;
      this.ingestExternalFiles(fileList, this.cwd);
      this.refs.filePicker.value = "";
    }

    openFilePicker() {
      if (this.refs.filePicker) this.refs.filePicker.click();
    }

    async ingestExternalFiles(fileList, destFolder) {
      const files = Array.from(fileList);
      let count = 0;
      for (const f of files) {
        try {
          const text = await readFileAsText(f);
          let target = this.fs.joinPath(destFolder, f.name);
          if (this.fs.exists(target)) {
            const parent = this.fs.dirname(target);
            const newName = this.fs.uniquifyName(this.fs.getMetadata(parent), f.name);
            target = this.fs.joinPath(parent, newName);
          }
          this.fs.writeFile(target, text);
          count++;
        } catch (e) {
          console.warn("[FileManager] ingest failed for", f.name, e);
        }
      }
      this.flash("Imported " + count + " file(s)", "success");
      this.render();
      this.updateBadges();
    }

    /* ---------------------------------------------------------------------- *
     * Selection rectangle (click & drag empty space)
     * ---------------------------------------------------------------------- */
    onContentPointerDown(e) {
      // Only left button on empty area
      if (e.button !== 0) return;
      const item = e.target.closest(".fm-item, .fm-list-row, .fm-search-row, .fm-prev-close");
      if (item) return;
      const r = this.refs;
      const rect = r.content.getBoundingClientRect();
      const startX = e.clientX - rect.left + r.content.scrollLeft;
      const startY = e.clientY - rect.top + r.content.scrollTop;
      const rubber = document.createElement("div");
      rubber.className = "fm-rubber";
      rubber.style.left = startX + "px";
      rubber.style.top  = startY + "px";
      rubber.style.width = "0px";
      rubber.style.height = "0px";
      r.content.appendChild(rubber);
      const baseSel = (e.ctrlKey || e.metaKey) ? new Set(this.selection) : new Set();

      const onMove = (ev) => {
        const x = ev.clientX - rect.left + r.content.scrollLeft;
        const y = ev.clientY - rect.top + r.content.scrollTop;
        const x1 = Math.min(x, startX), y1 = Math.min(y, startY);
        const x2 = Math.max(x, startX), y2 = Math.max(y, startY);
        rubber.style.left = x1 + "px";
        rubber.style.top  = y1 + "px";
        rubber.style.width  = (x2 - x1) + "px";
        rubber.style.height = (y2 - y1) + "px";
        // collision detection
        const nodes = this.viewMode === "grid"
          ? r.grid.querySelectorAll(".fm-item")
          : r.listBody.querySelectorAll(".fm-list-row");
        const next = new Set(baseSel);
        const cRect = r.content.getBoundingClientRect();
        nodes.forEach((n) => {
          const nr = n.getBoundingClientRect();
          const nx1 = nr.left - cRect.left + r.content.scrollLeft;
          const ny1 = nr.top  - cRect.top  + r.content.scrollTop;
          const nx2 = nx1 + nr.width;
          const ny2 = ny1 + nr.height;
          const overlap = !(nx2 < x1 || nx1 > x2 || ny2 < y1 || ny1 > y2);
          if (overlap) next.add(n.dataset.path);
        });
        // apply selection
        if (!setsEqual(this.selection, next)) {
          this.selection = next;
          this.applySelectionStyles();
          this.updatePreview();
          this.updateStatusBar();
        }
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        try { rubber.remove(); } catch (_) {}
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    }

    /* ---------------------------------------------------------------------- *
     * Keyboard
     * ---------------------------------------------------------------------- */
    onKeyDown(e) {
      // ignore when typing in an input/textarea
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) {
        if (e.key === "Escape" && ae === this.refs.search) {
          e.preventDefault(); this.clearSearch();
        }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const key  = e.key;

      if (key === "F5")              { e.preventDefault(); this.refresh(); return; }
      if (key === "F2")              { e.preventDefault();
        const sel = this.getSelection();
        if (sel.length === 1) this.beginRename(sel[0]);
        return;
      }
      if (key === "Delete")          { e.preventDefault(); this.deleteSelected(); return; }
      if (key === "Backspace")       { e.preventDefault(); this.goUp(); return; }
      if (key === "Enter")           {
        e.preventDefault();
        const sel = this.getSelection();
        if (sel.length === 1) this.openPath(sel[0]);
        return;
      }
      if (ctrl && (key === "a" || key === "A")) { e.preventDefault(); this.selectAll(); return; }
      if (ctrl && (key === "c" || key === "C")) { e.preventDefault(); this.copySelected(); return; }
      if (ctrl && (key === "x" || key === "X")) { e.preventDefault(); this.cutSelected(); return; }
      if (ctrl && (key === "v" || key === "V")) { e.preventDefault(); this.pasteHere(); return; }
      if (ctrl && (key === "d" || key === "D")) { e.preventDefault(); this.duplicateSelected(); return; }
      if (ctrl && e.shiftKey && (key === "n" || key === "N")) { e.preventDefault(); this.newFolder(); return; }
      if (ctrl && (key === "z" || key === "Z")) { e.preventDefault();
        if (this.fs && this.fs.undo) {
          const u = this.fs.undo();
          if (u) this.flash("Undone: " + u.kind, "info");
        }
        return;
      }
      if (e.altKey && key === "ArrowLeft")  { e.preventDefault(); this.goBack(); return; }
      if (e.altKey && key === "ArrowRight") { e.preventDefault(); this.goForward(); return; }
      if (key === "Home")            { e.preventDefault(); this.selectByIndex(0); return; }
      if (key === "End")             { e.preventDefault(); this.selectByIndex(this.entries.length - 1); return; }
      if (key === "ArrowDown" || key === "ArrowUp" || key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        this.moveSelection(key, e.shiftKey);
        return;
      }
      // Type-ahead: jump to next item starting with that letter
      if (key.length === 1 && /[a-zA-Z0-9]/.test(key) && !ctrl && !e.altKey) {
        this.typeAhead(key);
      }
    }

    selectByIndex(i) {
      if (i < 0 || i >= this.entries.length) return;
      const path = this.entries[i].path;
      this.selectOnly(path);
      this.scrollIntoView(path);
    }
    moveSelection(key, shift) {
      const ids = this.entries.map((e) => e.path);
      if (!ids.length) return;
      const cur = this.lastSelected || (this.getSelection()[0]) || null;
      let idx = cur ? ids.indexOf(cur) : -1;
      if (idx === -1) idx = 0;
      const cols = this.computeGridColumns();

      let next = idx;
      if (this.viewMode === "list") {
        if (key === "ArrowDown") next = Math.min(idx + 1, ids.length - 1);
        if (key === "ArrowUp")   next = Math.max(idx - 1, 0);
      } else {
        if (key === "ArrowRight") next = Math.min(idx + 1, ids.length - 1);
        if (key === "ArrowLeft")  next = Math.max(idx - 1, 0);
        if (key === "ArrowDown")  next = Math.min(idx + cols, ids.length - 1);
        if (key === "ArrowUp")    next = Math.max(idx - cols, 0);
      }
      if (shift) this.selectRange(ids[next]);
      else this.selectOnly(ids[next]);
      this.scrollIntoView(ids[next]);
    }
    computeGridColumns() {
      // estimate columns based on grid container width
      const grid = this.refs.grid;
      if (!grid || this.viewMode !== "grid") return 1;
      const w = grid.clientWidth || 1;
      const tile = 122; // matches minmax(116px, 1fr) + gap
      return Math.max(1, Math.floor(w / tile));
    }
    scrollIntoView(path) {
      const sel = this.viewMode === "grid"
        ? this.refs.grid.querySelector(`.fm-item[data-path="${cssEscape(path)}"]`)
        : this.refs.listBody.querySelector(`tr[data-path="${cssEscape(path)}"]`);
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
    typeAhead(ch) {
      const lc = ch.toLowerCase();
      const ids = this.entries.map((e) => e.path);
      if (!ids.length) return;
      const cur = this.lastSelected || ids[0];
      const start = ids.indexOf(cur);
      for (let off = 1; off <= ids.length; off++) {
        const i = (start + off) % ids.length;
        const md = this.entries[i];
        if (md.name.charAt(0).toLowerCase() === lc) {
          this.selectOnly(md.path);
          this.scrollIntoView(md.path);
          return;
        }
      }
    }

    /* ---------------------------------------------------------------------- *
     * Flash messages
     * ---------------------------------------------------------------------- */
    flash(msg, kind) {
      // remove existing flash
      const old = this.body.querySelector(".fm-flash");
      if (old) old.remove();
      const f = document.createElement("div");
      f.className = "fm-flash" + (kind === "error" ? " is-error" : kind === "success" ? " is-success" : "");
      f.textContent = msg;
      this.refs.root.appendChild(f);
      setTimeout(() => { try { f.remove(); } catch (_) {} }, 2200);
    }

    /* ---------------------------------------------------------------------- *
     * Trash-folder special handling
     * ----------------------------------------------------------------------
     * When the user is browsing /Trash we surface extra actions — "Restore"
     * and "Empty Trash" — in the right-click and toolbar contexts. The
     * generic context-menu builders cannot know about FM-window state, so we
     * implement the logic here.
     * ---------------------------------------------------------------------- */
    isInTrash() {
      return this.cwd === "/Trash" || this.cwd.indexOf("/Trash/") === 0;
    }

    restoreSelection() {
      const sel = this.getSelection();
      if (!sel.length) return;
      let ok = 0, fail = 0;
      sel.forEach((p) => {
        try { this.fs.restoreFromTrash(p); ok++; }
        catch (_) { fail++; }
      });
      this.flash(
        ok + " item(s) restored" + (fail ? " (" + fail + " failed)" : ""),
        fail ? "error" : "success"
      );
      this.selection.clear();
      this.render();
      this.updateBadges();
    }

    emptyTrash() {
      const ok = window.confirm("Permanently delete everything in Trash?\nThis action cannot be undone.");
      if (!ok) return;
      const n = this.fs.emptyTrash();
      this.flash("Emptied Trash (" + n + " item(s))", "success");
      this.selection.clear();
      this.render();
      this.updateBadges();
    }

    /* ---------------------------------------------------------------------- *
     * Properties dialog — in-window inline panel
     * ---------------------------------------------------------------------- */
    showInlineProperties(path) {
      if (!this.fs) return;
      let md;
      try { md = this.fs.getMetadata(path); }
      catch (e) { return this.flash(e.message, "error"); }
      // Build a small modal overlay inside this window. Not a separate window
      // so it stays anchored to the FM that triggered it.
      const old = this.body.querySelector(".fm-props-modal");
      if (old) old.remove();
      const overlay = document.createElement("div");
      overlay.className = "fm-props-modal";
      overlay.style.cssText = `
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,.45); z-index: 9;
      `;
      const card = document.createElement("div");
      card.style.cssText = `
        background: var(--window-bg); border: 1px solid var(--window-border);
        border-radius: 8px; padding: 18px 22px; min-width: 340px; max-width: 460px;
        box-shadow: 0 16px 36px rgba(0,0,0,.45);
      `;
      let extras = "";
      if (md.type === "folder") {
        try {
          const children = this.fs.listDir(path);
          const folders  = children.filter((c) => c.type === "folder").length;
          const files    = children.length - folders;
          extras = `<div style="opacity:.6;">Contents</div><div>${folders} folder(s), ${files} file(s)</div>`;
        } catch (_) {}
      }
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
          <div style="font-size:42px;">${escapeHtml(md.icon)}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(md.name)}</div>
            <div style="opacity:.6;font-size:11px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(md.path)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;">
          <div style="opacity:.6;">Type</div>      <div>${escapeHtml(md.type)}${md.ext ? " (." + escapeHtml(md.ext) + ")" : ""}</div>
          <div style="opacity:.6;">Kind</div>      <div>${escapeHtml(md.kind)}</div>
          <div style="opacity:.6;">Size</div>      <div>${this.fs.formatBytes(md.size)}</div>
          <div style="opacity:.6;">Created</div>   <div>${this.fs.formatDate(md.created)}</div>
          <div style="opacity:.6;">Modified</div>  <div>${this.fs.formatDate(md.modified)}</div>
          <div style="opacity:.6;">Read-only</div> <div>${md.readonly ? "Yes" : "No"}</div>
          <div style="opacity:.6;">Hidden</div>    <div>${md.hidden ? "Yes" : "No"}</div>
          <div style="opacity:.6;">Permissions</div><div>${md.perms} (rwx bits)</div>
          ${extras}
        </div>
        <div style="margin-top:18px;display:flex;justify-content:flex-end;gap:8px;">
          <button class="app-btn fm-props-close">Close</button>
        </div>
      `;
      overlay.appendChild(card);
      this.refs.root.appendChild(overlay);
      const close = () => { try { overlay.remove(); } catch (_) {} };
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      card.querySelector(".fm-props-close").addEventListener("click", close);
      // Esc to close
      const esc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc, true); } };
      document.addEventListener("keydown", esc, true);
    }

    /* ---------------------------------------------------------------------- *
     * Conflict resolution dialog (used by paste collisions in some flows)
     * ----------------------------------------------------------------------
     * Currently `pasteClipboard({uniquify:true})` just renames silently, but
     * power users may want a Skip / Replace / Keep both prompt. This is wired
     * into the right-click "Paste with options…" menu item.
     * ---------------------------------------------------------------------- */
    pasteWithOptions() {
      const fs = this.fs;
      const clip = fs.getClipboard();
      if (clip.empty) { this.flash("Clipboard is empty", "error"); return; }
      const dest = this.cwd;
      // Detect collisions by attempting metadata lookups
      const collisions = [];
      const ok = [];
      for (const src of clip.paths) {
        if (!fs.exists(src)) continue;
        const target = fs.joinPath(dest, fs.basename(src));
        if (fs.exists(target)) collisions.push({ src, target });
        else ok.push(src);
      }
      // No collisions: just paste directly
      if (!collisions.length) return this.pasteHere();

      // Build a small conflict dialog
      const overlay = document.createElement("div");
      overlay.className = "fm-props-modal";
      overlay.style.cssText = `
        position: absolute; inset: 0; display:flex; align-items:center;
        justify-content:center; background: rgba(0,0,0,.45); z-index: 9;
      `;
      const card = document.createElement("div");
      card.style.cssText = `
        background: var(--window-bg); border: 1px solid var(--window-border);
        border-radius: 8px; padding: 18px 22px; min-width: 380px; max-width: 520px;
        box-shadow: 0 16px 36px rgba(0,0,0,.45);
      `;
      card.innerHTML = `
        <div style="font-weight:600;margin-bottom:10px;">${collisions.length} item${collisions.length>1?"s":""} already exist in this folder</div>
        <div style="opacity:.7;font-size:12px;margin-bottom:14px;">
          ${collisions.slice(0,5).map(c => escapeHtml(fs.basename(c.src))).join(", ")}${collisions.length > 5 ? "…" : ""}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="app-btn"        data-act="skip">Skip</button>
          <button class="app-btn"        data-act="keep">Keep both</button>
          <button class="app-btn primary" data-act="replace">Replace</button>
        </div>
      `;
      overlay.appendChild(card);
      this.refs.root.appendChild(overlay);

      const close = () => { try { overlay.remove(); } catch (_) {} };

      const apply = (mode) => {
        // OK paths first (no conflicts)
        try { for (const p of ok) this._pasteOne(p, dest, clip.op, { uniquify: false }); }
        catch (_) {}
        for (const c of collisions) {
          try {
            if (mode === "skip")    continue;
            if (mode === "replace") this._pasteOne(c.src, dest, clip.op, { overwrite: true });
            if (mode === "keep")    this._pasteOne(c.src, dest, clip.op, { uniquify: true });
          } catch (e) { console.warn(e); }
        }
        if (clip.op === "cut") fs.clearClipboard();
        close();
        this.render();
        this.updateBadges();
        this.flash("Pasted", "success");
      };
      card.querySelectorAll("[data-act]").forEach((b) =>
        b.addEventListener("click", () => apply(b.dataset.act)));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    }

    _pasteOne(src, destFolder, op, opts) {
      const target = this.fs.joinPath(destFolder, this.fs.basename(src));
      if (op === "copy") return this.fs.copyFile(src, target, opts);
      return this.fs.moveFile(src, target, opts);
    }

    /* ---------------------------------------------------------------------- *
     * Cleanup
     * ---------------------------------------------------------------------- */
    destroy() {
      try { this.body.removeEventListener("keydown", this.onKeyDown); } catch (_) {}
      if (typeof this.unsubFs === "function") { try { this.unsubFs(); } catch (_) {} }
      moduleState.instances.delete(this);
    }
  }

  /* --------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------*/
  function cssEscape(s) {
    return String(s == null ? "" : s).replace(/(["\\\n\r])/g, "\\$1");
  }
  function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result == null ? "" : String(reader.result));
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      // try text first; for binary files this may produce garbage but the user
      // explicitly chose to import, so we honour the request
      reader.readAsText(file);
    });
  }

  /* --------------------------------------------------------------------------
   * App registration with WindowManager
   * ------------------------------------------------------------------------*/
  function registerApp() {
    if (!window.WindowManager) {
      // try again shortly
      setTimeout(registerApp, 60);
      return;
    }
    // unregister any existing stub that uses the same id ("files" or "filemanager")
    if (window.WindowManager.unregisterApp) {
      try { window.WindowManager.unregisterApp("files"); } catch (_) {}
      try { window.WindowManager.unregisterApp("filemanager"); } catch (_) {}
    }
    loadCss();

    window.WindowManager.registerApp({
      id:        APP_ID,
      title:     APP_TITLE,
      icon:      APP_ICON,
      width:     900, height: 580,
      minWidth:  520, minHeight: 320,
      category:  "System",
      pinned:    true,
      // Inform the context menu's "Open with" probe
      canOpen:   (md) => md && md.type === "folder",
      async render(body, win) {
        const html = await loadHtml();
        body.innerHTML = html;
        const inst = new FmController(body, win, win.opts || {});
        moduleState.instances.add(inst);
        // remember instance on win for cleanup hooks
        win._fmController = inst;
      },
      onClose(win) {
        if (win && win._fmController) {
          try { win._fmController.destroy(); } catch (_) {}
        }
      },
    });

    // legacy alias: keep the old "files" id working from desktop icons / start menu
    window.WindowManager.registerApp({
      id:       "files",
      title:    APP_TITLE,
      icon:     APP_ICON,
      width:    900, height: 580,
      category: "System",
      pinned:   false,
      hidden:   true,
      async render(body, win) {
        // delegate by opening the real app
        win && window.WindowManager.closeWindow && window.WindowManager.closeWindow(win.id);
        window.WindowManager.openApp(APP_ID, win && win.opts || {});
      },
    });

    moduleState.initialized = true;
    console.log("%c[WebOS]%c File Manager registered",
      "color:#22c55e;font-weight:bold","color:inherit");
  }

  /* --------------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------------*/
  function boot() {
    // Make sure FileSystem is mounted before our app accepts opens.
    if (!window.FileSystem) {
      console.warn("[FileManager] FileSystem not loaded yet — retrying");
      setTimeout(boot, 60);
      return;
    }
    try { window.FileSystem.init && window.FileSystem.init(); } catch (_) {}
    registerApp();
  }

  /* --------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------*/
  window.FileManagerApp = {
    APP_ID, APP_TITLE, APP_ICON,
    open(opts)   { return window.WindowManager && window.WindowManager.openApp(APP_ID, opts || {}); },
    openAt(path) { return this.open({ startPath: path }); },
    register: registerApp,
    bookmarks: {
      list:    getBookmarks,
      add:     addBookmark,
      remove:  removeBookmark,
      has:     isBookmarked,
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
