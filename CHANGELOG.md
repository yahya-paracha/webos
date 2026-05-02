# Changelog

All notable changes to WebOS are documented in this file.

WebOS follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **MAJOR** — incompatible API changes (e.g., a global like `window.FileSystem`
  changes its public method signatures).
- **MINOR** — new functionality added in a backwards-compatible manner
  (e.g., a new app, a new theme, a new optional feature).
- **PATCH** — backwards-compatible bug fixes and polish.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.0.0] — 2025-XX-XX  ·  "Aurora"

WebOS reaches feature-complete with the Day 7 release. Three new games, a
full polish pass, and complete documentation.

### Day 1 — Foundation  *(internal milestone)*
**Added**
- Boot screen with animated logo, progress bar, and 6 step messages
  (`boot.js`, `boot.css`).
- Theme engine (`themeEngine.js`, `themes.css`) with 5 themes (dark, light,
  cyberpunk, retro, forest) and 5 wallpapers.
- Virtual desktop (`desktop.js`, `desktop.css`) with icons, wallpaper,
  context menu, double-click activation.
- Window manager (`windowManager.js`, `windows.css`):
  drag, 8-handle resize, minimize/maximize/restore, snapping (left/right
  halves + 4 corners), z-stack focus, Alt+Tab cycling, keyboard shortcuts
  (Win+↑/↓/←/→, F11), app registry.
- Taskbar (`taskbar.js`, `taskbar.css`) — pinned apps, running pills,
  clock, system tray, notification slot, show-desktop button.
- Start menu (`startMenu.js`) — pinned apps grid, search, power button.

### Day 2 — Filesystem + File Manager  *(internal milestone)*
**Added**
- In-memory virtual filesystem (`fileSystem.js`, `window.FileSystem`):
  paths, folders, files, JSON read/write, mkdirp, rename, move, copy,
  trash, recent files, watchers, undo, clipboard, search, snapshot
  export/import, persistent storage in localStorage.
- File Manager (`fileManager.js`, `apps/fileManager/`): tree pane, content
  grid/list views, breadcrumbs, multi-select, drag, copy/cut/paste,
  rename, delete, search bar, hidden file toggle, file preview panel.
- Context menu framework (`contextMenus.js`, `window.ContextMenu`).

### Day 3 — Productivity apps  *(internal milestone)*
**Added**
- Text Editor (`textEditor.js`, `apps/textEditor/`): multi-tab, autosave,
  find/replace with regex, word count, modified-marker tabs.
- Calculator (`calculator.js`, `apps/calculator/`): basic + scientific
  modes, history pane, memory keys, full keyboard input.
- Browser (`browser.js`, `apps/browser/`): tabbed UI, address bar,
  bookmarks, history, sandboxed iframe rendering.

### Day 4 — Creative apps  *(internal milestone)*
**Added**
- OsPaint (`paint.js`, `apps/paint/`): pencil/brush/eraser/fill/text/shape
  tools, color picker, layer system, undo/redo (50 steps), PNG export.
- SoundWave (`musicPlayer.js`, `apps/musicPlayer/`): playlist UI,
  shuffle/repeat, volume, equalizer presets, WebAudio visualizer.

### Day 5 — Terminal, Settings, Backend  *(internal milestone)*
**Added**
- Terminal (`terminal.js`, `apps/terminal/`): bash-like shell with 30+
  commands (`ls`, `cd`, `cat`, `mkdir`, `rm`, `mv`, `cp`, `touch`, `pwd`,
  `echo`, `grep`, `find`, `wc`, `head`, `tail`, `clear`, `history`,
  `whoami`, `date`, `uname`, `tree`, plus pipes and redirection).
- Settings (`settings.js`, `apps/settings/`): theme picker, wallpaper
  picker, account/sign-in, backend sync toggle, accessibility, about page.
- Backend bridge (`backendSync.js`, `window.Backend`): auto-detection,
  login flow, filesystem and settings sync.
- Python backend (`backend/`): Flask server, SQLite persistence, JWT auth
  with bcrypt password hashing, REST endpoints for filesystem and
  settings sync.

### Day 6 — Intelligence + community  *(internal milestone)*
**Added**
- ARIA AI assistant (`aria.js`, `apps/aria/`): conversational panel,
  filesystem search, app launching, settings changes.
- OsStore (`appStore.js`, `apps/appStore/`): app marketplace with curated
  catalog, install/uninstall, ratings, reviews.
- Notifications system (`notifications.js`, `css/notifications.css`,
  `window.Notifications`): toast stack, full notification center, type
  colors, badge counter, do-not-disturb, persistent log of 200 entries.
- Widgets (`widgets.js`, `css/widgets.css`, `window.Widgets`): clock,
  calendar, weather, system monitor, sticky notes — pinnable to the right
  panel of the desktop.

### Day 7 — Games + final polish  *(THIS RELEASE)*
**Added**
- **OsChess** (`chess.js`, `apps/chess/`): full chess implementation with
  legal move generation for all 6 piece types, castling, en passant,
  promotion (with dialog), check/checkmate/stalemate detection, draw by
  insufficient material, threefold repetition and 50-move rule. AI built
  on minimax + alpha-beta pruning at depths 1/2/3 (Easy/Medium/Hard) with
  piece-square tables. UI features: click-to-move, drag-and-drop, ghost
  promotion picker, move history with click-to-jump in algebraic notation,
  captured pieces with material balance, optional 5/10/15/30-min clocks,
  hint button, undo (player + AI in HvA mode), flip-board, copy-PGN,
  AI-vs-AI watch mode, opening book, settings panel (anim/dots/last-move/
  coords/sound/auto-queen/board-theme/piece-set). Stats persisted to
  `/.games/chess_stats.json`.
- **OsTetris** (`tetris.js`, `apps/tetris/`): all 7 tetrominoes with SRS
  rotation, ghost piece, hold piece, 7-bag randomizer, next-3 preview, full
  wall-kick tables (separate I-table), lock delay (0.5 s) and ARE delay
  (0.2 s), DAS/ARR for held arrows. Scoring: single/double/triple/Tetris
  ×level, T-spin (mini and full) bonuses, back-to-back ×1.5 bonus, combo
  bonus, soft drop +1 / hard drop +2. Level system: +1 every 10 lines,
  gravity from 800 ms (L1) down to 25 ms (L21+). Pause, restart, game-over
  overlay with rank, top-10 high scores in `/.games/tetris_scores.json`.
- **OsMinesweeper** (`minesweeper.js`, `apps/minesweeper/`): three
  presets + custom difficulty (with validation, max 50×50). First-click
  always safe (mines placed afterward, excluding clicked cell + neighbors).
  Flood fill on zero cells, right-click flagging, chord click on revealed
  numbers, smiley face button (🙂😮😎😵), three-digit mine counter and
  timer, classic Win95 beveled skin and a modern flat skin (toggle button).
  Per-difficulty best times in `/.games/minesweeper_times.json`.
- **Polish layer** (`polish.js`):
  - Window shake animation when trying to drag a maximized window
  - Window minimize/restore "fly" animations targeting the matching
    taskbar pill position
  - Alt+Tab switcher with **live window thumbnails** (CSS-scaled clones)
  - **Aero Peek**: hovering a taskbar pill shows a ghost outline of the
    window's actual on-screen rect
  - Slow-double-click rename on desktop icons (in addition to F2)
  - Drag-from-File-Manager-onto-Desktop drop handler
  - Animated power menu: shutdown fades to black, restart flashes white
    then re-runs boot, lock blurs the desktop with a clock screen
  - "Recently installed" tracking + red `NEW` badge on start-menu tiles
    for apps installed in the last 7 days
  - **Konami code easter egg** (↑↑↓↓←→←→BA) — desktop icons drift around
    the screen for 5 seconds with emoji particle bursts; discovery saved
    to localStorage
- **boot.js** modified:
  - BIOS-style pre-screen (1 s) with CPU/RAM/GPU/storage messages and a
    blinking "Press DEL to enter setup" prompt before the main boot screen
  - Live percentage counter (0% → 100%) tweens alongside the progress bar
  - Two new boot steps: "Initializing notification daemon" and
    "Starting widget compositor" (8 total)
- **css/desktop.css** modifications absorbed by `polish.js` injected
  styles: subtle wallpaper parallax (~3 px max offset on mouse move),
  softer radial-glow desktop-icon selection highlight.
- **js/taskbar.js** complementary polish via `polish.js`:
  - Clock hover tooltip shows full date and day of week
  - Right-click clock opens context menu (Open Calendar Widget / Copy
    Time / Copy Date / Date & Time Settings)
  - Running app pills get an orange dot indicator when the app exposes
    `hasPendingChanges() → true`
- **js/desktop.js** complementary polish via `polish.js`:
  - Slow double-click rename
  - Drag-onto-desktop file drop handler
  - Konami code keyboard listener
- **js/startMenu.js** complementary polish via `polish.js`:
  - "Recently installed" `NEW` badges
  - Power menu shutdown / restart / lock animations

**Documentation**
- `README.md` — full project overview, features, screenshots description,
  run instructions, complete keyboard shortcuts table, app list,
  technology stack, project structure, day-by-day build log,
  contributing guide, MIT license.
- `CHANGELOG.md` — this file, with semver explanation and complete
  per-day history.

---

## [Unreleased]

Planned for future releases:

- Touch / mobile-friendly layout
- Multi-user accounts on the backend
- Cloud-stored OsPaint canvases
- Multiplayer chess (over WebSocket via the Python backend)
- Tetris tournament mode
- More themes and wallpapers
- Localization (i18n)
