/* ============================================================================
 * OsPaint — WebOS Paint application
 * ----------------------------------------------------------------------------
 * A self-contained, multi-layer raster paint app with a Photoshop-flavored UI.
 * Lives entirely in this file and apps/paint/paint.{html,css}.
 *
 * Highlights
 *   - Multi-layer compositing (each layer = its own offscreen <canvas>)
 *   - Tools: pencil, brush, eraser, fill bucket, eyedropper, text, move,
 *            select-rect, zoom, hand, rect/ellipse/line/triangle/polygon/star
 *   - Color: HSL wheel + RGB sliders + HEX input + alpha + 30-slot palette
 *            and recently-used row
 *   - Layer system: visibility, lock, opacity, blend mode, drag-reorder,
 *                   add/dup/del, merge down, merge visible, flatten
 *   - History: 50-step undo/redo (one entry per stroke / commit)
 *   - Zoom 10–3200% with Ctrl+wheel; Space-drag pan; fit/100% shortcuts
 *   - File ops: New, Open from FS, Save PNG, Save .ospaint JSON, Export PNG
 *   - Keyboard shortcuts (Photoshop-flavored)
 *   - Self-registers with WindowManager, advertises canOpen for image files
 *
 * Coding style
 *   - One IIFE; no globals leak except `window.OsPaint`
 *   - JSDoc-flavored comments on the shape of important objects
 *   - Defensive: never throws on malformed FS input; all dialogs are sync
 *     against a single modal at a time.
 * ========================================================================= */
(function () {
  "use strict";

  /* =========================================================================
   * 0.  CONSTANTS & SMALL UTILITIES
   * ====================================================================== */
  const APP_ID       = "paint";
  const APP_TITLE    = "OsPaint";
  const APP_ICON     = "🎨";
  const APP_CATEGORY = "Creativity";

  const DEFAULT_W       = 800;
  const DEFAULT_H       = 600;
  const MIN_ZOOM        = 0.1;
  const MAX_ZOOM        = 32;
  const HISTORY_LIMIT   = 50;
  const PALETTE_SLOTS   = 30;
  const RECENT_SLOTS    = 12;
  const THUMB_W         = 32;
  const THUMB_H         = 28;
  const ZOOM_STEPS = [
    0.10, 0.125, 0.166, 0.25, 0.333, 0.5, 0.666, 1, 1.5,
    2, 3, 4, 6, 8, 12, 16, 24, 32
  ];

  const IMG_EXTS  = ["png","jpg","jpeg","gif","svg","bmp","webp"];
  const PROJ_EXTS = ["ospaint"];

  const BLEND_MODES = [
    { id: "source-over", label: "Normal" },
    { id: "multiply",    label: "Multiply" },
    { id: "screen",      label: "Screen" },
    { id: "overlay",     label: "Overlay" },
    { id: "darken",      label: "Darken" },
    { id: "lighten",     label: "Lighten" },
  ];

  const DEFAULT_PALETTE = [
    "#000000","#3f3f3f","#7f7f7f","#bfbfbf","#ffffff","#7f1d1d",
    "#ef4444","#f97316","#f59e0b","#eab308","#84cc16","#22c55e",
    "#10b981","#14b8a6","#06b6d4","#0ea5e9","#3b82f6","#6366f1",
    "#8b5cf6","#a855f7","#d946ef","#ec4899","#f43f5e","#5b3a29",
    "#a16207","#65a30d","#0f766e","#1e3a8a","#4c1d95","#831843"
  ];

  /* small math helpers ---------------------------------------------------- */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp  = (a, b, t)   => a + (b - a) * t;
  const TAU   = Math.PI * 2;

  function uid(prefix) { return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 9); }

  function getExt(p) {
    if (!p) return "";
    const i = p.lastIndexOf(".");
    return i < 0 ? "" : p.slice(i + 1).toLowerCase();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* color conversions ----------------------------------------------------- */
  function rgbToHex(r, g, b, a) {
    function h(v) { const s = clamp(v|0, 0, 255).toString(16); return s.length === 1 ? "0" + s : s; }
    let out = "#" + h(r) + h(g) + h(b);
    if (a != null && a < 1) out += h(Math.round(a * 255));
    return out;
  }

  function hexToRgb(hex) {
    if (!hex || typeof hex !== "string") return { r: 0, g: 0, b: 0, a: 1 };
    let h = hex.replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.substr(0, 2), 16) || 0;
    const g = parseInt(h.substr(2, 2), 16) || 0;
    const b = parseInt(h.substr(4, 2), 16) || 0;
    let a = 1;
    if (h.length === 8) a = (parseInt(h.substr(6, 2), 16) || 0) / 255;
    return { r, g, b, a };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s; const l = (max + min) / 2;
    if (max === min) { h = 0; s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s, 0, 100) / 100;
    l = clamp(l, 0, 100) / 100;
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    function hue2rgb(t) {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }
    return {
      r: Math.round(hue2rgb(h + 1/3) * 255),
      g: Math.round(hue2rgb(h)       * 255),
      b: Math.round(hue2rgb(h - 1/3) * 255),
    };
  }

  function parseColorString(s) {
    if (!s) return null;
    s = String(s).trim().toLowerCase();
    if (s.startsWith("#")) return hexToRgb(s);
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
      return { r: parts[0]|0, g: parts[1]|0, b: parts[2]|0, a: parts.length > 3 ? parts[3] : 1 };
    }
    return null;
  }

  /* ============================================================
   * 1. APP CLASS
   * ============================================================ */
  class OsPaint {
    /**
     * @param {HTMLElement} root - window body
     * @param {object}      opts - { openPath?: string }
     */
    constructor(root, opts) {
      this.root = root;
      this.opts = opts || {};
      this.id   = uid("paint");
      this._unmounted = false;

      // Document state
      this.doc = {
        name:    "Untitled",
        path:    null,
        width:   DEFAULT_W,
        height:  DEFAULT_H,
        layers:  [],          /* [{ id,name,visible,locked,opacity,blend,canvas,thumbDirty }] */
        active:  -1,          /* index into layers[] */
        bg:      "transparent",
      };

      // View state
      this.view = {
        zoom:        1,
        scrollLeft:  0,
        scrollTop:   0,
      };

      // Tool state — the current settings carried per-tool but applied globally
      this.tool = "pencil";
      this.opt = {
        size:       6,
        hardness:   80,
        opacity:    100,
        flow:       100,
        smoothing:  0,
        eraserHardness: 100,
        shapeFill:    true,
        shapeStroke:  true,
        shapeStrokeW: 2,
        shapeSides:   6,
        shapePoints:  5,
        shapeInner:   50,
        textFont:     "Inter",
        textSize:     32,
        textBold:     false,
        textItalic:   false,
        textUnder:    false,
        selectFeather: 0,
        selectMode:    "new",
        fillTolerance: 32,
        fillContig:    true,
        eyeSample:     "all",
        moveSnap:      false,
      };

      // Color state
      this.color = {
        fg: { r: 0, g: 0, b: 0, a: 1 },
        bg: { r: 255, g: 255, b: 255, a: 1 },
        recent: [],
        palette: DEFAULT_PALETTE.slice(0, PALETTE_SLOTS),
      };
      while (this.color.palette.length < PALETTE_SLOTS) this.color.palette.push(null);

      // History
      this.history = { stack: [], index: -1 };

      // Selection (rectangular)
      this.selection = null; /* { x, y, w, h, mask?: ImageData, clipboard?: ImageData } */
      this.clipboard = null;

      // Interaction state
      this.input = {
        drawing: false,
        dragging: false,
        space: false,
        panStart: null,
        last: null,
        startPoint: null,
        path: [],
        snapshot: null, // ImageData of the active layer at stroke start
        textBox: null,
        moveStartImage: null,
        moveOrigin: null,
        selectStart: null,
        selectionDragOffset: null,
        selectionMoveImg: null,
      };

      // Cached DOM references (filled in mount())
      this.dom = {};

      // Bindings (used in addEventListener so we can remove later)
      this._handlers = [];
    }

    /* --------------------------------------------------------------------
     * 1.1  MOUNT / UNMOUNT
     * ----------------------------------------------------------------- */
    mount() {
      this.root.innerHTML = "";
      // Try to fetch the HTML template; fall back to inline.
      this._loadTemplateInto(this.root).then(() => {
        this._cacheDom();
        this._initCanvas();
        this._addBaseLayer();
        this._buildPalette();
        this._wireEvents();
        this._wireMenubar();
        this._wireOptionsBar();
        this._wireColorPicker();
        this._wireToolbar();
        this._wireKeyboard();
        this._renderLayers();
        this._renderSwatches();
        this._renderCpFromColor();
        this._setTool("pencil");
        this._fitInitial();
        this._render();
        this._pushHistory("init");

        // Auto-open file from launch options
        if (this.opts && this.opts.openPath) {
          this._openFromPath(this.opts.openPath);
        }
      }).catch((err) => {
        console.error("[OsPaint] mount failed:", err);
        this.root.innerHTML = "<div style='padding:24px;color:#fff;'>Failed to mount OsPaint: " + escapeHtml(err && err.message) + "</div>";
      });
    }

    destroy() {
      this._unmounted = true;
      this._handlers.forEach(([t, e, fn, opt]) => t.removeEventListener(e, fn, opt));
      this._handlers.length = 0;
      this.root.innerHTML = "";
    }

    on(target, ev, fn, opt) {
      if (!target) return;
      target.addEventListener(ev, fn, opt);
      this._handlers.push([target, ev, fn, opt]);
    }

    /* --------------------------------------------------------------------
     * 1.2  TEMPLATE LOADER
     * ----------------------------------------------------------------- */
    _loadTemplateInto(root) {
      return new Promise((resolve, reject) => {
        const url = "apps/paint/paint.html";
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 400) {
            root.innerHTML = xhr.responseText;
            this._injectStylesheet("apps/paint/paint.css");
            resolve();
          } else {
            // Embedded fallback: build a minimal HTML structure so the app
            // remains functional if the file isn't reachable.
            root.innerHTML = this._fallbackTemplate();
            this._injectStylesheet("apps/paint/paint.css");
            resolve();
          }
        };
        xhr.onerror = () => {
          root.innerHTML = this._fallbackTemplate();
          this._injectStylesheet("apps/paint/paint.css");
          resolve();
        };
        xhr.send();
      });
    }

    _injectStylesheet(href) {
      if (document.querySelector('link[data-paint-css]')) return;
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.dataset.paintCss = "1";
      document.head.appendChild(l);
    }

    _fallbackTemplate() {
      // Very small fallback so the app at least runs even if HTML missing.
      return '<div class="paint-app" data-paint-root>' +
        '<div class="paint-menubar" data-paint-menubar></div>' +
        '<div class="paint-optionsbar" data-paint-optionsbar></div>' +
        '<div class="paint-workspace">' +
          '<div class="paint-toolbar" data-paint-toolbar></div>' +
          '<div class="paint-canvas-host" data-paint-canvas-host>' +
            '<div class="paint-viewport" data-paint-viewport>' +
              '<div class="paint-stage" data-paint-stage>' +
                '<canvas data-paint-display></canvas>' +
                '<canvas class="paint-overlay" data-paint-overlay></canvas>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="paint-rightcol">' +
            '<div data-paint-layer-list></div>' +
          '</div>' +
        '</div>' +
        '<div class="paint-statusbar"></div>' +
      '</div>';
    }

    /* --------------------------------------------------------------------
     * 1.3  DOM CACHE
     * ----------------------------------------------------------------- */
    _cacheDom() {
      const r = this.root;
      const $  = (s) => r.querySelector(s);
      const $$ = (s) => Array.from(r.querySelectorAll(s));
      this.dom = {
        appRoot:          $('[data-paint-root]'),
        menubar:          $('[data-paint-menubar]'),
        optionsbar:       $('[data-paint-optionsbar]'),
        toolbar:          $('[data-paint-toolbar]'),
        canvasHost:       $('[data-paint-canvas-host]'),
        viewport:         $('[data-paint-viewport]'),
        stage:            $('[data-paint-stage]'),
        display:          $('[data-paint-display]'),
        overlay:          $('[data-paint-overlay]'),
        textInput:        $('[data-paint-text-input]'),
        rulerH:           $('[data-paint-ruler-h]'),
        rulerV:           $('[data-paint-ruler-v]'),

        sizeRange:        $('[data-paint-size-range]'),
        sizeNum:          $('[data-paint-size-num]'),
        hardnessRange:    $('[data-paint-hardness-range]'),
        hardnessVal:      $('[data-paint-hardness-val]'),
        opacityRange:     $('[data-paint-opacity-range]'),
        opacityVal:       $('[data-paint-opacity-val]'),
        flowRange:        $('[data-paint-flow-range]'),
        flowVal:          $('[data-paint-flow-val]'),
        smoothingRange:   $('[data-paint-smoothing-range]'),
        smoothingVal:     $('[data-paint-smoothing-val]'),
        eraserHardness:   $('[data-paint-eraser-hardness]'),
        eraserHardnessVal:$('[data-paint-eraser-hardness-val]'),

        shapeFill:        $('[data-paint-shape-fill]'),
        shapeStroke:      $('[data-paint-shape-stroke]'),
        shapeStrokeW:     $('[data-paint-shape-strokew]'),
        shapeSides:       $('[data-paint-shape-sides]'),
        shapePoints:      $('[data-paint-shape-points]'),
        shapeInner:       $('[data-paint-shape-inner]'),
        shapeInnerVal:    $('[data-paint-shape-inner-val]'),

        textFont:         $('[data-paint-text-font]'),
        textSize:         $('[data-paint-text-size]'),
        textBold:         $('[data-paint-text-bold]'),
        textItalic:       $('[data-paint-text-italic]'),
        textUnder:        $('[data-paint-text-under]'),

        selectFeather:    $('[data-paint-select-feather]'),
        selectMode:       $('[data-paint-select-mode]'),

        fillTolerance:    $('[data-paint-fill-tolerance]'),
        fillToleranceVal: $('[data-paint-fill-tolerance-val]'),
        fillContig:       $('[data-paint-fill-contig]'),

        eyeSample:        $('[data-paint-eye-sample]'),
        moveSnap:         $('[data-paint-move-snap]'),

        cpCanvas:         $('[data-paint-cp-canvas]'),
        cpMarker:         $('[data-paint-cp-marker]'),
        cpH:              $('[data-paint-cp-h]'),
        cpHNum:           $('[data-paint-cp-h-num]'),
        cpS:              $('[data-paint-cp-s]'),
        cpSNum:           $('[data-paint-cp-s-num]'),
        cpL:              $('[data-paint-cp-l]'),
        cpLNum:           $('[data-paint-cp-l-num]'),
        cpR:              $('[data-paint-cp-r]'),
        cpRNum:           $('[data-paint-cp-r-num]'),
        cpG:              $('[data-paint-cp-g]'),
        cpGNum:           $('[data-paint-cp-g-num]'),
        cpB:              $('[data-paint-cp-b]'),
        cpBNum:           $('[data-paint-cp-b-num]'),
        cpA:              $('[data-paint-cp-a]'),
        cpANum:           $('[data-paint-cp-a-num]'),
        cpHex:            $('[data-paint-cp-hex]'),
        cpWheel:          $('[data-paint-cp-wheel]'),

        palette:          $('[data-paint-palette]'),
        recentRow:        $('[data-paint-recent-row]'),

        swatchFg:         $('[data-paint-fg]'),
        swatchBg:         $('[data-paint-bg]'),
        swatchSwap:       $('[data-paint-swap]'),
        swatchReset:      $('[data-paint-reset-colors]'),

        layerBlend:       $('[data-paint-layer-blend]'),
        layerOpacity:     $('[data-paint-layer-opacity]'),
        layerOpacityVal:  $('[data-paint-layer-opacity-val]'),
        layerList:        $('[data-paint-layer-list]'),

        statusCoord:      $('[data-paint-status-coord]'),
        statusSize:       $('[data-paint-status-size]'),
        statusZoom:       $('[data-paint-status-zoom]'),
        statusColorSwatch:$('[data-paint-status-color-swatch]'),
        statusColorHex:   $('[data-paint-status-color-hex]'),
        statusTool:       $('[data-paint-status-tool]'),
        statusMem:        $('[data-paint-status-mem]'),

        currentToolIco:   $('[data-paint-current-tool-ico]'),
        currentToolLabel: $('[data-paint-current-tool-label]'),

        docName:          $('[data-paint-doc-name]'),

        modalRoot:        $('[data-paint-modal-root]'),
        floatingMenu:     $('[data-paint-floating-menu]'),
        fileInput:        $('[data-paint-file-input]'),

        toolButtons:      $$('[data-tool]'),
      };
    }

    /* --------------------------------------------------------------------
     * 1.4  CANVAS / LAYER MANAGEMENT
     * ----------------------------------------------------------------- */
    _initCanvas() {
      const d = this.dom;
      d.display.width  = this.doc.width;
      d.display.height = this.doc.height;
      d.overlay.width  = this.doc.width;
      d.overlay.height = this.doc.height;
      this._applyZoomCss();
    }

    _addBaseLayer() {
      this._addLayer({ name: "Background", initialFill: "transparent" });
      this.doc.active = 0;
    }

    _addLayer(opts) {
      opts = opts || {};
      const c = document.createElement("canvas");
      c.width  = this.doc.width;
      c.height = this.doc.height;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      if (opts.initialFill && opts.initialFill !== "transparent") {
        ctx.fillStyle = opts.initialFill;
        ctx.fillRect(0, 0, c.width, c.height);
      }
      const layer = {
        id:       uid("layer"),
        name:     opts.name || ("Layer " + (this.doc.layers.length + 1)),
        visible:  true,
        locked:   false,
        opacity:  100,
        blend:    "source-over",
        canvas:   c,
        thumbDirty: true,
      };
      // insert ABOVE the active layer
      const insertAt = this.doc.active < 0 ? this.doc.layers.length : this.doc.active + 1;
      this.doc.layers.splice(insertAt, 0, layer);
      this.doc.active = insertAt;
      return layer;
    }

    _activeLayer() { return this.doc.layers[this.doc.active] || null; }
    _ctxFor(layer) { return layer.canvas.getContext("2d"); }

    _setActiveLayer(idx) {
      idx = clamp(idx, 0, this.doc.layers.length - 1);
      if (idx === this.doc.active) return;
      this.doc.active = idx;
      this._renderLayers();
      this._render();
    }

    _deleteLayer(idx) {
      if (this.doc.layers.length <= 1) return;
      if (idx == null) idx = this.doc.active;
      this.doc.layers.splice(idx, 1);
      this.doc.active = clamp(this.doc.active, 0, this.doc.layers.length - 1);
      this._pushHistory("delete-layer");
      this._renderLayers();
      this._render();
    }

    _duplicateLayer(idx) {
      const src = this.doc.layers[idx];
      if (!src) return;
      const c = document.createElement("canvas");
      c.width = src.canvas.width;
      c.height = src.canvas.height;
      c.getContext("2d").drawImage(src.canvas, 0, 0);
      const dup = {
        id: uid("layer"),
        name: src.name + " copy",
        visible: src.visible,
        locked: src.locked,
        opacity: src.opacity,
        blend: src.blend,
        canvas: c,
        thumbDirty: true,
      };
      this.doc.layers.splice(idx + 1, 0, dup);
      this.doc.active = idx + 1;
      this._pushHistory("dup-layer");
      this._renderLayers();
      this._render();
    }

    _moveLayer(from, to) {
      if (from === to || from < 0 || to < 0 || from >= this.doc.layers.length || to >= this.doc.layers.length) return;
      const [item] = this.doc.layers.splice(from, 1);
      this.doc.layers.splice(to, 0, item);
      this.doc.active = to;
      this._pushHistory("reorder");
      this._renderLayers();
      this._render();
    }

    _mergeDown(idx) {
      if (idx == null) idx = this.doc.active;
      if (idx <= 0) return;
      const above = this.doc.layers[idx];
      const below = this.doc.layers[idx - 1];
      if (!above || !below) return;
      const ctx = below.canvas.getContext("2d");
      ctx.save();
      ctx.globalAlpha = clamp(above.opacity / 100, 0, 1);
      ctx.globalCompositeOperation = above.blend;
      ctx.drawImage(above.canvas, 0, 0);
      ctx.restore();
      this.doc.layers.splice(idx, 1);
      this.doc.active = idx - 1;
      below.thumbDirty = true;
      this._pushHistory("merge-down");
      this._renderLayers();
      this._render();
    }

    _mergeVisible() {
      const visible = this.doc.layers.filter((l) => l.visible);
      if (visible.length < 2) return;
      const merged = document.createElement("canvas");
      merged.width = this.doc.width;
      merged.height = this.doc.height;
      const ctx = merged.getContext("2d");
      visible.forEach((l) => {
        ctx.save();
        ctx.globalAlpha = clamp(l.opacity / 100, 0, 1);
        ctx.globalCompositeOperation = l.blend;
        ctx.drawImage(l.canvas, 0, 0);
        ctx.restore();
      });
      // Replace lowest visible with merged result, remove the others
      const lowestIdx = this.doc.layers.indexOf(visible[0]);
      this.doc.layers[lowestIdx].canvas = merged;
      this.doc.layers[lowestIdx].opacity = 100;
      this.doc.layers[lowestIdx].blend = "source-over";
      this.doc.layers[lowestIdx].thumbDirty = true;
      this.doc.layers[lowestIdx].name = "Merged";
      // Remove the other visibles (excluding lowestIdx)
      for (let i = this.doc.layers.length - 1; i >= 0; i--) {
        if (i === lowestIdx) continue;
        if (this.doc.layers[i].visible) this.doc.layers.splice(i, 1);
      }
      this.doc.active = this.doc.layers.indexOf(this.doc.layers[lowestIdx]);
      this._pushHistory("merge-visible");
      this._renderLayers();
      this._render();
    }

    _flatten() {
      if (this.doc.layers.length < 2) return;
      const out = document.createElement("canvas");
      out.width = this.doc.width;
      out.height = this.doc.height;
      const ctx = out.getContext("2d");
      this.doc.layers.forEach((l) => {
        if (!l.visible) return;
        ctx.save();
        ctx.globalAlpha = clamp(l.opacity / 100, 0, 1);
        ctx.globalCompositeOperation = l.blend;
        ctx.drawImage(l.canvas, 0, 0);
        ctx.restore();
      });
      this.doc.layers = [{
        id: uid("layer"),
        name: "Background",
        visible: true,
        locked: false,
        opacity: 100,
        blend: "source-over",
        canvas: out,
        thumbDirty: true,
      }];
      this.doc.active = 0;
      this._pushHistory("flatten");
      this._renderLayers();
      this._render();
    }

    /* --------------------------------------------------------------------
     * 1.5  COMPOSITE / RENDER
     * ----------------------------------------------------------------- */
    _render() {
      const d = this.dom;
      const ctx = d.display.getContext("2d");
      ctx.clearRect(0, 0, d.display.width, d.display.height);
      this.doc.layers.forEach((l) => {
        if (!l.visible) return;
        ctx.save();
        ctx.globalAlpha = clamp(l.opacity / 100, 0, 1);
        ctx.globalCompositeOperation = l.blend;
        ctx.drawImage(l.canvas, 0, 0);
        ctx.restore();
      });
      this._renderOverlay();
      this._updateStatus();
    }

    _renderOverlay() {
      const d = this.dom;
      const ctx = d.overlay.getContext("2d");
      ctx.clearRect(0, 0, d.overlay.width, d.overlay.height);
      // Draw selection marching ants
      if (this.selection) {
        ctx.save();
        ctx.lineWidth = 1 / this.view.zoom;
        ctx.strokeStyle = "#000";
        ctx.setLineDash([4 / this.view.zoom, 4 / this.view.zoom]);
        ctx.strokeRect(
          this.selection.x + 0.5,
          this.selection.y + 0.5,
          this.selection.w,
          this.selection.h
        );
        ctx.strokeStyle = "#fff";
        ctx.lineDashOffset = 4 / this.view.zoom;
        ctx.strokeRect(
          this.selection.x + 0.5,
          this.selection.y + 0.5,
          this.selection.w,
          this.selection.h
        );
        ctx.restore();
      }
    }

    _applyZoomCss() {
      const z = this.view.zoom;
      const w = Math.round(this.doc.width * z);
      const h = Math.round(this.doc.height * z);
      const d = this.dom;
      if (!d.stage || !d.display || !d.overlay) return;
      d.display.style.width  = w + "px";
      d.display.style.height = h + "px";
      d.overlay.style.width  = w + "px";
      d.overlay.style.height = h + "px";
      d.stage.style.width  = w + "px";
      d.stage.style.height = h + "px";
      this._updateStatus();
    }

    _setZoom(z, cx, cy) {
      const old = this.view.zoom;
      const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
      if (next === old) return;
      const vp = this.dom.viewport;
      // Maintain focal point
      const rect = vp.getBoundingClientRect();
      const px = cx == null ? rect.width / 2 : cx;
      const py = cy == null ? rect.height / 2 : cy;
      const docX = (vp.scrollLeft + px) / old;
      const docY = (vp.scrollTop  + py) / old;
      this.view.zoom = next;
      this._applyZoomCss();
      vp.scrollLeft = docX * next - px;
      vp.scrollTop  = docY * next - py;
      this._render();
    }

    _zoomToStep(dir, cx, cy) {
      const z = this.view.zoom;
      let target;
      if (dir > 0) {
        target = ZOOM_STEPS.find((s) => s > z + 1e-6) || MAX_ZOOM;
      } else {
        const reversed = ZOOM_STEPS.slice().reverse();
        target = reversed.find((s) => s < z - 1e-6) || MIN_ZOOM;
      }
      this._setZoom(target, cx, cy);
    }

    _fitInitial() {
      const vp = this.dom.viewport;
      if (!vp) return;
      const r = vp.getBoundingClientRect();
      const padding = 80;
      const sx = (r.width - padding) / this.doc.width;
      const sy = (r.height - padding) / this.doc.height;
      const fit = Math.min(sx, sy, 1);
      this._setZoom(fit > 0 ? fit : 1);
    }

    _fitToWindow() { this._fitInitial(); }
    _zoom100() { this._setZoom(1); }

    /* --------------------------------------------------------------------
     * 1.6  MENUBAR
     * ----------------------------------------------------------------- */
    _wireMenubar() {
      const items = this.root.querySelectorAll('[data-menu]');
      items.forEach((it) => {
        this.on(it, "click", (ev) => {
          ev.stopPropagation();
          const id = it.dataset.menu;
          this._openMenu(id, it);
        });
      });
      this.on(document, "click", (ev) => {
        if (!ev.target.closest('[data-paint-floating-menu]')) {
          this._closeMenu();
        }
      });
    }

    _menuDef(id) {
      const _ = (lbl, kbd, action, opt) => Object.assign({ label: lbl, kbd, action }, opt);
      const sep = { sep: true };
      switch (id) {
        case "file": return [
          _("New…",                "Ctrl+N",       () => this._dialogNew()),
          _("Open…",               "Ctrl+O",       () => this._dialogOpen()),
          sep,
          _("Save",                "Ctrl+S",       () => this._save()),
          _("Save As…",            "Ctrl+Shift+S", () => this._dialogSaveAs()),
          _("Save Project (.ospaint)", "",         () => this._dialogSaveProject()),
          sep,
          _("Export PNG…",         "Ctrl+E",       () => this._dialogExportPNG()),
          _("Import Image…",       "",             () => this._importImage()),
        ];
        case "edit": return [
          _("Undo",       "Ctrl+Z",        () => this._undo()),
          _("Redo",       "Ctrl+Y",        () => this._redo()),
          sep,
          _("Cut",        "Ctrl+X",        () => this._editCut()),
          _("Copy",       "Ctrl+C",        () => this._editCopy()),
          _("Paste",      "Ctrl+V",        () => this._editPaste()),
          _("Delete",     "Del",           () => this._editDelete()),
          sep,
          _("Select All", "Ctrl+A",        () => this._selectAll()),
          _("Deselect",   "Ctrl+D",        () => this._deselect()),
          _("Invert Selection", "Shift+I", () => this._invertSelection()),
        ];
        case "image": return [
          _("Resize Canvas…",  "", () => this._dialogResize()),
          _("Rotate 90° CW",   "", () => this._rotateCanvas(90)),
          _("Rotate 90° CCW",  "", () => this._rotateCanvas(-90)),
          _("Rotate 180°",     "", () => this._rotateCanvas(180)),
          _("Flip Horizontal", "", () => this._flipCanvas("h")),
          _("Flip Vertical",   "", () => this._flipCanvas("v")),
          sep,
          _("Invert Colors",   "Ctrl+I", () => this._invertColors()),
          _("Grayscale",       "",       () => this._toGrayscale()),
        ];
        case "layer": return [
          _("New Layer",       "Ctrl+Shift+N", () => this._userAddLayer()),
          _("Duplicate Layer", "Ctrl+J",       () => this._duplicateLayer(this.doc.active)),
          _("Delete Layer",    "",             () => this._deleteLayer(this.doc.active)),
          sep,
          _("Merge Down",      "Ctrl+Shift+E", () => this._mergeDown(this.doc.active)),
          _("Merge Visible",   "Ctrl+Alt+E",   () => this._mergeVisible()),
          _("Flatten Image",   "",             () => this._flatten()),
        ];
        case "view": return [
          _("Zoom In",     "Ctrl++",     () => this._zoomToStep(+1)),
          _("Zoom Out",    "Ctrl+-",     () => this._zoomToStep(-1)),
          _("Fit Window",  "Ctrl+Shift+H", () => this._fitToWindow()),
          _("Actual Size", "Ctrl+1",     () => this._zoom100()),
        ];
        case "help": return [
          _("Keyboard Shortcuts", "", () => this._dialogShortcuts()),
          _("About OsPaint",      "", () => this._dialogAbout()),
        ];
      }
      return [];
    }

    _openMenu(id, anchor) {
      const def = this._menuDef(id);
      if (!def.length) return;
      const fm = this.dom.floatingMenu;
      fm.innerHTML = "";
      def.forEach((it) => {
        if (it.sep) {
          const s = document.createElement("div");
          s.className = "paint-fm-sep";
          fm.appendChild(s);
          return;
        }
        const el = document.createElement("div");
        el.className = "paint-fm-item";
        if (it.disabled) el.classList.add("disabled");
        el.innerHTML = '<span>' + escapeHtml(it.label) + '</span>' +
                       '<span class="paint-fm-kbd">' + escapeHtml(it.kbd || "") + '</span>';
        el.addEventListener("click", () => {
          this._closeMenu();
          if (it.action) it.action();
        });
        fm.appendChild(el);
      });
      const r = anchor.getBoundingClientRect();
      fm.style.left = r.left + "px";
      fm.style.top  = (r.bottom + 2) + "px";
      fm.hidden = false;
      anchor.classList.add("active");
      this._activeMenu = anchor;
    }

    _closeMenu() {
      const fm = this.dom.floatingMenu;
      if (!fm) return;
      fm.hidden = true;
      if (this._activeMenu) this._activeMenu.classList.remove("active");
      this._activeMenu = null;
    }

    /* --------------------------------------------------------------------
     * 1.7  OPTIONS BAR
     * ----------------------------------------------------------------- */
    _wireOptionsBar() {
      const d = this.dom;

      const bind2 = (range, num, key, suffix) => {
        if (!range || !num) return;
        const apply = (v) => {
          v = clamp(parseFloat(v) || 0, parseFloat(range.min), parseFloat(range.max));
          range.value = v;
          num.value   = v;
          this.opt[key] = v;
          this._updateOptionsBarLabels();
        };
        this.on(range, "input", () => apply(range.value));
        this.on(num,   "input", () => apply(num.value));
      };

      const bindRange = (range, valSpan, key, suffix) => {
        if (!range) return;
        const apply = (v) => {
          v = clamp(parseFloat(v) || 0, parseFloat(range.min), parseFloat(range.max));
          range.value = v;
          if (valSpan) valSpan.textContent = v + (suffix || "");
          this.opt[key] = v;
        };
        this.on(range, "input", () => apply(range.value));
      };

      bind2(d.sizeRange, d.sizeNum, "size");
      bindRange(d.hardnessRange, d.hardnessVal, "hardness", "%");
      bindRange(d.opacityRange,  d.opacityVal,  "opacity",  "%");
      bindRange(d.flowRange,     d.flowVal,     "flow",     "%");
      bindRange(d.smoothingRange,d.smoothingVal,"smoothing","%");
      bindRange(d.eraserHardness,d.eraserHardnessVal,"eraserHardness", "%");

      if (d.shapeFill)   this.on(d.shapeFill,   "change", () => this.opt.shapeFill   = d.shapeFill.checked);
      if (d.shapeStroke) this.on(d.shapeStroke, "change", () => this.opt.shapeStroke = d.shapeStroke.checked);
      if (d.shapeStrokeW) this.on(d.shapeStrokeW, "input", () => this.opt.shapeStrokeW = parseInt(d.shapeStrokeW.value, 10) || 1);
      if (d.shapeSides)  this.on(d.shapeSides,  "input",  () => this.opt.shapeSides   = clamp(parseInt(d.shapeSides.value, 10) || 3, 3, 32));
      if (d.shapePoints) this.on(d.shapePoints, "input",  () => this.opt.shapePoints  = clamp(parseInt(d.shapePoints.value,10) || 5, 3, 20));
      if (d.shapeInner)  this.on(d.shapeInner,  "input",  () => {
        this.opt.shapeInner = parseInt(d.shapeInner.value, 10) || 50;
        if (d.shapeInnerVal) d.shapeInnerVal.textContent = this.opt.shapeInner + "%";
      });

      if (d.textFont)   this.on(d.textFont,   "change", () => this.opt.textFont   = d.textFont.value);
      if (d.textSize)   this.on(d.textSize,   "input",  () => this.opt.textSize   = clamp(parseInt(d.textSize.value,10) || 12, 6, 400));
      if (d.textBold)   this.on(d.textBold,   "click",  () => { this.opt.textBold   = !this.opt.textBold;   d.textBold.classList.toggle("active",  this.opt.textBold); });
      if (d.textItalic) this.on(d.textItalic, "click",  () => { this.opt.textItalic = !this.opt.textItalic; d.textItalic.classList.toggle("active", this.opt.textItalic); });
      if (d.textUnder)  this.on(d.textUnder,  "click",  () => { this.opt.textUnder  = !this.opt.textUnder;  d.textUnder.classList.toggle("active",  this.opt.textUnder); });

      if (d.selectFeather) this.on(d.selectFeather, "input", () => this.opt.selectFeather = clamp(parseInt(d.selectFeather.value,10)||0, 0, 50));
      if (d.selectMode)    this.on(d.selectMode,    "change",() => this.opt.selectMode = d.selectMode.value);

      if (d.fillTolerance) this.on(d.fillTolerance, "input", () => {
        this.opt.fillTolerance = clamp(parseInt(d.fillTolerance.value,10)||0, 0, 255);
        if (d.fillToleranceVal) d.fillToleranceVal.textContent = this.opt.fillTolerance;
      });
      if (d.fillContig) this.on(d.fillContig, "change", () => this.opt.fillContig = d.fillContig.checked);

      if (d.eyeSample) this.on(d.eyeSample, "change", () => this.opt.eyeSample = d.eyeSample.value);
      if (d.moveSnap)  this.on(d.moveSnap,  "change", () => this.opt.moveSnap  = d.moveSnap.checked);

      this._updateOptionsBarLabels();
      this._updateOptionsBarVisibility();
    }

    _updateOptionsBarLabels() {
      const d = this.dom;
      if (d.hardnessVal) d.hardnessVal.textContent = this.opt.hardness + "%";
      if (d.opacityVal)  d.opacityVal.textContent  = this.opt.opacity  + "%";
      if (d.flowVal)     d.flowVal.textContent     = this.opt.flow     + "%";
      if (d.smoothingVal)d.smoothingVal.textContent= this.opt.smoothing+ "%";
      if (d.eraserHardnessVal) d.eraserHardnessVal.textContent = this.opt.eraserHardness + "%";
      if (d.fillToleranceVal) d.fillToleranceVal.textContent = this.opt.fillTolerance;
      if (d.shapeInnerVal) d.shapeInnerVal.textContent = this.opt.shapeInner + "%";
    }

    /**
     * Show / hide each option group based on the active tool.
     */
    _updateOptionsBarVisibility() {
      const t = this.tool;
      const d = this.dom;
      const map = {
        size:           ["pencil","brush","eraser"],
        hardness:       ["brush"],
        opacity:        ["pencil","brush","eraser","fill","rect","ellipse","line","triangle","polygon","star","text"],
        flow:           ["brush"],
        smoothing:      ["brush","pencil"],
        "eraser-hardness": ["eraser"],

        "shape-fill":   ["rect","ellipse","triangle","polygon","star"],
        "shape-stroke": ["rect","ellipse","line","triangle","polygon","star"],
        "shape-strokew":["rect","ellipse","line","triangle","polygon","star"],
        "shape-sides":  ["polygon"],
        "shape-points": ["star"],
        "shape-inner":  ["star"],

        "text-font":  ["text"],
        "text-size":  ["text"],
        "text-style": ["text"],

        "select-feather": ["select"],
        "select-mode":    ["select"],

        "fill-tolerance": ["fill"],
        "fill-contig":    ["fill"],

        "eye-sample":     ["eyedropper"],
        "move-snap":      ["move"],
      };
      this.root.querySelectorAll('.paint-option').forEach((el) => {
        const opt = el.dataset.option;
        const tools = map[opt];
        el.hidden = !(tools && tools.indexOf(t) !== -1);
      });
      // Hide all dividers, then re-show only those between visible groups
      const optionsbar = d.optionsbar;
      if (optionsbar) {
        const children = Array.from(optionsbar.children);
        children.forEach((c) => { if (c.classList.contains("paint-options-divider")) c.style.display = "none"; });
        // walk and show divider only between two visible siblings
        for (let i = 0; i < children.length; i++) {
          const c = children[i];
          if (!c.classList.contains("paint-options-divider")) continue;
          let hasPrev = false, hasNext = false;
          for (let j = i - 1; j >= 0; j--) {
            const cc = children[j];
            if (cc.classList.contains("paint-options-divider")) break;
            if (!cc.hidden && cc.style.display !== "none") { hasPrev = true; break; }
          }
          for (let j = i + 1; j < children.length; j++) {
            const cc = children[j];
            if (cc.classList.contains("paint-options-divider")) break;
            if (!cc.hidden && cc.style.display !== "none") { hasNext = true; break; }
          }
          c.style.display = (hasPrev && hasNext) ? "" : "none";
        }
      }

      if (d.currentToolIco) d.currentToolIco.textContent = TOOL_META[t] ? TOOL_META[t].icon : "•";
      if (d.currentToolLabel) d.currentToolLabel.textContent = TOOL_META[t] ? TOOL_META[t].label : t;
    }

    /* --------------------------------------------------------------------
     * 1.8  TOOLBAR
     * ----------------------------------------------------------------- */
    _wireToolbar() {
      this.dom.toolButtons.forEach((btn) => {
        this.on(btn, "click", () => this._setTool(btn.dataset.tool));
      });
      if (this.dom.swatchFg) this.on(this.dom.swatchFg, "click", () => this._activateSwatch("fg"));
      if (this.dom.swatchBg) this.on(this.dom.swatchBg, "click", () => this._activateSwatch("bg"));
      if (this.dom.swatchSwap)  this.on(this.dom.swatchSwap,  "click", () => this._swapColors());
      if (this.dom.swatchReset) this.on(this.dom.swatchReset, "click", () => this._resetColors());
    }

    _setTool(tool) {
      if (!TOOL_META[tool]) return;
      this.tool = tool;
      this.dom.toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
      if (this.dom.appRoot) this.dom.appRoot.dataset.tool = tool;
      this._updateOptionsBarVisibility();
      this._commitTextIfAny();
      this._updateStatus();
    }

    _activeSwatch = "fg";
    _activateSwatch(which) {
      this._activeSwatch = which;
      this._renderCpFromColor();
      this._renderSwatches();
    }

    _swapColors() {
      const t = this.color.fg;
      this.color.fg = this.color.bg;
      this.color.bg = t;
      this._renderSwatches();
      this._renderCpFromColor();
    }

    _resetColors() {
      this.color.fg = { r: 0,   g: 0,   b: 0,   a: 1 };
      this.color.bg = { r: 255, g: 255, b: 255, a: 1 };
      this._renderSwatches();
      this._renderCpFromColor();
    }

    _renderSwatches() {
      const d = this.dom;
      if (!d.swatchFg || !d.swatchBg) return;
      const fg = this.color.fg, bg = this.color.bg;
      d.swatchFg.style.background = "rgba(" + fg.r + "," + fg.g + "," + fg.b + "," + fg.a + ")";
      d.swatchBg.style.background = "rgba(" + bg.r + "," + bg.g + "," + bg.b + "," + bg.a + ")";
      d.swatchFg.classList.toggle("active", this._activeSwatch === "fg");
      d.swatchBg.classList.toggle("active", this._activeSwatch === "bg");
    }

    /* --------------------------------------------------------------------
     * 1.9  COLOR PICKER (HSL wheel + RGB sliders + HEX input)
     * ----------------------------------------------------------------- */
    _wireColorPicker() {
      const d = this.dom;
      if (d.cpCanvas) this._drawColorWheel();

      // HSL row sync -> color & UI
      const onHsl = () => {
        const h = parseFloat(d.cpH.value);
        const s = parseFloat(d.cpS.value);
        const l = parseFloat(d.cpL.value);
        const rgb = hslToRgb(h, s, l);
        const a = parseFloat(d.cpA.value) / 100;
        this._setActiveColor({ r: rgb.r, g: rgb.g, b: rgb.b, a });
        this._syncCpInputs("hsl");
      };
      const onRgb = () => {
        const r = parseInt(d.cpR.value, 10) || 0;
        const g = parseInt(d.cpG.value, 10) || 0;
        const b = parseInt(d.cpB.value, 10) || 0;
        const a = parseFloat(d.cpA.value) / 100;
        this._setActiveColor({ r, g, b, a });
        this._syncCpInputs("rgb");
      };
      const onHex = () => {
        const c = hexToRgb(d.cpHex.value);
        this._setActiveColor(c);
        this._syncCpInputs("hex");
      };
      const onA = () => {
        const c = this._activeColorObj();
        this._setActiveColor({ r: c.r, g: c.g, b: c.b, a: parseFloat(d.cpA.value) / 100 });
        if (d.cpANum) d.cpANum.value = d.cpA.value;
      };

      const bindPair = (slider, num, fn) => {
        if (!slider || !num) return;
        this.on(slider, "input", () => { num.value = slider.value; fn(); });
        this.on(num,    "input", () => { slider.value = num.value;  fn(); });
      };
      bindPair(d.cpH, d.cpHNum, onHsl);
      bindPair(d.cpS, d.cpSNum, onHsl);
      bindPair(d.cpL, d.cpLNum, onHsl);
      bindPair(d.cpR, d.cpRNum, onRgb);
      bindPair(d.cpG, d.cpGNum, onRgb);
      bindPair(d.cpB, d.cpBNum, onRgb);
      bindPair(d.cpA, d.cpANum, onA);
      if (d.cpHex) this.on(d.cpHex, "change", onHex);

      // Click on wheel
      if (d.cpCanvas) {
        const pickFromWheel = (ev) => {
          const r = d.cpCanvas.getBoundingClientRect();
          const x = ev.clientX - r.left;
          const y = ev.clientY - r.top;
          const ctx = d.cpCanvas.getContext("2d");
          const px = ctx.getImageData(clamp(x|0,0,d.cpCanvas.width-1), clamp(y|0,0,d.cpCanvas.height-1), 1, 1).data;
          if (px[3] === 0) return; // outside wheel
          this._setActiveColor({ r: px[0], g: px[1], b: px[2], a: this._activeColorObj().a });
          this._syncCpInputs("rgb");
          if (d.cpMarker) {
            d.cpMarker.style.left = x + "px";
            d.cpMarker.style.top  = y + "px";
          }
        };
        let dragging = false;
        this.on(d.cpCanvas, "mousedown", (ev) => { dragging = true; pickFromWheel(ev); });
        this.on(window,     "mouseup",   () => dragging = false);
        this.on(d.cpCanvas, "mousemove", (ev) => { if (dragging) pickFromWheel(ev); });
      }
    }

    _drawColorWheel() {
      const c = this.dom.cpCanvas;
      const ctx = c.getContext("2d");
      const w = c.width, h = c.height;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 2;
      const img = ctx.createImageData(w, h);
      const data = img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - cx, dy = y - cy;
          const r = Math.sqrt(dx*dx + dy*dy);
          const i = (y * w + x) * 4;
          if (r > R) { data[i+3] = 0; continue; }
          const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
          const sat = clamp(r / R, 0, 1) * 100;
          const rgb = hslToRgb(ang, sat, 50);
          data[i  ] = rgb.r;
          data[i+1] = rgb.g;
          data[i+2] = rgb.b;
          data[i+3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    _activeColorObj() {
      return this._activeSwatch === "bg" ? this.color.bg : this.color.fg;
    }

    _setActiveColor(c) {
      const cur = this._activeColorObj();
      Object.assign(cur, { r: clamp(c.r|0,0,255), g: clamp(c.g|0,0,255), b: clamp(c.b|0,0,255), a: clamp(c.a == null ? cur.a : c.a, 0, 1) });
      this._addRecent(rgbToHex(cur.r, cur.g, cur.b));
      this._renderSwatches();
      this._updateStatus();
    }

    _renderCpFromColor() { this._syncCpInputs("force"); }

    _syncCpInputs(source) {
      const d = this.dom;
      const c = this._activeColorObj();
      const hsl = rgbToHsl(c.r, c.g, c.b);
      if (source !== "hsl") {
        if (d.cpH)    d.cpH.value    = Math.round(hsl.h);
        if (d.cpHNum) d.cpHNum.value = Math.round(hsl.h);
        if (d.cpS)    d.cpS.value    = Math.round(hsl.s);
        if (d.cpSNum) d.cpSNum.value = Math.round(hsl.s);
        if (d.cpL)    d.cpL.value    = Math.round(hsl.l);
        if (d.cpLNum) d.cpLNum.value = Math.round(hsl.l);
      }
      if (source !== "rgb") {
        if (d.cpR)    d.cpR.value    = c.r;
        if (d.cpRNum) d.cpRNum.value = c.r;
        if (d.cpG)    d.cpG.value    = c.g;
        if (d.cpGNum) d.cpGNum.value = c.g;
        if (d.cpB)    d.cpB.value    = c.b;
        if (d.cpBNum) d.cpBNum.value = c.b;
      }
      if (source !== "hex") {
        if (d.cpHex) d.cpHex.value = rgbToHex(c.r, c.g, c.b);
      }
      if (d.cpA)    d.cpA.value    = Math.round(c.a * 100);
      if (d.cpANum) d.cpANum.value = Math.round(c.a * 100);
    }

    /* --------------------------------------------------------------------
     * 1.10  PALETTE
     * ----------------------------------------------------------------- */
    _buildPalette() {
      const d = this.dom;
      if (!d.palette) return;
      d.palette.innerHTML = "";
      for (let i = 0; i < PALETTE_SLOTS; i++) {
        const cell = document.createElement("div");
        cell.className = "paint-palette-cell";
        const c = this.color.palette[i];
        if (c) cell.style.background = c;
        else cell.classList.add("empty");
        cell.title = c || "Empty (right-click to save current color)";
        cell.dataset.idx = i;
        cell.addEventListener("click", () => {
          if (cell.classList.contains("empty")) {
            const cc = this._activeColorObj();
            const hex = rgbToHex(cc.r, cc.g, cc.b);
            this.color.palette[i] = hex;
            cell.style.background = hex;
            cell.classList.remove("empty");
            cell.title = hex;
          } else {
            this._setActiveColor(hexToRgb(this.color.palette[i]));
            this._syncCpInputs("force");
          }
        });
        cell.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const cc = this._activeColorObj();
          const hex = rgbToHex(cc.r, cc.g, cc.b);
          this.color.palette[i] = hex;
          cell.style.background = hex;
          cell.classList.remove("empty");
          cell.title = hex;
        });
        d.palette.appendChild(cell);
      }
      this._renderRecent();
    }

    _addRecent(hex) {
      if (!hex) return;
      const idx = this.color.recent.indexOf(hex);
      if (idx !== -1) this.color.recent.splice(idx, 1);
      this.color.recent.unshift(hex);
      if (this.color.recent.length > RECENT_SLOTS) this.color.recent.length = RECENT_SLOTS;
      this._renderRecent();
    }

    _renderRecent() {
      const r = this.dom.recentRow;
      if (!r) return;
      r.innerHTML = "";
      this.color.recent.forEach((hex) => {
        const c = document.createElement("div");
        c.className = "paint-recent-cell";
        c.style.background = hex;
        c.title = hex;
        c.addEventListener("click", () => {
          this._setActiveColor(hexToRgb(hex));
          this._syncCpInputs("force");
        });
        r.appendChild(c);
      });
    }

    /* --------------------------------------------------------------------
     * 1.11  LAYER PANEL
     * ----------------------------------------------------------------- */
    _renderLayers() {
      const d = this.dom;
      if (!d.layerList) return;
      d.layerList.innerHTML = "";

      // Render top-down (Photoshop-style: top-most first)
      const layers = this.doc.layers;
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        const row = document.createElement("div");
        row.className = "paint-layer-row" + (i === this.doc.active ? " active" : "");
        row.dataset.idx = i;
        row.draggable  = true;

        const vis = document.createElement("div");
        vis.className = "paint-layer-vis" + (l.visible ? "" : " off");
        vis.textContent = l.visible ? "👁" : "—";
        vis.title = l.visible ? "Visible" : "Hidden";
        vis.addEventListener("click", (ev) => {
          ev.stopPropagation();
          l.visible = !l.visible;
          this._render();
          this._renderLayers();
        });

        const thumb = document.createElement("div");
        thumb.className = "paint-layer-thumb";
        const tc = document.createElement("canvas");
        tc.width = THUMB_W; tc.height = THUMB_H;
        const ttx = tc.getContext("2d");
        ttx.imageSmoothingEnabled = true;
        ttx.drawImage(l.canvas, 0, 0, THUMB_W, THUMB_H);
        thumb.appendChild(tc);

        const name = document.createElement("div");
        name.className = "paint-layer-name";
        name.textContent = l.name;
        name.title = l.name;
        name.addEventListener("dblclick", () => this._beginRenameLayer(i, name));

        const lock = document.createElement("div");
        lock.className = "paint-layer-lock" + (l.locked ? " on" : "");
        lock.textContent = l.locked ? "🔒" : "🔓";
        lock.title = l.locked ? "Locked" : "Unlocked";
        lock.addEventListener("click", (ev) => {
          ev.stopPropagation();
          l.locked = !l.locked;
          this._renderLayers();
        });

        row.appendChild(vis);
        row.appendChild(thumb);
        row.appendChild(name);
        row.appendChild(lock);

        row.addEventListener("click", () => this._setActiveLayer(i));

        // Drag-reorder
        row.addEventListener("dragstart", (ev) => {
          row.classList.add("dragging");
          ev.dataTransfer.setData("text/paint-layer", String(i));
          ev.dataTransfer.effectAllowed = "move";
        });
        row.addEventListener("dragend", () => {
          row.classList.remove("dragging");
          d.layerList.querySelectorAll(".paint-layer-row").forEach((r) => {
            r.classList.remove("drop-above"); r.classList.remove("drop-below");
          });
        });
        row.addEventListener("dragover", (ev) => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          const r = row.getBoundingClientRect();
          const above = (ev.clientY - r.top) < r.height / 2;
          row.classList.toggle("drop-above", above);
          row.classList.toggle("drop-below", !above);
        });
        row.addEventListener("dragleave", () => {
          row.classList.remove("drop-above"); row.classList.remove("drop-below");
        });
        row.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const fromStr = ev.dataTransfer.getData("text/paint-layer");
          if (!fromStr) return;
          const from = parseInt(fromStr, 10);
          if (isNaN(from) || from === i) return;
          const r = row.getBoundingClientRect();
          const above = (ev.clientY - r.top) < r.height / 2;
          // 'above' visually means above the row, which is a HIGHER index (top-down list).
          let to = above ? i + 1 : i;
          if (from < to) to -= 1;
          to = clamp(to, 0, this.doc.layers.length - 1);
          this._moveLayer(from, to);
        });

        d.layerList.appendChild(row);
      }

      // Action buttons
      this.root.querySelectorAll('[data-layer-action]').forEach((b) => {
        b.onclick = () => {
          switch (b.dataset.layerAction) {
            case "add":  this._userAddLayer(); break;
            case "dup":  this._duplicateLayer(this.doc.active); break;
            case "up":   this._moveLayer(this.doc.active, Math.min(this.doc.layers.length - 1, this.doc.active + 1)); break;
            case "down": this._moveLayer(this.doc.active, Math.max(0, this.doc.active - 1)); break;
            case "mergedown": this._mergeDown(this.doc.active); break;
            case "del":  this._deleteLayer(this.doc.active); break;
          }
        };
      });

      // Sync active layer's blend mode + opacity into the panel header controls
      const a = this._activeLayer();
      if (a) {
        if (d.layerBlend)   d.layerBlend.value = a.blend;
        if (d.layerOpacity) d.layerOpacity.value = a.opacity;
        if (d.layerOpacityVal) d.layerOpacityVal.textContent = a.opacity + "%";
      }

      if (d.layerBlend && !d.layerBlend._wired) {
        d.layerBlend._wired = true;
        d.layerBlend.addEventListener("change", () => {
          const al = this._activeLayer(); if (!al) return;
          al.blend = d.layerBlend.value;
          this._pushHistory("blend");
          this._render();
        });
      }
      if (d.layerOpacity && !d.layerOpacity._wired) {
        d.layerOpacity._wired = true;
        d.layerOpacity.addEventListener("input", () => {
          const al = this._activeLayer(); if (!al) return;
          al.opacity = parseInt(d.layerOpacity.value, 10) || 0;
          if (d.layerOpacityVal) d.layerOpacityVal.textContent = al.opacity + "%";
          this._render();
        });
        d.layerOpacity.addEventListener("change", () => {
          this._pushHistory("opacity");
        });
      }
    }

    _userAddLayer() {
      this._addLayer({});
      this._pushHistory("add-layer");
      this._renderLayers();
      this._render();
    }

    _beginRenameLayer(idx, span) {
      const l = this.doc.layers[idx];
      if (!l) return;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = l.name;
      span.textContent = "";
      span.appendChild(inp);
      inp.focus();
      inp.select();
      const finish = (commit) => {
        if (commit && inp.value.trim()) l.name = inp.value.trim();
        this._renderLayers();
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      inp.addEventListener("blur", () => finish(true));
    }

    /* --------------------------------------------------------------------
     * 1.12  EVENT WIRING (canvas mouse, scroll, panning, zoom)
     * ----------------------------------------------------------------- */
    _wireEvents() {
      const stage = this.dom.stage;
      const vp    = this.dom.viewport;
      if (!stage || !vp) return;

      this.on(stage, "mousedown", (ev) => this._onCanvasDown(ev));
      this.on(window, "mousemove", (ev) => this._onCanvasMove(ev));
      this.on(window, "mouseup",   (ev) => this._onCanvasUp(ev));
      this.on(stage, "mouseleave", (ev) => this._onCanvasMove(ev));

      this.on(vp, "wheel", (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          const r = vp.getBoundingClientRect();
          const cx = ev.clientX - r.left;
          const cy = ev.clientY - r.top;
          this._setZoom(this.view.zoom * (ev.deltaY < 0 ? 1.15 : 1/1.15), cx, cy);
        }
      }, { passive: false });

      this.on(vp, "scroll", () => {
        this.view.scrollLeft = vp.scrollLeft;
        this.view.scrollTop  = vp.scrollTop;
      });

      this.on(this.dom.fileInput, "change", (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (f) this._loadImageFromFile(f);
        ev.target.value = "";
      });
    }

    /**
     * Convert a clientX/clientY to canvas pixel coords.
     */
    _toCanvasCoords(ev) {
      const r = this.dom.display.getBoundingClientRect();
      const x = (ev.clientX - r.left) / this.view.zoom;
      const y = (ev.clientY - r.top)  / this.view.zoom;
      return { x, y };
    }

    _onCanvasDown(ev) {
      if (ev.button === 2) return; // right click — ignored here
      this._closeMenu();

      const p = this._toCanvasCoords(ev);
      this.input.startPoint = { x: p.x, y: p.y };
      this.input.last = p;
      this.input.path = [p];

      // Space-pan overrides everything
      if (this.input.space) {
        this.input.dragging = true;
        this.input.panStart = { x: ev.clientX, y: ev.clientY, sl: this.dom.viewport.scrollLeft, st: this.dom.viewport.scrollTop };
        this.dom.canvasHost.classList.add("is-panning", "is-grabbing");
        ev.preventDefault();
        return;
      }

      switch (this.tool) {
        case "pencil":   this._beginStroke(p, "pencil"); break;
        case "brush":    this._beginStroke(p, "brush");  break;
        case "eraser":   this._beginStroke(p, "eraser"); break;
        case "fill":     this._toolFill(p); break;
        case "eyedropper": this._toolEyedropper(p); break;
        case "text":     this._toolTextStart(p); break;
        case "select":   this._toolSelectStart(p); break;
        case "move":     this._toolMoveStart(p); break;
        case "zoom":     this._toolZoomClick(p, ev); break;
        case "hand":
          this.input.dragging = true;
          this.input.panStart = { x: ev.clientX, y: ev.clientY, sl: this.dom.viewport.scrollLeft, st: this.dom.viewport.scrollTop };
          this.dom.canvasHost.classList.add("is-panning", "is-grabbing");
          break;
        case "rect": case "ellipse": case "line":
        case "triangle": case "polygon": case "star":
          this._beginShape(p, this.tool);
          break;
      }
      ev.preventDefault();
    }

    _onCanvasMove(ev) {
      const p = this._toCanvasCoords(ev);
      this._updateCursorReadout(p);

      if (this.input.dragging && this.input.panStart) {
        const dx = ev.clientX - this.input.panStart.x;
        const dy = ev.clientY - this.input.panStart.y;
        this.dom.viewport.scrollLeft = this.input.panStart.sl - dx;
        this.dom.viewport.scrollTop  = this.input.panStart.st - dy;
        return;
      }

      if (this.input.drawing) {
        switch (this.tool) {
          case "pencil":   this._extendStroke(p, "pencil"); break;
          case "brush":    this._extendStroke(p, "brush"); break;
          case "eraser":   this._extendStroke(p, "eraser"); break;
          case "rect": case "ellipse": case "line":
          case "triangle": case "polygon": case "star":
            this._previewShape(p, this.tool, ev);
            break;
          case "select":   this._toolSelectMove(p, ev); break;
          case "move":     this._toolMoveMove(p); break;
        }
      }
    }

    _onCanvasUp(ev) {
      if (this.input.dragging && this.input.panStart) {
        this.input.dragging = false;
        this.input.panStart = null;
        this.dom.canvasHost.classList.remove("is-grabbing");
        if (!this.input.space) this.dom.canvasHost.classList.remove("is-panning");
        return;
      }
      if (!this.input.drawing) return;

      const p = this._toCanvasCoords(ev);
      switch (this.tool) {
        case "pencil": case "brush": case "eraser":
          this._endStroke(p);
          break;
        case "rect": case "ellipse": case "line":
        case "triangle": case "polygon": case "star":
          this._commitShape(p, this.tool, ev);
          break;
        case "select":
          this._toolSelectEnd(p);
          break;
        case "move":
          this._toolMoveEnd(p);
          break;
      }
      this.input.drawing = false;
      this.input.path = [];
      this.input.startPoint = null;
    }

    _updateCursorReadout(p) {
      const d = this.dom;
      if (d.statusCoord) d.statusCoord.textContent = (p.x | 0) + ", " + (p.y | 0);
    }

    _updateStatus() {
      const d = this.dom;
      if (d.statusZoom)  d.statusZoom.textContent  = Math.round(this.view.zoom * 100) + "%";
      if (d.statusSize)  d.statusSize.textContent  = this.doc.width + " × " + this.doc.height;
      if (d.statusTool)  d.statusTool.textContent  = TOOL_META[this.tool] ? TOOL_META[this.tool].label : this.tool;
      if (d.docName)     d.docName.textContent     = this.doc.name + " — " + this.doc.width + "×" + this.doc.height;
      const c = this._activeColorObj();
      const hex = rgbToHex(c.r, c.g, c.b);
      if (d.statusColorSwatch) d.statusColorSwatch.style.background = "rgba(" + c.r + "," + c.g + "," + c.b + "," + c.a + ")";
      if (d.statusColorHex)    d.statusColorHex.textContent = hex;
      if (d.statusMem) {
        const px = this.doc.width * this.doc.height * 4 * this.doc.layers.length;
        d.statusMem.textContent = (px / (1024 * 1024)).toFixed(1) + " MB";
      }
    }

    /* --------------------------------------------------------------------
     * 1.13  STROKE TOOLS (pencil / brush / eraser)
     * ----------------------------------------------------------------- */
    _beginStroke(p, kind) {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      this.input.drawing = true;
      const ctx = this._ctxFor(layer);
      this.input.snapshot = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      this._strokeKind = kind;
      this._strokePoints = [p];
      this._drawStrokeStep(p, kind);
    }

    _extendStroke(p, kind) {
      this._strokePoints.push(p);
      const layer = this._activeLayer();
      if (!layer) return;
      // Apply smoothing: blend toward path average
      const sm = this.opt.smoothing / 100;
      let pt = p;
      if (sm > 0 && this.input.last) {
        pt = {
          x: lerp(this.input.last.x, p.x, 1 - sm * 0.6),
          y: lerp(this.input.last.y, p.y, 1 - sm * 0.6),
        };
      }
      this._drawStrokeStep(pt, kind);
      this.input.last = pt;
    }

    _drawStrokeStep(p, kind) {
      const layer = this._activeLayer();
      if (!layer) return;
      const ctx = this._ctxFor(layer);
      const c = this._activeColorObj();
      const size = Math.max(1, this.opt.size);

      if (kind === "pencil") {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = c.a * (this.opt.opacity / 100);
        ctx.fillStyle = rgbToHex(c.r, c.g, c.b);
        if (this._lastPenPoint) {
          this._stamps(this._lastPenPoint, p, size, (x, y) => {
            ctx.fillRect(x - size/2, y - size/2, size, size);
          });
        } else {
          ctx.fillRect(p.x - size/2, p.y - size/2, size, size);
        }
        ctx.restore();
        this._lastPenPoint = p;
      } else if (kind === "brush") {
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = c.a * (this.opt.opacity / 100) * (this.opt.flow / 100);
        const grad = this._brushGradient(p, size, c, this.opt.hardness / 100);
        ctx.fillStyle = grad;
        if (this._lastPenPoint) {
          this._stamps(this._lastPenPoint, p, Math.max(1, size / 4), (x, y) => {
            ctx.beginPath(); ctx.arc(x, y, size/2, 0, TAU); ctx.fill();
          });
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, size/2, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
        this._lastPenPoint = p;
      } else if (kind === "eraser") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = (this.opt.opacity / 100);
        if (this._lastPenPoint) {
          this._stamps(this._lastPenPoint, p, Math.max(1, size / 4), (x, y) => {
            ctx.beginPath(); ctx.arc(x, y, size/2, 0, TAU); ctx.fill();
          });
        } else {
          ctx.beginPath(); ctx.arc(p.x, p.y, size/2, 0, TAU); ctx.fill();
        }
        ctx.restore();
        this._lastPenPoint = p;
      }
      layer.thumbDirty = true;
      this._render();
    }

    _stamps(a, b, spacing, fn) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const steps = Math.max(1, Math.ceil(dist / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        fn(a.x + dx * t, a.y + dy * t);
      }
    }

    _brushGradient(p, size, c, hardness) {
      const layer = this._activeLayer();
      if (!layer) return rgbToHex(c.r, c.g, c.b);
      const ctx = this._ctxFor(layer);
      const inner = clamp(hardness, 0, 1) * size / 2;
      const outer = size / 2;
      const g = ctx.createRadialGradient(p.x, p.y, inner, p.x, p.y, outer);
      g.addColorStop(0, "rgba(" + c.r + "," + c.g + "," + c.b + ",1)");
      g.addColorStop(1, "rgba(" + c.r + "," + c.g + "," + c.b + ",0)");
      return g;
    }

    _endStroke(p) {
      this._lastPenPoint = null;
      this.input.snapshot = null;
      const layer = this._activeLayer();
      if (layer) layer.thumbDirty = true;
      this._pushHistory("stroke");
      this._renderLayers();
      this._render();
    }

    /* --------------------------------------------------------------------
     * 1.14  FILL BUCKET (BFS flood fill)
     * ----------------------------------------------------------------- */
    _toolFill(p) {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      const ctx = this._ctxFor(layer);
      const w = layer.canvas.width, h = layer.canvas.height;
      const x0 = clamp(p.x | 0, 0, w - 1);
      const y0 = clamp(p.y | 0, 0, h - 1);
      const img = ctx.getImageData(0, 0, w, h);
      const data = img.data;
      const idx = (x, y) => (y * w + x) * 4;

      const start = idx(x0, y0);
      const target = [data[start], data[start+1], data[start+2], data[start+3]];
      const c = this._activeColorObj();
      const repl = [c.r, c.g, c.b, Math.round(c.a * 255)];
      const tol = this.opt.fillTolerance;

      // No-op if target == replacement within tolerance
      if (Math.abs(target[0] - repl[0]) <= tol &&
          Math.abs(target[1] - repl[1]) <= tol &&
          Math.abs(target[2] - repl[2]) <= tol &&
          Math.abs(target[3] - repl[3]) <= tol) {
        return;
      }

      const matches = (i) => {
        return Math.abs(data[i  ] - target[0]) <= tol &&
               Math.abs(data[i+1] - target[1]) <= tol &&
               Math.abs(data[i+2] - target[2]) <= tol &&
               Math.abs(data[i+3] - target[3]) <= tol;
      };
      const setPixel = (i) => {
        data[i  ] = repl[0];
        data[i+1] = repl[1];
        data[i+2] = repl[2];
        data[i+3] = repl[3];
      };

      if (!this.opt.fillContig) {
        // Global: replace all matching pixels
        for (let i = 0; i < data.length; i += 4) {
          if (matches(i)) setPixel(i);
        }
        ctx.putImageData(img, 0, 0);
        layer.thumbDirty = true;
        this._pushHistory("fill-global");
        this._render();
        this._renderLayers();
        return;
      }

      // BFS flood fill, scanline
      const stack = [[x0, y0]];
      while (stack.length) {
        const [sx, sy] = stack.pop();
        let xL = sx;
        let i = idx(xL, sy);
        if (!matches(i)) continue;
        // Find leftmost match
        while (xL > 0 && matches(idx(xL - 1, sy))) xL--;
        let xR = sx;
        while (xR < w - 1 && matches(idx(xR + 1, sy))) xR++;
        // Fill this run
        for (let x = xL; x <= xR; x++) {
          setPixel(idx(x, sy));
        }
        // Push runs above/below
        for (let x = xL; x <= xR; x++) {
          if (sy > 0     && matches(idx(x, sy - 1))) stack.push([x, sy - 1]);
          if (sy < h - 1 && matches(idx(x, sy + 1))) stack.push([x, sy + 1]);
        }
      }

      ctx.putImageData(img, 0, 0);
      layer.thumbDirty = true;
      this._pushHistory("fill");
      this._render();
      this._renderLayers();
    }

    /* --------------------------------------------------------------------
     * 1.15  EYEDROPPER
     * ----------------------------------------------------------------- */
    _toolEyedropper(p) {
      let r = 0, g = 0, b = 0, a = 0;
      const x = clamp(p.x | 0, 0, this.doc.width - 1);
      const y = clamp(p.y | 0, 0, this.doc.height - 1);
      if (this.opt.eyeSample === "all") {
        const px = this.dom.display.getContext("2d").getImageData(x, y, 1, 1).data;
        r = px[0]; g = px[1]; b = px[2]; a = px[3];
      } else {
        const layer = this._activeLayer();
        if (!layer) return;
        const px = this._ctxFor(layer).getImageData(x, y, 1, 1).data;
        r = px[0]; g = px[1]; b = px[2]; a = px[3];
      }
      this._setActiveColor({ r, g, b, a: a / 255 });
      this._syncCpInputs("force");
    }

    /* --------------------------------------------------------------------
     * 1.16  TEXT TOOL
     * ----------------------------------------------------------------- */
    _toolTextStart(p) {
      this._commitTextIfAny();
      const ti = this.dom.textInput;
      if (!ti) return;
      ti.hidden = false;
      ti.style.left = (p.x * this.view.zoom) + "px";
      ti.style.top  = (p.y * this.view.zoom) + "px";
      ti.style.font = this._fontString();
      ti.style.color = this._cssColor(this._activeColorObj());
      ti.textContent = "";
      ti.focus();
      this.input.textBox = { x: p.x, y: p.y };
    }

    _commitTextIfAny() {
      const ti = this.dom.textInput;
      if (!ti || ti.hidden || !this.input.textBox) return;
      const txt = ti.textContent || "";
      if (!txt.trim()) {
        ti.hidden = true;
        this.input.textBox = null;
        return;
      }
      const layer = this._activeLayer();
      if (!layer || layer.locked) {
        ti.hidden = true;
        this.input.textBox = null;
        return;
      }
      const ctx = this._ctxFor(layer);
      const c = this._activeColorObj();
      ctx.save();
      ctx.fillStyle = this._cssColor(c);
      ctx.globalAlpha = (this.opt.opacity / 100);
      ctx.font = this._fontString();
      ctx.textBaseline = "top";
      const lines = txt.split("\n");
      const lh = this.opt.textSize * 1.2;
      lines.forEach((ln, i) => {
        ctx.fillText(ln, this.input.textBox.x, this.input.textBox.y + i * lh);
        if (this.opt.textUnder) {
          const w = ctx.measureText(ln).width;
          ctx.fillRect(this.input.textBox.x, this.input.textBox.y + i * lh + this.opt.textSize, w, Math.max(1, this.opt.textSize / 16));
        }
      });
      ctx.restore();
      ti.hidden = true;
      ti.textContent = "";
      this.input.textBox = null;
      layer.thumbDirty = true;
      this._pushHistory("text");
      this._render();
      this._renderLayers();
    }

    _fontString() {
      const styles = [];
      if (this.opt.textItalic) styles.push("italic");
      if (this.opt.textBold)   styles.push("bold");
      styles.push(this.opt.textSize + "px");
      styles.push('"' + this.opt.textFont + '"');
      return styles.join(" ");
    }

    _cssColor(c) {
      return "rgba(" + c.r + "," + c.g + "," + c.b + "," + c.a + ")";
    }

    /* --------------------------------------------------------------------
     * 1.17  SHAPES — preview overlay + commit
     * ----------------------------------------------------------------- */
    _beginShape(p, kind) {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      this.input.drawing = true;
      // Snapshot for live preview
      const ctx = this._ctxFor(layer);
      this.input.snapshot = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
    }

    _previewShape(p, kind, ev) {
      const layer = this._activeLayer();
      if (!layer || !this.input.snapshot || !this.input.startPoint) return;
      const ctx = this._ctxFor(layer);
      ctx.putImageData(this.input.snapshot, 0, 0);
      // Draw on overlay AND target temporarily? We commit a preview directly to layer for performance,
      // restoring snapshot first. The final commit happens in mouseup.
      this._drawShape(ctx, this.input.startPoint, p, kind, ev);
      layer.thumbDirty = true;
      this._render();
    }

    _commitShape(p, kind, ev) {
      const layer = this._activeLayer();
      if (!layer || !this.input.snapshot || !this.input.startPoint) return;
      const ctx = this._ctxFor(layer);
      ctx.putImageData(this.input.snapshot, 0, 0);
      this._drawShape(ctx, this.input.startPoint, p, kind, ev);
      this.input.snapshot = null;
      layer.thumbDirty = true;
      this._pushHistory("shape:" + kind);
      this._render();
      this._renderLayers();
    }

    _drawShape(ctx, a, b, kind, ev) {
      const c = this._activeColorObj();
      const c2 = this.color.bg;
      const fill = this.opt.shapeFill;
      const stroke = this.opt.shapeStroke;
      const sw = Math.max(1, this.opt.shapeStrokeW);
      const op = this.opt.opacity / 100;
      const shift = !!(ev && ev.shiftKey);

      ctx.save();
      ctx.globalAlpha = op;
      ctx.lineJoin = "round";
      ctx.lineCap  = "round";
      ctx.lineWidth = sw;
      ctx.strokeStyle = this._cssColor(c);
      ctx.fillStyle   = this._cssColor(c2);

      let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (shift) {
        const m = Math.min(w, h);
        w = h = m;
      }

      switch (kind) {
        case "rect": {
          if (fill)   ctx.fillRect(x, y, w, h);
          if (stroke) ctx.strokeRect(x, y, w, h);
          break;
        }
        case "ellipse": {
          ctx.beginPath();
          ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, TAU);
          if (fill)   ctx.fill();
          if (stroke) ctx.stroke();
          break;
        }
        case "line": {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          if (shift) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.sqrt(dx*dx + dy*dy);
            ctx.lineTo(a.x + Math.cos(ang) * len, a.y + Math.sin(ang) * len);
          } else {
            ctx.lineTo(b.x, b.y);
          }
          ctx.stroke();
          break;
        }
        case "triangle": {
          ctx.beginPath();
          ctx.moveTo(x + w/2, y);
          ctx.lineTo(x + w, y + h);
          ctx.lineTo(x, y + h);
          ctx.closePath();
          if (fill)   ctx.fill();
          if (stroke) ctx.stroke();
          break;
        }
        case "polygon": {
          const sides = clamp(this.opt.shapeSides | 0, 3, 32);
          const cx = x + w/2, cy = y + h/2;
          const rx = w/2, ry = h/2;
          ctx.beginPath();
          for (let i = 0; i < sides; i++) {
            const ang = -Math.PI / 2 + (i * TAU) / sides;
            const px = cx + Math.cos(ang) * rx;
            const py = cy + Math.sin(ang) * ry;
            if (i === 0) ctx.moveTo(px, py);
            else         ctx.lineTo(px, py);
          }
          ctx.closePath();
          if (fill)   ctx.fill();
          if (stroke) ctx.stroke();
          break;
        }
        case "star": {
          const points = clamp(this.opt.shapePoints | 0, 3, 20);
          const inner  = clamp(this.opt.shapeInner / 100, 0.1, 0.95);
          const cx = x + w/2, cy = y + h/2;
          const ro = Math.min(w, h) / 2;
          const ri = ro * inner;
          ctx.beginPath();
          for (let i = 0; i < points * 2; i++) {
            const r = (i % 2 === 0) ? ro : ri;
            const ang = -Math.PI / 2 + (i * Math.PI) / points;
            const px = cx + Math.cos(ang) * r;
            const py = cy + Math.sin(ang) * r;
            if (i === 0) ctx.moveTo(px, py);
            else         ctx.lineTo(px, py);
          }
          ctx.closePath();
          if (fill)   ctx.fill();
          if (stroke) ctx.stroke();
          break;
        }
      }
      ctx.restore();
    }

    /* --------------------------------------------------------------------
     * 1.18  SELECTION TOOL
     * ----------------------------------------------------------------- */
    _toolSelectStart(p) {
      this.input.drawing = true;
      this.input.selectStart = p;
      this.selection = { x: p.x | 0, y: p.y | 0, w: 0, h: 0 };
    }

    _toolSelectMove(p) {
      if (!this.input.selectStart) return;
      const a = this.input.selectStart;
      const x = Math.min(a.x, p.x) | 0;
      const y = Math.min(a.y, p.y) | 0;
      const w = Math.abs(p.x - a.x) | 0;
      const h = Math.abs(p.y - a.y) | 0;
      this.selection = { x, y, w, h };
      this._render();
    }

    _toolSelectEnd(p) {
      this.input.selectStart = null;
      if (this.selection && (this.selection.w < 2 || this.selection.h < 2)) {
        this.selection = null;
      }
      this._render();
    }

    _selectAll() {
      this.selection = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
      this._render();
    }

    _deselect() {
      this.selection = null;
      this._render();
    }

    _invertSelection() {
      // For our rectangular selection, "invert" creates a multi-rect mask which
      // we approximate by selecting nothing inside the current rect:
      // Implementation: if no selection, behaves as select-all; otherwise
      // fall back to a full-canvas selection. (Real masks would require
      // pixel-mask tracking — kept simple here.)
      if (!this.selection) { this._selectAll(); return; }
      this.selection = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
      this._render();
    }

    _editCopy() {
      if (!this.selection || !this._activeLayer()) return;
      const layer = this._activeLayer();
      const ctx = this._ctxFor(layer);
      const s = this.selection;
      this.clipboard = ctx.getImageData(s.x, s.y, Math.max(1, s.w), Math.max(1, s.h));
    }

    _editCut() {
      this._editCopy();
      this._editDelete();
    }

    _editDelete() {
      if (!this.selection || !this._activeLayer()) return;
      const layer = this._activeLayer();
      if (layer.locked) return;
      const ctx = this._ctxFor(layer);
      const s = this.selection;
      ctx.clearRect(s.x, s.y, s.w, s.h);
      layer.thumbDirty = true;
      this._pushHistory("delete-selection");
      this._render();
      this._renderLayers();
    }

    _editPaste() {
      if (!this.clipboard) return;
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      const ctx = this._ctxFor(layer);
      const s = this.selection || { x: 0, y: 0 };
      ctx.putImageData(this.clipboard, s.x, s.y);
      layer.thumbDirty = true;
      this._pushHistory("paste");
      this._render();
      this._renderLayers();
    }

    /* --------------------------------------------------------------------
     * 1.19  MOVE TOOL — moves entire active layer
     * ----------------------------------------------------------------- */
    _toolMoveStart(p) {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      this.input.drawing = true;
      const ctx = this._ctxFor(layer);
      this.input.moveStartImage = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      this.input.moveOrigin = p;
    }

    _toolMoveMove(p) {
      const layer = this._activeLayer();
      if (!layer || !this.input.moveStartImage || !this.input.moveOrigin) return;
      const dx = (p.x - this.input.moveOrigin.x) | 0;
      const dy = (p.y - this.input.moveOrigin.y) | 0;
      const snap = this.opt.moveSnap ? 8 : 1;
      const sdx = Math.round(dx / snap) * snap;
      const sdy = Math.round(dy / snap) * snap;
      const ctx = this._ctxFor(layer);
      ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      ctx.putImageData(this.input.moveStartImage, sdx, sdy);
      layer.thumbDirty = true;
      this._render();
    }

    _toolMoveEnd(p) {
      this.input.moveStartImage = null;
      this.input.moveOrigin = null;
      this._pushHistory("move-layer");
      this._renderLayers();
      this._render();
    }

    /* --------------------------------------------------------------------
     * 1.20  ZOOM TOOL
     * ----------------------------------------------------------------- */
    _toolZoomClick(p, ev) {
      const dir = ev && ev.altKey ? -1 : +1;
      const r = this.dom.viewport.getBoundingClientRect();
      this._zoomToStep(dir, ev.clientX - r.left, ev.clientY - r.top);
    }

    /* --------------------------------------------------------------------
     * 1.21  HISTORY
     * ----------------------------------------------------------------- */
    _snapshot() {
      // Deep copy: each layer's pixel data + metadata
      return {
        width:   this.doc.width,
        height:  this.doc.height,
        active:  this.doc.active,
        layers:  this.doc.layers.map((l) => ({
          id:      l.id,
          name:    l.name,
          visible: l.visible,
          locked:  l.locked,
          opacity: l.opacity,
          blend:   l.blend,
          imageData: this._ctxFor(l).getImageData(0, 0, l.canvas.width, l.canvas.height),
        })),
      };
    }

    _restoreSnapshot(snap) {
      this.doc.width  = snap.width;
      this.doc.height = snap.height;
      this.dom.display.width  = snap.width;
      this.dom.display.height = snap.height;
      this.dom.overlay.width  = snap.width;
      this.dom.overlay.height = snap.height;
      this.doc.layers = snap.layers.map((src) => {
        const c = document.createElement("canvas");
        c.width = snap.width; c.height = snap.height;
        const ctx = c.getContext("2d");
        ctx.putImageData(src.imageData, 0, 0);
        return {
          id: src.id, name: src.name,
          visible: src.visible, locked: src.locked,
          opacity: src.opacity, blend: src.blend,
          canvas: c, thumbDirty: true,
        };
      });
      this.doc.active = clamp(snap.active, 0, this.doc.layers.length - 1);
      this._applyZoomCss();
      this._renderLayers();
      this._render();
    }

    _pushHistory(label) {
      const h = this.history;
      // Drop redo branch
      if (h.index < h.stack.length - 1) {
        h.stack.length = h.index + 1;
      }
      h.stack.push({ label, snap: this._snapshot() });
      if (h.stack.length > HISTORY_LIMIT) {
        h.stack.shift();
      } else {
        h.index = h.stack.length - 1;
      }
    }

    _undo() {
      const h = this.history;
      if (h.index <= 0) return;
      h.index--;
      this._restoreSnapshot(h.stack[h.index].snap);
    }

    _redo() {
      const h = this.history;
      if (h.index >= h.stack.length - 1) return;
      h.index++;
      this._restoreSnapshot(h.stack[h.index].snap);
    }

    /* --------------------------------------------------------------------
     * 1.22  IMAGE OPS
     * ----------------------------------------------------------------- */
    _rotateCanvas(deg) {
      const oldW = this.doc.width;
      const oldH = this.doc.height;
      const swap = (deg % 180 !== 0);
      const newW = swap ? oldH : oldW;
      const newH = swap ? oldW : oldH;
      this.doc.layers = this.doc.layers.map((l) => {
        const c = document.createElement("canvas");
        c.width = newW; c.height = newH;
        const ctx = c.getContext("2d");
        ctx.save();
        ctx.translate(newW/2, newH/2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(l.canvas, -oldW/2, -oldH/2);
        ctx.restore();
        l.canvas = c;
        l.thumbDirty = true;
        return l;
      });
      this.doc.width = newW;
      this.doc.height = newH;
      this.dom.display.width = newW; this.dom.display.height = newH;
      this.dom.overlay.width = newW; this.dom.overlay.height = newH;
      this._pushHistory("rotate");
      this._applyZoomCss();
      this._renderLayers();
      this._render();
    }

    _flipCanvas(axis) {
      this.doc.layers = this.doc.layers.map((l) => {
        const c = document.createElement("canvas");
        c.width = l.canvas.width; c.height = l.canvas.height;
        const ctx = c.getContext("2d");
        ctx.save();
        if (axis === "h") { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
        else              { ctx.translate(0, c.height); ctx.scale(1, -1); }
        ctx.drawImage(l.canvas, 0, 0);
        ctx.restore();
        l.canvas = c;
        l.thumbDirty = true;
        return l;
      });
      this._pushHistory("flip");
      this._renderLayers();
      this._render();
    }

    _invertColors() {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      const ctx = this._ctxFor(layer);
      const img = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i  ] = 255 - d[i  ];
        d[i+1] = 255 - d[i+1];
        d[i+2] = 255 - d[i+2];
      }
      ctx.putImageData(img, 0, 0);
      layer.thumbDirty = true;
      this._pushHistory("invert");
      this._render();
      this._renderLayers();
    }

    _toGrayscale() {
      const layer = this._activeLayer();
      if (!layer || layer.locked) return;
      const ctx = this._ctxFor(layer);
      const img = ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]) | 0;
        d[i  ] = v; d[i+1] = v; d[i+2] = v;
      }
      ctx.putImageData(img, 0, 0);
      layer.thumbDirty = true;
      this._pushHistory("grayscale");
      this._render();
      this._renderLayers();
    }

    /* --------------------------------------------------------------------
     * 1.23  KEYBOARD
     * ----------------------------------------------------------------- */
    _wireKeyboard() {
      this.on(window, "keydown", (ev) => {
        if (this._unmounted) return;
        if (!this._isActiveWindow()) return;
        const tgt = ev.target;
        const isField = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
        // Space-pan
        if (ev.code === "Space" && !isField) {
          ev.preventDefault();
          if (!this.input.space) {
            this.input.space = true;
            this.dom.canvasHost.classList.add("is-panning");
          }
          return;
        }
        const ctrl = ev.ctrlKey || ev.metaKey;
        const shift = ev.shiftKey;
        const alt = ev.altKey;
        const k = ev.key.toLowerCase();

        if (ctrl && !shift && !alt) {
          switch (k) {
            case "z": ev.preventDefault(); this._undo(); return;
            case "y": ev.preventDefault(); this._redo(); return;
            case "n": ev.preventDefault(); this._dialogNew(); return;
            case "o": ev.preventDefault(); this._dialogOpen(); return;
            case "s": ev.preventDefault(); this._save(); return;
            case "e": ev.preventDefault(); this._dialogExportPNG(); return;
            case "a": ev.preventDefault(); this._selectAll(); return;
            case "d": ev.preventDefault(); this._deselect(); return;
            case "i": ev.preventDefault(); this._invertColors(); return;
            case "1": ev.preventDefault(); this._zoom100(); return;
            case "+": case "=": ev.preventDefault(); this._zoomToStep(+1); return;
            case "-": ev.preventDefault(); this._zoomToStep(-1); return;
            case "j": ev.preventDefault(); this._duplicateLayer(this.doc.active); return;
            case "x": ev.preventDefault(); this._editCut(); return;
            case "c": ev.preventDefault(); this._editCopy(); return;
            case "v": ev.preventDefault(); this._editPaste(); return;
          }
        }
        if (ctrl && shift && !alt) {
          switch (k) {
            case "s": ev.preventDefault(); this._dialogSaveAs(); return;
            case "n": ev.preventDefault(); this._userAddLayer(); return;
            case "h": ev.preventDefault(); this._fitToWindow(); return;
            case "i": ev.preventDefault(); this._invertSelection(); return;
            case "e": ev.preventDefault(); this._mergeDown(this.doc.active); return;
            case "z": ev.preventDefault(); this._redo(); return;
          }
        }
        if (ctrl && alt && !shift) {
          if (k === "e") { ev.preventDefault(); this._mergeVisible(); return; }
        }
        if (!ctrl && !alt && !shift && !isField) {
          switch (k) {
            case "b": this._setTool("brush"); return;
            case "p": this._setTool("pencil"); return;
            case "e": this._setTool("eraser"); return;
            case "g": this._setTool("fill"); return;
            case "i": this._setTool("eyedropper"); return;
            case "t": this._setTool("text"); return;
            case "m": this._setTool("select"); return;
            case "v": this._setTool("move"); return;
            case "z": this._setTool("zoom"); return;
            case "h": this._setTool("hand"); return;
            case "x": this._swapColors(); return;
            case "d": this._resetColors(); return;
            case "[": this._adjustSize(-1); return;
            case "]": this._adjustSize(+1); return;
            case "delete": case "backspace":
              if (this.selection) { ev.preventDefault(); this._editDelete(); }
              return;
            case "escape":
              this._commitTextIfAny();
              this._closeMenu();
              this._deselect();
              return;
          }
        }
      });

      this.on(window, "keyup", (ev) => {
        if (ev.code === "Space") {
          this.input.space = false;
          if (!this.input.dragging) this.dom.canvasHost.classList.remove("is-panning", "is-grabbing");
        }
      });
    }

    _isActiveWindow() {
      // Determine if our window is the focused/active one in the WM.
      // Heuristic: appRoot is contained in the document's active window.
      if (!this.dom.appRoot) return false;
      const w = this.dom.appRoot.closest('.window');
      if (!w) return false;
      return w.classList.contains("active") || w === document.activeElement || w.contains(document.activeElement);
    }

    _adjustSize(dir) {
      const cur = this.opt.size;
      const next = clamp(Math.max(1, Math.round(cur * (dir > 0 ? 1.2 : 1/1.2))), 1, 200);
      this.opt.size = next;
      if (this.dom.sizeRange) this.dom.sizeRange.value = next;
      if (this.dom.sizeNum)   this.dom.sizeNum.value   = next;
    }

    /* --------------------------------------------------------------------
     * 1.24  FILE OPERATIONS
     * ----------------------------------------------------------------- */
    _dialogNew() {
      this._showModal({
        title: "New Image",
        body: this._modalNewForm(),
        actions: [
          { label: "Cancel", onClick: () => this._closeModal() },
          { label: "Create", primary: true, onClick: () => {
            const r = this.dom.modalRoot;
            const w = parseInt(r.querySelector('[data-new-w]').value, 10);
            const h = parseInt(r.querySelector('[data-new-h]').value, 10);
            const fill = r.querySelector('[data-new-bg]').value;
            this._closeModal();
            this._newDocument({ width: w, height: h, fill });
          }},
        ],
      });
    }

    _modalNewForm() {
      return '<div class="paint-modal-row"><label>Width</label><input type="number" min="1" max="8000" value="800" data-new-w /></div>' +
             '<div class="paint-modal-row"><label>Height</label><input type="number" min="1" max="8000" value="600" data-new-h /></div>' +
             '<div class="paint-modal-row"><label>Background</label>' +
             '<select data-new-bg>' +
             '<option value="transparent">Transparent</option>' +
             '<option value="#ffffff">White</option>' +
             '<option value="#000000">Black</option>' +
             '<option value="bg">Background color</option>' +
             '</select></div>';
    }

    _newDocument(opts) {
      const w = clamp(opts.width|0,  1, 8000);
      const h = clamp(opts.height|0, 1, 8000);
      let fill = opts.fill;
      if (fill === "bg") fill = this._cssColor(this.color.bg);
      this.doc = {
        name: "Untitled",
        path: null,
        width: w, height: h,
        layers: [],
        active: -1,
        bg: fill,
      };
      this.dom.display.width = w; this.dom.display.height = h;
      this.dom.overlay.width = w; this.dom.overlay.height = h;
      this._addLayer({ name: "Background", initialFill: fill === "transparent" ? "transparent" : fill });
      this.doc.active = 0;
      this.history = { stack: [], index: -1 };
      this._pushHistory("new");
      this._fitInitial();
      this._renderLayers();
      this._render();
    }

    _dialogOpen() {
      const fs = window.FileSystem;
      if (!fs) {
        // Fallback: native file dialog
        if (this.dom.fileInput) this.dom.fileInput.click();
        return;
      }
      // Pull list of image-ish files from FS
      const files = this._listImageFiles();
      const list = files.map((p) => '<div class="paint-fm-item" data-fpath="' + escapeHtml(p) + '">📄 ' + escapeHtml(p) + '</div>').join("") || '<div class="paint-fm-item disabled">No images found</div>';
      this._showModal({
        title: "Open Image from Filesystem",
        body: '<div style="max-height:280px;overflow:auto;border:1px solid var(--p-border);background:var(--p-bg-1);padding:4px;">' + list + '</div>' +
              '<div style="margin-top:8px;"><button data-os-import>Import from disk…</button></div>',
        actions: [
          { label: "Close", onClick: () => this._closeModal() },
        ],
      });
      const r = this.dom.modalRoot;
      r.querySelectorAll('[data-fpath]').forEach((el) => {
        el.addEventListener("click", () => {
          this._closeModal();
          this._openFromPath(el.dataset.fpath);
        });
      });
      const imp = r.querySelector('[data-os-import]');
      if (imp) imp.addEventListener("click", () => { this._closeModal(); this._importImage(); });
    }

    _listImageFiles() {
      const fs = window.FileSystem;
      const out = [];
      if (!fs) return out;
      const walk = (path) => {
        try {
          const items = fs.listDir(path);
          (items || []).forEach((it) => {
            const p = it.path || (path === "/" ? "/" + it.name : path + "/" + it.name);
            if (it.type === "folder" || it.kind === "folder") walk(p);
            else {
              const ext = getExt(p);
              if (IMG_EXTS.indexOf(ext) !== -1 || PROJ_EXTS.indexOf(ext) !== -1) out.push(p);
            }
          });
        } catch (_) {}
      };
      walk("/");
      return out;
    }

    _openFromPath(path) {
      const fs = window.FileSystem;
      if (!fs) return;
      const ext = getExt(path);
      if (PROJ_EXTS.indexOf(ext) !== -1) {
        try {
          const text = fs.readFile(path);
          const obj = JSON.parse(text);
          this._loadProject(obj);
          this.doc.name = path.split("/").pop();
          this.doc.path = path;
          this._updateStatus();
        } catch (e) {
          alert("Failed to load project: " + e.message);
        }
        return;
      }
      // raster image: read content, decode via blob URL when we can
      try {
        const text = fs.readFile(path);
        // Many WebOS files are stored as text; an SVG might be raw XML, others
        // could be data URIs we ourselves wrote. Try data URI first.
        if (typeof text === "string" && text.startsWith("data:image/")) {
          this._loadImageFromUrl(text, path);
        } else if (ext === "svg" || (typeof text === "string" && text.includes("<svg"))) {
          const blob = new Blob([text], { type: "image/svg+xml" });
          const url = URL.createObjectURL(blob);
          this._loadImageFromUrl(url, path, () => URL.revokeObjectURL(url));
        } else {
          // Treat raw text as base64 png if it looks like it
          if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 100) {
            this._loadImageFromUrl("data:image/png;base64," + text.replace(/\s+/g, ""), path);
          } else {
            alert("Unable to display this file as image: " + path);
          }
        }
      } catch (e) {
        alert("Open failed: " + e.message);
      }
    }

    _loadImageFromUrl(url, path, onDone) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        this._newDocument({ width: img.naturalWidth, height: img.naturalHeight, fill: "transparent" });
        const layer = this._activeLayer();
        const ctx = this._ctxFor(layer);
        ctx.drawImage(img, 0, 0);
        layer.thumbDirty = true;
        layer.name = path ? path.split("/").pop() : "Imported";
        this._pushHistory("open");
        this._renderLayers();
        this._render();
        if (path) {
          this.doc.name = path.split("/").pop();
          this.doc.path = path;
        }
        this._updateStatus();
        if (onDone) onDone();
      };
      img.onerror = () => {
        alert("Image load failed.");
        if (onDone) onDone();
      };
      img.src = url;
    }

    _importImage() {
      if (this.dom.fileInput) this.dom.fileInput.click();
    }

    _loadImageFromFile(file) {
      const url = URL.createObjectURL(file);
      this._loadImageFromUrl(url, file.name, () => URL.revokeObjectURL(url));
    }

    _save() {
      if (!this.doc.path) { this._dialogSaveAs(); return; }
      this._writePngToFs(this.doc.path);
    }

    _dialogSaveAs() {
      const def = (this.doc.name && this.doc.name !== "Untitled") ? this.doc.name : "image.png";
      const path = prompt("Save as path (e.g. /Documents/image.png):", "/Documents/" + def);
      if (!path) return;
      this._writePngToFs(path);
    }

    _dialogSaveProject() {
      const def = (this.doc.name || "project").replace(/\.[^.]+$/, "") + ".ospaint";
      const path = prompt("Save project as:", "/Documents/" + def);
      if (!path) return;
      this._writeProjectToFs(path);
    }

    _dialogExportPNG() {
      const url = this.dom.display.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = (this.doc.name || "image") + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    _writePngToFs(path) {
      const fs = window.FileSystem;
      if (!fs) { alert("No filesystem available."); return; }
      const url = this.dom.display.toDataURL("image/png");
      try {
        fs.writeFile(path, url, { mime: "image/png", kind: "image", icon: "🖼" });
        this.doc.name = path.split("/").pop();
        this.doc.path = path;
        this._updateStatus();
      } catch (e) {
        alert("Save failed: " + e.message);
      }
    }

    _writeProjectToFs(path) {
      const fs = window.FileSystem;
      if (!fs) { alert("No filesystem available."); return; }
      const obj = this._serializeProject();
      try {
        fs.writeFile(path, JSON.stringify(obj), { mime: "application/json", kind: "ospaint", icon: "🎨" });
        this.doc.name = path.split("/").pop();
        this.doc.path = path;
        this._updateStatus();
      } catch (e) {
        alert("Save failed: " + e.message);
      }
    }

    _serializeProject() {
      return {
        type: "ospaint",
        version: 1,
        width:  this.doc.width,
        height: this.doc.height,
        active: this.doc.active,
        layers: this.doc.layers.map((l) => ({
          name: l.name, visible: l.visible, locked: l.locked,
          opacity: l.opacity, blend: l.blend,
          dataUrl: l.canvas.toDataURL("image/png"),
        })),
      };
    }

    _loadProject(obj) {
      if (!obj || obj.type !== "ospaint") {
        alert("Not a valid OsPaint project file.");
        return;
      }
      this._newDocument({ width: obj.width, height: obj.height, fill: "transparent" });
      // Remove the auto-added background, then load each layer
      this.doc.layers = [];
      this.doc.active = -1;
      let pending = obj.layers.length;
      if (!pending) { this._addBaseLayer(); this._render(); this._renderLayers(); return; }
      obj.layers.forEach((src, i) => {
        const c = document.createElement("canvas");
        c.width = obj.width; c.height = obj.height;
        const img = new Image();
        img.onload = () => {
          c.getContext("2d").drawImage(img, 0, 0);
          this.doc.layers[i] = {
            id: uid("layer"), name: src.name || ("Layer " + (i+1)),
            visible: src.visible !== false, locked: !!src.locked,
            opacity: src.opacity || 100, blend: src.blend || "source-over",
            canvas: c, thumbDirty: true,
          };
          if (--pending === 0) {
            this.doc.active = clamp(obj.active || 0, 0, this.doc.layers.length - 1);
            this._renderLayers();
            this._render();
            this._pushHistory("project-open");
          }
        };
        img.src = src.dataUrl;
      });
    }

    _dialogResize() {
      this._showModal({
        title: "Resize Canvas",
        body: '<div class="paint-modal-row"><label>Width</label><input type="number" value="' + this.doc.width + '" data-rs-w /></div>' +
              '<div class="paint-modal-row"><label>Height</label><input type="number" value="' + this.doc.height + '" data-rs-h /></div>' +
              '<div class="paint-modal-row"><label>Mode</label><select data-rs-mode>' +
              '<option value="canvas">Canvas (no scaling)</option>' +
              '<option value="scale">Scale Image</option>' +
              '</select></div>',
        actions: [
          { label: "Cancel", onClick: () => this._closeModal() },
          { label: "Apply", primary: true, onClick: () => {
            const r = this.dom.modalRoot;
            const w = parseInt(r.querySelector('[data-rs-w]').value, 10);
            const h = parseInt(r.querySelector('[data-rs-h]').value, 10);
            const m = r.querySelector('[data-rs-mode]').value;
            this._closeModal();
            this._resizeCanvas(w, h, m);
          }},
        ],
      });
    }

    _resizeCanvas(w, h, mode) {
      w = clamp(w|0, 1, 8000);
      h = clamp(h|0, 1, 8000);
      this.doc.layers = this.doc.layers.map((l) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (mode === "scale") {
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(l.canvas, 0, 0, w, h);
        } else {
          ctx.drawImage(l.canvas, 0, 0);
        }
        l.canvas = c; l.thumbDirty = true;
        return l;
      });
      this.doc.width = w; this.doc.height = h;
      this.dom.display.width = w; this.dom.display.height = h;
      this.dom.overlay.width = w; this.dom.overlay.height = h;
      this._pushHistory("resize");
      this._applyZoomCss();
      this._renderLayers();
      this._render();
    }

    _dialogShortcuts() {
      const rows = SHORTCUT_HELP.map((r) =>
        '<tr><td style="padding:2px 14px 2px 0;color:var(--p-fg-2);">' + escapeHtml(r[0]) +
        '</td><td style="padding:2px 0;font-family:monospace;">' + escapeHtml(r[1]) + '</td></tr>'
      ).join("");
      this._showModal({
        title: "Keyboard Shortcuts",
        body: '<div style="max-height:380px;overflow:auto;"><table style="border-collapse:collapse;width:100%;">' + rows + '</table></div>',
        actions: [{ label: "OK", primary: true, onClick: () => this._closeModal() }],
      });
    }

    _dialogAbout() {
      this._showModal({
        title: "About OsPaint",
        body: '<div style="text-align:center;padding:14px;">' +
              '<div style="font-size:36px;">🎨</div>' +
              '<h3 style="margin:6px 0;">OsPaint</h3>' +
              '<div style="opacity:0.7;">A multi-layer raster paint app for WebOS.</div>' +
              '<div style="margin-top:14px;font-size:11px;opacity:0.6;">Day 4 build · v1.0</div>' +
              '</div>',
        actions: [{ label: "OK", primary: true, onClick: () => this._closeModal() }],
      });
    }

    /* --------------------------------------------------------------------
     * 1.25  MODALS
     * ----------------------------------------------------------------- */
    _showModal(opts) {
      const r = this.dom.modalRoot;
      if (!r) return;
      r.hidden = false;
      r.innerHTML = "";
      const m = document.createElement("div");
      m.className = "paint-modal";
      m.innerHTML = '<div class="paint-modal-head">' + escapeHtml(opts.title || "") + '</div>' +
                    '<div class="paint-modal-body">' + (opts.body || "") + '</div>' +
                    '<div class="paint-modal-foot"></div>';
      const foot = m.querySelector(".paint-modal-foot");
      (opts.actions || []).forEach((a) => {
        const b = document.createElement("button");
        b.textContent = a.label;
        if (a.primary) b.classList.add("primary");
        b.addEventListener("click", a.onClick);
        foot.appendChild(b);
      });
      r.appendChild(m);
    }

    _closeModal() {
      const r = this.dom.modalRoot;
      if (!r) return;
      r.hidden = true;
      r.innerHTML = "";
    }

  }

  /* =========================================================================
   * 2.  CONSTANTS used by methods that reference them
   * ====================================================================== */
  const TOOL_META = {
    move:       { label: "Move",         icon: "✥" },
    select:     { label: "Select Rect",  icon: "▭" },
    pencil:     { label: "Pencil",       icon: "✎" },
    brush:      { label: "Brush",        icon: "🖌" },
    eraser:     { label: "Eraser",       icon: "🧽" },
    fill:       { label: "Fill",         icon: "🪣" },
    eyedropper: { label: "Eyedropper",   icon: "💧" },
    text:       { label: "Text",         icon: "T" },
    rect:       { label: "Rectangle",    icon: "▢" },
    ellipse:    { label: "Ellipse",      icon: "◯" },
    line:       { label: "Line",         icon: "╱" },
    triangle:   { label: "Triangle",     icon: "△" },
    polygon:    { label: "Polygon",      icon: "⬡" },
    star:       { label: "Star",         icon: "★" },
    zoom:       { label: "Zoom",         icon: "🔍" },
    hand:       { label: "Hand",         icon: "✋" },
  };

  const SHORTCUT_HELP = [
    ["New",                     "Ctrl+N"],
    ["Open",                    "Ctrl+O"],
    ["Save",                    "Ctrl+S"],
    ["Save As",                 "Ctrl+Shift+S"],
    ["Export PNG",              "Ctrl+E"],
    ["Undo",                    "Ctrl+Z"],
    ["Redo",                    "Ctrl+Y / Ctrl+Shift+Z"],
    ["Cut",                     "Ctrl+X"],
    ["Copy",                    "Ctrl+C"],
    ["Paste",                   "Ctrl+V"],
    ["Select All",              "Ctrl+A"],
    ["Deselect",                "Ctrl+D"],
    ["Invert Selection",        "Ctrl+Shift+I"],
    ["Invert Colors",           "Ctrl+I"],
    ["Zoom In / Out",           "Ctrl++ / Ctrl+-"],
    ["Fit Window",              "Ctrl+Shift+H"],
    ["Actual Size 100%",        "Ctrl+1"],
    ["New Layer",               "Ctrl+Shift+N"],
    ["Duplicate Layer",         "Ctrl+J"],
    ["Merge Down",              "Ctrl+Shift+E"],
    ["Merge Visible",           "Ctrl+Alt+E"],
    ["Brush Tool",              "B"],
    ["Pencil Tool",             "P"],
    ["Eraser Tool",             "E"],
    ["Fill Tool",               "G"],
    ["Eyedropper",              "I"],
    ["Text Tool",               "T"],
    ["Select Rectangle",        "M"],
    ["Move Tool",               "V"],
    ["Zoom Tool",               "Z"],
    ["Hand Tool",               "H"],
    ["Swap FG / BG colors",     "X"],
    ["Reset to black/white",    "D"],
    ["Decrease brush size",     "["],
    ["Increase brush size",     "]"],
    ["Pan canvas",              "Hold Space + drag"],
    ["Constrain shape",         "Hold Shift while drawing"],
  ];

  /* =========================================================================
   * 3.  REGISTER WITH WINDOW MANAGER
   * ====================================================================== */
  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id: APP_ID,
      title: APP_TITLE,
      icon: APP_ICON,
      width: 1100, height: 720,
      minWidth: 720, minHeight: 480,
      category: APP_CATEGORY,
      pinned: true,
      canOpen: (md) => {
        if (!md) return false;
        if (md.type === "folder") return false;
        const ext = getExt(md.path || md.name || "");
        return IMG_EXTS.indexOf(ext) !== -1 || PROJ_EXTS.indexOf(ext) !== -1;
      },
      render(body, win) {
        const app = new OsPaint(body, win.opts || {});
        app.mount();
        win._ospaint = app;
      },
      onClose(win) {
        if (win._ospaint) win._ospaint.destroy();
      },
    });
    console.log("%c[WebOS]%c OsPaint registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* =========================================================================
   * 4.  EXTRA UTILITIES (filter helpers, mask helpers, etc.)
   *     Exported on window.OsPaint for tests and other apps.
   * ====================================================================== */

  /**
   * Apply a 3x3 convolution kernel to an ImageData and return new ImageData.
   * Used by some image-processing features (grayscale already inline; here we
   * provide more for future features and tests).
   */
  function convolve(imageData, kernel, divisor, offset) {
    divisor = divisor || 1;
    offset  = offset  || 0;
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const k = kernel;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let r = 0, g = 0, b = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const i = ((y + ky) * w + (x + kx)) * 4;
            const wgt = k[(ky + 1) * 3 + (kx + 1)];
            r += src[i  ] * wgt;
            g += src[i+1] * wgt;
            b += src[i+2] * wgt;
          }
        }
        const i = (y * w + x) * 4;
        out[i  ] = clamp((r / divisor) + offset, 0, 255);
        out[i+1] = clamp((g / divisor) + offset, 0, 255);
        out[i+2] = clamp((b / divisor) + offset, 0, 255);
        out[i+3] = src[i+3];
      }
    }
    return new ImageData(out, w, h);
  }

  /**
   * Box blur an ImageData with the given radius. Fast enough for small layers.
   */
  function boxBlur(imageData, radius) {
    radius = clamp(radius | 0, 0, 50);
    if (radius === 0) return imageData;
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const tmp = new Uint8ClampedArray(src.length);
    const out = new Uint8ClampedArray(src.length);
    // Horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let kx = -radius; kx <= radius; kx++) {
          const xx = clamp(x + kx, 0, w - 1);
          const i = (y * w + xx) * 4;
          r += src[i]; g += src[i+1]; b += src[i+2]; a += src[i+3];
          count++;
        }
        const j = (y * w + x) * 4;
        tmp[j  ] = r / count;
        tmp[j+1] = g / count;
        tmp[j+2] = b / count;
        tmp[j+3] = a / count;
      }
    }
    // Vertical
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let ky = -radius; ky <= radius; ky++) {
          const yy = clamp(y + ky, 0, h - 1);
          const i = (yy * w + x) * 4;
          r += tmp[i]; g += tmp[i+1]; b += tmp[i+2]; a += tmp[i+3];
          count++;
        }
        const j = (y * w + x) * 4;
        out[j  ] = r / count;
        out[j+1] = g / count;
        out[j+2] = b / count;
        out[j+3] = a / count;
      }
    }
    return new ImageData(out, w, h);
  }

  /**
   * Adjust brightness and contrast of an ImageData. brightness in [-100,100],
   * contrast in [-100,100]. Returns a new ImageData.
   */
  function adjustBrightnessContrast(imageData, brightness, contrast) {
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const b = brightness * 2.55;
    const c = (contrast / 100) + 1;
    const intercept = 128 * (1 - c);
    for (let i = 0; i < src.length; i += 4) {
      out[i  ] = clamp(c * src[i  ] + intercept + b, 0, 255);
      out[i+1] = clamp(c * src[i+1] + intercept + b, 0, 255);
      out[i+2] = clamp(c * src[i+2] + intercept + b, 0, 255);
      out[i+3] = src[i+3];
    }
    return new ImageData(out, w, h);
  }

  /**
   * Adjust saturation of an ImageData using HSL conversion. amount is in [-100,100].
   */
  function adjustSaturation(imageData, amount) {
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const k = amount / 100;
    for (let i = 0; i < src.length; i += 4) {
      const r = src[i], g = src[i+1], b = src[i+2];
      const hsl = rgbToHsl(r, g, b);
      hsl.s = clamp(hsl.s + hsl.s * k, 0, 100);
      const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);
      out[i  ] = rgb.r;
      out[i+1] = rgb.g;
      out[i+2] = rgb.b;
      out[i+3] = src[i+3];
    }
    return new ImageData(out, w, h);
  }

  /**
   * Posterize each channel into N levels.
   */
  function posterize(imageData, levels) {
    levels = clamp(levels | 0, 2, 16);
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const step = 255 / (levels - 1);
    for (let i = 0; i < src.length; i += 4) {
      out[i  ] = Math.round(Math.round(src[i  ] / step) * step);
      out[i+1] = Math.round(Math.round(src[i+1] / step) * step);
      out[i+2] = Math.round(Math.round(src[i+2] / step) * step);
      out[i+3] = src[i+3];
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  /**
   * Threshold to pure black/white given a 0..255 cutoff.
   */
  function threshold(imageData, cutoff) {
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const v = (src[i] * 0.299 + src[i+1] * 0.587 + src[i+2] * 0.114) | 0;
      const b = v >= cutoff ? 255 : 0;
      out[i  ] = b; out[i+1] = b; out[i+2] = b;
      out[i+3] = src[i+3];
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  /**
   * Sepia tone effect.
   */
  function sepia(imageData, amount) {
    amount = clamp(amount, 0, 1);
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const r = src[i], g = src[i+1], b = src[i+2];
      const tr = 0.393*r + 0.769*g + 0.189*b;
      const tg = 0.349*r + 0.686*g + 0.168*b;
      const tb = 0.272*r + 0.534*g + 0.131*b;
      out[i  ] = clamp(lerp(r, tr, amount), 0, 255);
      out[i+1] = clamp(lerp(g, tg, amount), 0, 255);
      out[i+2] = clamp(lerp(b, tb, amount), 0, 255);
      out[i+3] = src[i+3];
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  /**
   * Edge detect (Sobel).
   */
  function sobel(imageData) {
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    const gxK = [-1,0,1,-2,0,2,-1,0,1];
    const gyK = [-1,-2,-1,0,0,0,1,2,1];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let gx = 0, gy = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const i = ((y + ky) * w + (x + kx)) * 4;
            const v = src[i] * 0.299 + src[i+1] * 0.587 + src[i+2] * 0.114;
            const ki = (ky + 1) * 3 + (kx + 1);
            gx += v * gxK[ki];
            gy += v * gyK[ki];
          }
        }
        const m = Math.min(255, Math.sqrt(gx*gx + gy*gy));
        const i = (y * w + x) * 4;
        out[i  ] = m; out[i+1] = m; out[i+2] = m; out[i+3] = src[i+3];
      }
    }
    return new ImageData(out, w, h);
  }

  /**
   * Pixelate to NxN blocks (cheap nearest-neighbor downsample/upscale).
   */
  function pixelate(imageData, size) {
    size = clamp(size | 0, 2, 64);
    const w = imageData.width, h = imageData.height;
    const src = imageData.data;
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const i = ((y + dy) * w + (x + dx)) * 4;
            r += src[i]; g += src[i+1]; b += src[i+2]; a += src[i+3]; n++;
          }
        }
        r /= n; g /= n; b /= n; a /= n;
        for (let dy = 0; dy < size && y + dy < h; dy++) {
          for (let dx = 0; dx < size && x + dx < w; dx++) {
            const i = ((y + dy) * w + (x + dx)) * 4;
            out[i  ] = r; out[i+1] = g; out[i+2] = b; out[i+3] = a;
          }
        }
      }
    }
    return new ImageData(out, w, h);
  }

  /**
   * Compute a histogram of luminance values for an ImageData.
   */
  function histogram(imageData) {
    const src = imageData.data;
    const lum = new Uint32Array(256);
    const r   = new Uint32Array(256);
    const g   = new Uint32Array(256);
    const b   = new Uint32Array(256);
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i+3];
      if (a === 0) continue;
      const ll = (src[i] * 0.299 + src[i+1] * 0.587 + src[i+2] * 0.114) | 0;
      lum[ll]++;
      r[src[i]]++;
      g[src[i+1]]++;
      b[src[i+2]]++;
    }
    return { lum, r, g, b };
  }


  /* =========================================================================
   * 5.  EXPOSE
   * ====================================================================== */
  window.OsPaint = {
    APP_ID, IMG_EXTS, PROJ_EXTS, BLEND_MODES,
    rgbToHex, hexToRgb, rgbToHsl, hslToRgb, parseColorString,
    convolve, boxBlur, adjustBrightnessContrast, adjustSaturation,
    posterize, threshold, sepia, sobel, pixelate, histogram,
    open(path) {
      return window.WindowManager.openApp(APP_ID, { openPath: path });
    },
  };

})();
