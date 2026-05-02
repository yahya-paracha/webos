/* ============================================================================
 * WebOS — boot.js
 * ----------------------------------------------------------------------------
 * Drives the boot sequence:
 *   - Animates the boot screen for ~5 seconds
 *   - Steps through fake loading messages (kernel, FS, display, etc.)
 *   - Updates the progress bar
 *   - Fades out and reveals the desktop when done
 *   - Initializes subsystems (theme/wm/taskbar/start/desktop) in order
 *   - Public API on window.WebOSBoot
 * ==========================================================================*/

(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   * Config — boot timeline (sums to ~5 seconds)
   * ------------------------------------------------------------------------*/
  // Day 7 polish: 2 additional boot steps + BIOS pre-screen.
  const CONFIG = Object.freeze({
    TOTAL_MS: 6200,
    BIOS_MS:  1000,                  // BIOS pre-screen duration
    STEPS: [
      { idx: 0, at: 200,  duration: 700,  label: "Initializing kernel…",         progress: 12 },
      { idx: 1, at: 900,  duration: 700,  label: "Mounting virtual filesystem…",  progress: 26 },
      { idx: 2, at: 1600, duration: 700,  label: "Loading display server…",      progress: 40 },
      { idx: 3, at: 2300, duration: 700,  label: "Compositing window manager…",  progress: 54 },
      { idx: 4, at: 3000, duration: 700,  label: "Starting network services…",   progress: 68 },
      { idx: 5, at: 3700, duration: 700,  label: "Initializing notification daemon…", progress: 80 },
      { idx: 6, at: 4400, duration: 700,  label: "Starting widget compositor…",  progress: 92 },
      { idx: 7, at: 5300, duration: 700,  label: "Welcome to WebOS",             progress: 100 },
    ],
    FADE_OUT_MS: 700,
    DESKTOP_REVEAL_DELAY_MS: 200,
    BUILD_PREFIX: "build",
  });

  /* --------------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------------*/
  const state = {
    initialized:    false,
    running:        false,
    startTime:      0,
    bootEl:         null,
    progressBarEl:  null,
    stepEls:        [],
    timers:         [],
    onCompleteCbs:  [],
  };

  /* --------------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------------*/
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

  function emit(name, detail) {
    try { document.dispatchEvent(new CustomEvent("webos:" + name, { detail })); } catch (_) {}
  }

  function clearTimers() {
    state.timers.forEach((t) => clearTimeout(t));
    state.timers = [];
  }

  function timer(fn, delay) {
    const t = setTimeout(() => {
      try { fn(); } catch (e) { console.error(e); }
    }, delay);
    state.timers.push(t);
    return t;
  }

  function buildString() {
    const d = new Date();
    const pad = (n) => (n < 10 ? "0" : "") + n;
    return CONFIG.BUILD_PREFIX +
      "." + d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate());
  }

  /* --------------------------------------------------------------------------
   * DOM hookups
   * ------------------------------------------------------------------------*/
  function cacheDOM() {
    state.bootEl        = document.getElementById("boot-screen");
    state.progressBarEl = document.getElementById("boot-progress-bar");
    state.stepEls       = $$("#boot-steps .boot-step");

    const buildEl = document.getElementById("boot-build");
    if (buildEl) buildEl.textContent = buildString();
  }

  /* --------------------------------------------------------------------------
   * Visual updates
   * ------------------------------------------------------------------------*/
  function setProgress(pct) {
    if (!state.progressBarEl) return;
    state.progressBarEl.style.width = pct + "%";
    const pr = state.bootEl && state.bootEl.querySelector("[role='progressbar']");
    if (pr) pr.setAttribute("aria-valuenow", String(Math.round(pct)));
    // Day 7 polish: percentage counter rendered alongside progress bar
    let pctEl = document.getElementById("boot-percent");
    if (!pctEl && state.bootEl) {
      const container = state.bootEl.querySelector(".boot-progress-wrap")
                     || state.bootEl.querySelector(".boot-progress")
                     || state.bootEl.querySelector(".boot-container")
                     || state.bootEl;
      pctEl = document.createElement("div");
      pctEl.id = "boot-percent";
      pctEl.style.cssText = "font-family:'JetBrains Mono',monospace;font-size:12px;opacity:.75;margin-top:6px;text-align:center;letter-spacing:1px;color:rgba(255,255,255,0.85);";
      container.appendChild(pctEl);
    }
    if (pctEl) pctEl.textContent = Math.round(pct) + "%";
  }

  function activateStep(i) {
    state.stepEls.forEach((el, j) => {
      if (j < i)      { el.classList.remove("active"); el.classList.add("done"); }
      else if (j === i){ el.classList.remove("done");   el.classList.add("active"); }
      else            { el.classList.remove("active","done"); }
    });
  }

  function completeAllSteps() {
    state.stepEls.forEach((el) => {
      el.classList.remove("active");
      el.classList.add("done");
    });
  }

  /* --------------------------------------------------------------------------
   * Subsystem readiness
   * ------------------------------------------------------------------------*/
  function ensureSubsystems() {
    // Each module auto-inits on script load, but call init() defensively
    try { window.ThemeEngine    && window.ThemeEngine.init    && window.ThemeEngine.init();    } catch (e) { console.error(e); }
    try { window.WindowManager  && window.WindowManager.init  && window.WindowManager.init();  } catch (e) { console.error(e); }
    try { window.Taskbar        && window.Taskbar.init        && window.Taskbar.init();        } catch (e) { console.error(e); }
    try { window.StartMenu      && window.StartMenu.init      && window.StartMenu.init();      } catch (e) { console.error(e); }
    try { window.Desktop        && window.Desktop.init        && window.Desktop.init();        } catch (e) { console.error(e); }
  }

  /* --------------------------------------------------------------------------
   * Reveal desktop
   * ------------------------------------------------------------------------*/
  function revealDesktop() {
    const desk = document.getElementById("desktop");
    if (!desk) return;
    desk.setAttribute("aria-hidden", "false");
    // animate in
    requestAnimationFrame(() => desk.classList.add("visible"));
  }

  function fadeOutBoot() {
    if (!state.bootEl) return;
    state.bootEl.classList.add("boot-fadeout");
    timer(() => {
      if (state.bootEl) state.bootEl.hidden = true;
    }, CONFIG.FADE_OUT_MS + 60);
  }

  /* --------------------------------------------------------------------------
   * Welcome toast — fired once after boot finishes
   * ------------------------------------------------------------------------*/
  function showWelcome() {
    if (window.Taskbar && window.Taskbar.pushNotification) {
      window.Taskbar.pushNotification({
        title: "Welcome to WebOS",
        body:  "Your desktop is ready. Right-click anywhere to explore.",
        kind:  "success",
        duration: 4500,
      });
    }
  }

  /* --------------------------------------------------------------------------
   * Public — run the full sequence
   * ------------------------------------------------------------------------*/
  function run() {
    if (state.running) return;
    state.running   = true;
    state.startTime = performance.now();

    // If a previous run left things visible, reset
    if (state.bootEl) {
      state.bootEl.hidden = false;
      state.bootEl.style.display = "";
      state.bootEl.style.opacity = "";
      state.bootEl.classList.remove("boot-fadeout");
    }
    const desk = document.getElementById("desktop");
    if (desk) {
      desk.classList.remove("visible");
      desk.setAttribute("aria-hidden", "true");
    }

    // Day 7 polish: show BIOS pre-screen before main boot screen
    if (window.Polish && typeof window.Polish.showBiosScreen === "function") {
      if (state.bootEl) state.bootEl.style.opacity = "0";
      window.Polish.showBiosScreen(CONFIG.BIOS_MS).then(function () {
        if (state.bootEl) state.bootEl.style.opacity = "";
        _runBootSequence();
      });
      return;
    }
    _runBootSequence();
  }

  function _runBootSequence() {
    cacheDOM();
    setProgress(0);
    state.stepEls.forEach((el) => el.classList.remove("active","done"));

    emit("bootstart", { at: Date.now() });

    // Schedule each step
    CONFIG.STEPS.forEach((step) => {
      timer(() => {
        activateStep(step.idx);
        // Smoothly tween progress to step.progress
        animateProgress(step.progress, Math.min(step.duration, 500));
        emit("bootstep", { idx: step.idx, label: step.label, progress: step.progress });
      }, step.at);
    });

    // Final completion
    timer(() => {
      completeAllSteps();
      setProgress(100);

      // Initialize all subsystems just before reveal
      ensureSubsystems();

      timer(() => {
        fadeOutBoot();
        timer(() => {
          revealDesktop();
          state.running = false;
          emit("bootcomplete", { duration: performance.now() - state.startTime });
          showWelcome();
          // Run completion callbacks
          state.onCompleteCbs.splice(0).forEach((cb) => {
            try { cb(); } catch (e) { console.error(e); }
          });
        }, CONFIG.DESKTOP_REVEAL_DELAY_MS);
      }, 280);
    }, CONFIG.TOTAL_MS);
  }

  /* --------------------------------------------------------------------------
   * Smooth progress animation between checkpoints
   * ------------------------------------------------------------------------*/
  function animateProgress(target, durationMs) {
    if (!state.progressBarEl) return;
    const start = parseFloat(state.progressBarEl.style.width || "0") || 0;
    const delta = target - start;
    const t0 = performance.now();
    const dur = Math.max(60, durationMs || 300);

    function step(now) {
      const t = Math.min(1, (now - t0) / dur);
      const eased = easeOutCubic(t);
      const cur = start + delta * eased;
      setProgress(cur);
      if (t < 1 && state.running) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  /* --------------------------------------------------------------------------
   * Skip / abort
   * ------------------------------------------------------------------------*/
  function skip() {
    if (!state.running) return;
    clearTimers();
    completeAllSteps();
    setProgress(100);
    ensureSubsystems();
    fadeOutBoot();
    timer(() => {
      revealDesktop();
      state.running = false;
      emit("bootcomplete", { duration: performance.now() - state.startTime, skipped: true });
      showWelcome();
      state.onCompleteCbs.splice(0).forEach((cb) => { try { cb(); } catch (_) {} });
    }, 200);
  }

  function bindSkipShortcut() {
    document.addEventListener("keydown", function onKey(e) {
      // Esc or Enter during boot skips
      if (!state.running) return;
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); skip(); }
    });
    // Click anywhere on boot to skip
    document.addEventListener("click", function onClick(e) {
      if (!state.running) return;
      if (state.bootEl && state.bootEl.contains(e.target)) skip();
    });
  }

  /* --------------------------------------------------------------------------
   * Public API
   * ------------------------------------------------------------------------*/
  function onComplete(cb) {
    if (typeof cb !== "function") return;
    if (!state.running && state.initialized) {
      try { cb(); } catch (_) {}
      return;
    }
    state.onCompleteCbs.push(cb);
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    cacheDOM();
    bindSkipShortcut();
    // Auto-run unless something explicitly disables it
    run();
  }

  window.WebOSBoot = {
    init,
    run,
    skip,
    onComplete,
    isRunning: () => state.running,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
