/* ============================================================================
 * WebSurf — WebOS Browser (browser.js)
 * ============================================================================
 * Multi-tab browser with:
 *   - Chrome-style tab strip (add / close / middle-click)
 *   - Back / Forward / Refresh / Home navigation + address bar
 *   - Per-tab history stack and independent state
 *   - Smart URL resolution: valid URL → navigate; search terms → Google
 *   - Home page: live clock, date, Google search bar, 8 quick-link tiles
 *     (editable), random quote of the day
 *   - Bookmarks + History persisted to the WebOS FileSystem as JSON
 *   - Bookmarks / History side panels with delete & clear controls
 *   - Keyboard shortcuts: Ctrl+T / Ctrl+W / Ctrl+L / Ctrl+R / Alt+← / Alt+→
 *   - Fake download manager with animated progress bar
 *
 * Registers as app id "browser" via WindowManager. Replaces the stub
 * browser registration that windowManager.js includes in registerBuiltIns.
 * ========================================================================= */
(function () {
  "use strict";

  /* -------------------------------------------------------------------------
   * CONSTANTS
   * ---------------------------------------------------------------------- */
  const APP_ID       = "browser";
  const APP_TITLE    = "WebSurf";
  const APP_ICON     = "🌐";
  const APP_CATEGORY = "Internet";

  const HOME_URL      = "websurf://home";
  const SEARCH_PREFIX = "https://www.google.com/search?q=";

  const FS_DIR_CONFIG      = "/.config/websurf";
  const FS_BOOKMARKS_PATH  = FS_DIR_CONFIG + "/bookmarks.json";
  const FS_HISTORY_PATH    = FS_DIR_CONFIG + "/history.json";
  const FS_TILES_PATH      = FS_DIR_CONFIG + "/tiles.json";

  const HISTORY_MAX = 500;

  // Default quick-link tiles (shown on homepage first load).
  const DEFAULT_TILES = [
    { name: "Google",    url: "https://www.google.com",         icon: "🔍" },
    { name: "YouTube",   url: "https://www.youtube.com",        icon: "📺" },
    { name: "GitHub",    url: "https://github.com",             icon: "🐙" },
    { name: "Wikipedia", url: "https://en.wikipedia.org",       icon: "📚" },
    { name: "MDN",       url: "https://developer.mozilla.org",  icon: "📖" },
    { name: "Reddit",    url: "https://www.reddit.com",         icon: "👽" },
    { name: "Hacker News", url: "https://news.ycombinator.com", icon: "📰" },
    { name: "Stack Overflow", url: "https://stackoverflow.com", icon: "🧑‍💻" },
  ];

  const QUOTES = [
    { t: "The best way to predict the future is to invent it.",                a: "Alan Kay" },
    { t: "Simplicity is the ultimate sophistication.",                          a: "Leonardo da Vinci" },
    { t: "Premature optimization is the root of all evil.",                     a: "Donald Knuth" },
    { t: "Code is like humor. When you have to explain it, it's bad.",          a: "Cory House" },
    { t: "First, solve the problem. Then, write the code.",                     a: "John Johnson" },
    { t: "The only way to learn a new programming language is by writing programs in it.", a: "Dennis Ritchie" },
    { t: "Talk is cheap. Show me the code.",                                    a: "Linus Torvalds" },
    { t: "Programs must be written for people to read, and only incidentally for machines to execute.", a: "Harold Abelson" },
    { t: "Make it work, make it right, make it fast.",                          a: "Kent Beck" },
    { t: "Simplicity, carried to the extreme, becomes elegance.",               a: "Jon Franklin" },
    { t: "Any sufficiently advanced technology is indistinguishable from magic.", a: "Arthur C. Clarke" },
    { t: "There are only two kinds of languages: the ones people complain about and the ones nobody uses.", a: "Bjarne Stroustrup" },
    { t: "If you don't fail at least 90% of the time, you're not aiming high enough.", a: "Alan Kay" },
    { t: "Walking on water and developing software to specification are easy if both are frozen.", a: "Edward Berard" },
    { t: "Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.", a: "Antoine de Saint-Exupéry" },
  ];

  const FAKE_DOWNLOAD_PATTERNS = [
    /\.(zip|tar|gz|rar|7z)(\?.*)?$/i,
    /\.(pdf|docx?|xlsx?|pptx?)(\?.*)?$/i,
    /\.(mp3|mp4|wav|flac|ogg|mkv|avi|mov)(\?.*)?$/i,
    /\.(exe|dmg|pkg|deb|rpm|msi)(\?.*)?$/i,
    /\.(iso|bin)(\?.*)?$/i,
    /\bdownload\b/i,
  ];

  /* -------------------------------------------------------------------------
   * UTILS
   * ---------------------------------------------------------------------- */
  function $(root, s)  { return root.querySelector(s); }
  function $$(root, s) { return Array.from(root.querySelectorAll(s)); }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function uid(prefix) {
    return (prefix || "id") + "-" + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Decide whether a user-typed address should be interpreted as a URL or as
   * a search query. Returns the canonical URL to navigate to.
   */
  function resolveAddress(input) {
    input = (input || "").trim();
    if (!input) return HOME_URL;
    if (input === HOME_URL || input === "about:home" || input === "home") return HOME_URL;
    // Already has scheme
    if (/^[a-z]+:\/\//i.test(input)) return input;
    if (/^websurf:/i.test(input))    return input;
    // Looks like a domain? (contains a dot, no spaces, or localhost/IP pattern)
    const hasSpace = /\s/.test(input);
    const looksLikeDomain =
      !hasSpace &&
      (/^([\w-]+\.)+[a-z]{2,}(\/.*)?$/i.test(input) ||
       /^localhost(:\d+)?(\/.*)?$/i.test(input) ||
       /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(input));
    if (looksLikeDomain) return "https://" + input;
    // Otherwise: search query
    return SEARCH_PREFIX + encodeURIComponent(input);
  }

  /**
   * Derive a short title from a URL for fallback tab labels.
   */
  function titleFromUrl(url) {
    if (!url) return "New Tab";
    if (url === HOME_URL) return "New Tab";
    try {
      const u = new URL(url);
      if (u.hostname === "www.google.com" && u.pathname === "/search") {
        return (u.searchParams.get("q") || "Google Search") + " — Google";
      }
      return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
    } catch (_) {
      return url.length > 40 ? url.slice(0, 40) + "…" : url;
    }
  }

  /**
   * Pick a favicon glyph based on hostname or URL scheme.
   */
  function faviconFor(url) {
    if (!url) return "🌐";
    if (url === HOME_URL) return "🏠";
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (host.includes("google"))        return "🔍";
      if (host.includes("youtube"))       return "📺";
      if (host.includes("github"))        return "🐙";
      if (host.includes("wikipedia"))     return "📚";
      if (host.includes("reddit"))        return "👽";
      if (host.includes("twitter") || host.includes("x.com")) return "🐦";
      if (host.includes("facebook"))      return "📘";
      if (host.includes("instagram"))     return "📷";
      if (host.includes("linkedin"))      return "💼";
      if (host.includes("stackoverflow")) return "🧑‍💻";
      if (host.includes("mozilla") || host.includes("mdn")) return "📖";
      if (host.includes("news"))          return "📰";
      if (host.includes("mail"))          return "📧";
      if (host.includes("amazon"))        return "🛒";
      if (host.includes("netflix"))       return "🎬";
      if (host.endsWith(".edu"))          return "🎓";
      if (host.endsWith(".gov"))          return "🏛";
      return "🌐";
    } catch (_) { return "🌐"; }
  }

  function formatDate(d) {
    const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    return d.toLocaleDateString(undefined, opts);
  }
  function formatTime(d) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function prettyAgo(ts) {
    const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (secs < 60)      return secs + "s ago";
    if (secs < 3600)    return Math.floor(secs / 60) + "m ago";
    if (secs < 86400)   return Math.floor(secs / 3600) + "h ago";
    if (secs < 86400*7) return Math.floor(secs / 86400) + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  function shouldFakeDownload(url) {
    if (!url || /^websurf:/i.test(url)) return false;
    for (const re of FAKE_DOWNLOAD_PATTERNS) {
      if (re.test(url)) return true;
    }
    return false;
  }

  function downloadFilenameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop() || "download";
      return last.split("?")[0];
    } catch (_) { return "download.bin"; }
  }

  /* -------------------------------------------------------------------------
   * FILESYSTEM PERSISTENCE HELPERS
   * ---------------------------------------------------------------------- */
  function ensureConfigDir(fs) {
    try {
      if (fs.mkdirp) fs.mkdirp(FS_DIR_CONFIG);
      else if (fs.mkdir && !fs.exists(FS_DIR_CONFIG)) {
        fs.mkdir(FS_DIR_CONFIG);
      }
    } catch (_) {}
  }

  function readJSONFile(fs, path, fallback) {
    try {
      if (!fs || !fs.exists(path)) return fallback;
      const s = fs.readFile(path);
      return s ? JSON.parse(s) : fallback;
    } catch (_) { return fallback; }
  }

  function writeJSONFile(fs, path, data) {
    try {
      ensureConfigDir(fs);
      fs.writeFile(path, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.warn("[WebSurf] FS write failed for", path, e);
      return false;
    }
  }

  function loadBookmarks() {
    const fs = window.FileSystem;
    if (!fs) {
      try { return JSON.parse(localStorage.getItem("webos.websurf.bookmarks") || "[]"); }
      catch (_) { return []; }
    }
    return readJSONFile(fs, FS_BOOKMARKS_PATH, []);
  }
  function saveBookmarks(list) {
    const fs = window.FileSystem;
    if (!fs) {
      try { localStorage.setItem("webos.websurf.bookmarks", JSON.stringify(list)); } catch (_) {}
      return;
    }
    writeJSONFile(fs, FS_BOOKMARKS_PATH, list);
  }
  function loadHistory() {
    const fs = window.FileSystem;
    if (!fs) {
      try { return JSON.parse(localStorage.getItem("webos.websurf.history") || "[]"); }
      catch (_) { return []; }
    }
    return readJSONFile(fs, FS_HISTORY_PATH, []);
  }
  function saveHistory(list) {
    const fs = window.FileSystem;
    if (!fs) {
      try { localStorage.setItem("webos.websurf.history", JSON.stringify(list)); } catch (_) {}
      return;
    }
    writeJSONFile(fs, FS_HISTORY_PATH, list);
  }
  function loadTiles() {
    const fs = window.FileSystem;
    if (!fs) {
      try {
        const s = localStorage.getItem("webos.websurf.tiles");
        if (s) return JSON.parse(s);
      } catch (_) {}
      return DEFAULT_TILES.slice();
    }
    const t = readJSONFile(fs, FS_TILES_PATH, null);
    return Array.isArray(t) && t.length ? t : DEFAULT_TILES.slice();
  }
  function saveTiles(list) {
    const fs = window.FileSystem;
    if (!fs) {
      try { localStorage.setItem("webos.websurf.tiles", JSON.stringify(list)); } catch (_) {}
      return;
    }
    writeJSONFile(fs, FS_TILES_PATH, list);
  }

  /* -------------------------------------------------------------------------
   * HTML TEMPLATE
   * ---------------------------------------------------------------------- */
  const HTML_TEMPLATE = `
<div class="ws-root" data-ws-root>
  <div class="ws-tabstrip" data-ws-tabstrip>
    <div class="ws-tabs" data-ws-tabs role="tablist"></div>
    <button class="ws-newtab" data-ws-newtab title="New tab (Ctrl+T)">+</button>
  </div>
  <div class="ws-navbar" data-ws-navbar>
    <button class="ws-navbtn" data-ws-nav="back"    title="Back (Alt+Left)">←</button>
    <button class="ws-navbtn" data-ws-nav="forward" title="Forward (Alt+Right)">→</button>
    <button class="ws-navbtn" data-ws-nav="refresh" title="Refresh (Ctrl+R)">⟳</button>
    <button class="ws-navbtn" data-ws-nav="home"    title="Home">🏠</button>
    <div class="ws-addrbar" data-ws-addrbar>
      <span class="ws-favicon" data-ws-favicon>🌐</span>
      <input class="ws-addr" data-ws-addr type="text" spellcheck="false" placeholder="Search Google or enter a URL" />
      <span class="ws-loading" data-ws-loading hidden></span>
    </div>
    <button class="ws-navbtn" data-ws-nav="bookmark"  title="Bookmark">☆</button>
    <button class="ws-navbtn" data-ws-nav="bookmarks" title="Bookmarks sidebar">📑</button>
    <button class="ws-navbtn" data-ws-nav="history"   title="History sidebar">🕓</button>
    <button class="ws-navbtn" data-ws-nav="menu"      title="Menu">⋮</button>
  </div>
  <div class="ws-body" data-ws-body>
    <div class="ws-content" data-ws-content></div>
    <aside class="ws-sidebar" data-ws-sidebar hidden>
      <div class="ws-sidebar-head">
        <span class="ws-sidebar-title" data-ws-sidebar-title>Bookmarks</span>
        <button class="ws-iconbtn" data-ws-sidebar-close title="Close">✕</button>
      </div>
      <div class="ws-sidebar-body" data-ws-sidebar-body></div>
    </aside>
  </div>
  <div class="ws-downloadbar" data-ws-downloadbar hidden>
    <div class="ws-dl-items" data-ws-dl-items></div>
    <button class="ws-iconbtn" data-ws-dl-close title="Close">✕</button>
  </div>
  <div class="ws-menu" data-ws-menu hidden>
    <div class="ws-menu-item" data-ws-menu-act="newTab"><span class="ws-menu-icon">➕</span> New tab <span class="ws-menu-kbd">Ctrl+T</span></div>
    <div class="ws-menu-item" data-ws-menu-act="closeTab"><span class="ws-menu-icon">✕</span> Close tab <span class="ws-menu-kbd">Ctrl+W</span></div>
    <div class="ws-menu-sep"></div>
    <div class="ws-menu-item" data-ws-menu-act="bookmarks"><span class="ws-menu-icon">📑</span> Bookmarks</div>
    <div class="ws-menu-item" data-ws-menu-act="history"><span class="ws-menu-icon">🕓</span> History</div>
    <div class="ws-menu-item" data-ws-menu-act="downloads"><span class="ws-menu-icon">⬇</span> Downloads</div>
    <div class="ws-menu-sep"></div>
    <div class="ws-menu-item" data-ws-menu-act="clearHistory"><span class="ws-menu-icon">🧹</span> Clear history</div>
    <div class="ws-menu-item" data-ws-menu-act="home"><span class="ws-menu-icon">🏠</span> Go home</div>
    <div class="ws-menu-item" data-ws-menu-act="help"><span class="ws-menu-icon">?</span> Shortcuts</div>
  </div>
</div>
`;

  /* -------------------------------------------------------------------------
   * WEBSURF BROWSER INSTANCE
   * ---------------------------------------------------------------------- */
  class WebSurf {
    constructor(body, winOpts) {
      this.body = body;
      this.winOpts = winOpts || {};
      this.root = null;

      this.tabs = [];             // Tab[]
      this.activeTabId = null;
      this.sidebarMode = null;    // null | "bookmarks" | "history"

      this.bookmarks = loadBookmarks();
      this.history   = loadHistory();
      this.tiles     = loadTiles();

      this.downloads = [];
      this.downloadsVisible = false;

      this.keyHandler = null;
      this.destroyed = false;
      this._menuClickOutsideHandler = null;
      this._clockTimer = null;
    }

    /* ------------------------------------------------------------
     * MOUNT / UNMOUNT
     * --------------------------------------------------------- */
    mount() {
      this.body.innerHTML = HTML_TEMPLATE;
      this.root = $(this.body, "[data-ws-root]");
      this._bindChrome();
      this._bindKeys();

      // Open initial tab
      const initUrl = this.winOpts.openUrl || HOME_URL;
      this.newTab(initUrl);
    }

    destroy() {
      this.destroyed = true;
      if (this.keyHandler) {
        document.removeEventListener("keydown", this.keyHandler, true);
        this.keyHandler = null;
      }
      if (this._menuClickOutsideHandler) {
        document.removeEventListener("mousedown", this._menuClickOutsideHandler, true);
      }
      if (this._clockTimer) clearInterval(this._clockTimer);
    }

    /* ------------------------------------------------------------
     * CHROME BINDING
     * --------------------------------------------------------- */
    _bindChrome() {
      const self = this;

      // New tab button
      $(this.root, "[data-ws-newtab]").addEventListener("click", () => self.newTab());

      // Nav buttons
      $$(this.root, "[data-ws-nav]").forEach((b) => {
        b.addEventListener("click", () => self._handleNav(b.dataset.wsNav, b));
      });

      // Address bar
      const addr = $(this.root, "[data-ws-addr]");
      addr.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          self.navigateActive(addr.value);
        } else if (ev.key === "Escape") {
          const t = self.activeTab();
          if (t) addr.value = t.url === HOME_URL ? "" : t.url;
          addr.blur();
        }
      });
      addr.addEventListener("focus", () => addr.select());

      // Sidebar close
      $(this.root, "[data-ws-sidebar-close]").addEventListener("click", () => self._closeSidebar());

      // Download bar close
      $(this.root, "[data-ws-dl-close]").addEventListener("click", () => {
        self.downloadsVisible = false;
        $(self.root, "[data-ws-downloadbar]").hidden = true;
      });

      // Menu dropdown
      $$(this.root, "[data-ws-menu-act]").forEach((item) => {
        item.addEventListener("click", () => {
          self._handleMenuAction(item.dataset.wsMenuAct);
          self._closeMenu();
        });
      });
      this._menuClickOutsideHandler = (ev) => {
        const menu = $(self.root, "[data-ws-menu]");
        if (!menu || menu.hidden) return;
        if (!menu.contains(ev.target) &&
            !(ev.target.closest && ev.target.closest("[data-ws-nav='menu']"))) {
          self._closeMenu();
        }
      };
      document.addEventListener("mousedown", this._menuClickOutsideHandler, true);
    }

    _bindKeys() {
      const self = this;
      this.keyHandler = (ev) => {
        if (self.destroyed || !self.root || !self.root.isConnected) return;
        if (!self.root.contains(document.activeElement)) return;
        const k = ev.key;
        const ctrl = ev.ctrlKey || ev.metaKey;
        if (ctrl && !ev.shiftKey && !ev.altKey) {
          switch (k.toLowerCase()) {
            case "t": ev.preventDefault(); self.newTab(); return;
            case "w": ev.preventDefault(); self.closeTab(self.activeTabId); return;
            case "l": ev.preventDefault();
              { const a = $(self.root, "[data-ws-addr]"); if (a) { a.focus(); a.select(); } } return;
            case "r": ev.preventDefault(); self.refresh(); return;
            case "d": ev.preventDefault(); self.toggleBookmarkActive(); return;
            case "h": ev.preventDefault(); self.toggleSidebar("history"); return;
            case "b": ev.preventDefault(); self.toggleSidebar("bookmarks"); return;
          }
        }
        if (ctrl && ev.shiftKey) {
          if (k.toLowerCase() === "t") { ev.preventDefault(); self._reopenLast(); return; }
        }
        if (ev.altKey && !ev.ctrlKey) {
          if (k === "ArrowLeft")  { ev.preventDefault(); self.back(); return; }
          if (k === "ArrowRight") { ev.preventDefault(); self.forward(); return; }
          if (k === "Home")       { ev.preventDefault(); self.goHome(); return; }
        }
      };
      document.addEventListener("keydown", this.keyHandler, true);
    }

    /* ------------------------------------------------------------
     * TABS
     * --------------------------------------------------------- */
    newTab(url, opts) {
      url = url || HOME_URL;
      const id = uid("tab");
      const tab = {
        id,
        url: null,               // set by _loadUrl
        title: "New Tab",
        favicon: "🌐",
        history: [],             // stack of URLs
        historyIdx: -1,
        loading: false,
        iframeEl: null,
        homeEl: null,
      };
      this.tabs.push(tab);
      this.activeTabId = id;
      this._renderTabBar();
      this._loadUrl(tab, url, { addHistory: true });
    }

    closeTab(id) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      // stash for possible reopen
      const closed = this.tabs[idx];
      this._lastClosed = { url: closed.url };
      this.tabs.splice(idx, 1);
      if (!this.tabs.length) {
        this.newTab();
        return;
      }
      if (this.activeTabId === id) {
        const nextIdx = Math.min(idx, this.tabs.length - 1);
        this.activeTabId = this.tabs[nextIdx].id;
      }
      this._renderTabBar();
      this._renderActiveContent();
      this._updateChromeForActive();
    }

    _reopenLast() {
      if (this._lastClosed && this._lastClosed.url) {
        this.newTab(this._lastClosed.url);
      }
    }

    switchTab(id) {
      if (this.activeTabId === id) return;
      this.activeTabId = id;
      this._renderTabBar();
      this._renderActiveContent();
      this._updateChromeForActive();
    }

    activeTab() {
      return this.tabs.find((t) => t.id === this.activeTabId) || null;
    }

    _renderTabBar() {
      const bar = $(this.root, "[data-ws-tabs]");
      if (!bar) return;
      bar.innerHTML = "";
      this.tabs.forEach((t) => {
        const el = document.createElement("div");
        el.className = "ws-tab" + (t.id === this.activeTabId ? " is-active" : "") + (t.loading ? " is-loading" : "");
        el.dataset.wsTabId = t.id;
        el.title = t.url || t.title;
        el.innerHTML = `
          <span class="ws-tab-fav">${escapeHtml(t.favicon || "🌐")}</span>
          <span class="ws-tab-title">${escapeHtml(t.title || "New Tab")}</span>
          <span class="ws-tab-close" data-ws-tab-close="${t.id}" title="Close tab">✕</span>
        `;
        el.addEventListener("click", (ev) => {
          if (ev.target.matches("[data-ws-tab-close]")) return;
          this.switchTab(t.id);
        });
        el.addEventListener("mousedown", (ev) => {
          if (ev.button === 1) {
            ev.preventDefault();
            this.closeTab(t.id);
          }
        });
        const closeBtn = el.querySelector("[data-ws-tab-close]");
        if (closeBtn) closeBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.closeTab(t.id);
        });
        bar.appendChild(el);
      });
    }

    /* ------------------------------------------------------------
     * NAVIGATION
     * --------------------------------------------------------- */
    _handleNav(name, btn) {
      switch (name) {
        case "back":      return this.back();
        case "forward":   return this.forward();
        case "refresh":   return this.refresh();
        case "home":      return this.goHome();
        case "bookmark":  return this.toggleBookmarkActive();
        case "bookmarks": return this.toggleSidebar("bookmarks");
        case "history":   return this.toggleSidebar("history");
        case "menu":      return this._toggleMenu(btn);
      }
    }

    navigateActive(input) {
      const t = this.activeTab();
      if (!t) return;
      // Fake download?
      if (shouldFakeDownload(input)) {
        this._startFakeDownload(input);
        // still land on "download page" — show the original URL in bar
        const a = $(this.root, "[data-ws-addr]");
        if (a) a.value = input;
        return;
      }
      const url = resolveAddress(input);
      this._loadUrl(t, url, { addHistory: true });
    }

    navigateNewTab(url) {
      this.newTab(url);
    }

    back() {
      const t = this.activeTab();
      if (!t) return;
      if (t.historyIdx <= 0) return;
      t.historyIdx -= 1;
      const url = t.history[t.historyIdx];
      this._loadUrl(t, url, { addHistory: false });
    }

    forward() {
      const t = this.activeTab();
      if (!t) return;
      if (t.historyIdx >= t.history.length - 1) return;
      t.historyIdx += 1;
      const url = t.history[t.historyIdx];
      this._loadUrl(t, url, { addHistory: false });
    }

    refresh() {
      const t = this.activeTab();
      if (!t) return;
      if (!t.url) return;
      this._loadUrl(t, t.url, { addHistory: false, force: true });
    }

    goHome() {
      const t = this.activeTab();
      if (!t) return;
      this._loadUrl(t, HOME_URL, { addHistory: true });
    }

    _loadUrl(tab, url, { addHistory = true, force = false } = {}) {
      url = url || HOME_URL;
      if (!tab) return;

      if (addHistory) {
        // drop forward history on new nav
        tab.history = tab.history.slice(0, tab.historyIdx + 1);
        if (tab.history[tab.history.length - 1] !== url) {
          tab.history.push(url);
        }
        tab.historyIdx = tab.history.length - 1;
      }

      tab.url = url;
      tab.loading = true;
      tab.favicon = faviconFor(url);
      const baseTitle = titleFromUrl(url);
      tab.title = url === HOME_URL ? "New Tab" : baseTitle;

      this._renderTabBar();
      if (tab.id === this.activeTabId) {
        this._renderActiveContent();
        this._updateChromeForActive();
        this._showLoading(true);
      }

      // Record in history (except home)
      if (url !== HOME_URL && addHistory) {
        this._recordHistory(url, tab.title);
      }

      // Simulate load complete after a short delay
      if (url !== HOME_URL) {
        setTimeout(() => {
          if (!tab || this.destroyed) return;
          tab.loading = false;
          // Attempt to extract iframe title (same-origin only; falls back silently)
          if (tab.iframeEl) {
            try {
              const doc = tab.iframeEl.contentDocument;
              if (doc && doc.title) tab.title = doc.title;
            } catch (_) { /* cross-origin */ }
          }
          this._renderTabBar();
          if (tab.id === this.activeTabId) {
            this._updateChromeForActive();
            this._showLoading(false);
          }
        }, 650);
      } else {
        tab.loading = false;
        this._showLoading(false);
      }
    }

    _renderActiveContent() {
      const content = $(this.root, "[data-ws-content]");
      if (!content) return;
      content.innerHTML = "";
      const t = this.activeTab();
      if (!t) return;
      if (t.url === HOME_URL) {
        t.iframeEl = null;
        t.homeEl = this._buildHomepage();
        content.appendChild(t.homeEl);
        this._startClock();
      } else {
        t.homeEl = null;
        const iframe = document.createElement("iframe");
        iframe.src = t.url;
        iframe.referrerPolicy = "no-referrer";
        iframe.sandbox = "allow-scripts allow-forms allow-popups allow-same-origin allow-presentation";
        iframe.setAttribute("allowfullscreen", "true");
        iframe.addEventListener("load", () => {
          // Try to extract title + favicon from iframe (same-origin)
          try {
            const doc = iframe.contentDocument;
            if (doc && doc.title) {
              t.title = doc.title;
              this._renderTabBar();
              if (t.id === this.activeTabId) this._updateChromeForActive();
            }
            // click interception for fake downloads
            if (doc) {
              doc.addEventListener("click", (ev) => {
                const a = ev.target.closest && ev.target.closest("a[href]");
                if (a && shouldFakeDownload(a.href)) {
                  ev.preventDefault();
                  this._startFakeDownload(a.href);
                }
              });
            }
          } catch (_) { /* cross-origin */ }
        });
        t.iframeEl = iframe;
        content.appendChild(iframe);
      }
    }

    _updateChromeForActive() {
      const t = this.activeTab();
      const addr = $(this.root, "[data-ws-addr]");
      const fav  = $(this.root, "[data-ws-favicon]");
      if (addr) addr.value = (t && t.url !== HOME_URL) ? (t.url || "") : "";
      if (fav)  fav.textContent = (t && t.favicon) || "🌐";
      // back / forward disabled state
      const back = $(this.root, "[data-ws-nav='back']");
      const fwd  = $(this.root, "[data-ws-nav='forward']");
      if (back) back.classList.toggle("is-disabled", !t || t.historyIdx <= 0);
      if (fwd)  fwd.classList.toggle("is-disabled",  !t || t.historyIdx >= (t.history.length - 1));
      // bookmark indicator
      const bk = $(this.root, "[data-ws-nav='bookmark']");
      if (bk) {
        const isBookmarked = t && t.url && this.bookmarks.some((b) => b.url === t.url);
        bk.textContent = isBookmarked ? "★" : "☆";
        bk.classList.toggle("is-active-bookmark", !!isBookmarked);
      }
    }

    _showLoading(yes) {
      const el = $(this.root, "[data-ws-loading]");
      if (el) el.hidden = !yes;
    }

    /* ------------------------------------------------------------
     * HOMEPAGE
     * --------------------------------------------------------- */
    _buildHomepage() {
      const container = document.createElement("div");
      container.className = "ws-home";
      const now = new Date();
      const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
      container.innerHTML = `
        <div class="ws-home-clock" data-ws-home-clock>${formatTime(now)}</div>
        <div class="ws-home-date"  data-ws-home-date>${escapeHtml(formatDate(now))}</div>
        <form class="ws-home-searchbar" data-ws-home-search>
          <span>🔍</span>
          <input type="text" placeholder="Search Google or type a URL" autocomplete="off" spellcheck="false" />
        </form>
        <div class="ws-home-tiles" data-ws-home-tiles></div>
        <div class="ws-home-quote">“${escapeHtml(quote.t)}”
          <span class="ws-home-quote-author">— ${escapeHtml(quote.a)}</span>
        </div>
      `;
      const form = $(container, "[data-ws-home-search]");
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const input = form.querySelector("input");
        this.navigateActive(input.value);
      });
      this._renderHomeTiles(container);
      return container;
    }

    _renderHomeTiles(container) {
      const grid = container.querySelector("[data-ws-home-tiles]");
      if (!grid) return;
      grid.innerHTML = "";
      this.tiles.forEach((tile, idx) => {
        const el = document.createElement("div");
        el.className = "ws-home-tile";
        el.title = tile.url;
        el.innerHTML = `
          <span class="ws-home-tile-edit" data-ws-tile-edit="${idx}" title="Edit">✎</span>
          <div class="ws-home-tile-icon">${escapeHtml(tile.icon || "🌐")}</div>
          <div class="ws-home-tile-name">${escapeHtml(tile.name)}</div>
        `;
        el.addEventListener("click", (ev) => {
          if (ev.target.matches("[data-ws-tile-edit]")) return;
          this.navigateActive(tile.url);
        });
        const edit = el.querySelector("[data-ws-tile-edit]");
        if (edit) edit.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._editTile(idx);
        });
        grid.appendChild(el);
      });
      // allow adding a 9th tile as a "+ add" placeholder if there's room
      if (this.tiles.length < 12) {
        const add = document.createElement("div");
        add.className = "ws-home-tile";
        add.title = "Add quick link";
        add.innerHTML = `
          <div class="ws-home-tile-icon" style="opacity:.55">➕</div>
          <div class="ws-home-tile-name" style="opacity:.55">Add</div>
        `;
        add.addEventListener("click", () => this._addTile());
        grid.appendChild(add);
      }
    }

    _editTile(idx) {
      const tile = this.tiles[idx];
      if (!tile) return;
      const name = prompt("Tile name:", tile.name);
      if (name === null) return;
      const url = prompt("Tile URL:", tile.url);
      if (url === null) return;
      const icon = prompt("Tile icon (emoji):", tile.icon || "🌐") || "🌐";
      if (!name.trim() || !url.trim()) {
        if (confirm("Empty name or URL — remove this tile?")) {
          this.tiles.splice(idx, 1);
          saveTiles(this.tiles);
          const t = this.activeTab();
          if (t && t.url === HOME_URL) this._renderActiveContent();
        }
        return;
      }
      this.tiles[idx] = { name: name.trim(), url: url.trim(), icon };
      saveTiles(this.tiles);
      const t = this.activeTab();
      if (t && t.url === HOME_URL) this._renderActiveContent();
    }

    _addTile() {
      const name = prompt("Tile name:");
      if (!name) return;
      const url = prompt("Tile URL:");
      if (!url) return;
      const icon = prompt("Tile icon (emoji):", "🌐") || "🌐";
      this.tiles.push({ name: name.trim(), url: url.trim(), icon });
      saveTiles(this.tiles);
      const t = this.activeTab();
      if (t && t.url === HOME_URL) this._renderActiveContent();
    }

    _startClock() {
      if (this._clockTimer) clearInterval(this._clockTimer);
      const tick = () => {
        const t = this.activeTab();
        if (!t || t.url !== HOME_URL || !t.homeEl) {
          clearInterval(this._clockTimer);
          this._clockTimer = null;
          return;
        }
        const now = new Date();
        const ce = t.homeEl.querySelector("[data-ws-home-clock]");
        const de = t.homeEl.querySelector("[data-ws-home-date]");
        if (ce) ce.textContent = formatTime(now);
        if (de) de.textContent = formatDate(now);
      };
      tick();
      this._clockTimer = setInterval(tick, 1000);
    }

    /* ------------------------------------------------------------
     * BOOKMARKS
     * --------------------------------------------------------- */
    toggleBookmarkActive() {
      const t = this.activeTab();
      if (!t || !t.url || t.url === HOME_URL) return;
      const existingIdx = this.bookmarks.findIndex((b) => b.url === t.url);
      if (existingIdx >= 0) {
        this.bookmarks.splice(existingIdx, 1);
      } else {
        this.bookmarks.unshift({
          url: t.url,
          title: t.title || titleFromUrl(t.url),
          favicon: t.favicon,
          addedAt: Date.now(),
        });
      }
      saveBookmarks(this.bookmarks);
      this._updateChromeForActive();
      if (this.sidebarMode === "bookmarks") this._renderSidebar();
    }

    /* ------------------------------------------------------------
     * HISTORY
     * --------------------------------------------------------- */
    _recordHistory(url, title) {
      // Deduplicate consecutive entries
      if (this.history.length && this.history[0].url === url) return;
      this.history.unshift({ url, title: title || titleFromUrl(url), ts: Date.now() });
      if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
      saveHistory(this.history);
    }

    clearHistory() {
      if (!confirm("Clear all browsing history?")) return;
      this.history = [];
      saveHistory(this.history);
      if (this.sidebarMode === "history") this._renderSidebar();
    }

    /* ------------------------------------------------------------
     * SIDEBAR
     * --------------------------------------------------------- */
    toggleSidebar(mode) {
      if (this.sidebarMode === mode) { this._closeSidebar(); return; }
      this.sidebarMode = mode;
      const sb = $(this.root, "[data-ws-sidebar]");
      sb.hidden = false;
      $(this.root, "[data-ws-sidebar-title]").textContent =
        mode === "bookmarks" ? "Bookmarks" : "History";
      this._renderSidebar();
    }

    _closeSidebar() {
      this.sidebarMode = null;
      const sb = $(this.root, "[data-ws-sidebar]");
      if (sb) sb.hidden = true;
    }

    _renderSidebar() {
      const body = $(this.root, "[data-ws-sidebar-body]");
      if (!body) return;
      body.innerHTML = "";
      if (this.sidebarMode === "bookmarks") this._renderBookmarks(body);
      else if (this.sidebarMode === "history") this._renderHistory(body);
    }

    _renderBookmarks(body) {
      if (!this.bookmarks.length) {
        body.innerHTML = `<div class="ws-sidebar-empty">No bookmarks yet.<br/>Click ☆ in the nav bar to add.</div>`;
        return;
      }
      this.bookmarks.forEach((bk, idx) => {
        const item = document.createElement("div");
        item.className = "ws-bk-item";
        item.title = bk.url;
        item.innerHTML = `
          <span class="ws-bk-fav">${escapeHtml(bk.favicon || faviconFor(bk.url))}</span>
          <span class="ws-bk-title">
            <span class="ws-bk-name">${escapeHtml(bk.title)}</span>
            <span class="ws-bk-url">${escapeHtml(bk.url)}</span>
          </span>
          <span class="ws-bk-del" data-ws-bk-del="${idx}" title="Remove">✕</span>
        `;
        item.addEventListener("click", (ev) => {
          if (ev.target.matches("[data-ws-bk-del]")) return;
          this.navigateActive(bk.url);
        });
        const del = item.querySelector("[data-ws-bk-del]");
        if (del) del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.bookmarks.splice(idx, 1);
          saveBookmarks(this.bookmarks);
          this._updateChromeForActive();
          this._renderSidebar();
        });
        body.appendChild(item);
      });
    }

    _renderHistory(body) {
      if (!this.history.length) {
        body.innerHTML = `<div class="ws-sidebar-empty">No history yet.</div>`;
        return;
      }
      const controlRow = document.createElement("div");
      controlRow.style.cssText = "padding:4px 6px;display:flex;gap:6px;border-bottom:1px dashed var(--border-1,rgba(255,255,255,0.08));margin-bottom:4px;";
      controlRow.innerHTML = `<button class="ws-iconbtn" style="width:auto;padding:2px 10px;font-size:11px;" data-ws-hist-clear>Clear all</button>`;
      body.appendChild(controlRow);
      controlRow.querySelector("[data-ws-hist-clear]")
        .addEventListener("click", () => this.clearHistory());

      this.history.forEach((h, idx) => {
        const item = document.createElement("div");
        item.className = "ws-hist-item";
        item.title = h.url + "\n" + new Date(h.ts).toLocaleString();
        item.innerHTML = `
          <span class="ws-hist-fav">${escapeHtml(faviconFor(h.url))}</span>
          <span class="ws-hist-title">
            <span class="ws-hist-name">${escapeHtml(h.title || titleFromUrl(h.url))}</span>
            <span class="ws-hist-url">${escapeHtml(h.url)}</span>
          </span>
          <span class="ws-hist-time">${escapeHtml(prettyAgo(h.ts))}</span>
          <span class="ws-hist-del" data-ws-hist-del="${idx}" title="Remove">✕</span>
        `;
        item.addEventListener("click", (ev) => {
          if (ev.target.matches("[data-ws-hist-del]")) return;
          this.navigateActive(h.url);
        });
        const del = item.querySelector("[data-ws-hist-del]");
        if (del) del.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.history.splice(idx, 1);
          saveHistory(this.history);
          this._renderSidebar();
        });
        body.appendChild(item);
      });
    }

    /* ------------------------------------------------------------
     * MENU
     * --------------------------------------------------------- */
    _toggleMenu(anchorBtn) {
      const menu = $(this.root, "[data-ws-menu]");
      if (!menu) return;
      if (!menu.hidden) { this._closeMenu(); return; }
      menu.hidden = false;
      if (anchorBtn) {
        const r = anchorBtn.getBoundingClientRect();
        const rootR = this.root.getBoundingClientRect();
        menu.style.top = (r.bottom - rootR.top + 4) + "px";
        menu.style.right = (rootR.right - r.right) + "px";
        menu.style.left = "auto";
      }
    }
    _closeMenu() {
      const menu = $(this.root, "[data-ws-menu]");
      if (menu) menu.hidden = true;
    }

    _handleMenuAction(act) {
      switch (act) {
        case "newTab":       return this.newTab();
        case "closeTab":     return this.closeTab(this.activeTabId);
        case "bookmarks":    return this.toggleSidebar("bookmarks");
        case "history":      return this.toggleSidebar("history");
        case "downloads":
          this.downloadsVisible = true;
          $(this.root, "[data-ws-downloadbar]").hidden = this.downloads.length === 0;
          return;
        case "clearHistory": return this.clearHistory();
        case "home":         return this.goHome();
        case "help":         return this._showShortcuts();
      }
    }

    _showShortcuts() {
      alert([
        "WebSurf keyboard shortcuts:",
        "  Ctrl+T        — New tab",
        "  Ctrl+W        — Close tab",
        "  Ctrl+L        — Focus address bar",
        "  Ctrl+R        — Refresh",
        "  Ctrl+D        — Bookmark page",
        "  Ctrl+B        — Bookmarks sidebar",
        "  Ctrl+H        — History sidebar",
        "  Ctrl+Shift+T  — Reopen last closed tab",
        "  Alt+Left      — Back",
        "  Alt+Right     — Forward",
        "  Alt+Home      — Go home",
      ].join("\n"));
    }

    /* ------------------------------------------------------------
     * FAKE DOWNLOAD MANAGER
     * --------------------------------------------------------- */
    _startFakeDownload(url) {
      const item = {
        id: uid("dl"),
        url,
        name: downloadFilenameFromUrl(url),
        progress: 0,
        complete: false,
        totalBytes: 500000 + Math.floor(Math.random() * 4500000),
      };
      this.downloads.unshift(item);
      this.downloadsVisible = true;
      $(this.root, "[data-ws-downloadbar]").hidden = false;
      this._renderDownloads();
      // Animate progress
      const start = Date.now();
      const duration = 1200 + Math.random() * 1800;
      const tick = () => {
        if (this.destroyed) return;
        const elapsed = Date.now() - start;
        const prog = Math.min(100, Math.round((elapsed / duration) * 100));
        item.progress = prog;
        if (prog >= 100) {
          item.complete = true;
          this._renderDownloads();
          return;
        }
        this._renderDownloads();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    _renderDownloads() {
      const list = $(this.root, "[data-ws-dl-items]");
      if (!list) return;
      list.innerHTML = "";
      this.downloads.forEach((d) => {
        const el = document.createElement("div");
        el.className = "ws-dl-item" + (d.complete ? " is-complete" : "");
        const statusText = d.complete
          ? "Complete · " + formatBytesCompact(d.totalBytes)
          : d.progress + "% · " + formatBytesCompact(Math.floor(d.totalBytes * d.progress / 100));
        el.innerHTML = `
          <div class="ws-dl-name" title="${escapeHtml(d.url)}">${escapeHtml(d.name)}</div>
          <div class="ws-dl-progress"><div class="ws-dl-progress-bar" style="width:${d.progress}%"></div></div>
          <div class="ws-dl-status">${escapeHtml(statusText)}</div>
        `;
        list.appendChild(el);
      });
    }
  }

  function formatBytesCompact(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
    return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  /* -------------------------------------------------------------------------
   * CSS AUTO-LINK
   * ---------------------------------------------------------------------- */
  (function ensureCss() {
    const href = "apps/browser/browser.css";
    const has = Array.from(document.styleSheets).some((s) => (s.href || "").endsWith(href));
    if (!has) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      document.head.appendChild(l);
    }
  })();

  /* -------------------------------------------------------------------------
   * REGISTER WITH WINDOW MANAGER
   * ---------------------------------------------------------------------- */
  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    // Remove stub browser from windowManager.registerBuiltIns
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id: APP_ID,
      title: APP_TITLE,
      icon: APP_ICON,
      width: 1040, height: 680,
      minWidth: 540, minHeight: 380,
      category: APP_CATEGORY,
      pinned: true,
      render(body, win) {
        const b = new WebSurf(body, win.opts || {});
        b.mount();
        win._websurf = b;
      },
      onClose(win) {
        if (win._websurf) win._websurf.destroy();
      },
    });
    console.log("%c[WebOS]%c WebSurf Browser registered",
      "color:#06b6d4;font-weight:bold", "color:inherit");
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* -------------------------------------------------------------------------
   * ADDITIONAL HELPERS & PUBLIC API SURFACE
   *   Exposed for other WebOS apps / developer console use.
   * ---------------------------------------------------------------------- */

  /**
   * Parse a query-string into an object. Used by the URL resolver for
   * smarter default search handling in future enhancements.
   */
  function parseQuery(qs) {
    const out = {};
    if (!qs) return out;
    qs = qs.replace(/^\?/, "");
    qs.split("&").forEach((pair) => {
      if (!pair) return;
      const [k, v] = pair.split("=");
      out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
    return out;
  }

  /**
   * Build a URL query string from an object (inverse of parseQuery).
   */
  function buildQuery(obj) {
    return Object.keys(obj || {}).map((k) =>
      encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])
    ).join("&");
  }

  /**
   * Very light URL validator. Used as a secondary check by the address
   * bar heuristic.
   */
  function isValidURL(s) {
    try { new URL(s); return true; } catch (_) { return false; }
  }

  /**
   * Extract a domain-level "host key" suitable for grouping history items.
   * Returns `null` for invalid inputs instead of throwing.
   */
  function hostKey(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, "").toLowerCase();
    } catch (_) { return null; }
  }

  /**
   * Group a list of history entries by host. Useful for rendering
   * grouped-history views in future.
   */
  function groupHistoryByHost(list) {
    const out = {};
    (list || []).forEach((e) => {
      const k = hostKey(e.url) || "(unknown)";
      (out[k] = out[k] || []).push(e);
    });
    return out;
  }

  /**
   * Produce a "most-visited" summary from a history list, sorted by count.
   */
  function mostVisited(list, limit) {
    const counts = {};
    (list || []).forEach((e) => {
      const k = e.url;
      if (!counts[k]) counts[k] = { url: k, title: e.title, count: 0, lastTs: 0 };
      counts[k].count += 1;
      counts[k].lastTs = Math.max(counts[k].lastTs, e.ts || 0);
    });
    return Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit || 10);
  }

  /**
   * Export the user's bookmarks as a Netscape-style HTML bookmark file string.
   * The major browsers all accept this format for import.
   */
  function exportBookmarksHTML(bookmarks) {
    const head = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      "<TITLE>WebSurf Bookmarks</TITLE>",
      "<H1>WebSurf Bookmarks</H1>",
      "<DL><p>",
    ];
    const body = (bookmarks || []).map((b) =>
      `    <DT><A HREF="${escapeAttr(b.url)}" ADD_DATE="${Math.floor((b.addedAt || Date.now()) / 1000)}">${escapeHtml(b.title || b.url)}</A>`
    );
    const tail = ["</DL><p>"];
    return head.concat(body).concat(tail).join("\n");
  }

  /**
   * Import a Netscape-format HTML bookmarks file. Returns an array of
   * `{ url, title, addedAt }` entries. Robust against missing tags.
   */
  function importBookmarksHTML(html) {
    if (!html) return [];
    const out = [];
    const re = /<A[^>]*HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      out.push({
        url: m[1],
        title: String(m[2]).replace(/<[^>]+>/g, "").trim(),
        addedAt: Date.now(),
      });
    }
    return out;
  }

  /**
   * Resolve a relative URL against a base. Thin wrapper around URL() that
   * never throws — on failure returns the input unchanged.
   */
  function resolveRelative(url, base) {
    try { return new URL(url, base).toString(); } catch (_) { return url; }
  }

  /**
   * Check whether two URLs point to the same "page" ignoring trailing
   * slashes and fragment identifiers. Used for de-duplicating history.
   */
  function sameURL(a, b) {
    if (!a || !b) return false;
    const norm = (u) => {
      try {
        const x = new URL(u);
        return (x.origin + x.pathname.replace(/\/+$/, "") + x.search).toLowerCase();
      } catch (_) { return String(u).toLowerCase(); }
    };
    return norm(a) === norm(b);
  }

  /* -------------------------------------------------------------------------
   * SELF TEST
   * ---------------------------------------------------------------------- */
  function selfTest() {
    const t = (name, cond) => {
      if (!cond) console.warn("[WebSurf self-test]", name, "FAIL");
      return !!cond;
    };
    let pass = 0, total = 0;
    const run = (n, c) => { total++; if (t(n, c)) pass++; };

    run("resolveAddress: empty -> home",
        resolveAddress("") === HOME_URL);
    run("resolveAddress: domain without scheme",
        resolveAddress("example.com") === "https://example.com");
    run("resolveAddress: full URL preserved",
        resolveAddress("https://foo.bar/x") === "https://foo.bar/x");
    run("resolveAddress: search terms → google",
        resolveAddress("hello world").startsWith(SEARCH_PREFIX));
    run("resolveAddress: localhost:port",
        resolveAddress("localhost:8080") === "https://localhost:8080");
    run("titleFromUrl google",
        titleFromUrl("https://www.google.com/search?q=test").indexOf("test") !== -1);
    run("isValidURL true",  isValidURL("https://a.b/c"));
    run("isValidURL false", !isValidURL("not a url at all"));
    run("faviconFor google", faviconFor("https://google.com") === "🔍");
    run("hostKey strips www", hostKey("https://www.github.com/x") === "github.com");
    run("sameURL ignores trailing slash",
        sameURL("https://a.com/x", "https://a.com/x/"));
    run("shouldFakeDownload pdf",
        shouldFakeDownload("https://site.com/file.pdf"));
    run("shouldFakeDownload html false",
        !shouldFakeDownload("https://site.com/index.html"));
    run("parseQuery/buildQuery round-trip",
        (() => {
          const s = "a=1&b=two%20words";
          const p = parseQuery(s);
          return p.a === "1" && p.b === "two words";
        })());
    run("exportBookmarksHTML contains dt",
        exportBookmarksHTML([{ url: "https://a.b", title: "A" }]).indexOf("<DT>") !== -1);
    run("importBookmarksHTML parses",
        importBookmarksHTML('<DL><DT><A HREF="https://a.b/c">Hi</A></DL>').length === 1);
    run("mostVisited sorts by count",
        mostVisited([
          { url: "x", ts: 1 }, { url: "x", ts: 2 }, { url: "y", ts: 3 }
        ])[0].url === "x");
    console.log("%c[WebSurf self-test]%c " + pass + "/" + total + " passed.",
      "color:#06b6d4;font-weight:bold", "color:inherit");
    return { pass, total };
  }

  /* -------------------------------------------------------------------------
   * EXPOSE
   * ---------------------------------------------------------------------- */
  window.WebSurf = {
    APP_ID,
    HOME_URL,
    SEARCH_PREFIX,
    DEFAULT_TILES,
    // URL helpers
    resolveAddress, titleFromUrl, faviconFor,
    parseQuery, buildQuery, isValidURL,
    hostKey, groupHistoryByHost, mostVisited,
    sameURL, resolveRelative,
    shouldFakeDownload, downloadFilenameFromUrl,
    // bookmarks import/export
    exportBookmarksHTML, importBookmarksHTML,
    // persistence
    loadBookmarks, saveBookmarks,
    loadHistory,   saveHistory,
    loadTiles,     saveTiles,
    // formatting
    formatDate, formatTime, prettyAgo, formatBytesCompact,
    // lifecycle
    open(url) { return window.WindowManager.openApp(APP_ID, url ? { openUrl: url } : {}); },
    selfTest,
  };

  /* -------------------------------------------------------------------------
   * SEARCH ENGINE REGISTRY
   *   A small catalog of popular search engines that power users may want
   *   to default-bind via the address bar. The current implementation
   *   always routes to Google, but exposing this registry here makes it
   *   trivial to extend in Day 4+.
   * ---------------------------------------------------------------------- */
  const SEARCH_ENGINES = {
    google:     { name: "Google",     url: "https://www.google.com/search?q=%s",    icon: "🔍" },
    bing:       { name: "Bing",       url: "https://www.bing.com/search?q=%s",      icon: "🌐" },
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s",          icon: "🦆" },
    startpage:  { name: "Startpage",  url: "https://www.startpage.com/do/search?q=%s", icon: "🔒" },
    yandex:     { name: "Yandex",     url: "https://yandex.com/search/?text=%s",    icon: "🌧️" },
    ecosia:     { name: "Ecosia",     url: "https://www.ecosia.org/search?q=%s",    icon: "🌲" },
    brave:      { name: "Brave",      url: "https://search.brave.com/search?q=%s", icon: "🦁" },
    wikipedia:  { name: "Wikipedia",  url: "https://en.wikipedia.org/wiki/Special:Search?search=%s", icon: "📚" },
    youtube:    { name: "YouTube",    url: "https://www.youtube.com/results?search_query=%s", icon: "📺" },
    github:     { name: "GitHub",     url: "https://github.com/search?q=%s",        icon: "🐙" },
  };

  /**
   * Build a full search URL for a given engine id and query.
   */
  function buildSearchUrl(engineId, query) {
    const eng = SEARCH_ENGINES[engineId] || SEARCH_ENGINES.google;
    return eng.url.replace("%s", encodeURIComponent(query || ""));
  }

  /* -------------------------------------------------------------------------
   * ADDRESS-BAR SUGGESTIONS
   *   Given a partial input and the user's bookmark + history lists, build
   *   a small ranked list of completion suggestions. The matcher is simple
   *   substring-based and case-insensitive, which is enough for a desktop
   *   UI without external dependencies.
   * ---------------------------------------------------------------------- */
  function buildSuggestions(input, bookmarks, history, maxItems) {
    maxItems = maxItems || 8;
    input = String(input || "").trim().toLowerCase();
    if (!input) return [];
    const scored = [];
    const seen = new Set();
    const push = (src, entry, score) => {
      const key = entry.url;
      if (seen.has(key)) return;
      seen.add(key);
      scored.push({ kind: src, url: entry.url, title: entry.title || entry.url, score });
    };
    (bookmarks || []).forEach((b) => {
      const hay = (b.title + " " + b.url).toLowerCase();
      const idx = hay.indexOf(input);
      if (idx !== -1) push("bookmark", b, 100 - idx); // bookmarks win
    });
    (history || []).forEach((h) => {
      const hay = (h.title + " " + h.url).toLowerCase();
      const idx = hay.indexOf(input);
      if (idx !== -1) push("history", h, 50 - idx);
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxItems);
  }

  /**
   * Filter the history list down to entries matching `text`.
   * Returns a new array; the input is never mutated.
   */
  function filterHistory(history, text) {
    if (!text) return (history || []).slice();
    const q = String(text).toLowerCase();
    return (history || []).filter((h) => {
      const hay = (h.title + " " + h.url).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /**
   * Filter bookmarks by a substring.
   */
  function filterBookmarks(bookmarks, text) {
    if (!text) return (bookmarks || []).slice();
    const q = String(text).toLowerCase();
    return (bookmarks || []).filter((b) => {
      const hay = (b.title + " " + b.url).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* -------------------------------------------------------------------------
   * COOKIE-LESS SESSION HELPERS
   *   Because WebSurf sandboxes every iframe, persistent state must live in
   *   WebOS FileSystem / localStorage. These helpers manage a lightweight
   *   per-host settings blob that tabs can read from or write to.
   * ---------------------------------------------------------------------- */
  const FS_HOST_SETTINGS = FS_DIR_CONFIG + "/host-settings.json";

  function loadHostSettings() {
    const fs = window.FileSystem;
    if (!fs) {
      try { return JSON.parse(localStorage.getItem("webos.websurf.hostSettings") || "{}"); }
      catch (_) { return {}; }
    }
    return readJSONFile(fs, FS_HOST_SETTINGS, {});
  }
  function saveHostSettings(obj) {
    const fs = window.FileSystem;
    if (!fs) {
      try { localStorage.setItem("webos.websurf.hostSettings", JSON.stringify(obj)); } catch (_) {}
      return;
    }
    writeJSONFile(fs, FS_HOST_SETTINGS, obj);
  }
  function getHostSetting(host, key, fallback) {
    const all = loadHostSettings();
    const byHost = all[host] || {};
    return Object.prototype.hasOwnProperty.call(byHost, key) ? byHost[key] : fallback;
  }
  function setHostSetting(host, key, value) {
    const all = loadHostSettings();
    const byHost = all[host] || (all[host] = {});
    byHost[key] = value;
    saveHostSettings(all);
  }

  /* -------------------------------------------------------------------------
   * TAB-GROUP HELPERS
   *   Future-facing utilities for grouping tabs by hostname. Right now the
   *   tab bar shows a flat list, but the grouping logic is needed to build
   *   the "Recent tabs" menu and the per-window restore flow.
   * ---------------------------------------------------------------------- */
  function groupTabsByHost(tabs) {
    const out = {};
    (tabs || []).forEach((t) => {
      const k = hostKey(t.url) || "(local)";
      (out[k] = out[k] || []).push(t);
    });
    return out;
  }

  /**
   * Given a tab's history stack, produce a compact summary suitable for
   * rendering in a tooltip when hovering the back/forward buttons.
   */
  function describeTabHistory(tab) {
    if (!tab || !tab.history) return "(no history)";
    const back = Math.max(0, tab.historyIdx);
    const fwd  = Math.max(0, tab.history.length - 1 - tab.historyIdx);
    return back + " back · " + fwd + " forward";
  }

  /* -------------------------------------------------------------------------
   * PAGE-INFO SUMMARIES
   *   Produce human-readable summaries of bookmark / history / tab lists.
   *   Used by external scripts and by the shortcuts panel for richer
   *   diagnostics.
   * ---------------------------------------------------------------------- */
  function summarize(webSurfInstance) {
    if (!webSurfInstance) return null;
    return {
      tabs:        webSurfInstance.tabs.length,
      activeTabId: webSurfInstance.activeTabId,
      bookmarks:   webSurfInstance.bookmarks.length,
      historySize: webSurfInstance.history.length,
      sidebar:     webSurfInstance.sidebarMode,
      downloads:   webSurfInstance.downloads.length,
    };
  }

  /* -------------------------------------------------------------------------
   * DATA URI BUILDERS
   *   Helpers to produce data: URIs for embedded preview pages. These are
   *   used by the homepage and by future "error page" rendering in place
   *   of an iframe navigation failure.
   * ---------------------------------------------------------------------- */
  function buildErrorPage(url, reason) {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Unable to load</title>
<style>
  body { font: 14px system-ui, -apple-system, sans-serif; background: #0f1223;
         color: #e7e9f3; padding: 48px; text-align: center; }
  .icon { font-size: 56px; }
  h1 { margin: 12px 0 4px; font-weight: 600; }
  code { color: #67e8f9; word-break: break-all; }
  p { opacity: .75; max-width: 520px; margin: 8px auto; line-height: 1.5; }
</style></head>
<body>
  <div class="icon">🔌</div>
  <h1>Couldn't load this page</h1>
  <p><code>${esc(url)}</code></p>
  <p>${esc(reason || "The server refused to embed this page, or the connection was interrupted.")}</p>
</body></html>`;
    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
  }

  /**
   * Build a minimal "new tab" error page shown when JavaScript is
   * explicitly disabled for an iframe (used as a fallback for about:blank).
   */
  function buildBlankPage() {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Blank</title>
<style>body { background:#0f1223;color:#9ca3af;font:13px system-ui;padding:40px;text-align:center }</style>
</head><body><div>about:blank</div></body></html>`;
    return "data:text/html;charset=utf-8," + encodeURIComponent(html);
  }

  /* -------------------------------------------------------------------------
   * PRIVATE BROWSING (STUB)
   *   Placeholder hooks so future code can add real InPrivate windows.
   *   For now we simply forward to the regular open flow with a marker.
   * ---------------------------------------------------------------------- */
  function openInPrivate(url) {
    const w = window.WindowManager && window.WindowManager.openApp
            ? window.WindowManager.openApp(APP_ID, { openUrl: url, isPrivate: true })
            : null;
    if (w) w.title = APP_TITLE + " — InPrivate";
    return w;
  }

  /* -------------------------------------------------------------------------
   * READING-LIST
   *   A lightweight FileSystem-backed reading list, separate from bookmarks,
   *   so that the user can queue pages to read later without polluting their
   *   permanent bookmarks. Persisted to ${FS_DIR_CONFIG}/reading-list.json.
   * ---------------------------------------------------------------------- */
  const FS_READING_LIST = FS_DIR_CONFIG + "/reading-list.json";

  function loadReadingList() {
    const fs = window.FileSystem;
    if (!fs) {
      try { return JSON.parse(localStorage.getItem("webos.websurf.reading") || "[]"); }
      catch (_) { return []; }
    }
    return readJSONFile(fs, FS_READING_LIST, []);
  }
  function saveReadingList(list) {
    const fs = window.FileSystem;
    if (!fs) {
      try { localStorage.setItem("webos.websurf.reading", JSON.stringify(list)); } catch (_) {}
      return;
    }
    writeJSONFile(fs, FS_READING_LIST, list);
  }
  function addToReadingList(item) {
    if (!item || !item.url) return;
    const list = loadReadingList();
    if (list.some((r) => r.url === item.url)) return;
    list.unshift({ url: item.url, title: item.title || titleFromUrl(item.url), addedAt: Date.now() });
    saveReadingList(list);
  }
  function removeFromReadingList(url) {
    const list = loadReadingList().filter((r) => r.url !== url);
    saveReadingList(list);
  }

  /* -------------------------------------------------------------------------
   * DEBUG LOGGING
   *   Enabled only when the user sets `localStorage.webos_websurf_debug = 1`.
   * ---------------------------------------------------------------------- */
  const DEBUG = (function () {
    try { return localStorage.getItem("webos_websurf_debug") === "1"; }
    catch (_) { return false; }
  })();
  function dlog() {
    if (!DEBUG) return;
    const args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["%c[WebSurf]", "color:#06b6d4"].concat(args));
  }

  /* -------------------------------------------------------------------------
   * EXPOSE ADDITIONAL HELPERS
   * ---------------------------------------------------------------------- */
  Object.assign(window.WebSurf, {
    SEARCH_ENGINES,
    buildSearchUrl,
    buildSuggestions,
    filterHistory, filterBookmarks,
    loadHostSettings, saveHostSettings,
    getHostSetting, setHostSetting,
    groupTabsByHost, describeTabHistory,
    summarize,
    buildErrorPage, buildBlankPage,
    openInPrivate,
    loadReadingList, saveReadingList,
    addToReadingList, removeFromReadingList,
    debug: dlog,
  });

  // Dispatch ready event
  try {
    window.dispatchEvent(new CustomEvent("webos:websurf-ready", {
      detail: {
        version: "1.0.0",
        tiles: DEFAULT_TILES.length,
        quotes: QUOTES.length,
        engines: Object.keys(SEARCH_ENGINES).length,
      }
    }));
  } catch (_) {}

  // Optional self-test via query string
  try {
    if (typeof location !== "undefined" && /[?&]websurf-selftest=1/.test(location.search)) {
      setTimeout(selfTest, 250);
    }
  } catch (_) {}

  /* -------------------------------------------------------------------------
   * URL NORMALIZATION & VALIDATION
   *   Additional URL-handling utilities. These are exposed on the public
   *   WebSurf API so other parts of WebOS (e.g. the taskbar, notifications)
   *   can reason about browser-owned URLs consistently.
   * ---------------------------------------------------------------------- */

  /**
   * Return a canonical, scheme-aware form of `url` suitable for display in
   * the address bar. Examples:
   *   "example.com"              -> "https://example.com"
   *   "HTTPS://Example.COM/a"    -> "https://example.com/a"
   *   "localhost:3000"           -> "http://localhost:3000"
   */
  function canonicalizeUrl(url) {
    url = String(url || "").trim();
    if (!url) return HOME_URL;
    if (url === HOME_URL) return url;
    try {
      const u = new URL(/^[a-z]+:/i.test(url) ? url : "https://" + url);
      u.protocol = u.protocol.toLowerCase();
      u.hostname = u.hostname.toLowerCase();
      return u.toString().replace(/\/$/, "");
    } catch (_) { return url; }
  }

  /**
   * Remove query parameters commonly used for tracking (utm_*, fbclid,
   * gclid, etc.). Non-destructive: returns a new URL string.
   */
  function stripTrackingParams(url) {
    try {
      const u = new URL(url);
      const banned = [
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
        "fbclid", "gclid", "msclkid", "yclid", "mc_eid", "mc_cid",
        "_hsenc", "_hsmi", "hsCtaTracking", "spm", "ref",
      ];
      banned.forEach((k) => u.searchParams.delete(k));
      return u.toString();
    } catch (_) { return url; }
  }

  /**
   * Quick detection of an address-bar token that should be treated as a URL
   * fragment (e.g. "#section") rather than a search query.
   */
  function isFragment(s) { return /^#/.test(String(s || "")); }

  /**
   * Strip a hostname's subdomain down to its registrable portion. Pure
   * heuristic based on dot-count — matches real public-suffix logic for the
   * common TLDs and is good enough for cosmetic display.
   */
  function registrableHost(hostname) {
    const parts = String(hostname || "").split(".");
    if (parts.length <= 2) return hostname;
    // Two-part TLDs: co.uk, com.au, co.jp, etc.
    const twoPartTlds = new Set([
      "co.uk", "co.jp", "co.kr", "co.in", "com.au", "com.br", "com.cn",
      "com.mx", "com.tr", "com.tw", "ne.jp", "or.jp", "ac.uk", "gov.uk",
    ]);
    const tail2 = parts.slice(-2).join(".");
    if (twoPartTlds.has(tail2) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  }

  /* -------------------------------------------------------------------------
   * TAB STATE SNAPSHOTS
   *   Produce a compact, JSON-serializable snapshot of the full session
   *   (all open tabs + sidebar state). Used by the (planned) session-restore
   *   feature and by tests that want to round-trip browser state.
   * ---------------------------------------------------------------------- */
  function snapshotSession(webSurfInstance) {
    if (!webSurfInstance) return null;
    return {
      version: 1,
      ts: Date.now(),
      activeTabId: webSurfInstance.activeTabId,
      sidebarMode: webSurfInstance.sidebarMode,
      tabs: webSurfInstance.tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        favicon: t.favicon,
        history: (t.history || []).slice(),
        historyIdx: t.historyIdx,
      })),
    };
  }

  /**
   * Restore a previously snapshotted session. Expects an empty WebSurf
   * instance; any existing tabs will be closed first. Returns the number
   * of tabs successfully restored.
   */
  function restoreSession(webSurfInstance, snapshot) {
    if (!webSurfInstance || !snapshot || !Array.isArray(snapshot.tabs)) return 0;
    // Close existing tabs first
    while (webSurfInstance.tabs.length > 1) {
      webSurfInstance.closeTab(webSurfInstance.tabs[0].id);
    }
    if (webSurfInstance.tabs.length === 1) {
      webSurfInstance.closeTab(webSurfInstance.tabs[0].id);
    }
    let restored = 0;
    snapshot.tabs.forEach((t) => {
      webSurfInstance.newTab(t.url || HOME_URL);
      restored += 1;
      // Replay history stack if available
      const liveTab = webSurfInstance.tabs[webSurfInstance.tabs.length - 1];
      if (liveTab && Array.isArray(t.history) && t.history.length > 1) {
        liveTab.history = t.history.slice();
        liveTab.historyIdx = Math.min(t.historyIdx || 0, liveTab.history.length - 1);
      }
    });
    return restored;
  }

  /* -------------------------------------------------------------------------
   * THEME HOOK
   *   React to theme changes dispatched by ThemeEngine so that the iframe
   *   contents — which have their own styles — can at least have their
   *   favicon chip tint refreshed without rerendering the whole window.
   * ---------------------------------------------------------------------- */
  function hookThemeEvents(instance) {
    const handler = () => {
      if (!instance || instance.destroyed) return;
      try { instance._updateChromeForActive(); } catch (_) {}
    };
    window.addEventListener("webos:theme-changed", handler);
    // Return a disposer so the caller can clean up on destroy()
    return () => window.removeEventListener("webos:theme-changed", handler);
  }

  /* -------------------------------------------------------------------------
   * PUBLIC API FOR CROSS-APP COMMUNICATION
   *   Other apps (File Manager, Start Menu, etc.) may want to open URLs in
   *   the browser without knowing its internal structure. We expose a small
   *   stable surface that wraps `WindowManager.openApp`.
   * ---------------------------------------------------------------------- */

  /**
   * Open a URL in a new WebSurf window. If a WebSurf window is already
   * open, add the URL as a new tab instead.
   */
  function openUrl(url) {
    const wm = window.WindowManager;
    if (!wm) return null;
    // Look for an existing browser window
    const allWins = wm.getAllWindows ? wm.getAllWindows() : [];
    const existing = (allWins || []).find((w) => w.appId === APP_ID && w._websurf);
    if (existing) {
      try { existing._websurf.newTab(url); return existing; }
      catch (_) { /* fall through */ }
    }
    return wm.openApp(APP_ID, url ? { openUrl: url } : {});
  }

  /**
   * Navigate the currently-active tab of the active browser window.
   */
  function navigateActive(url) {
    const wm = window.WindowManager;
    if (!wm) return null;
    const allWins = wm.getAllWindows ? wm.getAllWindows() : [];
    const existing = (allWins || []).find((w) => w.appId === APP_ID && w._websurf);
    if (existing) {
      try { existing._websurf.navigateActive(url); return existing; }
      catch (_) { /* fall through */ }
    }
    return openUrl(url);
  }

  /* -------------------------------------------------------------------------
   * DEVELOPER TOOLS STUBS
   *   A very small "view page source" / "inspect" surface. These operate on
   *   same-origin iframes only; cross-origin content silently no-ops.
   * ---------------------------------------------------------------------- */

  /**
   * Return the full HTML source of the currently active tab's iframe, or
   * `null` when the content is cross-origin (and therefore unreachable).
   */
  function getActiveSource(webSurfInstance) {
    if (!webSurfInstance) return null;
    const t = webSurfInstance.activeTab && webSurfInstance.activeTab();
    if (!t || !t.iframeEl) return null;
    try {
      const doc = t.iframeEl.contentDocument;
      if (!doc || !doc.documentElement) return null;
      return "<!doctype html>\n" + doc.documentElement.outerHTML;
    } catch (_) { return null; }
  }

  /**
   * Return the text content of the active tab's iframe. Useful for
   * integration tests and for future "reader mode" prototypes.
   */
  function getActiveText(webSurfInstance) {
    if (!webSurfInstance) return null;
    const t = webSurfInstance.activeTab && webSurfInstance.activeTab();
    if (!t || !t.iframeEl) return null;
    try {
      const doc = t.iframeEl.contentDocument;
      if (!doc || !doc.body) return null;
      return doc.body.innerText || doc.body.textContent || "";
    } catch (_) { return null; }
  }

  /* -------------------------------------------------------------------------
   * STATISTICS HELPERS
   *   Summary numbers useful for the dashboard / analytics plugin planned
   *   for a later day. Everything here is a pure function of the data.
   * ---------------------------------------------------------------------- */

  /**
   * Count the number of unique domains visited in the history list.
   */
  function uniqueHostCount(history) {
    const seen = new Set();
    (history || []).forEach((h) => {
      const k = hostKey(h.url);
      if (k) seen.add(k);
    });
    return seen.size;
  }

  /**
   * Return a map of hour-of-day -> visit count, for building histograms.
   */
  function histogramByHour(history) {
    const out = new Array(24).fill(0);
    (history || []).forEach((h) => {
      const d = new Date(h.ts || 0);
      out[d.getHours()] += 1;
    });
    return out;
  }

  /**
   * Produce a day-by-day visit histogram for the last N days (default 14).
   */
  function histogramByDay(history, days) {
    days = days || 14;
    const out = new Array(days).fill(0);
    const now = Date.now();
    (history || []).forEach((h) => {
      const diff = Math.floor((now - (h.ts || 0)) / 86400000);
      if (diff >= 0 && diff < days) out[diff] += 1;
    });
    return out;
  }

  /* -------------------------------------------------------------------------
   * EVENT BUS (lightweight pub/sub)
   *   Small observable so external code can react to browser lifecycle
   *   events without monkey-patching the class. Intentionally minimal.
   * ---------------------------------------------------------------------- */
  const _listeners = {};
  function on(event, fn) {
    (_listeners[event] = _listeners[event] || []).push(fn);
    return () => off(event, fn);
  }
  function off(event, fn) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter((f) => f !== fn);
  }
  function emit(event, payload) {
    (_listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.warn("[WebSurf] listener error", e); }
    });
  }

  /* -------------------------------------------------------------------------
   * EXPOSE FINAL EXTRAS
   * ---------------------------------------------------------------------- */
  Object.assign(window.WebSurf, {
    canonicalizeUrl,
    stripTrackingParams,
    isFragment,
    registrableHost,
    snapshotSession, restoreSession,
    hookThemeEvents,
    openUrl, navigateActive,
    getActiveSource, getActiveText,
    uniqueHostCount, histogramByHour, histogramByDay,
    on, off, emit,
  });

})();
