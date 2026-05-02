/* ============================================================================
 * WebOS — terminal.js (OsTerminal)
 * ----------------------------------------------------------------------------
 * Full-featured in-browser terminal emulator backed by window.FileSystem.
 *
 * Highlights
 *   - Multiple independent tabs, each with its own cwd / history / env / aliases
 *   - 30+ shell commands (filesystem, system, fun)
 *   - Tab autocomplete (commands then paths) with double-tab list expansion
 *   - Up/Down history navigation
 *   - Ctrl+R reverse-incremental search
 *   - Ctrl+L (clear), Ctrl+C (interrupt), Ctrl+A (home), Ctrl+E (end),
 *     Ctrl+W (delete word), Home/End/Arrow keys
 *   - ANSI colour-code rendering -> spans
 *   - 1000-line scrollback per tab
 *   - 5 selectable colour schemes; persistent in localStorage
 *   - Adjustable font size (Ctrl+= / Ctrl+-)
 *   - Mouse: copy on selection (default browser behaviour) + right-click paste
 *   - Fun commands: neofetch, cowsay, banner, matrix rain, snake, ping, curl,
 *     cal, weather
 *   - Self-registers with window.WindowManager as app id "terminal"
 *   - Registers canOpen() handlers for .sh / .bash / .zsh files
 *
 * Public API on window.OsTerminal
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * 0. Constants & configuration
   * ========================================================================*/

  const APP_ID      = "terminal";
  const APP_TITLE   = "OsTerminal";
  const APP_ICON    = "▚";

  const DEFAULT_USER     = "user";
  const DEFAULT_HOST     = "webos";
  const HOME_PATH        = "/home/user";
  const SCROLLBACK_LIMIT = 1000;
  const HISTORY_LIMIT    = 500;

  const STORAGE_PREFS = "webos.terminal.prefs";
  const STORAGE_HIST  = "webos.terminal.history";

  // Schemes mirrored from CSS for convenience
  const SCHEMES = ["dark", "light", "solarized", "dracula", "monokai"];

  // Allowed font sizes (must be present in CSS data-fontsize cases)
  const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

  // Default environment variables
  function makeDefaultEnv() {
    return {
      USER:    DEFAULT_USER,
      HOME:    HOME_PATH,
      SHELL:   "/bin/webash",
      TERM:    "xterm-256color",
      LANG:    "en_US.UTF-8",
      PATH:    "/usr/local/bin:/usr/bin:/bin",
      PWD:     HOME_PATH,
      OLDPWD:  HOME_PATH,
      EDITOR:  "textEditor",
      PAGER:   "less",
      SHLVL:   "1",
      HOSTNAME: DEFAULT_HOST,
    };
  }

  function makeDefaultAliases() {
    return {
      ll:      "ls -la",
      la:      "ls -a",
      l:       "ls",
      ".":     "pwd",
      "..":    "cd ..",
      cls:     "clear",
      "h":     "history",
      copy:    "cp",
      del:     "rm",
      e:       "echo",
    };
  }

  /* ==========================================================================
   * 1. Tiny utility helpers
   * ========================================================================*/

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function uid(prefix) {
    return (prefix || "id_") + Math.random().toString(36).slice(2, 10);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/"/g,  "&quot;")
      .replace(/'/g,  "&#39;");
  }

  function pad(n, w, c) {
    n = String(n);
    c = c || " ";
    while (n.length < w) n = c + n;
    return n;
  }

  function padR(n, w, c) {
    n = String(n);
    c = c || " ";
    while (n.length < w) n = n + c;
    return n;
  }

  function repeat(s, n) {
    let out = "";
    for (let i = 0; i < n; i++) out += s;
    return out;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function rngInt(lo, hi) {
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function pickOne(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* Read/write JSON in localStorage with safe fallback */
  function lsRead(key, def) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return def;
      return JSON.parse(raw);
    } catch (_) { return def; }
  }
  function lsWrite(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  /* Resolve FS — terminal works even if FS arrived late (rare) */
  function FS() { return window.FileSystem; }

  /* ==========================================================================
   * 2. Path normalisation specific to the terminal
   *    The FileSystem API has its own normaliser, but we need to expand "~"
   *    and "." / ".." manually relative to the *current* tab's cwd before
   *    handing the path to FS.
   * ========================================================================*/

  function expandTilde(path, env) {
    if (!path) return path;
    const home = (env && env.HOME) || HOME_PATH;
    if (path === "~") return home;
    if (path.startsWith("~/")) return home + path.slice(1);
    return path;
  }

  function isAbsolute(p) { return typeof p === "string" && p.startsWith("/"); }

  function joinResolve(cwd, target) {
    if (!target) return cwd;
    let p = target;
    if (!isAbsolute(p)) p = cwd.replace(/\/$/, "") + "/" + p;
    // collapse repeated slashes, "." and ".."
    const parts = p.split("/").filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      if (seg === ".") continue;
      if (seg === "..") { if (out.length) out.pop(); continue; }
      out.push(seg);
    }
    return "/" + out.join("/");
  }

  function resolvePath(target, ctx) {
    if (target == null) target = ctx.cwd;
    target = expandTilde(target, ctx.env);
    return joinResolve(ctx.cwd, target);
  }

  function shortenHome(path, env) {
    const home = (env && env.HOME) || HOME_PATH;
    if (path === home) return "~";
    if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
    return path;
  }

  /* ==========================================================================
   * 3. Lightweight argv parser + glob fnmatch
   * ========================================================================*/

  function tokenize(line) {
    /* Returns array of tokens. Supports single/double quotes & escapes.
       Also returns redirection markers as their own tokens (>, >>). */
    const tokens = [];
    let cur = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\" && i + 1 < line.length && (inDouble || (!inSingle && !inDouble))) {
        cur += line[i + 1];
        i++;
        continue;
      }
      if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
      if (!inSingle && !inDouble) {
        if (/\s/.test(c)) {
          if (cur.length) { tokens.push(cur); cur = ""; }
          continue;
        }
        if (c === ">") {
          if (cur.length) { tokens.push(cur); cur = ""; }
          if (line[i + 1] === ">") { tokens.push(">>"); i++; }
          else { tokens.push(">"); }
          continue;
        }
      }
      cur += c;
    }
    if (cur.length) tokens.push(cur);
    return tokens;
  }

  /* Split tokens around redirection (only output redirection supported) */
  function splitRedirect(tokens) {
    const argv = [];
    let redirect = null;
    let redirectMode = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === ">" || t === ">>") {
        redirectMode = t;
        redirect = tokens[i + 1] || null;
        i++;
        continue;
      }
      argv.push(t);
    }
    return { argv, redirect, redirectMode };
  }

  /* Convert a glob pattern to RegExp. Supports *, ?, [abc] */
  function globToRegex(glob) {
    let re = "^";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*")      re += ".*";
      else if (c === "?") re += ".";
      else if (c === "[") {
        let j = i + 1, neg = false;
        if (glob[j] === "!") { neg = true; j++; }
        let cls = "";
        while (j < glob.length && glob[j] !== "]") { cls += glob[j]; j++; }
        re += "[" + (neg ? "^" : "") + cls.replace(/\\/g, "\\\\") + "]";
        i = j;
      }
      else if (/[.+^$(){}|\\]/.test(c)) re += "\\" + c;
      else re += c;
    }
    return new RegExp(re + "$");
  }

  /* ==========================================================================
   * 4. ANSI color code -> HTML conversion
   *    Supports a useful subset of CSI SGR codes (foreground/background 16-color,
   *    bold/dim/italic/underline/inverse, reset). Unknown codes are ignored.
   * ========================================================================*/

  const ANSI_FG = {
    "30":"black","31":"red","32":"green","33":"yellow",
    "34":"blue","35":"magenta","36":"cyan","37":"white",
    "90":"bblack","91":"bred","92":"bgreen","93":"byellow",
    "94":"bblue","95":"bmagenta","96":"bcyan","97":"bwhite",
  };
  const ANSI_BG = {
    "40":"black","41":"red","42":"green","43":"yellow",
    "44":"blue","45":"magenta","46":"cyan","47":"white",
  };

  function ansiToHtml(text) {
    if (text == null) return "";
    text = String(text);
    if (text.indexOf("\u001b[") === -1) return escapeHtml(text);

    const re = /\u001b\[([0-9;]*)m/g;
    let out = "";
    let last = 0;
    const stack = []; // open spans
    let attrs = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };

    function span(a) {
      const cls = [];
      if (a.fg) cls.push("ansi-fg-" + a.fg);
      if (a.bg) cls.push("ansi-bg-" + a.bg);
      if (a.bold) cls.push("ansi-bold");
      if (a.dim) cls.push("ansi-dim");
      if (a.italic) cls.push("ansi-italic");
      if (a.underline) cls.push("ansi-underline");
      if (a.inverse) cls.push("ansi-reverse");
      if (cls.length === 0) return null;
      return '<span class="' + cls.join(" ") + '">';
    }

    function closeAll() {
      while (stack.length) { out += "</span>"; stack.pop(); }
    }

    function pushSpan() {
      const s = span(attrs);
      if (s) { out += s; stack.push(true); }
    }

    let m;
    while ((m = re.exec(text)) !== null) {
      out += escapeHtml(text.slice(last, m.index));
      last = re.lastIndex;
      const params = (m[1] === "" ? ["0"] : m[1].split(";"));
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === "0" || p === "")  { closeAll(); attrs = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }; continue; }
        if (p === "1") { closeAll(); attrs.bold = true; pushSpan(); continue; }
        if (p === "2") { closeAll(); attrs.dim = true;  pushSpan(); continue; }
        if (p === "3") { closeAll(); attrs.italic = true; pushSpan(); continue; }
        if (p === "4") { closeAll(); attrs.underline = true; pushSpan(); continue; }
        if (p === "7") { closeAll(); attrs.inverse = true; pushSpan(); continue; }
        if (p === "22"){ closeAll(); attrs.bold = false; attrs.dim = false; pushSpan(); continue; }
        if (p === "23"){ closeAll(); attrs.italic = false; pushSpan(); continue; }
        if (p === "24"){ closeAll(); attrs.underline = false; pushSpan(); continue; }
        if (p === "27"){ closeAll(); attrs.inverse = false; pushSpan(); continue; }
        if (p === "39"){ closeAll(); attrs.fg = null; pushSpan(); continue; }
        if (p === "49"){ closeAll(); attrs.bg = null; pushSpan(); continue; }
        if (ANSI_FG[p])  { closeAll(); attrs.fg = ANSI_FG[p]; pushSpan(); continue; }
        if (ANSI_BG[p])  { closeAll(); attrs.bg = ANSI_BG[p]; pushSpan(); continue; }
      }
    }
    out += escapeHtml(text.slice(last));
    closeAll();
    return out;
  }

  /* Helper for code that wants to inject ANSI color codes directly. */
  const ANSI = {
    reset:    "\u001b[0m",
    bold:     "\u001b[1m",
    dim:      "\u001b[2m",
    italic:   "\u001b[3m",
    underline:"\u001b[4m",
    fg: {
      black:  "\u001b[30m", red: "\u001b[31m", green: "\u001b[32m", yellow: "\u001b[33m",
      blue:   "\u001b[34m", magenta: "\u001b[35m", cyan: "\u001b[36m", white: "\u001b[37m",
      bblack: "\u001b[90m", bred: "\u001b[91m", bgreen: "\u001b[92m", byellow: "\u001b[93m",
      bblue:  "\u001b[94m", bmagenta:"\u001b[95m", bcyan:  "\u001b[96m", bwhite:  "\u001b[97m",
    },
  };

  function color(text, fg, bold) {
    let s = "";
    if (bold) s += ANSI.bold;
    if (fg) s += ANSI.fg[fg];
    s += text;
    s += ANSI.reset;
    return s;
  }

  /* ==========================================================================
   * 5. Per-tab session state
   *    Each tab has its own cwd, history, aliases, env, scrollback.
   * ========================================================================*/

  const sessions = new Map();    // sessionId -> Session

  function createSession(opts) {
    const sid = uid("term_");
    const session = {
      id:        sid,
      cwd:       (opts && opts.cwd) || HOME_PATH,
      history:   loadHistory(),
      historyCursor: -1,
      input:     "",
      caret:     0,
      env:       makeDefaultEnv(),
      aliases:   makeDefaultAliases(),
      buffer:    [],            // array of HTML strings (lines)
      pageEl:    null,
      outputEl:  null,
      promptEl:  null,
      inputTextEl: null,
      tabBtnEl:  null,
      tabTitle:  "Terminal",
      busy:      false,
      interruptCb: null,        // when set, Ctrl+C will call this
      pasteSelectActive: false,
      lastTabComplete: 0,
      lastTabPrefix: "",
      reverseSearch: null,      // {query, results, index}
      // snake / matrix transient state
      snake: null,
      matrix: null,
    };
    sessions.set(sid, session);
    return session;
  }

  function loadHistory() {
    const h = lsRead(STORAGE_HIST, []);
    return Array.isArray(h) ? h.slice(-HISTORY_LIMIT) : [];
  }

  function persistHistory(session) {
    /* History is shared across tabs via localStorage so a new tab gets a useful
       history right away. Each tab still keeps its own *navigation* cursor. */
    lsWrite(STORAGE_HIST, session.history.slice(-HISTORY_LIMIT));
  }

  function loadPrefs() {
    return Object.assign({
      scheme: "dark",
      fontSize: 14,
    }, lsRead(STORAGE_PREFS, {}));
  }

  function savePrefs(prefs) { lsWrite(STORAGE_PREFS, prefs); }

  /* ==========================================================================
   * 6. The Terminal component
   *    Manages the DOM, tabs, and routes keystrokes to the active session.
   * ========================================================================*/

  class TerminalApp {

    constructor(root, win) {
      this.root      = root;
      this.win       = win;
      this.prefs     = loadPrefs();
      this.tabsEl    = null;
      this.pagesEl   = null;
      this.shadowIn  = null;
      this.activeSid = null;
      this._pageTpl  = null;
      this._mounted  = false;
      this._keyHandlers = [];
      this._docHandlers = [];

      this._fontIdx  = FONT_SIZES.indexOf(this.prefs.fontSize);
      if (this._fontIdx < 0) this._fontIdx = FONT_SIZES.indexOf(14);
    }

    /* ------------------------------------------------------------------ */
    /* Mount / un-mount                                                   */
    /* ------------------------------------------------------------------ */

    async mount() {
      if (this._mounted) return;
      this._mounted = true;

      // Lazy-load HTML & CSS into the window body
      await this._injectHtml();
      this._injectCssOnce();
      this._cacheDom();
      this._applyPrefs();
      this._wireToolbar();
      this._wireKeyboard();
      this._wireMouse();

      // Create initial tab
      this.newTab({ welcome: true });
    }

    destroy() {
      // Remove document-level key handlers
      this._docHandlers.forEach((fn) => document.removeEventListener("keydown", fn, true));
      this._docHandlers = [];
      // Cleanup sessions
      sessions.forEach((s, id) => {
        if (s.matrix) cancelAnimationFrame(s.matrix.raf || 0);
        if (s.snake)  cancelAnimationFrame(s.snake.raf || 0);
        sessions.delete(id);
      });
    }

    async _injectHtml() {
      try {
        const res = await fetch("apps/terminal/terminal.html");
        const txt = await res.text();
        this.root.innerHTML = txt;
      } catch (e) {
        // Fall back to inline shell — minimal but functional
        this.root.innerHTML =
          '<div class="osterm-root" data-scheme="dark" data-fontsize="14">'+
          '<div class="osterm-toolbar"><div class="osterm-brand"><span class="osterm-brand-glyph">▚</span><span>OsTerminal</span></div></div>'+
          '<div class="osterm-tabbar"><div class="osterm-tabs" id="osterm-tabs"></div><button class="osterm-tab-add" id="osterm-tab-add">＋</button></div>'+
          '<div class="osterm-pages" id="osterm-pages"></div>'+
          '<input class="osterm-shadow-input" id="osterm-shadow-input" />'+
          '</div>';
      }
    }

    _injectCssOnce() {
      if (document.getElementById("osterm-css")) return;
      const link = document.createElement("link");
      link.id = "osterm-css";
      link.rel = "stylesheet";
      link.href = "apps/terminal/terminal.css";
      document.head.appendChild(link);
    }

    _cacheDom() {
      this.rootEl    = $(".osterm-root", this.root);
      this.tabsEl    = $("#osterm-tabs", this.root);
      this.tabAddEl  = $("#osterm-tab-add", this.root);
      this.pagesEl   = $("#osterm-pages", this.root);
      this.shadowIn  = $("#osterm-shadow-input", this.root);
      this._pageTpl  = $("#osterm-page-template", this.root);

      this.btnClear     = $("#osterm-btn-clear", this.root);
      this.btnCopy      = $("#osterm-btn-copy", this.root);
      this.btnPaste     = $("#osterm-btn-paste", this.root);
      this.schemeSelect = $("#osterm-scheme", this.root);
      this.fontDownBtn  = $("#osterm-font-down", this.root);
      this.fontUpBtn    = $("#osterm-font-up", this.root);
      this.fontDisplay  = $("#osterm-fontsize-display", this.root);
      this.statusDot    = $("#osterm-status-dot", this.root);
      this.statusText   = $("#osterm-status-text", this.root);

      this.rsearchEl       = $("#osterm-rsearch", this.root);
      this.rsearchQuery    = $("#osterm-rsearch-query", this.root);
      this.rsearchResult   = $("#osterm-rsearch-result", this.root);

      this.snakeHud        = $("#osterm-snake-hud", this.root);
      this.snakeScoreEl    = $("#osterm-snake-score", this.root);
    }

    _applyPrefs() {
      if (!this.rootEl) return;
      this.rootEl.setAttribute("data-scheme", this.prefs.scheme);
      this.rootEl.setAttribute("data-fontsize", String(this.prefs.fontSize));
      if (this.schemeSelect) this.schemeSelect.value = this.prefs.scheme;
      if (this.fontDisplay) this.fontDisplay.textContent = this.prefs.fontSize + "px";
    }

    _wireToolbar() {
      if (this.tabAddEl) this.tabAddEl.addEventListener("click", () => this.newTab());

      if (this.btnClear) this.btnClear.addEventListener("click", () => {
        const s = this._active(); if (s) this._clear(s);
        this._focusInput();
      });

      if (this.btnCopy) this.btnCopy.addEventListener("click", () => {
        const text = (window.getSelection && window.getSelection().toString()) || "";
        if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        this._focusInput();
      });

      if (this.btnPaste) this.btnPaste.addEventListener("click", () => {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((txt) => {
            const s = this._active(); if (!s) return;
            this._insertText(s, txt);
          }).catch(() => {});
        }
        this._focusInput();
      });

      if (this.schemeSelect) this.schemeSelect.addEventListener("change", () => {
        this.prefs.scheme = this.schemeSelect.value;
        this.rootEl.setAttribute("data-scheme", this.prefs.scheme);
        savePrefs(this.prefs);
        this._focusInput();
      });

      if (this.fontDownBtn) this.fontDownBtn.addEventListener("click", () => this.changeFont(-1));
      if (this.fontUpBtn)   this.fontUpBtn.addEventListener("click",   () => this.changeFont(+1));
    }

    _wireMouse() {
      if (!this.pagesEl) return;
      // Right-click paste
      this.pagesEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then((txt) => {
            const s = this._active(); if (!s) return;
            this._insertText(s, txt);
          }).catch(() => {});
        }
      });
      // Click anywhere -> focus shadow input (preserve selection)
      this.pagesEl.addEventListener("mouseup", () => {
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) {
          // user is selecting text — don't hijack focus
          if (navigator.clipboard) {
            try { navigator.clipboard.writeText(sel); } catch (_) {}
          }
          return;
        }
        this._focusInput();
      });
    }

    _wireKeyboard() {
      // Catch keys at document level — but only when our window is focused
      const handler = (e) => {
        const root = this.rootEl;
        if (!root || !root.isConnected) return;
        // Only handle if our window contains the active focus or none does
        const active = document.activeElement;
        const inOurs = root.contains(active) || active === document.body || active === this.shadowIn;
        if (!inOurs) return;
        this._onKey(e);
      };
      this._docHandlers.push(handler);
      document.addEventListener("keydown", handler, true);
    }

    _focusInput() {
      if (this.shadowIn) {
        try { this.shadowIn.focus({ preventScroll: true }); } catch (_) { this.shadowIn.focus(); }
      }
    }

    _active() {
      return this.activeSid ? sessions.get(this.activeSid) : null;
    }

    /* ------------------------------------------------------------------ */
    /* Tab management                                                     */
    /* ------------------------------------------------------------------ */

    newTab(opts) {
      opts = opts || {};
      const session = createSession({ cwd: opts.cwd || HOME_PATH });
      session.tabTitle = opts.title || ("Terminal " + (this.tabsEl.children.length + 1));

      // Tab button
      const tab = document.createElement("button");
      tab.className = "osterm-tab";
      tab.dataset.sid = session.id;
      tab.innerHTML =
        '<span class="osterm-tab-icon">▚</span>' +
        '<span class="osterm-tab-title">' + escapeHtml(session.tabTitle) + '</span>' +
        '<span class="osterm-tab-close" title="Close tab" aria-label="Close tab">✕</span>';
      tab.addEventListener("click", (e) => {
        if ((e.target instanceof Element) && e.target.classList.contains("osterm-tab-close")) {
          this.closeTab(session.id);
          e.stopPropagation();
          return;
        }
        this.activateTab(session.id);
      });
      this.tabsEl.appendChild(tab);
      session.tabBtnEl = tab;

      // Page
      let page;
      if (this._pageTpl && this._pageTpl.content) {
        page = this._pageTpl.content.firstElementChild.cloneNode(true);
      } else {
        page = document.createElement("div");
        page.className = "osterm-page";
        page.innerHTML =
          '<div class="osterm-output" tabindex="0"></div>' +
          '<div class="osterm-input-row"><span class="osterm-prompt"></span>' +
          '<span class="osterm-input-wrap"><span class="osterm-input-text"></span>' +
          '<span class="osterm-cursor">█</span></span></div>' +
          '<div class="osterm-completions" hidden></div>';
      }
      page.dataset.tabId = session.id;
      this.pagesEl.appendChild(page);

      session.pageEl     = page;
      session.outputEl   = $(".osterm-output", page);
      session.promptEl   = $(".osterm-prompt", page);
      session.inputTextEl= $(".osterm-input-text", page);
      session.cursorEl   = $(".osterm-cursor", page);
      session.completionsEl = $(".osterm-completions", page);

      this.activateTab(session.id);

      if (opts.welcome) this._printWelcome(session);
      this._renderPrompt(session);
      this._renderInput(session);
      this._focusInput();
      return session;
    }

    activateTab(sid) {
      const s = sessions.get(sid);
      if (!s) return;
      this.activeSid = sid;
      $$(".osterm-tab", this.root).forEach((b) => b.classList.toggle("is-active", b.dataset.sid === sid));
      $$(".osterm-page", this.root).forEach((p) => p.classList.toggle("is-active", p.dataset.tabId === sid));
      this._focusInput();
      this._scrollToBottom(s);
    }

    closeTab(sid) {
      const s = sessions.get(sid);
      if (!s) return;
      // Cleanup any running effects
      if (s.matrix) { cancelAnimationFrame(s.matrix.raf || 0); s.matrix = null; }
      if (s.snake)  { cancelAnimationFrame(s.snake.raf || 0);  s.snake  = null; }
      const tabs = $$(".osterm-tab", this.root);
      const idx  = tabs.findIndex((t) => t.dataset.sid === sid);
      s.tabBtnEl && s.tabBtnEl.remove();
      s.pageEl   && s.pageEl.remove();
      sessions.delete(sid);

      // Activate neighbour or create new one
      const remaining = $$(".osterm-tab", this.root);
      if (remaining.length === 0) {
        this.newTab({ welcome: false });
      } else {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        if (next) this.activateTab(next.dataset.sid);
      }
    }

    /* ------------------------------------------------------------------ */
    /* Font size                                                          */
    /* ------------------------------------------------------------------ */

    changeFont(delta) {
      this._fontIdx = clamp(this._fontIdx + delta, 0, FONT_SIZES.length - 1);
      this.prefs.fontSize = FONT_SIZES[this._fontIdx];
      this.rootEl.setAttribute("data-fontsize", String(this.prefs.fontSize));
      this.fontDisplay.textContent = this.prefs.fontSize + "px";
      savePrefs(this.prefs);
    }

    setScheme(name) {
      if (SCHEMES.indexOf(name) === -1) return;
      this.prefs.scheme = name;
      this.rootEl.setAttribute("data-scheme", name);
      this.schemeSelect.value = name;
      savePrefs(this.prefs);
    }

    /* ------------------------------------------------------------------ */
    /* Welcome banner & prompt rendering                                  */
    /* ------------------------------------------------------------------ */

    _printWelcome(session) {
      const lines = [
        ANSI.fg.bcyan + ANSI.bold +
          "  __        __   _      ___  ____  " + ANSI.reset,
        ANSI.fg.bcyan + ANSI.bold +
          "  \\ \\      / /__| |__  / _ \\/ ___| " + ANSI.reset,
        ANSI.fg.bcyan + ANSI.bold +
          "   \\ \\ /\\ / / _ \\ '_ \\| | | \\___ \\ " + ANSI.reset,
        ANSI.fg.bcyan + ANSI.bold +
          "    \\ V  V /  __/ |_) | |_| |___) |" + ANSI.reset,
        ANSI.fg.bcyan + ANSI.bold +
          "     \\_/\\_/ \\___|_.__/ \\___/|____/ " + ANSI.reset,
        "",
        ANSI.fg.byellow + "Welcome to OsTerminal." + ANSI.reset +
          " Type " + ANSI.fg.bgreen + "help" + ANSI.reset + " for a list of commands.",
        ANSI.fg.bblack + "WeBash 2.0  ·  " + new Date().toString() + ANSI.reset,
        "",
      ];
      lines.forEach((l) => this._println(session, l));
    }

    _renderPrompt(session) {
      const path = shortenHome(session.cwd, session.env);
      const u = session.env.USER || DEFAULT_USER;
      const h = session.env.HOSTNAME || DEFAULT_HOST;
      // Format: user@host:path$
      const html =
        '<span class="ot-pr-user">' + escapeHtml(u) + '</span>' +
        '<span class="ot-pr-sep">@</span>' +
        '<span class="ot-pr-host">' + escapeHtml(h) + '</span>' +
        '<span class="ot-pr-sep">:</span>' +
        '<span class="ot-pr-path">' + escapeHtml(path) + '</span>' +
        '<span class="ot-pr-tail">$</span> ';
      session.promptEl.innerHTML = html;
    }

    _renderInput(session) {
      // Render input with cursor in the middle by splitting around caret
      const before = session.input.slice(0, session.caret);
      const after  = session.input.slice(session.caret);
      session.inputTextEl.innerHTML = escapeHtml(before);
      // Place cursor inside the caret position. We achieve mid-cursor by
      // appending after-text after the cursor element.
      let afterEl = session.pageEl.querySelector(".osterm-after-cursor");
      if (!afterEl) {
        afterEl = document.createElement("span");
        afterEl.className = "osterm-after-cursor";
        session.cursorEl.parentNode.appendChild(afterEl);
      }
      afterEl.textContent = after;
    }

    /* ------------------------------------------------------------------ */
    /* Output                                                             */
    /* ------------------------------------------------------------------ */

    _println(session, text, cls) {
      this._print(session, (text == null ? "" : text), cls);
      // newline always implied by block-level .osterm-line
    }

    _print(session, text, cls) {
      const div = document.createElement("div");
      div.className = "osterm-line" + (cls ? " " + cls : "");
      div.innerHTML = ansiToHtml(text);
      session.outputEl.appendChild(div);
      session.buffer.push(div);
      // Trim buffer to scrollback limit
      while (session.buffer.length > SCROLLBACK_LIMIT) {
        const old = session.buffer.shift();
        if (old.parentNode) old.parentNode.removeChild(old);
      }
      this._scrollToBottom(session);
    }

    _printRaw(session, html, cls) {
      const div = document.createElement("div");
      div.className = "osterm-line" + (cls ? " " + cls : "");
      div.innerHTML = html;
      session.outputEl.appendChild(div);
      session.buffer.push(div);
      while (session.buffer.length > SCROLLBACK_LIMIT) {
        const old = session.buffer.shift();
        if (old.parentNode) old.parentNode.removeChild(old);
      }
      this._scrollToBottom(session);
    }

    _scrollToBottom(session) {
      if (!session || !session.outputEl) return;
      session.outputEl.scrollTop = session.outputEl.scrollHeight;
    }

    _clear(session) {
      session.outputEl.innerHTML = "";
      session.buffer = [];
    }

    /* ------------------------------------------------------------------ */
    /* Input editing                                                      */
    /* ------------------------------------------------------------------ */

    _onKey(e) {
      const s = this._active();
      if (!s) return;

      // Reverse-search has its own input handling
      if (s.reverseSearch) {
        return this._onKeyReverseSearch(e, s);
      }
      // Snake game
      if (s.snake && s.snake.active) {
        return this._onKeySnake(e, s);
      }

      const key = e.key;

      // Global shortcuts (don't depend on text input)
      if (e.ctrlKey && (key === "+" || key === "=")) {
        e.preventDefault(); this.changeFont(+1); return;
      }
      if (e.ctrlKey && key === "-") {
        e.preventDefault(); this.changeFont(-1); return;
      }
      if (e.ctrlKey && e.shiftKey && (key === "T" || key === "t")) {
        e.preventDefault(); this.newTab(); return;
      }
      if (e.ctrlKey && e.shiftKey && (key === "W" || key === "w")) {
        e.preventDefault(); this.closeTab(s.id); return;
      }
      if (e.ctrlKey && key === "Tab") {
        e.preventDefault();
        const tabs = $$(".osterm-tab", this.root);
        const idx  = tabs.findIndex((t) => t.dataset.sid === s.id);
        const next = tabs[(idx + 1) % tabs.length];
        if (next) this.activateTab(next.dataset.sid);
        return;
      }

      // Ctrl+L — clear
      if (e.ctrlKey && (key === "L" || key === "l")) {
        e.preventDefault(); this._clear(s); return;
      }

      // Ctrl+C
      if (e.ctrlKey && (key === "C" || key === "c")) {
        // If the user has a text selection, let the browser copy it
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) return; // browser handles copy
        e.preventDefault();
        if (s.interruptCb) { try { s.interruptCb(); } catch (_) {} }
        if (s.input.length || s.caret > 0) {
          // Echo a ^C and clear input
          this._echoCommand(s, s.input, true);
          s.input = ""; s.caret = 0;
          this._renderInput(s);
        }
        return;
      }

      // Ctrl+A — start of line
      if (e.ctrlKey && (key === "A" || key === "a")) {
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) return;
        e.preventDefault(); s.caret = 0; this._renderInput(s); return;
      }
      // Ctrl+E — end of line
      if (e.ctrlKey && (key === "E" || key === "e")) {
        e.preventDefault(); s.caret = s.input.length; this._renderInput(s); return;
      }
      // Ctrl+W — delete word before caret
      if (e.ctrlKey && (key === "W" || key === "w")) {
        e.preventDefault();
        const before = s.input.slice(0, s.caret);
        const after  = s.input.slice(s.caret);
        const newBefore = before.replace(/\S+\s*$/, "");
        s.input = newBefore + after;
        s.caret = newBefore.length;
        this._renderInput(s);
        return;
      }
      // Ctrl+U — delete to start of line
      if (e.ctrlKey && (key === "U" || key === "u")) {
        e.preventDefault();
        s.input = s.input.slice(s.caret);
        s.caret = 0;
        this._renderInput(s);
        return;
      }
      // Ctrl+K — delete to end of line
      if (e.ctrlKey && (key === "K" || key === "k")) {
        e.preventDefault();
        s.input = s.input.slice(0, s.caret);
        this._renderInput(s);
        return;
      }
      // Ctrl+R — reverse search
      if (e.ctrlKey && (key === "R" || key === "r")) {
        e.preventDefault(); this._startReverseSearch(s); return;
      }

      // Tab — autocomplete
      if (key === "Tab") {
        e.preventDefault();
        const now = Date.now();
        const same = (now - s.lastTabComplete) < 500 && s.lastTabPrefix === s.input;
        s.lastTabComplete = now;
        s.lastTabPrefix   = s.input;
        this._autocomplete(s, same);
        return;
      }
      // Hide completions on any other key
      if (s.completionsEl && !s.completionsEl.hidden) {
        s.completionsEl.hidden = true;
      }

      // History navigation
      if (key === "ArrowUp") {
        e.preventDefault(); this._historyPrev(s); return;
      }
      if (key === "ArrowDown") {
        e.preventDefault(); this._historyNext(s); return;
      }

      // Caret motion
      if (key === "ArrowLeft") {
        if (s.caret > 0) { s.caret--; this._renderInput(s); }
        e.preventDefault(); return;
      }
      if (key === "ArrowRight") {
        if (s.caret < s.input.length) { s.caret++; this._renderInput(s); }
        e.preventDefault(); return;
      }
      if (key === "Home") { s.caret = 0; this._renderInput(s); e.preventDefault(); return; }
      if (key === "End")  { s.caret = s.input.length; this._renderInput(s); e.preventDefault(); return; }

      // Backspace / Delete
      if (key === "Backspace") {
        e.preventDefault();
        if (s.caret > 0) {
          s.input = s.input.slice(0, s.caret - 1) + s.input.slice(s.caret);
          s.caret--;
          this._renderInput(s);
        }
        return;
      }
      if (key === "Delete") {
        e.preventDefault();
        if (s.caret < s.input.length) {
          s.input = s.input.slice(0, s.caret) + s.input.slice(s.caret + 1);
          this._renderInput(s);
        }
        return;
      }

      // Enter
      if (key === "Enter") {
        e.preventDefault();
        const line = s.input;
        s.input = ""; s.caret = 0;
        this._renderInput(s);
        this._submit(s, line);
        return;
      }

      // Printable
      if (!e.ctrlKey && !e.metaKey && !e.altKey && key && key.length === 1) {
        e.preventDefault();
        this._insertText(s, key);
        return;
      }
    }

    _insertText(session, text) {
      session.input = session.input.slice(0, session.caret) + text + session.input.slice(session.caret);
      session.caret += text.length;
      this._renderInput(session);
    }

    _historyPrev(s) {
      if (s.history.length === 0) return;
      if (s.historyCursor === -1) s.historyCursor = s.history.length;
      s.historyCursor = clamp(s.historyCursor - 1, 0, s.history.length - 1);
      s.input = s.history[s.historyCursor] || "";
      s.caret = s.input.length;
      this._renderInput(s);
    }

    _historyNext(s) {
      if (s.historyCursor === -1) return;
      s.historyCursor++;
      if (s.historyCursor >= s.history.length) {
        s.historyCursor = -1;
        s.input = "";
      } else {
        s.input = s.history[s.historyCursor];
      }
      s.caret = s.input.length;
      this._renderInput(s);
    }

    /* ------------------------------------------------------------------ */
    /* Reverse search                                                     */
    /* ------------------------------------------------------------------ */

    _startReverseSearch(s) {
      s.reverseSearch = { query: "", index: -1, match: "" };
      this.rsearchEl.hidden = false;
      this.rsearchQuery.textContent = "";
      this.rsearchResult.textContent = "";
    }

    _endReverseSearch(s, accept) {
      const r = s.reverseSearch;
      s.reverseSearch = null;
      this.rsearchEl.hidden = true;
      if (accept && r && r.match) {
        s.input = r.match;
        s.caret = s.input.length;
        this._renderInput(s);
      }
    }

    _onKeyReverseSearch(e, s) {
      const r = s.reverseSearch;
      const key = e.key;
      if (key === "Escape") { e.preventDefault(); this._endReverseSearch(s, false); return; }
      if (key === "Enter")  { e.preventDefault(); this._endReverseSearch(s, true); return; }
      if (e.ctrlKey && (key === "R" || key === "r")) {
        e.preventDefault();
        this._reverseSearchStep(s, r.index - 1);
        return;
      }
      if (key === "Backspace") {
        e.preventDefault();
        r.query = r.query.slice(0, -1);
        this._reverseSearchUpdate(s);
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && key.length === 1) {
        e.preventDefault();
        r.query += key;
        this._reverseSearchUpdate(s);
        return;
      }
    }

    _reverseSearchUpdate(s) {
      const r = s.reverseSearch;
      this.rsearchQuery.textContent = r.query;
      // Find latest matching command
      let found = "";
      let foundIdx = -1;
      for (let i = s.history.length - 1; i >= 0; i--) {
        if (s.history[i].indexOf(r.query) >= 0) { found = s.history[i]; foundIdx = i; break; }
      }
      r.match = found; r.index = foundIdx;
      this.rsearchResult.textContent = found || "(no match)";
    }

    _reverseSearchStep(s, fromIdx) {
      const r = s.reverseSearch;
      if (!r.query) return;
      let idx = fromIdx;
      if (idx < 0) idx = s.history.length - 1;
      while (idx >= 0) {
        if (s.history[idx].indexOf(r.query) >= 0) {
          r.match = s.history[idx]; r.index = idx;
          this.rsearchResult.textContent = r.match;
          return;
        }
        idx--;
      }
    }

    /* ------------------------------------------------------------------ */
    /* Autocomplete                                                       */
    /* ------------------------------------------------------------------ */

    _autocomplete(s, second) {
      const tokens = tokenize(s.input);
      const atFirst = tokens.length <= 1 && !s.input.endsWith(" ");
      const fragment = (s.input.endsWith(" ") || tokens.length === 0) ? "" : tokens[tokens.length - 1];

      let matches = [];
      let kindHint = "";

      if (atFirst) {
        const cmds = Object.keys(COMMANDS).concat(Object.keys(s.aliases));
        matches = cmds.filter((c) => c.startsWith(fragment)).sort();
        kindHint = "cmd";
      } else {
        // path completion
        let dir, prefix;
        if (fragment.length === 0) { dir = s.cwd; prefix = ""; }
        else {
          let abs = expandTilde(fragment, s.env);
          if (abs.endsWith("/")) { dir = joinResolve(s.cwd, abs); prefix = ""; }
          else {
            const lastSlash = abs.lastIndexOf("/");
            if (lastSlash === -1) { dir = s.cwd; prefix = abs; }
            else { dir = joinResolve(s.cwd, abs.slice(0, lastSlash) || "/"); prefix = abs.slice(lastSlash + 1); }
          }
        }
        try {
          const entries = FS().listDir(dir);
          matches = entries.filter((en) => en.name.startsWith(prefix))
                            .map((en) => ({ name: en.name, type: en.type }));
          matches.sort((a, b) => a.name.localeCompare(b.name));
        } catch (_) { matches = []; }
        kindHint = "path";
      }

      if (matches.length === 0) return;

      if (matches.length === 1) {
        const repl = (kindHint === "cmd") ? matches[0] : matches[0].name;
        this._applyCompletion(s, fragment, repl, kindHint, atFirst, matches[0]);
        return;
      }

      // Multiple — find common prefix
      const names = (kindHint === "cmd") ? matches : matches.map((m) => m.name);
      const common = longestCommonPrefix(names);
      if (common.length > fragment.length) {
        this._applyCompletion(s, fragment, common, kindHint, atFirst);
        return;
      }

      // Show list (always; double-tab condition is informational)
      this._showCompletions(s, matches, kindHint);
    }

    _applyCompletion(s, fragment, replacement, kindHint, atFirst, info) {
      let suffix = "";
      if (kindHint === "path" && info && info.type === "folder") suffix = "/";
      else if (kindHint === "cmd") suffix = " ";

      // Replace fragment in input — preserving surrounding whitespace
      const before = s.input.slice(0, s.caret);
      const after  = s.input.slice(s.caret);
      const re     = /(\S*)$/;
      const m      = before.match(re);
      const start  = before.length - (m ? m[1].length : 0);

      let newInput;
      if (kindHint === "path") {
        const tildeReplace = expandTildePreservingPrefix(fragment, replacement, s.env);
        newInput = before.slice(0, start) + tildeReplace + suffix + after;
        s.caret  = (before.slice(0, start) + tildeReplace + suffix).length;
      } else {
        newInput = before.slice(0, start) + replacement + suffix + after;
        s.caret  = (before.slice(0, start) + replacement + suffix).length;
      }
      s.input = newInput;
      this._renderInput(s);
      if (s.completionsEl) s.completionsEl.hidden = true;
    }

    _showCompletions(s, matches, kindHint) {
      const c = s.completionsEl;
      if (!c) return;
      const html = matches.map((m) => {
        const name = (kindHint === "path") ? m.name : m;
        const dir  = (kindHint === "path") && m.type === "folder";
        return '<span class="osterm-completion-item' + (dir ? " is-dir" : "") + '">' +
               escapeHtml(name) + (dir ? "/" : "") + '</span>';
      }).join("");
      c.innerHTML = html;
      c.hidden = false;
    }

    /* ------------------------------------------------------------------ */
    /* Command submission                                                 */
    /* ------------------------------------------------------------------ */

    _echoCommand(s, line, interrupted) {
      // Render a static line that matches the prompt + the command typed
      const prompt = s.promptEl.outerHTML;
      const echoLine = document.createElement("div");
      echoLine.className = "osterm-line osterm-line-cmd";
      echoLine.innerHTML = prompt + escapeHtml(line) + (interrupted ? '<span class="ansi-fg-red">^C</span>' : "");
      s.outputEl.appendChild(echoLine);
      s.buffer.push(echoLine);
    }

    _submit(s, line) {
      // Clear historyCursor when we submit
      s.historyCursor = -1;

      if (line.length) {
        this._echoCommand(s, line, false);
        // Push to history (avoid consecutive duplicates)
        if (s.history[s.history.length - 1] !== line) {
          s.history.push(line);
          if (s.history.length > HISTORY_LIMIT) s.history.shift();
          persistHistory(s);
        }
      } else {
        this._echoCommand(s, "", false);
        return;
      }

      this._executeLine(s, line);
    }

    _executeLine(s, line) {
      // Expand alias (at first token only, single substitution)
      let raw = line.trim();
      if (!raw) return;

      // Multi-statement support via `;` and `&&`
      const stmts = splitStatements(raw);
      const run = (idx) => {
        if (idx >= stmts.length) return;
        const stmt = stmts[idx];
        const ok = this._executeStmt(s, stmt.cmd);
        if (stmt.next === "&&" && !ok) return; // short-circuit
        run(idx + 1);
      };
      run(0);
    }

    _executeStmt(s, cmd) {
      // alias expansion
      const firstSpace = cmd.indexOf(" ");
      const head = (firstSpace === -1 ? cmd : cmd.slice(0, firstSpace));
      if (s.aliases[head]) {
        const tail = (firstSpace === -1 ? "" : cmd.slice(firstSpace));
        cmd = s.aliases[head] + tail;
      }

      const tokens = tokenize(cmd);
      if (tokens.length === 0) return true;

      const { argv, redirect, redirectMode } = splitRedirect(tokens);
      const name = argv[0];
      const handler = COMMANDS[name];

      if (!handler) {
        this._println(s, color("webash: command not found: " + name, "red"), "osterm-line-err");
        return false;
      }

      // If output redirected, we capture into a buffer
      const ctx = {
        argv: argv.slice(1),
        cwd: s.cwd,
        env: s.env,
        session: s,
        terminal: this,
        out: [],
        err: [],
        captureOut: !!redirect,
        print(text, cls) {
          if (this.captureOut) this.out.push(text == null ? "" : String(text));
          else this.terminal._println(s, text == null ? "" : text, cls);
        },
        printRaw(html, cls) {
          if (this.captureOut) this.out.push(htmlToText(html));
          else this.terminal._printRaw(s, html, cls);
        },
        error(text) {
          this.terminal._println(s, color(text, "red"), "osterm-line-err");
        },
        warn(text) {
          this.terminal._println(s, color(text, "yellow"), "osterm-line-warn");
        },
      };

      let exitCode = 0;
      try {
        const r = handler(ctx);
        exitCode = (typeof r === "number") ? r : 0;
      } catch (e) {
        ctx.error("webash: " + (e && e.message ? e.message : String(e)));
        exitCode = 1;
      }

      if (ctx.captureOut && redirect) {
        const path = resolvePath(redirect, s);
        const content = ctx.out.join("\n");
        try {
          if (redirectMode === ">>") {
            const prior = FS().exists(path) ? FS().readFile(path) : "";
            FS().writeFile(path, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + content);
          } else {
            FS().writeFile(path, content);
          }
        } catch (e) {
          ctx.error("redirect failed: " + (e.message || e));
          exitCode = 1;
        }
      }

      return exitCode === 0;
    }

    /* ------------------------------------------------------------------ */
    /* Snake game                                                         */
    /* ------------------------------------------------------------------ */

    _onKeySnake(e, s) {
      const g = s.snake;
      const k = e.key;
      e.preventDefault();
      if (k === "ArrowLeft" && g.dir.x !== 1)  { g.next = { x: -1, y:  0 }; return; }
      if (k === "ArrowRight"&& g.dir.x !== -1) { g.next = { x:  1, y:  0 }; return; }
      if (k === "ArrowUp"   && g.dir.y !== 1)  { g.next = { x:  0, y: -1 }; return; }
      if (k === "ArrowDown" && g.dir.y !== -1) { g.next = { x:  0, y:  1 }; return; }
      if (k === "Q" || k === "q" || k === "Escape") {
        endSnake(this, s, true);
        return;
      }
    }
  }

  /* ==========================================================================
   * 7. Helpers used by TerminalApp internals
   * ========================================================================*/

  function htmlToText(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
  }

  function longestCommonPrefix(arr) {
    if (!arr.length) return "";
    let p = arr[0];
    for (let i = 1; i < arr.length; i++) {
      let j = 0;
      while (j < p.length && j < arr[i].length && p[j] === arr[i][j]) j++;
      p = p.slice(0, j);
      if (!p) return "";
    }
    return p;
  }

  function expandTildePreservingPrefix(orig, replacement, env) {
    /* When user typed "~/foo", and replacement starts with "fooBar",
       we want to keep the "~" prefix. We detect by checking if orig started
       with "~/" or "~". */
    if (!orig) return replacement;
    if (orig.startsWith("~")) {
      const homePart = (env && env.HOME) || HOME_PATH;
      // Recompose: if orig was "~/sub/par", replacement is just the leaf name
      const lastSlash = orig.lastIndexOf("/");
      if (lastSlash === -1) return "~/" + replacement;
      return orig.slice(0, lastSlash + 1) + replacement;
    }
    // Preserve everything before the last "/" in the original fragment
    const lastSlash = orig.lastIndexOf("/");
    if (lastSlash === -1) return replacement;
    return orig.slice(0, lastSlash + 1) + replacement;
  }

  function splitStatements(line) {
    const out = [];
    let cur = "";
    let inSingle = false, inDouble = false;
    let next = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      if (c === '"' && !inSingle) inDouble = !inDouble;
      if (!inSingle && !inDouble && c === "&" && line[i + 1] === "&") {
        out.push({ cmd: cur.trim(), next: "&&" });
        cur = ""; i++; continue;
      }
      if (!inSingle && !inDouble && c === ";") {
        out.push({ cmd: cur.trim(), next: ";" });
        cur = ""; continue;
      }
      cur += c;
    }
    if (cur.trim()) out.push({ cmd: cur.trim(), next: null });
    return out.filter((s) => s.cmd);
  }

  /* ==========================================================================
   * 8. Command implementations
   *    Each command receives a ctx with:
   *       argv (array of args, no command name),
   *       cwd, env, session, terminal,
   *       print(text, cls), printRaw(html, cls),
   *       error(text), warn(text)
   *    Returns 0 (success) or non-zero. Throwing also counts as failure.
   * ========================================================================*/

  const COMMANDS = {};

  /* -------- ls -------- */
  COMMANDS.ls = function (ctx) {
    const args = parseFlags(ctx.argv, "la");
    const target = args.positional[0] || ctx.cwd;
    const path = resolvePath(target, ctx);
    let entries;
    try { entries = FS().listDir(path, { showHidden: args.flags.a }); }
    catch (e) { ctx.error("ls: " + e.message); return 1; }
    entries.sort((a, b) => {
      // dirs first, then alpha
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (args.flags.l) {
      // Long listing
      const rows = entries.map((en) => {
        const meta = FS().getMetadata(en.path) || {};
        const perm = formatPerms(meta);
        const size = (en.type === "folder") ? "—" : formatSize(meta.size || 0);
        const mtime = formatDateLs(meta.modified || meta.created || Date.now());
        const colorCls = (en.type === "folder") ? "blue" : (meta.executable ? "green" : null);
        const namePart = colorCls ? color(en.name, colorCls, en.type === "folder") : en.name;
        return padR(perm, 11) + " " + pad(size, 8) + " " + padR(mtime, 16) + " " + namePart;
      });
      rows.forEach((r) => ctx.print(r));
      ctx.print(color(entries.length + " item(s)", "bblack"));
      return 0;
    }

    // Short listing — group horizontally
    if (entries.length === 0) {
      ctx.print(color("(empty)", "bblack"));
      return 0;
    }
    const cols = entries.map((en) => {
      const meta = FS().getMetadata(en.path) || {};
      if (en.type === "folder") return color(en.name + "/", "blue", true);
      if (meta.executable) return color(en.name + "*", "green");
      return en.name;
    });
    // Pack into ~80 col wide rows
    const widths = cols.map((c) => stripAnsi(c).length);
    const maxW = Math.max(...widths) + 2;
    const perRow = Math.max(1, Math.floor(80 / maxW));
    let line = "";
    for (let i = 0; i < cols.length; i++) {
      const padding = maxW - widths[i];
      line += cols[i] + repeat(" ", padding);
      if ((i + 1) % perRow === 0) { ctx.print(line); line = ""; }
    }
    if (line) ctx.print(line);
    return 0;
  };

  /* -------- cd -------- */
  COMMANDS.cd = function (ctx) {
    const target = ctx.argv[0];
    let dest;
    if (!target || target === "~") dest = ctx.env.HOME || HOME_PATH;
    else if (target === "-")       dest = ctx.env.OLDPWD || ctx.env.HOME;
    else                           dest = resolvePath(target, ctx);
    if (!FS().exists(dest)) { ctx.error("cd: no such file or directory: " + target); return 1; }
    if (!FS().isFolder(dest)) { ctx.error("cd: not a directory: " + target); return 1; }
    ctx.env.OLDPWD = ctx.cwd;
    ctx.session.cwd = dest;
    ctx.env.PWD = dest;
    ctx.terminal._renderPrompt(ctx.session);
    return 0;
  };

  /* -------- pwd -------- */
  COMMANDS.pwd = function (ctx) {
    ctx.print(ctx.cwd);
    return 0;
  };

  /* -------- mkdir -------- */
  COMMANDS.mkdir = function (ctx) {
    const args = parseFlags(ctx.argv, "p");
    if (args.positional.length === 0) { ctx.error("mkdir: missing operand"); return 1; }
    let code = 0;
    args.positional.forEach((name) => {
      const p = resolvePath(name, ctx);
      try {
        if (args.flags.p) FS().mkdirp(p);
        else              FS().createFolder(p);
      } catch (e) { ctx.error("mkdir: " + e.message); code = 1; }
    });
    return code;
  };

  /* -------- rm -------- */
  COMMANDS.rm = function (ctx) {
    const args = parseFlags(ctx.argv, "rRf");
    if (args.positional.length === 0) { ctx.error("rm: missing operand"); return 1; }
    const recursive = args.flags.r || args.flags.R;
    let code = 0;
    args.positional.forEach((name) => {
      const p = resolvePath(name, ctx);
      try {
        if (!FS().exists(p)) {
          if (!args.flags.f) ctx.error("rm: cannot remove '" + name + "': no such file or directory");
          if (!args.flags.f) code = 1;
          return;
        }
        if (FS().isFolder(p) && !recursive) {
          ctx.error("rm: cannot remove '" + name + "': is a directory (use -r)");
          code = 1; return;
        }
        FS().deleteFile(p, { permanent: true });
      } catch (e) { ctx.error("rm: " + e.message); code = 1; }
    });
    return code;
  };

  /* -------- cp -------- */
  COMMANDS.cp = function (ctx) {
    const a = parseFlags(ctx.argv, "rR");
    if (a.positional.length < 2) { ctx.error("cp: missing operand"); return 1; }
    const src = resolvePath(a.positional[0], ctx);
    const dst = resolvePath(a.positional[1], ctx);
    try { FS().copyFile(src, dst); }
    catch (e) { ctx.error("cp: " + e.message); return 1; }
    return 0;
  };

  /* -------- mv -------- */
  COMMANDS.mv = function (ctx) {
    if (ctx.argv.length < 2) { ctx.error("mv: missing operand"); return 1; }
    const src = resolvePath(ctx.argv[0], ctx);
    const dst = resolvePath(ctx.argv[1], ctx);
    try { FS().moveFile(src, dst); }
    catch (e) { ctx.error("mv: " + e.message); return 1; }
    return 0;
  };

  /* -------- cat -------- */
  COMMANDS.cat = function (ctx) {
    const a = parseFlags(ctx.argv, "n");
    if (a.positional.length === 0) { ctx.error("cat: missing operand"); return 1; }
    let code = 0;
    a.positional.forEach((file) => {
      const p = resolvePath(file, ctx);
      try {
        if (!FS().exists(p)) { ctx.error("cat: " + file + ": No such file or directory"); code = 1; return; }
        if (FS().isFolder(p)) { ctx.error("cat: " + file + ": Is a directory"); code = 1; return; }
        const content = FS().readFile(p);
        const lines = content.split("\n");
        if (a.flags.n) {
          const w = String(lines.length).length;
          lines.forEach((line, i) => ctx.print(color(pad(i + 1, w) + "  ", "bblack") + line));
        } else {
          lines.forEach((line) => ctx.print(line));
        }
      } catch (e) { ctx.error("cat: " + e.message); code = 1; }
    });
    return code;
  };

  /* -------- touch -------- */
  COMMANDS.touch = function (ctx) {
    if (ctx.argv.length === 0) { ctx.error("touch: missing operand"); return 1; }
    let code = 0;
    ctx.argv.forEach((name) => {
      const p = resolvePath(name, ctx);
      try {
        if (FS().exists(p)) { /* update mtime if API supports it; otherwise no-op */ }
        else FS().writeFile(p, "");
      } catch (e) { ctx.error("touch: " + e.message); code = 1; }
    });
    return code;
  };

  /* -------- echo -------- */
  COMMANDS.echo = function (ctx) {
    // Expand $VAR and ${VAR} from env
    const text = ctx.argv.map((a) => expandVars(a, ctx.env)).join(" ");
    ctx.print(text);
    return 0;
  };

  /* -------- find -------- */
  COMMANDS.find = function (ctx) {
    let target = ".", namePat = null;
    for (let i = 0; i < ctx.argv.length; i++) {
      if (ctx.argv[i] === "-name") { namePat = ctx.argv[i + 1]; i++; }
      else if (!ctx.argv[i].startsWith("-")) target = ctx.argv[i];
    }
    const start = resolvePath(target, ctx);
    if (!FS().exists(start)) { ctx.error("find: '" + target + "': No such file or directory"); return 1; }

    const re = namePat ? globToRegex(namePat) : null;
    function walk(p) {
      const meta = FS().getMetadata(p) || {};
      const name = p.split("/").pop() || p;
      if (!namePat || re.test(name)) ctx.print(p);
      if (meta.type === "folder" || FS().isFolder(p)) {
        try {
          const entries = FS().listDir(p, { showHidden: true });
          entries.forEach((en) => walk(en.path));
        } catch (_) {}
      }
    }
    walk(start);
    return 0;
  };

  /* -------- grep -------- */
  COMMANDS.grep = function (ctx) {
    const a = parseFlags(ctx.argv, "ivn");
    if (a.positional.length < 2) { ctx.error("grep: usage: grep [-ivn] PATTERN FILE..."); return 1; }
    const pat = a.positional[0];
    const files = a.positional.slice(1);
    const reFlags = a.flags.i ? "ig" : "g";
    let re;
    try { re = new RegExp(escRegExp(pat), reFlags); }
    catch (e) { ctx.error("grep: bad pattern: " + e.message); return 1; }

    let code = 1;
    files.forEach((f) => {
      const p = resolvePath(f, ctx);
      try {
        if (!FS().exists(p) || !FS().isFile(p)) {
          ctx.error("grep: " + f + ": No such file"); return;
        }
        const content = FS().readFile(p);
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          re.lastIndex = 0;
          const matches = line.match(re);
          if ((!!matches) !== !!a.flags.v) {
            // highlight matches when not inverted
            let display = line;
            if (!a.flags.v) {
              display = line.replace(re, (mm) => ANSI.bold + ANSI.fg.byellow + mm + ANSI.reset);
            }
            const prefix = (a.flags.n ? color(String(i + 1), "bblack") + ":" : "");
            const filePref = (files.length > 1 ? color(f, "magenta") + ":" : "");
            ctx.print(filePref + prefix + display);
            code = 0;
          }
        });
      } catch (e) { ctx.error("grep: " + e.message); }
    });
    return code;
  };

  /* -------- wc -------- */
  COMMANDS.wc = function (ctx) {
    const a = parseFlags(ctx.argv, "lwc");
    if (a.positional.length === 0) { ctx.error("wc: missing operand"); return 1; }
    let totL = 0, totW = 0, totC = 0;
    a.positional.forEach((f) => {
      const p = resolvePath(f, ctx);
      try {
        const text = FS().readFile(p);
        const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        const words = (text.match(/\S+/g) || []).length;
        const chars = text.length;
        totL += lines; totW += words; totC += chars;
        const parts = [];
        if (a.flags.l || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(lines, 7));
        if (a.flags.w || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(words, 7));
        if (a.flags.c || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(chars, 7));
        ctx.print(parts.join("") + " " + f);
      } catch (e) { ctx.error("wc: " + e.message); }
    });
    if (a.positional.length > 1) {
      const parts = [];
      if (a.flags.l || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(totL, 7));
      if (a.flags.w || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(totW, 7));
      if (a.flags.c || (!a.flags.l && !a.flags.w && !a.flags.c)) parts.push(pad(totC, 7));
      ctx.print(parts.join("") + " total");
    }
    return 0;
  };

  /* -------- head -------- */
  COMMANDS.head = function (ctx) {
    let n = 10;
    const positional = [];
    for (let i = 0; i < ctx.argv.length; i++) {
      if (ctx.argv[i] === "-n") { n = parseInt(ctx.argv[i + 1], 10) || 10; i++; }
      else if (ctx.argv[i].startsWith("-")) { n = parseInt(ctx.argv[i].slice(1), 10) || 10; }
      else positional.push(ctx.argv[i]);
    }
    if (positional.length === 0) { ctx.error("head: missing operand"); return 1; }
    positional.forEach((f) => {
      try {
        const p = resolvePath(f, ctx);
        const lines = FS().readFile(p).split("\n").slice(0, n);
        if (positional.length > 1) ctx.print(color("==> " + f + " <==", "magenta"));
        lines.forEach((l) => ctx.print(l));
      } catch (e) { ctx.error("head: " + e.message); }
    });
    return 0;
  };

  /* -------- tail -------- */
  COMMANDS.tail = function (ctx) {
    let n = 10;
    const positional = [];
    for (let i = 0; i < ctx.argv.length; i++) {
      if (ctx.argv[i] === "-n") { n = parseInt(ctx.argv[i + 1], 10) || 10; i++; }
      else if (ctx.argv[i].startsWith("-")) { n = parseInt(ctx.argv[i].slice(1), 10) || 10; }
      else positional.push(ctx.argv[i]);
    }
    if (positional.length === 0) { ctx.error("tail: missing operand"); return 1; }
    positional.forEach((f) => {
      try {
        const p = resolvePath(f, ctx);
        const all = FS().readFile(p).split("\n");
        const lines = all.slice(Math.max(0, all.length - n));
        if (positional.length > 1) ctx.print(color("==> " + f + " <==", "magenta"));
        lines.forEach((l) => ctx.print(l));
      } catch (e) { ctx.error("tail: " + e.message); }
    });
    return 0;
  };

  /* -------- sort -------- */
  COMMANDS.sort = function (ctx) {
    if (ctx.argv.length === 0) { ctx.error("sort: missing operand"); return 1; }
    ctx.argv.forEach((f) => {
      try {
        const p = resolvePath(f, ctx);
        const lines = FS().readFile(p).split("\n");
        lines.sort();
        lines.forEach((l) => ctx.print(l));
      } catch (e) { ctx.error("sort: " + e.message); }
    });
    return 0;
  };

  /* -------- clear / cls -------- */
  COMMANDS.clear = function (ctx) {
    ctx.terminal._clear(ctx.session);
    return 0;
  };
  COMMANDS.cls = COMMANDS.clear;

  /* -------- whoami -------- */
  COMMANDS.whoami = function (ctx) {
    ctx.print(ctx.env.USER || DEFAULT_USER);
    return 0;
  };

  /* -------- date -------- */
  COMMANDS.date = function (ctx) {
    const d = new Date();
    const tz = -d.getTimezoneOffset();
    const sign = tz >= 0 ? "+" : "-";
    const tzStr = sign + pad(Math.floor(Math.abs(tz) / 60), 2, "0") +
                  pad(Math.abs(tz) % 60, 2, "0");
    const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    const mo  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    ctx.print(`${day} ${mo} ${pad(d.getDate(),2,"0")} ${pad(d.getHours(),2,"0")}:${pad(d.getMinutes(),2,"0")}:${pad(d.getSeconds(),2,"0")} UTC${tzStr} ${d.getFullYear()}`);
    return 0;
  };

  /* -------- uptime -------- */
  COMMANDS.uptime = function (ctx) {
    const boot = window.WEBOS_BOOT_TIME || (Date.now() - 1000 * rngInt(120, 7200));
    const elapsed = Math.floor((Date.now() - boot) / 1000);
    const d  = Math.floor(elapsed / 86400);
    const h  = Math.floor((elapsed % 86400) / 3600);
    const m  = Math.floor((elapsed % 3600) / 60);
    const load = [
      (Math.random() * 0.5).toFixed(2),
      (Math.random() * 0.4).toFixed(2),
      (Math.random() * 0.3).toFixed(2),
    ].join(", ");
    let parts = [];
    if (d) parts.push(d + " day" + (d > 1 ? "s" : ""));
    if (h) parts.push(h + ":" + pad(m, 2, "0"));
    else parts.push(m + " min");
    const t = new Date();
    ctx.print(` ${pad(t.getHours(),2,"0")}:${pad(t.getMinutes(),2,"0")}:${pad(t.getSeconds(),2,"0")}  up  ${parts.join(", ")},  1 user,  load average: ${load}`);
    return 0;
  };

  /* -------- history -------- */
  COMMANDS.history = function (ctx) {
    const h = ctx.session.history;
    const w = String(h.length).length;
    h.forEach((line, i) => ctx.print(color(pad(i + 1, w + 2), "bblack") + "  " + line));
    return 0;
  };

  /* -------- env -------- */
  COMMANDS.env = function (ctx) {
    Object.keys(ctx.env).sort().forEach((k) => {
      ctx.print(color(k, "cyan") + "=" + ctx.env[k]);
    });
    return 0;
  };

  /* -------- export -------- */
  COMMANDS.export = function (ctx) {
    if (ctx.argv.length === 0) {
      Object.keys(ctx.env).sort().forEach((k) =>
        ctx.print("declare -x " + k + "=\"" + ctx.env[k] + "\""));
      return 0;
    }
    ctx.argv.forEach((kv) => {
      const m = kv.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) { ctx.error("export: invalid: " + kv); return; }
      ctx.env[m[1]] = expandVars(m[2], ctx.env);
    });
    return 0;
  };

  /* -------- alias -------- */
  COMMANDS.alias = function (ctx) {
    if (ctx.argv.length === 0) {
      Object.keys(ctx.session.aliases).sort().forEach((k) =>
        ctx.print("alias " + k + "='" + ctx.session.aliases[k] + "'"));
      return 0;
    }
    ctx.argv.forEach((kv) => {
      const m = kv.match(/^([A-Za-z_][\w]*)=(.*)$/);
      if (!m) { ctx.error("alias: invalid: " + kv); return; }
      let val = m[2];
      if ((val.startsWith("'") && val.endsWith("'")) ||
          (val.startsWith('"') && val.endsWith('"'))) val = val.slice(1, -1);
      ctx.session.aliases[m[1]] = val;
    });
    return 0;
  };

  /* -------- help -------- */
  COMMANDS.help = function (ctx) {
    const sections = [
      ["Filesystem",
        ["ls [-la] [path]",     "List directory contents"],
        ["cd [path]",            "Change directory"],
        ["pwd",                  "Print working directory"],
        ["mkdir [-p] name",      "Create directory"],
        ["rm [-rf] path",        "Remove file/folder"],
        ["cp src dst",           "Copy file/folder"],
        ["mv src dst",           "Move/rename"],
        ["cat [-n] file",        "Print file contents"],
        ["touch file",           "Create empty file"],
        ["echo [text] [> file]", "Print or write text"],
        ["find [path] -name p",  "Find files by name"],
        ["grep pat file",        "Search inside files"],
        ["wc [-lwc] file",       "Count lines/words/chars"],
        ["head [-n N] file",     "First N lines"],
        ["tail [-n N] file",     "Last N lines"],
        ["sort file",            "Sort lines"],
      ],
      ["System",
        ["clear / cls",          "Clear terminal"],
        ["whoami",               "Current user"],
        ["date",                 "Date and time"],
        ["uptime",               "System uptime"],
        ["history",              "Command history"],
        ["env",                  "Environment vars"],
        ["export K=v",           "Set env var"],
        ["alias n=cmd",          "Create alias"],
      ],
      ["Fun",
        ["neofetch",             "System info banner"],
        ["banner [text]",        "Big ASCII letters"],
        ["cowsay [text]",        "Talking ASCII cow"],
        ["matrix",               "Matrix rain (Ctrl+C)"],
        ["snake",                "Play snake!"],
        ["ping [host]",          "Fake ping"],
        ["curl [url]",           "Fake HTTP fetch"],
        ["cal",                  "Month calendar"],
        ["weather",              "Random weather"],
      ],
    ];
    ctx.print(color("OsTerminal — command reference", "bcyan", true));
    ctx.print(color("─".repeat(40), "bblack"));
    sections.forEach((sec) => {
      ctx.print("");
      ctx.print(color(sec[0], "byellow", true));
      for (let i = 1; i < sec.length; i++) {
        const [c, d] = sec[i];
        ctx.print("  " + color(padR(c, 22), "bgreen") + " " + color(d, "white"));
      }
    });
    ctx.print("");
    ctx.print(color("Use TAB to autocomplete. Up/Down for history. Ctrl+R to search.", "bblack"));
    return 0;
  };

  /* -------- neofetch -------- */
  COMMANDS.neofetch = function (ctx) {
    const art = [
      "    ╔══════════════╗  ",
      "    ║  ██  ██  ██  ║  ",
      "    ║  ██  ██  ██  ║  ",
      "    ║              ║  ",
      "    ║   W e b O S  ║  ",
      "    ║              ║  ",
      "    ║  ▓▓▓▓▓▓▓▓▓▓  ║  ",
      "    ╚══════════════╝  ",
    ];
    const ramTotal = 16384;
    const ramUsed  = rngInt(2400, 6500);
    const cpuLoad  = rngInt(2, 35);
    const fsCount  = countFsFiles();
    const theme    = (window.ThemeEngine && window.ThemeEngine.getTheme && window.ThemeEngine.getTheme()) || "dark";
    const wp       = (window.ThemeEngine && window.ThemeEngine.getWallpaper && window.ThemeEngine.getWallpaper()) || "—";
    const winApps  = (window.WindowManager && window.WindowManager.getApps) ? window.WindowManager.getApps().length : 0;
    const info = [
      ["", color(ctx.env.USER + "@" + ctx.env.HOSTNAME, "byellow", true)],
      ["", color(repeat("─", (ctx.env.USER + "@" + ctx.env.HOSTNAME).length), "bblack")],
      ["OS",         "WebOS 1.0  (Day 5 Build)"],
      ["Kernel",     "WebKernel 5.0"],
      ["Shell",      "WeBash 2.0"],
      ["Resolution", `${window.innerWidth}x${window.innerHeight}`],
      ["Theme",      theme],
      ["Wallpaper",  wp],
      ["Terminal",   "OsTerminal " + ctx.terminal.prefs.scheme],
      ["CPU",        "WebVirtual @ " + cpuLoad + "%"],
      ["RAM",        ramUsed + "MB / " + ramTotal + "MB"],
      ["Uptime",     fmtUptime()],
      ["Files",      fsCount + " in /"],
      ["Apps",       winApps + " registered"],
    ];

    // Render side-by-side
    const lhs = art.map((a) => color(a, "bcyan", true));
    const rows = Math.max(lhs.length, info.length);
    for (let i = 0; i < rows; i++) {
      const left  = lhs[i] || repeat(" ", 22);
      const right = info[i]
        ? (info[i][0] ? color(padR(info[i][0], 11), "bcyan") + ": " : "  ") + info[i][1]
        : "";
      ctx.print(left + " " + right);
    }
    return 0;
  };

  /* -------- banner -------- */
  COMMANDS.banner = function (ctx) {
    const text = (ctx.argv.join(" ") || "WebOS").toUpperCase();
    const lines = bigBanner(text);
    lines.forEach((l) => ctx.print(color(l, "bmagenta", true)));
    return 0;
  };

  /* -------- cowsay -------- */
  COMMANDS.cowsay = function (ctx) {
    const text = ctx.argv.join(" ") || "Moo!";
    const out  = cowsay(text);
    out.forEach((l) => ctx.print(color(l, "bcyan")));
    return 0;
  };

  /* -------- matrix -------- */
  COMMANDS.matrix = function (ctx) {
    return startMatrix(ctx.terminal, ctx.session);
  };

  /* -------- snake -------- */
  COMMANDS.snake = function (ctx) {
    return startSnake(ctx.terminal, ctx.session);
  };

  /* -------- ping -------- */
  COMMANDS.ping = function (ctx) {
    const host = ctx.argv[0] || "webos.local";
    const ip   = `${rngInt(1, 250)}.${rngInt(0, 255)}.${rngInt(0, 255)}.${rngInt(1, 254)}`;
    ctx.print(`PING ${host} (${ip}) 56(84) bytes of data.`);
    let i = 0; let sum = 0; let lost = 0;
    const total = 4;
    const seq = () => {
      if (i >= total) {
        const recv = total - lost;
        const avg  = recv ? (sum / recv).toFixed(2) : "—";
        ctx.print("");
        ctx.print(`--- ${host} ping statistics ---`);
        ctx.print(`${total} packets transmitted, ${recv} received, ${(lost/total*100).toFixed(0)}% packet loss, time ${total*1000}ms`);
        ctx.print(`rtt avg = ${avg} ms`);
        return;
      }
      const t = Math.random() * 50 + 5;
      const dropped = Math.random() < 0.04;
      if (dropped) { lost++; }
      else {
        sum += t;
        ctx.print(`64 bytes from ${host} (${ip}): icmp_seq=${i+1} ttl=${rngInt(40,64)} time=${t.toFixed(2)} ms`);
      }
      i++;
      setTimeout(seq, 380);
    };
    seq();
    return 0;
  };

  /* -------- curl -------- */
  COMMANDS.curl = function (ctx) {
    const url = ctx.argv[0] || "http://example.com";
    const isHttps = url.startsWith("https://");
    const codes = [200, 200, 200, 200, 301, 404, 500, 418];
    const status = codes[rngInt(0, codes.length - 1)];
    ctx.print(`*   Trying ${rngInt(1,250)}.${rngInt(0,255)}.${rngInt(0,255)}.${rngInt(1,254)}:${isHttps ? 443 : 80}...`);
    ctx.print(`* Connected to ${(url.split("/")[2] || url)} port ${isHttps ? 443 : 80} (#0)`);
    if (isHttps) ctx.print(`* TLS 1.3 handshake (TLS_AES_128_GCM_SHA256)`);
    ctx.print(`> GET ${url} HTTP/1.1`);
    ctx.print(`> Host: ${url.split("/")[2] || url}`);
    ctx.print(`> User-Agent: WeBash-Curl/1.0`);
    ctx.print(`> Accept: */*`);
    ctx.print(`> `);
    const statusText = ({200:"OK",301:"Moved Permanently",404:"Not Found",500:"Internal Server Error",418:"I'm a teapot"})[status] || "OK";
    ctx.print(`< HTTP/1.1 ${status} ${statusText}`);
    ctx.print(`< Server: nginx/1.27.1`);
    ctx.print(`< Date: ${new Date().toUTCString()}`);
    ctx.print(`< Content-Type: text/html; charset=UTF-8`);
    ctx.print(`< Content-Length: ${rngInt(120, 5400)}`);
    ctx.print(`< Connection: keep-alive`);
    ctx.print(`< `);
    if (status === 418) {
      ctx.print(color("I'm a little teapot, short and stout.", "byellow"));
    } else if (status >= 400) {
      ctx.print(color(`<h1>${status} ${statusText}</h1>`, "red"));
    } else if (status >= 300) {
      ctx.print(color(`Location: https://example.com/`, "yellow"));
    } else {
      ctx.print(`<!doctype html><html><body><h1>${url}</h1><p>Hello from WebOS curl.</p></body></html>`);
    }
    return 0;
  };

  /* -------- cal -------- */
  COMMANDS.cal = function (ctx) {
    const now = new Date();
    const month = now.getMonth();
    const year  = now.getFullYear();
    const today = now.getDate();

    const monthNames = ["January","February","March","April","May","June",
      "July","August","September","October","November","December"];
    const header = (monthNames[month] + " " + year).padStart(20).padEnd(28);
    ctx.print(color(header, "byellow", true));
    ctx.print(color("Su Mo Tu We Th Fr Sa", "bcyan"));

    const first = new Date(year, month, 1).getDay();
    const days  = new Date(year, month + 1, 0).getDate();
    let row = "";
    for (let i = 0; i < first; i++) row += "   ";
    for (let d = 1; d <= days; d++) {
      const cell = pad(d, 2, " ");
      if (d === today) {
        row += color(cell, "byellow", true) + " ";
      } else {
        row += cell + " ";
      }
      if ((first + d) % 7 === 0) { ctx.print(row); row = ""; }
    }
    if (row) ctx.print(row);
    return 0;
  };

  /* -------- weather -------- */
  COMMANDS.weather = function (ctx) {
    const conditions = [
      { name: "Sunny",  art: weatherSunny(),  fg: "byellow" },
      { name: "Cloudy", art: weatherCloudy(), fg: "white"   },
      { name: "Rainy",  art: weatherRainy(),  fg: "bblue"   },
      { name: "Stormy", art: weatherStormy(), fg: "bmagenta"},
      { name: "Snowy",  art: weatherSnowy(),  fg: "bcyan"   },
    ];
    const c = pickOne(conditions);
    const temp = rngInt(-5, 32);
    const wind = rngInt(2, 20);
    const hum  = rngInt(20, 95);
    const city = pickOne(["WebOS City","Browser Town","Localhost","Frame Forest","Render Ridge"]);

    const info = [
      "",
      color("Weather for " + city, "byellow", true),
      color("─".repeat(28), "bblack"),
      "Condition  : " + color(c.name, c.fg),
      "Temperature: " + temp + "°C",
      "Wind       : " + wind + " km/h",
      "Humidity   : " + hum + "%",
      "Updated    : just now",
    ];
    const arr = c.art;
    const rows = Math.max(arr.length, info.length);
    for (let i = 0; i < rows; i++) {
      const left  = arr[i] ? color(arr[i], c.fg, true) : repeat(" ", 22);
      const right = info[i] || "";
      ctx.print(padR(left, 22) + "  " + right);
    }
    return 0;
  };

  /* ==========================================================================
   * 9. Helpers used by command implementations
   * ========================================================================*/

  function parseFlags(argv, allowed) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
      if (a.startsWith("--")) {
        const m = a.slice(2);
        flags[m] = true;
      } else if (a.startsWith("-") && a.length > 1) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (allowed.indexOf(ch) === -1) {
            // Unknown flag — treat as position
            positional.push(a); break;
          }
          flags[ch] = true;
        }
      } else positional.push(a);
    }
    return { flags, positional };
  }

  function expandVars(text, env) {
    if (!text) return text;
    return text.replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (_, a, b) => {
      const k = a || b;
      return env[k] != null ? env[k] : "";
    });
  }

  function escRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function stripAnsi(s) {
    return String(s).replace(/\u001b\[[0-9;]*m/g, "");
  }

  function formatPerms(meta) {
    const r = (meta && meta.permissions && meta.permissions.r !== false) ? "r" : "-";
    const w = (meta && meta.permissions && meta.permissions.w !== false) ? "w" : "-";
    const x = (meta && (meta.permissions ? meta.permissions.x : false)) ? "x" : "-";
    const t = (meta && meta.type === "folder") ? "d" : "-";
    return t + r + w + x + "r-" + (x === "x" ? "x" : "-") + "r-" + (x === "x" ? "x" : "-");
  }

  function formatSize(b) {
    if (!b && b !== 0) return "—";
    if (b < 1024) return b + "B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "K";
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + "M";
    return (b / 1024 / 1024 / 1024).toFixed(1) + "G";
  }

  function formatDateLs(ts) {
    const d = new Date(ts);
    const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    return m + " " + pad(d.getDate(), 2, " ") + " " + pad(d.getHours(), 2, "0") + ":" + pad(d.getMinutes(), 2, "0");
  }

  function fmtUptime() {
    const boot = window.WEBOS_BOOT_TIME || (Date.now() - 1000 * rngInt(120, 7200));
    const elapsed = Math.floor((Date.now() - boot) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    return (h ? h + "h " : "") + m + "m " + s + "s";
  }

  function countFsFiles() {
    try {
      const tree = FS().tree("/");
      let count = 0;
      function walk(n) {
        if (!n) return;
        if (n.type === "file") count++;
        if (n.children) Object.values(n.children).forEach(walk);
      }
      walk(tree);
      return count;
    } catch (_) { return 0; }
  }

  /* ==========================================================================
   * 10. Big ASCII banner generator
   * ========================================================================*/

  const FONT_5x5 = (function () {
    /* 5-row ASCII font for A-Z 0-9 and a few punctuations.
       Each character is 5 rows of fixed width chars. */
    const F = {};
    F["A"]=["  █  "," █ █ "," ███ "," █ █ "," █ █ "];
    F["B"]=[" ██  "," █ █ "," ██  "," █ █ "," ██  "];
    F["C"]=["  ██ "," █   "," █   "," █   ","  ██ "];
    F["D"]=[" ██  "," █ █ "," █ █ "," █ █ "," ██  "];
    F["E"]=[" ███ "," █   "," ██  "," █   "," ███ "];
    F["F"]=[" ███ "," █   "," ██  "," █   "," █   "];
    F["G"]=["  ██ "," █   "," █ █ "," █ █ ","  ██ "];
    F["H"]=[" █ █ "," █ █ "," ███ "," █ █ "," █ █ "];
    F["I"]=[" ███ ","  █  ","  █  ","  █  "," ███ "];
    F["J"]=["   █ ","   █ ","   █ "," █ █ ","  █  "];
    F["K"]=[" █ █ "," ██  "," █   "," ██  "," █ █ "];
    F["L"]=[" █   "," █   "," █   "," █   "," ███ "];
    F["M"]=[" █ █ "," ███ "," ███ "," █ █ "," █ █ "];
    F["N"]=[" █ █ "," ██  "," █ █ "," █ █ "," █ █ "];
    F["O"]=["  █  "," █ █ "," █ █ "," █ █ ","  █  "];
    F["P"]=[" ██  "," █ █ "," ██  "," █   "," █   "];
    F["Q"]=["  █  "," █ █ "," █ █ "," ██  ","  ██ "];
    F["R"]=[" ██  "," █ █ "," ██  "," █ █ "," █ █ "];
    F["S"]=["  ██ "," █   ","  █  ","   █ "," ██  "];
    F["T"]=[" ███ ","  █  ","  █  ","  █  ","  █  "];
    F["U"]=[" █ █ "," █ █ "," █ █ "," █ █ ","  █  "];
    F["V"]=[" █ █ "," █ █ "," █ █ "," █ █ ","  █  "];
    F["W"]=[" █ █ "," █ █ "," ███ "," ███ "," █ █ "];
    F["X"]=[" █ █ "," █ █ ","  █  "," █ █ "," █ █ "];
    F["Y"]=[" █ █ "," █ █ ","  █  ","  █  ","  █  "];
    F["Z"]=[" ███ ","   █ ","  █  "," █   "," ███ "];
    F["0"]=["  █  "," █ █ "," █ █ "," █ █ ","  █  "];
    F["1"]=["  █  "," ██  ","  █  ","  █  "," ███ "];
    F["2"]=[" ██  ","   █ ","  █  "," █   "," ███ "];
    F["3"]=[" ██  ","   █ ","  █  ","   █ "," ██  "];
    F["4"]=[" █ █ "," █ █ "," ███ ","   █ ","   █ "];
    F["5"]=[" ███ "," █   "," ██  ","   █ "," ██  "];
    F["6"]=["  ██ "," █   "," ██  "," █ █ ","  █  "];
    F["7"]=[" ███ ","   █ ","  █  ","  █  ","  █  "];
    F["8"]=["  █  "," █ █ ","  █  "," █ █ ","  █  "];
    F["9"]=["  █  "," █ █ ","  ██ ","   █ "," ██  "];
    F[" "]=["     ","     ","     ","     ","     "];
    F["!"]=["  █  ","  █  ","  █  ","     ","  █  "];
    F["?"]=[" ██  ","   █ ","  █  ","     ","  █  "];
    F["."]=["     ","     ","     ","     ","  █  "];
    F[","]=["     ","     ","     ","  █  "," █   "];
    F["-"]=["     ","     "," ███ ","     ","     "];
    F["_"]=["     ","     ","     ","     "," ███ "];
    F["+"]=["     ","  █  "," ███ ","  █  ","     "];
    F["="]=["     "," ███ ","     "," ███ ","     "];
    F["/"]=["   █ ","   █ ","  █  "," █   "," █   "];
    F[":"]=["     ","  █  ","     ","  █  ","     "];
    return F;
  })();

  function bigBanner(text) {
    const rows = ["", "", "", "", ""];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i].toUpperCase();
      const glyph = FONT_5x5[ch] || FONT_5x5["?"];
      for (let r = 0; r < 5; r++) rows[r] += glyph[r] + " ";
    }
    return rows;
  }

  /* ==========================================================================
   * 11. Cowsay
   * ========================================================================*/

  function cowsay(text) {
    const words = text.split(/\s+/);
    const wrapped = [];
    let line = "";
    const max = 38;
    words.forEach((w) => {
      if ((line + " " + w).trim().length > max) {
        wrapped.push(line.trim());
        line = w;
      } else {
        line += " " + w;
      }
    });
    if (line.trim()) wrapped.push(line.trim());

    const width = Math.max(...wrapped.map((l) => l.length));
    const top   = " " + "_".repeat(width + 2);
    const bot   = " " + "-".repeat(width + 2);
    const lines = [];
    lines.push(top);
    if (wrapped.length === 1) {
      lines.push("< " + padR(wrapped[0], width) + " >");
    } else {
      wrapped.forEach((w, i) => {
        const left  = (i === 0) ? "/" : (i === wrapped.length - 1 ? "\\" : "|");
        const right = (i === 0) ? "\\" : (i === wrapped.length - 1 ? "/" : "|");
        lines.push(left + " " + padR(w, width) + " " + right);
      });
    }
    lines.push(bot);
    lines.push("        \\   ^__^");
    lines.push("         \\  (oo)\\_______");
    lines.push("            (__)\\       )\\/\\");
    lines.push("                ||----w |");
    lines.push("                ||     ||");
    return lines;
  }

  /* ==========================================================================
   * 12. Matrix rain
   * ========================================================================*/

  function startMatrix(term, session) {
    if (session.matrix) return 0;

    const COLS  = 60;
    const ROWS  = 20;
    const chars = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEF<>?@#$%^&*()";

    const div = document.createElement("div");
    div.className = "osterm-line osterm-matrix-host";
    div.style.fontFamily = "JetBrains Mono, monospace";
    div.style.lineHeight = "1.0";
    div.style.color = "var(--ot-ansi-green)";
    div.style.whiteSpace = "pre";
    session.outputEl.appendChild(div);
    session.buffer.push(div);

    const drops = new Array(COLS).fill(0).map(() => Math.floor(Math.random() * ROWS));
    const matrix = { active: true, raf: null, startedAt: Date.now() };
    session.matrix = matrix;

    function frame() {
      if (!matrix.active) return;
      // Build grid
      const grid = [];
      for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(" "));
      for (let c = 0; c < COLS; c++) {
        const head = drops[c];
        for (let i = 0; i < 8; i++) {
          const r = head - i;
          if (r < 0 || r >= ROWS) continue;
          const ch = chars[Math.floor(Math.random() * chars.length)];
          if (i === 0)      grid[r][c] = "<span class='bright'>" + escapeHtml(ch) + "</span>";
          else if (i < 4)   grid[r][c] = escapeHtml(ch);
          else              grid[r][c] = "<span class='dim'>" + escapeHtml(ch) + "</span>";
        }
        drops[c] = (drops[c] + 1) % (ROWS + Math.floor(Math.random() * 6));
      }
      let html = "";
      for (let r = 0; r < ROWS; r++) html += "<div class='osterm-matrix-line'>" + grid[r].join("") + "</div>";
      div.innerHTML = html;

      term._scrollToBottom(session);

      // Stop after 5 seconds or if interrupted
      if (Date.now() - matrix.startedAt > 5000) {
        matrix.active = false;
        return;
      }
      matrix.raf = requestAnimationFrame(frame);
    }

    session.interruptCb = function () {
      matrix.active = false;
      session.interruptCb = null;
      session.matrix = null;
    };
    matrix.raf = requestAnimationFrame(frame);
    return 0;
  }

  /* ==========================================================================
   * 13. Snake game
   * ========================================================================*/

  function startSnake(term, session) {
    if (session.snake) return 0;

    const COLS = 36;
    const ROWS = 16;
    const host = document.createElement("div");
    host.className = "osterm-line osterm-snake-host";
    host.style.fontFamily = "JetBrains Mono, monospace";
    host.style.lineHeight = "1.0";
    host.style.whiteSpace = "pre";
    session.outputEl.appendChild(host);
    session.buffer.push(host);

    const snake = {
      active: true,
      raf: null,
      lastTick: 0,
      tickMs: 130,
      body: [{ x: 5, y: 8 }, { x: 4, y: 8 }, { x: 3, y: 8 }],
      dir:  { x: 1, y: 0 },
      next: { x: 1, y: 0 },
      food: { x: 18, y: 8 },
      score: 0,
      gameOver: false,
    };
    session.snake = snake;
    term.snakeHud.hidden = false;
    term.snakeScoreEl.textContent = "0";

    function placeFood() {
      while (true) {
        const x = rngInt(1, COLS - 2);
        const y = rngInt(1, ROWS - 2);
        if (snake.body.some((p) => p.x === x && p.y === y)) continue;
        snake.food = { x, y };
        return;
      }
    }

    function render() {
      const grid = [];
      for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(" "));
      for (let c = 0; c < COLS; c++) { grid[0][c] = "═"; grid[ROWS - 1][c] = "═"; }
      for (let r = 0; r < ROWS; r++) { grid[r][0] = "║"; grid[r][COLS - 1] = "║"; }
      grid[0][0] = "╔"; grid[0][COLS-1] = "╗";
      grid[ROWS-1][0] = "╚"; grid[ROWS-1][COLS-1] = "╝";

      grid[snake.food.y][snake.food.x] = "<span class='ansi-fg-bred'>●</span>";
      snake.body.forEach((seg, i) => {
        const ch = (i === 0) ? "<span class='ansi-fg-bgreen ansi-bold'>◉</span>"
                            : "<span class='ansi-fg-bgreen'>●</span>";
        grid[seg.y][seg.x] = ch;
      });

      let html = "";
      for (let r = 0; r < ROWS; r++) html += grid[r].join("") + "\n";
      html += "Score: " + color(String(snake.score), "byellow", true) +
              "    " + color("(arrow keys, Q to quit)", "bblack");
      if (snake.gameOver) html += "\n" + color("GAME OVER — Final score: " + snake.score, "bred", true);
      host.innerHTML = html;
      term.snakeScoreEl.textContent = String(snake.score);
      term._scrollToBottom(session);
    }

    function tick(ts) {
      if (!snake.active) return;
      if (!snake.lastTick) snake.lastTick = ts;
      if (ts - snake.lastTick >= snake.tickMs) {
        snake.lastTick = ts;
        snake.dir = snake.next;
        const head = snake.body[0];
        const nh = { x: head.x + snake.dir.x, y: head.y + snake.dir.y };
        // Wall collision
        if (nh.x <= 0 || nh.x >= COLS - 1 || nh.y <= 0 || nh.y >= ROWS - 1) {
          snake.gameOver = true; snake.active = false;
          render();
          endSnake(term, session, false);
          return;
        }
        // Self-collision
        if (snake.body.some((p) => p.x === nh.x && p.y === nh.y)) {
          snake.gameOver = true; snake.active = false;
          render();
          endSnake(term, session, false);
          return;
        }
        snake.body.unshift(nh);
        if (nh.x === snake.food.x && nh.y === snake.food.y) {
          snake.score += 10;
          snake.tickMs = Math.max(60, snake.tickMs - 4);
          placeFood();
        } else {
          snake.body.pop();
        }
        render();
      }
      snake.raf = requestAnimationFrame(tick);
    }

    render();
    snake.raf = requestAnimationFrame(tick);

    session.interruptCb = function () { endSnake(term, session, true); };
    return 0;
  }

  function endSnake(term, session, byCtrlC) {
    if (!session.snake) return;
    cancelAnimationFrame(session.snake.raf || 0);
    session.snake.active = false;
    if (byCtrlC) {
      session.snake = null;
    } else {
      // leave final game-over render but mark as inactive
      session.snake = null;
    }
    term.snakeHud.hidden = true;
    session.interruptCb = null;
  }

  /* ==========================================================================
   * 14. Weather ASCII
   * ========================================================================*/

  function weatherSunny() {
    return [
      "    \\   /    ",
      "     .-.     ",
      "  ‒ (   ) ‒  ",
      "     `-’     ",
      "    /   \\    ",
    ];
  }
  function weatherCloudy() {
    return [
      "             ",
      "    .--.     ",
      " .-(    ).   ",
      "(___.__)__)  ",
      "             ",
    ];
  }
  function weatherRainy() {
    return [
      "             ",
      "    .--.     ",
      " .-(    ).   ",
      "(___.__)__)  ",
      "  ‚‘‚‘‚‘‚‘   ",
    ];
  }
  function weatherStormy() {
    return [
      "             ",
      "    .--.     ",
      " .-(    ).   ",
      "(___.__)__)  ",
      "  ⚡‚‘⚡‚‘     ",
    ];
  }
  function weatherSnowy() {
    return [
      "             ",
      "    .--.     ",
      " .-(    ).   ",
      "(___.__)__)  ",
      "  *  *  *    ",
    ];
  }

  /* ==========================================================================
   * 15. Window-Manager registration
   * ========================================================================*/

  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id:       APP_ID,
      title:    APP_TITLE,
      icon:     APP_ICON,
      width:    820,
      height:   520,
      minWidth: 480,
      minHeight: 280,
      category: "Developer",
      pinned:   true,

      // Enable file-open: terminal can "open" a script file by cd'ing to its dir
      // and printing its contents. Used by File Manager double-click.
      canOpen(path) {
        if (!path) return false;
        return /\.(sh|bash|zsh)$/i.test(path);
      },

      render(body, win) {
        const t = new TerminalApp(body, win);
        win._terminal = t;
        t.mount().then(() => {
          if (win.opts && win.opts.openPath) {
            const s = t._active();
            if (s) {
              try {
                const dir = path_dirname(win.opts.openPath);
                if (FS().exists(dir)) {
                  s.cwd = dir;
                  s.env.PWD = dir;
                  t._renderPrompt(s);
                }
                t._executeStmt(s, "cat " + JSON.stringify(win.opts.openPath));
              } catch (_) {}
            }
          }
        });
      },

      onClose(win) {
        if (win._terminal) win._terminal.destroy();
      },
    });

    console.log("%c[WebOS]%c OsTerminal registered",
      "color:#06b6d4;font-weight:bold", "color:inherit");
  }

  function path_dirname(p) {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* ==========================================================================
   * 16. Public API on window.OsTerminal
   * ========================================================================*/

  window.OsTerminal = {
    /** Open a new terminal window (or focus existing). */
    open(opts) {
      return window.WindowManager.openApp(APP_ID, opts || {});
    },

    /** Programmatically run a command in the active tab of the focused window. */
    run(cmd) {
      const win = window.WindowManager && window.WindowManager.getFocused
        ? window.WindowManager.getFocused() : null;
      if (!win || !win._terminal) return false;
      const t = win._terminal;
      const s = t._active();
      if (!s) return false;
      t._submit(s, cmd);
      return true;
    },

    /** Returns a snapshot of registered commands (for help / docs). */
    listCommands() { return Object.keys(COMMANDS).sort(); },

    /** Convert ANSI to HTML — useful for other apps wanting same look. */
    ansiToHtml,

    /** Static color helper (returns ANSI-coded string). */
    color,

    /** Constants (read-only) */
    APP_ID, SCHEMES, FONT_SIZES,
  };

  /* ==========================================================================
   * 17. Final ground-truth: track WEBOS_BOOT_TIME if not yet set
   * ========================================================================*/
  if (typeof window.WEBOS_BOOT_TIME !== "number") {
    window.WEBOS_BOOT_TIME = Date.now();
  }

})();
