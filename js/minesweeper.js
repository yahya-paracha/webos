/* ============================================================================
 * WebOS — minesweeper.js  (OsMinesweeper)
 * ----------------------------------------------------------------------------
 * Classic Minesweeper with first-click safety, flood-fill reveal, chord
 * click, custom difficulty, and per-difficulty best-time tracking.
 *
 *   • Difficulty: Beginner (9×9·10), Intermediate (16×16·40), Expert (30×16·99)
 *   • Custom difficulty with validation (2×2 .. 50×50, mines < rows×cols-9)
 *   • First click is always safe (mines placed *after* first click and the
 *     opening neighborhood is excluded from mine placement)
 *   • Flood fill on zero-cells, chord click on revealed numbers
 *   • Smiley face button (🙂 / 😮 / 😎 / 😵)
 *   • Mine counter, timer, best times saved to FileSystem at
 *     /.games/minesweeper_times.json
 *   • Two skins: classic Win95 beveled and modern flat (toggle button)
 *
 * Public API on  window.Minesweeper
 * ==========================================================================*/

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
   * Constants
   * --------------------------------------------------------------------- */
  const APP_ID    = "minesweeper";
  const APP_TITLE = "OsMinesweeper";
  const APP_ICON  = "💣";

  const TIMES_PATH = "/.games/minesweeper_times.json";
  const PREFS_KEY  = "webos.minesweeper.prefs.v1";

  const PRESETS = {
    beginner:     { rows: 9,  cols: 9,  mines: 10 },
    intermediate: { rows: 16, cols: 16, mines: 40 },
    expert:       { rows: 16, cols: 30, mines: 99 },
  };

  // 8 neighbors offsets
  const NEIGHBORS = [
    [-1, -1], [-1, 0], [-1, 1],
    [ 0, -1],          [ 0, 1],
    [ 1, -1], [ 1, 0], [ 1, 1],
  ];

  /* =======================================================================
   * GAME CONTROLLER
   * ===================================================================== */
  class MinesweeperGame {
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.prefs = this._loadPrefs();

      this.diff = "beginner";
      this.rows = PRESETS.beginner.rows;
      this.cols = PRESETS.beginner.cols;
      this.mines = PRESETS.beginner.mines;
      // dynamic state
      this.board = null;       // 2D array of cell objects
      this.firstClick = true;
      this.revealedCount = 0;
      this.flagCount = 0;
      this.gameOver = false;
      this.gameWon = false;
      this.startTs = 0;
      this.elapsed = 0;
      this.timerHandle = null;
      this.bestTimes = {};     // diff -> { time, date }
      this.lastClickedMine = null;
    }

    /* -- mount ----------------------------------------------------------- */
    async mount() {
      const html = await this._fetchTemplate();
      this.host.innerHTML = html;
      this.root  = this.host.querySelector(".ms-app");
      this.root.dataset.skin = this.prefs.skin || "classic";
      this.gridEl = this.root.querySelector("#ms-grid");
      this.smiley = this.root.querySelector("#ms-smiley");
      this.counterEl = this.root.querySelector("#ms-counter");
      this.timerEl   = this.root.querySelector("#ms-timer");

      await this._loadBestTimes();
      this._wireToolbar();
      this._wireGrid();
      this._renderBest();

      this.diff = this.prefs.diff || "beginner";
      const sel = this.root.querySelector('[data-act="diff"]');
      if (sel) sel.value = this.diff;
      this.applyDifficulty(this.diff);
    }

    destroy() {
      if (this.timerHandle) clearInterval(this.timerHandle);
    }

    async _fetchTemplate() {
      try {
        const r = await fetch("apps/minesweeper/minesweeper.html");
        if (r.ok) return await r.text();
      } catch {}
      return _inlineFallback();
    }

    _loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) return Object.assign({ skin: "classic", diff: "beginner" }, JSON.parse(raw));
      } catch {}
      return { skin: "classic", diff: "beginner" };
    }
    _savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {}
    }

    /* -- wiring ---------------------------------------------------------- */
    _wireToolbar() {
      this.root.addEventListener("click", (e) => {
        const t = e.target.closest("[data-act]");
        if (!t) return;
        const a = t.dataset.act;
        switch (a) {
          case "new":
          case "smiley":      this.newGame(); break;
          case "skin":        this._toggleSkin(); break;
          case "best":        this._openBest(); break;
          case "close-best":  this._closeBest(); break;
          case "reset-best":  this.bestTimes = {}; this._saveBestTimes(); this._renderBest(); this._renderBestModal(); break;
          case "help":        this._openHelp(); break;
          case "close-help":  this._closeHelp(); break;
          case "apply-custom": this._applyCustom(); break;
          case "cancel-custom": this._cancelCustom(); break;
        }
      });
      const diffSel = this.root.querySelector('[data-act="diff"]');
      diffSel.addEventListener("change", () => {
        const v = diffSel.value;
        if (v === "custom") {
          this._showCustom(true);
        } else {
          this._showCustom(false);
          this.applyDifficulty(v);
        }
      });
    }

    _showCustom(show) {
      const c = this.root.querySelector("#ms-custom");
      if (c) c.hidden = !show;
    }
    _applyCustom() {
      const r = parseInt(this.root.querySelector("#ms-rows").value, 10);
      const c = parseInt(this.root.querySelector("#ms-cols").value, 10);
      const m = parseInt(this.root.querySelector("#ms-mines").value, 10);
      const v = validateCustom(r, c, m);
      if (!v.ok) {
        alert(v.error);
        return;
      }
      this.diff  = "custom";
      this.rows  = r;
      this.cols  = c;
      this.mines = m;
      this._showCustom(false);
      this.newGame();
    }
    _cancelCustom() {
      this._showCustom(false);
      const sel = this.root.querySelector('[data-act="diff"]');
      sel.value = this.diff;
    }

    _toggleSkin() {
      this.prefs.skin = this.prefs.skin === "modern" ? "classic" : "modern";
      this.root.dataset.skin = this.prefs.skin;
      this._savePrefs();
    }
    _openHelp() {
      const m = this.root.querySelector("#ms-help");
      if (m) m.hidden = false;
    }
    _closeHelp() {
      const m = this.root.querySelector("#ms-help");
      if (m) m.hidden = true;
    }
    _openBest() {
      const m = this.root.querySelector("#ms-best-modal");
      if (!m) return;
      m.hidden = false;
      this._renderBestModal();
    }
    _closeBest() {
      const m = this.root.querySelector("#ms-best-modal");
      if (m) m.hidden = true;
    }

    /* -- difficulty ------------------------------------------------------ */
    applyDifficulty(name) {
      this.diff = name;
      this.prefs.diff = name;
      this._savePrefs();
      const p = PRESETS[name];
      if (p) {
        this.rows  = p.rows;
        this.cols  = p.cols;
        this.mines = p.mines;
      }
      this.newGame();
    }

    /* -- new game -------------------------------------------------------- */
    newGame() {
      if (this.timerHandle) { clearInterval(this.timerHandle); this.timerHandle = null; }
      this.firstClick = true;
      this.revealedCount = 0;
      this.flagCount = 0;
      this.gameOver = false;
      this.gameWon  = false;
      this.startTs  = 0;
      this.elapsed  = 0;
      this.lastClickedMine = null;
      this.board = makeEmptyBoard(this.rows, this.cols);
      this._buildGridDOM();
      this._setSmiley("normal");
      this._updateCounter();
      this._updateTimer();
    }

    _buildGridDOM() {
      const g = this.gridEl;
      g.innerHTML = "";
      g.style.gridTemplateColumns = `repeat(${this.cols}, var(--ms-cell))`;
      const frag = document.createDocumentFragment();
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const el = document.createElement("div");
          el.className = "ms-cell";
          el.dataset.r = r;
          el.dataset.c = c;
          el.tabIndex = -1;
          frag.appendChild(el);
          this.board[r][c].el = el;
        }
      }
      g.appendChild(frag);
    }

    _wireGrid() {
      let pressing = false;
      let lDown = false, rDown = false;
      let chordCells = [];

      this.gridEl.addEventListener("contextmenu", (e) => e.preventDefault());

      this.gridEl.addEventListener("mousedown", (e) => {
        if (this.gameOver) return;
        const cell = e.target.closest(".ms-cell");
        if (!cell) return;
        const r = +cell.dataset.r, c = +cell.dataset.c;
        if (e.button === 0) lDown = true;
        if (e.button === 2) rDown = true;
        if (lDown && rDown) {
          // start chord visual
          chordCells = this._neighborsOf(r, c).concat([{ r, c }]);
          chordCells.forEach(p => {
            const cc = this.board[p.r][p.c];
            if (!cc.revealed && !cc.flagged) cc.el.classList.add("pressed");
          });
          this._setSmiley("oh");
        } else if (e.button === 0) {
          if (!this.board[r][c].revealed && !this.board[r][c].flagged) {
            cell.classList.add("pressed");
          }
          this._setSmiley("oh");
        }
      });

      this.gridEl.addEventListener("mouseup", (e) => {
        if (this.gameOver) {
          lDown = rDown = false;
          return;
        }
        const cell = e.target.closest(".ms-cell");
        // remove all 'pressed' visuals
        chordCells.forEach(p => this.board[p.r][p.c].el.classList.remove("pressed"));
        chordCells = [];
        this.gridEl.querySelectorAll(".pressed").forEach(el => el.classList.remove("pressed"));
        this._setSmiley("normal");

        if (cell) {
          const r = +cell.dataset.r, c = +cell.dataset.c;
          if (lDown && rDown) {
            this._chordReveal(r, c);
          } else if (e.button === 0 && lDown) {
            this._reveal(r, c);
          } else if (e.button === 2 && rDown && !lDown) {
            this._toggleFlag(r, c);
          }
        }
        if (e.button === 0) lDown = false;
        if (e.button === 2) rDown = false;
      });

      // Cancel pressed visuals if the mouse leaves while held
      this.gridEl.addEventListener("mouseleave", () => {
        this.gridEl.querySelectorAll(".pressed").forEach(el => el.classList.remove("pressed"));
        chordCells = [];
        if (!this.gameOver) this._setSmiley("normal");
      });
    }

    /* -- core actions --------------------------------------------------- */
    _reveal(r, c) {
      const cell = this.board[r][c];
      if (cell.revealed || cell.flagged) return;

      if (this.firstClick) {
        placeMines(this.board, this.rows, this.cols, this.mines, r, c);
        computeNumbers(this.board, this.rows, this.cols);
        this.firstClick = false;
        this._startTimer();
      }

      if (cell.mine) {
        // BOOM
        this.lastClickedMine = [r, c];
        this._loseGame();
        return;
      }

      this._floodReveal(r, c);
      if (this._checkWin()) this._winGame();
    }

    _floodReveal(startR, startC) {
      const stack = [[startR, startC]];
      while (stack.length) {
        const [r, c] = stack.pop();
        const cell = this.board[r][c];
        if (cell.revealed || cell.flagged) continue;
        cell.revealed = true;
        this.revealedCount++;
        this._renderCell(r, c);
        if (cell.value === 0) {
          for (const [dr, dc] of NEIGHBORS) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
              const nb = this.board[nr][nc];
              if (!nb.revealed && !nb.flagged && !nb.mine) {
                stack.push([nr, nc]);
              } else if (!nb.revealed && !nb.flagged && !nb.mine === false) {
                // mine — won't reveal
              }
            }
          }
        }
      }
    }

    _toggleFlag(r, c) {
      const cell = this.board[r][c];
      if (cell.revealed) return;
      cell.flagged = !cell.flagged;
      this.flagCount += cell.flagged ? 1 : -1;
      this._renderCell(r, c);
      this._updateCounter();
    }

    _chordReveal(r, c) {
      const cell = this.board[r][c];
      if (!cell.revealed) {
        // chord on unrevealed = treat as normal click
        this._reveal(r, c);
        return;
      }
      if (cell.value === 0) return;
      const neigh = this._neighborsOf(r, c);
      const flagged = neigh.filter(p => this.board[p.r][p.c].flagged).length;
      if (flagged !== cell.value) return;
      for (const p of neigh) {
        const nb = this.board[p.r][p.c];
        if (!nb.flagged && !nb.revealed) {
          if (nb.mine) {
            this.lastClickedMine = [p.r, p.c];
            this._loseGame();
            return;
          }
          this._floodReveal(p.r, p.c);
        }
      }
      if (this._checkWin()) this._winGame();
    }

    _neighborsOf(r, c) {
      const out = [];
      for (const [dr, dc] of NEIGHBORS) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
          out.push({ r: nr, c: nc });
        }
      }
      return out;
    }

    _checkWin() {
      const total = this.rows * this.cols;
      return this.revealedCount === (total - this.mines);
    }

    /* -- end-of-game ----------------------------------------------------- */
    _winGame() {
      this.gameOver = true;
      this.gameWon  = true;
      this._stopTimer();
      this._setSmiley("cool");
      // auto-flag remaining mines
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cc = this.board[r][c];
          if (cc.mine && !cc.flagged) {
            cc.flagged = true;
            this._renderCell(r, c);
          }
        }
      }
      this.flagCount = this.mines;
      this._updateCounter();
      // best time
      const t = Math.floor(this.elapsed / 1000);
      const key = this.diff;
      if (PRESETS[key]) {
        const cur = this.bestTimes[key];
        if (!cur || t < cur.time) {
          this.bestTimes[key] = { time: t, date: new Date().toISOString() };
          this._saveBestTimes();
          this._renderBest();
        }
      }
      try {
        if (window.Notifications) {
          window.Notifications.success("OsMinesweeper",
            "You win! Time: " + this._fmt(t));
        }
      } catch {}
    }

    _loseGame() {
      this.gameOver = true;
      this.gameWon  = false;
      this._stopTimer();
      this._setSmiley("dead");
      // reveal all mines + mark wrong flags
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const cc = this.board[r][c];
          if (cc.mine && !cc.flagged) {
            cc.revealed = true;
            this._renderCell(r, c);
          } else if (!cc.mine && cc.flagged) {
            cc.wrongFlag = true;
            this._renderCell(r, c);
          }
        }
      }
      // highlight clicked mine
      if (this.lastClickedMine) {
        const [r, c] = this.lastClickedMine;
        const el = this.board[r][c].el;
        if (el) el.style.background = "#ff0000";
      }
    }

    /* -- timer ----------------------------------------------------------- */
    _startTimer() {
      this.startTs = Date.now();
      this.elapsed = 0;
      this.timerHandle = setInterval(() => {
        this.elapsed = Date.now() - this.startTs;
        this._updateTimer();
      }, 200);
    }
    _stopTimer() {
      if (this.timerHandle) { clearInterval(this.timerHandle); this.timerHandle = null; }
    }
    _updateTimer() {
      const sec = Math.min(999, Math.floor(this.elapsed / 1000));
      this.timerEl.textContent = pad3(sec);
    }
    _updateCounter() {
      const remaining = Math.max(-99, this.mines - this.flagCount);
      this.counterEl.textContent = pad3Signed(remaining);
    }

    _setSmiley(kind) {
      const map = { normal: "🙂", oh: "😮", cool: "😎", dead: "😵" };
      this.smiley.textContent = map[kind] || "🙂";
    }

    /* -- rendering ------------------------------------------------------- */
    _renderCell(r, c) {
      const cell = this.board[r][c];
      const el = cell.el;
      if (!el) return;
      el.className = "ms-cell";
      el.textContent = "";
      if (cell.flagged) {
        el.classList.add("flagged");
        return;
      }
      if (cell.wrongFlag) {
        el.classList.add("revealed", "wrong-flag");
        return;
      }
      if (!cell.revealed) return;
      el.classList.add("revealed");
      if (cell.mine) {
        el.classList.add("mine");
      } else if (cell.value > 0) {
        el.classList.add("n" + cell.value);
        el.textContent = cell.value;
      }
    }

    _fmt(sec) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + ":" + (s < 10 ? "0" : "") + s;
    }

    /* -- best times ------------------------------------------------------ */
    async _loadBestTimes() {
      try {
        if (window.FileSystem && window.FileSystem.readJSON
            && window.FileSystem.exists(TIMES_PATH)) {
          this.bestTimes = window.FileSystem.readJSON(TIMES_PATH) || {};
        } else {
          const raw = localStorage.getItem("webos.minesweeper.times");
          if (raw) this.bestTimes = JSON.parse(raw) || {};
        }
      } catch (e) {
        console.warn("[minesweeper] loadBestTimes:", e);
      }
    }
    _saveBestTimes() {
      try {
        if (window.FileSystem && window.FileSystem.writeJSON) {
          window.FileSystem.mkdirp && window.FileSystem.mkdirp("/.games");
          window.FileSystem.writeJSON(TIMES_PATH, this.bestTimes);
        }
        localStorage.setItem("webos.minesweeper.times", JSON.stringify(this.bestTimes));
      } catch (e) {
        console.warn("[minesweeper] saveBestTimes:", e);
      }
    }
    _renderBest() {
      const fmtT = (t) => (t == null) ? "—" : this._fmt(t) + "s";
      const set = (key) => {
        const el = this.root.querySelector(`[data-best="${key}"]`);
        if (el) el.textContent = (this.bestTimes[key] && this.bestTimes[key].time != null)
          ? this._fmt(this.bestTimes[key].time)
          : "—";
      };
      set("beginner"); set("intermediate"); set("expert");
    }
    _renderBestModal() {
      const body = this.root.querySelector("#ms-best-body");
      if (!body) return;
      body.innerHTML = "";
      const keys = ["beginner", "intermediate", "expert"];
      for (const k of keys) {
        const tr = document.createElement("tr");
        const t = this.bestTimes[k];
        const date = t && t.date ? t.date.slice(0, 10) : "—";
        tr.innerHTML = `
          <td>${k.charAt(0).toUpperCase() + k.slice(1)}</td>
          <td>${t ? this._fmt(t.time) : "—"}</td>
          <td>${date}</td>`;
        body.appendChild(tr);
      }
    }
  }

  /* =======================================================================
   * STATIC HELPERS
   * ===================================================================== */
  function makeEmptyBoard(rows, cols) {
    const b = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push({
          mine: false, value: 0,
          revealed: false, flagged: false, wrongFlag: false,
          el: null,
        });
      }
      b.push(row);
    }
    return b;
  }

  function placeMines(board, rows, cols, mines, safeR, safeC) {
    // Build "forbidden" set: clicked cell + 8 neighbors
    const forbidden = new Set();
    forbidden.add(safeR * cols + safeC);
    for (const [dr, dc] of NEIGHBORS) {
      const nr = safeR + dr, nc = safeC + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        forbidden.add(nr * cols + nc);
      }
    }
    const total = rows * cols;
    const available = [];
    for (let i = 0; i < total; i++) {
      if (!forbidden.has(i)) available.push(i);
    }
    // If too many mines for available cells, fall back to allowing neighbors
    let toPlace = Math.min(mines, available.length);
    let extraNeeded = mines - toPlace;
    // pick toPlace random indices from available
    shuffleInPlace(available);
    for (let i = 0; i < toPlace; i++) {
      const idx = available[i];
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      board[r][c].mine = true;
    }
    if (extraNeeded > 0) {
      // place into forbidden (excluding the clicked square itself)
      const forbList = Array.from(forbidden).filter(i => i !== safeR * cols + safeC);
      shuffleInPlace(forbList);
      for (let i = 0; i < extraNeeded && i < forbList.length; i++) {
        const idx = forbList[i];
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        board[r][c].mine = true;
      }
    }
  }

  function computeNumbers(board, rows, cols) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (board[r][c].mine) continue;
        let v = 0;
        for (const [dr, dc] of NEIGHBORS) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].mine) v++;
        }
        board[r][c].value = v;
      }
    }
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function pad3(n) {
    n = Math.max(0, Math.min(999, Math.floor(n)));
    return n.toString().padStart(3, "0");
  }
  function pad3Signed(n) {
    if (n < 0) return "-" + Math.min(99, -n).toString().padStart(2, "0");
    return n.toString().padStart(3, "0");
  }

  function validateCustom(rows, cols, mines) {
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || !Number.isFinite(mines)) {
      return { ok: false, error: "Please enter valid numbers." };
    }
    if (rows < 2 || cols < 2)   return { ok: false, error: "Rows and columns must be ≥ 2." };
    if (rows > 50 || cols > 50) return { ok: false, error: "Rows and columns must be ≤ 50." };
    if (mines < 1)              return { ok: false, error: "At least 1 mine required." };
    const max = rows * cols - 9; // leave first-click neighborhood safe
    if (mines > max) return { ok: false, error: "Too many mines (max " + max + " for " + rows + "×" + cols + ")." };
    return { ok: true };
  }

  /* -----------------------------------------------------------------------
   * Inline fallback markup
   * --------------------------------------------------------------------- */
  function _inlineFallback() {
    return `
      <div class="ms-app" data-skin="classic">
        <div class="ms-toolbar">
          <select class="ms-select" data-act="diff">
            <option value="beginner" selected>Beginner (9×9·10)</option>
            <option value="intermediate">Intermediate (16×16·40)</option>
            <option value="expert">Expert (30×16·99)</option>
            <option value="custom">Custom…</option>
          </select>
          <button class="ms-btn ms-btn-primary" data-act="new">⟳ New</button>
          <span class="ms-spacer"></span>
          <button class="ms-btn ms-btn-icon" data-act="skin">🎨</button>
          <button class="ms-btn ms-btn-icon" data-act="best">🏆</button>
          <button class="ms-btn ms-btn-icon" data-act="help">❓</button>
        </div>
        <div class="ms-custom" id="ms-custom" hidden>
          <label>Rows <input type="number" id="ms-rows" min="2" max="50" value="16"></label>
          <label>Cols <input type="number" id="ms-cols" min="2" max="50" value="16"></label>
          <label>Mines <input type="number" id="ms-mines" min="1" max="2491" value="40"></label>
          <button class="ms-btn ms-btn-primary" data-act="apply-custom">Apply</button>
          <button class="ms-btn" data-act="cancel-custom">Cancel</button>
        </div>
        <div class="ms-header">
          <div class="ms-counter" id="ms-counter">000</div>
          <button class="ms-smiley" id="ms-smiley" data-act="smiley">🙂</button>
          <div class="ms-timer" id="ms-timer">000</div>
        </div>
        <div class="ms-grid-wrap">
          <div class="ms-grid" id="ms-grid"></div>
        </div>
        <div class="ms-best">
          <div class="ms-best-row"><span>Beginner</span><b data-best="beginner">—</b></div>
          <div class="ms-best-row"><span>Intermediate</span><b data-best="intermediate">—</b></div>
          <div class="ms-best-row"><span>Expert</span><b data-best="expert">—</b></div>
        </div>
        <div class="ms-modal-backdrop" id="ms-help" hidden>
          <div class="ms-modal">
            <h3>How to play</h3>
            <ul>
              <li>Left-click to reveal a cell.</li>
              <li>Right-click to flag a mine.</li>
              <li>Numbers show adjacent mines.</li>
              <li>Chord click reveals a number's neighbors when correctly flagged.</li>
              <li>First click is always safe.</li>
            </ul>
            <div class="ms-actions"><button class="ms-btn ms-btn-primary" data-act="close-help">Got it</button></div>
          </div>
        </div>
        <div class="ms-modal-backdrop" id="ms-best-modal" hidden>
          <div class="ms-modal">
            <h3>Best times</h3>
            <table class="ms-best-table">
              <thead><tr><th>Difficulty</th><th>Time</th><th>Date</th></tr></thead>
              <tbody id="ms-best-body"></tbody>
            </table>
            <div class="ms-actions">
              <button class="ms-btn" data-act="reset-best">Reset</button>
              <button class="ms-btn ms-btn-primary" data-act="close-best">Done</button>
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
      width: 560, height: 620,
      minWidth: 380, minHeight: 480,
      category: "Games",
      pinned: true,
      render(body, win) {
        body.style.padding = "0";
        body.style.background = "var(--surface, #14182a)";
        const game = new MinesweeperGame(body, win.opts || {});
        game.mount();
        win._mines = game;
      },
      onClose(win) {
        if (win._mines) win._mines.destroy();
      },
    });
    console.log("%c[WebOS]%c OsMinesweeper registered",
      "color:#22c55e;font-weight:bold", "color:inherit");
  }
  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* =======================================================================
   * EXTRA: solver heuristic helpers (exposed for tests)
   * ===================================================================== */

  // Count flagged neighbors of (r,c)
  function flagCountAround(board, rows, cols, r, c) {
    let n = 0;
    for (const [dr, dc] of NEIGHBORS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (board[nr][nc].flagged) n++;
      }
    }
    return n;
  }

  function unrevealedAround(board, rows, cols, r, c) {
    const out = [];
    for (const [dr, dc] of NEIGHBORS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (!board[nr][nc].revealed) out.push({ r: nr, c: nc });
      }
    }
    return out;
  }

  // Trivial first-pass solver: for every revealed numbered cell, if number ===
  // (flags + unrevealed-non-flagged), all unrevealed-non-flagged are mines;
  // similarly if number === flags, all unrevealed-non-flagged are safe.
  function solverHints(board, rows, cols) {
    const safe = [];
    const mines = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if (!cell.revealed || cell.value === 0 || cell.mine) continue;
        const f = flagCountAround(board, rows, cols, r, c);
        const un = unrevealedAround(board, rows, cols, r, c).filter(p => !board[p.r][p.c].flagged);
        if (un.length === 0) continue;
        if (cell.value === f + un.length) un.forEach(p => mines.push(p));
        else if (cell.value === f)         un.forEach(p => safe.push(p));
      }
    }
    return { safe, mines };
  }

  /* =======================================================================
   * EXTRA: density helper
   * ===================================================================== */
  function density(rows, cols, mines) {
    if (rows * cols === 0) return 0;
    return mines / (rows * cols);
  }

  /* =======================================================================
   * PUBLIC API
   * ===================================================================== */
  window.Minesweeper = {
    MinesweeperGame,
    PRESETS,
    NEIGHBORS,
    TIMES_PATH,

    // pure helpers
    makeEmptyBoard, placeMines, computeNumbers,
    validateCustom, density,
    flagCountAround, unrevealedAround, solverHints,

    // open helper
    open() {
      if (window.WindowManager && window.WindowManager.openApp) {
        window.WindowManager.openApp(APP_ID);
      }
    },
  };

  /* -----------------------------------------------------------------------
   * Self-test
   * --------------------------------------------------------------------- */
  if (typeof location !== "undefined" && /[?&]ms-debug\b/.test(location.search)) {
    try {
      const b = makeEmptyBoard(9, 9);
      placeMines(b, 9, 9, 10, 0, 0);
      computeNumbers(b, 9, 9);
      console.log("[minesweeper] OK; first cell value:", b[0][0].value);
    } catch (e) {
      console.warn("[minesweeper] self-test failed:", e);
    }
  }

  /* =======================================================================
   * BOARD STATISTICS
   * -----------------------------------------------------------------------
   * Computes a small bag of metrics about a board: total cells, revealed
   * count, flagged count, percent revealed, and the distribution of cell
   * values (0..8).  Useful for tests and for displaying detailed game
   * statistics in future extensions.
   * ===================================================================== */
  function boardStats(board, rows, cols) {
    const stats = {
      total: rows * cols,
      mines: 0,
      revealed: 0,
      flagged: 0,
      remaining: 0,
      pctRevealed: 0,
      valueDist: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if (cell.mine) stats.mines++;
        if (cell.revealed) stats.revealed++;
        if (cell.flagged) stats.flagged++;
        if (!cell.mine) stats.valueDist[cell.value]++;
      }
    }
    stats.remaining = stats.total - stats.mines - stats.revealed;
    stats.pctRevealed = stats.total
      ? (stats.revealed / (stats.total - stats.mines))
      : 0;
    return stats;
  }

  /* =======================================================================
   * SERIALIZE / DESERIALIZE
   *   For save/restore. Strips DOM references.
   * ===================================================================== */
  function serializeBoard(board, rows, cols) {
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        row.push({
          mine: !!cell.mine,
          value: cell.value | 0,
          revealed: !!cell.revealed,
          flagged: !!cell.flagged,
          wrongFlag: !!cell.wrongFlag,
        });
      }
      out.push(row);
    }
    return { rows, cols, board: out };
  }

  function deserializeBoard(data) {
    const out = [];
    for (let r = 0; r < data.rows; r++) {
      const row = [];
      for (let c = 0; c < data.cols; c++) {
        const cell = data.board[r][c];
        row.push({
          mine: !!cell.mine,
          value: cell.value | 0,
          revealed: !!cell.revealed,
          flagged: !!cell.flagged,
          wrongFlag: !!cell.wrongFlag,
          el: null,
        });
      }
      out.push(row);
    }
    return out;
  }

  /* =======================================================================
   * PROBABILITY ESTIMATOR
   * -----------------------------------------------------------------------
   * Crude per-cell mine probability estimate.  For each unrevealed cell, it
   * returns the average of the local probabilities derived from each
   * adjacent revealed numbered cell. This is *not* an exact CSP solver,
   * but it's enough for a "show hints" feature.
   * ===================================================================== */
  function probabilityMap(board, rows, cols) {
    const map = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = board[r][c];
        if (cell.revealed || cell.flagged) continue;
        const adjNumbers = [];
        for (const [dr, dc] of NEIGHBORS) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const nb = board[nr][nc];
          if (nb.revealed && !nb.mine && nb.value > 0) {
            const flagN = flagCountAround(board, rows, cols, nr, nc);
            const unflagN = unrevealedAround(board, rows, cols, nr, nc)
              .filter(p => !board[p.r][p.c].flagged).length;
            if (unflagN > 0) {
              const minesLeft = Math.max(0, nb.value - flagN);
              adjNumbers.push(minesLeft / unflagN);
            }
          }
        }
        if (adjNumbers.length === 0) {
          map[r][c] = null; // no info
        } else {
          const sum = adjNumbers.reduce((a, b) => a + b, 0);
          map[r][c] = sum / adjNumbers.length;
        }
      }
    }
    return map;
  }

  /* =======================================================================
   * NEIGHBOR-COUNT HELPER (exposed)
   * ===================================================================== */
  function neighborMineCount(board, rows, cols, r, c) {
    let n = 0;
    for (const [dr, dc] of NEIGHBORS) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].mine) n++;
    }
    return n;
  }

  /* =======================================================================
   * OPENING-AREA HELPER
   *   Estimate how many cells would be auto-revealed by clicking (r,c).
   * ===================================================================== */
  function estimateOpeningArea(board, rows, cols, r, c) {
    if (board[r][c].mine) return 0;
    const seen = new Set();
    const stack = [[r, c]];
    while (stack.length) {
      const [rr, cc] = stack.pop();
      const key = rr * cols + cc;
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = board[rr][cc];
      if (cell.value === 0) {
        for (const [dr, dc] of NEIGHBORS) {
          const nr = rr + dr, nc = cc + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            const nb = board[nr][nc];
            if (!nb.mine) stack.push([nr, nc]);
          }
        }
      }
    }
    return seen.size;
  }

  /* =======================================================================
   * SCORE FOR LEADERBOARD
   *   Compose a composite score (smaller time = higher score) for displays.
   * ===================================================================== */
  function leaderboardScore(diff, timeSec) {
    const base = { beginner: 1000, intermediate: 4000, expert: 12000 }[diff] || 1000;
    if (timeSec <= 0) return base;
    return Math.max(0, base - Math.round(timeSec * (diff === "expert" ? 8 : 12)));
  }

  /* =======================================================================
   * Wire extras into public API
   * ===================================================================== */
  Object.assign(window.Minesweeper, {
    boardStats,
    serializeBoard, deserializeBoard,
    probabilityMap,
    neighborMineCount,
    estimateOpeningArea,
    leaderboardScore,
  });

})();
