/* ============================================================================
 * WebOS — notifications.js
 * ----------------------------------------------------------------------------
 * Global notification system for WebOS.
 *
 *   window.Notifications.send({ title, body, type, ... })
 *
 * Features:
 *   - Toast notifications (bottom-right stack, max 5 visible)
 *   - Notification Center panel (bell icon in taskbar)
 *   - Badge counter with unread count
 *   - Type color coding (info, success, warning, error, neutral)
 *   - Hover pauses auto-dismiss timer
 *   - Action buttons per notification
 *   - Mark read / mark all read / clear all
 *   - Filter tabs in Notification Center (all/unread/by type)
 *   - Persistent storage in FileSystem at /.notifications/log.json
 *     with graceful localStorage fallback
 *   - Rolling log of max 200 entries
 *   - App-specific sender helpers
 *
 * Public API on  window.Notifications
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * Constants
   * ========================================================================*/

  const STORAGE_KEY       = "webos.notifications.v1";
  const STORAGE_KEY_PREFS = "webos.notifications.prefs.v1";
  const FS_DIR            = "/.notifications";
  const FS_LOG_PATH       = "/.notifications/log.json";
  const MAX_STORED        = 200;
  const MAX_VISIBLE_TOASTS = 5;
  const DEFAULT_DURATION   = 5000;          // 5 seconds
  const MIN_DURATION       = 1500;
  const MAX_DURATION       = 60000;
  const PERSISTENT_DURATION = Number.POSITIVE_INFINITY;
  const UID_PREFIX         = "wn_";

  const TYPES = Object.freeze({
    INFO:    "info",
    SUCCESS: "success",
    WARNING: "warning",
    ERROR:   "error",
    NEUTRAL: "neutral",
  });

  const TYPE_ICON = Object.freeze({
    info:    "ℹ",
    success: "✓",
    warning: "⚠",
    error:   "✕",
    neutral: "●",
  });

  const TYPE_SOUND_HINT = Object.freeze({
    info:    true,
    success: true,
    warning: true,
    error:   true,
    neutral: false,
  });

  /* ==========================================================================
   * State
   * ========================================================================*/

  const state = {
    initialized:      false,
    entries:          [],             // { id, title, body, type, ts, read, ... }
    toasts:           new Map(),      // id -> { entry, el, timer, remaining }
    toastStack:       null,           // DOM container for toasts
    center:           null,           // DOM for notification center
    centerOpen:       false,
    centerFilter:     "all",          // all | unread | info | success | warning | error
    bellEl:           null,
    badgeEl:          null,
    listeners:        new Set(),
    prefs: {
      enabled:          true,
      toastsEnabled:    true,
      defaultDuration:  DEFAULT_DURATION,
      maxVisibleToasts: MAX_VISIBLE_TOASTS,
      doNotDisturb:     false,
      soundsEnabled:    false,
      position:         "bottom-right",  // future-proof
    },
    saveTimer:        null,
    idCounter:        0,
  };

  /* ==========================================================================
   * Utilities
   * ========================================================================*/

  function uid() {
    state.idCounter++;
    return UID_PREFIX + Date.now().toString(36) + "_" + state.idCounter.toString(36);
  }

  function now() {
    return Date.now();
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function linkify(text) {
    if (!text) return "";
    const escaped = escapeHtml(text);
    return escaped.replace(/\n/g, "<br/>");
  }

  function safeLocalGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function safeLocalSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (_) {
      return false;
    }
  }

  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent("webos:notifications:" + name, { detail }));
    } catch (_) {}
    state.listeners.forEach((fn) => {
      try { fn(name, detail); } catch (e) { console.error(e); }
    });
  }

  function on(fn) {
    if (typeof fn !== "function") return () => {};
    state.listeners.add(fn);
    return () => state.listeners.delete(fn);
  }

  function formatTime(ts) {
    if (!ts) return "";
    const diff = Math.max(0, now() - ts);
    const secs = Math.floor(diff / 1000);
    const mins = Math.floor(secs / 60);
    const hrs  = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (secs < 10) return "just now";
    if (secs < 60) return secs + "s ago";
    if (mins < 60) return mins + "m ago";
    if (hrs  < 24) return hrs + "h ago";
    if (days < 7 ) return days + "d ago";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    });
  }

  function formatFullTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function normalizeType(type) {
    if (!type) return TYPES.INFO;
    const t = String(type).toLowerCase();
    if (t === "warn" || t === "warning") return TYPES.WARNING;
    if (t === "err"  || t === "error" || t === "danger") return TYPES.ERROR;
    if (t === "ok"   || t === "success") return TYPES.SUCCESS;
    if (t === "muted" || t === "neutral" || t === "gray") return TYPES.NEUTRAL;
    if (t === "info") return TYPES.INFO;
    return TYPES.INFO;
  }

  function getTypeIcon(type, fallback) {
    return fallback || TYPE_ICON[type] || "•";
  }

  /* ==========================================================================
   * Persistence — FileSystem preferred, localStorage fallback
   * ========================================================================*/

  function persistToFs() {
    if (!window.FileSystem) return false;
    try {
      if (!window.FileSystem.exists(FS_DIR)) {
        window.FileSystem.createFolder(FS_DIR, { hidden: true, recursive: true });
      }
      const payload = {
        version: 1,
        ts: now(),
        entries: state.entries.slice(0, MAX_STORED),
      };
      window.FileSystem.writeFile(FS_LOG_PATH, JSON.stringify(payload, null, 0), {
        mime: "application/json", kind: "text",
      });
      return true;
    } catch (e) {
      console.warn("[Notifications] FS persist failed:", e);
      return false;
    }
  }

  function loadFromFs() {
    if (!window.FileSystem) return null;
    try {
      if (!window.FileSystem.exists(FS_LOG_PATH)) return null;
      const raw = window.FileSystem.readFile(FS_LOG_PATH, { noRecent: true });
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.entries)) return null;
      return payload.entries;
    } catch (e) {
      console.warn("[Notifications] FS load failed:", e);
      return null;
    }
  }

  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      // Always mirror to localStorage (fast, synchronous)
      safeLocalSet(STORAGE_KEY, state.entries.slice(0, MAX_STORED));
      // And to FileSystem if available
      persistToFs();
      state.saveTimer = null;
    }, 300);
  }

  function loadPrefs() {
    const stored = safeLocalGet(STORAGE_KEY_PREFS, null);
    if (stored && typeof stored === "object") {
      Object.assign(state.prefs, stored);
    }
  }

  function savePrefs() {
    safeLocalSet(STORAGE_KEY_PREFS, state.prefs);
  }

  function loadEntries() {
    // Prefer FS, fall back to localStorage
    const fromFs = loadFromFs();
    if (fromFs) {
      state.entries = fromFs;
      return;
    }
    const fromLs = safeLocalGet(STORAGE_KEY, []);
    if (Array.isArray(fromLs)) {
      state.entries = fromLs;
    } else {
      state.entries = [];
    }
  }

  /* ==========================================================================
   * Entry model
   * ========================================================================*/

  function makeEntry(options) {
    const o = options || {};
    const type = normalizeType(o.type);
    const entry = {
      id:         o.id || uid(),
      title:      String(o.title || "Notification"),
      body:       o.body != null ? String(o.body) : "",
      type:       type,
      ts:         o.ts || now(),
      appName:    o.appName || o.app || "System",
      appIcon:    o.appIcon || null,
      icon:       o.icon || getTypeIcon(type),
      read:       !!o.read,
      persistent: !!o.persistent,
      duration:   o.persistent
                    ? PERSISTENT_DURATION
                    : (o.duration != null
                        ? clamp(o.duration, MIN_DURATION, MAX_DURATION)
                        : state.prefs.defaultDuration),
      action:     typeof o.action === "function" ? o.action : null,
      actionLabel: o.actionLabel || null,
      action2:    typeof o.action2 === "function" ? o.action2 : null,
      actionLabel2: o.actionLabel2 || null,
      silent:     !!o.silent,
      meta:       o.meta || null,
      _deleted:   false,
    };
    return entry;
  }

  function addToLog(entry) {
    state.entries.unshift(entry);
    // Trim
    if (state.entries.length > MAX_STORED) {
      state.entries.length = MAX_STORED;
    }
    scheduleSave();
  }

  function removeFromLog(id) {
    const i = state.entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      state.entries.splice(i, 1);
      scheduleSave();
      return true;
    }
    return false;
  }

  function findEntry(id) {
    return state.entries.find((e) => e.id === id) || null;
  }

  /* ==========================================================================
   * Toast DOM
   * ========================================================================*/

  function ensureToastStack() {
    if (state.toastStack && document.body.contains(state.toastStack)) {
      return state.toastStack;
    }
    let el = document.getElementById("wn-toast-stack");
    if (!el) {
      el = document.createElement("div");
      el.id = "wn-toast-stack";
      el.className = "wn-toast-stack";
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", "Notifications");
      document.body.appendChild(el);
    }
    state.toastStack = el;
    return el;
  }

  function renderToast(entry) {
    const el = document.createElement("div");
    el.className = "wn-toast wn-" + entry.type;
    el.dataset.id = entry.id;
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "polite");

    const iconHtml = entry.appIcon
      ? `<span class="wn-toast-icon">${escapeHtml(entry.appIcon)}</span>`
      : `<span class="wn-toast-icon">${escapeHtml(entry.icon)}</span>`;

    const actionsHtml = (entry.action || entry.action2) ? `
      <div class="wn-toast-actions">
        ${entry.action ? `<button class="wn-toast-action primary" data-act="1">${escapeHtml(entry.actionLabel || "Open")}</button>` : ""}
        ${entry.action2 ? `<button class="wn-toast-action" data-act="2">${escapeHtml(entry.actionLabel2 || "Dismiss")}</button>` : ""}
      </div>
    ` : "";

    const appBadge = entry.appName
      ? `<span class="wn-toast-app">${escapeHtml(entry.appName)}</span>`
      : "";

    const progressVisible = entry.duration !== PERSISTENT_DURATION;

    el.innerHTML = `
      ${iconHtml}
      <div class="wn-toast-body">
        <div class="wn-toast-title">
          <span>${escapeHtml(entry.title)}</span>
          ${appBadge}
        </div>
        ${entry.body ? `<div class="wn-toast-text">${linkify(entry.body)}</div>` : ""}
        ${actionsHtml}
      </div>
      <button class="wn-toast-close" aria-label="Dismiss" title="Dismiss">✕</button>
      ${progressVisible ? `<div class="wn-toast-progress"></div>` : ""}
    `;

    // Wire events
    const closeBtn = el.querySelector(".wn-toast-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissToast(entry.id);
      });
    }

    el.querySelectorAll(".wn-toast-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const which = btn.getAttribute("data-act");
        const fn = which === "2" ? entry.action2 : entry.action;
        if (typeof fn === "function") {
          try { fn(entry); } catch (err) { console.error("[Notifications] action error:", err); }
        }
        dismissToast(entry.id);
      });
    });

    // Hover pauses timer
    el.addEventListener("mouseenter", () => pauseToast(entry.id));
    el.addEventListener("mouseleave", () => resumeToast(entry.id));

    // Click on body marks as read and focuses center
    el.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      markAsRead(entry.id);
    });

    return el;
  }

  function showToast(entry) {
    if (!state.prefs.enabled) return;
    if (!state.prefs.toastsEnabled) return;
    if (state.prefs.doNotDisturb && entry.type !== TYPES.ERROR) return;
    if (entry.silent) return;

    const stack = ensureToastStack();
    const el = renderToast(entry);
    stack.appendChild(el);

    const rec = {
      entry,
      el,
      timer: null,
      remaining: entry.duration,
      startedAt: now(),
      paused: false,
    };
    state.toasts.set(entry.id, rec);

    // Set progress bar animation
    if (entry.duration !== PERSISTENT_DURATION) {
      const progress = el.querySelector(".wn-toast-progress");
      if (progress) {
        // Kick off after paint
        requestAnimationFrame(() => {
          progress.style.transitionDuration = entry.duration + "ms";
          progress.style.transform = "scaleX(0)";
        });
      }
      rec.timer = setTimeout(() => dismissToast(entry.id), entry.duration);
    }

    // Enforce max visible
    enforceToastLimit();

    emit("toast-shown", { id: entry.id, entry });
  }

  function enforceToastLimit() {
    const max = Math.max(1, state.prefs.maxVisibleToasts || MAX_VISIBLE_TOASTS);
    const current = Array.from(state.toasts.keys());
    while (current.length > max) {
      const oldest = current.shift();
      dismissToast(oldest);
    }
  }

  function pauseToast(id) {
    const rec = state.toasts.get(id);
    if (!rec || rec.paused) return;
    if (rec.entry.duration === PERSISTENT_DURATION) return;
    if (rec.timer) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    const elapsed = now() - rec.startedAt;
    rec.remaining = Math.max(0, rec.remaining - elapsed);
    rec.paused = true;
    rec.el.classList.add("wn-paused");
    const progress = rec.el.querySelector(".wn-toast-progress");
    if (progress) {
      const cs = getComputedStyle(progress);
      const t = cs.transform;
      progress.style.transitionDuration = "0ms";
      progress.style.transform = t;
    }
  }

  function resumeToast(id) {
    const rec = state.toasts.get(id);
    if (!rec || !rec.paused) return;
    if (rec.entry.duration === PERSISTENT_DURATION) return;
    rec.paused = false;
    rec.startedAt = now();
    rec.el.classList.remove("wn-paused");
    const progress = rec.el.querySelector(".wn-toast-progress");
    if (progress) {
      requestAnimationFrame(() => {
        progress.style.transitionDuration = rec.remaining + "ms";
        progress.style.transform = "scaleX(0)";
      });
    }
    rec.timer = setTimeout(() => dismissToast(id), rec.remaining);
  }

  function dismissToast(id) {
    const rec = state.toasts.get(id);
    if (!rec) return false;
    if (rec.timer) clearTimeout(rec.timer);
    const el = rec.el;
    el.classList.add("wn-out");
    const finish = () => {
      try { el.remove(); } catch (_) {}
      state.toasts.delete(id);
      emit("toast-dismissed", { id });
    };
    el.addEventListener("animationend", finish, { once: true });
    // Safety fallback
    setTimeout(() => {
      if (state.toasts.has(id)) finish();
    }, 400);
    return true;
  }

  function dismissAllToasts() {
    Array.from(state.toasts.keys()).forEach(dismissToast);
  }

  /* ==========================================================================
   * Notification Center DOM
   * ========================================================================*/

  function ensureCenter() {
    if (state.center && document.body.contains(state.center)) {
      return state.center;
    }
    const el = document.createElement("div");
    el.className = "wn-center";
    el.id = "wn-center";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Notification Center");
    el.hidden = true;
    document.body.appendChild(el);
    state.center = el;
    return el;
  }

  function buildCenter() {
    const el = ensureCenter();
    el.innerHTML = `
      <div class="wn-center-header">
        <div class="wn-center-title-row">
          <div class="wn-center-title">
            Notifications
            <span class="wn-center-unread-dot" aria-hidden="true"></span>
          </div>
          <div class="wn-center-actions">
            <button class="wn-center-btn" data-action="mark-all">Mark all read</button>
            <button class="wn-center-btn danger" data-action="clear-all">Clear all</button>
          </div>
        </div>
        <div class="wn-center-tabs" role="tablist">
          <button class="wn-center-tab active" data-filter="all" role="tab">
            All
            <span class="wn-center-tab-count" data-count="all">0</span>
          </button>
          <button class="wn-center-tab" data-filter="unread" role="tab">
            Unread
            <span class="wn-center-tab-count" data-count="unread">0</span>
          </button>
          <button class="wn-center-tab" data-filter="info" role="tab">Info</button>
          <button class="wn-center-tab" data-filter="success" role="tab">Success</button>
          <button class="wn-center-tab" data-filter="warning" role="tab">Warning</button>
          <button class="wn-center-tab" data-filter="error" role="tab">Error</button>
        </div>
      </div>
      <div class="wn-center-body" role="log"></div>
      <div class="wn-center-footer">
        <div class="wn-center-count-text" data-count-text>No notifications</div>
        <div class="wn-center-dnd">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;">
            <input type="checkbox" data-dnd />
            Do not disturb
          </label>
        </div>
      </div>
    `;

    // Wire buttons
    el.addEventListener("click", (e) => {
      const tab = e.target.closest(".wn-center-tab");
      if (tab) {
        const f = tab.getAttribute("data-filter");
        setFilter(f);
        return;
      }
      const btn = e.target.closest("[data-action]");
      if (btn) {
        const action = btn.getAttribute("data-action");
        if (action === "mark-all") markAllRead();
        else if (action === "clear-all") clearAll();
        return;
      }
    });

    const dnd = el.querySelector("[data-dnd]");
    if (dnd) {
      dnd.checked = !!state.prefs.doNotDisturb;
      dnd.addEventListener("change", () => {
        state.prefs.doNotDisturb = dnd.checked;
        savePrefs();
      });
    }

    return el;
  }

  function refreshCenter() {
    if (!state.center) return;
    // Update tabs' counts
    const unread = state.entries.filter((e) => !e.read).length;
    const all    = state.entries.length;
    const elAll     = state.center.querySelector('[data-count="all"]');
    const elUnread  = state.center.querySelector('[data-count="unread"]');
    if (elAll) elAll.textContent = String(all);
    if (elUnread) elUnread.textContent = String(unread);

    if (unread > 0) state.center.classList.add("has-unread");
    else state.center.classList.remove("has-unread");

    // Re-render list
    const body = state.center.querySelector(".wn-center-body");
    if (!body) return;

    let list = state.entries.slice();
    if (state.centerFilter === "unread") {
      list = list.filter((e) => !e.read);
    } else if (
      state.centerFilter === "info" ||
      state.centerFilter === "success" ||
      state.centerFilter === "warning" ||
      state.centerFilter === "error"
    ) {
      list = list.filter((e) => e.type === state.centerFilter);
    }

    if (list.length === 0) {
      body.innerHTML = `
        <div class="wn-center-empty">
          <div class="wn-center-empty-icon">🔕</div>
          <div><strong>All clear</strong></div>
          <div style="font-size:11px;opacity:.7;">You have no ${
            state.centerFilter === "all" ? "" : state.centerFilter + " "
          }notifications.</div>
        </div>
      `;
    } else {
      body.innerHTML = list.map(renderItemHtml).join("");
      // Attach handlers
      body.querySelectorAll(".wn-item").forEach((itemEl) => {
        const id = itemEl.getAttribute("data-id");
        itemEl.addEventListener("click", (e) => {
          if (e.target.closest(".wn-item-delete")) return;
          if (e.target.closest(".wn-item-action")) return;
          markAsRead(id);
          const entry = findEntry(id);
          if (entry && typeof entry.action === "function") {
            try { entry.action(entry); } catch (err) { console.error(err); }
          }
        });
        const del = itemEl.querySelector(".wn-item-delete");
        if (del) {
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteEntry(id);
          });
        }
        itemEl.querySelectorAll(".wn-item-action").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const which = btn.getAttribute("data-act");
            const entry = findEntry(id);
            if (!entry) return;
            const fn = which === "2" ? entry.action2 : entry.action;
            if (typeof fn === "function") {
              try { fn(entry); } catch (err) { console.error(err); }
            }
            markAsRead(id);
          });
        });
      });
    }

    // Footer count
    const ct = state.center.querySelector("[data-count-text]");
    if (ct) {
      if (all === 0) ct.textContent = "No notifications";
      else ct.textContent = all + " total · " + unread + " unread";
    }

    // Update active tab
    state.center.querySelectorAll(".wn-center-tab").forEach((t) => {
      if (t.getAttribute("data-filter") === state.centerFilter) t.classList.add("active");
      else t.classList.remove("active");
    });

    // Update bell badge
    updateBadge();
  }

  function renderItemHtml(entry) {
    const iconHtml = entry.appIcon
      ? escapeHtml(entry.appIcon)
      : escapeHtml(entry.icon);
    const unreadClass = entry.read ? "" : " unread";
    const actionsHtml = (entry.action || entry.action2) ? `
      <div class="wn-toast-actions" style="margin-top:4px;">
        ${entry.action ? `<button class="wn-toast-action wn-item-action primary" data-act="1">${escapeHtml(entry.actionLabel || "Open")}</button>` : ""}
        ${entry.action2 ? `<button class="wn-toast-action wn-item-action" data-act="2">${escapeHtml(entry.actionLabel2 || "Dismiss")}</button>` : ""}
      </div>
    ` : "";

    return `
      <div class="wn-item wn-${escapeHtml(entry.type)}${unreadClass}" data-id="${escapeHtml(entry.id)}" title="${escapeHtml(formatFullTime(entry.ts))}">
        <div class="wn-item-icon">${iconHtml}</div>
        <div class="wn-item-content">
          <div class="wn-item-head">
            <div class="wn-item-title">${escapeHtml(entry.title)}</div>
            <div class="wn-item-time">${escapeHtml(formatTime(entry.ts))}</div>
          </div>
          ${entry.body ? `<div class="wn-item-body">${linkify(entry.body)}</div>` : ""}
          <div class="wn-item-app">${escapeHtml(entry.appName || "System")}</div>
          ${actionsHtml}
        </div>
        <button class="wn-item-delete" aria-label="Delete" title="Delete">✕</button>
      </div>
    `;
  }

  function setFilter(filter) {
    state.centerFilter = filter || "all";
    refreshCenter();
  }

  function positionCenter() {
    if (!state.center) return;
    const el = state.center;
    const vp = { w: window.innerWidth, h: window.innerHeight };
    // Align bottom-right of bell or tray
    const anchor = state.bellEl || document.getElementById("tray-notifications");
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      el.style.right  = Math.max(8, vp.w - r.right) + "px";
      el.style.bottom = Math.max(8, vp.h - r.top + 8) + "px";
    } else {
      el.style.right = "8px";
      el.style.bottom = "60px";
    }
  }

  function openCenter() {
    buildCenter();
    refreshCenter();
    state.center.hidden = false;
    state.center.classList.remove("wn-out");
    positionCenter();
    state.centerOpen = true;
    // Outside-click dismiss
    setTimeout(() => {
      document.addEventListener("mousedown", onOutsideClick, true);
      document.addEventListener("keydown", onEscClose, true);
    }, 0);
    emit("center-opened", {});
  }

  function closeCenter() {
    if (!state.centerOpen || !state.center) return;
    const el = state.center;
    el.classList.add("wn-out");
    const finish = () => {
      el.hidden = true;
      el.classList.remove("wn-out");
    };
    el.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 240);
    state.centerOpen = false;
    document.removeEventListener("mousedown", onOutsideClick, true);
    document.removeEventListener("keydown", onEscClose, true);
    emit("center-closed", {});
  }

  function toggleCenter() {
    if (state.centerOpen) closeCenter();
    else openCenter();
  }

  function onOutsideClick(e) {
    if (!state.centerOpen || !state.center) return;
    if (state.center.contains(e.target)) return;
    if (state.bellEl && state.bellEl.contains(e.target)) return;
    const tray = document.getElementById("tray-notifications");
    if (tray && tray.contains(e.target)) return;
    closeCenter();
  }

  function onEscClose(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCenter();
    }
  }

  /* ==========================================================================
   * Badge management
   * ========================================================================*/

  function ensureBadge() {
    const tray = document.getElementById("tray-notifications");
    if (!tray) return null;
    state.bellEl = tray;
    let badge = tray.querySelector(".wn-bell-badge");
    if (!badge) {
      // Remove the built-in taskbar badge — we take over.
      const legacy = tray.querySelector("#tray-badge");
      if (legacy) legacy.remove();

      badge = document.createElement("span");
      badge.className = "wn-bell-badge";
      badge.hidden = true;
      tray.style.position = tray.style.position || "relative";
      tray.appendChild(badge);
    }
    state.badgeEl = badge;
    return badge;
  }

  function updateBadge() {
    const badge = state.badgeEl || ensureBadge();
    if (!badge) return;
    const unread = state.entries.filter((e) => !e.read).length;
    if (unread <= 0) {
      badge.hidden = true;
      badge.textContent = "0";
    } else {
      badge.hidden = false;
      badge.textContent = unread > 99 ? "99+" : String(unread);
    }
  }

  function ringBell() {
    if (!state.bellEl) return;
    state.bellEl.classList.remove("wn-bell-ringing");
    // Force reflow
    void state.bellEl.offsetWidth;
    state.bellEl.classList.add("wn-bell-ringing");
    setTimeout(() => {
      state.bellEl && state.bellEl.classList.remove("wn-bell-ringing");
    }, 700);
  }

  /* ==========================================================================
   * Public operations
   * ========================================================================*/

  function send(options) {
    const entry = makeEntry(options);
    addToLog(entry);

    if (state.prefs.enabled && !entry.silent) {
      showToast(entry);
      ringBell();
    }
    refreshCenter();
    updateBadge();
    emit("sent", { entry });
    return entry.id;
  }

  function info(title, body, opts) {
    return send(Object.assign({ title, body, type: TYPES.INFO }, opts || {}));
  }

  function success(title, body, opts) {
    return send(Object.assign({ title, body, type: TYPES.SUCCESS }, opts || {}));
  }

  function warning(title, body, opts) {
    return send(Object.assign({ title, body, type: TYPES.WARNING }, opts || {}));
  }

  function error(title, body, opts) {
    return send(Object.assign({ title, body, type: TYPES.ERROR }, opts || {}));
  }

  function neutral(title, body, opts) {
    return send(Object.assign({ title, body, type: TYPES.NEUTRAL }, opts || {}));
  }

  function markAsRead(id) {
    const e = findEntry(id);
    if (!e) return false;
    if (e.read) return false;
    e.read = true;
    scheduleSave();
    refreshCenter();
    updateBadge();
    emit("read", { id });
    return true;
  }

  function markAllRead() {
    let changed = 0;
    state.entries.forEach((e) => {
      if (!e.read) { e.read = true; changed++; }
    });
    if (changed > 0) {
      scheduleSave();
      refreshCenter();
      updateBadge();
      emit("read-all", { count: changed });
    }
    return changed;
  }

  function deleteEntry(id) {
    const ok = removeFromLog(id);
    if (ok) {
      refreshCenter();
      updateBadge();
      emit("deleted", { id });
    }
    return ok;
  }

  function clearAll() {
    const n = state.entries.length;
    state.entries = [];
    scheduleSave();
    refreshCenter();
    updateBadge();
    emit("cleared", { count: n });
    return n;
  }

  function getUnread() {
    return state.entries.filter((e) => !e.read);
  }

  function getAll() {
    return state.entries.slice();
  }

  function setEnabled(on) {
    state.prefs.enabled = !!on;
    savePrefs();
    if (!state.prefs.enabled) {
      dismissAllToasts();
    }
  }

  function setDoNotDisturb(on) {
    state.prefs.doNotDisturb = !!on;
    savePrefs();
    const dnd = state.center && state.center.querySelector("[data-dnd]");
    if (dnd) dnd.checked = !!on;
  }

  function setPrefs(patch) {
    Object.assign(state.prefs, patch || {});
    savePrefs();
  }

  function getPrefs() {
    return Object.assign({}, state.prefs);
  }

  /* ==========================================================================
   * App sender helpers
   *
   * These helpers give each app a friendly default appName / appIcon so the
   * notification log shows a clear origin.
   * ========================================================================*/

  function appSender(appName, appIcon) {
    return {
      info(title, body, opts)    { return send(Object.assign({ title, body, type: TYPES.INFO,    appName, appIcon }, opts || {})); },
      success(title, body, opts) { return send(Object.assign({ title, body, type: TYPES.SUCCESS, appName, appIcon }, opts || {})); },
      warning(title, body, opts) { return send(Object.assign({ title, body, type: TYPES.WARNING, appName, appIcon }, opts || {})); },
      error(title, body, opts)   { return send(Object.assign({ title, body, type: TYPES.ERROR,   appName, appIcon }, opts || {})); },
      send(opts)                 { return send(Object.assign({ appName, appIcon }, opts || {})); },
    };
  }

  /* ==========================================================================
   * Wiring to other apps (observe global events)
   * ========================================================================*/

  function wireFileSystemEvents() {
    if (!window.FileSystem || typeof window.FileSystem.on !== "function") return;
    // Do not spam — only emit for explicit Ctrl+S style saves reported via custom events.
    // We observe "fs:change" with reason "writeFile" from user actions.
    // To avoid noise we batch / debounce.
    let recentWrites = [];
    let flushTimer = null;

    window.FileSystem.on((name, detail) => {
      if (name !== "fs:change" || !detail) return;
      if (detail.reason !== "writeFile") return;
      if (!detail.path) return;
      // Ignore writes to our own log
      if (detail.path.indexOf("/.notifications/") === 0) return;
      // Ignore writes from widgets & aria auto-save
      if (detail.path.indexOf("/.widgets/") === 0) return;
      if (detail.path.indexOf("/.aria/") === 0) return;
      if (detail.silent) return;

      // Only surface saves explicitly marked by apps
      if (!detail.announce) return;

      recentWrites.push(detail.path);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => {
        if (recentWrites.length === 1) {
          send({
            title: "File saved",
            body: recentWrites[0],
            type: TYPES.SUCCESS,
            appName: detail.appName || "File System",
            appIcon: "💾",
            duration: 2500,
          });
        } else if (recentWrites.length > 1) {
          send({
            title: recentWrites.length + " files saved",
            body: recentWrites.slice(0, 3).join("\n") + (recentWrites.length > 3 ? "\n…" : ""),
            type: TYPES.SUCCESS,
            appName: "File System",
            appIcon: "💾",
            duration: 3000,
          });
        }
        recentWrites = [];
        flushTimer = null;
      }, 250);
    });
  }

  function wireTaskbarBell() {
    const tray = document.getElementById("tray-notifications");
    if (!tray) return;
    ensureBadge();
    // Replace default click handler (taskbar's toggleNC) with ours.
    // Use capture to override.
    tray.addEventListener("click", (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      toggleCenter();
    }, true);
  }

  function reposition() {
    if (state.centerOpen) positionCenter();
  }

  /* ==========================================================================
   * Dev / test helper
   * ========================================================================*/

  function demoSamples() {
    const samples = [
      { title: "Welcome to WebOS", body: "Your notification center is ready.", type: "info",    appName: "System", appIcon: "✨" },
      { title: "Theme updated",    body: "Forest theme applied.",              type: "success", appName: "Settings", appIcon: "⚙" },
      { title: "Low disk space",   body: "You have 8% free on /.",             type: "warning", appName: "Disk",    appIcon: "💽" },
    ];
    samples.forEach((s, i) => setTimeout(() => send(s), 500 + i * 350));
  }

  /* ==========================================================================
   * Keyboard shortcuts
   *   Ctrl+Shift+N  →  toggle Notification Center
   * ========================================================================*/

  function wireShortcuts() {
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "n" || e.key === "N")) {
        const tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        toggleCenter();
      }
    }, true);
  }

  /* ==========================================================================
   * Periodic refresh (for relative times)
   * ========================================================================*/

  function startTimeRefreshLoop() {
    setInterval(() => {
      if (state.centerOpen) refreshCenter();
    }, 30000);
  }

  /* ==========================================================================
   * Init
   * ========================================================================*/

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    loadPrefs();
    loadEntries();

    // Make sure DOM containers exist
    ensureToastStack();

    // Defer until taskbar is ready to wire the bell
    const tryWire = () => {
      if (document.getElementById("tray-notifications")) {
        wireTaskbarBell();
        wireFileSystemEvents();
      } else {
        setTimeout(tryWire, 80);
      }
    };
    tryWire();

    wireShortcuts();
    startTimeRefreshLoop();

    // Reposition on resize
    window.addEventListener("resize", reposition);

    console.log(
      "%c[WebOS]%c Notifications ready (%d entries)",
      "color:#06b6d4;font-weight:bold", "color:inherit",
      state.entries.length
    );

    emit("ready", { entries: state.entries.length });
  }

  /* ==========================================================================
   * Grouping & smart dedupe
   * ========================================================================*/

  function findDuplicateWithinWindow(title, body, appName, windowMs) {
    const cutoff = now() - (windowMs || 4000);
    for (let i = 0; i < state.entries.length; i++) {
      const e = state.entries[i];
      if (e.ts < cutoff) break;
      if (e.title === title && e.body === body && e.appName === appName) {
        return e;
      }
    }
    return null;
  }

  function sendDedupe(options) {
    const o = options || {};
    if (o.dedupeWindow !== false) {
      const dup = findDuplicateWithinWindow(
        o.title || "Notification",
        o.body || "",
        o.appName || "System",
        typeof o.dedupeWindow === "number" ? o.dedupeWindow : 4000
      );
      if (dup) {
        dup.ts = now();
        dup.read = false;
        dup.count = (dup.count || 1) + 1;
        scheduleSave();
        refreshCenter();
        updateBadge();
        return dup.id;
      }
    }
    return send(options);
  }

  /* ==========================================================================
   * Batched notifications — collect many rapid events into one summary
   * ========================================================================*/

  const batchers = new Map();

  function batch(key, options, flushMs) {
    if (!batchers.has(key)) {
      batchers.set(key, {
        key,
        items: [],
        timer: null,
        options: options || {},
        flushMs: flushMs || 1500,
      });
    }
    const b = batchers.get(key);
    b.items.push(options);
    if (b.timer) clearTimeout(b.timer);
    b.timer = setTimeout(() => flushBatch(key), b.flushMs);
  }

  function flushBatch(key) {
    const b = batchers.get(key);
    if (!b) return;
    batchers.delete(key);
    const n = b.items.length;
    if (n === 0) return;
    if (n === 1) {
      send(b.items[0]);
      return;
    }
    // Merge into summary
    const first = b.items[0];
    send({
      title: first.title + " (x" + n + ")",
      body: b.items.map((x) => x.body || "").filter(Boolean).slice(0, 3).join("\n")
             + (n > 3 ? "\n…" : ""),
      type: first.type,
      appName: first.appName,
      appIcon: first.appIcon,
      duration: first.duration,
    });
  }

  /* ==========================================================================
   * Query helpers
   * ========================================================================*/

  function countByType(type) {
    if (!type) return state.entries.length;
    return state.entries.filter((e) => e.type === type).length;
  }

  function countUnread() {
    return state.entries.reduce((n, e) => n + (e.read ? 0 : 1), 0);
  }

  function search(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return state.entries.slice();
    return state.entries.filter((e) =>
      (e.title && e.title.toLowerCase().includes(q)) ||
      (e.body && e.body.toLowerCase().includes(q)) ||
      (e.appName && e.appName.toLowerCase().includes(q))
    );
  }

  function getByApp(appName) {
    if (!appName) return [];
    return state.entries.filter((e) => e.appName === appName);
  }

  function removeByApp(appName) {
    if (!appName) return 0;
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => e.appName !== appName);
    const removed = before - state.entries.length;
    if (removed > 0) {
      scheduleSave();
      refreshCenter();
      updateBadge();
      emit("app-cleared", { appName, count: removed });
    }
    return removed;
  }

  /* ==========================================================================
   * Export / import (for Settings app backup)
   * ========================================================================*/

  function exportLog() {
    return JSON.stringify({
      version: 1,
      exportedAt: now(),
      prefs: state.prefs,
      entries: state.entries,
    }, null, 2);
  }

  function importLog(json) {
    try {
      const obj = typeof json === "string" ? JSON.parse(json) : json;
      if (!obj || !Array.isArray(obj.entries)) return false;
      state.entries = obj.entries.slice(0, MAX_STORED);
      if (obj.prefs) Object.assign(state.prefs, obj.prefs);
      scheduleSave();
      savePrefs();
      refreshCenter();
      updateBadge();
      return true;
    } catch (e) {
      console.warn("[Notifications] import failed:", e);
      return false;
    }
  }

  /* ==========================================================================
   * Expose API
   * ========================================================================*/

  const api = {
    // Lifecycle
    init,
    // Send
    send, sendDedupe, info, success, warning, error, neutral, batch,
    // Management
    markAsRead, markAllRead, deleteEntry,
    clear: clearAll, clearAll,
    getUnread, getAll, search, getByApp, removeByApp,
    countByType, countUnread,
    exportLog, importLog,
    // Center
    openCenter, closeCenter, toggleCenter,
    setFilter,
    // Toasts
    dismissToast, dismissAllToasts,
    // Prefs
    setEnabled, setDoNotDisturb, setPrefs, getPrefs,
    // Events
    on,
    // App helpers
    appSender,
    // Dev
    demoSamples,
    // Constants
    TYPES,
  };

  window.Notifications = api;

  // Auto-init
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


/* ============================================================================
 * ----------------------------------------------------------------------------
 * INTEGRATION LAYER — wire events from other apps into Notifications.
 *
 * The helpers below attach to global app APIs if present so apps do not need
 * to import anything explicitly. Everything is optional and guarded.
 * ----------------------------------------------------------------------------
 * ==========================================================================*/

(function () {
  "use strict";

  const N = () => window.Notifications;

  function waitFor(test, cb, maxMs) {
    const start = Date.now();
    const tick = () => {
      if (test()) return cb();
      if (Date.now() - start > (maxMs || 8000)) return;
      setTimeout(tick, 100);
    };
    tick();
  }

  /* --------------------------------------------------------------------------
   * TEXT EDITOR (NoteForge) — announce on Ctrl+S
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "s" && e.key !== "S") return;
      // Only surface if a text-editor-looking window is focused
      const active = document.activeElement;
      if (!active) return;
      const host = active.closest && active.closest(".window");
      if (!host) return;
      const appId = host.dataset && host.dataset.appId;
      if (!appId) return;
      if (appId !== "notepad" && appId !== "textEditor" && appId !== "noteforge") return;
      // Give the editor a tick to actually save
      setTimeout(() => {
        if (window.Notifications) {
          window.Notifications.success("File saved", "", {
            appName: "NoteForge",
            appIcon: "📝",
            duration: 1800,
          });
        }
      }, 80);
    }, true);
  });

  /* --------------------------------------------------------------------------
   * TERMINAL — announce long command completion
   * (Terminal app can call Notifications directly; we expose a helper so it
   * does not need to duplicate the sender boilerplate.)
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    if (!window.TerminalNotify) {
      window.TerminalNotify = {
        commandComplete(cmd, duration) {
          if (!window.Notifications) return;
          if (typeof duration === "number" && duration < 1500) return; // only long-running
          window.Notifications.success(
            "Command completed",
            `\`${cmd}\` finished in ${Math.round((duration || 0) / 1000)}s`,
            { appName: "Terminal", appIcon: "💻", duration: 2500 }
          );
        },
        commandFailed(cmd, err) {
          if (!window.Notifications) return;
          window.Notifications.error(
            "Command failed",
            `${cmd}\n${err || ""}`,
            { appName: "Terminal", appIcon: "💻", duration: 3500 }
          );
        },
      };
    }
  });

  /* --------------------------------------------------------------------------
   * BROWSER — fake download complete
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    if (!window.BrowserNotify) {
      window.BrowserNotify = {
        downloadComplete(filename) {
          if (!window.Notifications) return;
          window.Notifications.success(
            "Download complete",
            filename || "File ready",
            {
              appName: "Browser",
              appIcon: "🌐",
              duration: 4000,
              actionLabel: "Open Folder",
              action: () => {
                if (window.WindowManager && window.WindowManager.openApp) {
                  window.WindowManager.openApp("filemanager", { startPath: "/Downloads" });
                }
              },
            }
          );
        },
      };
    }
  });

  /* --------------------------------------------------------------------------
   * ARIA — response ready (used by aria.js)
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    if (!window.AriaNotify) {
      window.AriaNotify = {
        responseReady(preview) {
          if (!window.Notifications) return;
          window.Notifications.info(
            "ARIA response ready",
            preview || "",
            {
              appName: "ARIA",
              appIcon: "🤖",
              duration: 3500,
              actionLabel: "Open ARIA",
              action: () => {
                if (window.WindowManager && window.WindowManager.openApp) {
                  window.WindowManager.openApp("aria");
                }
              },
            }
          );
        },
      };
    }
  });

  /* --------------------------------------------------------------------------
   * APP STORE — install complete
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    if (!window.AppStoreNotify) {
      window.AppStoreNotify = {
        installed(appName) {
          if (!window.Notifications) return;
          window.Notifications.success(
            "App installed",
            `${appName || "App"} is ready to use.`,
            {
              appName: "OsStore",
              appIcon: "🛍",
              duration: 3500,
            }
          );
        },
        uninstalled(appName) {
          if (!window.Notifications) return;
          window.Notifications.neutral(
            "App removed",
            `${appName || "App"} has been uninstalled.`,
            { appName: "OsStore", appIcon: "🛍", duration: 2500 }
          );
        },
        updated(appName, version) {
          if (!window.Notifications) return;
          window.Notifications.info(
            "App updated",
            `${appName} → v${version}`,
            { appName: "OsStore", appIcon: "🛍", duration: 2800 }
          );
        },
      };
    }
  });

  /* --------------------------------------------------------------------------
   * SETTINGS — settings saved
   * ------------------------------------------------------------------------*/
  waitFor(() => !!window.Notifications, () => {
    if (!window.SettingsNotify) {
      window.SettingsNotify = {
        saved(section) {
          if (!window.Notifications) return;
          window.Notifications.success(
            "Settings saved",
            section ? `Section: ${section}` : "",
            { appName: "Settings", appIcon: "⚙", duration: 1800 }
          );
        },
      };
    }
  });
})();
