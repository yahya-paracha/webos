/* ============================================================================
 * NoteForge — WebOS Text Editor
 * ============================================================================
 * Multi-tab, multi-language, keyboard-driven source editor. Self-contained:
 *   - Tokenizer (JS, Python, HTML, CSS, JSON, Markdown) — hand-rolled, no libs
 *   - Tab bar with unsaved indicator, middle-click close, close-warning dialog
 *   - Find / Replace (case, word, regex options)
 *   - Line numbers, current-line highlight, bracket matching, auto-close
 *   - Auto-indent / Tab / Shift+Tab
 *   - Undo / Redo (100 steps), Select All, Zoom, Word-wrap
 *   - FileSystem integration (open picker, save, save-as)
 *   - Shortcuts help panel
 *
 * Registers itself as app id "textEditor" via WindowManager.registerApp.
 * File Manager & Context Menus will route text-like files here because this
 * registration exposes a `canOpen(metadata)` function.
 * ========================================================================= */
(function () {
  "use strict";

  /* -------------------------------------------------------------------------
   * 0.  CONSTANTS
   * ---------------------------------------------------------------------- */
  const APP_ID       = "textEditor";
  const APP_TITLE    = "NoteForge";
  const APP_ICON     = "📝";
  const APP_CATEGORY = "Productivity";

  const DEFAULT_FONT_PX = 14;
  const MIN_FONT_PX     = 8;
  const MAX_FONT_PX     = 32;
  const LINE_HEIGHT     = 18;
  const UNDO_STACK_LIMIT = 100;

  // File extensions we officially understand (and claim in canOpen).
  const TEXT_EXTENSIONS = [
    "txt","log","md","markdown","js","mjs","cjs","jsx","ts","tsx",
    "py","pyw","html","htm","xml","svg","css","scss","less",
    "json","jsonc","yaml","yml","toml","ini","cfg","conf","env",
    "sh","bash","zsh","bat","cmd","ps1","rb","go","rs","java",
    "c","h","cpp","hpp","cc","cs","php","kt","swift","lua","sql",
    "csv","tsv","gitignore","dockerfile","makefile","editorconfig"
  ];

  // Human-friendly language map for the status bar.
  const LANG_DISPLAY = {
    js: "JavaScript", py: "Python", html: "HTML", css: "CSS",
    json: "JSON", md: "Markdown", text: "Plain Text",
  };

  // Default keymap (action_id -> key combo, key combo -> action_id).
  const KEYMAP = [
    ["new",                "Ctrl+N",       "File",   "New file"],
    ["open",               "Ctrl+O",       "File",   "Open file"],
    ["save",               "Ctrl+S",       "File",   "Save"],
    ["saveAs",             "Ctrl+Shift+S", "File",   "Save as"],
    ["closeTab",           "Ctrl+W",       "File",   "Close tab"],
    ["nextTab",            "Ctrl+Tab",     "File",   "Next tab"],
    ["prevTab",            "Ctrl+Shift+Tab","File",  "Previous tab"],
    ["undo",               "Ctrl+Z",       "Edit",   "Undo"],
    ["redo",               "Ctrl+Y",       "Edit",   "Redo"],
    ["redoAlt",            "Ctrl+Shift+Z", "Edit",   "Redo (alt)"],
    ["selectAll",          "Ctrl+A",       "Edit",   "Select all"],
    ["cut",                "Ctrl+X",       "Edit",   "Cut"],
    ["copy",               "Ctrl+C",       "Edit",   "Copy"],
    ["paste",              "Ctrl+V",       "Edit",   "Paste"],
    ["find",               "Ctrl+F",       "Edit",   "Find"],
    ["replace",            "Ctrl+H",       "Edit",   "Replace"],
    ["findNext",           "F3",           "Edit",   "Find next"],
    ["findPrev",           "Shift+F3",     "Edit",   "Find previous"],
    ["goto",               "Ctrl+G",       "Edit",   "Go to line"],
    ["duplicateLine",      "Ctrl+D",       "Edit",   "Duplicate line"],
    ["deleteLine",         "Ctrl+Shift+K", "Edit",   "Delete line"],
    ["moveLineUp",         "Alt+Up",       "Edit",   "Move line up"],
    ["moveLineDown",       "Alt+Down",     "Edit",   "Move line down"],
    ["indent",             "Tab",          "Edit",   "Indent"],
    ["dedent",             "Shift+Tab",    "Edit",   "Dedent"],
    ["toggleComment",      "Ctrl+/",       "Edit",   "Toggle line comment"],
    ["zoomIn",             "Ctrl+=",       "View",   "Zoom in"],
    ["zoomOut",            "Ctrl+-",       "View",   "Zoom out"],
    ["zoomReset",          "Ctrl+0",       "View",   "Reset zoom"],
    ["toggleWrap",         "Ctrl+Alt+W",   "View",   "Toggle word wrap"],
    ["toggleMinimap",      "Ctrl+Alt+M",   "View",   "Toggle minimap"],
    ["showShortcuts",      "Ctrl+/",       "Help",   "Keyboard shortcuts"],
    ["run",                "Ctrl+R",       "Run",    "Run script"],
  ];

  const MENU_DEFS = {
    file: [
      { id: "new",     label: "New",           kbd: "Ctrl+N" },
      { id: "open",    label: "Open…",         kbd: "Ctrl+O" },
      { type: "sep" },
      { id: "save",    label: "Save",          kbd: "Ctrl+S" },
      { id: "saveAs",  label: "Save As…",      kbd: "Ctrl+Shift+S" },
      { type: "sep" },
      { id: "closeTab", label: "Close Tab",    kbd: "Ctrl+W" },
    ],
    edit: [
      { id: "undo",       label: "Undo",            kbd: "Ctrl+Z" },
      { id: "redo",       label: "Redo",            kbd: "Ctrl+Y" },
      { type: "sep" },
      { id: "cut",        label: "Cut",             kbd: "Ctrl+X" },
      { id: "copy",       label: "Copy",            kbd: "Ctrl+C" },
      { id: "paste",      label: "Paste",           kbd: "Ctrl+V" },
      { id: "selectAll",  label: "Select All",      kbd: "Ctrl+A" },
      { type: "sep" },
      { id: "find",       label: "Find",            kbd: "Ctrl+F" },
      { id: "replace",    label: "Replace",         kbd: "Ctrl+H" },
      { id: "goto",       label: "Go to Line…",     kbd: "Ctrl+G" },
      { type: "sep" },
      { id: "duplicateLine", label: "Duplicate Line", kbd: "Ctrl+D" },
      { id: "deleteLine",    label: "Delete Line",    kbd: "Ctrl+Shift+K" },
      { id: "toggleComment", label: "Toggle Comment", kbd: "Ctrl+/" },
    ],
    view: [
      { id: "zoomIn",       label: "Zoom In",          kbd: "Ctrl+=" },
      { id: "zoomOut",      label: "Zoom Out",         kbd: "Ctrl+-" },
      { id: "zoomReset",    label: "Reset Zoom",       kbd: "Ctrl+0" },
      { type: "sep" },
      { id: "toggleWrap",    label: "Word Wrap",        kbd: "Ctrl+Alt+W", check: "wrap" },
      { id: "toggleMinimap", label: "Minimap",          kbd: "Ctrl+Alt+M", check: "minimap" },
      { id: "toggleGutter",  label: "Line Numbers",     check: "gutter" },
      { id: "toggleLineHL",  label: "Highlight Current Line", check: "lineHL" },
    ],
    format: [
      { id: "setLangJs",       label: "JavaScript",    lang: "js" },
      { id: "setLangPy",       label: "Python",        lang: "py" },
      { id: "setLangHtml",     label: "HTML",          lang: "html" },
      { id: "setLangCss",      label: "CSS",           lang: "css" },
      { id: "setLangJson",     label: "JSON",          lang: "json" },
      { id: "setLangMd",       label: "Markdown",      lang: "md" },
      { id: "setLangText",     label: "Plain Text",    lang: "text" },
      { type: "sep" },
      { id: "setEolLF",        label: "EOL: LF",       eol: "\n" },
      { id: "setEolCRLF",      label: "EOL: CRLF",     eol: "\r\n" },
      { type: "sep" },
      { id: "indent2",  label: "Indent: 2 spaces", indent: 2 },
      { id: "indent4",  label: "Indent: 4 spaces", indent: 4 },
      { id: "indentTab",label: "Indent: Tab",      indent: "tab" },
    ],
    run: [
      { id: "run",              label: "Run Script",   kbd: "Ctrl+R" },
      { id: "runClear",         label: "Clear Output" },
    ],
  };

  /* -------------------------------------------------------------------------
   * 1.  UTIL
   * ---------------------------------------------------------------------- */
  function $ (root, sel) { return root.querySelector(sel); }
  function $$(root, sel) { return Array.from(root.querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getExt(path) {
    if (!path) return "";
    const name = path.split("/").pop() || "";
    const i = name.lastIndexOf(".");
    if (i <= 0) return name.toLowerCase();       // e.g. .bashrc, dockerfile
    return name.slice(i + 1).toLowerCase();
  }

  function basename(path) {
    if (!path) return "Untitled";
    const parts = path.replace(/\/+$/,"").split("/");
    return parts[parts.length - 1] || "/";
  }

  function dirname(path) {
    if (!path) return "/";
    const parts = path.replace(/\/+$/,"").split("/");
    parts.pop();
    const out = parts.join("/");
    return out || "/";
  }

  function detectLang(ext) {
    switch (ext) {
      case "js": case "mjs": case "cjs": case "jsx": case "ts": case "tsx":
        return "js";
      case "py": case "pyw":
        return "py";
      case "html": case "htm": case "xml": case "svg":
        return "html";
      case "css": case "scss": case "less":
        return "css";
      case "json": case "jsonc":
        return "json";
      case "md": case "markdown":
        return "md";
      default:
        return "text";
    }
  }

  /* -------------------------------------------------------------------------
   * 2.  TOKENIZER
   *     Input: full text + language id.
   *     Output: array of { start, end, type } non-overlapping spans in order.
   *     Designed to be fast (single pass), tolerant of malformed input,
   *     and never throw.
   * ---------------------------------------------------------------------- */
  const JS_KEYWORDS = new Set([
    "var","let","const","function","return","if","else","for","while","do",
    "switch","case","break","continue","default","new","delete","typeof",
    "instanceof","in","of","try","catch","finally","throw","class","extends",
    "super","this","null","undefined","true","false","void","yield","async",
    "await","static","import","export","from","as","get","set","public",
    "private","protected","readonly","interface","enum","implements",
    "package","debugger","with"
  ]);
  const PY_KEYWORDS = new Set([
    "False","None","True","and","as","assert","async","await","break","class",
    "continue","def","del","elif","else","except","finally","for","from",
    "global","if","import","in","is","lambda","nonlocal","not","or","pass",
    "raise","return","try","while","with","yield","match","case","self","cls"
  ]);

  const JS_IDENT_RE = /[A-Za-z_$][\w$]*/y;
  const PY_IDENT_RE = /[A-Za-z_][\w]*/y;
  const NUM_RE      = /(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)n?/y;

  function tokenizeJS(text) {
    const tokens = [];
    const len = text.length;
    let i = 0;
    let lastNonSpaceType = null; // to disambiguate regex vs divide

    while (i < len) {
      const c = text[i];
      const c2 = text[i+1];

      // line comment
      if (c === "/" && c2 === "/") {
        let j = i;
        while (j < len && text[j] !== "\n") j++;
        tokens.push({ start: i, end: j, type: "cmt" });
        i = j;
        continue;
      }
      // block comment
      if (c === "/" && c2 === "*") {
        let j = i + 2;
        while (j < len && !(text[j] === "*" && text[j+1] === "/")) j++;
        j = Math.min(len, j + 2);
        tokens.push({ start: i, end: j, type: "cmt" });
        i = j;
        continue;
      }
      // string literals
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        let j = i + 1;
        while (j < len) {
          const ch = text[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === quote) { j++; break; }
          if (quote !== "`" && ch === "\n") break; // unterminated
          j++;
        }
        tokens.push({ start: i, end: j, type: "str" });
        i = j;
        continue;
      }
      // regex literal (rough heuristic)
      if (c === "/" &&
          (lastNonSpaceType === null ||
           lastNonSpaceType === "op" ||
           lastNonSpaceType === "punct" ||
           lastNonSpaceType === "kw")) {
        let j = i + 1;
        let inClass = false;
        let terminated = false;
        while (j < len) {
          const ch = text[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === "[")  { inClass = true; j++; continue; }
          if (ch === "]" && inClass) { inClass = false; j++; continue; }
          if (ch === "/" && !inClass) { j++; terminated = true; break; }
          if (ch === "\n") break;
          j++;
        }
        if (terminated) {
          while (j < len && /[gimsuy]/.test(text[j])) j++;
          tokens.push({ start: i, end: j, type: "regex" });
          i = j;
          lastNonSpaceType = "regex";
          continue;
        }
      }
      // number
      NUM_RE.lastIndex = i;
      const numM = NUM_RE.exec(text);
      if (numM && numM.index === i) {
        const end = i + numM[0].length;
        tokens.push({ start: i, end, type: "num" });
        i = end;
        lastNonSpaceType = "num";
        continue;
      }
      // identifier / keyword
      JS_IDENT_RE.lastIndex = i;
      const idM = JS_IDENT_RE.exec(text);
      if (idM && idM.index === i) {
        const word = idM[0];
        const end = i + word.length;
        let type = "var";
        if (JS_KEYWORDS.has(word)) type = "kw";
        else if (word === "true" || word === "false") type = "bool";
        else if (word === "null" || word === "undefined") type = "null";
        else {
          // if followed by `(` -> function call
          let k = end;
          while (k < len && (text[k] === " " || text[k] === "\t")) k++;
          if (text[k] === "(") type = "fn";
        }
        tokens.push({ start: i, end, type });
        i = end;
        lastNonSpaceType = type;
        continue;
      }
      // whitespace
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      // operators
      if ("+-*/%=<>!&|^~?:".indexOf(c) !== -1) {
        let j = i + 1;
        while (j < len && "+-*/%=<>!&|^~?:".indexOf(text[j]) !== -1) j++;
        tokens.push({ start: i, end: j, type: "op" });
        i = j;
        lastNonSpaceType = "op";
        continue;
      }
      // punctuation
      if ("(){}[];,.".indexOf(c) !== -1) {
        tokens.push({ start: i, end: i + 1, type: "punct" });
        i++;
        lastNonSpaceType = "punct";
        continue;
      }
      // fallback
      i++;
    }
    return tokens;
  }

  function tokenizePython(text) {
    const tokens = [];
    const len = text.length;
    let i = 0;

    while (i < len) {
      const c = text[i];

      // line comment
      if (c === "#") {
        let j = i;
        while (j < len && text[j] !== "\n") j++;
        tokens.push({ start: i, end: j, type: "cmt" });
        i = j;
        continue;
      }
      // triple-quoted strings
      if ((c === '"' || c === "'") && text[i+1] === c && text[i+2] === c) {
        const q = c + c + c;
        let j = i + 3;
        while (j < len - 2) {
          if (text[j] === c && text[j+1] === c && text[j+2] === c) { j += 3; break; }
          j++;
        }
        if (j > len) j = len;
        tokens.push({ start: i, end: j, type: "str" });
        i = j;
        continue;
      }
      // single/double strings (with optional prefix r/b/f)
      let prefix = 0;
      if (/[rRbBfFuU]/.test(c) && (text[i+1] === '"' || text[i+1] === "'")) prefix = 1;
      else if (/[rRbBfFuU]/.test(c) && /[rRbBfFuU]/.test(text[i+1]) &&
               (text[i+2] === '"' || text[i+2] === "'")) prefix = 2;
      if (prefix) {
        const qStart = i + prefix;
        const quote = text[qStart];
        let j = qStart + 1;
        while (j < len) {
          const ch = text[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === quote) { j++; break; }
          if (ch === "\n") break;
          j++;
        }
        tokens.push({ start: i, end: j, type: "str" });
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        while (j < len) {
          const ch = text[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === quote) { j++; break; }
          if (ch === "\n") break;
          j++;
        }
        tokens.push({ start: i, end: j, type: "str" });
        i = j;
        continue;
      }
      // number
      NUM_RE.lastIndex = i;
      const numM = NUM_RE.exec(text);
      if (numM && numM.index === i) {
        const end = i + numM[0].length;
        tokens.push({ start: i, end, type: "num" });
        i = end;
        continue;
      }
      // identifier / keyword
      PY_IDENT_RE.lastIndex = i;
      const idM = PY_IDENT_RE.exec(text);
      if (idM && idM.index === i) {
        const word = idM[0];
        const end = i + word.length;
        let type = "var";
        if (PY_KEYWORDS.has(word)) {
          if (word === "True" || word === "False") type = "bool";
          else if (word === "None") type = "null";
          else type = "kw";
        } else {
          let k = end;
          while (k < len && (text[k] === " " || text[k] === "\t")) k++;
          if (text[k] === "(") type = "fn";
        }
        tokens.push({ start: i, end, type });
        i = end;
        continue;
      }
      // whitespace
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
        continue;
      }
      // operators
      if ("+-*/%=<>!&|^~@".indexOf(c) !== -1) {
        let j = i + 1;
        while (j < len && "+-*/%=<>!&|^~@".indexOf(text[j]) !== -1) j++;
        tokens.push({ start: i, end: j, type: "op" });
        i = j;
        continue;
      }
      if ("(){}[];,.:".indexOf(c) !== -1) {
        tokens.push({ start: i, end: i + 1, type: "punct" });
        i++;
        continue;
      }
      i++;
    }
    return tokens;
  }

  function tokenizeHTML(text) {
    const tokens = [];
    const len = text.length;
    let i = 0;
    while (i < len) {
      // comment
      if (text.substr(i, 4) === "<!--") {
        let j = text.indexOf("-->", i + 4);
        if (j === -1) j = len; else j += 3;
        tokens.push({ start: i, end: j, type: "cmt" });
        i = j;
        continue;
      }
      // tag
      if (text[i] === "<") {
        const end = text.indexOf(">", i);
        const tagEnd = end === -1 ? len : end + 1;
        // within a tag, sub-tokenize attr/value
        let j = i + 1;
        // tag name
        if (text[j] === "/") j++;
        const nameStart = j;
        while (j < tagEnd - 1 && /[A-Za-z0-9\-_:]/.test(text[j])) j++;
        tokens.push({ start: i, end: j, type: "tag" });
        // attrs
        while (j < tagEnd - 1) {
          // skip spaces
          while (j < tagEnd - 1 && /\s/.test(text[j])) j++;
          if (j >= tagEnd - 1) break;
          // attr name
          const aStart = j;
          while (j < tagEnd - 1 && /[A-Za-z0-9\-_:]/.test(text[j])) j++;
          if (j > aStart) tokens.push({ start: aStart, end: j, type: "attr" });
          // equals
          if (text[j] === "=") {
            tokens.push({ start: j, end: j + 1, type: "op" });
            j++;
            // value
            if (text[j] === '"' || text[j] === "'") {
              const quote = text[j];
              const vs = j;
              j++;
              while (j < tagEnd - 1 && text[j] !== quote) j++;
              if (text[j] === quote) j++;
              tokens.push({ start: vs, end: j, type: "str" });
            } else {
              const vs = j;
              while (j < tagEnd - 1 && /\S/.test(text[j]) && text[j] !== ">") j++;
              if (j > vs) tokens.push({ start: vs, end: j, type: "str" });
            }
          } else {
            j++;
          }
        }
        tokens.push({ start: Math.max(i, j), end: tagEnd, type: "punct" });
        i = tagEnd;
        continue;
      }
      i++;
    }
    return tokens;
  }

  function tokenizeCSS(text) {
    const tokens = [];
    const len = text.length;
    let i = 0;
    let inRule = 0;

    while (i < len) {
      const c = text[i];

      // comment
      if (c === "/" && text[i+1] === "*") {
        let j = text.indexOf("*/", i + 2);
        if (j === -1) j = len; else j += 2;
        tokens.push({ start: i, end: j, type: "cmt" });
        i = j;
        continue;
      }
      // string
      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1;
        while (j < len && text[j] !== quote) {
          if (text[j] === "\\") j += 2; else j++;
        }
        if (text[j] === quote) j++;
        tokens.push({ start: i, end: j, type: "str" });
        i = j;
        continue;
      }
      // number with possible unit
      if (/[\d.]/.test(c)) {
        let j = i;
        while (j < len && /[\d.]/.test(text[j])) j++;
        while (j < len && /[a-zA-Z%]/.test(text[j])) j++;
        tokens.push({ start: i, end: j, type: "num" });
        i = j;
        continue;
      }
      // hex color
      if (c === "#") {
        let j = i + 1;
        while (j < len && /[0-9a-fA-F]/.test(text[j])) j++;
        if (j > i + 1) {
          tokens.push({ start: i, end: j, type: "num" });
          i = j;
          continue;
        }
      }
      // braces
      if (c === "{") { tokens.push({ start: i, end: i+1, type: "punct" }); inRule++; i++; continue; }
      if (c === "}") { tokens.push({ start: i, end: i+1, type: "punct" }); inRule = Math.max(0, inRule-1); i++; continue; }
      if (c === ";" || c === ",") { tokens.push({ start: i, end: i+1, type: "punct" }); i++; continue; }
      if (c === ":") { tokens.push({ start: i, end: i+1, type: "op" }); i++; continue; }

      // identifier / selector / property
      if (/[A-Za-z_\-@.&*\[#]/.test(c)) {
        let j = i;
        while (j < len && /[A-Za-z0-9_\-@.&*#:>+~\[\]=\"'(), ]/.test(text[j]) &&
               text[j] !== "{" && text[j] !== ";" && text[j] !== ":" &&
               !(text[j] === " " && inRule > 0)) {
          if (text[j] === " " && inRule === 0) { j++; continue; }
          j++;
        }
        if (j === i) j++;
        let word = text.slice(i, j).trim();
        let type = inRule ? "prop" : "sel";
        // detect @rule at any position
        if (word.startsWith("@")) type = "kw";
        tokens.push({ start: i, end: j, type });
        i = j;
        continue;
      }
      i++;
    }
    return tokens;
  }

  function tokenizeJSON(text) {
    const tokens = [];
    const len = text.length;
    let i = 0;
    let expectKey = false;

    while (i < len) {
      const c = text[i];
      if (c === "{" || c === "[") {
        tokens.push({ start: i, end: i+1, type: "punct" });
        if (c === "{") expectKey = true;
        i++;
        continue;
      }
      if (c === "}" || c === "]" || c === "," || c === ":") {
        tokens.push({ start: i, end: i+1, type: c === ":" ? "op" : "punct" });
        if (c === ",") expectKey = true; // next may be key (if in object)
        if (c === ":") expectKey = false;
        i++;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < len && text[j] !== '"') {
          if (text[j] === "\\") j += 2; else j++;
        }
        if (text[j] === '"') j++;
        tokens.push({ start: i, end: j, type: expectKey ? "key" : "str" });
        i = j;
        if (expectKey) expectKey = false;
        continue;
      }
      if (/[-\d]/.test(c)) {
        let j = i;
        if (text[j] === "-") j++;
        while (j < len && /[\d.eE+-]/.test(text[j])) j++;
        tokens.push({ start: i, end: j, type: "num" });
        i = j;
        continue;
      }
      if (text.substr(i, 4) === "true" || text.substr(i, 5) === "false") {
        const len2 = text[i] === "t" ? 4 : 5;
        tokens.push({ start: i, end: i + len2, type: "bool" });
        i += len2;
        continue;
      }
      if (text.substr(i, 4) === "null") {
        tokens.push({ start: i, end: i + 4, type: "null" });
        i += 4;
        continue;
      }
      i++;
    }
    return tokens;
  }

  function tokenizeMarkdown(text) {
    const tokens = [];
    const len = text.length;
    const lines = text.split("\n");
    let offset = 0;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineStart = offset;
      offset += line.length + 1;

      // heading
      const hm = /^(\s*)(#{1,6})(\s.*)?$/.exec(line);
      if (hm) {
        tokens.push({ start: lineStart, end: lineStart + line.length, type: "md-h" });
        continue;
      }
      // list item
      const lm = /^(\s*)([-*+]|\d+\.)\s/.exec(line);
      if (lm) {
        tokens.push({ start: lineStart + lm[1].length, end: lineStart + lm[1].length + lm[2].length, type: "md-list" });
      }
      // fenced code
      if (/^\s*```/.test(line)) {
        tokens.push({ start: lineStart, end: lineStart + line.length, type: "md-code" });
        continue;
      }

      // inline: code
      let m;
      const codeRe = /`[^`\n]+`/g;
      while ((m = codeRe.exec(line)) !== null) {
        tokens.push({ start: lineStart + m.index, end: lineStart + m.index + m[0].length, type: "md-code" });
      }
      // bold
      const boldRe = /\*\*[^*\n]+\*\*|__[^_\n]+__/g;
      while ((m = boldRe.exec(line)) !== null) {
        tokens.push({ start: lineStart + m.index, end: lineStart + m.index + m[0].length, type: "md-b" });
      }
      // italic
      const itRe = /(^|[^*_])(\*[^*\n]+\*|_[^_\n]+_)/g;
      while ((m = itRe.exec(line)) !== null) {
        const sOff = m[1].length;
        tokens.push({ start: lineStart + m.index + sOff, end: lineStart + m.index + sOff + m[2].length, type: "md-i" });
      }
      // link
      const linkRe = /\[[^\]\n]+\]\([^)\n]+\)/g;
      while ((m = linkRe.exec(line)) !== null) {
        tokens.push({ start: lineStart + m.index, end: lineStart + m.index + m[0].length, type: "md-link" });
      }
    }
    // sort and dedupe overlapping
    tokens.sort((a, b) => a.start - b.start);
    const out = [];
    let lastEnd = -1;
    for (const t of tokens) {
      if (t.start >= lastEnd) {
        out.push(t);
        lastEnd = t.end;
      }
    }
    return out;
  }

  function tokenize(text, lang) {
    try {
      switch (lang) {
        case "js":   return tokenizeJS(text);
        case "py":   return tokenizePython(text);
        case "html": return tokenizeHTML(text);
        case "css":  return tokenizeCSS(text);
        case "json": return tokenizeJSON(text);
        case "md":   return tokenizeMarkdown(text);
        default:     return [];
      }
    } catch (e) {
      console.warn("[NoteForge] tokenize error:", e);
      return [];
    }
  }

  /** Convert tokens + text into HTML (for the highlight layer) */
  function renderHighlightHTML(text, tokens) {
    if (!tokens || !tokens.length) {
      return escapeHtml(text) + "\n";
    }
    let out = "";
    let cur = 0;
    for (const t of tokens) {
      if (t.start > cur) out += escapeHtml(text.slice(cur, t.start));
      const span = text.slice(t.start, t.end);
      out += `<span class="tok-${t.type}">${escapeHtml(span)}</span>`;
      cur = t.end;
    }
    if (cur < text.length) out += escapeHtml(text.slice(cur));
    // trailing newline ensures the <pre> block has the same height as textarea
    if (!out.endsWith("\n")) out += "\n";
    return out;
  }

  /* -------------------------------------------------------------------------
   * 3.  UNDO / REDO STACK
   * ---------------------------------------------------------------------- */
  class UndoStack {
    constructor(limit) {
      this.limit = limit || UNDO_STACK_LIMIT;
      this.past = [];
      this.future = [];
    }
    push(snapshot) {
      // `snapshot`: { text, selStart, selEnd }
      this.past.push(snapshot);
      if (this.past.length > this.limit) this.past.shift();
      this.future.length = 0;
    }
    canUndo() { return this.past.length > 1; } // keep 1 baseline
    canRedo() { return this.future.length > 0; }
    undo(currentSnapshot) {
      if (!this.canUndo()) return null;
      const last = this.past.pop();
      this.future.push(currentSnapshot);
      if (this.future.length > this.limit) this.future.shift();
      return this.past[this.past.length - 1];
    }
    redo(currentSnapshot) {
      if (!this.canRedo()) return null;
      const next = this.future.pop();
      this.past.push(currentSnapshot);
      if (this.past.length > this.limit) this.past.shift();
      return next;
    }
    clear() { this.past.length = 0; this.future.length = 0; }
  }

  /* -------------------------------------------------------------------------
   * 4.  EDITOR INSTANCE CLASS
   *     One instance per window. Manages all tabs, DOM, state.
   * ---------------------------------------------------------------------- */
  class NoteForge {
    constructor(body, winOpts) {
      this.body = body;
      this.winOpts = winOpts || {};
      this.root = null;
      this.tabs = [];                       // Tab[]
      this.activeTabIdx = -1;
      this.keyHandler = null;
      this.destroyed = false;

      // Editor-wide preferences
      this.fontPx = DEFAULT_FONT_PX;
      this.wrap = false;
      this.minimapOn = false;
      this.gutterOn = true;
      this.lineHLOn = true;
      this.indentWidth = 2;
      this.indentUseTab = false;
      this.autoCloseBrackets = true;

      // Dropdown menu state
      this.openMenuId = null;
    }

    /* --------------------------------------------------------------
     * MOUNT / UNMOUNT
     * ----------------------------------------------------------- */
    mount() {
      this.body.innerHTML = HTML_TEMPLATE;
      this.root = $(this.body, "[data-ne-root]");
      this._bindChrome();
      this._bindFindBar();
      this._bindModal();
      this._bindGlobalKeys();
      this._renderShortcuts();

      // Open initial document
      const open = this.winOpts.openPath;
      if (open) this.openFromPath(open);
      else this.newTab();

      this._layoutTick();
      window.addEventListener("resize", this._resizeHandler = () => this._layoutTick());
    }

    destroy() {
      this.destroyed = true;
      if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler, true);
      if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
      // release tabs
      this.tabs.length = 0;
    }

    /* --------------------------------------------------------------
     * TABS
     * ----------------------------------------------------------- */
    newTab(initial) {
      const tab = {
        id: "tab-" + Math.random().toString(36).slice(2, 9),
        title: (initial && initial.title) || "Untitled",
        path: (initial && initial.path) || null,
        text: (initial && initial.text) || "",
        lang: (initial && initial.lang) || "text",
        eol:  (initial && initial.eol)  || "\n",
        dirty: false,
        selStart: 0,
        selEnd: 0,
        scrollTop: 0,
        scrollLeft: 0,
        undo: new UndoStack(UNDO_STACK_LIMIT),
      };
      tab.undo.push({ text: tab.text, selStart: 0, selEnd: 0 });
      this.tabs.push(tab);
      this.activeTabIdx = this.tabs.length - 1;
      this._renderTabBar();
      this._loadActiveTabIntoDOM();
      return tab;
    }

    closeTab(idx, force) {
      if (idx < 0 || idx >= this.tabs.length) return;
      const t = this.tabs[idx];
      if (t.dirty && !force) {
        const ok = confirm(`'${t.title}' has unsaved changes. Close anyway?`);
        if (!ok) return;
      }
      this.tabs.splice(idx, 1);
      if (this.tabs.length === 0) {
        this.newTab();
        return;
      }
      if (this.activeTabIdx >= this.tabs.length) this.activeTabIdx = this.tabs.length - 1;
      else if (this.activeTabIdx > idx) this.activeTabIdx -= 1;
      this._renderTabBar();
      this._loadActiveTabIntoDOM();
    }

    switchTab(idx) {
      if (idx === this.activeTabIdx) return;
      if (idx < 0 || idx >= this.tabs.length) return;
      this._saveActiveTabDOMState();
      this.activeTabIdx = idx;
      this._renderTabBar();
      this._loadActiveTabIntoDOM();
    }

    activeTab() {
      return this.tabs[this.activeTabIdx] || null;
    }

    nextTab() {
      if (this.tabs.length < 2) return;
      this.switchTab((this.activeTabIdx + 1) % this.tabs.length);
    }
    prevTab() {
      if (this.tabs.length < 2) return;
      this.switchTab((this.activeTabIdx - 1 + this.tabs.length) % this.tabs.length);
    }

    _renderTabBar() {
      const bar = $(this.root, "[data-ne-tabbar]");
      if (!bar) return;
      // Remove existing tabs (keep `+` button)
      const plus = bar.querySelector(".ne-tab-new");
      bar.innerHTML = "";
      this.tabs.forEach((t, idx) => {
        const el = document.createElement("div");
        el.className = "ne-tab" + (idx === this.activeTabIdx ? " is-active" : "");
        el.dataset.tabIdx = idx;
        el.title = t.path || t.title;
        el.innerHTML = `
          ${t.dirty ? '<span class="ne-tab-dirty" title="Unsaved"></span>' : ""}
          <span class="ne-tab-icon">${escapeHtml(iconForLang(t.lang))}</span>
          <span class="ne-tab-title">${escapeHtml(t.title)}</span>
          <span class="ne-tab-close" data-close="${idx}" title="Close (Ctrl+W)">✕</span>
        `;
        el.addEventListener("click", (ev) => {
          if (ev.target.matches("[data-close]")) return;
          this.switchTab(idx);
        });
        el.addEventListener("mousedown", (ev) => {
          if (ev.button === 1) {
            ev.preventDefault();
            this.closeTab(idx);
          }
        });
        const closeBtn = el.querySelector("[data-close]");
        if (closeBtn) closeBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.closeTab(idx);
        });
        bar.appendChild(el);
      });
      bar.appendChild(plus);
    }

    _saveActiveTabDOMState() {
      const t = this.activeTab();
      if (!t) return;
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      t.text       = ta.value;
      t.selStart   = ta.selectionStart;
      t.selEnd     = ta.selectionEnd;
      t.scrollTop  = ta.scrollTop;
      t.scrollLeft = ta.scrollLeft;
    }

    _loadActiveTabIntoDOM() {
      const t = this.activeTab();
      const ta = $(this.root, "[data-ne-textarea]");
      if (!t || !ta) return;
      ta.value = t.text;
      ta.selectionStart = t.selStart;
      ta.selectionEnd   = t.selEnd;
      ta.scrollTop  = t.scrollTop;
      ta.scrollLeft = t.scrollLeft;
      this._updateHighlight();
      this._updateGutter();
      this._updateStatusBar();
      this._updateLineHighlight();
      this._updateMinimap();
      setTimeout(() => ta.focus(), 0);
    }

    /* --------------------------------------------------------------
     * CHROME WIRE-UP (menus, buttons)
     * ----------------------------------------------------------- */
    _bindChrome() {
      const self = this;

      // ---- Menu dropdowns ----
      $$(this.root, ".ne-menu-item").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const id = btn.dataset.menu;
          if (self.openMenuId === id) self._closeMenu();
          else self._openMenu(id, btn);
        });
        btn.addEventListener("mouseenter", () => {
          if (self.openMenuId && self.openMenuId !== btn.dataset.menu) {
            self._openMenu(btn.dataset.menu, btn);
          }
        });
      });
      document.addEventListener("mousedown", (ev) => {
        if (!self.root) return;
        const dd = $(self.root, "[data-ne-dropdown]");
        if (self.openMenuId && !dd.contains(ev.target) && !ev.target.matches(".ne-menu-item")) {
          self._closeMenu();
        }
      }, true);

      // ---- Toolbar action buttons ----
      $$(this.root, "[data-act]").forEach((b) => {
        b.addEventListener("click", (ev) => {
          const a = b.dataset.act;
          self._runAction(a);
        });
      });

      // ---- New-tab (+) in tab bar ----
      $(this.root, ".ne-tab-new").addEventListener("click", () => self.newTab());

      // ---- Main textarea bindings ----
      const ta = $(this.root, "[data-ne-textarea]");
      const onInput = () => {
        const t = self.activeTab();
        if (!t) return;
        const prevText = t.text;
        t.text = ta.value;
        t.selStart = ta.selectionStart;
        t.selEnd   = ta.selectionEnd;
        if (prevText !== t.text) {
          t.dirty = true;
          t.undo.push({ text: t.text, selStart: t.selStart, selEnd: t.selEnd });
        }
        self._renderTabBar();
        self._updateHighlight();
        self._updateGutter();
        self._updateStatusBar();
        self._updateLineHighlight();
        self._updateMinimap();
      };
      ta.addEventListener("input", onInput);
      ta.addEventListener("scroll", () => {
        self._syncScroll();
        self._updateGutter();
        self._updateLineHighlight();
        self._updateMinimap();
      });
      ta.addEventListener("click", () => {
        self._updateStatusBar();
        self._updateLineHighlight();
        self._updateBracketMatch();
      });
      ta.addEventListener("keyup", (ev) => {
        if (ev.key.startsWith("Arrow") || ev.key === "Home" || ev.key === "End" || ev.key === "PageUp" || ev.key === "PageDown") {
          self._updateStatusBar();
          self._updateLineHighlight();
          self._updateBracketMatch();
        }
      });

      // ---- Textarea keydown — interception for indent / auto-close / etc ----
      ta.addEventListener("keydown", (ev) => self._onEditorKeyDown(ev));

      // ---- Resize via theme change → re-highlight ----
      window.addEventListener("webos:theme-changed", () => self._updateHighlight());
    }

    _openMenu(id, anchorBtn) {
      const dd = $(this.root, "[data-ne-dropdown]");
      if (!dd) return;
      const defs = MENU_DEFS[id];
      if (!defs) return;
      $$(this.root, ".ne-menu-item").forEach((b) =>
        b.classList.toggle("is-active", b.dataset.menu === id));

      // Render items
      dd.innerHTML = "";
      defs.forEach((it) => {
        if (it.type === "sep") {
          const s = document.createElement("div");
          s.className = "ne-dd-sep";
          dd.appendChild(s);
          return;
        }
        const row = document.createElement("div");
        row.className = "ne-dd-item";
        let check = "";
        if (it.check && this._checkStateFor(it.check)) check = "✓";
        row.innerHTML = `
          <span class="ne-dd-check">${check}</span>
          <span class="ne-dd-label">${escapeHtml(it.label)}</span>
          ${it.kbd ? `<span class="ne-dd-kbd">${escapeHtml(it.kbd)}</span>` : ""}
        `;
        row.addEventListener("click", () => {
          this._runAction(it.id, it);
          this._closeMenu();
        });
        dd.appendChild(row);
      });

      // Position under anchor
      const r = anchorBtn.getBoundingClientRect();
      const rootR = this.root.getBoundingClientRect();
      dd.style.left = (r.left - rootR.left) + "px";
      dd.style.top  = (r.bottom - rootR.top) + "px";
      dd.hidden = false;
      this.openMenuId = id;
    }

    _closeMenu() {
      const dd = $(this.root, "[data-ne-dropdown]");
      if (dd) dd.hidden = true;
      $$(this.root, ".ne-menu-item").forEach((b) => b.classList.remove("is-active"));
      this.openMenuId = null;
    }

    _checkStateFor(key) {
      switch (key) {
        case "wrap":    return this.wrap;
        case "minimap": return this.minimapOn;
        case "gutter":  return this.gutterOn;
        case "lineHL":  return this.lineHLOn;
        default: return false;
      }
    }

    /* --------------------------------------------------------------
     * GLOBAL KEYBOARD HANDLING (editor-scope only)
     * ----------------------------------------------------------- */
    _bindGlobalKeys() {
      const self = this;
      this.keyHandler = (ev) => {
        // Only intercept if our window contains focus, or a child of ours.
        if (self.destroyed || !self.root || !self.root.isConnected) return;
        if (!self.root.contains(document.activeElement)) return;

        const combo = this._comboFromEvent(ev);
        if (!combo) return;

        // Match against KEYMAP
        for (const [aId, k] of KEYMAP) {
          if (k === combo) {
            // find has special shortcut overlap: Ctrl+/ is both toggleComment AND showShortcuts.
            // resolve based on context: if editor focused, toggleComment wins; else shortcuts.
            if (combo === "Ctrl+/" && aId === "showShortcuts") {
              const ta = $(self.root, "[data-ne-textarea]");
              if (ta && document.activeElement === ta) continue;
            }
            ev.preventDefault();
            ev.stopPropagation();
            self._runAction(aId);
            return;
          }
        }
      };
      document.addEventListener("keydown", this.keyHandler, true);
    }

    _comboFromEvent(ev) {
      const parts = [];
      if (ev.ctrlKey || ev.metaKey) parts.push("Ctrl");
      if (ev.altKey) parts.push("Alt");
      if (ev.shiftKey) parts.push("Shift");
      let k = ev.key;
      if (k === "Escape") k = "Esc";
      // Key normalization
      if (k === " ") k = "Space";
      if (k.length === 1) k = k.toUpperCase();
      if (["Control","Shift","Alt","Meta"].indexOf(k) !== -1) return null;
      parts.push(k);
      return parts.join("+");
    }

    /* --------------------------------------------------------------
     * ACTIONS DISPATCH
     * ----------------------------------------------------------- */
    _runAction(id, def) {
      switch (id) {
        case "new":            return this.newTab();
        case "open":           return this._showOpenDialog();
        case "save":           return this.save();
        case "saveAs":         return this.saveAs();
        case "closeTab":       return this.closeTab(this.activeTabIdx);
        case "nextTab":        return this.nextTab();
        case "prevTab":        return this.prevTab();
        case "undo":           return this._undo();
        case "redo": case "redoAlt": return this._redo();
        case "selectAll":      return this._doSelectAll();
        case "cut":            return this._doCut();
        case "copy":           return this._doCopy();
        case "paste":          return this._doPaste();
        case "find":           return this._showFindBar(false);
        case "replace":        return this._showFindBar(true);
        case "findNext":       return this._findNext();
        case "findPrev":       return this._findPrev();
        case "goto":           return this._showGoto();
        case "duplicateLine":  return this._duplicateLine();
        case "deleteLine":     return this._deleteLine();
        case "moveLineUp":     return this._moveLine(-1);
        case "moveLineDown":   return this._moveLine(1);
        case "toggleComment":  return this._toggleComment();
        case "zoomIn":         return this._setZoom(this.fontPx + 1);
        case "zoomOut":        return this._setZoom(this.fontPx - 1);
        case "zoomReset":      return this._setZoom(DEFAULT_FONT_PX);
        case "toggleWrap":     return this._toggleWrap();
        case "toggleMinimap":  return this._toggleMinimap();
        case "toggleGutter":   return this._toggleGutter();
        case "toggleLineHL":   return this._toggleLineHL();
        case "showShortcuts":  return this._toggleShortcuts(true);
        case "help":           return this._toggleShortcuts(true);
        case "indent":         return this._indentSelection(false);
        case "dedent":         return this._indentSelection(true);
        case "run":            return this._runCurrentScript();
        case "runClear":       return this._clearRunOutput();
      }
      if (def && def.lang !== undefined)    return this._setLang(def.lang);
      if (def && def.eol !== undefined)     return this._setEol(def.eol);
      if (def && def.indent !== undefined)  return this._setIndent(def.indent);
    }

    /* --------------------------------------------------------------
     * EDITOR KEY HANDLING (indent / auto-close / enter indent)
     * ----------------------------------------------------------- */
    _onEditorKeyDown(ev) {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const t = this.activeTab();
      if (!t) return;

      // Tab / Shift+Tab
      if (ev.key === "Tab") {
        ev.preventDefault();
        this._indentSelection(ev.shiftKey);
        return;
      }

      // Enter — auto indent
      if (ev.key === "Enter") {
        ev.preventDefault();
        this._handleEnter();
        return;
      }

      // Backspace — smart dedent of leading-only whitespace
      if (ev.key === "Backspace") {
        if (this._handleBackspace()) ev.preventDefault();
        return;
      }

      // Auto-close brackets / quotes
      if (this.autoCloseBrackets && ev.key.length === 1) {
        const pairMap = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
        if (pairMap[ev.key]) {
          if (this._handleAutoClose(ev.key, pairMap[ev.key])) ev.preventDefault();
          return;
        }
        // Skip over closing if user typed the same closing char adjacent
        if (")]}".indexOf(ev.key) !== -1) {
          if (this._handleSkipClose(ev.key)) ev.preventDefault();
          return;
        }
      }

      // Alt+Up / Alt+Down move line
      if (ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
        if (ev.key === "ArrowUp")   { ev.preventDefault(); this._moveLine(-1); return; }
        if (ev.key === "ArrowDown") { ev.preventDefault(); this._moveLine(1);  return; }
      }
    }

    _indentSelection(dedent) {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return;
      const indentStr = this.indentUseTab ? "\t" : " ".repeat(this.indentWidth);
      let start = ta.selectionStart;
      let end   = ta.selectionEnd;
      const text = ta.value;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = (end === start)
        ? end
        : (text[end - 1] === "\n" ? end - 1 : end);
      const spans = text.slice(lineStart, lineEnd).split("\n");
      if (start === end && !dedent) {
        // simple insert
        const insertAt = start;
        const newText = text.slice(0, insertAt) + indentStr + text.slice(insertAt);
        this._replaceAll(newText, insertAt + indentStr.length, insertAt + indentStr.length);
        return;
      }
      if (start === end && dedent) {
        // remove up to `indentWidth` leading chars on this line
        const before = text.slice(lineStart, start);
        let cut = 0;
        if (before.startsWith("\t")) cut = 1;
        else for (let i = 0; i < this.indentWidth && before[i] === " "; i++) cut++;
        if (!cut) return;
        const newText = text.slice(0, lineStart) + text.slice(lineStart + cut);
        this._replaceAll(newText, Math.max(lineStart, start - cut), Math.max(lineStart, end - cut));
        return;
      }
      // selection across multiple lines
      const processed = spans.map((l) => {
        if (dedent) {
          if (l.startsWith("\t")) return l.slice(1);
          let n = 0;
          while (n < this.indentWidth && l[n] === " ") n++;
          return l.slice(n);
        }
        return indentStr + l;
      });
      const delta = processed.reduce((acc, p, i) => acc + (p.length - spans[i].length), 0);
      const newBlock = processed.join("\n");
      const before = text.slice(0, lineStart);
      const after  = text.slice(lineStart + spans.join("\n").length);
      const newText = before + newBlock + after;
      const firstLineAdj = dedent
        ? -Math.min(start - lineStart, (spans[0].startsWith("\t") ? 1 : Math.min(this.indentWidth, (spans[0].match(/^ */) || [""])[0].length)))
        : indentStr.length;
      this._replaceAll(newText, Math.max(lineStart, start + firstLineAdj), end + delta);
    }

    _handleEnter() {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const text = ta.value;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const curLine = text.slice(lineStart, start);
      const indent = (curLine.match(/^[ \t]*/) || [""])[0];

      // Extra indent after `{`, `[`, `(`, `:` at end of line (python)
      const trimmed = curLine.trimEnd();
      const extra = /[\{\[\(:]$/.test(trimmed) ? (this.indentUseTab ? "\t" : " ".repeat(this.indentWidth)) : "";
      const insertion = "\n" + indent + extra;

      let newText = text.slice(0, start) + insertion + text.slice(end);
      // If we're inserting between {} [] (), push closing to next line with base indent
      const charAfter = text[end];
      const charBefore = text[start - 1];
      if (extra && ((charBefore === "{" && charAfter === "}") ||
                    (charBefore === "[" && charAfter === "]") ||
                    (charBefore === "(" && charAfter === ")"))) {
        const extra2 = "\n" + indent;
        const ip = start + insertion.length;
        newText = newText.slice(0, ip) + extra2 + newText.slice(ip);
      }
      this._replaceAll(newText, start + insertion.length, start + insertion.length);
    }

    _handleBackspace() {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return false;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      if (start !== end) return false;
      const text = ta.value;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const before = text.slice(lineStart, start);
      if (before.length === 0 || /\S/.test(before)) return false;
      // all whitespace — dedent by indentWidth or 1 tab
      let cut = 0;
      if (before.endsWith("\t")) cut = 1;
      else {
        const mod = before.length % this.indentWidth;
        cut = mod === 0 ? this.indentWidth : mod;
      }
      cut = Math.min(cut, before.length);
      const newText = text.slice(0, start - cut) + text.slice(start);
      this._replaceAll(newText, start - cut, start - cut);
      return true;
    }

    _handleAutoClose(open, close) {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return false;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const text = ta.value;
      if (start !== end) {
        // Wrap selection
        const wrapped = open + text.slice(start, end) + close;
        const newText = text.slice(0, start) + wrapped + text.slice(end);
        this._replaceAll(newText, start + 1, end + 1);
        return true;
      }
      // don't auto-close if next char is alnum
      const next = text[start] || "";
      if (/[\w]/.test(next) && (open === '"' || open === "'" || open === "`")) return false;
      const newText = text.slice(0, start) + open + close + text.slice(start);
      this._replaceAll(newText, start + 1, start + 1);
      return true;
    }

    _handleSkipClose(close) {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return false;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      if (start !== end) return false;
      const text = ta.value;
      if (text[start] === close) {
        this._replaceAll(text, start + 1, start + 1);
        return true;
      }
      return false;
    }

    /* --------------------------------------------------------------
     * REPLACE VALUE HELPER
     *    Sets textarea value preserving undo history correctly.
     * ----------------------------------------------------------- */
    _replaceAll(newValue, selStart, selEnd) {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return;
      ta.value = newValue;
      ta.selectionStart = selStart;
      ta.selectionEnd   = selEnd;
      const prev = t.text;
      t.text = newValue;
      t.selStart = selStart;
      t.selEnd   = selEnd;
      if (prev !== newValue) {
        t.dirty = true;
        t.undo.push({ text: newValue, selStart, selEnd });
      }
      this._renderTabBar();
      this._updateHighlight();
      this._updateGutter();
      this._updateStatusBar();
      this._updateLineHighlight();
      this._updateMinimap();
    }

    _undo() {
      const t = this.activeTab();
      if (!t) return;
      const ta = $(this.root, "[data-ne-textarea]");
      const cur = { text: t.text, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
      const prev = t.undo.undo(cur);
      if (!prev) return;
      ta.value = prev.text;
      ta.selectionStart = prev.selStart;
      ta.selectionEnd   = prev.selEnd;
      t.text = prev.text;
      t.selStart = prev.selStart;
      t.selEnd   = prev.selEnd;
      this._renderTabBar();
      this._updateHighlight();
      this._updateGutter();
      this._updateStatusBar();
      this._updateLineHighlight();
    }

    _redo() {
      const t = this.activeTab();
      if (!t) return;
      const ta = $(this.root, "[data-ne-textarea]");
      const cur = { text: t.text, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
      const nxt = t.undo.redo(cur);
      if (!nxt) return;
      ta.value = nxt.text;
      ta.selectionStart = nxt.selStart;
      ta.selectionEnd   = nxt.selEnd;
      t.text = nxt.text;
      t.selStart = nxt.selStart;
      t.selEnd   = nxt.selEnd;
      this._renderTabBar();
      this._updateHighlight();
      this._updateGutter();
      this._updateStatusBar();
      this._updateLineHighlight();
    }

    _doSelectAll() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      ta.focus();
      ta.select();
    }
    _doCut() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (!text) return;
      try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (_) {}
      const start = ta.selectionStart;
      const newText = ta.value.slice(0, start) + ta.value.slice(ta.selectionEnd);
      this._replaceAll(newText, start, start);
    }
    _doCopy() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (!text) return;
      try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (_) {}
    }
    async _doPaste() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      let text = "";
      try { text = await navigator.clipboard.readText(); } catch (_) { return; }
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const newText = ta.value.slice(0, start) + text + ta.value.slice(end);
      this._replaceAll(newText, start + text.length, start + text.length);
    }

    _duplicateLine() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const ls = text.lastIndexOf("\n", start - 1) + 1;
      let le = text.indexOf("\n", end);
      if (le === -1) le = text.length;
      const block = text.slice(ls, le);
      const newText = text.slice(0, le) + "\n" + block + text.slice(le);
      this._replaceAll(newText, start + block.length + 1, end + block.length + 1);
    }

    _deleteLine() {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const ls = text.lastIndexOf("\n", start - 1) + 1;
      let le = text.indexOf("\n", end);
      if (le === -1) le = text.length; else le += 1;
      const newText = text.slice(0, ls) + text.slice(le);
      this._replaceAll(newText, ls, ls);
    }

    _moveLine(dir) {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const ls = text.lastIndexOf("\n", start - 1) + 1;
      let le = text.indexOf("\n", end);
      if (le === -1) le = text.length;
      const block = text.slice(ls, le);
      if (dir < 0) {
        if (ls === 0) return;
        const prevLs = text.lastIndexOf("\n", ls - 2) + 1;
        const prevLe = ls - 1;
        const prevBlock = text.slice(prevLs, prevLe);
        const newText = text.slice(0, prevLs) + block + "\n" + prevBlock + text.slice(le);
        const shift = prevBlock.length + 1;
        this._replaceAll(newText, start - shift, end - shift);
      } else {
        if (le === text.length) return;
        const nextLs = le + 1;
        let nextLe = text.indexOf("\n", nextLs);
        if (nextLe === -1) nextLe = text.length;
        const nextBlock = text.slice(nextLs, nextLe);
        const newText = text.slice(0, ls) + nextBlock + "\n" + block + text.slice(nextLe);
        const shift = nextBlock.length + 1;
        this._replaceAll(newText, start + shift, end + shift);
      }
    }

    _toggleComment() {
      const ta = $(this.root, "[data-ne-textarea]");
      const t = this.activeTab();
      if (!ta || !t) return;
      const prefix = commentPrefixFor(t.lang);
      if (!prefix) return;
      const start = ta.selectionStart;
      const end   = ta.selectionEnd;
      const text = ta.value;
      const ls = text.lastIndexOf("\n", start - 1) + 1;
      let le = text.indexOf("\n", end === start ? end : end - 1);
      if (le === -1) le = text.length;
      const block = text.slice(ls, le);
      const lines = block.split("\n");
      const allCommented = lines.every((l) => l.trim() === "" || l.trimStart().startsWith(prefix));
      const processed = lines.map((l) => {
        if (l.trim() === "") return l;
        if (allCommented) {
          const idx = l.indexOf(prefix);
          return l.slice(0, idx) + l.slice(idx + prefix.length).replace(/^ /, "");
        }
        const pad = (l.match(/^[ \t]*/) || [""])[0];
        return pad + prefix + " " + l.slice(pad.length);
      });
      const newBlock = processed.join("\n");
      const newText = text.slice(0, ls) + newBlock + text.slice(le);
      const delta = newBlock.length - block.length;
      this._replaceAll(newText, start, end + delta);
    }

    /* --------------------------------------------------------------
     * FIND / REPLACE
     * ----------------------------------------------------------- */
    _bindFindBar() {
      const self = this;
      const bar = $(this.root, "[data-ne-findbar]");
      const findInput    = $(this.root, "[data-ne-find-input]");
      const replaceInput = $(this.root, "[data-ne-replace-input]");
      this.findState = {
        query: "", matches: [], index: -1,
        caseSensitive: false, wholeWord: false, regex: false,
      };

      findInput.addEventListener("input", () => {
        self.findState.query = findInput.value;
        self._recomputeFind();
      });
      findInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault();
          if (ev.shiftKey) self._findPrev(); else self._findNext();
        } else if (ev.key === "Escape") {
          ev.preventDefault(); self._hideFindBar();
        }
      });
      replaceInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); self._replaceCurrent(); }
        else if (ev.key === "Escape") { ev.preventDefault(); self._hideFindBar(); }
      });

      $$(bar, "[data-find-act]").forEach((b) => {
        b.addEventListener("click", () => {
          const a = b.dataset.findAct;
          if (a === "prev")        self._findPrev();
          else if (a === "next")   self._findNext();
          else if (a === "close")  self._hideFindBar();
          else if (a === "replace")     self._replaceCurrent();
          else if (a === "replace-all") self._replaceAllMatches();
        });
      });
      $$(bar, "[data-find-opt]").forEach((b) => {
        b.addEventListener("click", () => {
          const o = b.dataset.findOpt;
          if (o === "case")  self.findState.caseSensitive = !self.findState.caseSensitive;
          if (o === "word")  self.findState.wholeWord = !self.findState.wholeWord;
          if (o === "regex") self.findState.regex = !self.findState.regex;
          b.classList.toggle("is-active");
          self._recomputeFind();
        });
      });
    }

    _showFindBar(withReplace) {
      const bar = $(this.root, "[data-ne-findbar]");
      const rr  = $(this.root, "[data-ne-replace-row]");
      bar.hidden = false;
      rr.style.display = withReplace ? "" : "none";
      const input = $(this.root, "[data-ne-find-input]");
      // Pre-fill with selection if any
      const ta = $(this.root, "[data-ne-textarea]");
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (!sel.includes("\n")) { input.value = sel; this.findState.query = sel; this._recomputeFind(); }
      }
      input.focus();
      input.select();
    }

    _hideFindBar() {
      const bar = $(this.root, "[data-ne-findbar]");
      if (bar) bar.hidden = true;
      this.findState.matches = [];
      this.findState.index = -1;
      this._renderFindHighlights();
      const ta = $(this.root, "[data-ne-textarea]");
      if (ta) ta.focus();
    }

    _recomputeFind() {
      const st = this.findState;
      const ta = $(this.root, "[data-ne-textarea]");
      const countEl = $(this.root, "[data-ne-find-count]");
      if (!ta) return;
      st.matches = [];
      st.index = -1;
      if (!st.query) { countEl.textContent = "0 / 0"; this._renderFindHighlights(); return; }
      let pattern;
      try {
        const flags = (st.caseSensitive ? "g" : "gi");
        let src = st.regex ? st.query : escapeRegExp(st.query);
        if (st.wholeWord && !st.regex) src = "\\b" + src + "\\b";
        pattern = new RegExp(src, flags);
      } catch (e) {
        countEl.textContent = "invalid";
        this._renderFindHighlights();
        return;
      }
      const text = ta.value;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        if (m[0].length === 0) { pattern.lastIndex++; continue; }
        st.matches.push({ start: m.index, end: m.index + m[0].length });
      }
      if (st.matches.length) {
        // Move to the first match after current caret
        const cur = ta.selectionStart;
        st.index = st.matches.findIndex((m) => m.start >= cur);
        if (st.index === -1) st.index = 0;
      }
      countEl.textContent = st.matches.length ? ((st.index + 1) + " / " + st.matches.length) : "0 / 0";
      this._renderFindHighlights();
    }

    _findNext() {
      const st = this.findState;
      if (!st.matches.length) return;
      st.index = (st.index + 1) % st.matches.length;
      this._jumpToMatch();
    }

    _findPrev() {
      const st = this.findState;
      if (!st.matches.length) return;
      st.index = (st.index - 1 + st.matches.length) % st.matches.length;
      this._jumpToMatch();
    }

    _jumpToMatch() {
      const st = this.findState;
      const m = st.matches[st.index];
      if (!m) return;
      const ta = $(this.root, "[data-ne-textarea]");
      ta.focus();
      ta.selectionStart = m.start;
      ta.selectionEnd   = m.end;
      // Scroll so match is visible
      const pos = this._caretCoordinates(m.start);
      const tAreaTop = ta.scrollTop;
      const tAreaBot = tAreaTop + ta.clientHeight;
      if (pos.top < tAreaTop + 4) ta.scrollTop = pos.top - 4;
      else if (pos.top + LINE_HEIGHT > tAreaBot - 4) ta.scrollTop = pos.top + LINE_HEIGHT - ta.clientHeight + 4;
      const countEl = $(this.root, "[data-ne-find-count]");
      if (countEl) countEl.textContent = ((st.index + 1) + " / " + st.matches.length);
      this._renderFindHighlights();
      this._updateStatusBar();
      this._updateLineHighlight();
    }

    _replaceCurrent() {
      const st = this.findState;
      if (!st.matches.length || st.index < 0) return;
      const ta = $(this.root, "[data-ne-textarea]");
      const repl = $(this.root, "[data-ne-replace-input]").value;
      const m = st.matches[st.index];
      const newText = ta.value.slice(0, m.start) + repl + ta.value.slice(m.end);
      this._replaceAll(newText, m.start + repl.length, m.start + repl.length);
      this._recomputeFind();
      if (st.matches.length) {
        this._jumpToMatch();
      }
    }

    _replaceAllMatches() {
      const st = this.findState;
      if (!st.matches.length) return;
      const ta = $(this.root, "[data-ne-textarea]");
      const repl = $(this.root, "[data-ne-replace-input]").value;
      let text = ta.value;
      // Replace from the end backwards so earlier indices remain valid
      for (let i = st.matches.length - 1; i >= 0; i--) {
        const m = st.matches[i];
        text = text.slice(0, m.start) + repl + text.slice(m.end);
      }
      this._replaceAll(text, 0, 0);
      this._recomputeFind();
    }

    _renderFindHighlights() {
      // Overlay divs for matches, drawn over the highlight layer via absolutely
      // positioned elements inside the editor-col
      const col = $(this.root, "[data-ne-editor-col]");
      if (!col) return;
      // Remove old
      $$(col, ".ne-match-highlight").forEach((n) => n.remove());
      const st = this.findState;
      if (!st.matches.length) return;
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const maxDraw = 1000;
      const count = Math.min(st.matches.length, maxDraw);
      for (let i = 0; i < count; i++) {
        const m = st.matches[i];
        const rects = this._rangeRects(m.start, m.end);
        for (const r of rects) {
          const el = document.createElement("div");
          el.className = "ne-match-highlight" + (i === st.index ? " is-current" : "");
          el.style.left = (r.left - ta.scrollLeft) + "px";
          el.style.top  = (r.top  - ta.scrollTop)  + "px";
          el.style.width  = r.width + "px";
          el.style.height = r.height + "px";
          col.appendChild(el);
        }
      }
    }

    _showGoto() {
      const n = prompt("Go to line:");
      if (!n) return;
      const line = parseInt(n, 10);
      if (isNaN(line) || line < 1) return;
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const lines = ta.value.split("\n");
      let offset = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length - 1); i++) offset += lines[i].length + 1;
      ta.focus();
      ta.selectionStart = offset;
      ta.selectionEnd   = offset;
      this._updateLineHighlight();
      this._updateStatusBar();
    }

    /* --------------------------------------------------------------
     * COORDINATE MATH
     * ----------------------------------------------------------- */
    _caretCoordinates(offset) {
      // naive: lineCount * LINE_HEIGHT + column * charWidth
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return { left: 0, top: 0 };
      const lines = ta.value.slice(0, offset).split("\n");
      const line = lines.length - 1;
      const col = lines[lines.length - 1].length;
      const cw = this._charWidth();
      return {
        left: 10 + col * cw,   // 10 padding
        top:  8  + line * LINE_HEIGHT,
      };
    }

    _rangeRects(start, end) {
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return [];
      const text = ta.value;
      const cw = this._charWidth();
      const rects = [];
      let cur = start;
      while (cur < end) {
        const lineStart = text.lastIndexOf("\n", cur - 1) + 1;
        let lineEnd = text.indexOf("\n", cur);
        if (lineEnd === -1 || lineEnd > end) lineEnd = end;
        else if (lineEnd > end) lineEnd = end;
        const line = text.slice(0, lineStart).split("\n").length - 1;
        const startCol = cur - lineStart;
        const endCol = Math.min(lineEnd - lineStart, end - lineStart);
        rects.push({
          left: 10 + startCol * cw,
          top:  8  + line * LINE_HEIGHT,
          width: Math.max(2, (endCol - startCol) * cw),
          height: LINE_HEIGHT,
        });
        if (lineEnd === end) break;
        cur = lineEnd + 1;
      }
      return rects;
    }

    _charWidth() {
      if (this._cachedCW && this._cachedCWFont === this.fontPx) return this._cachedCW;
      const probe = document.createElement("span");
      probe.style.cssText = `position:absolute;visibility:hidden;font-family:var(--font-mono,monospace);font-size:${this.fontPx}px;`;
      probe.textContent = "M".repeat(80);
      document.body.appendChild(probe);
      const w = probe.getBoundingClientRect().width / 80;
      document.body.removeChild(probe);
      this._cachedCW = w;
      this._cachedCWFont = this.fontPx;
      return w;
    }

    /* --------------------------------------------------------------
     * RENDER HELPERS
     * ----------------------------------------------------------- */
    _updateHighlight() {
      const t = this.activeTab();
      const code = $(this.root, "[data-ne-highlight-code]");
      const pre  = $(this.root, "[data-ne-highlight]");
      if (!t || !code) return;
      const tokens = tokenize(t.text, t.lang);
      code.innerHTML = renderHighlightHTML(t.text, tokens);
      // Ensure the <pre> scroll matches textarea scroll
      const ta = $(this.root, "[data-ne-textarea]");
      if (ta && pre) {
        pre.scrollTop  = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
      }
    }

    _syncScroll() {
      const ta  = $(this.root, "[data-ne-textarea]");
      const pre = $(this.root, "[data-ne-highlight]");
      if (ta && pre) {
        pre.scrollTop  = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
      }
      this._renderFindHighlights();
    }

    _updateGutter() {
      const g = $(this.root, "[data-ne-gutter]");
      const ta = $(this.root, "[data-ne-textarea]");
      if (!g || !ta) return;
      g.hidden = !this.gutterOn;
      if (!this.gutterOn) return;
      const text = ta.value;
      const lines = text.split("\n").length;
      const curLine = ta.value.slice(0, ta.selectionStart).split("\n").length;
      let inner = g.querySelector(".ne-gutter-inner");
      if (!inner) {
        inner = document.createElement("div");
        inner.className = "ne-gutter-inner";
        g.appendChild(inner);
      }
      // Build gutter html
      let html = "";
      for (let i = 1; i <= lines; i++) {
        html += `<span class="ne-gutter-line${i === curLine ? " is-current" : ""}">${i}</span>`;
      }
      inner.innerHTML = html;
      // Sync scroll
      inner.style.top = (8 - ta.scrollTop) + "px";
      // Adjust gutter width to fit largest line number
      const digits = String(lines).length;
      g.style.width = Math.max(40, digits * 10 + 20) + "px";
    }

    _updateLineHighlight() {
      const hl = $(this.root, "[data-ne-line-hl]");
      const ta = $(this.root, "[data-ne-textarea]");
      if (!hl || !ta) return;
      hl.hidden = !this.lineHLOn;
      if (!this.lineHLOn) return;
      const line = ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
      hl.style.top = (8 + line * LINE_HEIGHT - ta.scrollTop) + "px";
      hl.style.height = LINE_HEIGHT + "px";
    }

    _updateBracketMatch() {
      const col = $(this.root, "[data-ne-editor-col]");
      if (!col) return;
      $$(col, ".ne-bracket-highlight").forEach((n) => n.remove());
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const caret = ta.selectionStart;
      if (caret !== ta.selectionEnd) return;
      const text = ta.value;
      const pairs = { "(": [")", 1], ")": ["(", -1], "[": ["]", 1], "]": ["[", -1], "{": ["}", 1], "}": ["{", -1] };
      const checkPositions = [caret, caret - 1];
      for (const p of checkPositions) {
        const ch = text[p];
        if (pairs[ch]) {
          const [match, dir] = pairs[ch];
          let depth = 1;
          let i = p + dir;
          while (i >= 0 && i < text.length) {
            const c = text[i];
            if (c === ch) depth++;
            else if (c === match) depth--;
            if (depth === 0) {
              // Highlight both p and i
              this._drawBracketAt(p);
              this._drawBracketAt(i);
              return;
            }
            i += dir;
          }
          return;
        }
      }
    }

    _drawBracketAt(offset) {
      const col = $(this.root, "[data-ne-editor-col]");
      const ta  = $(this.root, "[data-ne-textarea]");
      if (!col || !ta) return;
      const pos = this._caretCoordinates(offset);
      const el = document.createElement("div");
      el.className = "ne-bracket-highlight";
      el.style.left = (pos.left - ta.scrollLeft) + "px";
      el.style.top  = (pos.top  - ta.scrollTop)  + "px";
      el.style.width = this._charWidth() + "px";
      el.style.height = LINE_HEIGHT + "px";
      col.appendChild(el);
    }

    _updateStatusBar() {
      const t = this.activeTab();
      const ta = $(this.root, "[data-ne-textarea]");
      if (!t || !ta) return;
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const lines = before.split("\n");
      const ln = lines.length;
      const col = lines[lines.length - 1].length + 1;
      const selLen = Math.abs(ta.selectionEnd - ta.selectionStart);
      const wc = (ta.value.trim().match(/\S+/g) || []).length;
      const cc = ta.value.length;
      const set = (k, v) => { const el = $(this.root, `[data-sb="${k}"]`); if (el) el.textContent = v; };
      set("file",      t.path ? basename(t.path) : t.title);
      set("lang",      LANG_DISPLAY[t.lang] || "Plain Text");
      set("dirty",     t.dirty ? "● Modified" : "");
      set("linecol",   "Ln " + ln + ", Col " + col);
      set("sel",       selLen ? selLen + " sel" : "0 sel");
      set("wordcount", wc + " words · " + cc + " chars");
      set("eol",       t.eol === "\r\n" ? "CRLF" : "LF");
      set("enc",       "UTF-8");
      set("zoom",      this.fontPx + "px");
    }

    /* --------------------------------------------------------------
     * MINIMAP
     * ----------------------------------------------------------- */
    _updateMinimap() {
      const mm = $(this.root, "[data-ne-minimap]");
      const cv = $(this.root, "[data-ne-minimap-canvas]");
      const slider = $(this.root, "[data-ne-minimap-slider]");
      if (!mm || !cv) return;
      mm.hidden = !this.minimapOn;
      if (!this.minimapOn) return;
      const ta = $(this.root, "[data-ne-textarea]");
      if (!ta) return;
      const text = ta.value;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, w, h);
      const lines = text.split("\n");
      const lineH = Math.max(1, Math.floor(h / Math.max(50, lines.length)));
      ctx.fillStyle = "rgba(233, 233, 243, 0.5)";
      for (let i = 0; i < lines.length; i++) {
        const len = Math.min(lines[i].length, 80);
        ctx.fillRect(2, i * lineH, (len / 80) * (w - 4), Math.max(1, lineH - 1));
      }
      // slider reflects visible portion
      const scrollH = ta.scrollHeight;
      const cli = ta.clientHeight;
      if (scrollH > 0) {
        const topFrac = ta.scrollTop / scrollH;
        const hFrac = cli / scrollH;
        slider.style.top = (topFrac * h) + "px";
        slider.style.height = Math.max(20, hFrac * h) + "px";
      }
    }

    /* --------------------------------------------------------------
     * VIEW TOGGLES
     * ----------------------------------------------------------- */
    _setZoom(v) {
      v = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, v));
      this.fontPx = v;
      const ta = $(this.root, "[data-ne-textarea]");
      const pre = $(this.root, "[data-ne-highlight]");
      if (ta) ta.style.fontSize = v + "px";
      if (pre) pre.style.fontSize = v + "px";
      this._cachedCW = null;
      this._updateGutter();
      this._updateStatusBar();
      this._updateLineHighlight();
      this._updateMinimap();
    }

    _toggleWrap() {
      this.wrap = !this.wrap;
      this.root.classList.toggle("is-wrap", this.wrap);
      this._updateStatusBar();
    }

    _toggleMinimap() {
      this.minimapOn = !this.minimapOn;
      this._updateMinimap();
    }

    _toggleGutter() {
      this.gutterOn = !this.gutterOn;
      this._updateGutter();
    }

    _toggleLineHL() {
      this.lineHLOn = !this.lineHLOn;
      this._updateLineHighlight();
    }

    _setLang(lang) {
      const t = this.activeTab();
      if (!t) return;
      t.lang = lang;
      this._updateHighlight();
      this._updateStatusBar();
    }

    _setEol(eol) {
      const t = this.activeTab();
      if (!t) return;
      t.eol = eol;
      this._updateStatusBar();
    }

    _setIndent(v) {
      if (v === "tab") { this.indentUseTab = true; this.indentWidth = 1; }
      else { this.indentUseTab = false; this.indentWidth = v; }
    }

    _layoutTick() {
      this._updateGutter();
      this._updateLineHighlight();
      this._updateMinimap();
      this._renderFindHighlights();
    }

    /* --------------------------------------------------------------
     * RUN (eval JS for sandboxed tabs) — best-effort only
     * ----------------------------------------------------------- */
    _runCurrentScript() {
      const t = this.activeTab();
      if (!t) return;
      if (t.lang !== "js") {
        alert("Run is only supported for JavaScript tabs.");
        return;
      }
      try {
        const fn = new Function('"use strict"; const log=[]; const console={log:(...a)=>log.push(a.map(String).join(" "))}; ' + t.text + "; return log.join(\"\\n\");");
        const out = fn();
        alert("▶ Output:\n\n" + (out || "(no output)"));
      } catch (e) {
        alert("❌ Error: " + e.message);
      }
    }

    _clearRunOutput() { /* reserved for dedicated output pane */ }

    /* --------------------------------------------------------------
     * FILESYSTEM OPEN / SAVE
     * ----------------------------------------------------------- */
    _bindModal() {
      const self = this;
      const modal = $(this.root, "[data-ne-modal]");
      $(modal, "[data-ne-modal-close]").addEventListener("click", () => self._hideModal());
      $(modal, "[data-ne-modal-cancel]").addEventListener("click", () => self._hideModal());
      $(modal, "[data-ne-modal-ok]").addEventListener("click", () => self._modalConfirm());
      $(modal, "[data-ne-modal-up]").addEventListener("click", () => self._modalNavigate(dirname(self._modalState.cwd)));
      $(modal, "[data-ne-modal-path]").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); self._modalNavigate(ev.target.value); }
      });
    }

    _showOpenDialog() {
      const fs = window.FileSystem;
      if (!fs) return alert("FileSystem is not available.");
      this._modalState = { mode: "open", cwd: "/Documents", selected: null };
      this._showModal("Open File");
      this._modalNavigate(this._modalState.cwd);
    }

    _showSaveAsDialog() {
      const fs = window.FileSystem;
      if (!fs) return alert("FileSystem is not available.");
      const t = this.activeTab();
      this._modalState = {
        mode: "saveAs",
        cwd: t && t.path ? dirname(t.path) : "/Documents",
        selected: null,
      };
      this._showModal("Save As");
      this._modalNavigate(this._modalState.cwd);
      const nameEl = $(this.root, "[data-ne-modal-name]");
      if (nameEl) nameEl.value = (t && t.title) || "Untitled.txt";
    }

    _showModal(title) {
      const modal = $(this.root, "[data-ne-modal]");
      $(modal, "[data-ne-modal-title]").textContent = title;
      modal.hidden = false;
    }

    _hideModal() {
      const modal = $(this.root, "[data-ne-modal]");
      if (modal) modal.hidden = true;
    }

    _modalNavigate(path) {
      const fs = window.FileSystem;
      if (!fs) return;
      try {
        if (!fs.exists(path)) path = "/";
        this._modalState.cwd = path;
        $(this.root, "[data-ne-modal-path]").value = path;
        const items = fs.list(path) || [];
        const list = $(this.root, "[data-ne-modal-list]");
        list.innerHTML = "";
        // parent up (except root)
        if (path !== "/") {
          const row = document.createElement("div");
          row.className = "ne-modal-item";
          row.innerHTML = `<span class="ne-modal-item-icon">📁</span><span class="ne-modal-item-name">..</span>`;
          row.addEventListener("dblclick", () => this._modalNavigate(dirname(path)));
          row.addEventListener("click", () => {
            $$(list, ".ne-modal-item").forEach((r) => r.classList.remove("is-selected"));
            row.classList.add("is-selected");
          });
          list.appendChild(row);
        }
        // folders first
        items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === "folder" ? -1 : 1)));
        items.forEach((it) => {
          const row = document.createElement("div");
          row.className = "ne-modal-item";
          const isFolder = it.type === "folder";
          const sizeStr = isFolder ? "" : (fs.formatBytes ? fs.formatBytes(it.size || 0) : (it.size || 0) + " B");
          row.innerHTML = `
            <span class="ne-modal-item-icon">${isFolder ? "📁" : iconForPath(it.name)}</span>
            <span class="ne-modal-item-name">${escapeHtml(it.name)}</span>
            <span class="ne-modal-item-size">${escapeHtml(sizeStr)}</span>
          `;
          row.addEventListener("click", () => {
            $$(list, ".ne-modal-item").forEach((r) => r.classList.remove("is-selected"));
            row.classList.add("is-selected");
            this._modalState.selected = it;
            if (!isFolder) {
              const ne = $(this.root, "[data-ne-modal-name]");
              if (ne) ne.value = it.name;
            }
          });
          row.addEventListener("dblclick", () => {
            if (isFolder) this._modalNavigate(fs.joinPath ? fs.joinPath(path, it.name) : (path.replace(/\/$/, "") + "/" + it.name));
            else { this._modalState.selected = it; this._modalConfirm(); }
          });
          list.appendChild(row);
        });
      } catch (e) {
        console.warn("[NoteForge] modal nav error:", e);
      }
    }

    _modalConfirm() {
      const fs = window.FileSystem;
      if (!fs) return;
      const st = this._modalState;
      const nameEl = $(this.root, "[data-ne-modal-name]");
      const name = nameEl ? nameEl.value.trim() : "";
      if (st.mode === "open") {
        const sel = st.selected;
        if (sel) {
          if (sel.type === "folder") { this._modalNavigate(fs.joinPath ? fs.joinPath(st.cwd, sel.name) : (st.cwd.replace(/\/$/, "") + "/" + sel.name)); return; }
          const p = fs.joinPath ? fs.joinPath(st.cwd, sel.name) : (st.cwd.replace(/\/$/, "") + "/" + sel.name);
          this.openFromPath(p);
          this._hideModal();
        } else if (name) {
          const p = fs.joinPath ? fs.joinPath(st.cwd, name) : (st.cwd.replace(/\/$/, "") + "/" + name);
          if (fs.exists(p)) { this.openFromPath(p); this._hideModal(); }
          else alert("File not found: " + p);
        }
      } else if (st.mode === "saveAs") {
        if (!name) return;
        const p = fs.joinPath ? fs.joinPath(st.cwd, name) : (st.cwd.replace(/\/$/, "") + "/" + name);
        const t = this.activeTab();
        if (!t) return;
        try {
          if (fs.exists(p)) {
            if (!confirm("Overwrite " + p + "?")) return;
            fs.writeFile(p, t.text);
          } else {
            fs.writeFile(p, t.text);
          }
          t.path = p;
          t.title = basename(p);
          t.lang = detectLang(getExt(p));
          t.dirty = false;
          this._renderTabBar();
          this._updateStatusBar();
          this._hideModal();
        } catch (e) {
          alert("Save failed: " + e.message);
        }
      }
    }

    openFromPath(path) {
      const fs = window.FileSystem;
      if (!fs) return alert("FileSystem is not available.");
      try {
        if (!fs.exists(path)) {
          alert("File not found: " + path);
          return;
        }
        const content = fs.readFile(path);
        // Check if already open
        const existing = this.tabs.findIndex((t) => t.path === path);
        if (existing >= 0) {
          this.switchTab(existing);
          return;
        }
        const ext = getExt(path);
        const lang = detectLang(ext);
        const eol = content.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
        const title = basename(path);
        const tab = this.newTab({
          title, path, text: content, lang, eol,
        });
        tab.dirty = false;
        this._renderTabBar();
        this._updateStatusBar();
      } catch (e) {
        alert("Open failed: " + e.message);
      }
    }

    save() {
      const t = this.activeTab();
      if (!t) return;
      const fs = window.FileSystem;
      if (!fs) return alert("FileSystem is not available.");
      if (!t.path) return this.saveAs();
      try {
        fs.writeFile(t.path, t.text);
        t.dirty = false;
        this._renderTabBar();
        this._updateStatusBar();
      } catch (e) {
        alert("Save failed: " + e.message);
      }
    }

    saveAs() { this._showSaveAsDialog(); }

    /* --------------------------------------------------------------
     * SHORTCUTS HELP
     * ----------------------------------------------------------- */
    _renderShortcuts() {
      const body = $(this.root, "[data-ne-sc-body]");
      if (!body) return;
      const groups = {};
      for (const [id, kbd, g, desc] of KEYMAP) {
        (groups[g] = groups[g] || []).push({ kbd, desc });
      }
      let html = "";
      Object.keys(groups).forEach((g) => {
        html += `<div class="ne-sc-group">${escapeHtml(g)}</div>`;
        groups[g].forEach((row) => {
          html += `<div class="ne-sc-row"><span>${escapeHtml(row.desc)}</span><span class="ne-sc-kbd">${escapeHtml(row.kbd)}</span></div>`;
        });
      });
      body.innerHTML = html;
      $(this.root, "[data-ne-sc-close]").addEventListener("click", () => this._toggleShortcuts(false));
    }

    _toggleShortcuts(show) {
      const sc = $(this.root, "[data-ne-shortcuts]");
      if (!sc) return;
      if (show === undefined) show = sc.hidden;
      sc.hidden = !show;
    }
  }

  /* -------------------------------------------------------------------------
   * 5.  HELPERS shared across all NoteForge instances
   * ---------------------------------------------------------------------- */
  function iconForLang(lang) {
    switch (lang) {
      case "js":   return "🟨";
      case "py":   return "🐍";
      case "html": return "🌐";
      case "css":  return "🎨";
      case "json": return "🗂";
      case "md":   return "📝";
      default:     return "📄";
    }
  }

  function iconForPath(name) {
    const ext = getExt(name);
    return iconForLang(detectLang(ext));
  }

  function commentPrefixFor(lang) {
    switch (lang) {
      case "js":   return "//";
      case "py":   return "#";
      case "css":  return "/*"; // handled specially? We'll use `/* */` wrap; simplify: use '//' if scss
      case "html": return null;
      case "json": return null;
      case "md":   return null;
      default:     return "#";
    }
  }

  /* -------------------------------------------------------------------------
   * 6.  TEMPLATE LOADER — we inline the HTML template string here so the JS
   *     file is self-contained (no fetch required). Kept in sync with
   *     apps/textEditor/textEditor.html.
   * ---------------------------------------------------------------------- */
  const HTML_TEMPLATE = `
<div class="ne-root" data-ne-root>
  <div class="ne-menubar" role="menubar">
    <button class="ne-menu-item" data-menu="file"   role="menuitem" aria-haspopup="true">File</button>
    <button class="ne-menu-item" data-menu="edit"   role="menuitem" aria-haspopup="true">Edit</button>
    <button class="ne-menu-item" data-menu="view"   role="menuitem" aria-haspopup="true">View</button>
    <button class="ne-menu-item" data-menu="format" role="menuitem" aria-haspopup="true">Format</button>
    <button class="ne-menu-item" data-menu="run"    role="menuitem" aria-haspopup="true">Run</button>
    <div class="ne-menubar-spacer"></div>
    <div class="ne-toolbar-actions">
      <button class="ne-icon-btn" data-act="new"      title="New (Ctrl+N)">📄</button>
      <button class="ne-icon-btn" data-act="open"     title="Open (Ctrl+O)">📂</button>
      <button class="ne-icon-btn" data-act="save"     title="Save (Ctrl+S)">💾</button>
      <button class="ne-icon-btn" data-act="find"     title="Find (Ctrl+F)">🔍</button>
      <button class="ne-icon-btn" data-act="replace"  title="Replace (Ctrl+H)">🔁</button>
      <span class="ne-sep"></span>
      <button class="ne-icon-btn" data-act="undo"     title="Undo (Ctrl+Z)">↶</button>
      <button class="ne-icon-btn" data-act="redo"     title="Redo (Ctrl+Y)">↷</button>
      <span class="ne-sep"></span>
      <button class="ne-icon-btn" data-act="toggleWrap"     title="Toggle Word Wrap (Ctrl+Alt+W)">⇄</button>
      <button class="ne-icon-btn" data-act="toggleMinimap"  title="Toggle Minimap">🗺</button>
      <button class="ne-icon-btn" data-act="showShortcuts"  title="Shortcuts (Ctrl+/)">?</button>
    </div>
  </div>
  <div class="ne-dropdown" data-ne-dropdown hidden></div>
  <div class="ne-tabbar" data-ne-tabbar role="tablist">
    <button class="ne-tab-new" data-act="new" title="New tab (Ctrl+N)">+</button>
  </div>
  <div class="ne-findbar" data-ne-findbar hidden>
    <div class="ne-find-row">
      <span class="ne-find-label">Find</span>
      <input class="ne-find-input"    data-ne-find-input    type="text" spellcheck="false" placeholder="Find…" />
      <button class="ne-find-btn" data-find-act="prev"   title="Previous (Shift+Enter)">↑</button>
      <button class="ne-find-btn" data-find-act="next"   title="Next (Enter)">↓</button>
      <span class="ne-find-count" data-ne-find-count>0 / 0</span>
      <button class="ne-find-toggle" data-find-opt="case" title="Match case">Aa</button>
      <button class="ne-find-toggle" data-find-opt="word" title="Whole word">⟨W⟩</button>
      <button class="ne-find-toggle" data-find-opt="regex" title="Regex">.*</button>
      <button class="ne-find-close" data-find-act="close" title="Close (Esc)">✕</button>
    </div>
    <div class="ne-find-row ne-replace-row" data-ne-replace-row style="display:none;">
      <span class="ne-find-label">Replace</span>
      <input class="ne-find-input"    data-ne-replace-input type="text" spellcheck="false" placeholder="Replace with…" />
      <button class="ne-find-btn" data-find-act="replace"     title="Replace">Replace</button>
      <button class="ne-find-btn" data-find-act="replace-all" title="Replace all">Replace All</button>
    </div>
  </div>
  <div class="ne-editor-wrap" data-ne-editor-wrap>
    <div class="ne-gutter" data-ne-gutter aria-hidden="true"></div>
    <div class="ne-editor-col" data-ne-editor-col>
      <pre class="ne-highlight" data-ne-highlight aria-hidden="true"><code data-ne-highlight-code></code></pre>
      <textarea class="ne-textarea" data-ne-textarea spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" wrap="off" aria-label="Text editor"></textarea>
      <div class="ne-line-highlight" data-ne-line-hl></div>
    </div>
    <div class="ne-minimap" data-ne-minimap hidden>
      <canvas data-ne-minimap-canvas></canvas>
      <div class="ne-minimap-slider" data-ne-minimap-slider></div>
    </div>
  </div>
  <div class="ne-statusbar" data-ne-statusbar>
    <div class="ne-sb-left">
      <span class="ne-sb-item"  data-sb="file">Untitled</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="lang">Plain Text</span>
    </div>
    <div class="ne-sb-center">
      <span class="ne-sb-item"  data-sb="dirty"></span>
    </div>
    <div class="ne-sb-right">
      <span class="ne-sb-item"  data-sb="linecol">Ln 1, Col 1</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="sel">0 sel</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="wordcount">0 words · 0 chars</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="eol">LF</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="enc">UTF-8</span>
      <span class="ne-sb-dot">•</span>
      <span class="ne-sb-item"  data-sb="zoom">14px</span>
    </div>
  </div>
  <div class="ne-modal" data-ne-modal hidden>
    <div class="ne-modal-card">
      <div class="ne-modal-head">
        <span class="ne-modal-title" data-ne-modal-title>Open File</span>
        <button class="ne-icon-btn" data-ne-modal-close>✕</button>
      </div>
      <div class="ne-modal-body">
        <div class="ne-path-bar">
          <button class="ne-find-btn" data-ne-modal-up title="Up">↑</button>
          <input class="ne-find-input" data-ne-modal-path type="text" spellcheck="false" />
        </div>
        <div class="ne-modal-list" data-ne-modal-list></div>
        <div class="ne-modal-foot">
          <label class="ne-modal-label">Name:</label>
          <input class="ne-find-input" data-ne-modal-name type="text" spellcheck="false" />
          <button class="ne-find-btn ne-btn-primary" data-ne-modal-ok>OK</button>
          <button class="ne-find-btn" data-ne-modal-cancel>Cancel</button>
        </div>
      </div>
    </div>
  </div>
  <div class="ne-shortcuts" data-ne-shortcuts hidden>
    <div class="ne-sc-card">
      <div class="ne-sc-head">
        <span>Keyboard Shortcuts</span>
        <button class="ne-icon-btn" data-ne-sc-close>✕</button>
      </div>
      <div class="ne-sc-body" data-ne-sc-body></div>
    </div>
  </div>
</div>
`;

  /* -------------------------------------------------------------------------
   * 7.  CSS AUTO-LINK (inject css href if not already present)
   * ---------------------------------------------------------------------- */
  (function ensureCss() {
    const href = "apps/textEditor/textEditor.css";
    const has = Array.from(document.styleSheets).some((s) => (s.href || "").endsWith(href));
    if (!has) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      document.head.appendChild(l);
    }
  })();

  /* -------------------------------------------------------------------------
   * 8.  REGISTER WITH WINDOW MANAGER
   * ---------------------------------------------------------------------- */
  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      // wait
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    // remove stub "notepad" if present? keep notepad as legacy — we register under a new id.
    window.WindowManager.registerApp({
      id: APP_ID,
      title: APP_TITLE,
      icon: APP_ICON,
      width: 900, height: 620,
      category: APP_CATEGORY,
      pinned: true,
      canOpen: (md) => {
        if (!md) return false;
        if (md.type === "folder") return false;
        if (md.kind === "text" || md.kind === "code") return true;
        const ext = getExt(md.path || md.name || "");
        return TEXT_EXTENSIONS.indexOf(ext) !== -1;
      },
      render(body, win) {
        const ed = new NoteForge(body, win.opts || {});
        ed.mount();
        // keep on the window for cleanup / external access
        win._noteforge = ed;
      },
      onClose(win) {
        if (win._noteforge) win._noteforge.destroy();
      },
    });
    console.log("%c[WebOS]%c NoteForge Text Editor registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }

  // Listen to WM ready signal or run immediately if already ready
  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* -------------------------------------------------------------------------
   * 9.  EXPOSE (for other apps and testing)
   * ---------------------------------------------------------------------- */
  window.NoteForge = {
    APP_ID, TEXT_EXTENSIONS, detectLang, tokenize, iconForLang,
    open(path) {
      const w = window.WindowManager.openApp(APP_ID, { openPath: path });
      return w;
    },
  };
})();
