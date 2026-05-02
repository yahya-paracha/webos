# WebOS

```
██╗    ██╗███████╗██████╗  ██████╗ ███████╗
██║    ██║██╔════╝██╔══██╗██╔═══██╗██╔════╝
██║ █╗ ██║█████╗  ██████╔╝██║   ██║███████╗
██║███╗██║██╔══╝  ██╔══██╗██║   ██║╚════██║
╚███╔███╔╝███████╗██████╔╝╚██████╔╝███████║
 ╚══╝╚══╝ ╚══════╝╚═════╝  ╚═════╝ ╚══════╝
        a desktop in your browser
```

A fully functional desktop operating system that runs entirely inside your
browser. Boot animation, draggable windows, virtual filesystem, fifteen
built-in apps (including chess, Tetris and Minesweeper), themes,
notifications, widgets, an app store, an AI assistant, and an optional
Python backend for cloud sync — all written from scratch in vanilla
HTML/CSS/JavaScript.

WebOS was built day-by-day across **7 days, 62 files, ~57,000 lines of code**.

---

## ✨ Features

### Core OS
- **Animated boot sequence** — BIOS pre-screen, percentage counter, 8 boot
  steps, smooth fade into the desktop.
- **Window manager** — drag, resize (8 handles), minimize, maximize, snap
  (left/right/corners), Alt+Tab thumbnail switcher, Aero Peek, F11 maximize.
- **Taskbar** — running app pills, pinned apps, system tray, clock with
  context menu, notification badge, "show desktop" button.
- **Start Menu** — pinned apps grid, recently used, "NEW" badges for apps
  installed in the last 7 days, animated power menu (shutdown / restart /
  lock).
- **Desktop** — wallpaper parallax, drag-and-drop file rearranging,
  slow-double-click rename, right-click context menu, Konami code easter egg.
- **Theme engine** — five built-in themes (Dark, Light, Cyberpunk, Retro,
  Forest), five wallpaper styles, animation toggle.
- **Notifications** — toast stack, full notification center, type colors,
  badge counter, persistent log.
- **Widgets** — clock, calendar, weather, system monitor, sticky notes.

### Apps
| App | Icon | Description |
|---|---|---|
| **File Manager** | 📁 | Tree view + grid, copy/cut/paste, drag, search, breadcrumbs, multi-select. |
| **Text Editor** | 📝 | Tabs, syntax-friendly fonts, find/replace, autosave, word count. |
| **Calculator** | 🔢 | Basic + scientific modes, history, keyboard input, memory keys. |
| **Browser** | 🌐 | Tabs, bookmarks, history, address bar, sandboxed iframe rendering. |
| **OsPaint** | 🎨 | Brush, pencil, eraser, shapes, fill, layers, undo/redo, export PNG. |
| **SoundWave** | 🎵 | Music player with playlist, equalizer, visualizer, shuffle/repeat. |
| **Terminal** | ⌨️ | Bash-like shell with 30+ commands and pipes/redirection. |
| **Settings** | ⚙ | Theme, wallpaper, account, sync, accessibility, about. |
| **ARIA** | 🤖 | Built-in AI assistant for help/search/automation. |
| **OsStore** | 🛒 | App marketplace with one-click install/uninstall and reviews. |
| **OsChess** | ♟ | Full chess engine with AI (3 difficulties), PGN, clocks. |
| **OsTetris** | 🟦 | Modern Tetris with SRS, ghost piece, hold, T-spins, high scores. |
| **OsMinesweeper** | 💣 | Beginner/Intermediate/Expert/Custom, chord click, best times. |

### Backend (optional)
- **Python Flask server** — user accounts, JWT auth, filesystem sync, settings
  sync, REST API.
- **SQLite database** — persists files, metadata, settings across devices.
- **Frontend bridge** — `window.Backend` automatically syncs the in-browser
  filesystem with the server when available.

---

## 📸 Screenshots

> The repository ships without binary screenshots; running the project
> locally is the easiest way to see it in action.

1. **Boot screen** — animated BIOS terminal followed by the WebOS logo,
   gradient progress bar, and rotating step messages.
2. **Desktop with widgets** — calendar, weather, and clock widgets pinned to
   the right edge over an aurora wallpaper.
3. **OsChess in mid-game** — board centered, captured pieces and stats on
   the left, move history (algebraic notation) on the right, AI thinking.
4. **OsTetris with combo** — neon-glowing tetrominoes, a Tetris just landed,
   floating "+1200 BACK-TO-BACK TETRIS ×3" score popup.
5. **OsMinesweeper Expert** — 30×16 grid mid-solve, best-time panel below.
6. **File Manager + Paint side-by-side** — windows snapped to left/right
   halves, Alt+Tab thumbnail strip overlay.
7. **Start Menu open** — pinned tiles, recently installed apps showing red
   "NEW" badges, blurred desktop behind.
8. **Settings → Themes** — preview tiles for each theme, live wallpaper
   preview swapping in real time.

---

## 🚀 How to run (frontend only)

WebOS is a static site. Any HTTP server will do:

```bash
git clone <repo-url> webos
cd webos
python3 -m http.server 8765
# open http://localhost:8765
```

Or with `npx`:

```bash
npx serve .
```

You can also open `index.html` directly with `file://` — most things work,
but a few HTML template files are loaded with `fetch()` and may fall back to
inline templates instead.

---

## 🔌 How to run with the backend

```bash
cd backend
pip install -r requirements.txt
python server.py
```

The server defaults to `http://localhost:5000`. The frontend's
`backendSync.js` will detect it automatically and start syncing the
filesystem and settings whenever the user signs in via Settings → Account.

---

## ⌨️ Keyboard shortcuts

### Desktop / Window manager
| Shortcut | Action |
|---|---|
| `Alt`+`Tab` | Cycle windows (with thumbnail switcher) |
| `Alt`+`Shift`+`Tab` | Cycle backwards |
| `Win`+`↑` | Maximize focused window |
| `Win`+`↓` | Minimize focused window |
| `Win`+`←` | Snap left half |
| `Win`+`→` | Snap right half |
| `F11` | Toggle maximize |
| `Ctrl`+`W` | Close focused window |
| `Win`+`I` | Open Settings |
| `Win`+`E` | Open File Manager |
| `Win`+`D` | Show desktop / restore all |
| `Ctrl`+`Shift`+`T` | Cycle theme |
| `Esc` (during boot) | Skip boot |
| Konami code | 🎮 (try it) |

### Text Editor
| Shortcut | Action |
|---|---|
| `Ctrl`+`N` | New file |
| `Ctrl`+`O` | Open |
| `Ctrl`+`S` | Save |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Undo / Redo |
| `Ctrl`+`F` | Find |
| `Ctrl`+`H` | Replace |
| `Ctrl`+`/` | Toggle comment |
| `Ctrl`+`A` | Select all |

### File Manager
| Shortcut | Action |
|---|---|
| `Ctrl`+`C` / `Ctrl`+`X` / `Ctrl`+`V` | Copy / Cut / Paste |
| `Delete` | Move to Trash |
| `Shift`+`Delete` | Delete permanently |
| `F2` | Rename |
| `Ctrl`+`A` | Select all |
| `Ctrl`+`Shift`+`N` | New folder |

### Terminal
| Shortcut | Action |
|---|---|
| `↑` / `↓` | History |
| `Tab` | Autocomplete |
| `Ctrl`+`L` | Clear screen |
| `Ctrl`+`C` | Cancel |

### Calculator
| Shortcut | Action |
|---|---|
| `0-9 . + - * /` | Numeric input |
| `Enter` | Equals |
| `Esc` | Clear |
| `Backspace` | Delete |

### OsPaint
| Shortcut | Action |
|---|---|
| `B` | Brush |
| `E` | Eraser |
| `R` | Rectangle |
| `O` | Oval |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Undo / Redo |
| `Ctrl`+`S` | Save |

### OsChess
| Shortcut | Action |
|---|---|
| `Ctrl`+`N` | New game |
| `Ctrl`+`Z` | Undo (player + AI) |
| `F` | Flip board |
| `H` | Hint |
| `←` / `→` | Step backward / forward in history |
| `Esc` | Deselect / close dialog |

### OsTetris
| Shortcut | Action |
|---|---|
| `←` / `→` | Move left / right |
| `↓` | Soft drop |
| `Space` | Hard drop |
| `↑` or `X` | Rotate clockwise |
| `Z` | Rotate counter-clockwise |
| `C` or `Shift` | Hold |
| `P` or `Esc` | Pause |

### OsMinesweeper
| Shortcut | Action |
|---|---|
| Left-click | Reveal |
| Right-click | Flag |
| Both buttons | Chord click |
| `F2` | New game |

---

## 📦 App list (deeper dive)

- **File Manager** — Two-pane layout (tree + content), context menus,
  bulk operations, search, hidden file toggle, hex preview for binaries.
- **Text Editor** — Multi-tab, autosave, find/replace with regex, word count
  in status bar, full-text search across all open tabs.
- **Calculator** — Basic, scientific (sin/cos/tan/log/sqrt/^), history pane,
  memory store/recall, copy result, keyboard input.
- **Browser** — Tabs with favicon, history, bookmarks, back/forward, reload,
  address-bar search, sandboxed iframe display.
- **OsPaint** — Pixel canvas, brush/pencil/eraser/fill/text/shape tools,
  color picker, color history, layer system, undo/redo, PNG export.
- **SoundWave** — Audio playback, playlist queue, shuffle/repeat, volume,
  equalizer presets, real-time visualizer, scrubbable progress bar.
- **Terminal** — `ls`, `cd`, `cat`, `mkdir`, `rm`, `mv`, `cp`, `touch`,
  `pwd`, `echo`, `grep`, `find`, `wc`, `head`, `tail`, `clear`, `history`,
  `whoami`, `date`, `uname`, `tree`, plus pipes (`|`) and redirects (`>`).
- **Settings** — Theme picker, wallpaper picker, account/sign-in, backend
  sync toggle, accessibility (animations, font size), about page.
- **ARIA** — Conversational AI panel; can answer questions, open apps,
  search the filesystem, change settings on request.
- **OsStore** — Browse, install, rate, and review additional apps; ships
  with a curated catalog.
- **OsChess** — Full FIDE-compliant move generation, minimax/alpha-beta
  search at depths 1–3, opening book, PGN export, three difficulty levels,
  AI vs AI watch mode, optional clocks (5/10/15/30 min).
- **OsTetris** — SRS rotation, wall kicks (with separate I-piece table),
  ghost piece, hold piece, 7-bag randomizer, T-spin scoring, back-to-back
  bonus, combo bonus, top-10 high score table.
- **OsMinesweeper** — Beginner (9×9·10), Intermediate (16×16·40), Expert
  (30×16·99), custom difficulty, first-click safety, flood-fill reveal,
  chord click, auto-flag on win, classic and modern skins.

---

## 🛠 Technology stack

- **HTML5** — Semantic markup, ARIA roles, keyboard accessibility.
- **CSS3** — Custom properties for theming, grid + flex layouts, animations
  with `@keyframes`, `backdrop-filter` for glassmorphism.
- **Vanilla JavaScript (ES2020+)** — No framework, no bundler. Each module
  is an IIFE that publishes a clean API on `window`.
- **Canvas 2D** — Used by OsPaint, OsTetris, and the music visualizer.
- **WebAudio API** — Music playback, equalizer, sound effects in chess and
  tetris.
- **localStorage** — Theme/preferences/recent files persistence.
- **Drag & Drop API** — File Manager and desktop file movement.
- **Python (backend)** — Flask, Flask-CORS, JWT (PyJWT), SQLite (stdlib),
  bcrypt for passwords.

No npm, no webpack, no React, no Vue, no jQuery. Everything is hand-rolled.

---

## 📂 Project structure

```
webos/
├── index.html                       # Entry point — loads everything
├── README.md                        # This file
├── CHANGELOG.md                     # Version history
│
├── css/
│   ├── themes.css                   # Theme variables (dark/light/cyberpunk/…)
│   ├── boot.css                     # Boot screen
│   ├── desktop.css                  # Desktop, wallpaper, icons
│   ├── taskbar.css                  # Taskbar pills, tray, clock
│   ├── windows.css                  # Window chrome + animations
│   ├── notifications.css            # Toast + notification center
│   └── widgets.css                  # Widget panel
│
├── js/
│   ├── themeEngine.js               # Theme manager
│   ├── fileSystem.js                # Virtual FS (window.FileSystem)
│   ├── windowManager.js             # Windows (window.WM / window.WindowManager)
│   ├── contextMenus.js              # Right-click menus (window.ContextMenu)
│   ├── taskbar.js                   # Taskbar
│   ├── startMenu.js                 # Start menu
│   ├── desktop.js                   # Desktop layer
│   ├── boot.js                      # Boot sequence (Day 7: BIOS + 8 steps)
│   ├── fileManager.js               # File Manager app
│   ├── textEditor.js                # Text Editor app
│   ├── calculator.js                # Calculator app
│   ├── browser.js                   # Browser app
│   ├── paint.js                     # OsPaint app
│   ├── musicPlayer.js               # SoundWave app
│   ├── terminal.js                  # Terminal app
│   ├── settings.js                  # Settings app
│   ├── backendSync.js               # Backend bridge (window.Backend)
│   ├── notifications.js             # Notifications (window.Notifications)
│   ├── widgets.js                   # Widgets (window.Widgets)
│   ├── aria.js                      # ARIA AI assistant
│   ├── appStore.js                  # OsStore
│   ├── chess.js                     # ★ Day 7 — OsChess
│   ├── tetris.js                    # ★ Day 7 — OsTetris
│   ├── minesweeper.js               # ★ Day 7 — OsMinesweeper
│   └── polish.js                    # ★ Day 7 — final polish layer
│
├── apps/
│   ├── fileManager/                 # File Manager UI templates
│   ├── textEditor/
│   ├── calculator/
│   ├── browser/
│   ├── paint/
│   ├── musicPlayer/
│   ├── terminal/
│   ├── settings/
│   ├── aria/
│   ├── appStore/
│   ├── chess/                       # ★ Day 7
│   ├── tetris/                      # ★ Day 7
│   └── minesweeper/                 # ★ Day 7
│
├── backend/
│   ├── server.py                    # Flask app entry
│   ├── database.py                  # SQLite layer
│   ├── auth.py                      # JWT + bcrypt
│   ├── api/
│   │   ├── filesystem.py
│   │   ├── settings.py
│   │   └── sync.py
│   ├── requirements.txt
│   └── README.md
│
└── assets/
    └── (icons, fonts cached locally if any)
```

---

## 📅 Day-by-day build log

### Day 1 — Foundation
Set up the boot screen, desktop, draggable/resizable windows, taskbar, start
menu, and theme engine. Built `windowManager.js` with full snapping +
keyboard shortcuts.

### Day 2 — Filesystem + File Manager
Implemented an in-memory virtual filesystem with persistence, a fully
featured File Manager (copy/cut/paste, search, drag-and-drop), and a
context-menu framework reused everywhere.

### Day 3 — First wave of apps
Text Editor (multi-tab, find/replace), Calculator (basic + scientific),
Browser (tabs, bookmarks, sandboxed iframes).

### Day 4 — Creative apps
OsPaint (canvas painting tool with shapes, fill, layers, undo/redo) and
SoundWave (music player with playlist, equalizer, visualizer).

### Day 5 — Power-user apps + backend
Terminal with 30+ shell commands, Settings app, Python Flask backend with
SQLite + JWT auth + filesystem sync, frontend `Backend` bridge.

### Day 6 — Intelligence + community
ARIA assistant, OsStore (app marketplace), notifications system, and
widgets (clock, calendar, weather, system monitor, sticky notes).

### Day 7 — Games + final polish
Three full games (OsChess with minimax AI, OsTetris with SRS, and
OsMinesweeper), plus a polish pass adding window-shake on maximized drag,
Alt+Tab thumbnails, Aero Peek, BIOS boot screen, percentage counter,
wallpaper parallax, taskbar clock context menu, Konami easter egg,
animated power menu, and the lock screen.

---

## 🤝 Contributing

PRs, issues, and ideas welcome. WebOS is structured so each app is a
single self-contained file that registers itself with the
`WindowManager`. To add a new app:

1. Create `apps/myApp/myApp.html` and `apps/myApp/myApp.css`.
2. Create `js/myApp.js`, do your work in an IIFE, and call
   `window.WindowManager.registerApp({ id, title, icon, render, onClose })`.
3. Add a `<script>` tag for it in `index.html` (after `windowManager.js`).
4. Pin it from the start menu, or add a desktop icon, and ship it.

If you stick to the existing API contracts (`window.FileSystem`,
`window.WindowManager`, `window.ContextMenu`, `window.Notifications`,
`window.Widgets`, `window.Backend`), your app gets file persistence,
notifications, snapping, and sync for free.

---

## 📜 License

MIT License — Copyright © 2025 WebOS Project.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
