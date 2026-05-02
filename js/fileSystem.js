/* ============================================================================
 * WebOS — fileSystem.js
 * ----------------------------------------------------------------------------
 * Virtual Filesystem Engine (VFS) for WebOS.
 *
 * Stores a complete tree of folders + files in localStorage, providing a
 * POSIX-flavored API for the rest of the OS to consume.
 *
 *  - Hierarchical paths:    /Documents/notes/todo.txt
 *  - File and Folder nodes with full metadata
 *  - CRUD operations:       readFile, writeFile, deleteFile, moveFile,
 *                           copyFile, createFolder, listDir, searchFiles,
 *                           getMetadata, exists, stat, rename, …
 *  - Trash bin:             delete moves to /Trash; emptyTrash purges
 *  - Read-only flags:       /System and its descendants
 *  - Permissions model:     basic { read, write, exec } per node
 *  - Event system:          emit "change|create|delete|move|rename|trash|empty"
 *  - Recent files:          last N opened/written tracked for Start Menu
 *  - Pre-populated demo content
 *
 * Public API on  window.FileSystem
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------------*/
  const STORAGE_KEY        = "webos.fs.v1";
  const STORAGE_KEY_RECENT = "webos.fs.recent";
  const SCHEMA_VERSION     = 1;
  const PATH_SEP           = "/";
  const ROOT_PATH          = "/";
  const TRASH_PATH         = "/Trash";
  const SYSTEM_PATH        = "/System";
  const RECENT_MAX         = 25;
  const MAX_PATH_LEN       = 4096;
  const MAX_NAME_LEN       = 255;
  const RESERVED_NAMES     = Object.freeze([
    "", ".", "..",
  ]);
  const ILLEGAL_NAME_RE    = /[\x00-\x1f\\\/:*?"<>|]/;

  // file kind
  const KIND_FILE          = "file";
  const KIND_FOLDER        = "folder";

  // permission flags
  const PERM_R = 4;
  const PERM_W = 2;
  const PERM_X = 1;
  const PERM_FULL = PERM_R | PERM_W | PERM_X; // 7
  const PERM_RX   = PERM_R | PERM_X;          // 5
  const PERM_R_   = PERM_R;                   // 4

  // event names emitted on document and via subscribers
  const EVENTS = Object.freeze({
    CHANGE:  "fs:change",
    CREATE:  "fs:create",
    DELETE:  "fs:delete",
    MOVE:    "fs:move",
    RENAME:  "fs:rename",
    WRITE:   "fs:write",
    READ:    "fs:read",
    TRASH:   "fs:trash",
    RESTORE: "fs:restore",
    EMPTY:   "fs:empty",
    READY:   "fs:ready",
    RECENT:  "fs:recent",
    MOUNT:   "fs:mount",
  });

  // file extension to mime/category map
  const EXT_MAP = Object.freeze({
    txt:   { kind: "text",     mime: "text/plain",        icon: "📄", color: "#9aa4b2" },
    md:    { kind: "text",     mime: "text/markdown",     icon: "📝", color: "#60a5fa" },
    json:  { kind: "text",     mime: "application/json",  icon: "🧾", color: "#fbbf24" },
    js:    { kind: "code",     mime: "text/javascript",   icon: "📜", color: "#facc15" },
    ts:    { kind: "code",     mime: "text/typescript",   icon: "📜", color: "#3b82f6" },
    html:  { kind: "code",     mime: "text/html",         icon: "🌐", color: "#fb923c" },
    css:   { kind: "code",     mime: "text/css",          icon: "🎨", color: "#22d3ee" },
    py:    { kind: "code",     mime: "text/x-python",     icon: "🐍", color: "#10b981" },
    log:   { kind: "text",     mime: "text/plain",        icon: "🪵", color: "#a78bfa" },
    csv:   { kind: "text",     mime: "text/csv",          icon: "📊", color: "#34d399" },
    pdf:   { kind: "document", mime: "application/pdf",   icon: "📕", color: "#ef4444" },
    doc:   { kind: "document", mime: "application/msword",icon: "📘", color: "#2563eb" },
    docx:  { kind: "document", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", icon: "📘", color: "#2563eb" },
    xls:   { kind: "document", mime: "application/vnd.ms-excel", icon: "📗", color: "#16a34a" },
    xlsx:  { kind: "document", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", icon: "📗", color: "#16a34a" },
    ppt:   { kind: "document", mime: "application/vnd.ms-powerpoint", icon: "📙", color: "#ea580c" },
    pptx:  { kind: "document", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", icon: "📙", color: "#ea580c" },
    png:   { kind: "image",    mime: "image/png",         icon: "🖼", color: "#f472b6" },
    jpg:   { kind: "image",    mime: "image/jpeg",        icon: "🖼", color: "#f472b6" },
    jpeg:  { kind: "image",    mime: "image/jpeg",        icon: "🖼", color: "#f472b6" },
    gif:   { kind: "image",    mime: "image/gif",         icon: "🖼", color: "#f472b6" },
    webp:  { kind: "image",    mime: "image/webp",        icon: "🖼", color: "#f472b6" },
    svg:   { kind: "image",    mime: "image/svg+xml",     icon: "🖼", color: "#f472b6" },
    bmp:   { kind: "image",    mime: "image/bmp",         icon: "🖼", color: "#f472b6" },
    ico:   { kind: "image",    mime: "image/x-icon",      icon: "🖼", color: "#f472b6" },
    mp3:   { kind: "audio",    mime: "audio/mpeg",        icon: "🎵", color: "#c084fc" },
    wav:   { kind: "audio",    mime: "audio/wav",         icon: "🎵", color: "#c084fc" },
    ogg:   { kind: "audio",    mime: "audio/ogg",         icon: "🎵", color: "#c084fc" },
    flac:  { kind: "audio",    mime: "audio/flac",        icon: "🎵", color: "#c084fc" },
    m4a:   { kind: "audio",    mime: "audio/mp4",         icon: "🎵", color: "#c084fc" },
    mp4:   { kind: "video",    mime: "video/mp4",         icon: "🎬", color: "#fb7185" },
    webm:  { kind: "video",    mime: "video/webm",        icon: "🎬", color: "#fb7185" },
    mov:   { kind: "video",    mime: "video/quicktime",   icon: "🎬", color: "#fb7185" },
    avi:   { kind: "video",    mime: "video/x-msvideo",   icon: "🎬", color: "#fb7185" },
    mkv:   { kind: "video",    mime: "video/x-matroska",  icon: "🎬", color: "#fb7185" },
    zip:   { kind: "archive",  mime: "application/zip",   icon: "🗜", color: "#eab308" },
    rar:   { kind: "archive",  mime: "application/x-rar", icon: "🗜", color: "#eab308" },
    "7z":  { kind: "archive",  mime: "application/x-7z-compressed", icon: "🗜", color: "#eab308" },
    tar:   { kind: "archive",  mime: "application/x-tar", icon: "🗜", color: "#eab308" },
    gz:    { kind: "archive",  mime: "application/gzip",  icon: "🗜", color: "#eab308" },
    exe:   { kind: "binary",   mime: "application/x-msdownload", icon: "⚙", color: "#9ca3af" },
    bin:   { kind: "binary",   mime: "application/octet-stream", icon: "⚙", color: "#9ca3af" },
    dll:   { kind: "binary",   mime: "application/x-msdownload", icon: "⚙", color: "#9ca3af" },
    sh:    { kind: "code",     mime: "text/x-shellscript",icon: "📜", color: "#22c55e" },
    sql:   { kind: "code",     mime: "application/sql",   icon: "🗄", color: "#0ea5e9" },
    xml:   { kind: "text",     mime: "application/xml",   icon: "🧾", color: "#fb923c" },
    yml:   { kind: "text",     mime: "application/yaml",  icon: "🧾", color: "#10b981" },
    yaml:  { kind: "text",     mime: "application/yaml",  icon: "🧾", color: "#10b981" },
    cfg:   { kind: "text",     mime: "text/plain",        icon: "🧾", color: "#9aa4b2" },
    ini:   { kind: "text",     mime: "text/plain",        icon: "🧾", color: "#9aa4b2" },
  });

  const FOLDER_VISUAL = Object.freeze({
    icon:  "📁",
    color: "#fbbf24",
    kind:  "folder",
    mime:  "inode/directory",
  });

  /* --------------------------------------------------------------------------
   * Internal state
   * ------------------------------------------------------------------------*/
  const state = {
    initialized: false,
    tree: null,           // root folder node
    nextId: 1,
    listeners: new Set(),
    recent: [],
    // a small write-coalescing buffer to avoid hammering localStorage
    pendingPersist: false,
    persistTimer: null,
  };

  /* --------------------------------------------------------------------------
   * Path utilities
   * ------------------------------------------------------------------------*/
  function isString(v) { return typeof v === "string"; }

  function normalizePath(p) {
    if (!isString(p)) throw new FsError("EINVAL", "Path must be a string");
    if (!p.length)    return ROOT_PATH;
    let path = p.replace(/\\/g, "/");
    // collapse multiple slashes
    path = path.replace(/\/+/g, "/");
    // ensure leading slash
    if (path[0] !== "/") path = "/" + path;
    // resolve . and ..
    const parts = path.split("/").filter(Boolean);
    const stack = [];
    for (const seg of parts) {
      if (seg === ".") continue;
      if (seg === "..") {
        if (stack.length) stack.pop();
        continue;
      }
      stack.push(seg);
    }
    const out = "/" + stack.join("/");
    if (out.length > MAX_PATH_LEN) throw new FsError("ENAMETOOLONG", "Path too long");
    return out;
  }

  function joinPath() {
    let acc = "";
    for (let i = 0; i < arguments.length; i++) {
      const seg = String(arguments[i] || "");
      if (!seg) continue;
      if (acc.length === 0) acc = seg;
      else if (acc[acc.length - 1] === "/" || seg[0] === "/") acc += seg;
      else acc += "/" + seg;
    }
    return normalizePath(acc || ROOT_PATH);
  }

  function dirname(p) {
    const path = normalizePath(p);
    if (path === ROOT_PATH) return ROOT_PATH;
    const idx = path.lastIndexOf("/");
    if (idx <= 0) return ROOT_PATH;
    return path.slice(0, idx);
  }

  function basename(p) {
    const path = normalizePath(p);
    if (path === ROOT_PATH) return "";
    const idx = path.lastIndexOf("/");
    return path.slice(idx + 1);
  }

  function extname(name) {
    if (!name) return "";
    const i = name.lastIndexOf(".");
    if (i <= 0) return "";
    return name.slice(i + 1).toLowerCase();
  }

  function splitName(name) {
    if (!name) return { stem: "", ext: "" };
    const i = name.lastIndexOf(".");
    if (i <= 0) return { stem: name, ext: "" };
    return { stem: name.slice(0, i), ext: name.slice(i + 1) };
  }

  function validateName(name) {
    if (!isString(name) || !name.length)
      throw new FsError("EINVAL", "Name is required");
    if (name.length > MAX_NAME_LEN)
      throw new FsError("ENAMETOOLONG", "Name too long");
    if (RESERVED_NAMES.indexOf(name) !== -1)
      throw new FsError("EINVAL", "Reserved name: " + name);
    if (ILLEGAL_NAME_RE.test(name))
      throw new FsError("EINVAL", "Illegal characters in name");
    return name;
  }

  function isAncestor(maybeAncestor, descendant) {
    const a = normalizePath(maybeAncestor);
    const d = normalizePath(descendant);
    if (a === d) return true;
    if (a === ROOT_PATH) return true;
    return d.startsWith(a + "/");
  }

  /* --------------------------------------------------------------------------
   * Errors
   * ------------------------------------------------------------------------*/
  function FsError(code, message) {
    this.name    = "FsError";
    this.code    = code;
    this.message = "[" + code + "] " + message;
  }
  FsError.prototype = Object.create(Error.prototype);
  FsError.prototype.constructor = FsError;

  /* --------------------------------------------------------------------------
   * Helpers — bytes, text encoding, ids
   * ------------------------------------------------------------------------*/
  function nextId() {
    return "n_" + (state.nextId++) + "_" + Date.now().toString(36);
  }

  function now() { return Date.now(); }

  function utf8Bytes(str) {
    if (str == null) return 0;
    if (typeof TextEncoder !== "undefined") {
      try { return new TextEncoder().encode(String(str)).length; } catch (_) {}
    }
    // fallback rough estimate
    let bytes = 0, s = String(str);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1024)        return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function formatDate(ts) {
    if (!ts) return "—";
    try {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
           + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch (_) { return "—"; }
  }

  function deepClone(o) {
    if (o == null) return o;
    try { return JSON.parse(JSON.stringify(o)); } catch (_) { return o; }
  }

  /* --------------------------------------------------------------------------
   * Node factories
   * ------------------------------------------------------------------------*/
  function makeFolder(name, opts) {
    const o = opts || {};
    return {
      id:        o.id || nextId(),
      name:      name,
      type:      KIND_FOLDER,
      children:  {},
      created:   o.created  || now(),
      modified:  o.modified || now(),
      accessed:  o.accessed || now(),
      readonly:  !!o.readonly,
      hidden:    !!o.hidden,
      perms:     o.perms != null ? o.perms : PERM_FULL,
      owner:     o.owner || "user",
      icon:      o.icon  || null,
      color:     o.color || null,
      tags:      o.tags  || [],
      meta:      o.meta  || {},
    };
  }

  function makeFile(name, content, opts) {
    const o = opts || {};
    const ext = extname(name);
    const info = EXT_MAP[ext] || null;
    return {
      id:        o.id || nextId(),
      name:      name,
      type:      KIND_FILE,
      content:   content == null ? "" : String(content),
      ext:       ext,
      mime:      o.mime || (info ? info.mime : "application/octet-stream"),
      kind:      o.kind || (info ? info.kind : "binary"),
      size:      utf8Bytes(content == null ? "" : String(content)),
      created:   o.created  || now(),
      modified:  o.modified || now(),
      accessed:  o.accessed || now(),
      readonly:  !!o.readonly,
      hidden:    !!o.hidden,
      perms:     o.perms != null ? o.perms : PERM_FULL,
      owner:     o.owner || "user",
      icon:      o.icon  || (info ? info.icon : "📄"),
      color:     o.color || (info ? info.color : "#9aa4b2"),
      tags:      o.tags  || [],
      meta:      o.meta  || {},
    };
  }

  /* --------------------------------------------------------------------------
   * Tree traversal
   * ------------------------------------------------------------------------*/
  function getRoot() {
    if (!state.tree) throw new FsError("EFAULT", "Filesystem not mounted");
    return state.tree;
  }

  /**
   * Resolve a path to its node. Returns null if not found.
   */
  function resolveNode(path) {
    const p = normalizePath(path);
    const root = getRoot();
    if (p === ROOT_PATH) return root;
    const parts = p.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      if (node.type !== KIND_FOLDER) return null;
      node = node.children[parts[i]];
      if (!node) return null;
    }
    return node;
  }

  function resolveParent(path) {
    return resolveNode(dirname(path));
  }

  /**
   * Walk all descendants, applying fn(node, fullPath).
   */
  function walk(startPath, fn, includeSelf) {
    const start = resolveNode(startPath);
    if (!start) return;
    const stack = [{ node: start, path: normalizePath(startPath) }];
    while (stack.length) {
      const { node, path } = stack.pop();
      if (includeSelf || path !== normalizePath(startPath)) {
        if (fn(node, path) === false) return;
      } else if (path === normalizePath(startPath) && includeSelf !== false) {
        if (fn(node, path) === false) return;
      }
      if (node.type === KIND_FOLDER) {
        const names = Object.keys(node.children);
        for (let i = names.length - 1; i >= 0; i--) {
          const child = node.children[names[i]];
          stack.push({ node: child, path: joinPath(path, child.name) });
        }
      }
    }
  }

  function isUnderSystem(path) {
    const p = normalizePath(path);
    return p === SYSTEM_PATH || p.startsWith(SYSTEM_PATH + "/");
  }

  function isReadOnlyChain(node, path) {
    // a node is effectively read-only if it itself or any ancestor is
    if (!node) return false;
    if (node.readonly) return true;
    let p = normalizePath(path);
    while (p !== ROOT_PATH) {
      p = dirname(p);
      const a = resolveNode(p);
      if (a && a.readonly) return true;
    }
    return false;
  }

  function ensureWritable(node, path) {
    if (isReadOnlyChain(node, path))
      throw new FsError("EROFS", "Read-only: " + path);
    if (!(node.perms & PERM_W))
      throw new FsError("EACCES", "Permission denied: " + path);
  }

  function ensureReadable(node, path) {
    if (!(node.perms & PERM_R))
      throw new FsError("EACCES", "Permission denied: " + path);
  }

  /* --------------------------------------------------------------------------
   * Persistence
   * ------------------------------------------------------------------------*/
  function persist(immediate) {
    if (immediate) {
      doPersist();
      return;
    }
    // coalesce successive writes into one localStorage call within 80ms
    if (state.persistTimer) {
      state.pendingPersist = true;
      return;
    }
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null;
      doPersist();
      if (state.pendingPersist) {
        state.pendingPersist = false;
        persist();
      }
    }, 80);
  }

  function doPersist() {
    try {
      const payload = {
        v:    SCHEMA_VERSION,
        ts:   now(),
        next: state.nextId,
        tree: state.tree,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("[FileSystem] persist failed:", e);
      // emit a non-fatal error event
      try {
        emit("error", { code: "EPERSIST", message: String(e && e.message || e) });
      } catch (_) {}
    }
    try {
      localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(state.recent));
    } catch (_) {}
  }

  /* --------------------------------------------------------------------------
   * Backend sync (best-effort, fire-and-forget)
   * -------------------------------------------------------------------------
   * Mirrors local FS mutations to the optional Flask backend.
   * Non-blocking — any failure is swallowed so a backend outage can never
   * break local FS operations.
   * ------------------------------------------------------------------------*/
  function _backendSyncFile(path, content, metadata) {
    if (!window.Backend || !window.Backend.isAuthenticated || !window.Backend.isAuthenticated()) return;
    try { window.Backend.fs.write(path, content, metadata).catch(() => {}); } catch (_) {}
  }
  function _backendDeleteFile(path) {
    if (!window.Backend || !window.Backend.isAuthenticated || !window.Backend.isAuthenticated()) return;
    try { window.Backend.fs.delete(path, true).catch(() => {}); } catch (_) {}
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return false;
      if (data.v !== SCHEMA_VERSION) {
        console.warn("[FileSystem] schema mismatch — rebuilding");
        return false;
      }
      if (!data.tree || data.tree.type !== KIND_FOLDER) return false;
      state.tree   = data.tree;
      state.nextId = data.next || (Date.now() % 100000);
    } catch (e) {
      console.error("[FileSystem] load failed:", e);
      return false;
    }
    try {
      const r = JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT) || "[]");
      if (Array.isArray(r)) state.recent = r.slice(0, RECENT_MAX);
    } catch (_) {}
    return true;
  }

  /* --------------------------------------------------------------------------
   * Events
   * ------------------------------------------------------------------------*/
  function emit(name, detail) {
    const fullName = name.indexOf(":") === -1 ? "fs:" + name : name;
    const payload  = Object.assign({ ts: now() }, detail || {});
    try {
      document.dispatchEvent(new CustomEvent(fullName, { detail: payload }));
    } catch (_) {}
    state.listeners.forEach((fn) => {
      try { fn(fullName, payload); } catch (e) { console.error("[FileSystem] listener error:", e); }
    });
  }

  function on(name, handler) {
    const evt = name.indexOf(":") === -1 ? "fs:" + name : name;
    document.addEventListener(evt, handler);
    return () => document.removeEventListener(evt, handler);
  }

  function subscribe(handler) {
    state.listeners.add(handler);
    return () => state.listeners.delete(handler);
  }

  /* --------------------------------------------------------------------------
   * Recent files tracking
   * ------------------------------------------------------------------------*/
  function pushRecent(path, action) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node || node.type !== KIND_FILE) return;
    state.recent = state.recent.filter((r) => r.path !== p);
    state.recent.unshift({
      path:   p,
      name:   node.name,
      icon:   node.icon,
      kind:   node.kind,
      ext:    node.ext,
      action: action || "open",
      ts:     now(),
    });
    if (state.recent.length > RECENT_MAX) state.recent.length = RECENT_MAX;
    persist();
    emit(EVENTS.RECENT, { recent: state.recent.slice() });
  }

  function getRecent(limit) {
    const n = limit == null ? 5 : Math.max(0, limit | 0);
    return state.recent.slice(0, n).map((r) => Object.assign({}, r));
  }

  function clearRecent() {
    state.recent = [];
    persist();
    emit(EVENTS.RECENT, { recent: [] });
  }

  function pruneRecent() {
    // remove entries that no longer resolve to a file (e.g. deleted)
    const before = state.recent.length;
    state.recent = state.recent.filter((r) => {
      const n = resolveNode(r.path);
      return n && n.type === KIND_FILE;
    });
    if (state.recent.length !== before) {
      persist();
      emit(EVENTS.RECENT, { recent: state.recent.slice() });
    }
  }

  /* --------------------------------------------------------------------------
   * Pre-population (default tree)
   * ------------------------------------------------------------------------*/
  function buildDefaultTree() {
    const root = makeFolder("", { id: "root_node", perms: PERM_FULL });
    root.name = ""; // root has empty name
    root.path = ROOT_PATH;

    function ensureDir(parent, name, opts) {
      if (parent.children[name]) return parent.children[name];
      const f = makeFolder(name, opts);
      parent.children[name] = f;
      return f;
    }
    function dropFile(parent, name, content, opts) {
      const f = makeFile(name, content, opts);
      parent.children[name] = f;
      return f;
    }

    // Top-level user folders
    const desktop  = ensureDir(root, "Desktop");
    const docs     = ensureDir(root, "Documents");
    const pics     = ensureDir(root, "Pictures");
    const music    = ensureDir(root, "Music");
    const dl       = ensureDir(root, "Downloads");
    const sysFolder= ensureDir(root, "System", { readonly: true, perms: PERM_RX });
    const trash    = ensureDir(root, "Trash",  { hidden: false, perms: PERM_FULL });

    // Documents — five real .txt files with substantial content
    dropFile(docs, "welcome.txt",
`Welcome to WebOS!
==================

Thank you for installing WebOS — a fully functional desktop operating
system that runs entirely inside your web browser. No servers, no
plugins, no installers. Everything you see is built from HTML, CSS,
and JavaScript, and every byte you create is stored locally in your
browser's localStorage.

Getting started
---------------

* Press the Start button on the taskbar (bottom-left) to browse all
  installed applications.
* Right-click on the desktop to change your wallpaper, switch themes,
  or create a new file.
* Drag windows around, resize from any edge, snap to halves and
  quarters, or maximize with F11.
* Use Alt+Tab to cycle between running windows.

Tips
----

1. Your data lives in this browser. Clearing site data will erase
   your filesystem — export anything important first.
2. Use the File Manager (Files icon on your desktop) to organize
   your documents, pictures and music exactly like a real OS.
3. The /System folder is read-only by design — it stores OS metadata
   that should never be modified by user apps.

Have fun exploring!
— The WebOS team
`);

    dropFile(docs, "shortcuts.txt",
`Keyboard Shortcuts
==================

Window management
-----------------
  Alt + Tab            Cycle between open windows
  Win + Up             Maximize active window
  Win + Down           Minimize active window
  Win + Left           Snap left half
  Win + Right          Snap right half
  F11                  Toggle maximize
  Ctrl + W             Close active window

File manager
------------
  Ctrl + Shift + N     New folder
  F2                   Rename selected
  Delete               Move to Trash
  Ctrl + C / X / V     Copy / Cut / Paste
  Ctrl + A             Select all
  Backspace            Go up one folder
  Alt + Left / Right   Back / Forward in history

Desktop
-------
  F5                   Refresh desktop
  Ctrl + A             Select all icons
  Right click          Open desktop menu

Misc
----
  Ctrl + Shift + T     Cycle theme
  Esc                  Close menus / cancel rename
`);

    dropFile(docs, "todo.txt",
`To-do List
==========

[x] Boot WebOS for the first time
[x] Pick a theme that doesn't hurt my eyes at 2am
[x] Make a folder called "Important" and never put anything in it
[ ] Rename "New Folder" to literally anything else
[ ] Try out the calculator
[ ] Empty the trash, then immediately regret it
[ ] Write a poem in Notepad
[ ] Discover at least three keyboard shortcuts I'll forget tomorrow
[ ] Show this OS to a friend and watch them resize the window
    seventeen times in a row
[ ] Add another item to this list before deleting one above

Notes
-----

* Pressing Ctrl+Shift+T cycles themes — surprisingly addictive.
* The clock in the taskbar updates every second. Yes, every second.
* If you find a bug, congratulations — you are now part of QA.
`);

    dropFile(docs, "readme.md",
`# README

This is a sample Markdown file shipped with WebOS.

WebOS demonstrates that a complete desktop environment — windowing
system, taskbar, start menu, virtual filesystem, file manager,
theming, notifications and all — can be implemented entirely in a
modern web browser.

## Features

- 🪟 Window manager with drag, 8-way resize, snap, and Alt+Tab
- 📁 Hierarchical virtual filesystem stored in localStorage
- 🗂 Real file manager with grid/list views and clipboard ops
- 🎨 Five built-in themes and five wallpapers
- ⚡ No dependencies, no build step, no server required

## License

You can do whatever you want with this code, but please be kind
to your users.
`);

    dropFile(docs, "notes.txt",
`Random Notes
============

- The colour of fresh snow at sunrise is, technically, lavender.
- A web browser today is, in many ways, more capable than the
  entire operating systems we shipped on CDs in the late 90s.
- "Programming is the art of telling another human what one wants
  the computer to do." — Donald Knuth
- Backups are like flossing: nobody does it as often as they
  should, and everyone regrets it eventually.
- If a function is hard to name, it is probably doing too much.

Quick links to add later:
  * /Documents/welcome.txt
  * /Documents/shortcuts.txt
  * /Documents/todo.txt
`);

    // Pictures — empty by default but with one tiny demo SVG
    dropFile(pics, "sample.svg",
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#06b6d4"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="24" fill="url(#g)"/>
  <text x="100" y="112" font-family="Inter,system-ui" font-size="24"
        font-weight="700" text-anchor="middle" fill="white">WebOS</text>
</svg>
`);

    // Music — empty playlist file
    dropFile(music, "playlist.txt",
`# WebOS sample playlist
#
# Drop your favourite track titles below — one per line.
#
1. Aurora Skies — Synthwave
2. Pixel Dreams — Chiptune
3. Midnight City — Dream Pop
`);

    // Downloads — installer log
    dropFile(dl, "install.log",
`[INFO]  WebOS bootstrap started
[INFO]  Mounting /
[INFO]  Mounting /System  (ro)
[INFO]  Loading display server
[INFO]  Compositing window manager
[INFO]  Starting clock service
[OK]    Boot complete in 2.4s
`);

    // System — read-only configs
    dropFile(sysFolder, "version.txt",
`WebOS 1.0.0 "Aurora"
Build: ${formatDate(now())}
Channel: stable
Codename: aurora
Kernel: webos-1.0.0
`, { readonly: true, perms: PERM_R_ });

    dropFile(sysFolder, "config.json",
JSON.stringify({
  hostname:  "webos-local",
  release:   "1.0.0",
  codename:  "Aurora",
  schema:    SCHEMA_VERSION,
  features: {
    windowManager: true,
    filesystem:    true,
    fileManager:   true,
    notifications: true,
    themes:        ["dark","light","cyberpunk","retro","forest"],
  },
}, null, 2),
    { readonly: true, perms: PERM_R_ });

    dropFile(sysFolder, "kernel.log",
`[boot] kernel started
[boot] vfs mounted at /
[boot] schema v${SCHEMA_VERSION}
[boot] system folder protected (ro)
[boot] ready
`, { readonly: true, perms: PERM_R_ });

    return root;
  }

  /* --------------------------------------------------------------------------
   * Mount / unmount
   * ------------------------------------------------------------------------*/
  function mount() {
    if (state.initialized) return;
    state.initialized = true;
    if (!load()) {
      state.tree = buildDefaultTree();
      persist(true);
    } else {
      // Ensure mandatory top-level folders still exist (in case user nuked them)
      const root = state.tree;
      const required = ["Desktop", "Documents", "Pictures", "Music", "Downloads", "Trash"];
      for (const name of required) {
        if (!root.children[name]) root.children[name] = makeFolder(name);
      }
      // System always read-only
      if (!root.children["System"]) {
        root.children["System"] = makeFolder("System", { readonly: true, perms: PERM_RX });
      } else {
        root.children["System"].readonly = true;
        root.children["System"].perms    = PERM_RX;
      }
      pruneRecent();
      persist(true);
    }
    emit(EVENTS.MOUNT, { mountedAt: ROOT_PATH });
    emit(EVENTS.READY, {});
    console.log("%c[WebOS]%c FileSystem mounted (root: " + ROOT_PATH + ")",
      "color:#10b981;font-weight:bold", "color:inherit");
  }

  function reset() {
    state.tree   = buildDefaultTree();
    state.nextId = 1;
    state.recent = [];
    persist(true);
    emit(EVENTS.CHANGE, { reason: "reset" });
  }

  /**
   * Re-load the in-memory tree from localStorage without a full page reload.
   * Called by backendSync after it writes a fresh snapshot to localStorage
   * so the virtual FS picks up server-side files immediately after login.
   */
  function reload() {
    if (!load()) {
      state.tree = buildDefaultTree();
      persist(true);
    } else {
      // Ensure mandatory top-level folders still exist after snapshot restore.
      const root = state.tree;
      const required = ["Desktop", "Documents", "Pictures", "Music", "Downloads", "Trash"];
      for (const name of required) {
        if (!root.children[name]) root.children[name] = makeFolder(name);
      }
      if (!root.children["System"]) {
        root.children["System"] = makeFolder("System", { readonly: true, perms: PERM_RX });
      } else {
        root.children["System"].readonly = true;
        root.children["System"].perms    = PERM_RX;
      }
      pruneRecent();
      persist(true);
    }
    emit(EVENTS.CHANGE, { reason: "reload" });
    emit(EVENTS.READY,  {});
  }

  function format() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { localStorage.removeItem(STORAGE_KEY_RECENT); } catch (_) {}
    state.tree   = null;
    state.recent = [];
    state.initialized = false;
    mount();
    emit(EVENTS.CHANGE, { reason: "format" });
  }

  /* --------------------------------------------------------------------------
   * Public — existence / queries
   * ------------------------------------------------------------------------*/
  function exists(path) {
    try { return !!resolveNode(path); }
    catch (_) { return false; }
  }

  function isFile(path) {
    const n = resolveNode(path);
    return !!(n && n.type === KIND_FILE);
  }

  function isFolder(path) {
    const n = resolveNode(path);
    return !!(n && n.type === KIND_FOLDER);
  }

  function getMetadata(path) {
    const node = resolveNode(path);
    if (!node) throw new FsError("ENOENT", "No such file or directory: " + path);
    const p = normalizePath(path);
    return {
      path:     p,
      name:     node.name,
      type:     node.type,
      kind:     node.type === KIND_FILE ? node.kind : FOLDER_VISUAL.kind,
      ext:      node.ext || "",
      mime:     node.mime || (node.type === KIND_FILE ? "application/octet-stream" : FOLDER_VISUAL.mime),
      size:     node.type === KIND_FILE ? (node.size || 0) : computeFolderSize(node),
      created:  node.created,
      modified: node.modified,
      accessed: node.accessed,
      readonly: !!node.readonly || isReadOnlyChain(node, p),
      hidden:   !!node.hidden,
      perms:    node.perms,
      owner:    node.owner,
      icon:     node.icon || (node.type === KIND_FOLDER ? FOLDER_VISUAL.icon : "📄"),
      color:    node.color || (node.type === KIND_FOLDER ? FOLDER_VISUAL.color : "#9aa4b2"),
      tags:     (node.tags || []).slice(),
      meta:     deepClone(node.meta || {}),
      childCount: node.type === KIND_FOLDER ? Object.keys(node.children).length : 0,
    };
  }

  // alias compatible with POSIX intuition
  function stat(path) { return getMetadata(path); }

  function computeFolderSize(folder) {
    if (!folder || folder.type !== KIND_FOLDER) return 0;
    let total = 0;
    const stack = [folder];
    while (stack.length) {
      const n = stack.pop();
      const names = Object.keys(n.children);
      for (let i = 0; i < names.length; i++) {
        const c = n.children[names[i]];
        if (c.type === KIND_FILE) total += (c.size || 0);
        else stack.push(c);
      }
    }
    return total;
  }

  function getSize(path) {
    const md = getMetadata(path);
    return md.size;
  }

  function listDir(path, opts) {
    const o = opts || {};
    const node = resolveNode(path);
    if (!node) throw new FsError("ENOENT", "No such directory: " + path);
    if (node.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a directory: " + path);
    ensureReadable(node, path);
    node.accessed = now();
    const entries = [];
    const names = Object.keys(node.children);
    const showHidden = !!o.showHidden;
    for (let i = 0; i < names.length; i++) {
      const c = node.children[names[i]];
      if (!showHidden && c.hidden) continue;
      const childPath = joinPath(path, c.name);
      entries.push({
        path:     childPath,
        name:     c.name,
        type:     c.type,
        kind:     c.type === KIND_FILE ? c.kind : FOLDER_VISUAL.kind,
        ext:      c.ext || "",
        mime:     c.mime || (c.type === KIND_FOLDER ? FOLDER_VISUAL.mime : "application/octet-stream"),
        size:     c.type === KIND_FILE ? (c.size || 0) : (o.computeFolderSize ? computeFolderSize(c) : 0),
        created:  c.created,
        modified: c.modified,
        accessed: c.accessed,
        readonly: !!c.readonly || isReadOnlyChain(c, childPath),
        hidden:   !!c.hidden,
        perms:    c.perms,
        icon:     c.icon || (c.type === KIND_FOLDER ? FOLDER_VISUAL.icon : "📄"),
        color:    c.color || (c.type === KIND_FOLDER ? FOLDER_VISUAL.color : "#9aa4b2"),
        tags:     (c.tags || []).slice(),
        childCount: c.type === KIND_FOLDER ? Object.keys(c.children).length : 0,
      });
    }
    // optional sort
    if (o.sortBy) sortEntries(entries, o.sortBy, o.sortDir);
    return entries;
  }

  function sortEntries(entries, sortBy, sortDir) {
    const dir = (sortDir === "desc") ? -1 : 1;
    const cmp = (() => {
      switch (sortBy) {
        case "size":     return (a, b) => (a.size - b.size) * dir;
        case "modified": return (a, b) => (a.modified - b.modified) * dir;
        case "created":  return (a, b) => (a.created  - b.created)  * dir;
        case "type":     return (a, b) => {
          const k = (a.kind || "").localeCompare(b.kind || "");
          return k !== 0 ? k * dir : a.name.localeCompare(b.name) * dir;
        };
        case "ext":      return (a, b) => {
          const e = (a.ext || "").localeCompare(b.ext || "");
          return e !== 0 ? e * dir : a.name.localeCompare(b.name) * dir;
        };
        case "name":
        default:         return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) * dir;
      }
    })();
    // folders first then files (typical OS behavior) — toggleable via sortDir? keep stable
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === KIND_FOLDER ? -1 : 1;
      }
      return cmp(a, b);
    });
    return entries;
  }

  /* --------------------------------------------------------------------------
   * Public — file I/O
   * ------------------------------------------------------------------------*/
  function readFile(path, opts) {
    const o = opts || {};
    const node = resolveNode(path);
    if (!node) throw new FsError("ENOENT", "No such file: " + path);
    if (node.type !== KIND_FILE) throw new FsError("EISDIR", "Is a directory: " + path);
    ensureReadable(node, path);
    node.accessed = now();
    if (!o.noRecent) pushRecent(path, "read");
    emit(EVENTS.READ, { path: normalizePath(path) });
    return node.content == null ? "" : String(node.content);
  }

  function writeFile(path, content, opts) {
    const o    = opts || {};
    const p    = normalizePath(path);
    const dir  = dirname(p);
    const name = basename(p);
    validateName(name);
    const parent = resolveNode(dir);
    if (!parent) throw new FsError("ENOENT", "Directory not found: " + dir);
    if (parent.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a directory: " + dir);
    ensureWritable(parent, dir);

    const text = content == null ? "" : String(content);
    let node = parent.children[name];

    if (node && node.type === KIND_FOLDER)
      throw new FsError("EISDIR", "Is a directory: " + p);
    if (node && o.exclusive)
      throw new FsError("EEXIST", "File exists: " + p);

    if (!node) {
      node = makeFile(name, text, o);
      parent.children[name] = node;
      parent.modified = now();
      persist();
      _backendSyncFile(p, text, { mime: node.mime, kind: node.kind, icon: node.icon, color: node.color });
      if (!o.noRecent) pushRecent(p, "create");
      emit(EVENTS.CREATE, { path: p, type: KIND_FILE });
      emit(EVENTS.WRITE,  { path: p, size: node.size });
      emit(EVENTS.CHANGE, { path: p, reason: "create" });
      return getMetadata(p);
    }

    if (isReadOnlyChain(node, p) || !(node.perms & PERM_W))
      throw new FsError("EROFS", "Read-only: " + p);

    node.content  = text;
    node.size     = utf8Bytes(text);
    node.modified = now();
    node.accessed = now();
    if (o.mime)  node.mime  = o.mime;
    if (o.kind)  node.kind  = o.kind;
    if (o.icon)  node.icon  = o.icon;
    if (o.color) node.color = o.color;
    persist();
    _backendSyncFile(p, text, { mime: node.mime, kind: node.kind, icon: node.icon, color: node.color });
    if (!o.noRecent) pushRecent(p, "write");
    emit(EVENTS.WRITE,  { path: p, size: node.size });
    emit(EVENTS.CHANGE, { path: p, reason: "write" });
    return getMetadata(p);
  }

  function appendFile(path, content) {
    const p = normalizePath(path);
    const existing = exists(p) ? readFile(p, { noRecent: true }) : "";
    return writeFile(p, existing + (content == null ? "" : String(content)));
  }

  function touch(path) {
    const p = normalizePath(path);
    if (exists(p)) {
      const node = resolveNode(p);
      ensureWritable(node, p);
      node.modified = now();
      node.accessed = now();
      persist();
      emit(EVENTS.CHANGE, { path: p, reason: "touch" });
      return getMetadata(p);
    }
    return writeFile(p, "");
  }

  /* --------------------------------------------------------------------------
   * Public — folders
   * ------------------------------------------------------------------------*/
  function createFolder(path, opts) {
    const o    = opts || {};
    const p    = normalizePath(path);
    if (p === ROOT_PATH) throw new FsError("EEXIST", "Root already exists");
    const dir  = dirname(p);
    const name = basename(p);
    validateName(name);

    // recursive parent creation
    if (o.recursive) {
      const segs = dir.split("/").filter(Boolean);
      let cur = "";
      for (const s of segs) {
        cur += "/" + s;
        if (!exists(cur)) createFolder(cur, { recursive: false });
      }
    }

    const parent = resolveNode(dir);
    if (!parent) throw new FsError("ENOENT", "Parent not found: " + dir);
    if (parent.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a directory: " + dir);
    ensureWritable(parent, dir);

    if (parent.children[name]) {
      if (o.idempotent && parent.children[name].type === KIND_FOLDER) {
        return getMetadata(p);
      }
      throw new FsError("EEXIST", "Already exists: " + p);
    }

    const folder = makeFolder(name, o);
    parent.children[name] = folder;
    parent.modified = now();
    persist();
    emit(EVENTS.CREATE, { path: p, type: KIND_FOLDER });
    emit(EVENTS.CHANGE, { path: p, reason: "createFolder" });
    return getMetadata(p);
  }

  function mkdirp(path) { return createFolder(path, { recursive: true, idempotent: true }); }

  function ensureFolder(path) {
    return exists(path) && isFolder(path)
      ? getMetadata(path)
      : createFolder(path, { recursive: true, idempotent: true });
  }

  /* --------------------------------------------------------------------------
   * Public — delete / trash / restore
   * ------------------------------------------------------------------------*/
  /**
   * Delete a path. By default moves to /Trash. Pass {permanent:true} to purge.
   */
  function deleteFile(path, opts) {
    const o = opts || {};
    const p = normalizePath(path);
    if (p === ROOT_PATH || p === TRASH_PATH || p === SYSTEM_PATH)
      throw new FsError("EPERM", "Cannot delete protected path: " + p);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);

    const parent = resolveParent(p);
    if (!parent) throw new FsError("ENOENT", "Parent not found");
    ensureWritable(parent, dirname(p));
    if (isReadOnlyChain(node, p))
      throw new FsError("EROFS", "Read-only: " + p);

    if (o.permanent || isAncestor(TRASH_PATH, p)) {
      // permanent removal
      delete parent.children[node.name];
      parent.modified = now();
      pruneRecent();
      persist();
      _backendDeleteFile(p);
      emit(EVENTS.DELETE, { path: p, type: node.type, permanent: true });
      emit(EVENTS.CHANGE, { path: p, reason: "delete" });
      return true;
    }

    return moveToTrash(p);
  }

  // alias
  function remove(path, opts) { return deleteFile(path, opts); }

  function moveToTrash(path) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    if (isAncestor(TRASH_PATH, p))
      throw new FsError("EINVAL", "Already in trash");
    if (isAncestor(SYSTEM_PATH, p) || isReadOnlyChain(node, p))
      throw new FsError("EROFS", "Cannot trash read-only: " + p);

    const trash = resolveNode(TRASH_PATH);
    if (!trash) throw new FsError("ENOENT", "Trash missing");
    let target = node.name;
    if (trash.children[target]) {
      // collision — disambiguate
      target = uniquifyName(trash, node.name);
    }
    const parent = resolveParent(p);
    delete parent.children[node.name];
    node.name = target;
    node.meta = node.meta || {};
    node.meta.originalPath = p;
    node.meta.trashedAt    = now();
    trash.children[target] = node;
    parent.modified = now();
    trash.modified  = now();
    pruneRecent();
    persist();
    emit(EVENTS.TRASH,  { from: p, to: joinPath(TRASH_PATH, target) });
    emit(EVENTS.CHANGE, { path: p, reason: "trash" });
    return joinPath(TRASH_PATH, target);
  }

  function restoreFromTrash(trashPath) {
    const p = normalizePath(trashPath);
    if (!isAncestor(TRASH_PATH, p) || p === TRASH_PATH)
      throw new FsError("EINVAL", "Not in trash: " + p);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    const original = node.meta && node.meta.originalPath;
    let dest = original || joinPath("/Documents", node.name);
    let destParent = dirname(dest);
    if (!exists(destParent)) {
      // original parent is gone — fall back to /Documents
      dest = joinPath("/Documents", node.name);
      destParent = "/Documents";
    }
    if (exists(dest)) {
      dest = joinPath(destParent, uniquifyName(resolveNode(destParent), node.name));
    }
    const trash = resolveNode(TRASH_PATH);
    delete trash.children[node.name];
    node.name = basename(dest);
    if (node.meta) {
      delete node.meta.originalPath;
      delete node.meta.trashedAt;
    }
    const parent = resolveNode(destParent);
    parent.children[node.name] = node;
    trash.modified  = now();
    parent.modified = now();
    persist();
    emit(EVENTS.RESTORE, { from: p, to: dest });
    emit(EVENTS.CHANGE,  { path: dest, reason: "restore" });
    return dest;
  }

  function emptyTrash() {
    const trash = resolveNode(TRASH_PATH);
    if (!trash) return 0;
    const count = Object.keys(trash.children).length;
    trash.children = {};
    trash.modified = now();
    pruneRecent();
    persist();
    emit(EVENTS.EMPTY,  { count });
    emit(EVENTS.CHANGE, { path: TRASH_PATH, reason: "empty" });
    return count;
  }

  function listTrash() {
    return listDir(TRASH_PATH, { showHidden: true });
  }

  /* --------------------------------------------------------------------------
   * Public — move / rename / copy
   * ------------------------------------------------------------------------*/
  function uniquifyName(parent, name) {
    if (!parent.children[name]) return name;
    const { stem, ext } = splitName(name);
    let i = 1;
    while (true) {
      const candidate = ext ? (stem + " (" + i + ")." + ext) : (stem + " (" + i + ")");
      if (!parent.children[candidate]) return candidate;
      i++;
      if (i > 10000) throw new FsError("EAGAIN", "Could not generate unique name");
    }
  }

  function moveFile(src, dst, opts) {
    const o    = opts || {};
    const sp   = normalizePath(src);
    const dp   = normalizePath(dst);
    if (sp === ROOT_PATH || sp === SYSTEM_PATH)
      throw new FsError("EPERM", "Cannot move protected path: " + sp);
    if (sp === dp) return getMetadata(dp);
    if (isAncestor(sp, dp))
      throw new FsError("EINVAL", "Cannot move into own descendant");

    const node = resolveNode(sp);
    if (!node) throw new FsError("ENOENT", "No such path: " + sp);
    if (isReadOnlyChain(node, sp))
      throw new FsError("EROFS", "Source read-only: " + sp);

    const srcParent = resolveParent(sp);
    if (!srcParent) throw new FsError("ENOENT", "Source parent missing");
    ensureWritable(srcParent, dirname(sp));

    // Determine destination — if dst is a folder, place node inside it
    let destParentPath = dirname(dp);
    let destName       = basename(dp);
    const dpNode       = resolveNode(dp);
    if (dpNode && dpNode.type === KIND_FOLDER) {
      destParentPath = dp;
      destName       = node.name;
    }

    const destParent = resolveNode(destParentPath);
    if (!destParent) throw new FsError("ENOENT", "Destination parent missing: " + destParentPath);
    if (destParent.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a directory: " + destParentPath);
    ensureWritable(destParent, destParentPath);

    validateName(destName);

    if (destParent.children[destName]) {
      if (o.overwrite) {
        if (destParent.children[destName].type === KIND_FOLDER && o.overwrite !== "force") {
          throw new FsError("EISDIR", "Refusing to overwrite folder: " + joinPath(destParentPath, destName));
        }
        delete destParent.children[destName];
      } else if (o.uniquify) {
        destName = uniquifyName(destParent, destName);
      } else {
        throw new FsError("EEXIST", "Already exists: " + joinPath(destParentPath, destName));
      }
    }

    delete srcParent.children[node.name];
    node.name = destName;
    node.modified = now();
    destParent.children[destName] = node;
    srcParent.modified  = now();
    destParent.modified = now();

    const finalPath = joinPath(destParentPath, destName);
    pruneRecent();
    persist();
    emit(EVENTS.MOVE,   { from: sp, to: finalPath });
    emit(EVENTS.CHANGE, { path: finalPath, reason: "move" });
    return getMetadata(finalPath);
  }

  function rename(path, newName) {
    const p = normalizePath(path);
    if (p === ROOT_PATH) throw new FsError("EPERM", "Cannot rename root");
    validateName(newName);
    const dir = dirname(p);
    const dest = joinPath(dir, newName);
    if (dest === p) return getMetadata(p);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    if (isReadOnlyChain(node, p))
      throw new FsError("EROFS", "Read-only: " + p);
    const parent = resolveParent(p);
    if (parent.children[newName])
      throw new FsError("EEXIST", "Already exists: " + dest);
    delete parent.children[node.name];
    node.name = newName;
    node.modified = now();
    parent.children[newName] = node;
    parent.modified = now();
    pruneRecent();
    persist();
    emit(EVENTS.RENAME, { from: p, to: dest });
    emit(EVENTS.CHANGE, { path: dest, reason: "rename" });
    return getMetadata(dest);
  }

  function cloneNode(node) {
    if (node.type === KIND_FILE) {
      return makeFile(node.name, node.content, {
        mime: node.mime, kind: node.kind, icon: node.icon, color: node.color,
        readonly: false, hidden: node.hidden, perms: PERM_FULL, owner: node.owner,
        tags: (node.tags || []).slice(), meta: deepClone(node.meta || {}),
      });
    }
    const copy = makeFolder(node.name, {
      readonly: false, hidden: node.hidden, perms: PERM_FULL, owner: node.owner,
      icon: node.icon, color: node.color,
      tags: (node.tags || []).slice(), meta: deepClone(node.meta || {}),
    });
    const names = Object.keys(node.children);
    for (let i = 0; i < names.length; i++) {
      const child = cloneNode(node.children[names[i]]);
      copy.children[child.name] = child;
    }
    return copy;
  }

  function copyFile(src, dst, opts) {
    const o   = opts || {};
    const sp  = normalizePath(src);
    const dp  = normalizePath(dst);
    if (isAncestor(sp, dp))
      throw new FsError("EINVAL", "Cannot copy into own descendant");

    const node = resolveNode(sp);
    if (!node) throw new FsError("ENOENT", "No such path: " + sp);
    ensureReadable(node, sp);

    let destParentPath = dirname(dp);
    let destName       = basename(dp);
    const dpNode       = resolveNode(dp);
    if (dpNode && dpNode.type === KIND_FOLDER) {
      destParentPath = dp;
      destName       = node.name;
    }
    const destParent = resolveNode(destParentPath);
    if (!destParent) throw new FsError("ENOENT", "Destination parent missing: " + destParentPath);
    if (destParent.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a directory: " + destParentPath);
    ensureWritable(destParent, destParentPath);

    validateName(destName);

    if (destParent.children[destName]) {
      if (o.overwrite) {
        delete destParent.children[destName];
      } else if (o.uniquify) {
        destName = uniquifyName(destParent, destName);
      } else {
        throw new FsError("EEXIST", "Already exists: " + joinPath(destParentPath, destName));
      }
    }

    const copy = cloneNode(node);
    copy.name  = destName;
    copy.created  = now();
    copy.modified = now();
    destParent.children[destName] = copy;
    destParent.modified = now();
    persist();
    const finalPath = joinPath(destParentPath, destName);
    emit(EVENTS.CREATE, { path: finalPath, type: copy.type, copyOf: sp });
    emit(EVENTS.CHANGE, { path: finalPath, reason: "copy" });
    return getMetadata(finalPath);
  }

  function duplicate(path) {
    const p = normalizePath(path);
    const parent = resolveParent(p);
    const name = basename(p);
    const dup = uniquifyName(parent, name);
    return copyFile(p, joinPath(dirname(p), dup));
  }

  /* --------------------------------------------------------------------------
   * Public — search
   * ------------------------------------------------------------------------*/
  function searchFiles(query, opts) {
    const o = opts || {};
    const root      = normalizePath(o.root || ROOT_PATH);
    const limit     = o.limit == null ? 200 : (o.limit | 0);
    const showHidden= !!o.showHidden;
    const matchExt  = o.ext ? String(o.ext).toLowerCase() : null;
    const kindOnly  = o.kind || null;
    const inContent = !!o.inContent;
    const caseSens  = !!o.caseSensitive;
    const regex     = o.regex ? new RegExp(query, caseSens ? "" : "i") : null;
    const q         = caseSens ? String(query || "") : String(query || "").toLowerCase();
    const results   = [];

    walk(root, (node, p) => {
      if (results.length >= limit) return false;
      if (!showHidden && node.hidden) return;
      const name = caseSens ? node.name : node.name.toLowerCase();
      let nameHit = false;
      if (regex) nameHit = regex.test(node.name);
      else if (q.length === 0) nameHit = true;
      else nameHit = name.indexOf(q) !== -1;

      let contentHit = false;
      if (inContent && node.type === KIND_FILE && node.content) {
        const c = caseSens ? node.content : node.content.toLowerCase();
        if (regex) contentHit = regex.test(node.content);
        else if (q.length) contentHit = c.indexOf(q) !== -1;
      }

      if (!(nameHit || contentHit)) return;
      if (matchExt && (node.type !== KIND_FILE || node.ext !== matchExt)) return;
      if (kindOnly && node.type === KIND_FILE && node.kind !== kindOnly) return;
      if (kindOnly === KIND_FOLDER && node.type !== KIND_FOLDER) return;

      results.push({
        path:     p,
        name:     node.name,
        type:     node.type,
        kind:     node.type === KIND_FILE ? node.kind : FOLDER_VISUAL.kind,
        size:     node.type === KIND_FILE ? (node.size || 0) : 0,
        modified: node.modified,
        ext:      node.ext || "",
        icon:     node.icon || (node.type === KIND_FOLDER ? FOLDER_VISUAL.icon : "📄"),
        color:    node.color || (node.type === KIND_FOLDER ? FOLDER_VISUAL.color : "#9aa4b2"),
        nameHit:  nameHit,
        contentHit: contentHit,
      });
    }, true);

    return results;
  }

  /* --------------------------------------------------------------------------
   * Public — permissions
   * ------------------------------------------------------------------------*/
  function chmod(path, perms) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    if (isUnderSystem(p))
      throw new FsError("EROFS", "Cannot chmod under /System");
    const m = perms | 0;
    if (m < 0 || m > 7)
      throw new FsError("EINVAL", "Invalid perm bits: " + perms);
    node.perms = m;
    node.modified = now();
    persist();
    emit(EVENTS.CHANGE, { path: p, reason: "chmod", perms: m });
    return getMetadata(p);
  }

  function setReadOnly(path, ro) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    if (isUnderSystem(p))
      throw new FsError("EROFS", "Cannot toggle /System read-only");
    node.readonly = !!ro;
    node.modified = now();
    persist();
    emit(EVENTS.CHANGE, { path: p, reason: "readonly", readonly: !!ro });
    return getMetadata(p);
  }

  function setHidden(path, hidden) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    node.hidden = !!hidden;
    node.modified = now();
    persist();
    emit(EVENTS.CHANGE, { path: p, reason: "hidden", hidden: !!hidden });
    return getMetadata(p);
  }

  function setIcon(path, icon, color) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    if (icon != null)  node.icon  = String(icon);
    if (color != null) node.color = String(color);
    node.modified = now();
    persist();
    emit(EVENTS.CHANGE, { path: p, reason: "icon" });
    return getMetadata(p);
  }

  function setTags(path, tags) {
    const p = normalizePath(path);
    const node = resolveNode(p);
    if (!node) throw new FsError("ENOENT", "No such path: " + p);
    node.tags = Array.isArray(tags) ? tags.slice(0, 32).map(String) : [];
    node.modified = now();
    persist();
    emit(EVENTS.CHANGE, { path: p, reason: "tags" });
    return getMetadata(p);
  }

  /* --------------------------------------------------------------------------
   * Public — bulk / utility
   * ------------------------------------------------------------------------*/
  function tree(path, opts) {
    const o = opts || {};
    const start = resolveNode(path || ROOT_PATH);
    if (!start) throw new FsError("ENOENT", "No such path: " + path);
    const startPath = normalizePath(path || ROOT_PATH);
    const showHidden = !!o.showHidden;
    const maxDepth   = o.maxDepth == null ? Infinity : (o.maxDepth | 0);

    function visit(node, p, depth) {
      const out = {
        path:    p,
        name:    node.name,
        type:    node.type,
        size:    node.type === KIND_FILE ? (node.size || 0) : 0,
        icon:    node.icon || (node.type === KIND_FOLDER ? FOLDER_VISUAL.icon : "📄"),
        modified: node.modified,
        children: undefined,
      };
      if (node.type === KIND_FOLDER && depth < maxDepth) {
        out.children = [];
        const names = Object.keys(node.children).sort((a, b) => a.localeCompare(b));
        for (const n of names) {
          const c = node.children[n];
          if (!showHidden && c.hidden) continue;
          out.children.push(visit(c, joinPath(p, c.name), depth + 1));
        }
      }
      return out;
    }
    return visit(start, startPath, 0);
  }

  function diskUsage() {
    let totalFiles   = 0;
    let totalFolders = 0;
    let totalSize    = 0;
    walk(ROOT_PATH, (node) => {
      if (node.type === KIND_FILE) {
        totalFiles++;
        totalSize += node.size || 0;
      } else if (node.type === KIND_FOLDER) {
        totalFolders++;
      }
    }, true);
    let raw = 0;
    try { raw = (localStorage.getItem(STORAGE_KEY) || "").length; } catch (_) {}
    return {
      files:    totalFiles,
      folders:  totalFolders - 1, // exclude root
      bytes:    totalSize,
      pretty:   formatBytes(totalSize),
      storage:  raw,
      storagePretty: formatBytes(raw),
    };
  }

  function exportSnapshot() {
    return JSON.stringify({
      v:    SCHEMA_VERSION,
      ts:   now(),
      next: state.nextId,
      tree: state.tree,
    }, null, 2);
  }

  function importSnapshot(json, opts) {
    const o = opts || {};
    if (!json) throw new FsError("EINVAL", "No data");
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new FsError("EINVAL", "Bad JSON: " + e.message); }
    if (!parsed || parsed.v !== SCHEMA_VERSION)
      throw new FsError("EINVAL", "Schema mismatch");
    if (!parsed.tree || parsed.tree.type !== KIND_FOLDER)
      throw new FsError("EINVAL", "Bad tree");
    state.tree   = parsed.tree;
    state.nextId = parsed.next || state.nextId;
    if (o.clearRecent !== false) state.recent = [];
    persist(true);
    emit(EVENTS.CHANGE, { reason: "import" });
    return diskUsage();
  }

  /* --------------------------------------------------------------------------
   * Public — convenience
   * ------------------------------------------------------------------------*/
  function readJSON(path) {
    const t = readFile(path);
    try { return JSON.parse(t); }
    catch (e) { throw new FsError("EBADF", "Invalid JSON in " + path); }
  }

  function writeJSON(path, value, opts) {
    const o = opts || {};
    const text = JSON.stringify(value, null, o.indent == null ? 2 : o.indent);
    return writeFile(path, text, Object.assign({ mime: "application/json", kind: "text" }, o));
  }

  function fileInfoFromName(name) {
    const ext = extname(name);
    const info = EXT_MAP[ext] || null;
    return {
      ext,
      mime: info ? info.mime : "application/octet-stream",
      kind: info ? info.kind : "binary",
      icon: info ? info.icon : "📄",
      color: info ? info.color : "#9aa4b2",
    };
  }

  function getExtensionMap() {
    // Return a frozen-shallow copy so consumers can't mutate it
    const out = {};
    Object.keys(EXT_MAP).forEach((k) => out[k] = Object.assign({}, EXT_MAP[k]));
    return out;
  }

  /* --------------------------------------------------------------------------
   * Path helpers exposed publicly (useful for the file manager)
   * ------------------------------------------------------------------------*/
  function pathParts(path) {
    const p = normalizePath(path);
    if (p === ROOT_PATH) return [];
    return p.split("/").filter(Boolean);
  }

  function breadcrumbs(path) {
    const parts = pathParts(path);
    const out = [{ name: "Root", path: ROOT_PATH }];
    let acc = "";
    for (const seg of parts) {
      acc += "/" + seg;
      out.push({ name: seg, path: acc });
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * Clipboard (filesystem-internal cut/copy/paste)
   * --------------------------------------------------------------------------
   * The File Manager wires Ctrl+C / Ctrl+X / Ctrl+V into these helpers so that
   * cut / copy / paste survive across folders and even across reloads (we keep
   * a soft-persisted record of the last clipboard so reopening continues to
   * work). "cut" removes the source on paste; "copy" leaves it intact.
   * ------------------------------------------------------------------------*/
  const CLIP_KEY = "webos.fs.clipboard";
  const clipboard = {
    op:    null,    // "copy" | "cut" | null
    paths: [],      // array of normalized paths
    ts:    0,
  };

  function loadClipboard() {
    try {
      const raw = localStorage.getItem(CLIP_KEY);
      if (!raw) return;
      const v = JSON.parse(raw);
      if (v && (v.op === "copy" || v.op === "cut") && Array.isArray(v.paths)) {
        clipboard.op    = v.op;
        clipboard.paths = v.paths.slice();
        clipboard.ts    = v.ts || 0;
      }
    } catch (_) {}
  }
  function saveClipboard() {
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard)); }
    catch (_) {}
  }
  function clearClipboard() {
    clipboard.op = null;
    clipboard.paths = [];
    clipboard.ts = 0;
    try { localStorage.removeItem(CLIP_KEY); } catch (_) {}
    emit("clipboard", { op: null, paths: [] });
  }
  function copyToClipboard(paths) {
    const arr = (Array.isArray(paths) ? paths : [paths]).map(normalizePath);
    clipboard.op    = "copy";
    clipboard.paths = arr;
    clipboard.ts    = now();
    saveClipboard();
    emit("clipboard", { op: "copy", paths: arr.slice() });
    return arr.slice();
  }
  function cutToClipboard(paths) {
    const arr = (Array.isArray(paths) ? paths : [paths]).map(normalizePath);
    // disallow cutting protected items
    for (const p of arr) {
      if (p === ROOT_PATH || p === SYSTEM_PATH || p === TRASH_PATH)
        throw new FsError("EPERM", "Cannot cut protected: " + p);
      const n = resolveNode(p);
      if (n && isReadOnlyChain(n, p))
        throw new FsError("EROFS", "Read-only: " + p);
    }
    clipboard.op    = "cut";
    clipboard.paths = arr;
    clipboard.ts    = now();
    saveClipboard();
    emit("clipboard", { op: "cut", paths: arr.slice() });
    return arr.slice();
  }
  function getClipboard() {
    return {
      op:    clipboard.op,
      paths: clipboard.paths.slice(),
      ts:    clipboard.ts,
      empty: !clipboard.op || clipboard.paths.length === 0,
    };
  }
  function pasteClipboard(destFolder, opts) {
    const o    = opts || {};
    const dest = normalizePath(destFolder);
    const dn   = resolveNode(dest);
    if (!dn) throw new FsError("ENOENT", "No such folder: " + dest);
    if (dn.type !== KIND_FOLDER) throw new FsError("ENOTDIR", "Not a folder: " + dest);
    ensureWritable(dn, dest);
    if (!clipboard.op || !clipboard.paths.length)
      throw new FsError("ENODATA", "Clipboard is empty");
    const op    = clipboard.op;
    const paths = clipboard.paths.slice();
    const out   = [];
    for (const src of paths) {
      if (!exists(src)) continue; // gracefully skip missing
      if (isAncestor(src, dest)) {
        if (o.skipInvalid) continue;
        throw new FsError("EINVAL", "Cannot paste into own descendant: " + src);
      }
      const targetName = uniquifyName(dn, basename(src));
      const targetPath = joinPath(dest, targetName);
      try {
        if (op === "copy") {
          out.push(copyFile(src, targetPath));
        } else {
          out.push(moveFile(src, targetPath));
        }
      } catch (e) {
        if (!o.continueOnError) throw e;
        emit("error", { code: e.code || "EUNKNOWN", message: e.message, path: src });
      }
    }
    if (op === "cut") {
      // After a paste, cut clipboard is consumed
      clearClipboard();
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * Watchers — recursive change subscriptions for a path
   * --------------------------------------------------------------------------
   * watch("/Documents", cb) -> unwatch fn
   * The callback is fired with (eventName, detail) for any change at or below
   * the given path. The File Manager uses this to refresh its current view in
   * real time when other components mutate the filesystem.
   * ------------------------------------------------------------------------*/
  const watchers = []; // { path, cb }

  function watch(path, cb) {
    if (typeof cb !== "function")
      throw new FsError("EINVAL", "watch callback must be a function");
    const p = normalizePath(path || ROOT_PATH);
    const w = { path: p, cb };
    watchers.push(w);
    return function unwatch() {
      const idx = watchers.indexOf(w);
      if (idx !== -1) watchers.splice(idx, 1);
    };
  }

  function dispatchToWatchers(eventName, detail) {
    if (!watchers.length) return;
    const ePath = detail && (detail.path || detail.from || detail.to);
    for (let i = 0; i < watchers.length; i++) {
      const w = watchers[i];
      if (!ePath) {
        // global event (recent / clipboard / mount) — broadcast to all
        try { w.cb(eventName, detail); } catch (e) { console.error(e); }
        continue;
      }
      const pn = normalizePath(ePath);
      if (w.path === ROOT_PATH || pn === w.path || pn.startsWith(w.path + "/") || (detail && detail.from && (normalizePath(detail.from) === w.path || normalizePath(detail.from).startsWith(w.path + "/")))) {
        try { w.cb(eventName, detail); } catch (e) { console.error(e); }
      }
    }
  }

  // We forward all fs:* DOM events to registered watchers. Wiring directly to
  // document means watchers receive every event regardless of which internal
  // path emitted it — simpler than monkey-patching `emit`.
  document.addEventListener("fs:change",  (e) => dispatchToWatchers("fs:change",  e.detail || {}));
  document.addEventListener("fs:create",  (e) => dispatchToWatchers("fs:create",  e.detail || {}));
  document.addEventListener("fs:delete",  (e) => dispatchToWatchers("fs:delete",  e.detail || {}));
  document.addEventListener("fs:write",   (e) => dispatchToWatchers("fs:write",   e.detail || {}));
  document.addEventListener("fs:rename",  (e) => dispatchToWatchers("fs:rename",  e.detail || {}));
  document.addEventListener("fs:move",    (e) => dispatchToWatchers("fs:move",    e.detail || {}));
  document.addEventListener("fs:trash",   (e) => dispatchToWatchers("fs:trash",   e.detail || {}));
  document.addEventListener("fs:restore", (e) => dispatchToWatchers("fs:restore", e.detail || {}));
  document.addEventListener("fs:empty",   (e) => dispatchToWatchers("fs:empty",   e.detail || {}));
  document.addEventListener("fs:recent",  (e) => dispatchToWatchers("fs:recent",  e.detail || {}));

  /* --------------------------------------------------------------------------
   * Batch operations (helpful for the File Manager's multi-select actions)
   * ------------------------------------------------------------------------*/
  function batchDelete(paths, opts) {
    const o = opts || {};
    const out = [];
    for (const p of paths) {
      try { deleteFile(p, o); out.push({ path: p, ok: true }); }
      catch (e) {
        out.push({ path: p, ok: false, error: e.code || e.message });
        if (!o.continueOnError) break;
      }
    }
    return out;
  }

  function batchMove(paths, destFolder, opts) {
    const o    = opts || { uniquify: true };
    const dest = normalizePath(destFolder);
    const dn   = resolveNode(dest);
    if (!dn || dn.type !== KIND_FOLDER)
      throw new FsError("ENOTDIR", "Destination not a folder: " + dest);
    const out = [];
    for (const p of paths) {
      try {
        const nm  = uniquifyName(dn, basename(p));
        const md  = moveFile(p, joinPath(dest, nm), o);
        out.push({ path: p, ok: true, newPath: md.path });
      } catch (e) {
        out.push({ path: p, ok: false, error: e.code || e.message });
        if (!o.continueOnError) break;
      }
    }
    return out;
  }

  function batchCopy(paths, destFolder, opts) {
    const o    = opts || { uniquify: true };
    const dest = normalizePath(destFolder);
    const dn   = resolveNode(dest);
    if (!dn || dn.type !== KIND_FOLDER)
      throw new FsError("ENOTDIR", "Destination not a folder: " + dest);
    const out = [];
    for (const p of paths) {
      try {
        const nm  = uniquifyName(dn, basename(p));
        const md  = copyFile(p, joinPath(dest, nm), o);
        out.push({ path: p, ok: true, newPath: md.path });
      } catch (e) {
        out.push({ path: p, ok: false, error: e.code || e.message });
        if (!o.continueOnError) break;
      }
    }
    return out;
  }

  /* --------------------------------------------------------------------------
   * Undo stack — last 50 destructive ops, used by File Manager's Ctrl+Z.
   * ------------------------------------------------------------------------*/
  const UNDO_MAX = 50;
  const undoStack = [];
  let undoSuspended = false;

  function pushUndo(entry) {
    if (undoSuspended) return;
    undoStack.push(entry);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  // Hook into significant events so we can undo trash and rename automatically.
  document.addEventListener("fs:trash", (e) => {
    const d = e.detail || {};
    if (!d.from || !d.to) return;
    pushUndo({ kind: "trash", from: d.from, to: d.to, ts: d.ts || now() });
  });
  document.addEventListener("fs:rename", (e) => {
    const d = e.detail || {};
    if (!d.from || !d.to) return;
    pushUndo({ kind: "rename", from: d.from, to: d.to, ts: d.ts || now() });
  });
  document.addEventListener("fs:move", (e) => {
    const d = e.detail || {};
    if (!d.from || !d.to) return;
    pushUndo({ kind: "move", from: d.from, to: d.to, ts: d.ts || now() });
  });

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return null;
    undoSuspended = true;
    try {
      if (entry.kind === "trash") {
        // node was moved into /Trash — restore by name (its current location)
        if (exists(entry.to)) restoreFromTrash(entry.to);
      } else if (entry.kind === "rename") {
        if (exists(entry.to)) rename(entry.to, basename(entry.from));
      } else if (entry.kind === "move") {
        if (exists(entry.to)) moveFile(entry.to, entry.from, { uniquify: true });
      }
    } catch (e) {
      console.warn("[FileSystem] undo failed:", e);
    } finally {
      undoSuspended = false;
    }
    return entry;
  }

  function canUndo() { return undoStack.length > 0; }
  function clearUndo() { undoStack.length = 0; }

  /* --------------------------------------------------------------------------
   * Free-text content sniffing — used by previewers to pick syntax highlighting
   * ------------------------------------------------------------------------*/
  function sniffContent(content) {
    if (content == null) return { kind: "empty" };
    const s = String(content);
    const trimmed = s.trim();
    if (!trimmed.length) return { kind: "empty" };
    // JSON
    if ((trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}") ||
        (trimmed[0] === "[" && trimmed[trimmed.length - 1] === "]")) {
      try { JSON.parse(trimmed); return { kind: "json" }; } catch (_) {}
    }
    // SVG / HTML
    if (/^<\?xml/.test(trimmed) || /^<svg[\s>]/i.test(trimmed)) return { kind: "svg" };
    if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) return { kind: "html" };
    // Markdown heuristics
    if (/^#\s+\S/m.test(trimmed) || /^\s*[-*]\s+\S/m.test(trimmed)) return { kind: "markdown" };
    // Code-like
    if (/^\s*(function|const|let|var|class|import|export)\s/m.test(trimmed)) return { kind: "javascript" };
    if (/^\s*(def|import|class)\s/m.test(trimmed)) return { kind: "python" };
    return { kind: "text" };
  }

  /* --------------------------------------------------------------------------
   * Initialization
   * ------------------------------------------------------------------------*/
  function init() {
    if (state.initialized) return;
    mount();
    loadClipboard();
  }

  /* --------------------------------------------------------------------------
   * Expose
   * ------------------------------------------------------------------------*/
  window.FileSystem = {
    // lifecycle
    init, mount, reset, format, reload,
    // queries
    exists, isFile, isFolder, getMetadata, stat, getSize, listDir,
    // I/O
    readFile, writeFile, appendFile, touch, readJSON, writeJSON,
    // folders
    createFolder, mkdirp, ensureFolder,
    // delete / trash
    deleteFile, remove, moveToTrash, restoreFromTrash, emptyTrash, listTrash,
    // move / copy / rename
    moveFile, copyFile, rename, duplicate, uniquifyName,
    // search
    searchFiles,
    // perms / metadata
    chmod, setReadOnly, setHidden, setIcon, setTags,
    // bulk
    tree, diskUsage, exportSnapshot, importSnapshot,
    // recent
    pushRecent, getRecent, clearRecent, pruneRecent,
    // events
    on, subscribe,
    // helpers
    normalizePath, joinPath, dirname, basename, extname, splitName,
    formatBytes, formatDate, fileInfoFromName, getExtensionMap,
    pathParts, breadcrumbs, isAncestor,
    // clipboard
    copyToClipboard, cutToClipboard, pasteClipboard, getClipboard, clearClipboard,
    // watchers
    watch,
    // batch
    batchDelete, batchMove, batchCopy,
    // undo
    undo, canUndo, clearUndo,
    // sniffing
    sniffContent,
    // constants
    PATH_SEP, ROOT_PATH, TRASH_PATH, SYSTEM_PATH,
    EVENTS, KIND_FILE, KIND_FOLDER,
    PERM_R, PERM_W, PERM_X, PERM_FULL, PERM_RX, PERM_R_,
  };

  // Auto-mount as early as possible; we do not wait for DOMContentLoaded
  // because other modules may try to read the FS during their own init.
  try {
    mount();
    loadClipboard();
  } catch (e) {
    console.error("[FileSystem] mount failed:", e);
  }
})();
