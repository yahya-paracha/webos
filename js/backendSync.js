/* ============================================================================
 * WebOS — backendSync.js
 * ----------------------------------------------------------------------------
 * Frontend integration for the optional Python Flask backend (backend/server.py).
 *
 * The frontend works perfectly without any backend running — every WebOS app
 * persists to localStorage. When the backend IS running, this module:
 *
 *   - Probes /api/health on boot (2s timeout)
 *   - Adds a green/grey "Backend" status dot to the taskbar tray
 *   - Provides login / register / logout flows for the Settings app
 *   - Pulls server-side settings on login and applies theme/wallpaper
 *   - Pulls server-side filesystem on login and restores virtual FS
 *   - Pushes a snapshot of localStorage state to the backend every 60s
 *   - Surfaces server-pushed notifications to the taskbar's notification API
 *
 * Public API on window.Backend:
 *
 *     Backend.isOnline()                  -> bool
 *     Backend.url(path)                   -> absolute URL
 *     Backend.health()                    -> Promise<HealthInfo|null>
 *     Backend.login(username, password)   -> Promise<{ok, user}>
 *     Backend.register(user, pass, opts)  -> Promise<{ok, user}>
 *     Backend.logout()                    -> Promise<{ok}>
 *     Backend.me()                        -> Promise<User|null>
 *     Backend.token()                     -> string|null
 *     Backend.user()                      -> User|null
 *     Backend.changePassword(old, new)    -> Promise
 *     Backend.updateAvatar(av)            -> Promise
 *     Backend.updateProfile(opts)         -> Promise
 *     Backend.fs.read(path)               -> Promise<{path, content}>
 *     Backend.fs.write(path, content)     -> Promise
 *     Backend.fs.list(path)               -> Promise<{items}>
 *     Backend.fs.delete(path, recursive)  -> Promise
 *     Backend.fs.mkdir(path)              -> Promise
 *     Backend.settings.get(key)           -> Promise
 *     Backend.settings.set(key, value)    -> Promise
 *     Backend.settings.all()              -> Promise<{settings}>
 *     Backend.settings.bulk(map, replace) -> Promise
 *     Backend.sync(label?)                -> Promise<{ok}>
 *     Backend.pull()                      -> Promise<snapshot>
 *     Backend.applySettings(map)          -> applies a settings map locally
 *     Backend.pullAndApplyFilesystem()    -> Promise (restores FS from backend)
 *     Backend.on(event, fn)               -> subscribe to events
 *
 * Events emitted on window via "webos:backend<event>" and via Backend.on:
 *   - online, offline, login, logout, syncpush, syncpull, error, notification
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * 0. Configuration
   * ========================================================================*/

  const HEALTH_TIMEOUT_MS  = 2000;
  const SYNC_INTERVAL_MS   = 60_000;
  const POLL_HEALTH_MS     = 30_000;
  const STORAGE_TOKEN_KEY  = "webos.backend.token";
  const STORAGE_USER_KEY   = "webos.backend.user";
  const STORAGE_BASE_KEY   = "webos.backend.baseURL";
  const STORAGE_LASTSYNC   = "webos.backend.lastSync";

  function defaultBase() {
    const stored = localStorage.getItem(STORAGE_BASE_KEY);
    if (stored) return stored.replace(/\/+$/, "");
    if (location.protocol.startsWith("http")) {
      return location.origin.replace(/\/+$/, "");
    }
    return "http://127.0.0.1:5050";
  }

  /* ==========================================================================
   * 1. State
   * ========================================================================*/

  const state = {
    baseURL:    defaultBase(),
    online:     false,
    health:     null,
    token:      localStorage.getItem(STORAGE_TOKEN_KEY) || null,
    user:       safeJSON(localStorage.getItem(STORAGE_USER_KEY)) || null,
    syncTimer:  null,
    pollTimer:  null,
    listeners:  {},
    inflight:   0,
    socket:     null,
  };

  function safeJSON(s) { if (!s) return null; try { return JSON.parse(s); } catch (_) { return null; } }

  /* ==========================================================================
   * 2. Tiny event bus
   * ========================================================================*/

  function on(event, fn) {
    if (!state.listeners[event]) state.listeners[event] = [];
    state.listeners[event].push(fn);
    return () => off(event, fn);
  }
  function off(event, fn) {
    const arr = state.listeners[event];
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emit(event, payload) {
    (state.listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error("[Backend] listener:", e); }
    });
    try {
      window.dispatchEvent(new CustomEvent("webos:backend" + event, { detail: payload }));
    } catch (_) {}
  }

  /* ==========================================================================
   * 3. URL & fetch helpers
   * ========================================================================*/

  function url(path) {
    if (!path) return state.baseURL;
    if (/^https?:\/\//i.test(path)) return path;
    return state.baseURL.replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
  }

  async function fetchWithTimeout(input, init, ms) {
    init = init || {};
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms || 8000);
    init.signal = ctrl.signal;
    try {
      const res = await fetch(input, init);
      return res;
    } finally {
      clearTimeout(id);
    }
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const headers = Object.assign({ "Accept": "application/json" }, opts.headers || {});
    let payload = undefined;
    if (body != null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (state.token) headers["Authorization"] = "Bearer " + state.token;

    state.inflight++;
    let res;
    try {
      res = await fetchWithTimeout(
        url(path),
        { method, headers, body: payload, credentials: "omit" },
        opts.timeout || 8000
      );
    } catch (e) {
      state.inflight--;
      if (state.online) setOnline(false);
      throw new BackendError("NETWORK", e && e.message ? e.message : String(e));
    }
    state.inflight--;

    if (!state.online && res.status !== 0) {
      setOnline(true);
    }

    let data = null;
    const ct = res.headers.get("Content-Type") || "";
    if (ct.indexOf("application/json") >= 0) {
      try { data = await res.json(); } catch (_) { data = null; }
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const code = (data && data.error) || ("HTTP_" + res.status);
      const msg  = (data && data.message) || res.statusText || "request failed";
      const err  = new BackendError(code, msg, res.status, data);
      if (res.status === 401 && state.token) clearAuthLocal();
      throw err;
    }
    return data;
  }

  function get(path, opts)        { return request("GET", path, null, opts); }
  function post(path, body, opts) { return request("POST", path, body || {}, opts); }
  function del(path, body, opts)  { return request("DELETE", path, body || {}, opts); }

  class BackendError extends Error {
    constructor(code, message, status, data) {
      super(message);
      this.name = "BackendError";
      this.code = code;
      this.status = status || 0;
      this.data = data || null;
    }
  }

  /* ==========================================================================
   * 4. Connectivity probe
   * ========================================================================*/

  async function health() {
    try {
      const data = await fetchWithTimeout(url("/api/health"), {}, HEALTH_TIMEOUT_MS)
        .then((r) => r.ok ? r.json() : null);
      if (data && data.ok) {
        state.health = data;
        setOnline(true);
        return data;
      }
      setOnline(false);
      return null;
    } catch (_) {
      setOnline(false);
      return null;
    }
  }

  function setOnline(online) {
    if (state.online === online) return;
    state.online = online;
    updateTrayDot();
    emit(online ? "online" : "offline", { online });
  }

  function isOnline() { return !!state.online; }

  /* ==========================================================================
   * 5. Taskbar status indicator
   * ========================================================================*/

  function injectTrayDot() {
    const tray = document.querySelector(".taskbar-tray");
    if (!tray) return;
    if (document.getElementById("tray-backend")) return;
    const dot = document.createElement("div");
    dot.id = "tray-backend";
    dot.className = "tray-icon tray-backend";
    dot.title = "Backend status (click for details)";
    dot.innerHTML =
      '<span class="tray-backend-dot" aria-hidden="true"></span>' +
      '<span class="tray-backend-label">Offline</span>';
    tray.insertBefore(dot, tray.firstChild);
    dot.addEventListener("click", () => {
      const status = state.online ? "Connected" : "Offline";
      const url_ = state.baseURL;
      const u    = state.user ? state.user.username : "(not signed in)";
      if (window.Taskbar && window.Taskbar.toast) {
        window.Taskbar.toast({
          type: state.online ? "success" : "info",
          title: "Backend " + status,
          body:  `Server: ${url_}\nUser: ${u}`,
          timeout: 4500,
        });
      } else {
        alert("Backend " + status + "\n" + url_);
      }
    });
    injectTrayDotStyle();
    updateTrayDot();
  }

  function injectTrayDotStyle() {
    if (document.getElementById("backend-sync-css")) return;
    const css = `
      .tray-backend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 11px;
        line-height: 1;
        color: var(--fg-muted, #9aa3b2);
        background: rgba(255,255,255,0.04);
        transition: background 0.15s ease;
      }
      .tray-backend:hover { background: rgba(255,255,255,0.10); }
      .tray-backend-dot {
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #6b7280;
        box-shadow: 0 0 4px rgba(0,0,0,0.25);
        transition: background 0.18s ease, box-shadow 0.18s ease;
      }
      .tray-backend.is-online .tray-backend-dot {
        background: #10b981;
        box-shadow: 0 0 6px #10b981aa;
        animation: bk-pulse 2.4s ease-in-out infinite;
      }
      .tray-backend.is-online {
        color: #10b981;
      }
      .tray-backend-label {
        font-weight: 600;
        letter-spacing: 0.3px;
      }
      @keyframes bk-pulse {
        0%, 100% { opacity: 1.0; }
        50%      { opacity: 0.5; }
      }
    `;
    const style = document.createElement("style");
    style.id = "backend-sync-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function updateTrayDot() {
    const dot = document.getElementById("tray-backend");
    if (!dot) return;
    dot.classList.toggle("is-online", state.online);
    const label = dot.querySelector(".tray-backend-label");
    if (label) {
      if (state.online) {
        label.textContent = state.user ? "@" + state.user.username : "Connected";
      } else {
        label.textContent = "Offline";
      }
    }
    dot.title = state.online
      ? `Backend Connected (${state.baseURL})`
      : "Offline Mode (localStorage only)";
  }

  /* ==========================================================================
   * 6. Authentication
   * ========================================================================*/

  function setAuthLocal(token, user) {
    state.token = token;
    state.user  = user;
    if (token) localStorage.setItem(STORAGE_TOKEN_KEY, token);
    else       localStorage.removeItem(STORAGE_TOKEN_KEY);
    if (user)  localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
    else       localStorage.removeItem(STORAGE_USER_KEY);
    updateTrayDot();
  }

  function clearAuthLocal() { setAuthLocal(null, null); }

  async function login(username, password) {
    const r = await post("/api/auth/login", { username, password });
    if (r && r.token) {
      setAuthLocal(r.token, r.user);
      emit("login", { user: r.user });
      try { await pullAndApplySettings(); } catch (e) { console.warn("[Backend] post-login pull settings failed:", e); }
      try { await pullAndApplyFilesystem(); } catch (e) { console.warn("[Backend] post-login pull FS failed:", e); }
      startSyncTimer();
    }
    return r;
  }

  async function register(username, password, opts) {
    opts = opts || {};
    const r = await post("/api/auth/register", {
      username, password,
      displayName: opts.displayName || null,
      avatar:      opts.avatar || null,
    });
    if (r && r.token) {
      setAuthLocal(r.token, r.user);
      emit("login", { user: r.user });
      try { await pushSnapshot("first-login"); } catch (_) {}
      startSyncTimer();
    }
    return r;
  }

  async function logout() {
    try {
      if (state.token) await post("/api/auth/logout", {});
    } catch (_) {}
    stopSyncTimer();
    const u = state.user;
    clearAuthLocal();
    emit("logout", { user: u });
    return { ok: true };
  }

  async function me() {
    if (!state.token) return null;
    try {
      const r = await get("/api/auth/me");
      if (r && r.user) {
        setAuthLocal(state.token, r.user);
        return r.user;
      }
    } catch (e) {
      if (e instanceof BackendError && e.status === 401) clearAuthLocal();
    }
    return null;
  }

  async function changePassword(oldPassword, newPassword) {
    const r = await post("/api/auth/change-password", { oldPassword, newPassword });
    if (r && r.token) state.token = r.token;
    if (state.token) localStorage.setItem(STORAGE_TOKEN_KEY, state.token);
    return r;
  }

  async function updateAvatar(avatar) {
    const r = await post("/api/auth/avatar", { avatar });
    if (r && r.user) setAuthLocal(state.token, r.user);
    return r;
  }

  async function updateProfile(opts) {
    const r = await post("/api/auth/profile", opts || {});
    if (r && r.user) setAuthLocal(state.token, r.user);
    return r;
  }

  /* ==========================================================================
   * 7. Filesystem helpers
   * ========================================================================*/

  const fs = {
    read(path)            { return get("/api/fs/read?path=" + encodeURIComponent(path)); },
    write(path, content, metadata) { return post("/api/fs/write", { path, content, metadata: metadata || {} }); },
    list(path)            { return get("/api/fs/list?path=" + encodeURIComponent(path || "/")); },
    mkdir(path)           { return post("/api/fs/mkdir", { path }); },
    delete(path, recursive) { return del("/api/fs/delete", { path, recursive: !!recursive }); },
    move(src, dst)        { return post("/api/fs/move", { src, dst }); },
    copy(src, dst)        { return post("/api/fs/copy", { src, dst }); },
    touch(path)           { return post("/api/fs/touch", { path }); },
    search(q)             { return get("/api/fs/search?q=" + encodeURIComponent(q)); },
    stat(path)            { return get("/api/fs/stat?path=" + encodeURIComponent(path)); },
    dump()                { return get("/api/fs/dump"); },
    import(items)         { return post("/api/fs/import", { items }); },
  };

  /* ==========================================================================
   * 8. Settings helpers
   * ========================================================================*/

  const settings = {
    all()                  { return get("/api/settings"); },
    get(key)               { return get("/api/settings/" + encodeURIComponent(key)); },
    set(key, value)        { return post("/api/settings", { key, value }); },
    bulk(map, replace)     { return post("/api/settings/bulk", { settings: map, replace: !!replace }); },
    delete(key)            { return del("/api/settings/" + encodeURIComponent(key)); },
    reset(keys)            { return post("/api/settings/reset", keys ? { keys } : {}); },
    export_()              { return get("/api/settings/export"); },
    import(map)            { return post("/api/settings/import", { settings: map }); },
    categories()           { return get("/api/settings/categories"); },
  };

  /* ==========================================================================
   * 9. Sync (push/pull)
   * ========================================================================*/

  function buildSnapshot() {
    const snap = {
      version:    1,
      created_at: Date.now(),
      client:     "webos-frontend",
      filesystem: collectFilesystem(),
      settings:   collectLocalSettings(),
      localstorage: collectLocalStorageRaw(),
    };
    return snap;
  }

  function collectFilesystem() {
    if (!window.FileSystem || !window.FileSystem.exportSnapshot) return [];
    try {
      const snap = window.FileSystem.exportSnapshot();
      const flat = [];
      function walk(node, base) {
        if (!node) return;
        if (node.type === "folder") {
          if (base) flat.push({ path: base, type: "folder", content: "", metadata: node.metadata || {} });
          if (node.children) {
            Object.keys(node.children).forEach((name) => {
              const child = node.children[name];
              const childPath = (base === "/" ? "" : base) + "/" + name;
              walk(child, childPath);
            });
          }
        } else {
          flat.push({
            path:    base,
            type:    "file",
            content: node.content || "",
            metadata: node.metadata || {},
          });
        }
      }
      walk(snap, "/");
      return flat;
    } catch (e) {
      console.warn("[Backend] FS snapshot failed:", e);
      return [];
    }
  }

  function collectLocalSettings() {
    const out = {};
    try {
      if (window.ThemeEngine && window.ThemeEngine.exportSettings) {
        const s = window.ThemeEngine.exportSettings();
        Object.keys(s || {}).forEach((k) => out["appearance." + k] = s[k]);
      }
      const sys = safeJSON(localStorage.getItem("webos.settings.all"));
      if (sys && typeof sys === "object") {
        Object.keys(sys).forEach((k) => out[k] = sys[k]);
      }
    } catch (_) {}
    return out;
  }

  function collectLocalStorageRaw() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith("webos.")) continue;
        if (k === STORAGE_TOKEN_KEY) continue;
        if (k === STORAGE_USER_KEY)  continue;
        const v = localStorage.getItem(k);
        if (v != null && v.length < 200_000) out[k] = v;
      }
    } catch (_) {}
    return out;
  }

  async function pushSnapshot(label) {
    if (!state.online || !state.token) return { ok: false, reason: "offline_or_anon" };
    const snap = buildSnapshot();
    try {
      const r = await post("/api/sync/push", { snapshot: snap, label: label || "auto" });
      localStorage.setItem(STORAGE_LASTSYNC, String(Date.now()));
      emit("syncpush", { snapshot_id: r.snapshot_id, applied: r.applied });
      return r;
    } catch (e) {
      emit("error", { context: "syncpush", message: e.message, code: e.code });
      throw e;
    }
  }

  async function pull() {
    if (!state.online || !state.token) return null;
    const r = await get("/api/sync/pull");
    emit("syncpull", { synthetic: !!r.synthetic });
    return r.snapshot;
  }

  async function pullAndApplySettings() {
    if (!state.online || !state.token) return;
    try {
      const all = await settings.all();
      if (all && all.settings) {
        applySettings(all.settings);
      }
    } catch (e) {
      console.warn("[Backend] pull settings failed:", e);
    }
  }

  /**
   * Pull the full server snapshot and restore the virtual filesystem from it.
   * Writes FS localStorage keys directly, then asks FileSystem to hot-reload.
   * Safe to call offline/unauthenticated — silently no-ops.
   */
  async function pullAndApplyFilesystem() {
    if (!state.online || !state.token) return;
    try {
      const snapshot = await pull();
      if (!snapshot || !snapshot.localstorage) return;
      const ls = snapshot.localstorage;

      if (Object.prototype.hasOwnProperty.call(ls, "webos.fs.v1")) {
        try { localStorage.setItem("webos.fs.v1", ls["webos.fs.v1"]); } catch (_) {}
      }
      if (Object.prototype.hasOwnProperty.call(ls, "webos.fs.recent")) {
        try { localStorage.setItem("webos.fs.recent", ls["webos.fs.recent"]); } catch (_) {}
      }
      try {
        if (window.FileSystem && window.FileSystem.reload) {
          window.FileSystem.reload();
        }
      } catch (e) {
        console.warn("[Backend] FS reload failed:", e);
      }
    } catch (e) {
      console.warn("[Backend] pull filesystem failed:", e);
    }
  }

  function applySettings(map) {
    if (!map || typeof map !== "object") return;
    try {
      if (window.ThemeEngine) {
        if (map["appearance.theme"] && window.ThemeEngine.setTheme)
          window.ThemeEngine.setTheme(map["appearance.theme"]);
        if (map["appearance.wallpaper"] && window.ThemeEngine.setWallpaper)
          window.ThemeEngine.setWallpaper(map["appearance.wallpaper"]);
        if (map["appearance.accent"] && window.ThemeEngine.setAccent)
          window.ThemeEngine.setAccent(map["appearance.accent"]);
        if (map["appearance.animations"] != null && window.ThemeEngine.setAnimations)
          window.ThemeEngine.setAnimations(!!map["appearance.animations"]);
      }
      const merged = Object.assign(
        {}, safeJSON(localStorage.getItem("webos.settings.all")) || {}, map
      );
      localStorage.setItem("webos.settings.all", JSON.stringify(merged));
      try {
        window.dispatchEvent(new CustomEvent("webos:settingsapplied", { detail: { source: "backend", map } }));
      } catch (_) {}
    } catch (e) {
      console.warn("[Backend] applySettings failed:", e);
    }
  }

  function startSyncTimer() {
    stopSyncTimer();
    if (!state.online || !state.token) return;
    state.syncTimer = setInterval(() => {
      pushSnapshot("auto").catch(() => {});
    }, SYNC_INTERVAL_MS);
  }
  function stopSyncTimer() {
    if (state.syncTimer) { clearInterval(state.syncTimer); state.syncTimer = null; }
  }

  /* ==========================================================================
   * 10. Notification poll
   * ========================================================================*/

  let lastNotifTs = 0;
  async function pollNotifications() {
    if (!state.online || !state.token) return;
    try {
      const r = await get("/api/notifications");
      if (!r || !r.items) return;
      r.items.forEach((n) => {
        if (n.created_at <= lastNotifTs) return;
        lastNotifTs = Math.max(lastNotifTs, n.created_at);
        emit("notification", n);
        if (window.Taskbar && window.Taskbar.pushNotification) {
          window.Taskbar.pushNotification({
            id: "bk-" + n.id,
            type: n.type || "info",
            title: n.title,
            body:  n.body || "",
            time:  n.created_at * 1000,
          });
        }
      });
    } catch (_) {}
  }

  /* ==========================================================================
   * 11. Boot integration
   * ========================================================================*/

  async function init() {
    injectTrayDot();
    setOnline(false);
    state.pollTimer = setInterval(() => {
      if (!state.online) health();
      else pollNotifications();
    }, POLL_HEALTH_MS);

    const h = await health();
    if (!h) {
      console.log("%c[Backend]%c offline (localStorage-only mode)",
        "color:#9ca3af;font-weight:bold","color:inherit");
      return;
    }
    console.log("%c[Backend]%c connected to %s (v%s)",
      "color:#10b981;font-weight:bold","color:inherit",
      state.baseURL, h.version);

    if (state.token) {
      const u = await me();
      if (u) {
        emit("login", { user: u });
        try { await pullAndApplySettings(); } catch (e) { console.warn("[Backend] init pull settings failed:", e); }
        try { await pullAndApplyFilesystem(); } catch (e) { console.warn("[Backend] init pull FS failed:", e); }
        startSyncTimer();
      } else {
        emit("offline", { reason: "auth_expired" });
      }
    }
  }

  /* ==========================================================================
   * 12. Public API
   * ========================================================================*/

  window.Backend = {
    isOnline,
    health,
    url,
    setBaseURL(newURL) {
      state.baseURL = String(newURL || "").replace(/\/+$/, "");
      localStorage.setItem(STORAGE_BASE_KEY, state.baseURL);
      health();
    },
    getBaseURL() { return state.baseURL; },

    login, register, logout, me,
    changePassword, updateAvatar, updateProfile,
    token() { return state.token; },
    user()  { return state.user; },
    isAuthenticated() { return !!(state.token && state.user); },

    fs, settings,

    sync(label) { return pushSnapshot(label || "manual"); },
    pull,
    applySettings,
    pullAndApply: pullAndApplySettings,
    pullAndApplyFilesystem,
    lastSync()  { return Number(localStorage.getItem(STORAGE_LASTSYNC) || 0); },

    on, off,

    request, get, post, delete: del,
    BackendError,

    init,
    shutdown() {
      stopSyncTimer();
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    },

    state() {
      return {
        online:   state.online,
        baseURL:  state.baseURL,
        user:     state.user,
        hasToken: !!state.token,
        inflight: state.inflight,
        lastSync: Number(localStorage.getItem(STORAGE_LASTSYNC) || 0),
        health:   state.health,
      };
    },
  };

  /* ==========================================================================
   * 13. Boot
   * ========================================================================*/

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("online",  () => { health(); });
  window.addEventListener("offline", () => { setOnline(false); });

})();
