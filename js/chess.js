/* ============================================================================
 * WebOS — chess.js  (OsChess)
 * ----------------------------------------------------------------------------
 * Full-feature chess engine + UI for WebOS.
 *
 * Highlights
 * ----------
 *   • Bitless 0x88-style 8x8 array board with full legal move generation
 *   • Pawn (single, double, en passant, promotion), Knight, Bishop, Rook,
 *     Queen, King with kingside + queenside castling
 *   • Check, checkmate, stalemate, draw by insufficient material, threefold
 *     repetition, and 50-move rule
 *   • Minimax + alpha-beta search with piece-square tables, depths 1-3
 *   • Click-to-move, drag-and-drop, promotion dialog, undo
 *   • Move history in algebraic notation, click-to-jump-to-position
 *   • Game timer (5/10/15/30 min), captured pieces with material balance
 *   • Stats persisted to /.games/chess_stats.json (FileSystem)
 *
 * Public API on  window.Chess
 * ==========================================================================*/

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
   * Constants
   * --------------------------------------------------------------------- */
  const APP_ID    = "chess";
  const APP_TITLE = "OsChess";
  const APP_ICON  = "♟";

  const STATS_PATH = "/.games/chess_stats.json";
  const PREFS_KEY  = "webos.chess.prefs.v1";

  // piece codes:  uppercase = white, lowercase = black
  // P N B R Q K  / p n b r q k
  const W_PAWN   = "P", W_KNIGHT = "N", W_BISHOP = "B",
        W_ROOK   = "R", W_QUEEN  = "Q", W_KING   = "K";
  const B_PAWN   = "p", B_KNIGHT = "n", B_BISHOP = "b",
        B_ROOK   = "r", B_QUEEN  = "q", B_KING   = "k";

  const PIECE_VALUES = {
    P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000,
    p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000,
  };

  // Unicode glyphs (always pair of light + dark; we color via CSS)
  const GLYPH = {
    P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
    p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
  };

  // SAN piece letters (uppercase only, by piece type)
  const SAN_LETTER = { P: "", N: "N", B: "B", R: "R", Q: "Q", K: "K" };

  const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];

  const RESULT = {
    ONGOING:   "ongoing",
    CHECKMATE: "checkmate",
    STALEMATE: "stalemate",
    DRAW_50:   "draw_50",
    DRAW_3FR:  "draw_3fr",
    DRAW_INSUF:"draw_insufficient",
    RESIGN:    "resign",
    TIMEOUT:   "timeout",
    DRAW_AGREE:"draw_agreement",
  };

  /* -----------------------------------------------------------------------
   * Utility helpers
   * --------------------------------------------------------------------- */
  function isWhite(p) { return !!p && p === p.toUpperCase() && p !== "."; }
  function isBlack(p) { return !!p && p === p.toLowerCase() && p !== "."; }
  function pieceSide(p) { return isWhite(p) ? "w" : isBlack(p) ? "b" : null; }
  function pieceType(p) { return p ? p.toUpperCase() : null; }
  function opposite(side) { return side === "w" ? "b" : "w"; }

  function fileToCol(f)   { return f.charCodeAt(0) - 97; }     // 'a'->0
  function rankToRow(r)   { return 8 - parseInt(r, 10); }      // '1'->7
  function rcToAlg(r, c)  { return FILES[c] + RANKS[7 - r]; }
  function algToRC(s)     { return [rankToRow(s[1]), fileToCol(s[0])]; }
  function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }

  function deepClone(o) {
    if (Array.isArray(o)) return o.map(deepClone);
    if (o && typeof o === "object") {
      const out = {};
      for (const k in o) out[k] = deepClone(o[k]);
      return out;
    }
    return o;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* -----------------------------------------------------------------------
   * Piece-square tables (white perspective; mirrored for black at runtime)
   * --------------------------------------------------------------------- */
  const PST = {
    P: [
      [  0,   0,   0,   0,   0,   0,   0,   0],
      [ 50,  50,  50,  50,  50,  50,  50,  50],
      [ 10,  10,  20,  30,  30,  20,  10,  10],
      [  5,   5,  10,  25,  25,  10,   5,   5],
      [  0,   0,   0,  20,  20,   0,   0,   0],
      [  5,  -5, -10,   0,   0, -10,  -5,   5],
      [  5,  10,  10, -20, -20,  10,  10,   5],
      [  0,   0,   0,   0,   0,   0,   0,   0],
    ],
    N: [
      [-50, -40, -30, -30, -30, -30, -40, -50],
      [-40, -20,   0,   0,   0,   0, -20, -40],
      [-30,   0,  10,  15,  15,  10,   0, -30],
      [-30,   5,  15,  20,  20,  15,   5, -30],
      [-30,   0,  15,  20,  20,  15,   0, -30],
      [-30,   5,  10,  15,  15,  10,   5, -30],
      [-40, -20,   0,   5,   5,   0, -20, -40],
      [-50, -40, -30, -30, -30, -30, -40, -50],
    ],
    B: [
      [-20, -10, -10, -10, -10, -10, -10, -20],
      [-10,   0,   0,   0,   0,   0,   0, -10],
      [-10,   0,   5,  10,  10,   5,   0, -10],
      [-10,   5,   5,  10,  10,   5,   5, -10],
      [-10,   0,  10,  10,  10,  10,   0, -10],
      [-10,  10,  10,  10,  10,  10,  10, -10],
      [-10,   5,   0,   0,   0,   0,   5, -10],
      [-20, -10, -10, -10, -10, -10, -10, -20],
    ],
    R: [
      [  0,   0,   0,   0,   0,   0,   0,   0],
      [  5,  10,  10,  10,  10,  10,  10,   5],
      [ -5,   0,   0,   0,   0,   0,   0,  -5],
      [ -5,   0,   0,   0,   0,   0,   0,  -5],
      [ -5,   0,   0,   0,   0,   0,   0,  -5],
      [ -5,   0,   0,   0,   0,   0,   0,  -5],
      [ -5,   0,   0,   0,   0,   0,   0,  -5],
      [  0,   0,   0,   5,   5,   0,   0,   0],
    ],
    Q: [
      [-20, -10, -10,  -5,  -5, -10, -10, -20],
      [-10,   0,   0,   0,   0,   0,   0, -10],
      [-10,   0,   5,   5,   5,   5,   0, -10],
      [ -5,   0,   5,   5,   5,   5,   0,  -5],
      [  0,   0,   5,   5,   5,   5,   0,  -5],
      [-10,   5,   5,   5,   5,   5,   0, -10],
      [-10,   0,   5,   0,   0,   0,   0, -10],
      [-20, -10, -10,  -5,  -5, -10, -10, -20],
    ],
    K: [
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-30, -40, -40, -50, -50, -40, -40, -30],
      [-20, -30, -30, -40, -40, -30, -30, -20],
      [-10, -20, -20, -20, -20, -20, -20, -10],
      [ 20,  20,   0,   0,   0,   0,  20,  20],
      [ 20,  30,  10,   0,   0,  10,  30,  20],
    ],
    K_END: [
      [-50, -40, -30, -20, -20, -30, -40, -50],
      [-30, -20, -10,   0,   0, -10, -20, -30],
      [-30, -10,  20,  30,  30,  20, -10, -30],
      [-30, -10,  30,  40,  40,  30, -10, -30],
      [-30, -10,  30,  40,  40,  30, -10, -30],
      [-30, -10,  20,  30,  30,  20, -10, -30],
      [-30, -30,   0,   0,   0,   0, -30, -30],
      [-50, -30, -30, -30, -30, -30, -30, -50],
    ],
  };

  /* =======================================================================
   * BOARD STATE
   *
   *   board    — 8x8 array of piece codes (uppercase white, lowercase black,
   *              "." for empty)
   *   turn     — "w" | "b"
   *   castling — { K:bool, Q:bool, k:bool, q:bool }
   *   ep       — "e3" or null   (square pawn can capture into)
   *   halfmove — for 50-move rule
   *   fullmove — increments after black's move
   *   history  — array of { move, captured, castling, ep, halfmove, fen }
   *   posCount — fenKey -> count, for threefold repetition
   * ===================================================================== */
  function newBoard() {
    return [
      ["r","n","b","q","k","b","n","r"],
      ["p","p","p","p","p","p","p","p"],
      [".",".",".",".",".",".",".","."],
      [".",".",".",".",".",".",".","."],
      [".",".",".",".",".",".",".","."],
      [".",".",".",".",".",".",".","."],
      ["P","P","P","P","P","P","P","P"],
      ["R","N","B","Q","K","B","N","R"],
    ];
  }

  function newState() {
    return {
      board:    newBoard(),
      turn:     "w",
      castling: { K: true, Q: true, k: true, q: true },
      ep:       null,
      halfmove: 0,
      fullmove: 1,
      history:  [],
      posCount: Object.create(null),
      result:   RESULT.ONGOING,
      winner:   null,
    };
  }

  /* -----------------------------------------------------------------------
   * Cloning state for search
   * --------------------------------------------------------------------- */
  function cloneStateLite(s) {
    return {
      board: s.board.map(row => row.slice()),
      turn: s.turn,
      castling: { K: s.castling.K, Q: s.castling.Q, k: s.castling.k, q: s.castling.q },
      ep: s.ep,
      halfmove: s.halfmove,
      fullmove: s.fullmove,
    };
  }

  /* -----------------------------------------------------------------------
   * FEN-like position key (no halfmove/fullmove counters)
   * --------------------------------------------------------------------- */
  function posKey(s) {
    let out = "";
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        if (p === ".") { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += p;
      }
      if (empty) out += empty;
      if (r < 7) out += "/";
    }
    out += " " + s.turn;
    out += " " + (
      (s.castling.K ? "K" : "") +
      (s.castling.Q ? "Q" : "") +
      (s.castling.k ? "k" : "") +
      (s.castling.q ? "q" : "")
    || "-");
    out += " " + (s.ep || "-");
    return out;
  }

  function toFEN(s) {
    return posKey(s) + " " + s.halfmove + " " + s.fullmove;
  }

  /* -----------------------------------------------------------------------
   * fromFEN — used by undo/jump features (parses a FEN we wrote earlier).
   * --------------------------------------------------------------------- */
  function fromFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split("/");
    const board = [];
    for (const row of rows) {
      const r = [];
      for (const ch of row) {
        if (/\d/.test(ch)) {
          for (let i = 0; i < parseInt(ch, 10); i++) r.push(".");
        } else r.push(ch);
      }
      board.push(r);
    }
    const cstr = parts[2] || "-";
    return {
      board,
      turn: parts[1] || "w",
      castling: {
        K: cstr.includes("K"),
        Q: cstr.includes("Q"),
        k: cstr.includes("k"),
        q: cstr.includes("q"),
      },
      ep:       (parts[3] && parts[3] !== "-") ? parts[3] : null,
      halfmove: parseInt(parts[4] || "0", 10),
      fullmove: parseInt(parts[5] || "1", 10),
    };
  }

  /* =======================================================================
   * MOVE GENERATION
   * ===================================================================== */

  // Knight offsets
  const KN_OFFSETS = [
    [-2, -1], [-2,  1], [-1, -2], [-1,  2],
    [ 1, -2], [ 1,  2], [ 2, -1], [ 2,  1],
  ];
  // King + queen step offsets
  const RAY_DIAG  = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const RAY_ORTHO = [[-1,0],[1,0],[0,-1],[0,1]];
  const RAY_ALL   = RAY_DIAG.concat(RAY_ORTHO);

  /* generatePseudoMoves(state)
   * Returns all moves *without* filtering ones that leave the king in check.
   * Move object:
   *   { from:[r,c], to:[r,c], piece, captured?, promo?, special?, fromAlg, toAlg }
   *   special: "ep" | "castleK" | "castleQ" | "doublePush"
   */
  function generatePseudoMoves(s, side) {
    side = side || s.turn;
    const moves = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        if (p === ".") continue;
        if (pieceSide(p) !== side) continue;
        switch (pieceType(p)) {
          case "P": genPawn(s, r, c, p, moves); break;
          case "N": genKnight(s, r, c, p, moves); break;
          case "B": genSlider(s, r, c, p, RAY_DIAG, moves); break;
          case "R": genSlider(s, r, c, p, RAY_ORTHO, moves); break;
          case "Q": genSlider(s, r, c, p, RAY_ALL, moves); break;
          case "K": genKing(s, r, c, p, moves); break;
        }
      }
    }
    return moves;
  }

  function genPawn(s, r, c, p, moves) {
    const isW = isWhite(p);
    const dir = isW ? -1 : 1;
    const startRow = isW ? 6 : 1;
    const promoRow = isW ? 0 : 7;

    // single push
    const r1 = r + dir;
    if (inBounds(r1, c) && s.board[r1][c] === ".") {
      if (r1 === promoRow) {
        for (const promo of "qrbn") pushMv(moves, r, c, r1, c, p, null, isW ? promo.toUpperCase() : promo);
      } else {
        pushMv(moves, r, c, r1, c, p);
        // double push
        if (r === startRow) {
          const r2 = r + 2 * dir;
          if (s.board[r2][c] === ".") {
            const m = pushMv(moves, r, c, r2, c, p);
            m.special = "doublePush";
          }
        }
      }
    }
    // captures
    for (const dc of [-1, 1]) {
      const nc = c + dc;
      const nr = r + dir;
      if (!inBounds(nr, nc)) continue;
      const target = s.board[nr][nc];
      if (target !== "." && pieceSide(target) !== pieceSide(p)) {
        if (nr === promoRow) {
          for (const promo of "qrbn") pushMv(moves, r, c, nr, nc, p, target, isW ? promo.toUpperCase() : promo);
        } else {
          pushMv(moves, r, c, nr, nc, p, target);
        }
      }
      // en passant
      if (s.ep) {
        const [er, ec] = algToRC(s.ep);
        if (er === nr && ec === nc && target === ".") {
          const cap = s.board[r][nc]; // pawn beside
          const m = pushMv(moves, r, c, nr, nc, p, cap);
          m.special = "ep";
        }
      }
    }
  }

  function genKnight(s, r, c, p, moves) {
    for (const [dr, dc] of KN_OFFSETS) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = s.board[nr][nc];
      if (t === ".") pushMv(moves, r, c, nr, nc, p);
      else if (pieceSide(t) !== pieceSide(p)) pushMv(moves, r, c, nr, nc, p, t);
    }
  }

  function genSlider(s, r, c, p, dirs, moves) {
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const t = s.board[nr][nc];
        if (t === ".") {
          pushMv(moves, r, c, nr, nc, p);
        } else {
          if (pieceSide(t) !== pieceSide(p)) pushMv(moves, r, c, nr, nc, p, t);
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }

  function genKing(s, r, c, p, moves) {
    for (const [dr, dc] of RAY_ALL) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = s.board[nr][nc];
      if (t === ".") pushMv(moves, r, c, nr, nc, p);
      else if (pieceSide(t) !== pieceSide(p)) pushMv(moves, r, c, nr, nc, p, t);
    }
    // castling — only if king on its home square and not in check; legality
    // is verified later in filterLegal.
    const isW = isWhite(p);
    const homeRow = isW ? 7 : 0;
    if (r === homeRow && c === 4) {
      if ((isW ? s.castling.K : s.castling.k)
          && s.board[homeRow][5] === "."
          && s.board[homeRow][6] === "."
          && (isW ? s.board[homeRow][7] === "R" : s.board[homeRow][7] === "r")) {
        const m = pushMv(moves, r, c, homeRow, 6, p);
        m.special = "castleK";
      }
      if ((isW ? s.castling.Q : s.castling.q)
          && s.board[homeRow][3] === "."
          && s.board[homeRow][2] === "."
          && s.board[homeRow][1] === "."
          && (isW ? s.board[homeRow][0] === "R" : s.board[homeRow][0] === "r")) {
        const m = pushMv(moves, r, c, homeRow, 2, p);
        m.special = "castleQ";
      }
    }
  }

  function pushMv(moves, fr, fc, tr, tc, piece, captured, promo) {
    const m = {
      from: [fr, fc],
      to:   [tr, tc],
      piece,
      captured: captured || null,
      promo:    promo    || null,
      special:  null,
      fromAlg:  rcToAlg(fr, fc),
      toAlg:    rcToAlg(tr, tc),
    };
    moves.push(m);
    return m;
  }

  /* -----------------------------------------------------------------------
   * isSquareAttacked — returns true if (r,c) is attacked by `bySide`.
   * --------------------------------------------------------------------- */
  function isSquareAttacked(s, r, c, bySide) {
    // pawn attacks
    if (bySide === "w") {
      if (inBounds(r + 1, c - 1) && s.board[r + 1][c - 1] === "P") return true;
      if (inBounds(r + 1, c + 1) && s.board[r + 1][c + 1] === "P") return true;
    } else {
      if (inBounds(r - 1, c - 1) && s.board[r - 1][c - 1] === "p") return true;
      if (inBounds(r - 1, c + 1) && s.board[r - 1][c + 1] === "p") return true;
    }
    // knight
    for (const [dr, dc] of KN_OFFSETS) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = s.board[nr][nc];
      if (t === (bySide === "w" ? "N" : "n")) return true;
    }
    // king
    for (const [dr, dc] of RAY_ALL) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const t = s.board[nr][nc];
      if (t === (bySide === "w" ? "K" : "k")) return true;
    }
    // sliders: bishop/queen on diagonals
    for (const [dr, dc] of RAY_DIAG) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const t = s.board[nr][nc];
        if (t !== ".") {
          if (pieceSide(t) === bySide) {
            const tt = pieceType(t);
            if (tt === "B" || tt === "Q") return true;
          }
          break;
        }
        nr += dr; nc += dc;
      }
    }
    // rook/queen on orthogonals
    for (const [dr, dc] of RAY_ORTHO) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const t = s.board[nr][nc];
        if (t !== ".") {
          if (pieceSide(t) === bySide) {
            const tt = pieceType(t);
            if (tt === "R" || tt === "Q") return true;
          }
          break;
        }
        nr += dr; nc += dc;
      }
    }
    return false;
  }

  function findKing(s, side) {
    const k = side === "w" ? "K" : "k";
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (s.board[r][c] === k) return [r, c];
    return null;
  }

  function inCheck(s, side) {
    side = side || s.turn;
    const k = findKing(s, side);
    if (!k) return false;
    return isSquareAttacked(s, k[0], k[1], opposite(side));
  }

  /* -----------------------------------------------------------------------
   * makeMove / unmakeMove (mutating, used by search).
   * Returns an "undo info" object we keep on s.history.
   * --------------------------------------------------------------------- */
  function makeMove(s, m) {
    const undo = {
      move: m,
      captured: null,
      castling: { K: s.castling.K, Q: s.castling.Q, k: s.castling.k, q: s.castling.q },
      ep: s.ep,
      halfmove: s.halfmove,
      fullmove: s.fullmove,
    };
    const [fr, fc] = m.from;
    const [tr, tc] = m.to;
    const piece = s.board[fr][fc];
    const isW = isWhite(piece);
    let target = s.board[tr][tc];

    // halfmove clock
    if (pieceType(piece) === "P" || target !== ".") s.halfmove = 0;
    else s.halfmove++;

    // en passant capture
    if (m.special === "ep") {
      const capR = fr;
      target = s.board[capR][tc];
      s.board[capR][tc] = ".";
    }

    undo.captured = target === "." ? null : target;

    // move piece
    s.board[tr][tc] = piece;
    s.board[fr][fc] = ".";

    // promotion
    if (m.promo) s.board[tr][tc] = m.promo;

    // castling — move rook
    if (m.special === "castleK") {
      const row = isW ? 7 : 0;
      s.board[row][5] = isW ? "R" : "r";
      s.board[row][7] = ".";
    } else if (m.special === "castleQ") {
      const row = isW ? 7 : 0;
      s.board[row][3] = isW ? "R" : "r";
      s.board[row][0] = ".";
    }

    // update castling rights
    if (pieceType(piece) === "K") {
      if (isW) { s.castling.K = false; s.castling.Q = false; }
      else     { s.castling.k = false; s.castling.q = false; }
    } else if (pieceType(piece) === "R") {
      if (isW && fr === 7 && fc === 0) s.castling.Q = false;
      if (isW && fr === 7 && fc === 7) s.castling.K = false;
      if (!isW && fr === 0 && fc === 0) s.castling.q = false;
      if (!isW && fr === 0 && fc === 7) s.castling.k = false;
    }
    if (target) {
      // captured rook revokes opponent castling
      if (isW) {
        if (tr === 0 && tc === 0) s.castling.q = false;
        if (tr === 0 && tc === 7) s.castling.k = false;
      } else {
        if (tr === 7 && tc === 0) s.castling.Q = false;
        if (tr === 7 && tc === 7) s.castling.K = false;
      }
    }

    // en passant target
    if (m.special === "doublePush") {
      const epRow = (fr + tr) >> 1;
      s.ep = rcToAlg(epRow, fc);
    } else {
      s.ep = null;
    }

    // turn
    if (s.turn === "b") s.fullmove++;
    s.turn = opposite(s.turn);

    return undo;
  }

  function unmakeMove(s, undo) {
    const m = undo.move;
    const [fr, fc] = m.from;
    const [tr, tc] = m.to;
    const piece = s.board[tr][tc];
    const isW = m.promo ? (m.promo === m.promo.toUpperCase()) : isWhite(piece);

    // restore piece (undo promotion)
    s.board[fr][fc] = m.promo ? (isW ? "P" : "p") : piece;

    if (m.special === "ep") {
      s.board[tr][tc] = ".";
      const capR = fr;
      s.board[capR][tc] = isW ? "p" : "P";
    } else {
      s.board[tr][tc] = undo.captured || ".";
    }

    if (m.special === "castleK") {
      const row = isW ? 7 : 0;
      s.board[row][7] = isW ? "R" : "r";
      s.board[row][5] = ".";
    } else if (m.special === "castleQ") {
      const row = isW ? 7 : 0;
      s.board[row][0] = isW ? "R" : "r";
      s.board[row][3] = ".";
    }

    s.castling = undo.castling;
    s.ep       = undo.ep;
    s.halfmove = undo.halfmove;
    s.fullmove = undo.fullmove;
    s.turn     = opposite(s.turn);
  }

  /* -----------------------------------------------------------------------
   * generateLegalMoves(state): filters pseudo-legal moves to those leaving
   * own king out of check, and validates castling path.
   * --------------------------------------------------------------------- */
  function generateLegalMoves(s, side) {
    side = side || s.turn;
    const out = [];
    const pseudo = generatePseudoMoves(s, side);
    for (const m of pseudo) {
      // castling extra checks: king cannot pass through attacked squares
      if (m.special === "castleK" || m.special === "castleQ") {
        const row = side === "w" ? 7 : 0;
        if (inCheck(s, side)) continue;
        const through = m.special === "castleK" ? [5, 6] : [3, 2];
        let ok = true;
        for (const cc of through) {
          if (isSquareAttacked(s, row, cc, opposite(side))) { ok = false; break; }
        }
        if (!ok) continue;
      }
      const undo = makeMove(s, m);
      if (!inCheck(s, side)) out.push(m);
      unmakeMove(s, undo);
    }
    return out;
  }

  /* -----------------------------------------------------------------------
   * Position evaluation
   * --------------------------------------------------------------------- */
  function isEndgame(s) {
    let majors = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const t = pieceType(s.board[r][c]);
        if (t === "Q") majors += 4;
        else if (t === "R") majors += 2;
        else if (t === "B" || t === "N") majors += 1;
      }
    return majors <= 6;
  }

  function evaluate(s) {
    let score = 0;
    const endgame = isEndgame(s);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        if (p === ".") continue;
        const t = pieceType(p);
        const v = PIECE_VALUES[t];
        const isW = isWhite(p);
        let pst = 0;
        const tbl = (t === "K" && endgame) ? PST.K_END : PST[t];
        if (tbl) pst = isW ? tbl[r][c] : tbl[7 - r][c];
        score += isW ? (v + pst) : -(v + pst);
      }
    }
    // tiny bonus for mobility; keep it cheap
    return score;
  }

  /* -----------------------------------------------------------------------
   * Insufficient material / 50-move / 3-fold detection
   * --------------------------------------------------------------------- */
  function insufficientMaterial(s) {
    const list = [];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const t = s.board[r][c];
        if (t === "." || pieceType(t) === "K") continue;
        list.push({ p: t, r, c });
      }
    if (list.length === 0) return true; // K vs K
    if (list.length === 1) {
      const t = pieceType(list[0].p);
      if (t === "B" || t === "N") return true; // K + minor
    }
    if (list.length === 2) {
      const a = pieceType(list[0].p), b = pieceType(list[1].p);
      if (a === "B" && b === "B") {
        // Both bishops on same color → draw
        const sqA = (list[0].r + list[0].c) % 2;
        const sqB = (list[1].r + list[1].c) % 2;
        if (sqA === sqB) return true;
      }
    }
    return false;
  }

  function detectGameResult(s) {
    const legal = generateLegalMoves(s);
    if (legal.length === 0) {
      if (inCheck(s)) return { result: RESULT.CHECKMATE, winner: opposite(s.turn) };
      return { result: RESULT.STALEMATE, winner: null };
    }
    if (s.halfmove >= 100) return { result: RESULT.DRAW_50, winner: null };
    if (insufficientMaterial(s)) return { result: RESULT.DRAW_INSUF, winner: null };

    const k = posKey(s);
    if ((s.posCount[k] || 0) >= 3) return { result: RESULT.DRAW_3FR, winner: null };

    return { result: RESULT.ONGOING, winner: null };
  }

  /* =======================================================================
   * SEARCH — minimax with alpha-beta and basic move ordering
   * ===================================================================== */

  // Order moves: captures first (MVV/LVA-ish), then quiet
  function orderMoves(moves) {
    return moves.slice().sort((a, b) => {
      const av = a.captured ? PIECE_VALUES[pieceType(a.captured)] - PIECE_VALUES[pieceType(a.piece)] / 10 : -1;
      const bv = b.captured ? PIECE_VALUES[pieceType(b.captured)] - PIECE_VALUES[pieceType(b.piece)] / 10 : -1;
      return bv - av;
    });
  }

  function search(state, depth) {
    const root = { board: state.board.map(r => r.slice()), turn: state.turn,
                   castling: Object.assign({}, state.castling),
                   ep: state.ep, halfmove: state.halfmove, fullmove: state.fullmove };
    const moves = orderMoves(generateLegalMoves(root));
    if (moves.length === 0) return { move: null, score: 0 };

    let bestMove = moves[0];
    let bestScore = root.turn === "w" ? -Infinity : Infinity;
    let alpha = -Infinity, beta = Infinity;

    for (const m of moves) {
      const undo = makeMove(root, m);
      const score = alphabeta(root, depth - 1, alpha, beta);
      unmakeMove(root, undo);
      if (root.turn === "w") {
        if (score > bestScore) { bestScore = score; bestMove = m; }
        if (score > alpha) alpha = score;
      } else {
        if (score < bestScore) { bestScore = score; bestMove = m; }
        if (score < beta) beta = score;
      }
    }
    return { move: bestMove, score: bestScore };
  }

  function alphabeta(s, depth, alpha, beta) {
    if (depth === 0) return evaluate(s);
    const moves = orderMoves(generateLegalMoves(s));
    if (moves.length === 0) {
      if (inCheck(s)) {
        // mate: prefer faster mates
        return s.turn === "w" ? -100000 - depth : 100000 + depth;
      }
      return 0; // stalemate
    }
    if (s.turn === "w") {
      let value = -Infinity;
      for (const m of moves) {
        const undo = makeMove(s, m);
        const v = alphabeta(s, depth - 1, alpha, beta);
        unmakeMove(s, undo);
        if (v > value) value = v;
        if (value > alpha) alpha = value;
        if (alpha >= beta) break;
      }
      return value;
    } else {
      let value = Infinity;
      for (const m of moves) {
        const undo = makeMove(s, m);
        const v = alphabeta(s, depth - 1, alpha, beta);
        unmakeMove(s, undo);
        if (v < value) value = v;
        if (value < beta) beta = value;
        if (alpha >= beta) break;
      }
      return value;
    }
  }

  /* =======================================================================
   * SAN — Standard Algebraic Notation generation
   * ===================================================================== */
  function moveToSAN(s, m, allLegal) {
    if (m.special === "castleK") return "O-O" + checkSuffix(s, m);
    if (m.special === "castleQ") return "O-O-O" + checkSuffix(s, m);
    const t = pieceType(m.piece);
    const letter = SAN_LETTER[t];
    const isCap = !!m.captured;
    const dest = m.toAlg;

    let disambig = "";
    if (t !== "P" && t !== "K") {
      // find other moves of same piece type that go to same square
      const ambig = (allLegal || generateLegalMoves(s)).filter(
        x => x !== m
          && pieceType(x.piece) === t
          && pieceSide(x.piece) === pieceSide(m.piece)
          && x.toAlg === dest
      );
      if (ambig.length) {
        const sameFile = ambig.some(x => x.from[1] === m.from[1]);
        const sameRank = ambig.some(x => x.from[0] === m.from[0]);
        if (!sameFile) disambig = m.fromAlg[0];
        else if (!sameRank) disambig = m.fromAlg[1];
        else disambig = m.fromAlg;
      }
    }

    let san = "";
    if (t === "P") {
      if (isCap) san = m.fromAlg[0] + "x" + dest;
      else san = dest;
      if (m.promo) san += "=" + m.promo.toUpperCase();
    } else {
      san = letter + disambig + (isCap ? "x" : "") + dest;
    }
    san += checkSuffix(s, m);
    return san;
  }

  function checkSuffix(s, m) {
    const after = cloneStateLite(s);
    // make a temp clone so we don't disturb s
    const undoList = [];
    const tmp = { ...after, history: [], posCount: {} };
    tmp.board = after.board.map(r => r.slice());
    const u = makeMove(tmp, m);
    const opp = tmp.turn;
    const legal = generateLegalMoves(tmp, opp);
    if (legal.length === 0 && inCheck(tmp, opp)) return "#";
    if (inCheck(tmp, opp)) return "+";
    return "";
  }

  /* =======================================================================
   * GAME CONTROLLER  (the public class behind the rendered window)
   * ===================================================================== */
  class ChessGame {
    constructor(host, opts) {
      this.host = host;            // window body element
      this.opts = opts || {};
      this.state = newState();
      this.flipped = false;
      this.selected = null;        // [r, c]
      this.legalCache = null;      // legal moves for selected piece
      this.aiThinking = false;
      this.gameOver  = false;
      this.history   = [];         // { san, fen, undoInfo }
      this.cursor    = 0;          // current ply we are showing (history.length = "live")
      this.captured  = { byWhite: [], byBlack: [] };
      this.prefs = this._loadPrefs();
      this.stats = { easy: blank(), medium: blank(), hard: blank(), hvh: blank() };
      this.mode  = "hva";          // hva | hvh | ava
      this.diff  = "medium";
      this.playerSide = "w";       // which side the human plays in hva
      this.clockMin = 0;           // 0 = no clock
      this.clockW = 0;
      this.clockB = 0;
      this.clockTimer = null;
      this.lastMove = null;        // last move object
      this.dragging = null;
      this.aiTimer  = null;

      function blank() { return { wins: 0, losses: 0, draws: 0, streak: 0 }; }
    }

    /* -- mount -------------------------------------------------------------- */
    async mount() {
      const html = await this._fetchTemplate();
      this.host.innerHTML = html;
      this.root = this.host.querySelector(".chess-app");
      this.root.dataset.theme = this.prefs.theme || "classic";
      this.root.dataset.pieces = this.prefs.pieces || "unicode";
      this.root.dataset.anim = this.prefs.anim ? "on" : "off";
      this.root.dataset.coords = this.prefs.coords ? "on" : "off";
      this.boardEl = this.root.querySelector("#chess-board");
      this.histEl  = this.root.querySelector("#chess-history");
      await this._loadStats();
      this._buildBoardSquares();
      this._buildCoords();
      this._wireToolbar();
      this._wireBoard();
      this._wireModals();
      this._wireKeyboard();
      this.newGame();
      this._renderStats();
    }

    destroy() {
      this._stopClock();
      if (this.aiTimer) clearTimeout(this.aiTimer);
      window.removeEventListener("keydown", this._keyHandler);
    }

    async _fetchTemplate() {
      try {
        const r = await fetch("apps/chess/chess.html");
        if (r.ok) return await r.text();
      } catch (e) { /* fall through */ }
      // Fallback: inline minimal markup if fetch failed (e.g., file://)
      return _inlineFallback();
    }

    /* -- preferences --------------------------------------------------- */
    _loadPrefs() {
      try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) return Object.assign(_defPrefs(), JSON.parse(raw));
      } catch {}
      return _defPrefs();
    }
    _savePrefs() {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {}
    }

    /* -- stats persistence ---------------------------------------------- */
    async _loadStats() {
      try {
        if (window.FileSystem && window.FileSystem.readJSON
            && window.FileSystem.exists(STATS_PATH)) {
          const j = window.FileSystem.readJSON(STATS_PATH);
          if (j && typeof j === "object") Object.assign(this.stats, j);
        } else {
          const raw = localStorage.getItem("webos.chess.stats");
          if (raw) Object.assign(this.stats, JSON.parse(raw));
        }
      } catch (e) {
        console.warn("[chess] loadStats", e);
      }
    }
    async _saveStats() {
      try {
        if (window.FileSystem && window.FileSystem.writeJSON) {
          window.FileSystem.mkdirp && window.FileSystem.mkdirp("/.games");
          window.FileSystem.writeJSON(STATS_PATH, this.stats);
        }
        localStorage.setItem("webos.chess.stats", JSON.stringify(this.stats));
      } catch (e) {
        console.warn("[chess] saveStats", e);
      }
    }

    /* -- build board squares -------------------------------------------- */
    _buildBoardSquares() {
      const b = this.boardEl;
      b.innerHTML = "";
      this.squares = {};
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const el = document.createElement("div");
          const isLight = ((r + c) % 2) === 0;
          el.className = "ch-square " + (isLight ? "light" : "dark");
          el.dataset.r = r;
          el.dataset.c = c;
          el.dataset.alg = rcToAlg(r, c);
          b.appendChild(el);
          this.squares[r + "," + c] = el;
        }
      }
      // overlay layer for animations (absolute)
      this.animLayer = document.createElement("div");
      this.animLayer.className = "ch-anim-layer";
      b.appendChild(this.animLayer);
    }

    _buildCoords() {
      const filesT = this.root.querySelector('[data-coords="files"]');
      const filesB = this.root.querySelector('[data-coords="files-b"]');
      const ranksL = this.root.querySelector('[data-coords="ranks"]');
      const ranksR = this.root.querySelector('[data-coords="ranks-r"]');
      const fOrder = this.flipped ? FILES.slice().reverse() : FILES;
      const rOrder = this.flipped ? RANKS.slice() : RANKS.slice().reverse();
      const fill = (host, arr) => {
        host.innerHTML = arr.map(x => `<span>${x}</span>`).join("");
      };
      fill(filesT, fOrder);
      fill(filesB, fOrder);
      fill(ranksL, rOrder);
      fill(ranksR, rOrder);
    }

    /* -- toolbar wiring -------------------------------------------------- */
    _wireToolbar() {
      this.root.addEventListener("click", (e) => {
        const t = e.target.closest("[data-act]");
        if (!t) return;
        const act = t.dataset.act;
        switch (act) {
          case "new":         this.newGame(); break;
          case "undo":        this.undo(); break;
          case "flip":        this.flip(); break;
          case "hint":        this.hint(); break;
          case "settings":    this._openSettings(); break;
          case "close-settings": this._closeSettings(); break;
          case "reset-stats": this.resetStats(); break;
          case "dismiss":     this._closeGameOver(); break;
          case "copy-pgn":    this.copyPGN(); break;
          case "hist-start":  this.jumpTo(0); break;
          case "hist-prev":   this.jumpTo(Math.max(0, this.cursor - 1)); break;
          case "hist-next":   this.jumpTo(Math.min(this.history.length, this.cursor + 1)); break;
          case "hist-end":    this.jumpTo(this.history.length); break;
        }
      });
      // mode/difficulty/side selects
      this.root.querySelector('[data-act="mode"]').addEventListener("change", (e) => {
        this.mode = e.target.value;
        this.newGame();
      });
      this.root.querySelector('[data-act="diff"]').addEventListener("change", (e) => {
        this.diff = e.target.value;
      });
      this.root.querySelector('[data-act="side"]').addEventListener("change", (e) => {
        this.playerSide = e.target.value;
        if (this.playerSide === "b" && !this.flipped) this.flip();
        if (this.playerSide === "w" && this.flipped)  this.flip();
        this.newGame();
      });
      this.root.querySelector('[data-act="clock"]').addEventListener("change", (e) => {
        this.clockMin = parseInt(e.target.value, 10) || 0;
        this.newGame();
      });
    }

    _openSettings() {
      const m = this.root.querySelector("#ch-settings");
      m.hidden = false;
      m.querySelector('[data-set="anim"]').checked = !!this.prefs.anim;
      m.querySelector('[data-set="dots"]').checked = !!this.prefs.dots;
      m.querySelector('[data-set="last"]').checked = !!this.prefs.last;
      m.querySelector('[data-set="coords"]').checked = !!this.prefs.coords;
      m.querySelector('[data-set="sound"]').checked = !!this.prefs.sound;
      m.querySelector('[data-set="autoq"]').checked = !!this.prefs.autoQueen;
      m.querySelector('[data-set="theme"]').value = this.prefs.theme || "classic";
      m.querySelector('[data-set="pieces"]').value = this.prefs.pieces || "unicode";
      m.querySelectorAll("[data-set]").forEach(el => {
        el.addEventListener("change", () => this._readSettings());
      });
    }
    _closeSettings() {
      const m = this.root.querySelector("#ch-settings");
      m.hidden = true;
    }
    _readSettings() {
      const m = this.root.querySelector("#ch-settings");
      this.prefs.anim = m.querySelector('[data-set="anim"]').checked;
      this.prefs.dots = m.querySelector('[data-set="dots"]').checked;
      this.prefs.last = m.querySelector('[data-set="last"]').checked;
      this.prefs.coords = m.querySelector('[data-set="coords"]').checked;
      this.prefs.sound = m.querySelector('[data-set="sound"]').checked;
      this.prefs.autoQueen = m.querySelector('[data-set="autoq"]').checked;
      this.prefs.theme  = m.querySelector('[data-set="theme"]').value;
      this.prefs.pieces = m.querySelector('[data-set="pieces"]').value;
      this.root.dataset.theme  = this.prefs.theme;
      this.root.dataset.pieces = this.prefs.pieces;
      this.root.dataset.anim   = this.prefs.anim ? "on" : "off";
      this.root.dataset.coords = this.prefs.coords ? "on" : "off";
      this._savePrefs();
      this._renderBoard();
    }

    /* -- board interaction --------------------------------------------- */
    _wireBoard() {
      this.boardEl.addEventListener("click", (e) => this._onSquareClick(e));
      this.boardEl.addEventListener("mousedown", (e) => this._onMouseDown(e));
    }

    _onSquareClick(e) {
      if (this.gameOver || this.aiThinking) return;
      if (this.cursor !== this.history.length) return; // only at live position
      if (this.mode === "ava") return;
      const sq = e.target.closest(".ch-square");
      if (!sq) return;
      const r = parseInt(sq.dataset.r, 10);
      const c = parseInt(sq.dataset.c, 10);
      this._handleSquareInput(r, c);
    }

    _handleSquareInput(r, c) {
      const piece = this.state.board[r][c];
      const turn  = this.state.turn;

      // If we've selected one already and click on a legal target, move.
      if (this.selected) {
        const legal = this.legalCache || [];
        const move  = legal.find(m => m.to[0] === r && m.to[1] === c);
        if (move) {
          this._tryMove(move);
          return;
        }
        // clicked own piece → reselect
        if (piece !== "." && pieceSide(piece) === turn) {
          this._select(r, c);
          return;
        }
        // anywhere else → deselect
        this._clearSelection();
        return;
      }
      // not yet selected → only own pieces selectable
      if (piece !== "." && pieceSide(piece) === turn) {
        if (this.mode === "hva" && turn !== this.playerSide) return;
        this._select(r, c);
      }
    }

    _select(r, c) {
      this.selected = [r, c];
      const all = generateLegalMoves(this.state);
      this.legalCache = all.filter(m => m.from[0] === r && m.from[1] === c);
      this._renderBoard();
    }

    _clearSelection() {
      this.selected = null;
      this.legalCache = null;
      this._renderBoard();
    }

    _onMouseDown(e) {
      if (this.gameOver || this.aiThinking) return;
      if (this.cursor !== this.history.length) return;
      if (this.mode === "ava") return;
      if (e.button !== 0) return;
      const sq = e.target.closest(".ch-square");
      if (!sq) return;
      const pieceEl = e.target.closest(".ch-piece");
      if (!pieceEl) return;
      const r = parseInt(sq.dataset.r, 10);
      const c = parseInt(sq.dataset.c, 10);
      const p = this.state.board[r][c];
      if (p === "." || pieceSide(p) !== this.state.turn) return;
      if (this.mode === "hva" && this.state.turn !== this.playerSide) return;

      this._select(r, c);

      const ghost = document.createElement("div");
      ghost.className = "ch-drag-ghost";
      ghost.textContent = GLYPH[p];
      ghost.style.color = isWhite(p) ? "#fff" : "#1a1a1a";
      ghost.style.textShadow = isWhite(p) ? "0 0 2px #000" : "0 0 1px #fff";
      document.body.appendChild(ghost);

      const move = (ev) => {
        ghost.style.left = ev.clientX + "px";
        ghost.style.top  = ev.clientY + "px";
        // hover highlight
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const overSq = el && el.closest && el.closest(".ch-square");
        this.boardEl.querySelectorAll(".hover-from").forEach(x => x.classList.remove("hover-from"));
        if (overSq) overSq.classList.add("hover-from");
      };
      const up = (ev) => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        ghost.remove();
        this.boardEl.querySelectorAll(".hover-from").forEach(x => x.classList.remove("hover-from"));
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const overSq = el && el.closest && el.closest(".ch-square");
        if (overSq) {
          const tr = parseInt(overSq.dataset.r, 10);
          const tc = parseInt(overSq.dataset.c, 10);
          if (tr === r && tc === c) return; // didn't move
          const legal = (this.legalCache || []);
          const m = legal.find(mm => mm.to[0] === tr && mm.to[1] === tc);
          if (m) this._tryMove(m);
          else this._clearSelection();
        } else {
          this._clearSelection();
        }
      };
      // start drag at small threshold
      const startX = e.clientX, startY = e.clientY;
      const armed = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
          document.removeEventListener("mousemove", armed);
          document.addEventListener("mousemove", move);
          move(ev);
        }
      };
      document.addEventListener("mousemove", armed);
      document.addEventListener("mouseup", up, { once: true });
    }

    /* -- modals ---------------------------------------------------------- */
    _wireModals() {
      // promotion dialog handler set up per-prompt
      const go = this.root.querySelector("#ch-gameover");
      go.addEventListener("click", (e) => {
        if (e.target === go) this._closeGameOver();
      });
      const set = this.root.querySelector("#ch-settings");
      set.addEventListener("click", (e) => {
        if (e.target === set) this._closeSettings();
      });
    }

    _openPromotion(side) {
      return new Promise(resolve => {
        if (this.prefs.autoQueen) {
          resolve(side === "w" ? "Q" : "q");
          return;
        }
        const m = this.root.querySelector("#ch-promo");
        m.hidden = false;
        const handler = (e) => {
          const b = e.target.closest(".ch-promo-btn");
          if (!b) return;
          const code = b.dataset.promo;
          m.hidden = true;
          m.removeEventListener("click", handler);
          resolve(side === "w" ? code.toUpperCase() : code);
        };
        m.addEventListener("click", handler);
      });
    }

    _showGameOver(result, winner) {
      const m = this.root.querySelector("#ch-gameover");
      const icon  = m.querySelector('[data-go="icon"]');
      const title = m.querySelector('[data-go="title"]');
      const sub   = m.querySelector('[data-go="sub"]');

      let t = "Game Over", s = "", ic = "🏁";
      switch (result) {
        case RESULT.CHECKMATE:
          t = "Checkmate!";
          s = (winner === "w" ? "White" : "Black") + " wins by checkmate.";
          ic = winner === this.playerSide ? "🏆" : "💀";
          break;
        case RESULT.STALEMATE:
          t = "Stalemate"; s = "Draw — the side to move has no legal moves."; ic = "🤝"; break;
        case RESULT.DRAW_50:
          t = "Draw"; s = "50-move rule reached without a pawn move or capture."; ic = "🤝"; break;
        case RESULT.DRAW_3FR:
          t = "Draw"; s = "Threefold repetition."; ic = "🔁"; break;
        case RESULT.DRAW_INSUF:
          t = "Draw"; s = "Insufficient material."; ic = "♟"; break;
        case RESULT.TIMEOUT:
          t = "Timeout";
          s = (winner === "w" ? "White" : "Black") + " wins on time.";
          ic = winner === this.playerSide ? "⏱" : "⌛"; break;
      }
      icon.textContent = ic;
      title.textContent = t;
      sub.textContent = s;
      m.hidden = false;
    }
    _closeGameOver() {
      this.root.querySelector("#ch-gameover").hidden = true;
    }

    /* -- keyboard -------------------------------------------------------- */
    _wireKeyboard() {
      this._keyHandler = (e) => {
        if (!document.body.contains(this.host)) return;
        if (e.target.closest("input, select, textarea")) return;
        const tag = (e.key || "").toLowerCase();
        if (e.ctrlKey && tag === "z") { e.preventDefault(); this.undo(); return; }
        if (e.ctrlKey && tag === "n") { e.preventDefault(); this.newGame(); return; }
        if (tag === "f") { this.flip(); return; }
        if (tag === "h") { this.hint(); return; }
        if (e.key === "Escape") {
          this._clearSelection();
          this._closeGameOver();
          this._closeSettings();
        }
        if (e.key === "ArrowLeft")  { e.preventDefault(); this.jumpTo(Math.max(0, this.cursor - 1)); }
        if (e.key === "ArrowRight") { e.preventDefault(); this.jumpTo(Math.min(this.history.length, this.cursor + 1)); }
      };
      window.addEventListener("keydown", this._keyHandler);
    }

    /* -- new game / flip / undo / hint ---------------------------------- */
    newGame() {
      this._stopClock();
      this.state = newState();
      this.history = [];
      this.cursor = 0;
      this.captured = { byWhite: [], byBlack: [] };
      this.lastMove = null;
      this.gameOver = false;
      this.selected = null;
      this.legalCache = null;
      this.aiThinking = false;
      if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
      // record starting position
      const k = posKey(this.state);
      this.state.posCount[k] = 1;

      // sync flipped to playerSide
      const wantFlip = (this.mode === "hva" && this.playerSide === "b");
      if (this.flipped !== wantFlip) { this.flipped = wantFlip; this._buildCoords(); }

      // clocks
      if (this.clockMin > 0) {
        this.clockW = this.clockMin * 60;
        this.clockB = this.clockMin * 60;
      } else {
        this.clockW = this.clockB = 0;
      }
      this._renderClocks();
      this._renderBoard();
      this._renderHistory();
      this._renderCaptured();
      this._renderTurn();

      // schedule AI move if needed
      if (this._shouldAIMove()) this._scheduleAI();
      if (this.clockMin > 0) this._startClock();
    }

    flip() {
      this.flipped = !this.flipped;
      this._buildCoords();
      this._renderBoard();
    }

    undo() {
      if (this.history.length === 0) return;
      // In Human-vs-AI we undo two plies (player + AI) when it's the player's
      // turn; otherwise just one.
      let undoCount = 1;
      if (this.mode === "hva" && this.history.length >= 2) {
        const lastByAI = this.history[this.history.length - 1].sideMoved !== this.playerSide;
        if (!lastByAI) undoCount = 2;
        else undoCount = 2;
      }
      undoCount = Math.min(undoCount, this.history.length);

      for (let i = 0; i < undoCount; i++) {
        const entry = this.history.pop();
        unmakeMove(this.state, entry.undo);
        // restore captured
        if (entry.captured) {
          if (isWhite(entry.captured)) this.captured.byBlack.pop();
          else this.captured.byWhite.pop();
        }
        // restore posCount
        const k = entry.posKey;
        this.state.posCount[k] = (this.state.posCount[k] || 1) - 1;
        if (this.state.posCount[k] <= 0) delete this.state.posCount[k];
      }
      this.cursor = this.history.length;
      this.lastMove = this.history.length ? this.history[this.history.length - 1].move : null;
      this.gameOver = false;
      this.state.result = RESULT.ONGOING;
      this._closeGameOver();
      this._renderBoard();
      this._renderHistory();
      this._renderCaptured();
      this._renderTurn();
    }

    hint() {
      if (this.gameOver) return;
      if (this.aiThinking) return;
      this.aiThinking = true;
      this._renderTurn();
      setTimeout(() => {
        const r = search(this.state, 2);
        this.aiThinking = false;
        this._renderTurn();
        if (!r.move) return;
        const fr = this.squares[r.move.from.join(",")];
        const to = this.squares[r.move.to.join(",")];
        if (fr) fr.classList.add("hint-from");
        if (to) to.classList.add("hint-to");
        setTimeout(() => {
          if (fr) fr.classList.remove("hint-from");
          if (to) to.classList.remove("hint-to");
        }, 1500);
      }, 30);
    }

    resetStats() {
      this.stats = { easy: { wins:0,losses:0,draws:0,streak:0 }, medium: { wins:0,losses:0,draws:0,streak:0 }, hard: { wins:0,losses:0,draws:0,streak:0 }, hvh: { wins:0,losses:0,draws:0,streak:0 } };
      this._saveStats();
      this._renderStats();
    }

    /* -- core: try a move ------------------------------------------------ */
    async _tryMove(move) {
      // promotion
      if (pieceType(move.piece) === "P") {
        const isW = isWhite(move.piece);
        const tr = move.to[0];
        if ((isW && tr === 0) || (!isW && tr === 7)) {
          if (!move.promo) {
            const code = await this._openPromotion(isW ? "w" : "b");
            move = Object.assign({}, move, { promo: code });
          }
        }
      }
      this._applyMove(move);
    }

    _applyMove(move) {
      const undo = makeMove(this.state, move);
      const sideMoved = opposite(this.state.turn); // moved side
      // captured update
      if (undo.captured) {
        if (isWhite(undo.captured)) this.captured.byBlack.push(undo.captured);
        else this.captured.byWhite.push(undo.captured);
      }
      const k = posKey(this.state);
      this.state.posCount[k] = (this.state.posCount[k] || 0) + 1;
      const san = moveToSAN_for_played(move, undo, this);

      this.history.push({
        move,
        undo,
        san,
        sideMoved,
        captured: undo.captured,
        posKey: k,
        fen: toFEN(this.state),
      });
      this.lastMove = move;
      this.cursor = this.history.length;

      this._clearSelection();
      this._animateAndRender(move);
      this._renderHistory();
      this._renderCaptured();
      this._renderTurn();

      // check game state
      const r = detectGameResult(this.state);
      if (r.result !== RESULT.ONGOING) {
        this._endGame(r.result, r.winner);
        return;
      }
      if (this._shouldAIMove()) this._scheduleAI();
    }

    /* -- AI scheduling --------------------------------------------------- */
    _shouldAIMove() {
      if (this.gameOver) return false;
      if (this.mode === "ava") return true;
      if (this.mode === "hva" && this.state.turn !== this.playerSide) return true;
      return false;
    }

    _scheduleAI() {
      this.aiThinking = true;
      this._renderTurn();
      const depth = this.diff === "easy" ? 1 : this.diff === "hard" ? 3 : 2;
      const delay = this.mode === "ava" ? 600 : 250;
      this.aiTimer = setTimeout(() => {
        this.aiTimer = null;
        try {
          let move;
          if (this.diff === "easy" && Math.random() < 0.25) {
            // 25% random moves at easy
            const moves = generateLegalMoves(this.state);
            move = moves[Math.floor(Math.random() * moves.length)];
          } else {
            const r = search(this.state, depth);
            move = r.move;
          }
          this.aiThinking = false;
          if (!move) {
            // game already over (shouldn't happen)
            this._renderTurn();
            return;
          }
          this._applyMove(move);
        } catch (e) {
          console.error("[chess] AI error:", e);
          this.aiThinking = false;
          this._renderTurn();
        }
      }, delay);
    }

    /* -- end game stat tracking ----------------------------------------- */
    _endGame(result, winner) {
      this.gameOver = true;
      this.state.result = result;
      this.state.winner = winner;
      this._stopClock();
      // stats
      let key = null;
      if (this.mode === "hva") key = this.diff;
      else if (this.mode === "hvh") key = "hvh";
      if (key && this.stats[key]) {
        const st = this.stats[key];
        if (winner === null) {
          st.draws++; st.streak = 0;
        } else if (this.mode === "hva") {
          if (winner === this.playerSide) { st.wins++; st.streak = (st.streak || 0) + 1; }
          else { st.losses++; st.streak = 0; }
        } else {
          // human-vs-human: count win for whoever (track both)
          if (winner === "w") st.wins++; else st.losses++;
        }
        this._saveStats();
      }
      this._renderStats();
      this._showGameOver(result, winner);
      this._notify(result, winner);
    }

    _notify(result, winner) {
      try {
        if (!window.Notifications) return;
        let msg = "Game over.";
        if (result === RESULT.CHECKMATE)
          msg = "Checkmate — " + (winner === "w" ? "White" : "Black") + " wins!";
        else if (result === RESULT.STALEMATE) msg = "Stalemate — game drawn.";
        else if (result === RESULT.DRAW_50)   msg = "Draw — 50-move rule.";
        else if (result === RESULT.DRAW_3FR)  msg = "Draw — threefold repetition.";
        else if (result === RESULT.DRAW_INSUF) msg = "Draw — insufficient material.";
        else if (result === RESULT.TIMEOUT)
          msg = (winner === "w" ? "White" : "Black") + " wins on time!";
        window.Notifications.info("OsChess", msg, { icon: "♟", silent: false });
      } catch {}
    }

    /* -- jump in history ------------------------------------------------- */
    jumpTo(plyIndex) {
      if (plyIndex < 0) plyIndex = 0;
      if (plyIndex > this.history.length) plyIndex = this.history.length;
      // rebuild from start
      const target = plyIndex;
      const moves = this.history.slice(0, target).map(h => h.move);
      // restore live-state by rolling back fully then replaying
      while (this.history.length > target) {
        const e = this.history.pop();
        unmakeMove(this.state, e.undo);
      }
      while (this.history.length < target) {
        // shouldn't happen — but guard
        break;
      }
      this.cursor = target;
      this.lastMove = this.history.length ? this.history[this.history.length - 1].move : null;
      this._renderBoard();
      this._renderHistory();
      this._renderCaptured();
      this._renderTurn();
    }

    /* -- rendering ------------------------------------------------------- */
    _renderBoard() {
      const flip = this.flipped;
      // place squares in DOM order based on flipped flag
      const board = this.boardEl;
      // we don't reorder DOM nodes; we just visually flip via CSS-grid order
      // by setting `style.order` on each square.
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const sq = this.squares[r + "," + c];
          if (!sq) continue;
          const dispR = flip ? 7 - r : r;
          const dispC = flip ? 7 - c : c;
          sq.style.order = dispR * 8 + dispC;
          sq.classList.remove(
            "selected", "legal", "legal-cap",
            "last-from", "last-to", "in-check"
          );
          // piece glyph
          const p = this.state.board[r][c];
          let pieceEl = sq.querySelector(".ch-piece");
          if (p === ".") {
            if (pieceEl) pieceEl.remove();
          } else {
            if (!pieceEl) {
              pieceEl = document.createElement("div");
              pieceEl.className = "ch-piece";
              sq.appendChild(pieceEl);
            }
            pieceEl.textContent = GLYPH[p];
            pieceEl.classList.toggle("white", isWhite(p));
            pieceEl.classList.toggle("black", isBlack(p));
            pieceEl.dataset.piece = p;
          }
        }
      }
      // selection
      if (this.selected) {
        const [sr, sc] = this.selected;
        this.squares[sr + "," + sc].classList.add("selected");
      }
      // legal move dots
      if (this.prefs.dots && this.legalCache) {
        for (const m of this.legalCache) {
          const [tr, tc] = m.to;
          const sq = this.squares[tr + "," + tc];
          if (!sq) continue;
          if (m.captured || m.special === "ep") sq.classList.add("legal-cap");
          else sq.classList.add("legal");
        }
      }
      // last move highlight
      if (this.prefs.last && this.lastMove) {
        const [fr, fc] = this.lastMove.from;
        const [tr, tc] = this.lastMove.to;
        const a = this.squares[fr + "," + fc];
        const b = this.squares[tr + "," + tc];
        if (a) a.classList.add("last-from");
        if (b) b.classList.add("last-to");
      }
      // check highlight
      if (inCheck(this.state)) {
        const k = findKing(this.state, this.state.turn);
        if (k) this.squares[k.join(",")].classList.add("in-check");
      }
    }

    _animateAndRender(move) {
      // Quick re-render. Could be fancier — keep simple but clean.
      this._renderBoard();
    }

    _renderHistory() {
      const el = this.histEl;
      el.innerHTML = "";
      const totalPairs = Math.ceil(this.history.length / 2);
      for (let i = 0; i < totalPairs; i++) {
        const num = document.createElement("div");
        num.className = "ch-hist-num";
        num.textContent = (i + 1) + ".";
        el.appendChild(num);
        const wIdx = i * 2;
        const bIdx = i * 2 + 1;
        const w = document.createElement("div");
        w.className = "ch-hist-mv";
        w.textContent = this.history[wIdx] ? this.history[wIdx].san : "";
        if (this.history[wIdx]) {
          w.dataset.ply = wIdx + 1;
          w.addEventListener("click", () => this.jumpTo(wIdx + 1));
          if (this.cursor === wIdx + 1) w.classList.add("current");
        }
        el.appendChild(w);
        const b = document.createElement("div");
        b.className = "ch-hist-mv";
        b.textContent = this.history[bIdx] ? this.history[bIdx].san : "";
        if (this.history[bIdx]) {
          b.dataset.ply = bIdx + 1;
          b.addEventListener("click", () => this.jumpTo(bIdx + 1));
          if (this.cursor === bIdx + 1) b.classList.add("current");
        }
        el.appendChild(b);
      }
      // scroll to bottom
      el.scrollTop = el.scrollHeight;
    }

    _renderCaptured() {
      const w = this.root.querySelector('[data-list="byWhite"]');
      const b = this.root.querySelector('[data-list="byBlack"]');
      const ws = this.root.querySelector('[data-score="byWhite"]');
      const bs = this.root.querySelector('[data-score="byBlack"]');
      const sortPieces = arr => arr.slice().sort(
        (a, b) => PIECE_VALUES[pieceType(b)] - PIECE_VALUES[pieceType(a)]
      );
      const fill = (host, list) => {
        host.innerHTML = "";
        sortPieces(list).forEach(p => {
          const el = document.createElement("span");
          el.className = "ch-cap-piece " + (isWhite(p) ? "white" : "black");
          el.textContent = GLYPH[p];
          host.appendChild(el);
        });
      };
      fill(w, this.captured.byWhite);
      fill(b, this.captured.byBlack);
      let mat = 0;
      this.captured.byWhite.forEach(p => mat += PIECE_VALUES[pieceType(p)] / 100);
      this.captured.byBlack.forEach(p => mat -= PIECE_VALUES[pieceType(p)] / 100);
      if (mat > 0) { ws.textContent = "+" + Math.round(mat); bs.textContent = ""; }
      else if (mat < 0) { bs.textContent = "+" + Math.round(-mat); ws.textContent = ""; }
      else { ws.textContent = ""; bs.textContent = ""; }
    }

    _renderTurn() {
      const dot = this.root.querySelector('[data-turn="dot"]');
      const txt = this.root.querySelector('[data-turn="text"]');
      const flag = this.root.querySelector('[data-turn="flag"]');
      dot.classList.toggle("black", this.state.turn === "b");
      let label = (this.state.turn === "w" ? "White" : "Black") + " to move";
      if (this.aiThinking) label = "AI thinking…";
      if (this.gameOver)   label = "Game over";
      txt.textContent = label;
      flag.textContent = inCheck(this.state) && !this.gameOver ? "Check!" : "";
      // active clock
      const cw = this.root.querySelector('.chess-clock[data-side="w"]');
      const cb = this.root.querySelector('.chess-clock[data-side="b"]');
      if (cw && cb) {
        cw.classList.toggle("active", this.state.turn === "w" && !this.gameOver);
        cb.classList.toggle("active", this.state.turn === "b" && !this.gameOver);
      }
    }

    _renderStats() {
      const key = this.mode === "hva" ? this.diff : "hvh";
      const s = this.stats[key] || { wins:0,losses:0,draws:0,streak:0 };
      this.root.querySelector('[data-stat="wins"]').textContent = s.wins;
      this.root.querySelector('[data-stat="losses"]').textContent = s.losses;
      this.root.querySelector('[data-stat="draws"]').textContent = s.draws;
      this.root.querySelector('[data-stat="streak"]').textContent = s.streak;
    }

    /* -- clocks ---------------------------------------------------------- */
    _startClock() {
      this._stopClock();
      this.clockTimer = setInterval(() => {
        if (this.gameOver) return;
        if (this.aiThinking) {
          // still tick — AI uses its own clock
        }
        if (this.state.turn === "w") this.clockW = Math.max(0, this.clockW - 1);
        else                          this.clockB = Math.max(0, this.clockB - 1);
        this._renderClocks();
        if (this.clockW === 0 && this.clockMin > 0) this._endGame(RESULT.TIMEOUT, "b");
        if (this.clockB === 0 && this.clockMin > 0) this._endGame(RESULT.TIMEOUT, "w");
      }, 1000);
    }
    _stopClock() {
      if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    }
    _renderClocks() {
      const w = this.root.querySelector('[data-time="w"]');
      const b = this.root.querySelector('[data-time="b"]');
      const fmt = (s) => {
        if (this.clockMin === 0) return "--:--";
        const mm = Math.floor(s / 60);
        const ss = s % 60;
        return (mm < 10 ? "0" : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
      };
      if (w) w.textContent = fmt(this.clockW);
      if (b) b.textContent = fmt(this.clockB);
      const cw = this.root.querySelector('.chess-clock[data-side="w"]');
      const cb = this.root.querySelector('.chess-clock[data-side="b"]');
      if (cw) cw.classList.toggle("low", this.clockMin > 0 && this.clockW <= 30);
      if (cb) cb.classList.toggle("low", this.clockMin > 0 && this.clockB <= 30);
    }

    /* -- PGN ------------------------------------------------------------- */
    toPGN() {
      const tags = [
        '[Event "OsChess Casual"]',
        '[Site "WebOS"]',
        '[Date "' + new Date().toISOString().slice(0,10).replace(/-/g, ".") + '"]',
        '[White "' + (this.mode === "ava" ? "AI" : (this.mode === "hva" && this.playerSide === "w" ? "Player" : "AI")) + '"]',
        '[Black "' + (this.mode === "ava" ? "AI" : (this.mode === "hva" && this.playerSide === "b" ? "Player" : "AI")) + '"]',
        '[Result "' + this._pgnResult() + '"]',
      ];
      let body = "";
      for (let i = 0; i < this.history.length; i++) {
        if (i % 2 === 0) body += (Math.floor(i / 2) + 1) + ". ";
        body += this.history[i].san + " ";
      }
      body += this._pgnResult();
      return tags.join("\n") + "\n\n" + body;
    }
    _pgnResult() {
      if (!this.gameOver) return "*";
      if (this.state.winner === "w") return "1-0";
      if (this.state.winner === "b") return "0-1";
      return "1/2-1/2";
    }
    copyPGN() {
      try {
        const txt = this.toPGN();
        navigator.clipboard.writeText(txt);
        if (window.Notifications) window.Notifications.success("OsChess", "PGN copied to clipboard");
      } catch (e) {
        console.warn(e);
      }
    }
  }

  /* -----------------------------------------------------------------------
   * Helper: wrap moveToSAN with the right state context after make.
   * --------------------------------------------------------------------- */
  function moveToSAN_for_played(move, undo, game) {
    // The state in game.state is *after* the move. We need to pass the state
    // *before* the move to moveToSAN to get correct disambiguation. So
    // briefly roll back, compute, then redo.
    unmakeMove(game.state, undo);
    const all = generateLegalMoves(game.state);
    const san = moveToSAN(game.state, move, all);
    makeMove(game.state, move); // redo (undo info is regenerated identically)
    return san;
  }

  /* -----------------------------------------------------------------------
   * Default preferences
   * --------------------------------------------------------------------- */
  function _defPrefs() {
    return {
      anim: true,
      dots: true,
      last: true,
      coords: true,
      sound: false,
      autoQueen: false,
      theme: "classic",
      pieces: "unicode",
    };
  }

  /* -----------------------------------------------------------------------
   * Inline fallback markup if fetch() of chess.html fails (file:// origin)
   * --------------------------------------------------------------------- */
  function _inlineFallback() {
    return `
      <div class="chess-app">
        <div class="chess-toolbar">
          <button class="ch-btn ch-btn-primary" data-act="new">New Game</button>
          <button class="ch-btn" data-act="undo">Undo</button>
          <button class="ch-btn" data-act="flip">Flip</button>
          <button class="ch-btn" data-act="hint">Hint</button>
          <span class="ch-spacer"></span>
          <select class="ch-select" data-act="mode">
            <option value="hva">Human vs AI</option>
            <option value="hvh">Human vs Human</option>
            <option value="ava">AI vs AI</option>
          </select>
          <select class="ch-select" data-act="diff">
            <option value="easy">Easy</option>
            <option value="medium" selected>Medium</option>
            <option value="hard">Hard</option>
          </select>
          <select class="ch-select" data-act="side">
            <option value="w" selected>Play White</option>
            <option value="b">Play Black</option>
          </select>
          <select class="ch-select" data-act="clock">
            <option value="0" selected>No clock</option>
            <option value="5">5 min</option>
            <option value="10">10 min</option>
            <option value="15">15 min</option>
            <option value="30">30 min</option>
          </select>
          <button class="ch-btn ch-btn-icon" data-act="settings">⚙</button>
        </div>
        <div class="chess-main">
          <aside class="chess-side chess-side-left">
            <div class="chess-clock" data-side="b">
              <div class="ch-clock-name" data-name="b">Black</div>
              <div class="ch-clock-time" data-time="b">--:--</div>
            </div>
            <div class="chess-captured" data-captured="byWhite">
              <div class="ch-cap-title">Captured by White</div>
              <div class="ch-cap-list" data-list="byWhite"></div>
              <div class="ch-cap-score" data-score="byWhite">+0</div>
            </div>
            <div class="chess-stats">
              <div class="ch-stat-row"><span>Wins</span><b data-stat="wins">0</b></div>
              <div class="ch-stat-row"><span>Losses</span><b data-stat="losses">0</b></div>
              <div class="ch-stat-row"><span>Draws</span><b data-stat="draws">0</b></div>
              <div class="ch-stat-row"><span>Streak</span><b data-stat="streak">0</b></div>
            </div>
          </aside>
          <section class="chess-center">
            <div class="chess-coords-top" data-coords="files"></div>
            <div class="chess-board-wrap">
              <div class="chess-coords-left" data-coords="ranks"></div>
              <div class="chess-board" id="chess-board"></div>
              <div class="chess-coords-right" data-coords="ranks-r"></div>
            </div>
            <div class="chess-coords-bottom" data-coords="files-b"></div>
            <div class="chess-turn-bar">
              <span class="ch-turn-dot" data-turn="dot"></span>
              <span class="ch-turn-text" data-turn="text">White to move</span>
              <span class="ch-turn-flag" data-turn="flag"></span>
            </div>
          </section>
          <aside class="chess-side chess-side-right">
            <div class="chess-clock" data-side="w">
              <div class="ch-clock-name" data-name="w">White</div>
              <div class="ch-clock-time" data-time="w">--:--</div>
            </div>
            <div class="chess-captured" data-captured="byBlack">
              <div class="ch-cap-title">Captured by Black</div>
              <div class="ch-cap-list" data-list="byBlack"></div>
              <div class="ch-cap-score" data-score="byBlack">+0</div>
            </div>
            <div class="chess-history">
              <div class="ch-hist-head"><span>Move history</span><button class="ch-btn-mini" data-act="copy-pgn">⎘</button></div>
              <div class="ch-hist-body" id="chess-history"></div>
              <div class="ch-hist-foot">
                <button class="ch-btn-mini" data-act="hist-start">⏮</button>
                <button class="ch-btn-mini" data-act="hist-prev">◀</button>
                <button class="ch-btn-mini" data-act="hist-next">▶</button>
                <button class="ch-btn-mini" data-act="hist-end">⏭</button>
              </div>
            </div>
          </aside>
        </div>
        <div class="ch-modal-backdrop" id="ch-promo" hidden>
          <div class="ch-modal ch-promo">
            <h3>Choose promotion</h3>
            <div class="ch-promo-row">
              <button class="ch-promo-btn" data-promo="q">♛</button>
              <button class="ch-promo-btn" data-promo="r">♜</button>
              <button class="ch-promo-btn" data-promo="b">♝</button>
              <button class="ch-promo-btn" data-promo="n">♞</button>
            </div>
          </div>
        </div>
        <div class="ch-modal-backdrop" id="ch-gameover" hidden>
          <div class="ch-modal ch-gameover">
            <div class="ch-go-icon" data-go="icon">🏆</div>
            <h2 class="ch-go-title" data-go="title">Checkmate</h2>
            <p class="ch-go-sub" data-go="sub">White wins by checkmate</p>
            <div class="ch-go-actions">
              <button class="ch-btn ch-btn-primary" data-act="new">Play Again</button>
              <button class="ch-btn" data-act="dismiss">Review</button>
            </div>
          </div>
        </div>
        <div class="ch-modal-backdrop" id="ch-settings" hidden>
          <div class="ch-modal ch-settings">
            <h3>Chess Settings</h3>
            <label class="ch-set-row"><span>Animate piece moves</span><input type="checkbox" data-set="anim" checked></label>
            <label class="ch-set-row"><span>Show legal move dots</span><input type="checkbox" data-set="dots" checked></label>
            <label class="ch-set-row"><span>Highlight last move</span><input type="checkbox" data-set="last" checked></label>
            <label class="ch-set-row"><span>Show coordinates</span><input type="checkbox" data-set="coords" checked></label>
            <label class="ch-set-row"><span>Sound effects</span><input type="checkbox" data-set="sound" checked></label>
            <label class="ch-set-row"><span>Auto-promote to queen</span><input type="checkbox" data-set="autoq"></label>
            <label class="ch-set-row"><span>Board theme</span>
              <select data-set="theme">
                <option value="classic">Classic</option>
                <option value="ocean">Ocean</option>
                <option value="forest">Forest</option>
                <option value="midnight">Midnight</option>
                <option value="rose">Rose</option>
              </select>
            </label>
            <label class="ch-set-row"><span>Piece set</span>
              <select data-set="pieces">
                <option value="unicode">Unicode</option>
                <option value="solid">Solid</option>
              </select>
            </label>
            <div class="ch-set-actions">
              <button class="ch-btn" data-act="reset-stats">Reset Stats</button>
              <button class="ch-btn ch-btn-primary" data-act="close-settings">Done</button>
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
      width: 980, height: 720,
      minWidth: 640, minHeight: 520,
      category: "Games",
      pinned: true,
      render(body, win) {
        body.classList.add("chess-host");
        body.style.padding = "0";
        body.style.background = "var(--surface, #14182a)";
        const game = new ChessGame(body, win.opts || {});
        game.mount();
        win._chess = game;
      },
      onClose(win) {
        if (win._chess) win._chess.destroy();
      },
    });
    console.log("%c[WebOS]%c OsChess registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }
  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* =======================================================================
   * EXTRA: standalone helpers exposed for testing/console
   * ===================================================================== */

  // Mate-in-1 / quick puzzle helper (developer)
  function findMateIn1(state) {
    const moves = generateLegalMoves(state);
    for (const m of moves) {
      const undo = makeMove(state, m);
      const opp = generateLegalMoves(state);
      if (opp.length === 0 && inCheck(state)) {
        unmakeMove(state, undo);
        return m;
      }
      unmakeMove(state, undo);
    }
    return null;
  }

  // Quick perft (move generation correctness check)
  function perft(state, depth) {
    if (depth === 0) return 1;
    let nodes = 0;
    const moves = generateLegalMoves(state);
    for (const m of moves) {
      const u = makeMove(state, m);
      nodes += perft(state, depth - 1);
      unmakeMove(state, u);
    }
    return nodes;
  }

  /* =======================================================================
   * PUBLIC API
   * ===================================================================== */
  window.Chess = {
    // game class for embedding
    ChessGame,
    // engine functions for tests
    newState, generatePseudoMoves, generateLegalMoves,
    makeMove, unmakeMove, isSquareAttacked, inCheck,
    detectGameResult, evaluate, search, moveToSAN,
    findMateIn1, perft, posKey, toFEN, fromFEN,
    // constants
    PIECE_VALUES, GLYPH, RESULT,
    // open helper
    open() {
      if (window.WindowManager && window.WindowManager.openApp) {
        window.WindowManager.openApp(APP_ID);
      }
    },
  };

  /* -----------------------------------------------------------------------
   * SELF-TEST  (light, runs only in dev when ?chess-debug is in the URL)
   * --------------------------------------------------------------------- */
  if (typeof location !== "undefined" && /[?&]chess-debug\b/.test(location.search)) {
    try {
      const s = newState();
      console.log("[chess] perft(2)=", perft(s, 2));
    } catch (e) {
      console.warn("[chess] self-test failed:", e);
    }
  }

  /* =======================================================================
   * OPENING BOOK
   * -----------------------------------------------------------------------
   * Tiny in-memory opening book.  Each entry maps a sequence of SAN moves
   * to one or more candidate continuations expressed in long algebraic
   * notation (e.g. "e2e4" or "e7e8q").  Within the first 8 plies the AI
   * consults the book before falling back to the search.  The book is
   * intentionally small — enough to inject variety into early moves
   * without bloating the bundle.
   * ===================================================================== */
  const BOOK = {
    "start":     ["e2e4", "d2d4", "c2c4", "g1f3", "b1c3"],
    "e4":        ["e7e5", "c7c5", "e7e6", "c7c6", "d7d5", "g8f6"],
    "e4e5":      ["g1f3", "f1c4", "b1c3"],
    "e4e5Nf3":   ["b8c6", "g8f6", "d7d6"],
    "e4c5":      ["g1f3", "b1c3", "c2c3"],
    "e4e6":      ["d2d4", "g1f3"],
    "e4c6":      ["d2d4", "b1c3"],
    "d4":        ["d7d5", "g8f6", "e7e6", "f7f5"],
    "d4d5":      ["c2c4", "g1f3", "b1c3"],
    "d4Nf6":     ["c2c4", "g1f3"],
    "c4":        ["e7e5", "c7c5", "g8f6", "e7e6"],
    "Nf3":       ["d7d5", "g8f6", "c7c5"],
    "Nc3":       ["d7d5", "e7e5", "g8f6"],
  };

  function bookMoveForGame(game) {
    if (!game || !game.history) return null;
    if (game.history.length >= 8) return null;
    const sanList = game.history.map(h => h.san);
    const key = sanList.length === 0 ? "start" : sanList.join("");
    const candidates = BOOK[key];
    if (!candidates || candidates.length === 0) return null;
    const longAlg = candidates[Math.floor(Math.random() * candidates.length)];
    const fromAlg = longAlg.slice(0, 2);
    const toAlg   = longAlg.slice(2, 4);
    const promo   = longAlg.slice(4) || null;
    const all = generateLegalMoves(game.state);
    return all.find(m =>
      m.fromAlg === fromAlg &&
      m.toAlg === toAlg &&
      (promo ? (m.promo && m.promo.toLowerCase() === promo) : !m.promo)
    ) || null;
  }

  /* =======================================================================
   * STATE FROM FEN
   * ===================================================================== */
  function stateFromFEN(fen) {
    const lite = fromFEN(fen);
    const s = newState();
    s.board    = lite.board;
    s.turn     = lite.turn;
    s.castling = lite.castling;
    s.ep       = lite.ep;
    s.halfmove = lite.halfmove;
    s.fullmove = lite.fullmove;
    s.history  = [];
    s.posCount = Object.create(null);
    s.posCount[posKey(s)] = 1;
    s.result   = RESULT.ONGOING;
    s.winner   = null;
    return s;
  }

  /* =======================================================================
   * EVALUATION EXTRAS
   *   Exposed for tests and possible future extensions.
   * ===================================================================== */
  function countMaterial(s, side) {
    let mat = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        if (p === "." || pieceType(p) === "K") continue;
        if ((side === "w" && isWhite(p)) || (side === "b" && isBlack(p))) {
          mat += PIECE_VALUES[pieceType(p)];
        }
      }
    return mat;
  }

  function mobility(s, side) {
    const t = s.turn;
    s.turn = side;
    const m = generateLegalMoves(s).length;
    s.turn = t;
    return m;
  }

  function pawnStructureScore(s, side) {
    const pawn = side === "w" ? "P" : "p";
    const cols = [0,0,0,0,0,0,0,0];
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (s.board[r][c] === pawn) cols[c]++;
    let score = 0;
    for (const n of cols) {
      if (n > 1) score -= 15 * (n - 1); // doubled pawns penalty
    }
    for (let c = 0; c < 8; c++) {
      if (cols[c] === 0) continue;
      const hasL = c > 0 && cols[c-1] > 0;
      const hasR = c < 7 && cols[c+1] > 0;
      if (!hasL && !hasR) score -= 10;  // isolated pawn penalty
    }
    return score;
  }

  /* =======================================================================
   * BOARD UTILITIES
   * ===================================================================== */
  function boardToASCII(s) {
    let out = "  +-----------------+\n";
    for (let r = 0; r < 8; r++) {
      out += (8 - r) + " | ";
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        out += (p === "." ? "." : p) + " ";
      }
      out += "|\n";
    }
    out += "  +-----------------+\n";
    out += "    a b c d e f g h\n";
    return out;
  }

  function pieceCount(s) {
    const counts = { w: { P:0,N:0,B:0,R:0,Q:0,K:0 },
                     b: { P:0,N:0,B:0,R:0,Q:0,K:0 } };
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = s.board[r][c];
        if (p === ".") continue;
        counts[isWhite(p) ? "w" : "b"][pieceType(p)]++;
      }
    return counts;
  }

  function squareColor(r, c) { return ((r + c) % 2 === 0) ? "light" : "dark"; }

  /* =======================================================================
   * SOUND ENGINE
   *   WebAudio synth for move/capture/check sounds. We don't ship audio
   *   files. Synth is enabled only when prefs.sound is true.
   * ===================================================================== */
  let _audioCtx = null;
  function _ensureAudio() {
    if (_audioCtx) return _audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    } catch { return null; }
    return _audioCtx;
  }
  function playTone(freq, ms, type, gain) {
    const ctx = _ensureAudio();
    if (!ctx) return;
    type = type || "sine";
    gain = gain == null ? 0.06 : gain;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (ms / 1000));
    o.start();
    o.stop(ctx.currentTime + (ms / 1000));
  }
  function soundMove()    { playTone(420,  90, "triangle", 0.05); }
  function soundCapture() { playTone(280, 130, "sawtooth", 0.07); }
  function soundCheck()   { playTone(660, 200, "square",   0.05); }
  function soundCastle()  { playTone(520, 110, "triangle", 0.06); }
  function soundEnd()     { playTone(220, 480, "sine",     0.05); }

  /* =======================================================================
   * SAN PARSER
   * ===================================================================== */
  function parseSAN(s, sanRaw) {
    const san = sanRaw.replace(/[+#?!]+$/, "").trim();
    const legal = generateLegalMoves(s);
    if (san === "O-O")   return legal.find(m => m.special === "castleK") || null;
    if (san === "O-O-O") return legal.find(m => m.special === "castleQ") || null;

    let promo = null;
    let core  = san;
    const pm = core.match(/=([QRBN])$/);
    if (pm) { promo = pm[1]; core = core.slice(0, -2); }

    const dest = core.slice(-2);
    if (!/^[a-h][1-8]$/.test(dest)) return null;
    let body = core.slice(0, -2);
    if (body.endsWith("x")) body = body.slice(0, -1);

    let pieceLetter = "P";
    if (body && /[NBRQK]/.test(body[0])) {
      pieceLetter = body[0];
      body = body.slice(1);
    }
    const fromFile = (body.match(/[a-h]/) || [])[0];
    const fromRank = (body.match(/[1-8]/) || [])[0];

    return legal.find(m => {
      if (m.toAlg !== dest) return false;
      if (pieceType(m.piece) !== pieceLetter) return false;
      if (fromFile && m.fromAlg[0] !== fromFile) return false;
      if (fromRank && m.fromAlg[1] !== fromRank) return false;
      if (promo && (!m.promo || m.promo.toUpperCase() !== promo)) return false;
      return true;
    }) || null;
  }

  /* =======================================================================
   * PGN PARSING (minimal — strips tags, comments, variations)
   * ===================================================================== */
  function parsePGNMoves(text) {
    let body = text.replace(/^\s*\[[^\]]*\]\s*$/gm, "");
    body = body.replace(/\{[^}]*\}/g, "");
    body = body.replace(/;[^\n]*/g, "");
    let depth = 0, out = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    return out.split(/\s+/).filter(t =>
      t && !/^\d+\.+$/.test(t) &&
      t !== "1-0" && t !== "0-1" && t !== "1/2-1/2" && t !== "*"
    );
  }

  function loadPGN(text) {
    const tokens = parsePGNMoves(text);
    const s = newState();
    s.posCount[posKey(s)] = 1;
    const sans = [];
    for (const tok of tokens) {
      const mv = parseSAN(s, tok);
      if (!mv) break;
      makeMove(s, mv);
      sans.push(tok);
    }
    return { state: s, moves: sans };
  }

  /* =======================================================================
   * QUIESCENCE-LIKE NOISY EXTENSION (optional; not used by default)
   * ===================================================================== */
  function noisyEval(s, alpha, beta, depth) {
    if (depth <= 0) return evaluate(s);
    const stand = evaluate(s);
    if (s.turn === "w") {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    } else {
      if (stand <= alpha) return alpha;
      if (stand < beta) beta = stand;
    }
    const noisy = orderMoves(generateLegalMoves(s)).filter(m => m.captured || m.promo);
    for (const m of noisy) {
      const u = makeMove(s, m);
      const v = noisyEval(s, alpha, beta, depth - 1);
      unmakeMove(s, u);
      if (s.turn === "w") {
        if (v > alpha) alpha = v;
        if (alpha >= beta) return beta;
      } else {
        if (v < beta) beta = v;
        if (alpha >= beta) return alpha;
      }
    }
    return s.turn === "w" ? alpha : beta;
  }

  /* =======================================================================
   * DEMO POSITIONS
   * ===================================================================== */
  const DEMO_FENS = {
    starting:     "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    italian:      "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3",
    rookEndgame:  "4k3/8/8/8/8/8/4K3/4R3 w - - 0 1",
    mateIn1Back:  "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
    backRank:     "6k1/5ppp/8/8/8/8/r4PPP/3R2K1 b - - 0 1",
    insufficient: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
  };

  /* =======================================================================
   * TIMER FORMATTER + LEGAL-TARGETS HELPER
   * ===================================================================== */
  function fmtClock(seconds) {
    if (seconds == null) return "--:--";
    seconds = Math.max(0, Math.floor(seconds));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function legalTargetsFrom(s, fromAlg) {
    const moves = generateLegalMoves(s);
    return moves.filter(m => m.fromAlg === fromAlg)
                .map(m => ({
                  to: m.toAlg,
                  capture: !!m.captured,
                  special: m.special,
                  promo:   m.promo || null,
                }));
  }

  /* =======================================================================
   * COUNT ATTACKERS ON A SQUARE
   * ===================================================================== */
  function attackersOn(s, alg, bySide) {
    const [r, c] = algToRC(alg);
    let count = 0;
    for (let rr = 0; rr < 8; rr++)
      for (let cc = 0; cc < 8; cc++) {
        const p = s.board[rr][cc];
        if (p === ".") continue;
        if (pieceSide(p) !== bySide) continue;
        const tmp = [];
        switch (pieceType(p)) {
          case "P": genPawn(s, rr, cc, p, tmp); break;
          case "N": genKnight(s, rr, cc, p, tmp); break;
          case "B": genSlider(s, rr, cc, p, RAY_DIAG,  tmp); break;
          case "R": genSlider(s, rr, cc, p, RAY_ORTHO, tmp); break;
          case "Q": genSlider(s, rr, cc, p, RAY_ALL,   tmp); break;
          case "K": genKing(s, rr, cc, p, tmp); break;
        }
        if (tmp.some(m => m.toAlg === alg)) count++;
      }
    return count;
  }

  /* =======================================================================
   * EXTRA TACTIC PUZZLES
   * ===================================================================== */
  const TACTIC_PUZZLES = [
    {
      name: "Back-rank mate",
      fen:  "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
      hint: "White rook lift to the 8th rank.",
    },
    {
      name: "Knight fork",
      fen:  "r3kb1r/pp3ppp/2n2q2/2pp4/3P4/2N1PN2/PP3PPP/R2QKB1R w KQkq - 0 1",
      hint: "Find the knight fork.",
    },
    {
      name: "Smothered mate",
      fen:  "6rk/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1",
      hint: "Knight to f7 begins the pattern.",
    },
  ];

  /* =======================================================================
   * MOVE COMPARATOR
   * ===================================================================== */
  function sameMove(a, b) {
    if (!a || !b) return false;
    return a.fromAlg === b.fromAlg && a.toAlg === b.toAlg &&
           ((a.promo || null) === (b.promo || null));
  }

  /* =======================================================================
   * SNAPSHOT/RESTORE
   * ===================================================================== */
  function snapshotState(s) {
    return {
      board:    s.board.map(r => r.slice()),
      turn:     s.turn,
      castling: { K: s.castling.K, Q: s.castling.Q, k: s.castling.k, q: s.castling.q },
      ep:       s.ep,
      halfmove: s.halfmove,
      fullmove: s.fullmove,
      result:   s.result,
      winner:   s.winner,
    };
  }
  function restoreSnapshot(s, snap) {
    s.board    = snap.board.map(r => r.slice());
    s.turn     = snap.turn;
    s.castling = { K: snap.castling.K, Q: snap.castling.Q, k: snap.castling.k, q: snap.castling.q };
    s.ep       = snap.ep;
    s.halfmove = snap.halfmove;
    s.fullmove = snap.fullmove;
    s.result   = snap.result;
    s.winner   = snap.winner;
  }

  /* =======================================================================
   * ATTACKED-SQUARE MAP — useful for debug/visualisation
   * ===================================================================== */
  function attackedMap(s, bySide) {
    const map = Array.from({ length: 8 }, () => Array(8).fill(false));
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        if (isSquareAttacked(s, r, c, bySide)) map[r][c] = true;
      }
    return map;
  }

  /* =======================================================================
   * Wire helpers into the public namespace.
   * ===================================================================== */
  Object.assign(window.Chess, {
    BOOK, bookMoveForGame,
    countMaterial, mobility, pawnStructureScore,
    boardToASCII, pieceCount, squareColor,
    parseSAN, parsePGNMoves, loadPGN,
    noisyEval, stateFromFEN,
    fmtClock, legalTargetsFrom, attackersOn, attackedMap,
    soundMove, soundCapture, soundCheck, soundCastle, soundEnd,
    DEMO_FENS, TACTIC_PUZZLES,
    sameMove, snapshotState, restoreSnapshot,
  });

})();
