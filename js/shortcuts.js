/* ============================================================================
 * WebOS — shortcuts.js
 * ----------------------------------------------------------------------------
 * Global keyboard shortcuts for WebOS. Loaded after windowManager.js so it can
 * reach into WindowManager / StartMenu / Notifications / ContextMenu without
 * additional wiring.
 *
 *   - Win (Meta) / Ctrl+Escape  : Toggle Start Menu
 *   - Alt+F4                    : Close active window
 *   - Win+D                     : Minimize all windows (show desktop) / toggle
 *   - Win+M                     : Minimize active window
 *   - Escape                    : Close topmost modal / menu / popup
 *
 * All shortcuts work fully offline — no backend required.
 * Exposes window.Shortcuts for introspection and manual dispatch.
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------*/

  // Some browsers block Meta-key chord detection inside the OS. For our
  // desktop-in-browser use-case we treat the Meta/Super key as the "Win" key.
  function isWinKey(e) { return !!e.metaKey; }

  // True when the user is typing into a text field. We still allow Alt+F4 /
  // Escape / Win-chords inside inputs, but we don't want a single Escape
  // press (inside a search box etc.) to fight with the field's own handling
  // beyond closing the topmost popup.
  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function wm()   { return window.WindowManager; }
  function sm()   { return window.StartMenu; }
  function ntf()  { return window.Notifications; }
  function ctx()  { return window.ContextMenu; }

  /* --------------------------------------------------------------------------
   * Individual shortcut actions
   * ------------------------------------------------------------------------*/

  function toggleStart() {
    const s = sm();
    if (s && typeof s.toggle === "function") s.toggle();
  }

  function closeActiveWindow() {
    const W = wm();
    if (!W) return false;
    const focused = W.getFocused && W.getFocused();
    if (!focused) return false;
    W.closeWindow(focused.id);
    return true;
  }

  function minimizeActiveWindow() {
    const W = wm();
    if (!W) return false;
    const focused = W.getFocused && W.getFocused();
    if (!focused) return false;
    W.minimizeWindow(focused.id);
    return true;
  }

  function showDesktop() {
    const W = wm();
    if (!W) return false;
    // Prefer the built-in "show desktop" toggle so pressing Win+D twice
    // restores the previous window layout (like Windows).
    if (typeof W.toggleShowDesktop === "function") {
      W.toggleShowDesktop();
    } else if (typeof W.minimizeAll === "function") {
      W.minimizeAll();
    }
    return true;
  }

  /* --------------------------------------------------------------------------
   * Escape — close topmost modal / menu / popup
   * ------------------------------------------------------------------------*/

  // Order matters: we close the most recently opened layer first.
  function closeTopmostPopup() {
    // 1. Any custom WebOS context menu opened via ContextMenu.show()
    const C = ctx();
    if (C && typeof C.closeAll === "function") {
      // Only close if one is actually open (avoid no-op churn).
      if (document.querySelector(".webos-ctx")) {
        C.closeAll();
        return true;
      }
    }

    // 2. Floating / transient menus inserted directly into the DOM
    const floating = document.querySelector(
      "#sm-app-menu, #__desktop_icon_menu__"
    );
    if (floating) {
      try { floating.remove(); } catch (_) {}
      return true;
    }

    // 3. The two legacy context menus defined in index.html
    const legacyMenus = ["window-context-menu", "context-menu"];
    for (let i = 0; i < legacyMenus.length; i++) {
      const el = document.getElementById(legacyMenus[i]);
      if (el && !el.hidden) { el.hidden = true; return true; }
    }

    // 4. Notification panel
    const N = ntf();
    if (N && typeof N.closeCenter === "function") {
      // The notifications module tracks its own state but there's no public
      // isOpen() — detect via the DOM.
      const panel = document.getElementById("wn-center");
      if (panel && !panel.hidden) { N.closeCenter(); return true; }
    }

    // 5. Start Menu
    const S = sm();
    if (S && typeof S.isOpen === "function" && S.isOpen()) {
      S.close();
      return true;
    }

    // 6. Generic overlays (lock / shutdown / restart)
    const overlay = document.getElementById("__webos_overlay__");
    if (overlay) { try { overlay.remove(); } catch (_) {} return true; }

    return false;
  }

  /* --------------------------------------------------------------------------
   * Master key handler
   * ------------------------------------------------------------------------*/

  function onKeyDown(e) {
    // Escape — always allowed, even inside inputs, because users expect it
    // to dismiss menus/dialogs. If nothing is open we do nothing so the
    // input's own Escape handling still runs.
    if (e.key === "Escape") {
      if (closeTopmostPopup()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Alt+F4 — close active window. Intercept regardless of focus, because
    // the browser itself doesn't act on Alt+F4 inside tabs.
    if (e.altKey && (e.key === "F4" || e.code === "F4")) {
      if (closeActiveWindow()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // Ctrl+Escape — toggle Start Menu (a no-Meta alternative for keyboards
    // without a Super key). We already handle Escape above, but that only
    // fires when no chord is active.
    if (e.ctrlKey && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      toggleStart();
      return;
    }

    // Meta / Win key chords
    if (isWinKey(e)) {
      // Win+D — show desktop
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        e.stopPropagation();
        showDesktop();
        return;
      }
      // Win+M — minimize active window
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        e.stopPropagation();
        minimizeActiveWindow();
        return;
      }
    }

    // Bare Meta (Super) press — toggle Start Menu. Many browsers don't fire
    // keydown for the Meta key by itself on Windows; where they do, this
    // gives users the familiar Win-key behaviour.
    if (e.key === "Meta" && !e.ctrlKey && !e.altKey && !e.shiftKey && !isTypingTarget(e.target)) {
      e.preventDefault();
      toggleStart();
      return;
    }
  }

  /* --------------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------------*/

  function init() {
    // Capture phase so we can pre-empt per-window handlers where needed
    // (e.g. Alt+F4 inside an app's own <input>).
    document.addEventListener("keydown", onKeyDown, true);
    console.log(
      "%c[WebOS]%c Global shortcuts ready",
      "color:#a855f7;font-weight:bold", "color:inherit"
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  /* --------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------*/
  window.Shortcuts = {
    toggleStart,
    closeActiveWindow,
    minimizeActiveWindow,
    showDesktop,
    closeTopmostPopup,
  };
})();
