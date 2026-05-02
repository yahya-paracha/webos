/* ============================================================================
 * WebOS — tetris.js  (OsTetris)
 * ----------------------------------------------------------------------------
 * Modern Tetris implementation with the SRS rotation system, lock delay,
 * hold piece, ghost piece, T-spin scoring, level/gravity progression, and
 * persistent high scores.
 *
 *   • All 7 tetrominoes (I, O, T, S, Z, J, L) with correct SRS rotation
 *   • Ghost piece (faint preview at landing position)
 *   • Hold piece (one swap per piece)
 *   • Next preview (3 upcoming pieces) using a 7-bag randomizer
 *   • Wall kicks (SRS, with separate I-piece kick table)
 *   • Lock delay 0.5s, ARE 0.2s before next piece
 *   • Scoring: single/double/triple/Tetris × level, T-spin bonus, B2B bonus
 *   • Soft drop +1pt/cell, hard drop +2pt/cell
 *   • Level up every 10 lines; gravity 800ms (L1) → 50ms (L20+)
 *   • Pause / restart / game over / high score table
 *   • Top 10 high scores in /.games/tetris_scores.json (FileSystem)
 *
 * Public API on  window.Tetris
 * ==========================================================================*/

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
   * Constants
   * --------------------------------------------------------------------- */
  const APP_ID    = "tetris";
  const APP_TITLE = "OsTetris";
  const APP_ICON  = "🟦";

  const SCORES_PATH = "/.games/tetris_scores.json";
  const PREFS_KEY   = "webos.tetris.prefs.v1";

  const COLS = 10;
  const ROWS = 20;
  const HIDDEN_ROWS = 2; // spawn buffer above visible play area
  const TOTAL_ROWS = ROWS + HIDDEN_ROWS;

  const CELL = 30;          // px size of a cell on the main board
  const MINI_CELL = 18;     // px size for hold/next previews

  const LOCK_DELAY = 500;   // ms after grounded before lock
  const ARE_DELAY  = 200;   // ms between lock and next spawn
  const DAS = 160;          // delayed auto-shift (ms)
  const ARR = 50;           // auto repeat rate (ms)

  const SOFT_DROP_PT  = 1;
  const HARD_DROP_PT  = 2;
  const LINE_PTS = [0, 100, 300, 500, 800];   // index = lines cleared
  const TSPIN_PTS = { mini: 100, full_0: 400, full_1: 800, full_2: 1200, full_3: 1600 };
  const BACK_TO_BACK_MULT = 1.5;

  const GRAVITY_MS = (level) => {
    // Maps level → ms per gravity step; smooth-ish curve like NES/modern Tetris.
    const table = [
      800, 720, 630, 550, 470, 380, 300, 220, 150, 110,
      90,  80,  70,  60,  55,  50,  45,  40,  37,  33, 30
    ];
    if (level < 1)  level = 1;
    if (level >= table.length) return 25;
    return table[level - 1];
  };

  /* -----------------------------------------------------------------------
   * Tetromino shapes — we store rotation states explicitly because that's
   * what SRS expects. Each state is a list of (r,c) offsets relative to the
   * piece's pivot at (0,0) for the 4 rotations: 0=spawn, 1=R, 2=2, 3=L.
   * --------------------------------------------------------------------- */
  // Using 4×4 matrices (rows×cols, '1' = filled). Easier to visualise.
  const SHAPES = {
    I: [
      [
        [0,0,0,0],
        [1,1,1,1],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,0,1,0],
        [0,0,1,0],
        [0,0,1,0],
        [0,0,1,0],
      ],
      [
        [0,0,0,0],
        [0,0,0,0],
        [1,1,1,1],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [0,1,0,0],
        [0,1,0,0],
        [0,1,0,0],
      ],
    ],
    O: [
      [
        [0,1,1,0],
        [0,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,1,0],
        [0,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,1,0],
        [0,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,1,0],
        [0,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
    ],
    T: [
      [
        [0,1,0,0],
        [1,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [0,1,1,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
      [
        [0,0,0,0],
        [1,1,1,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [1,1,0,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
    ],
    S: [
      [
        [0,1,1,0],
        [1,1,0,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [0,1,1,0],
        [0,0,1,0],
        [0,0,0,0],
      ],
      [
        [0,0,0,0],
        [0,1,1,0],
        [1,1,0,0],
        [0,0,0,0],
      ],
      [
        [1,0,0,0],
        [1,1,0,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
    ],
    Z: [
      [
        [1,1,0,0],
        [0,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,0,1,0],
        [0,1,1,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
      [
        [0,0,0,0],
        [1,1,0,0],
        [0,1,1,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [1,1,0,0],
        [1,0,0,0],
        [0,0,0,0],
      ],
    ],
    J: [
      [
        [1,0,0,0],
        [1,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,1,0],
        [0,1,0,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
      [
        [0,0,0,0],
        [1,1,1,0],
        [0,0,1,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [0,1,0,0],
        [1,1,0,0],
        [0,0,0,0],
      ],
    ],
    L: [
      [
        [0,0,1,0],
        [1,1,1,0],
        [0,0,0,0],
        [0,0,0,0],
      ],
      [
        [0,1,0,0],
        [0,1,0,0],
        [0,1,1,0],
        [0,0,0,0],
      ],
      [
        [0,0,0,0],
        [1,1,1,0],
        [1,0,0,0],
        [0,0,0,0],
      ],
      [
        [1,1,0,0],
        [0,1,0,0],
        [0,1,0,0],
        [0,0,0,0],
      ],
    ],
  };

  // Piece colors (CSS variables defined in tetris.css)
  const COLORS = {
    I: "#00ddff",
    O: "#ffd700",
    T: "#b400ff",
    S: "#00e676",
    Z: "#ff3344",
    J: "#2962ff",
    L: "#ff8a00",
  };
  const GLOW = {
    I: "rgba(0,221,255,0.55)",
    O: "rgba(255,215,0,0.55)",
    T: "rgba(180,0,255,0.55)",
    S: "rgba(0,230,118,0.55)",
    Z: "rgba(255,51,68,0.55)",
    J: "rgba(41,98,255,0.55)",
    L: "rgba(255,138,0,0.55)",
  };

  const PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"];

  /* -----------------------------------------------------------------------
   * SRS wall-kick tables
   *   Index by [from-rotation][to-rotation].  The four rotations are
   *   0 (spawn), 1 (R = 90°cw), 2 (180), 3 (L = 90°ccw).
   *   For non-I, non-O pieces we use the standard JLSTZ table.  I uses its
   *   own table.  O has no kicks (rotations are identical).
   * --------------------------------------------------------------------- */
  const KICKS_JLSTZ = {
    "0>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "1>0": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "1>2": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "2>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "2>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
    "3>2": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "3>0": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "0>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  };
  const KICKS_I = {
    "0>1": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "1>0": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "1>2": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    "2>1": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "2>3": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "3>2": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "3>0": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "0>3": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  };
  // Note: the kick tuples are [dx, dy] (column, row) where dy is positive
  // *up* in classic SRS.  We invert dy because our rows grow downward.

  function kicks(type, from, to) {
    if (type === "O") return [[0, 0]];
    const table = type === "I" ? KICKS_I : KICKS_JLSTZ;
    const key   = from + ">" + to;
    const list  = table[key] || [[0, 0]];
    // convert dy → row delta (negative row = up)
    return list.map(([dx, dy]) => [dx, -dy]);
  }

  /* -----------------------------------------------------------------------
   * 7-bag randomizer
   * --------------------------------------------------------------------- */
  function newBag() {
    const arr = PIECE_TYPES.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /* =======================================================================
   * GAME STATE
   * ===================================================================== */
  function newField() {
    return Array.from({ length: TOTAL_ROWS }, () => Array(COLS).fill(null));
  }

  function newPiece(type) {
    return {
      type,
      rot:  0,
      r:    0,                      // top-left of piece bounding box
      c:    type === "O" ? 4 : 3,
      lastKick: null,
    };
  }

  function shapeOf(p) { return SHAPES[p.type][p.rot]; }
  function colorOf(t) { return COLORS[t]; }

  function forEachCell(p, fn) {
    const s = shapeOf(p);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (s[r][c]) fn(p.r + r, p.c + c, r, c);
      }
    }
  }

  function collides(field, p, dr = 0, dc = 0, rot = null) {
    const s = SHAPES[p.type][rot != null ? rot : p.rot];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (!s[r][c]) continue;
        const fr = p.r + dr + r;
        const fc = p.c + dc + c;
        if (fc < 0 || fc >= COLS) return true;
        if (fr >= TOTAL_ROWS) return true;
        if (fr >= 0 && field[fr][fc]) return true;
      }
    }
    return false;
  }

  function lockPiece(field, p) {
    forEachCell(p, (r, c) => {
      if (r >= 0 && r < TOTAL_ROWS && c >= 0 && c < COLS) {
        field[r][c] = p.type;
      }
    });
  }

  function clearLines(field) {
    const cleared = [];
    for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
      if (field[r].every(x => x !== null)) cleared.push(r);
    }
    cleared.forEach(r => {
      field.splice(r, 1);
      field.unshift(Array(COLS).fill(null));
    });
    // Re-scan because indices shifted
    let n = 0;
    for (let r = 0; r < TOTAL_ROWS; r++) if (field[r].every(x => x !== null)) n++;
    return cleared.length;
  }

  function actuallyClearLines(field) {
    const linesToClear = [];
    for (let r = 0; r < TOTAL_ROWS; r++) {
      if (field[r].every(x => x !== null)) linesToClear.push(r);
    }
    // Remove from bottom to top to keep indices stable
    for (let i = linesToClear.length - 1; i >= 0; i--) {
      const r = linesToClear[i];
      field.splice(r, 1);
      field.unshift(Array(COLS).fill(null));
    }
    return linesToClear;
  }

  /* -----------------------------------------------------------------------
   * Drop position calculation (for ghost piece + hard drop)
   * --------------------------------------------------------------------- */
  function dropDistance(field, p) {
    let d = 0;
    while (!collides(field, p, d + 1, 0)) d++;
    return d;
  }

  /* -----------------------------------------------------------------------
   * Try rotate (with SRS kicks)
   * --------------------------------------------------------------------- */
  function tryRotate(field, p, dir) {
    const from = p.rot;
    const to   = (from + (dir > 0 ? 1 : 3)) % 4;
    const offsets = kicks(p.type, from, to);
    for (const [dc, dr] of offsets) {
      if (!collides(field, p, dr, dc, to)) {
        p.rot = to;
        p.r += dr;
        p.c += dc;
        p.lastKick = [dc, dr];
        return true;
      }
    }
    return false;
  }

  /* -----------------------------------------------------------------------
   * T-Spin detection
   *   Standard "3-corner" rule: piece must be a T, last successful action a
   *   rotation, and at least 3 of the 4 diagonal corners around the T's
   *   centre square must be filled (or out of bounds).
   * --------------------------------------------------------------------- */
  function detectTSpin(field, p, lastWasRotation, lastWasKickedFar) {
    if (p.type !== "T" || !lastWasRotation) return null;
    // T's centre square depends on rotation:
    // rot 0: centre is at (r+1, c+1), corners are 4 diagonals around it
    const cx = p.c + 1, cy = p.r + 1;
    const corners = [
      [cy - 1, cx - 1],  // top-left
      [cy - 1, cx + 1],  // top-right
      [cy + 1, cx - 1],  // bottom-left
      [cy + 1, cx + 1],  // bottom-right
    ];
    const filled = corners.map(([r, c]) => {
      if (c < 0 || c >= COLS || r < 0 || r >= TOTAL_ROWS) return true;
      return field[r][c] !== null;
    });
    const filledCount = filled.filter(Boolean).length;
    if (filledCount < 3) return null;

    // Determine front vs back corners based on rotation. Front = side T
    // points towards.
    const front = {
      0: [0, 1],   // top corners
      1: [1, 3],   // right corners
      2: [2, 3],   // bottom corners
      3: [0, 2],   // left corners
    }[p.rot];
    const frontFilled = (filled[front[0]] ? 1 : 0) + (filled[front[1]] ? 1 : 0);
    if (frontFilled === 2) return "full";
    if (lastWasKickedFar)  return "full"; // TST kicks promote mini→full
    return "mini";
  }

  /* =======================================================================
   * GAME CONTROLLER
   * ===================================================================== */
  class TetrisGame {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.prefs = this._loadPrefs();

      // play state
      this.field = newField();
      this.queue = newBag();
      this.queue.push(...newBag()); // keep at least 7 ahead
      this.cur = null;              // current piece
      this.holdType = null;
      this.canHold = true;
      this.score = 0;
      this.lines = 0;
      this.level = 1;
      this.startLevel = 1;
      this.combo = -1;
      this.b2b = false;
      this.lastClearTSpin = null;
      this.gravityTimer = 0;
      this.lockTimer = 0;
      this.areTimer  = 0;
      this.grounded  = false;
      this.gameOver  = false;
      this.paused    = false;
      this.running   = false;
      this.lastTs    = 0;
      this.startTime = 0;
      this.elapsed   = 0;
      this.lastWasRotation = false;
      this.lastKickFar     = false;

      // input state
      this.keys = Object.create(null);
      this.dasL = 0;  this.dasR = 0;
      this.softDropping = false;

      // canvases
      this.boardCv = null;
      this.holdCv  = null;
      this.nextCv1 = null;
      this.nextCv2 = null;
      this.nextCv3 = null;
      this._floaterRoot = null;

      // high scores
      this.highScores = [];
    }

    /* -- mount -------------------------------------------------------------- */
    async mount() {
      const html = await this._fetchTemplate();
      this.host.innerHTML = html;
      this.root = this.host.querySelector(".tetris-app");
      this.boardCv = this.root.querySelector("#tt-board");
      this.holdCv  = this.root.querySelector("#tt-hold");
      this.nextCv1 = this.root.querySelector("#tt-next-1");
      this.nextCv2 = this.root.querySelector("#tt-next-2");
      this.nextCv3 = this.root.querySelector("#tt-next-3");
      this._floaterRoot = this.root.querySelector(".tt-board-wrap");

      this._wireToolbar();
      this._wireKeys();
      await this._loadScores();
      this._renderHigh();
      this._renderAll();
      this._loop = this._loop.bind(this);
      this._raf = requestAnimationFrame(this._loop);
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      window.removeEventListener("keydown", this._kd);
      window.removeEventListener("keyup",   this._ku);
    }

    async _fetchTemplate() {
      try {
        const r = await fetch("apps/tetris/tetris.html");
        if (r.ok) return await r.text();
      } catch {}
      return _inlineFallback();
    }

    _loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) return Object.assign({ sound: true, startLevel: 1 }, JSON.parse(raw));
      } catch {}
      return { sound: true, startLevel: 1 };
    }
    _savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {}
    }

    /* -- toolbar wiring -------------------------------------------------- */
    _wireToolbar() {
      this.root.addEventListener("click", (e) => {
        const t = e.target.closest("[data-act]");
        if (!t) return;
        const a = t.dataset.act;
        switch (a) {
          case "new":          this.newGame(); break;
          case "restart":      this.newGame(); break;
          case "pause":        this.togglePause(); break;
          case "sound":        this.prefs.sound = !this.prefs.sound; this._savePrefs(); this._refreshSoundIcon(); break;
          case "scores":       this._openScores(); break;
          case "close-scores": this._closeScores(); break;
          case "reset-scores": this.highScores = []; this._saveScores(); this._renderHigh(); this._renderScoresList(); break;
        }
      });
      const lvlSel = this.root.querySelector('[data-act="startlevel"]');
      lvlSel.value = this.prefs.startLevel;
      lvlSel.addEventListener("change", () => {
        this.prefs.startLevel = parseInt(lvlSel.value, 10) || 1;
        this._savePrefs();
      });
      this._refreshSoundIcon();
    }

    _refreshSoundIcon() {
      const b = this.root.querySelector('[data-act="sound"]');
      if (b) b.textContent = this.prefs.sound ? "🔊" : "🔇";
    }

    _openScores() {
      const m = this.root.querySelector("#tt-scores-modal");
      if (!m) return;
      m.hidden = false;
      this._renderScoresList();
    }
    _closeScores() {
      const m = this.root.querySelector("#tt-scores-modal");
      if (m) m.hidden = true;
    }

    /* -- new game ---------------------------------------------------------- */
    newGame() {
      this.field = newField();
      this.queue = newBag();
      this.queue.push(...newBag());
      this.holdType = null;
      this.canHold  = true;
      this.score = 0;
      this.lines = 0;
      this.startLevel = this.prefs.startLevel || 1;
      this.level = this.startLevel;
      this.combo = -1;
      this.b2b   = false;
      this.gravityTimer = 0;
      this.lockTimer = 0;
      this.areTimer  = 0;
      this.grounded  = false;
      this.gameOver  = false;
      this.paused    = false;
      this.running   = true;
      this.lastTs    = performance.now();
      this.startTime = performance.now();
      this.elapsed   = 0;
      this._spawnNext();
      this._hideOverlays();
      this._renderAll();
    }

    togglePause() {
      if (!this.running || this.gameOver) return;
      this.paused = !this.paused;
      const ov = this.root.querySelector("#tt-pause-ov");
      if (ov) ov.hidden = !this.paused;
      if (!this.paused) this.lastTs = performance.now();
    }

    _hideOverlays() {
      ["tt-pause-ov", "tt-over-ov", "tt-ready-ov"].forEach(id => {
        const el = this.root.querySelector("#" + id);
        if (el) el.hidden = true;
      });
    }

    /* -- spawning + hold ---------------------------------------------------- */
    _spawnNext() {
      if (this.queue.length < 7) this.queue.push(...newBag());
      const t = this.queue.shift();
      this.cur = newPiece(t);
      this.canHold = true;
      this.lockTimer = 0;
      this.grounded  = false;
      this.lastWasRotation = false;
      this.lastKickFar     = false;
      // Top-out: if the new piece collides immediately, game over
      if (collides(this.field, this.cur)) {
        this._endGame();
      }
    }

    _hold() {
      if (!this.cur || !this.canHold) return;
      const t = this.cur.type;
      if (this.holdType == null) {
        this.holdType = t;
        this._spawnNext();
      } else {
        const prev = this.holdType;
        this.holdType = t;
        this.cur = newPiece(prev);
        if (collides(this.field, this.cur)) this._endGame();
      }
      this.canHold = false;
      this._renderAll();
    }

    /* -- main loop --------------------------------------------------------- */
    _loop(ts) {
      this._raf = requestAnimationFrame(this._loop);
      if (!this.running || this.paused || this.gameOver || !this.cur) {
        this.lastTs = ts;
        this._renderBoard();
        return;
      }
      const dt = Math.min(50, ts - this.lastTs);
      this.lastTs = ts;
      this.elapsed += dt;
      this._tick(dt);
      this._renderAll();
    }

    _tick(dt) {
      // DAS / ARR for held arrows
      if (this.keys["ArrowLeft"]) {
        this.dasL += dt;
        if (this.dasL >= DAS) {
          while (this.dasL >= DAS) {
            this.dasL -= ARR;
            this._move(-1);
          }
        }
      }
      if (this.keys["ArrowRight"]) {
        this.dasR += dt;
        if (this.dasR >= DAS) {
          while (this.dasR >= DAS) {
            this.dasR -= ARR;
            this._move(1);
          }
        }
      }

      // Soft drop
      if (this.softDropping) {
        this.gravityTimer += dt * 20; // accelerate
      }
      this.gravityTimer += dt;
      const g = GRAVITY_MS(this.level);
      while (this.gravityTimer >= g) {
        this.gravityTimer -= g;
        this._gravityStep();
      }

      // Lock delay
      if (this.grounded) {
        this.lockTimer += dt;
        if (this.lockTimer >= LOCK_DELAY) this._lock();
      }
    }

    _gravityStep() {
      if (!this.cur) return;
      if (collides(this.field, this.cur, 1, 0)) {
        this.grounded = true;
        // do not advance row
      } else {
        this.cur.r++;
        this.grounded = false;
        this.lockTimer = 0;
        this.lastWasRotation = false;
        if (this.softDropping) this.score += SOFT_DROP_PT;
      }
    }

    _move(dx) {
      if (!this.cur) return false;
      if (!collides(this.field, this.cur, 0, dx)) {
        this.cur.c += dx;
        this.lastWasRotation = false;
        // reset lock delay on movement while grounded
        if (this.grounded) this.lockTimer = 0;
        // re-check grounded
        if (!collides(this.field, this.cur, 1, 0)) this.grounded = false;
        return true;
      }
      return false;
    }

    _rotate(dir) {
      if (!this.cur) return false;
      const ok = tryRotate(this.field, this.cur, dir);
      if (ok) {
        this.lastWasRotation = true;
        this.lastKickFar = !!(this.cur.lastKick &&
          (Math.abs(this.cur.lastKick[0]) >= 2 || Math.abs(this.cur.lastKick[1]) >= 2));
        if (this.grounded) this.lockTimer = 0;
        if (!collides(this.field, this.cur, 1, 0)) this.grounded = false;
      }
      return ok;
    }

    _hardDrop() {
      if (!this.cur) return;
      const d = dropDistance(this.field, this.cur);
      this.cur.r += d;
      this.score += HARD_DROP_PT * d;
      this._lock();
    }

    _lock() {
      if (!this.cur) return;
      // T-spin detection BEFORE clearing lines
      const tspin = detectTSpin(this.field, this.cur, this.lastWasRotation, this.lastKickFar);

      lockPiece(this.field, this.cur);
      this._playSound("lock");

      const cleared = actuallyClearLines(this.field);
      const n = cleared.length;
      this._scoreClear(n, tspin);
      this._flashLines(cleared);

      if (n > 0) this._playSound(n === 4 ? "tetris" : "clear");
      this.cur = null;
      this.grounded = false;
      this.lockTimer = 0;
      // ARE delay before next spawn
      this.areTimer = ARE_DELAY;
      setTimeout(() => {
        if (!this.running || this.gameOver) return;
        this._spawnNext();
      }, ARE_DELAY);
    }

    _scoreClear(n, tspin) {
      // Update lines/level
      let pts = 0;
      let isDifficult = false; // for back-to-back tracking
      if (tspin) {
        // T-spin scoring
        if (tspin === "mini") {
          pts = TSPIN_PTS.mini * this.level;
        } else {
          pts = (TSPIN_PTS["full_" + n] || TSPIN_PTS.full_0) * this.level;
        }
        if (n >= 1) isDifficult = true;
      } else if (n > 0) {
        pts = LINE_PTS[n] * this.level;
        if (n === 4) isDifficult = true;
      }

      // Back-to-back bonus
      if (isDifficult && this.b2b) pts = Math.floor(pts * BACK_TO_BACK_MULT);
      this.b2b = isDifficult ? true : (n > 0 ? false : this.b2b);

      // Combo bonus
      if (n > 0) {
        this.combo++;
        if (this.combo > 0) pts += 50 * this.combo * this.level;
      } else {
        this.combo = -1;
      }

      this.score += pts;
      this.lines += n;
      const newLevel = Math.max(this.level, this.startLevel + Math.floor(this.lines / 10));
      if (newLevel !== this.level) {
        this.level = newLevel;
        this._playSound("levelup");
      }

      // Floating score
      if (pts > 0) {
        let label = (n === 1 ? "SINGLE" : n === 2 ? "DOUBLE" :
                     n === 3 ? "TRIPLE" : n === 4 ? "TETRIS" : "");
        if (tspin === "full") label = "T-SPIN " + label;
        else if (tspin === "mini") label = "T-SPIN MINI " + label;
        if (this.b2b && isDifficult) label = "B2B " + label;
        if (this.combo > 0) label += " ×" + (this.combo + 1);
        this._floater(label.trim() + "  +" + pts);
      }
    }

    _flashLines(cleared) {
      // Visual line clear flash (positioned over the canvas)
      cleared.forEach((rIdx) => {
        const flash = document.createElement("div");
        flash.className = "tt-line-flash";
        flash.style.left = "0";
        flash.style.right = "0";
        flash.style.top = ((rIdx - HIDDEN_ROWS) * CELL) + "px";
        flash.style.height = CELL + "px";
        this._floaterRoot.appendChild(flash);
        setTimeout(() => flash.remove(), 350);
      });
    }

    _floater(text) {
      const f = document.createElement("div");
      f.className = "tt-floater";
      f.textContent = text;
      f.style.left = "50%";
      f.style.top  = "30%";
      f.style.transform = "translateX(-50%)";
      this._floaterRoot.appendChild(f);
      setTimeout(() => f.remove(), 1000);
    }

    /* -- end game -------------------------------------------------------- */
    _endGame() {
      this.gameOver = true;
      this.running  = false;
      this._playSound("over");
      const rank = this._addHighScore({
        score: this.score,
        lines: this.lines,
        level: this.level,
        time:  this.elapsed,
        date:  new Date().toISOString(),
      });
      this._renderAll();
      const ov = this.root.querySelector("#tt-over-ov");
      if (ov) {
        ov.hidden = false;
        ov.querySelector('[data-go="score"]').textContent = this.score.toLocaleString();
        ov.querySelector('[data-go="lines"]').textContent = this.lines;
        ov.querySelector('[data-go="level"]').textContent = this.level;
        ov.querySelector('[data-go="time"]').textContent  = this._fmtTime(this.elapsed);
        const rkEl = ov.querySelector('[data-go="rank"]');
        if (rank >= 0) rkEl.textContent = "🏆 New high score! Rank #" + (rank + 1);
        else rkEl.textContent = "";
      }
      // notify
      try {
        if (window.Notifications) {
          window.Notifications.info("OsTetris", "Game over — score " + this.score.toLocaleString());
        }
      } catch {}
    }

    _fmtTime(ms) {
      const sec = Math.floor(ms / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + ":" + (s < 10 ? "0" : "") + s;
    }

    /* -- high scores ----------------------------------------------------- */
    async _loadScores() {
      try {
        if (window.FileSystem && window.FileSystem.readJSON
            && window.FileSystem.exists(SCORES_PATH)) {
          const j = window.FileSystem.readJSON(SCORES_PATH);
          if (Array.isArray(j)) this.highScores = j;
        } else {
          const raw = localStorage.getItem("webos.tetris.scores");
          if (raw) this.highScores = JSON.parse(raw) || [];
        }
      } catch (e) {
        console.warn("[tetris] loadScores:", e);
      }
    }
    _saveScores() {
      try {
        if (window.FileSystem && window.FileSystem.writeJSON) {
          window.FileSystem.mkdirp && window.FileSystem.mkdirp("/.games");
          window.FileSystem.writeJSON(SCORES_PATH, this.highScores);
        }
        localStorage.setItem("webos.tetris.scores", JSON.stringify(this.highScores));
      } catch (e) {
        console.warn("[tetris] saveScores:", e);
      }
    }
    _addHighScore(entry) {
      const list = (this.highScores || []).slice();
      list.push(entry);
      list.sort((a, b) => b.score - a.score);
      const top = list.slice(0, 10);
      this.highScores = top;
      this._saveScores();
      return top.indexOf(entry);
    }

    /* -- keyboard ------------------------------------------------------- */
    _wireKeys() {
      this._kd = (e) => {
        if (!document.body.contains(this.host)) return;
        if (e.target && e.target.closest && e.target.closest("input, select, textarea")) return;
        const k = e.key;
        // Always-active keys
        if (k === "p" || k === "P" || k === "Escape") {
          e.preventDefault();
          this.togglePause();
          return;
        }
        if ((k === "r" || k === "R") && (e.ctrlKey || e.metaKey)) return; // let browser refresh
        if (k === " ") {
          e.preventDefault();
          if (!this.running || this.gameOver) { this.newGame(); return; }
          this._hardDrop();
          return;
        }
        if (this.gameOver || !this.running || this.paused) return;
        if (this.keys[k]) return;  // already pressed
        this.keys[k] = true;
        switch (k) {
          case "ArrowLeft":
            e.preventDefault(); this._move(-1); this.dasL = 0; break;
          case "ArrowRight":
            e.preventDefault(); this._move(1); this.dasR = 0; break;
          case "ArrowDown":
            e.preventDefault(); this.softDropping = true; break;
          case "ArrowUp":
          case "x":
          case "X":
            e.preventDefault(); this._rotate(1); break;
          case "z":
          case "Z":
            e.preventDefault(); this._rotate(-1); break;
          case "c":
          case "C":
          case "Shift":
            e.preventDefault(); this._hold(); break;
        }
      };
      this._ku = (e) => {
        const k = e.key;
        this.keys[k] = false;
        if (k === "ArrowLeft")  this.dasL = 0;
        if (k === "ArrowRight") this.dasR = 0;
        if (k === "ArrowDown")  this.softDropping = false;
      };
      window.addEventListener("keydown", this._kd);
      window.addEventListener("keyup",   this._ku);
    }

    /* -- audio ----------------------------------------------------------- */
    _playSound(kind) {
      if (!this.prefs.sound) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this._actx) this._actx = new Ctx();
        const ctx = this._actx;
        const now = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        let freq = 440, dur = 0.08, type = "square", gain = 0.05;
        switch (kind) {
          case "lock":    freq = 220; dur = 0.04; gain = 0.03; type = "triangle"; break;
          case "clear":   freq = 660; dur = 0.10; gain = 0.05; type = "sine"; break;
          case "tetris":  freq = 880; dur = 0.20; gain = 0.07; type = "sawtooth"; break;
          case "levelup": freq = 1320;dur = 0.18; gain = 0.05; type = "sine"; break;
          case "over":    freq = 130; dur = 0.45; gain = 0.06; type = "sawtooth"; break;
        }
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(gain, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        o.start(now);
        o.stop(now + dur);
      } catch {}
    }

    /* =====================================================================
     * RENDERING
     * =================================================================== */
    _renderAll() {
      this._renderBoard();
      this._renderHold();
      this._renderNext();
      this._renderHud();
    }

    _renderHud() {
      const setText = (id, v) => {
        const el = this.root.querySelector("#" + id);
        if (el) el.textContent = v;
      };
      setText("tt-score", this.score.toLocaleString());
      setText("tt-level", this.level);
      setText("tt-lines", this.lines);
      const high = this.highScores && this.highScores[0] ? this.highScores[0].score : 0;
      setText("tt-high", high.toLocaleString());
    }

    _renderHigh() {
      const high = this.highScores && this.highScores[0] ? this.highScores[0].score : 0;
      const el = this.root.querySelector("#tt-high");
      if (el) el.textContent = high.toLocaleString();
    }

    _renderBoard() {
      const cv = this.boardCv;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, cv.width, cv.height);

      // Grid background
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          ctx.strokeStyle = "rgba(255,255,255,0.04)";
          ctx.strokeRect(c * CELL + 0.5, r * CELL + 0.5, CELL - 1, CELL - 1);
        }
      }

      // Locked blocks
      for (let r = HIDDEN_ROWS; r < TOTAL_ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const t = this.field[r][c];
          if (!t) continue;
          this._drawCell(ctx, c, r - HIDDEN_ROWS, COLORS[t], 1);
        }
      }

      // Ghost piece
      if (this.cur && !this.gameOver) {
        const d = dropDistance(this.field, this.cur);
        forEachCell(this.cur, (rr, cc) => {
          const r = (rr + d) - HIDDEN_ROWS;
          if (r < 0 || r >= ROWS) return;
          this._drawGhost(ctx, cc, r, COLORS[this.cur.type]);
        });
      }
      // Active piece
      if (this.cur && !this.gameOver) {
        forEachCell(this.cur, (rr, cc) => {
          const r = rr - HIDDEN_ROWS;
          if (r < 0 || r >= ROWS) return;
          this._drawCell(ctx, cc, r, COLORS[this.cur.type], 1);
        });
      }
    }

    _drawCell(ctx, col, row, color, alpha) {
      const x = col * CELL;
      const y = row * CELL;
      const grad = ctx.createLinearGradient(x, y, x, y + CELL);
      grad.addColorStop(0, this._lighten(color, 0.4));
      grad.addColorStop(1, color);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, CELL, CELL);
      // bevel
      ctx.fillStyle = "rgba(255,255,255,0.20)";
      ctx.fillRect(x, y, CELL, 3);
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x, y + CELL - 3, CELL, 3);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fillRect(x, y, 3, CELL);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(x + CELL - 3, y, 3, CELL);
      // outer stroke
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
      ctx.globalAlpha = 1;
    }
    _drawGhost(ctx, col, row, color) {
      const x = col * CELL;
      const y = row * CELL;
      ctx.save();
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, CELL - 4, CELL - 4);
      ctx.restore();
    }
    _lighten(hex, amt) {
      // hex like #00ddff
      const m = /^#?([a-f0-9]{6})$/i.exec(hex);
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      r = Math.min(255, Math.round(r + (255 - r) * amt));
      g = Math.min(255, Math.round(g + (255 - g) * amt));
      b = Math.min(255, Math.round(b + (255 - b) * amt));
      return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
    }

    _renderHold() {
      const cv = this.holdCv;
      if (!cv) return;
      const ctx = cv.getContext("2d");
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!this.holdType) return;
      this._drawMiniPiece(ctx, this.holdType, cv.width, cv.height, !this.canHold);
    }

    _renderNext() {
      const drawAt = (cv, t, dimmed) => {
        if (!cv) return;
        const ctx = cv.getContext("2d");
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (t) this._drawMiniPiece(ctx, t, cv.width, cv.height, !!dimmed);
      };
      drawAt(this.nextCv1, this.queue[0], false);
      drawAt(this.nextCv2, this.queue[1], true);
      drawAt(this.nextCv3, this.queue[2], true);
    }

    _drawMiniPiece(ctx, type, w, h, dimmed) {
      const shape = SHAPES[type][0];
      // Compute bounding box of filled cells
      let minR = 4, maxR = -1, minC = 4, maxC = -1;
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
          if (shape[r][c]) {
            if (r < minR) minR = r; if (r > maxR) maxR = r;
            if (c < minC) minC = c; if (c > maxC) maxC = c;
          }
      const pw = (maxC - minC + 1);
      const ph = (maxR - minR + 1);
      const cell = Math.min(Math.floor(w / (pw + 1)), Math.floor(h / (ph + 1)), MINI_CELL);
      const ox = (w - pw * cell) / 2 - minC * cell;
      const oy = (h - ph * cell) / 2 - minR * cell;
      const color = COLORS[type];
      ctx.save();
      if (dimmed) ctx.globalAlpha = 0.5;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (!shape[r][c]) continue;
          const x = ox + c * cell;
          const y = oy + r * cell;
          const grad = ctx.createLinearGradient(x, y, x, y + cell);
          grad.addColorStop(0, this._lighten(color, 0.4));
          grad.addColorStop(1, color);
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, cell, cell);
          ctx.strokeStyle = "rgba(0,0,0,0.4)";
          ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
        }
      }
      ctx.restore();
    }

    _renderScoresList() {
      const host = this.root.querySelector("#tt-scores-list");
      if (!host) return;
      host.innerHTML = "";
      if (!this.highScores || this.highScores.length === 0) {
        host.innerHTML = '<div style="opacity:.6;text-align:center;padding:24px;">No scores yet — go play!</div>';
        return;
      }
      this.highScores.slice(0, 10).forEach((s, i) => {
        const row = document.createElement("div");
        row.className = "tt-score-row";
        const date = (s.date || "").slice(0, 10);
        row.innerHTML = `
          <span class="tt-rank">#${i + 1}</span>
          <span>L${s.level || 1} · ${s.lines || 0} lines</span>
          <span class="tt-pts">${(s.score || 0).toLocaleString()}</span>
          <span class="tt-when">${date}</span>
        `;
        host.appendChild(row);
      });
    }
  }

  /* -----------------------------------------------------------------------
   * Inline fallback markup
   * --------------------------------------------------------------------- */
  function _inlineFallback() {
    return `
      <div class="tetris-app">
        <div class="tt-toolbar">
          <button class="tt-btn tt-btn-primary" data-act="new">▶ New</button>
          <button class="tt-btn" data-act="pause">❚❚ Pause</button>
          <button class="tt-btn" data-act="restart">⟳ Restart</button>
          <span class="tt-spacer"></span>
          <select class="tt-select" data-act="startlevel">
            <option value="1" selected>Level 1</option>
            <option value="3">Level 3</option>
            <option value="5">Level 5</option>
            <option value="8">Level 8</option>
            <option value="10">Level 10</option>
            <option value="15">Level 15</option>
          </select>
          <button class="tt-btn tt-btn-icon" data-act="sound">🔊</button>
          <button class="tt-btn tt-btn-icon" data-act="scores">🏆</button>
        </div>
        <div class="tt-stage">
          <aside class="tt-side tt-side-left">
            <div class="tt-panel"><div class="tt-panel-title">HOLD</div><canvas class="tt-mini" id="tt-hold" width="120" height="120"></canvas></div>
            <div class="tt-panel"><div class="tt-panel-title">SCORE</div><div class="tt-num" id="tt-score">0</div></div>
            <div class="tt-panel"><div class="tt-panel-title">HIGH</div><div class="tt-num small" id="tt-high">0</div></div>
          </aside>
          <section class="tt-center">
            <div class="tt-board-wrap">
              <canvas class="tt-board" id="tt-board" width="300" height="600"></canvas>
              <div class="tt-overlay" id="tt-pause-ov" hidden><div class="tt-ov-card"><h2>PAUSED</h2><p>Press <kbd>P</kbd> to resume</p></div></div>
              <div class="tt-overlay" id="tt-over-ov" hidden>
                <div class="tt-ov-card">
                  <h2>GAME OVER</h2>
                  <div class="tt-ov-stats">
                    <div class="tt-ov-stat"><span>Score</span><b data-go="score">0</b></div>
                    <div class="tt-ov-stat"><span>Lines</span><b data-go="lines">0</b></div>
                    <div class="tt-ov-stat"><span>Level</span><b data-go="level">1</b></div>
                    <div class="tt-ov-stat"><span>Time</span><b data-go="time">0:00</b></div>
                  </div>
                  <p data-go="rank" class="tt-ov-rank"></p>
                  <button class="tt-btn tt-btn-primary" data-act="new">Play Again</button>
                </div>
              </div>
              <div class="tt-overlay" id="tt-ready-ov">
                <div class="tt-ov-card">
                  <h2>OsTetris</h2>
                  <p>Press <kbd>Space</kbd> or <b>New</b> to start</p>
                  <button class="tt-btn tt-btn-primary" data-act="new">▶ Start</button>
                </div>
              </div>
            </div>
          </section>
          <aside class="tt-side tt-side-right">
            <div class="tt-panel">
              <div class="tt-panel-title">NEXT</div>
              <canvas class="tt-mini" id="tt-next-1" width="120" height="80"></canvas>
              <canvas class="tt-mini" id="tt-next-2" width="100" height="60"></canvas>
              <canvas class="tt-mini" id="tt-next-3" width="100" height="60"></canvas>
            </div>
            <div class="tt-panel"><div class="tt-panel-title">LEVEL</div><div class="tt-num" id="tt-level">1</div></div>
            <div class="tt-panel"><div class="tt-panel-title">LINES</div><div class="tt-num small" id="tt-lines">0</div></div>
          </aside>
        </div>
        <div class="tt-controls">
          <span><kbd>←</kbd><kbd>→</kbd> Move</span>
          <span><kbd>↓</kbd> Soft</span>
          <span><kbd>Space</kbd> Hard</span>
          <span><kbd>↑</kbd>/<kbd>X</kbd> Rotate CW</span>
          <span><kbd>Z</kbd> Rotate CCW</span>
          <span><kbd>C</kbd> Hold</span>
          <span><kbd>P</kbd> Pause</span>
        </div>
        <div class="tt-modal-backdrop" id="tt-scores-modal" hidden>
          <div class="tt-modal">
            <h3>High Scores</h3>
            <div class="tt-scores-list" id="tt-scores-list"></div>
            <div class="tt-set-actions">
              <button class="tt-btn" data-act="reset-scores">Clear</button>
              <button class="tt-btn tt-btn-primary" data-act="close-scores">Done</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /* =======================================================================
   * REGISTER WITH WINDOW MANAGER
   * ===================================================================== */
  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id:    APP_ID,
      title: APP_TITLE,
      icon:  APP_ICON,
      width: 720, height: 760,
      minWidth: 540, minHeight: 600,
      category: "Games",
      pinned: true,
      render(body, win) {
        body.style.padding = "0";
        body.style.background = "var(--surface, #14182a)";
        const game = new TetrisGame(body, win.opts || {});
        game.mount();
        win._tetris = game;
        // expose for hasPendingChanges() detection
        win.hasPendingChanges = () => game.running && !game.gameOver && !game.paused;
      },
      onClose(win) {
        if (win._tetris) win._tetris.destroy();
      },
    });
    console.log("%c[WebOS]%c OsTetris registered",
      "color:#06b6d4;font-weight:bold", "color:inherit");
  }
  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* =======================================================================
   * EXTRA HELPERS — exposed for tests / debugging
   * ===================================================================== */

  // Render an entire field to an ASCII string (debugging)
  function fieldToASCII(field) {
    let out = "";
    for (let r = HIDDEN_ROWS; r < TOTAL_ROWS; r++) {
      out += "|";
      for (let c = 0; c < COLS; c++) {
        out += field[r][c] ? field[r][c] : ".";
      }
      out += "|\n";
    }
    out += "+" + "-".repeat(COLS) + "+\n";
    return out;
  }

  // Compute number of "holes" in a stack — used as a heuristic for AI work.
  function countHoles(field) {
    let holes = 0;
    for (let c = 0; c < COLS; c++) {
      let seen = false;
      for (let r = 0; r < TOTAL_ROWS; r++) {
        if (field[r][c]) seen = true;
        else if (seen) holes++;
      }
    }
    return holes;
  }

  // Compute aggregate height + bumpiness — heuristic features
  function heightStats(field) {
    const heights = Array(COLS).fill(0);
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < TOTAL_ROWS; r++) {
        if (field[r][c]) { heights[c] = TOTAL_ROWS - r; break; }
      }
    }
    let agg = 0, bumpy = 0;
    for (let c = 0; c < COLS; c++) {
      agg += heights[c];
      if (c < COLS - 1) bumpy += Math.abs(heights[c] - heights[c + 1]);
    }
    return { heights, aggregate: agg, bumpiness: bumpy };
  }

  /* =======================================================================
   * PUBLIC API
   * ===================================================================== */
  window.Tetris = {
    TetrisGame,
    SHAPES, COLORS, PIECE_TYPES,
    KICKS_JLSTZ, KICKS_I, kicks,
    SCORES_PATH,
    GRAVITY_MS, COLS, ROWS,
    LINE_PTS, TSPIN_PTS,

    // pure helpers
    newField, newPiece, newBag, shapeOf,
    collides, dropDistance, lockPiece, actuallyClearLines,
    tryRotate, detectTSpin, fieldToASCII, countHoles, heightStats,

    // open helper
    open() {
      if (window.WindowManager && window.WindowManager.openApp) {
        window.WindowManager.openApp(APP_ID);
      }
    },
  };

  /* -----------------------------------------------------------------------
   * Self-test (?tetris-debug in URL)
   * --------------------------------------------------------------------- */
  if (typeof location !== "undefined" && /[?&]tetris-debug\b/.test(location.search)) {
    try {
      const f = newField();
      console.log("[tetris] empty field holes:", countHoles(f));
      const p = newPiece("T");
      console.log("[tetris] T piece collides at start:", collides(f, p));
    } catch (e) {
      console.warn("[tetris] self-test failed:", e);
    }
  }

  /* =======================================================================
   * AI ASSIST  (hint generator)
   * -----------------------------------------------------------------------
   * A tiny heuristic placement-search used by the optional Auto-Pilot mode.
   * For the current piece, evaluate every (column, rotation) landing and
   * pick the one that maximises a hand-tuned score: lines cleared minus
   * holes minus aggregate height minus bumpiness.  Shipped as a public
   * helper for power users who want to play around with bot-vs-bot games.
   * ===================================================================== */
  function bestPlacement(field, piece) {
    let best = null;
    for (let rot = 0; rot < 4; rot++) {
      // skip duplicate rotations for O / I
      if (piece.type === "O" && rot > 0) break;
      if (piece.type === "I" && rot >= 2) break;
      if ((piece.type === "S" || piece.type === "Z") && rot >= 2) break;
      for (let c = -2; c < COLS + 2; c++) {
        const test = { type: piece.type, rot, r: 0, c };
        if (collides(field, test)) continue;
        // drop until grounded
        while (!collides(field, test, 1, 0)) test.r++;
        // simulate locking
        const sim = field.map(row => row.slice());
        const s = SHAPES[test.type][test.rot];
        let valid = true;
        for (let rr = 0; rr < 4; rr++) {
          for (let cc = 0; cc < 4; cc++) {
            if (!s[rr][cc]) continue;
            const fr = test.r + rr, fc = test.c + cc;
            if (fr < 0 || fr >= TOTAL_ROWS || fc < 0 || fc >= COLS) { valid = false; break; }
            sim[fr][fc] = test.type;
          }
          if (!valid) break;
        }
        if (!valid) continue;
        // lines cleared
        let lines = 0;
        for (let rr = 0; rr < TOTAL_ROWS; rr++) {
          if (sim[rr].every(x => x !== null)) lines++;
        }
        const stats = heightStats(sim);
        const holes = countHoles(sim);
        // weights
        const score =
          (lines * 760) -
          (holes * 360) -
          (stats.aggregate * 51) -
          (stats.bumpiness * 18);
        if (best == null || score > best.score) {
          best = { rot, c: test.c, r: test.r, score, lines };
        }
      }
    }
    return best;
  }

  /* =======================================================================
   * SHAPE BBOX HELPER
   * ===================================================================== */
  function shapeBoundingBox(type, rot) {
    const s = SHAPES[type][rot];
    let minR = 4, maxR = -1, minC = 4, maxC = -1;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        if (s[r][c]) {
          if (r < minR) minR = r; if (r > maxR) maxR = r;
          if (c < minC) minC = c; if (c > maxC) maxC = c;
        }
    return { minR, maxR, minC, maxC, w: maxC - minC + 1, h: maxR - minR + 1 };
  }

  /* =======================================================================
   * SCORE FORMATTER
   * ===================================================================== */
  function formatScore(n) {
    if (typeof n !== "number" || !isFinite(n)) return "0";
    return n.toLocaleString();
  }

  /* =======================================================================
   * RECORD/REPLAY
   * -----------------------------------------------------------------------
   * Lightweight replay format: { startLevel, seed, actions: [{t, kind, ...}] }
   * Designed so that future versions can reproduce a game from the action
   * log without depending on RNG (we record each piece type as it spawns).
   * ===================================================================== */
  function emptyReplay() {
    return { startLevel: 1, version: 1, actions: [], pieces: [] };
  }

  /* =======================================================================
   * EXTRA: bag-7 fairness check (used in tests)
   * ===================================================================== */
  function bag7Fairness(samples = 700) {
    const counts = { I:0, O:0, T:0, S:0, Z:0, J:0, L:0 };
    for (let i = 0; i < samples / 7; i++) {
      const bag = newBag();
      bag.forEach(t => counts[t]++);
    }
    return counts;
  }

  /* =======================================================================
   * EXTRA: line completion percentage of the field
   * ===================================================================== */
  function fillRatio(field) {
    let filled = 0, total = 0;
    for (let r = 0; r < TOTAL_ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        total++;
        if (field[r][c]) filled++;
      }
    return total ? filled / total : 0;
  }

  /* =======================================================================
   * Wire extras into public API
   * ===================================================================== */
  Object.assign(window.Tetris, {
    bestPlacement, shapeBoundingBox, formatScore,
    emptyReplay, bag7Fairness, fillRatio,
  });

})();
