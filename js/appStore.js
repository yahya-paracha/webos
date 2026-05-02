/* ============================================================================
 * WebOS — appStore.js
 * ----------------------------------------------------------------------------
 * OsStore — the WebOS App Store.
 *
 *   - Hardcoded catalog of 40+ apps across 7 categories
 *   - Search, category filtering, carousel, detail view, install/uninstall
 *   - Reviews, ratings, changelog, screenshots
 *   - Installed state persisted in localStorage
 *   - Installed apps appear on Desktop + Start Menu "Store Apps"
 *
 * Public API on  window.OsStore
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * Constants
   * ========================================================================*/

  const APP_ID     = "appstore";
  const APP_TITLE  = "OsStore";
  const APP_ICON   = "🛍";

  const LS_KEY_INSTALLED = "webos.osstore.installed.v1";

  const CAROUSEL_INTERVAL = 4000;
  const INSTALL_DURATION  = 2000;

  /* ==========================================================================
   * Color palettes (for icon backgrounds) — hashed from app id
   * ========================================================================*/

  const ICON_GRADIENTS = [
    ["#7c3aed", "#06b6d4"],
    ["#f59e0b", "#ef4444"],
    ["#10b981", "#06b6d4"],
    ["#ec4899", "#8b5cf6"],
    ["#3b82f6", "#8b5cf6"],
    ["#f43f5e", "#f59e0b"],
    ["#14b8a6", "#22c55e"],
    ["#a855f7", "#ec4899"],
    ["#0ea5e9", "#22d3ee"],
    ["#facc15", "#fb923c"],
    ["#6366f1", "#ec4899"],
    ["#059669", "#0d9488"],
    ["#dc2626", "#f97316"],
    ["#2563eb", "#4f46e5"],
    ["#db2777", "#7c3aed"],
    ["#16a34a", "#65a30d"],
  ];

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  function gradientFor(id) {
    const idx = hashString(id || "app") % ICON_GRADIENTS.length;
    const [a, b] = ICON_GRADIENTS[idx];
    return { from: a, to: b,
             css: `linear-gradient(135deg, ${a}, ${b})` };
  }

  function iconLetters(name) {
    if (!name) return "?";
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* ==========================================================================
   * Utilities
   * ========================================================================*/

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }

  function safeSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (_) { return false; }
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function starDisplay(rating, size) {
    const r = Math.max(0, Math.min(5, rating || 0));
    const full = Math.floor(r);
    const half = (r - full) >= 0.5;
    const empty = 5 - full - (half ? 1 : 0);
    let html = "";
    for (let i = 0; i < full; i++) html += `<span class="os-star">★</span>`;
    if (half) html += `<span class="os-star">★</span>`;
    for (let i = 0; i < empty; i++) html += `<span class="os-star empty">★</span>`;
    return html;
  }

  function formatRating(n) {
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ==========================================================================
   * Reviewers pool + changelog template helpers
   * ========================================================================*/

  const REVIEWERS = [
    "Alex M.", "Priya S.", "Jordan K.", "Lina W.", "Diego R.", "Sasha P.",
    "Hiro T.", "Emma B.", "Marcus D.", "Ava N.", "Omar F.", "Naomi L.",
    "Tao H.", "Kaito Y.", "Mira J.", "Leo V.", "Isla C.", "Sven O.",
    "Tasha B.", "Andrei K.", "Yara M.", "Ben S.", "Elena D.", "Kenji A.",
  ];

  const REVIEW_POOL = [
    { rating: 5, text: "Best app in its category. The UI is clean and it just works." },
    { rating: 5, text: "Incredibly polished. I use it daily." },
    { rating: 5, text: "Love the attention to detail. Small touches make a big difference." },
    { rating: 4, text: "Solid app with a great feature set. Minor bugs but fixed quickly." },
    { rating: 4, text: "Does exactly what it promises. Recommended." },
    { rating: 4, text: "Fast and lightweight. Wish it had dark mode though!" },
    { rating: 4, text: "Good value. Missing a couple of advanced features I'd like." },
    { rating: 3, text: "Works fine for basic use, gets tricky once you dig deeper." },
    { rating: 3, text: "Looks great but felt a bit sluggish on older browsers." },
    { rating: 5, text: "Customer support replied within hours — impressive." },
    { rating: 5, text: "Replaces three of my other tools. Huge win." },
    { rating: 4, text: "The export formats are exactly what I needed." },
    { rating: 5, text: "Thoughtful keyboard shortcuts make this a joy to use." },
    { rating: 4, text: "Really slick onboarding experience." },
    { rating: 5, text: "Just installed — the tutorials are top notch." },
  ];

  function pickReviews(seed, n) {
    const out = [];
    const base = hashString(seed || "");
    for (let i = 0; i < (n || 3); i++) {
      const rev = REVIEW_POOL[(base + i * 7) % REVIEW_POOL.length];
      const who = REVIEWERS[(base + i * 11) % REVIEWERS.length];
      const d = new Date(Date.now() - ((base + i * 31) % 90) * 86400000);
      out.push({
        reviewer: who,
        rating: rev.rating,
        text: rev.text,
        date: d.toISOString().slice(0, 10),
      });
    }
    return out;
  }

  function makeChangelog(currentVersion) {
    const v = currentVersion || "1.0.0";
    const parts = v.split(".").map((p) => parseInt(p, 10) || 0);
    const [maj, min, pat] = parts;
    const entries = [
      {
        version: v,
        date: new Date().toISOString().slice(0, 10),
        notes: "Performance improvements, bug fixes, and small UI polish.",
      },
      {
        version: [maj, Math.max(0, min), Math.max(0, pat - 1)].join("."),
        date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString().slice(0, 10),
        notes: "New keyboard shortcuts added. Improved accessibility.",
      },
      {
        version: [maj, Math.max(0, min - 1), 0].join("."),
        date: new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString().slice(0, 10),
        notes: "Major feature release with redesigned toolbar and new templates.",
      },
    ];
    return entries;
  }

  /* ==========================================================================
   * Shot palette — for fake screenshot mockups
   * ========================================================================*/

  const SHOT_PALETTES = [
    { bg: "linear-gradient(135deg, #1e293b, #334155)", label: "Main view" },
    { bg: "linear-gradient(135deg, #7c3aed, #4c1d95)", label: "Workspace" },
    { bg: "linear-gradient(135deg, #06b6d4, #0e7490)", label: "Settings" },
    { bg: "linear-gradient(135deg, #f59e0b, #b45309)", label: "Reports" },
    { bg: "linear-gradient(135deg, #10b981, #065f46)", label: "Dashboard" },
    { bg: "linear-gradient(135deg, #ef4444, #991b1b)", label: "Focus mode" },
    { bg: "linear-gradient(135deg, #8b5cf6, #5b21b6)", label: "Timeline" },
    { bg: "linear-gradient(135deg, #ec4899, #9d174d)", label: "Gallery" },
    { bg: "linear-gradient(135deg, #14b8a6, #0f766e)", label: "Analytics" },
    { bg: "linear-gradient(135deg, #f43f5e, #be123c)", label: "Inbox" },
  ];

  function pickShots(seed, n) {
    const base = hashString(seed || "");
    const picks = [];
    for (let i = 0; i < (n || 3); i++) {
      const p = SHOT_PALETTES[(base + i * 13) % SHOT_PALETTES.length];
      picks.push(p);
    }
    return picks;
  }

  /* ==========================================================================
   * Catalog — 40+ apps across 7 categories
   * ========================================================================*/

  function makeApp(overrides) {
    const id    = overrides.id;
    const name  = overrides.name || id;
    const dev   = overrides.developer || "WebOS Labs";
    const cat   = overrides.category || "Utilities";
    const ver   = overrides.version || "1.0.0";
    const size  = overrides.size || (Math.round((Math.random() * 18 + 3) * 10) * 1024);
    const rat   = overrides.rating || (Math.round((Math.random() * 1.5 + 3.5) * 10) / 10);
    const rCnt  = overrides.ratingCount || Math.floor(Math.random() * 8000 + 200);
    return Object.assign({
      id, name, developer: dev, category: cat, version: ver,
      size, rating: rat, ratingCount: rCnt,
      description: overrides.description || "A great WebOS application.",
      longDescription: overrides.longDescription ||
        "This app brings a polished experience to WebOS. Enjoy a refined " +
        "interface, thoughtful defaults, and smooth performance across " +
        "every theme.",
      screenshots: pickShots(id, 3),
      reviews: pickReviews(id, 3),
      changelog: makeChangelog(ver),
      tags: overrides.tags || [],
      featured: !!overrides.featured,
      installed: false,
      icon: overrides.icon || null,
      emoji: overrides.emoji || null,
    }, overrides);
  }

  const CATEGORIES = [
    { id: "All",          label: "All",          icon: "▦" },
    { id: "Productivity", label: "Productivity", icon: "📋" },
    { id: "Media",        label: "Media",        icon: "🎬" },
    { id: "Games",        label: "Games",        icon: "🎮" },
    { id: "Developer",    label: "Developer",    icon: "⌨" },
    { id: "Utilities",    label: "Utilities",    icon: "🛠" },
    { id: "Education",    label: "Education",    icon: "🎓" },
    { id: "Creative",     label: "Creative",     icon: "🎨" },
  ];

  const CATALOG = [
    /* -------------------- Productivity (8) -------------------- */
    makeApp({
      id: "pronotes", name: "ProNotes", developer: "Ink & Paper",
      category: "Productivity", version: "3.2.1", emoji: "📓",
      description: "Structured notes with backlinks and markdown.",
      longDescription: "ProNotes is a modern note-taking app with bi-directional links, nested folders, powerful full-text search, and a distraction-free writing mode. Export to Markdown, PDF, or HTML.",
      tags: ["notes","writing","markdown","pkm"],
      featured: true,
      rating: 4.8, ratingCount: 12430,
      size: 4.8 * 1024 * 1024,
    }),
    makeApp({
      id: "timetracker", name: "TimeTracker", developer: "Chronos Co.",
      category: "Productivity", version: "2.4.0", emoji: "⏱",
      description: "Track billable hours and project time effortlessly.",
      longDescription: "TimeTracker helps freelancers and small teams track time per project, generate client reports, and bill accurately. Includes timers, tags, and exports to CSV.",
      tags: ["time","tracking","productivity","billing"],
      rating: 4.5, ratingCount: 3840,
    }),
    makeApp({
      id: "focustimer", name: "FocusTimer", developer: "Pomodoro Labs",
      category: "Productivity", version: "1.8.2", emoji: "🎯",
      description: "Pomodoro timer with smart break suggestions.",
      longDescription: "Enter deep work with beautifully designed Pomodoro cycles, focus music, ambient sounds, and daily goal tracking.",
      tags: ["pomodoro","focus","timer","study"],
      rating: 4.7, ratingCount: 5620,
    }),
    makeApp({
      id: "kanbanboard", name: "KanbanBoard", developer: "Flow Systems",
      category: "Productivity", version: "4.0.0", emoji: "📊",
      description: "Beautiful kanban boards with drag-drop cards.",
      longDescription: "Plan projects visually with customizable columns, WIP limits, swimlanes, and team assignments.",
      tags: ["kanban","tasks","project","agile"],
      featured: true,
      rating: 4.6, ratingCount: 9210,
    }),
    makeApp({
      id: "spreadsheetlite", name: "SpreadsheetLite", developer: "GridWorks",
      category: "Productivity", version: "2.1.0", emoji: "📈",
      description: "Fast, local spreadsheets with formulas and charts.",
      longDescription: "A lightweight spreadsheet app with 120+ formulas, charts, pivot tables, and CSV import/export. No cloud, your data stays on-device.",
      tags: ["spreadsheet","csv","charts","formulas"],
      rating: 4.3, ratingCount: 2140,
    }),
    makeApp({
      id: "pdfviewer", name: "PdfViewer", developer: "Paper Systems",
      category: "Productivity", version: "1.6.4", emoji: "📄",
      description: "Smooth PDF reading with annotations.",
      longDescription: "Highlight, underline, add comments, and organize PDFs with multi-tab browsing and bookmark sync.",
      tags: ["pdf","reader","annotations"],
      rating: 4.4, ratingCount: 1830,
    }),
    makeApp({
      id: "markdownpad", name: "MarkdownPad", developer: "Quill Studios",
      category: "Productivity", version: "2.0.3", emoji: "✍",
      description: "Split-pane markdown editor with live preview.",
      longDescription: "Write in Markdown and see a live HTML preview side-by-side. Supports tables, footnotes, math, and mermaid diagrams.",
      tags: ["markdown","editor","writer"],
      rating: 4.7, ratingCount: 4310,
    }),
    makeApp({
      id: "mindmapper", name: "MindMapper", developer: "Branch Ideas",
      category: "Productivity", version: "3.0.0", emoji: "🧠",
      description: "Visual mind maps for brainstorming.",
      longDescription: "Capture and organize ideas with a smooth, infinite canvas. Styles, icons, relationships, and PNG/SVG export.",
      tags: ["mindmap","brainstorm","diagram"],
      rating: 4.5, ratingCount: 2980,
    }),

    /* -------------------- Media (6) -------------------- */
    makeApp({
      id: "videoplayer", name: "VideoPlayer", developer: "ReelCore",
      category: "Media", version: "5.2.1", emoji: "🎞",
      description: "Play almost any video with subtitles & playlists.",
      longDescription: "Hardware-accelerated playback, subtitle support (SRT/VTT), playback speed, and a clean mini-player mode.",
      tags: ["video","player","media"],
      featured: true,
      rating: 4.6, ratingCount: 18210,
    }),
    makeApp({
      id: "photoviewer", name: "PhotoViewer", developer: "Aperture Co.",
      category: "Media", version: "4.1.0", emoji: "🖼",
      description: "Beautiful photo browser with EXIF & slideshow.",
      longDescription: "Browse thousands of photos smoothly. View EXIF, organize by date, auto-slideshow, and one-click basic edits.",
      tags: ["photos","gallery","exif"],
      rating: 4.4, ratingCount: 6710,
    }),
    makeApp({
      id: "podcastapp", name: "PodcastApp", developer: "AudioWave",
      category: "Media", version: "2.8.0", emoji: "🎙",
      description: "Discover and subscribe to your favorite podcasts.",
      longDescription: "Search millions of podcasts, subscribe, and get smart new-episode notifications. Queue, playback speed, and sleep timer.",
      tags: ["podcast","audio","subscribe"],
      rating: 4.5, ratingCount: 8920,
    }),
    makeApp({
      id: "screenrecorder", name: "ScreenRecorder", developer: "Capture Inc.",
      category: "Media", version: "1.5.0", emoji: "🎥",
      description: "Record your screen with audio and webcam overlay.",
      longDescription: "Crystal-clear screen recordings in up to 4K, mic + system audio, webcam overlay, and GIF export.",
      tags: ["screen","record","video","capture"],
      rating: 4.3, ratingCount: 2340,
    }),
    makeApp({
      id: "gifmaker", name: "GifMaker", developer: "LoopCraft",
      category: "Media", version: "2.0.1", emoji: "🎞",
      description: "Convert videos and images into polished GIFs.",
      longDescription: "Fine-tune frame rate, dimensions, palette, and text overlays. Optimize file size without sacrificing quality.",
      tags: ["gif","animation","video"],
      rating: 4.6, ratingCount: 3430,
    }),
    makeApp({
      id: "colorpicker", name: "ColorPicker", developer: "Hue Works",
      category: "Media", version: "1.3.0", emoji: "🎨",
      description: "Pick, inspect, and convert colors across formats.",
      longDescription: "Eye-dropper, full-screen magnifier, HEX/RGB/HSL/OKLCH conversion, and a palette history that syncs across apps.",
      tags: ["color","design","picker"],
      rating: 4.7, ratingCount: 5010,
    }),

    /* -------------------- Games (8) -------------------- */
    makeApp({
      id: "chess", name: "Chess", developer: "Knight Moves",
      category: "Games", version: "3.4.0", emoji: "♞",
      description: "Play against an adaptive AI or online friends.",
      longDescription: "Beautiful, modern chess with multiple AI strength levels, puzzles, and openings explorer.",
      tags: ["chess","strategy","board"],
      featured: true,
      rating: 4.8, ratingCount: 24310,
    }),
    makeApp({
      id: "tetris", name: "Tetris", developer: "Block Party",
      category: "Games", version: "1.9.0", emoji: "🧩",
      description: "Classic block-stacker with modern marathon mode.",
      longDescription: "Relive the classic with crisp visuals, multiple modes (Marathon, Sprint, Ultra), and local leaderboards.",
      tags: ["tetris","puzzle","arcade"],
      rating: 4.7, ratingCount: 15290,
    }),
    makeApp({
      id: "sudoku", name: "Sudoku", developer: "9x9 Studios",
      category: "Games", version: "2.1.2", emoji: "🔢",
      description: "Beautifully presented sudoku with difficulty levels.",
      longDescription: "Thousands of hand-generated puzzles across five difficulty tiers, with notes, hints, and daily challenges.",
      tags: ["sudoku","logic","puzzle"],
      rating: 4.6, ratingCount: 9010,
    }),
    makeApp({
      id: "2048", name: "2048", developer: "Swipe Labs",
      category: "Games", version: "1.5.0", emoji: "2⃣",
      description: "The addictive number-merging puzzle.",
      longDescription: "Combine tiles to reach 2048 — and beyond. Undo, themes, and online leaderboards.",
      tags: ["2048","puzzle","numbers"],
      rating: 4.5, ratingCount: 12400,
    }),
    makeApp({
      id: "typinggame", name: "TypingGame", developer: "KeyMaster",
      category: "Games", version: "3.0.1", emoji: "⌨",
      description: "Improve your typing speed with fun challenges.",
      longDescription: "Race-style typing games, WPM tracking, lesson plans, and competitive modes.",
      tags: ["typing","education","speed"],
      rating: 4.4, ratingCount: 2870,
    }),
    makeApp({
      id: "wordsearch", name: "WordSearch", developer: "Lex Games",
      category: "Games", version: "2.2.0", emoji: "🔡",
      description: "Classic word-find puzzles with daily packs.",
      longDescription: "Themed word-search puzzles with an unlimited generator and dictionary support in 8 languages.",
      tags: ["words","puzzle","daily"],
      rating: 4.3, ratingCount: 1920,
    }),
    makeApp({
      id: "solitaire", name: "Solitaire", developer: "Ace Studios",
      category: "Games", version: "4.1.0", emoji: "🂡",
      description: "Klondike, Spider, FreeCell and more.",
      longDescription: "Polished solitaire suite with statistics, achievements, and a clean, relaxing interface.",
      tags: ["solitaire","cards","klondike"],
      rating: 4.7, ratingCount: 8830,
    }),
    makeApp({
      id: "pong", name: "Pong", developer: "Retro Revival",
      category: "Games", version: "1.2.0", emoji: "🏓",
      description: "The original arcade classic, reimagined.",
      longDescription: "Pong with split-screen multiplayer, adjustable AI, and CRT filter for that authentic retro feel.",
      tags: ["pong","arcade","retro"],
      rating: 4.2, ratingCount: 1350,
    }),

    /* -------------------- Developer (6) -------------------- */
    makeApp({
      id: "jsonformatter", name: "JsonFormatter", developer: "DevTools Inc.",
      category: "Developer", version: "2.0.0", emoji: "{}",
      description: "Pretty-print, validate, and diff JSON.",
      longDescription: "Format, validate, and visualize large JSON with a collapsible tree view, diff mode, and schema linting.",
      tags: ["json","format","dev","validator"],
      rating: 4.7, ratingCount: 5410,
    }),
    makeApp({
      id: "regextester", name: "RegexTester", developer: "Pattern Labs",
      category: "Developer", version: "3.2.1", emoji: "⌖",
      description: "Live regex playground with capture groups.",
      longDescription: "Debug regular expressions with instant match highlighting, capture groups, and cheat-sheet snippets.",
      tags: ["regex","regexp","dev"],
      rating: 4.8, ratingCount: 7210,
    }),
    makeApp({
      id: "colorpalette", name: "ColorPalette", developer: "Palette Co.",
      category: "Developer", version: "1.4.2", emoji: "🎨",
      description: "Generate and export color palettes for code.",
      longDescription: "Create harmonious palettes, extract colors from images, and export as CSS variables, Tailwind configs, or JSON.",
      tags: ["color","design","css"],
      featured: true,
      rating: 4.6, ratingCount: 3290,
    }),
    makeApp({
      id: "base64tool", name: "Base64Tool", developer: "Encode Co.",
      category: "Developer", version: "1.2.0", emoji: "🔤",
      description: "Encode and decode Base64 / URL / Hex.",
      longDescription: "Fast, offline encoding tools for Base64, URL, Hex, and JWT with a drag-and-drop file mode.",
      tags: ["encode","decode","base64","jwt"],
      rating: 4.5, ratingCount: 1810,
    }),
    makeApp({
      id: "httptester", name: "HttpTester", developer: "Curl Systems",
      category: "Developer", version: "2.3.0", emoji: "🌐",
      description: "Send requests, inspect responses, save collections.",
      longDescription: "A Postman-lite experience with request history, environment variables, and auto-generated cURL commands.",
      tags: ["http","api","curl","rest"],
      rating: 4.6, ratingCount: 4020,
    }),
    makeApp({
      id: "diffviewer", name: "DiffViewer", developer: "Sidebar Co.",
      category: "Developer", version: "1.1.0", emoji: "⇄",
      description: "Compare files side-by-side with syntax highlighting.",
      longDescription: "Line-by-line and word-by-word diffs, three-way merge, and support for 50+ languages.",
      tags: ["diff","compare","merge"],
      rating: 4.4, ratingCount: 1420,
    }),

    /* -------------------- Utilities (6) -------------------- */
    makeApp({
      id: "clipboardmanager", name: "ClipboardManager", developer: "Pastel",
      category: "Utilities", version: "2.6.0", emoji: "📋",
      description: "History of everything you've copied.",
      longDescription: "Access your clipboard history with search, pinned items, and sensitive-data filters.",
      tags: ["clipboard","utility","history"],
      rating: 4.6, ratingCount: 3870,
    }),
    makeApp({
      id: "systeminfo", name: "SystemInfo", developer: "Meta Tools",
      category: "Utilities", version: "1.8.0", emoji: "ℹ",
      description: "Inspect your WebOS environment at a glance.",
      longDescription: "CPU, memory, storage, browser features, and installed app inventory — all in one friendly dashboard.",
      tags: ["system","info","diagnostics"],
      rating: 4.5, ratingCount: 2110,
    }),
    makeApp({
      id: "networkmonitor", name: "NetworkMonitor", developer: "Packet Co.",
      category: "Utilities", version: "3.0.0", emoji: "📡",
      description: "Visualize network usage in real time.",
      longDescription: "Real-time graphs of network in/out, per-app breakdowns, and simulated latency tests.",
      tags: ["network","monitor","utility"],
      rating: 4.3, ratingCount: 1540,
    }),
    makeApp({
      id: "diskanalyzer", name: "DiskAnalyzer", developer: "Storage Labs",
      category: "Utilities", version: "2.1.0", emoji: "💽",
      description: "Find what's taking up space with a sunburst chart.",
      longDescription: "Beautiful sunburst and treemap visualizations help you reclaim disk space quickly.",
      tags: ["disk","storage","cleanup"],
      rating: 4.7, ratingCount: 6150,
    }),
    makeApp({
      id: "startupmanager", name: "StartupManager", developer: "BootWorks",
      category: "Utilities", version: "1.3.0", emoji: "⚡",
      description: "Control which apps launch at boot.",
      longDescription: "Toggle startup apps, see impact scores, and keep your WebOS boot time lightning fast.",
      tags: ["startup","boot","performance"],
      rating: 4.4, ratingCount: 1210,
    }),
    makeApp({
      id: "processkiller", name: "ProcessKiller", developer: "Axe Co.",
      category: "Utilities", version: "1.5.0", emoji: "🪓",
      description: "Manage running apps and free up resources.",
      longDescription: "See CPU/RAM impact per window, close runaway apps, and set up auto-kill rules for misbehaving processes.",
      tags: ["process","manager","kill"],
      rating: 4.2, ratingCount: 980,
    }),

    /* -------------------- Education (3) -------------------- */
    makeApp({
      id: "periodictable", name: "PeriodicTable", developer: "EduMatter",
      category: "Education", version: "2.2.1", emoji: "⚗",
      description: "Interactive periodic table with element details.",
      longDescription: "Explore every element with properties, discoveries, isotopes, and 3D electron configurations.",
      tags: ["chemistry","education","elements"],
      rating: 4.8, ratingCount: 4410,
    }),
    makeApp({
      id: "worldmap", name: "WorldMap", developer: "Atlas Studios",
      category: "Education", version: "3.1.0", emoji: "🗺",
      description: "Explore countries, capitals, and geography.",
      longDescription: "Interactive world map with country quizzes, fact cards, and historical borders over time.",
      tags: ["geography","education","map"],
      rating: 4.6, ratingCount: 2910,
    }),
    makeApp({
      id: "mathtrainer", name: "MathTrainer", developer: "NumeraCo",
      category: "Education", version: "1.7.0", emoji: "➗",
      description: "Practice mental math with adaptive difficulty.",
      longDescription: "Quick-fire arithmetic drills across addition, subtraction, multiplication, division, and more.",
      tags: ["math","education","practice"],
      rating: 4.5, ratingCount: 1830,
    }),

    /* -------------------- Creative (3) -------------------- */
    makeApp({
      id: "pixelarteditor", name: "PixelArtEditor", developer: "Byte Canvas",
      category: "Creative", version: "2.0.0", emoji: "🖌",
      description: "Draw pixel-perfect sprites and animations.",
      longDescription: "Per-pixel drawing with animation frames, palette management, onion skins, and GIF export.",
      tags: ["pixel","art","creative","sprites"],
      rating: 4.7, ratingCount: 3220,
    }),
    makeApp({
      id: "fontviewer", name: "FontViewer", developer: "Glyph Works",
      category: "Creative", version: "1.3.2", emoji: "𝒜",
      description: "Preview, compare, and pair fonts.",
      longDescription: "Browse installed fonts, try them with your text, and discover harmonious pairings for your next project.",
      tags: ["fonts","typography","design"],
      rating: 4.4, ratingCount: 1080,
    }),
    makeApp({
      id: "iconpack", name: "IconPack", developer: "Pictograph Co.",
      category: "Creative", version: "4.0.1", emoji: "✨",
      description: "Thousands of icons, one click to copy or export.",
      longDescription: "Search across 10,000+ icons, adjust stroke, color, and size, and export as SVG or PNG.",
      tags: ["icons","design","svg"],
      featured: true,
      rating: 4.8, ratingCount: 9320,
    }),
  ];

  /* ==========================================================================
   * Installed state
   * ========================================================================*/

  function loadInstalled() {
    const raw = safeGet(LS_KEY_INSTALLED, {});
    if (!raw || typeof raw !== "object") return {};
    return raw;
  }

  function saveInstalled(map) {
    safeSet(LS_KEY_INSTALLED, map || {});
  }

  function isInstalled(id) {
    const m = loadInstalled();
    return !!(m && m[id]);
  }

  function markInstalled(id, installedAt) {
    const m = loadInstalled();
    m[id] = { installedAt: installedAt || Date.now() };
    saveInstalled(m);
  }

  function markUninstalled(id) {
    const m = loadInstalled();
    delete m[id];
    saveInstalled(m);
  }

  function getInstalledList() {
    const m = loadInstalled();
    return Object.keys(m)
      .map((id) => CATALOG.find((a) => a.id === id))
      .filter(Boolean);
  }

  /* ==========================================================================
   * Catalog queries
   * ========================================================================*/

  function getCatalog() {
    return CATALOG.slice();
  }

  function getApp(id) {
    return CATALOG.find((a) => a.id === id) || null;
  }

  function getByCategory(category) {
    if (!category || category === "All") return CATALOG.slice();
    return CATALOG.filter((a) => a.category === category);
  }

  function searchCatalog(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return CATALOG.slice();
    return CATALOG.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.developer.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      (a.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  function topFreeCharts(limit) {
    return CATALOG.slice()
      .sort((a, b) => b.ratingCount - a.ratingCount)
      .slice(0, limit || 5);
  }

  function topRatedCharts(limit) {
    return CATALOG.slice()
      .sort((a, b) => (b.rating - a.rating) || (b.ratingCount - a.ratingCount))
      .slice(0, limit || 5);
  }

  function recentReleases(limit) {
    // Using "changelog[0].date" heuristically
    return CATALOG.slice()
      .sort((a, b) => {
        const da = new Date(a.changelog[0].date).getTime();
        const db = new Date(b.changelog[0].date).getTime();
        return db - da;
      })
      .slice(0, limit || 5);
  }

  function featuredApps() {
    return CATALOG.filter((a) => a.featured);
  }

  /* ==========================================================================
   * Install / uninstall flows (global, usable via window.OsStore)
   * ========================================================================*/

  const installListeners = new Set();

  function emit(name, detail) {
    installListeners.forEach((fn) => {
      try { fn(name, detail); } catch (e) { console.error(e); }
    });
    try {
      document.dispatchEvent(new CustomEvent("webos:osstore:" + name, { detail }));
    } catch (_) {}
  }

  function on(fn) {
    if (typeof fn !== "function") return () => {};
    installListeners.add(fn);
    return () => installListeners.delete(fn);
  }

  async function installApp(id, opts) {
    const app = getApp(id);
    if (!app) return { ok: false, error: "Unknown app" };
    if (isInstalled(id)) return { ok: true, alreadyInstalled: true };

    // Simulate progress
    emit("install-start", { id });
    await delay(opts && opts.quick ? 100 : INSTALL_DURATION);
    markInstalled(id);

    // Create Desktop shortcut + Start Menu entry
    placeAppOnDesktop(app);
    registerAppInStartMenu(app);

    emit("install-complete", { id });

    // Global notification
    if (window.AppStoreNotify && window.AppStoreNotify.installed) {
      window.AppStoreNotify.installed(app.name);
    } else if (window.Notifications) {
      window.Notifications.success(
        "App installed",
        app.name + " is ready to use.",
        { appName: "OsStore", appIcon: APP_ICON, duration: 3200 }
      );
    }
    return { ok: true };
  }

  function uninstallApp(id) {
    const app = getApp(id);
    if (!app) return { ok: false, error: "Unknown app" };
    if (!isInstalled(id)) return { ok: true, notInstalled: true };
    markUninstalled(id);
    removeAppFromDesktop(app);
    unregisterAppFromStartMenu(app);
    emit("uninstall", { id });

    if (window.AppStoreNotify && window.AppStoreNotify.uninstalled) {
      window.AppStoreNotify.uninstalled(app.name);
    } else if (window.Notifications) {
      window.Notifications.neutral(
        "App removed",
        app.name + " has been uninstalled.",
        { appName: "OsStore", appIcon: APP_ICON, duration: 2500 }
      );
    }
    return { ok: true };
  }

  /* ==========================================================================
   * Desktop / Start Menu integration
   * ========================================================================*/

  function placeAppOnDesktop(app) {
    if (!window.FileSystem) return;
    try {
      const base = "/Desktop";
      if (!window.FileSystem.exists(base)) {
        window.FileSystem.createFolder(base, { recursive: true });
      }
      // Create a small shortcut file the desktop reads as an icon
      const path = base + "/" + app.name + ".app";
      if (!window.FileSystem.exists(path)) {
        window.FileSystem.writeFile(path, JSON.stringify({
          type: "shortcut",
          appId: "osstore-app-" + app.id,
          launch: "osstore",
          launchArgs: { appId: app.id },
          name: app.name,
          icon: app.emoji || "▦",
        }, null, 2), {
          kind: "text",
          mime: "application/x-webos-shortcut",
          icon: app.emoji || "▦",
        });
      }
      if (window.Desktop && typeof window.Desktop.syncFromFs === "function") {
        window.Desktop.syncFromFs();
      }
    } catch (e) {
      console.warn("[OsStore] placeAppOnDesktop:", e);
    }
  }

  function removeAppFromDesktop(app) {
    if (!window.FileSystem) return;
    try {
      const path = "/Desktop/" + app.name + ".app";
      if (window.FileSystem.exists(path)) {
        window.FileSystem.deleteFile(path, { permanent: true });
      }
      if (window.Desktop && typeof window.Desktop.syncFromFs === "function") {
        window.Desktop.syncFromFs();
      }
    } catch (_) {}
  }

  function registerAppInStartMenu(app) {
    const wm = window.WindowManager;
    if (!wm || !wm.registerApp) return;
    const id = "osstore-app-" + app.id;
    if (wm.getApp && wm.getApp(id)) return; // already registered
    wm.registerApp({
      id,
      title: app.name,
      icon: app.emoji || "▦",
      width: 640,
      height: 440,
      category: "Store Apps",
      pinned: false,
      render(body, win) {
        body.innerHTML = renderStubForApp(app);
        const btn = body.querySelector("[data-open-appstore]");
        if (btn) {
          btn.addEventListener("click", () => {
            if (window.WindowManager && window.WindowManager.openApp) {
              window.WindowManager.openApp(APP_ID, { showDetail: app.id });
            }
          });
        }
      },
    });
  }

  function unregisterAppFromStartMenu(app) {
    const wm = window.WindowManager;
    if (!wm || !wm.unregisterApp) return;
    const id = "osstore-app-" + app.id;
    try { wm.unregisterApp(id); } catch (_) {}
  }

  function renderStubForApp(app) {
    const grad = gradientFor(app.id);
    const emoji = app.emoji || iconLetters(app.name);
    return `
      <div style="
        height:100%;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:16px;padding:40px;text-align:center;
        color:var(--text,#e6e9f2);font-family:var(--font-ui,Inter,sans-serif);
      ">
        <div style="
          width:96px;height:96px;border-radius:22px;
          background:${grad.css};
          display:flex;align-items:center;justify-content:center;
          font-size:44px;color:white;font-weight:700;
          box-shadow:0 12px 36px rgba(0,0,0,.35);
        ">${escapeHtml(emoji)}</div>
        <h2 style="margin:0;font-size:22px;letter-spacing:-.02em;">${escapeHtml(app.name)}</h2>
        <div style="font-size:12px;color:rgba(230,233,242,.65);">
          by ${escapeHtml(app.developer)} · v${escapeHtml(app.version)}
        </div>
        <p style="max-width:420px;font-size:13px;line-height:1.55;color:rgba(230,233,242,.75);margin:4px 0;">
          ${escapeHtml(app.longDescription)}
        </p>
        <button data-open-appstore style="
          appearance:none;border:none;cursor:pointer;
          background:linear-gradient(135deg,#7c3aed,#06b6d4);color:white;
          padding:8px 16px;border-radius:10px;font-size:12.5px;font-weight:600;
          font-family:inherit;
        ">Open in OsStore</button>
        <div style="font-size:10.5px;color:rgba(230,233,242,.45);margin-top:8px;">
          This is a demo stub. The full ${escapeHtml(app.name)} experience is not yet bundled.
        </div>
      </div>
    `;
  }

  function restoreInstalledApps() {
    // On boot, re-register installed apps in the Start Menu so they survive page reloads.
    const installed = getInstalledList();
    installed.forEach((app) => {
      registerAppInStartMenu(app);
    });
  }

  /* ==========================================================================
   * Main app class (UI)
   * ========================================================================*/

  class AppStoreApp {
    constructor(body, win, opts) {
      this.body = body;
      this.win  = win;
      this.opts = opts || {};
      this.refs = {};
      this.currentCategory = "All";
      this.currentQuery    = "";
      this.carouselIndex   = 0;
      this.carouselTimer   = null;
      this.carouselPaused  = false;
      this.detailId        = null;
      this.sortedView      = null;
    }

    mount() {
      const tmpl = document.getElementById("appstore-app-template");
      let html;
      if (tmpl) html = tmpl.innerHTML;
      else html = this._embeddedTemplate();
      this.body.innerHTML = html;

      this._ensureStyle();
      this._collectRefs();

      this._renderPills();
      this._renderHero();
      this._renderGrid();
      this._renderCharts();
      this._updateInstalledCount();
      this._wireSearch();
      this._wireHero();
      this._wireGrid();
      this._wireInstalledBtn();
      this._wireRefreshBtn();
      this._startCarousel();

      // External install events keep our UI in sync
      this._unsubEvents = on((name) => {
        if (name === "install-complete" || name === "uninstall") {
          this._renderGrid();
          this._renderCharts();
          this._updateInstalledCount();
          if (this.detailId) this._renderDetail();
        }
      });

      // If launched with a specific app to show, open its detail
      if (this.opts.showDetail) {
        setTimeout(() => this._openDetail(this.opts.showDetail), 150);
      }
    }

    destroy() {
      this._stopCarousel();
      if (this._unsubEvents) this._unsubEvents();
    }

    _ensureStyle() {
      if (document.getElementById("appstore-inline-css-loader")) return;
      const link = document.createElement("link");
      link.id = "appstore-inline-css-loader";
      link.rel = "stylesheet";
      link.href = "apps/appStore/appStore.css";
      document.head.appendChild(link);
    }

    _collectRefs() {
      this.body.querySelectorAll("[data-ref]").forEach((el) => {
        this.refs[el.getAttribute("data-ref")] = el;
      });
      this.rootEl = this.body.querySelector(".os-root");
    }

    _embeddedTemplate() {
      return `<div class="os-root"><div style="padding:40px;">OsStore template missing.</div></div>`;
    }

    /* ==================================================================
     * Pills
     * ================================================================*/
    _renderPills() {
      const pillsEl = this.refs.pills;
      if (!pillsEl) return;
      pillsEl.innerHTML = CATEGORIES.map((c) => {
        const count = c.id === "All"
          ? CATALOG.length
          : CATALOG.filter((a) => a.category === c.id).length;
        return `
          <button class="os-pill ${c.id === this.currentCategory ? "active" : ""}"
                  data-cat="${escapeHtml(c.id)}">
            <span>${escapeHtml(c.icon)}</span>
            <span>${escapeHtml(c.label)}</span>
            <span class="os-pill-count">${count}</span>
          </button>
        `;
      }).join("");

      pillsEl.addEventListener("click", (e) => {
        const b = e.target.closest(".os-pill");
        if (!b) return;
        const cat = b.getAttribute("data-cat");
        this.currentCategory = cat;
        this.sortedView = null;
        this._renderPills();
        this._renderGrid();
      });
    }

    /* ==================================================================
     * Hero carousel
     * ================================================================*/
    _renderHero() {
      const slidesEl = this.refs.heroSlides;
      const dotsEl   = this.refs.heroDots;
      if (!slidesEl || !dotsEl) return;
      const featured = featuredApps().slice(0, 5);
      if (featured.length === 0) {
        slidesEl.innerHTML = `<div style="padding:24px;">No featured apps right now.</div>`;
        return;
      }

      slidesEl.innerHTML = featured.map((app, i) => {
        const grad = gradientFor(app.id);
        const emoji = app.emoji || iconLetters(app.name);
        const installed = isInstalled(app.id);
        const bg = `background:linear-gradient(135deg, ${grad.from}ee, ${grad.to}ee);`;
        return `
          <div class="os-hero-slide ${i === 0 ? "active" : ""}" data-id="${escapeHtml(app.id)}" style="${bg}">
            <div class="os-hero-art" style="background:${grad.css};">
              ${escapeHtml(emoji)}
            </div>
            <div class="os-hero-text">
              <div class="os-hero-category">${escapeHtml(app.category)}</div>
              <h3 class="os-hero-title">${escapeHtml(app.name)}</h3>
              <p class="os-hero-tagline">${escapeHtml(app.longDescription)}</p>
              <div class="os-hero-actions">
                <button class="os-btn primary" data-hero-install="${escapeHtml(app.id)}" ${installed ? "disabled" : ""}>
                  ${installed ? "Installed ✓" : "Install"}
                </button>
                <button class="os-btn" data-hero-detail="${escapeHtml(app.id)}">
                  Learn more
                </button>
                <span class="os-btn-sub">${formatRating(app.rating)} ★ · ${app.ratingCount.toLocaleString()} ratings</span>
              </div>
            </div>
          </div>
        `;
      }).join("");

      dotsEl.innerHTML = featured.map((_, i) =>
        `<button class="os-hero-dot ${i === 0 ? "active" : ""}" data-dot="${i}" aria-label="Go to slide ${i + 1}"></button>`
      ).join("");

      this.heroCount = featured.length;
      this.carouselIndex = 0;
    }

    _wireHero() {
      const { hero, heroPrev, heroNext, heroDots, heroSlides } = this.refs;
      if (!hero) return;

      if (heroPrev) heroPrev.addEventListener("click", () => this._advanceCarousel(-1));
      if (heroNext) heroNext.addEventListener("click", () => this._advanceCarousel(1));
      if (heroDots) {
        heroDots.addEventListener("click", (e) => {
          const d = e.target.closest(".os-hero-dot");
          if (!d) return;
          const i = parseInt(d.getAttribute("data-dot"), 10);
          this._setCarousel(i);
        });
      }
      hero.addEventListener("mouseenter", () => { this.carouselPaused = true; });
      hero.addEventListener("mouseleave", () => { this.carouselPaused = false; });

      if (heroSlides) {
        heroSlides.addEventListener("click", (e) => {
          const inst = e.target.closest("[data-hero-install]");
          if (inst) {
            e.stopPropagation();
            const id = inst.getAttribute("data-hero-install");
            this._installFlow(id, inst);
            return;
          }
          const det = e.target.closest("[data-hero-detail]");
          if (det) {
            e.stopPropagation();
            const id = det.getAttribute("data-hero-detail");
            this._openDetail(id);
            return;
          }
          const slide = e.target.closest(".os-hero-slide");
          if (slide) {
            const id = slide.getAttribute("data-id");
            if (id) this._openDetail(id);
          }
        });
      }
    }

    _advanceCarousel(delta) {
      if (!this.heroCount) return;
      let i = this.carouselIndex + delta;
      if (i < 0) i = this.heroCount - 1;
      if (i >= this.heroCount) i = 0;
      this._setCarousel(i);
    }

    _setCarousel(i) {
      if (!this.refs.heroSlides) return;
      const slides = this.refs.heroSlides.querySelectorAll(".os-hero-slide");
      const dots   = this.refs.heroDots.querySelectorAll(".os-hero-dot");
      slides.forEach((s, idx) => s.classList.toggle("active", idx === i));
      dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
      this.carouselIndex = i;
    }

    _startCarousel() {
      if (this.carouselTimer) clearInterval(this.carouselTimer);
      this.carouselTimer = setInterval(() => {
        if (this.carouselPaused) return;
        this._advanceCarousel(1);
      }, CAROUSEL_INTERVAL);
    }

    _stopCarousel() {
      if (this.carouselTimer) {
        clearInterval(this.carouselTimer);
        this.carouselTimer = null;
      }
    }

    /* ==================================================================
     * Grid / cards
     * ================================================================*/
    _filteredList() {
      let list;
      if (this.sortedView === "installed") {
        list = getInstalledList();
      } else {
        list = getByCategory(this.currentCategory);
      }
      if (this.currentQuery) {
        const q = this.currentQuery.toLowerCase();
        list = list.filter((a) =>
          a.name.toLowerCase().includes(q) ||
          a.developer.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          (a.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      }
      return list;
    }

    _renderGrid() {
      const grid = this.refs.grid;
      const empty = this.refs.gridEmpty;
      const title = this.refs.gridTitle;
      const sub = this.refs.gridSub;
      if (!grid) return;

      const list = this._filteredList();

      // Title
      if (title) {
        if (this.sortedView === "installed") {
          title.textContent = "My Apps";
          if (sub) sub.textContent = list.length > 0
            ? list.length + " installed"
            : "No installed apps yet";
        } else if (this.currentQuery) {
          title.textContent = "Results for “" + this.currentQuery + "”";
          if (sub) sub.textContent = list.length + " apps";
        } else if (this.currentCategory && this.currentCategory !== "All") {
          title.textContent = this.currentCategory;
          if (sub) sub.textContent = list.length + " apps in this category";
        } else {
          title.textContent = "Discover";
          if (sub) sub.textContent = "Hand-picked apps for every workflow";
        }
      }

      if (list.length === 0) {
        grid.innerHTML = "";
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;

      grid.innerHTML = list.map((a) => this._cardHtml(a)).join("");
    }

    _cardHtml(app) {
      const grad = gradientFor(app.id);
      const installed = isInstalled(app.id);
      const emoji = app.emoji || iconLetters(app.name);
      return `
        <div class="os-card ${installed ? "installed-flag" : ""} ${app.featured ? "featured" : ""}"
             data-id="${escapeHtml(app.id)}">
          <div class="os-card-top">
            <div class="os-icon" style="background:${grad.css};">
              ${escapeHtml(emoji)}
            </div>
            <div class="os-card-info">
              <div class="os-card-name">${escapeHtml(app.name)}</div>
              <div class="os-card-category">${escapeHtml(app.category)} · ${escapeHtml(app.developer)}</div>
            </div>
          </div>
          <div class="os-card-desc">${escapeHtml(app.description)}</div>
          <div class="os-card-meta">
            <span class="os-stars">
              <span class="os-rating-num">${formatRating(app.rating)}</span>
              ${starDisplay(app.rating)}
              <span class="os-rating-count" style="margin-left:4px;font-size:10px;color:var(--os-text-mute);">
                (${app.ratingCount.toLocaleString()})
              </span>
            </span>
          </div>
          <div class="os-card-foot">
            <span class="os-size">${formatSize(app.size)}</span>
            <button class="os-install-btn ${installed ? "installed" : ""}"
                    data-install="${escapeHtml(app.id)}"
                    ${installed ? "disabled" : ""}>
              ${installed ? "Installed" : "Install"}
            </button>
          </div>
        </div>
      `;
    }

    _wireGrid() {
      if (!this.refs.grid) return;
      this.refs.grid.addEventListener("click", (e) => {
        const installBtn = e.target.closest("[data-install]");
        if (installBtn) {
          e.stopPropagation();
          const id = installBtn.getAttribute("data-install");
          this._installFlow(id, installBtn);
          return;
        }
        const card = e.target.closest(".os-card");
        if (card) this._openDetail(card.getAttribute("data-id"));
      });
    }

    /* ==================================================================
     * Install flow with progress animation
     * ================================================================*/
    async _installFlow(id, btnEl) {
      if (!id) return;
      if (isInstalled(id)) {
        // Toggle to detail view
        this._openDetail(id);
        return;
      }

      if (btnEl) {
        btnEl.classList.add("installing");
        btnEl.classList.remove("installed");
        btnEl.innerHTML = `
          <span class="os-install-progress"></span>
          <span class="os-install-progress-label">0%</span>
        `;
      }

      const app = getApp(id);
      const steps = 20;
      const stepMs = INSTALL_DURATION / steps;
      for (let i = 1; i <= steps; i++) {
        await delay(stepMs);
        if (btnEl) {
          const pct = Math.round((i / steps) * 100);
          const bar = btnEl.querySelector(".os-install-progress");
          const label = btnEl.querySelector(".os-install-progress-label");
          if (bar)   bar.style.width = pct + "%";
          if (label) label.textContent = pct + "%";
        }
      }

      // Quick-path install (persistence + desktop/menu)
      markInstalled(id);
      placeAppOnDesktop(app);
      registerAppInStartMenu(app);
      emit("install-complete", { id });

      if (window.AppStoreNotify && window.AppStoreNotify.installed) {
        window.AppStoreNotify.installed(app.name);
      }

      // Re-render card / grid / charts
      this._renderGrid();
      this._renderCharts();
      this._updateInstalledCount();
      if (this.detailId) this._renderDetail();
    }

    /* ==================================================================
     * Charts sidebar
     * ================================================================*/
    _renderCharts() {
      if (this.refs.chartTop) {
        this.refs.chartTop.innerHTML = topFreeCharts(6)
          .map((a) => this._chartItemHtml(a)).join("");
      }
      if (this.refs.chartRated) {
        this.refs.chartRated.innerHTML = topRatedCharts(6)
          .map((a) => this._chartItemHtml(a, "rated")).join("");
      }
      if (this.refs.chartRecent) {
        this.refs.chartRecent.innerHTML = recentReleases(6)
          .map((a) => this._chartItemHtml(a, "recent")).join("");
      }
      // Wire clicks
      [this.refs.chartTop, this.refs.chartRated, this.refs.chartRecent].forEach((chart) => {
        if (!chart || chart.dataset.wired) return;
        chart.dataset.wired = "1";
        chart.addEventListener("click", (e) => {
          const li = e.target.closest("li[data-id]");
          if (li) this._openDetail(li.getAttribute("data-id"));
        });
      });
    }

    _chartItemHtml(app, variant) {
      const grad = gradientFor(app.id);
      const emoji = app.emoji || iconLetters(app.name);
      let meta;
      if (variant === "rated") {
        meta = formatRating(app.rating) + " ★";
      } else if (variant === "recent") {
        meta = app.changelog[0].date + " · v" + app.version;
      } else {
        meta = app.ratingCount.toLocaleString() + " installs";
      }
      return `
        <li data-id="${escapeHtml(app.id)}">
          <span class="os-chart-mini-icon" style="background:${grad.css};">${escapeHtml(emoji)}</span>
          <span class="os-chart-info">
            <span class="os-chart-name">${escapeHtml(app.name)}</span>
            <span class="os-chart-meta">${escapeHtml(meta)}</span>
          </span>
        </li>
      `;
    }

    /* ==================================================================
     * Search
     * ================================================================*/
    _wireSearch() {
      const { search, searchClear } = this.refs;
      if (!search) return;
      search.addEventListener("input", () => {
        this.currentQuery = search.value.trim();
        if (searchClear) searchClear.hidden = this.currentQuery.length === 0;
        this._renderGrid();
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          search.value = "";
          this.currentQuery = "";
          if (searchClear) searchClear.hidden = true;
          this._renderGrid();
        }
      });
      if (searchClear) {
        searchClear.addEventListener("click", () => {
          search.value = "";
          this.currentQuery = "";
          searchClear.hidden = true;
          this._renderGrid();
          search.focus();
        });
      }
    }

    /* ==================================================================
     * Installed filter button
     * ================================================================*/
    _wireInstalledBtn() {
      const btn = this.refs.installedBtn;
      if (!btn) return;
      btn.addEventListener("click", () => {
        if (this.sortedView === "installed") {
          this.sortedView = null;
        } else {
          this.sortedView = "installed";
          this.currentCategory = "All";
          this._renderPills();
        }
        this._renderGrid();
      });
    }

    _updateInstalledCount() {
      const count = getInstalledList().length;
      const badge = this.refs.installedCount;
      if (!badge) return;
      if (count > 0) {
        badge.hidden = false;
        badge.textContent = count > 99 ? "99+" : String(count);
      } else {
        badge.hidden = true;
      }
    }

    _wireRefreshBtn() {
      const btn = this.refs.refreshBtn;
      if (!btn) return;
      btn.addEventListener("click", () => {
        // Pretend to refresh
        btn.style.transform = "rotate(360deg)";
        btn.style.transition = "transform 600ms ease";
        setTimeout(() => {
          btn.style.transform = "";
          btn.style.transition = "";
        }, 650);
        this._renderGrid();
        this._renderCharts();
        this._updateInstalledCount();
        this._localToast("Catalog refreshed");
      });
    }

    /* ==================================================================
     * Detail view
     * ================================================================*/
    _openDetail(id) {
      if (!id) return;
      this.detailId = id;
      if (this.refs.detail) this.refs.detail.hidden = false;
      this._renderDetail();
    }

    _closeDetail() {
      this.detailId = null;
      if (!this.refs.detail) return;
      this.refs.detail.hidden = true;
    }

    _renderDetail() {
      const inner = this.refs.detailInner;
      if (!inner || !this.detailId) return;
      const app = getApp(this.detailId);
      if (!app) return;
      const grad = gradientFor(app.id);
      const emoji = app.emoji || iconLetters(app.name);
      const installed = isInstalled(app.id);

      // Build rating histogram data (derive from rating & ratingCount)
      const breakdown = this._ratingBreakdown(app.rating, app.ratingCount);

      inner.style.setProperty("--os-accent-a", grad.from);
      inner.style.setProperty("--os-accent-b", grad.to);

      inner.innerHTML = `
        <button class="os-detail-close" aria-label="Close">✕</button>
        <div class="os-detail-head">
          <div class="os-detail-head-row">
            <div class="os-detail-icon">${escapeHtml(emoji)}</div>
            <div class="os-detail-titlewrap">
              <h2 class="os-detail-title">${escapeHtml(app.name)}</h2>
              <div class="os-detail-developer">by ${escapeHtml(app.developer)}</div>
              <div class="os-detail-chips">
                <span class="os-chip">${escapeHtml(app.category)}</span>
                <span class="os-chip">${formatRating(app.rating)} ★</span>
                <span class="os-chip">${app.ratingCount.toLocaleString()} ratings</span>
                <span class="os-chip">v${escapeHtml(app.version)}</span>
                <span class="os-chip">${formatSize(app.size)}</span>
              </div>
              <div class="os-detail-cta">
                <button class="os-btn ${installed ? "installed" : "primary"}" data-install="${escapeHtml(app.id)}" ${installed ? "" : ""}>
                  ${installed ? "Installed ✓" : "Install"}
                </button>
                ${installed ? `<button class="os-btn" data-uninstall="${escapeHtml(app.id)}">Uninstall</button>` : ""}
                ${installed ? `<button class="os-btn" data-launch="${escapeHtml(app.id)}">Launch</button>` : ""}
              </div>
            </div>
          </div>
        </div>
        <div class="os-detail-body">
          <section class="os-detail-section">
            <h4>About this app</h4>
            <div class="os-detail-long">${escapeHtml(app.longDescription)}</div>
          </section>

          <section class="os-detail-section">
            <h4>Ratings &amp; reviews</h4>
            <div class="os-rating-box">
              <div class="os-rating-big">
                <div class="os-rating-num-big">${formatRating(app.rating)}</div>
                <div>${starDisplay(app.rating)}</div>
                <div class="os-rating-total">${app.ratingCount.toLocaleString()} ratings</div>
              </div>
              <div class="os-rating-bars">
                ${[5, 4, 3, 2, 1].map((star) => {
                  const count = breakdown[star] || 0;
                  const pct = (count / app.ratingCount) * 100 || 0;
                  return `
                    <div class="os-rating-row">
                      <span class="os-rating-row-label">${star}</span>
                      <span class="os-rating-row-bar">
                        <span class="os-rating-row-bar-fill" style="width:${pct.toFixed(1)}%"></span>
                      </span>
                      <span class="os-rating-row-count">${count.toLocaleString()}</span>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          </section>

          <section class="os-detail-section">
            <h4>Screenshots</h4>
            <div class="os-shots">
              ${app.screenshots.map((s) => `
                <div class="os-shot" style="background:${s.bg};">
                  <span class="os-shot-label">${escapeHtml(s.label)}</span>
                </div>
              `).join("")}
            </div>
          </section>

          <section class="os-detail-section">
            <h4>What's new</h4>
            ${app.changelog.map((c) => `
              <div class="os-changelog-item">
                <span class="os-changelog-version">v${escapeHtml(c.version)}</span>
                <span class="os-changelog-date">${escapeHtml(c.date)}</span>
                <span class="os-changelog-notes">${escapeHtml(c.notes)}</span>
              </div>
            `).join("")}
          </section>

          <section class="os-detail-section">
            <h4>Reviews</h4>
            ${app.reviews.map((r) => `
              <div class="os-review">
                <div class="os-review-head">
                  <div class="os-review-name">${escapeHtml(r.reviewer)}</div>
                  <div class="os-review-date">${escapeHtml(r.date)}</div>
                </div>
                <div class="os-review-stars">${starDisplay(r.rating)}</div>
                <div class="os-review-text">${escapeHtml(r.text)}</div>
              </div>
            `).join("")}
          </section>

          <section class="os-detail-section">
            <h4>Information</h4>
            <div class="os-meta-grid">
              <div class="os-meta-stat"><div class="os-meta-stat-label">Developer</div><div class="os-meta-stat-val">${escapeHtml(app.developer)}</div></div>
              <div class="os-meta-stat"><div class="os-meta-stat-label">Version</div><div class="os-meta-stat-val">${escapeHtml(app.version)}</div></div>
              <div class="os-meta-stat"><div class="os-meta-stat-label">Size</div><div class="os-meta-stat-val">${formatSize(app.size)}</div></div>
              <div class="os-meta-stat"><div class="os-meta-stat-label">Category</div><div class="os-meta-stat-val">${escapeHtml(app.category)}</div></div>
              <div class="os-meta-stat"><div class="os-meta-stat-label">Compatibility</div><div class="os-meta-stat-val">WebOS 1.0+</div></div>
              <div class="os-meta-stat"><div class="os-meta-stat-label">Tags</div><div class="os-meta-stat-val">${(app.tags || []).join(", ") || "—"}</div></div>
            </div>
          </section>
        </div>
      `;

      // Wire events
      inner.querySelector(".os-detail-close").addEventListener("click", () => this._closeDetail());
      const installBtn = inner.querySelector("[data-install]");
      if (installBtn && !installed) {
        installBtn.addEventListener("click", () => this._installFlow(app.id, installBtn));
      }
      const uninstallBtn = inner.querySelector("[data-uninstall]");
      if (uninstallBtn) {
        uninstallBtn.addEventListener("click", () => {
          if (!confirm("Uninstall " + app.name + "?")) return;
          uninstallApp(app.id);
          this._renderDetail();
          this._renderGrid();
          this._renderCharts();
          this._updateInstalledCount();
        });
      }
      const launchBtn = inner.querySelector("[data-launch]");
      if (launchBtn) {
        launchBtn.addEventListener("click", () => {
          if (window.WindowManager && window.WindowManager.openApp) {
            window.WindowManager.openApp("osstore-app-" + app.id);
          }
        });
      }
    }

    _ratingBreakdown(rating, total) {
      // Heuristic: generate a plausible distribution that averages to `rating`.
      const shape = {
        5: Math.max(0.05, 0.7 - (5 - rating) * 0.3),
        4: 0.2 - Math.abs(rating - 4) * 0.05,
        3: 0.05 + Math.abs(rating - 3) * 0.03,
        2: 0.02 + (rating < 3 ? 0.1 : 0),
        1: 0.01 + (rating < 2.5 ? 0.15 : 0),
      };
      // Normalize
      const sum = Object.values(shape).reduce((a, b) => a + b, 0);
      const out = {};
      [5,4,3,2,1].forEach((s) => {
        out[s] = Math.round((shape[s] / sum) * total);
      });
      return out;
    }

    /* ==================================================================
     * Local toast
     * ================================================================*/
    _localToast(text) {
      const root = this.refs.localToasts;
      if (!root) return;
      const el = document.createElement("div");
      el.className = "os-local-toast";
      el.textContent = text;
      root.appendChild(el);
      setTimeout(() => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 220);
      }, 1600);
    }
  }

  /* ==========================================================================
   * Install metadata snapshot (for the "My Apps" section)
   * ========================================================================*/

  function installedMetadata() {
    const installed = loadInstalled();
    return Object.keys(installed).map((id) => {
      const app = getApp(id);
      if (!app) return null;
      return {
        id,
        name: app.name,
        installedAt: installed[id].installedAt || 0,
        installedVersion: getInstalledVersion(id) || app.version,
        currentVersion: app.version,
        needsUpdate: hasUpdate(app),
        size: app.size,
      };
    }).filter(Boolean);
  }

  function sortInstalledBy(criterion) {
    const data = installedMetadata();
    switch (criterion) {
      case "name":
        return data.sort((a, b) => a.name.localeCompare(b.name));
      case "size":
        return data.sort((a, b) => b.size - a.size);
      case "recent":
      default:
        return data.sort((a, b) => b.installedAt - a.installedAt);
    }
  }

  /* ==========================================================================
   * Notification helpers (store-wide announcements)
   * ========================================================================*/

  function announceUpdateAvailable() {
    const apps = appsNeedingUpdate();
    if (apps.length === 0) return 0;
    if (window.Notifications) {
      window.Notifications.info(
        apps.length === 1 ? "Update available" : apps.length + " updates available",
        apps.slice(0, 3).map((a) => a.name).join(", ") +
          (apps.length > 3 ? " and " + (apps.length - 3) + " more" : ""),
        {
          appName: "OsStore",
          appIcon: APP_ICON,
          duration: 6000,
          actionLabel: "Open OsStore",
          action: () => {
            if (window.WindowManager && window.WindowManager.openApp) {
              window.WindowManager.openApp(APP_ID);
            }
          },
        }
      );
    }
    return apps.length;
  }

  function checkForUpdatesPeriodically() {
    // Run once at boot, then every 5 minutes while the page is open
    setTimeout(announceUpdateAvailable, 8000);
    setInterval(announceUpdateAvailable, 5 * 60 * 1000);
  }

  /* ==========================================================================
   * Analytics-style event log (purely local)
   * ========================================================================*/

  const LS_KEY_EVENTS = "webos.osstore.events.v1";
  const EVENT_MAX = 500;

  function logEvent(kind, data) {
    const list = safeGet(LS_KEY_EVENTS, []) || [];
    list.unshift({ kind, data: data || {}, ts: Date.now() });
    if (list.length > EVENT_MAX) list.length = EVENT_MAX;
    safeSet(LS_KEY_EVENTS, list);
  }

  function getEventLog(limit) {
    const list = safeGet(LS_KEY_EVENTS, []) || [];
    return list.slice(0, limit || EVENT_MAX);
  }

  function clearEventLog() {
    try { localStorage.removeItem(LS_KEY_EVENTS); } catch (_) {}
  }

  // Wire internal events to the log
  on((name, detail) => {
    if (name === "install-complete" || name === "uninstall" ||
        name === "review-submit"    || name === "update-complete") {
      logEvent(name, detail || {});
    }
  });

  /* ==========================================================================
   * Pricing tiers (placeholder for future paid apps)
   * ========================================================================*/

  const PRICING_TIERS = [
    { id: "free",    label: "Free",        price: 0 },
    { id: "pro",     label: "Pro",         price: 9.99 },
    { id: "team",    label: "Team",        price: 24.99 },
    { id: "lifetime", label: "Lifetime",   price: 49.99 },
  ];

  function getPricingTiers() { return PRICING_TIERS.slice(); }

  /* ==========================================================================
   * Developer portal (list of developers and their apps)
   * ========================================================================*/

  function allDevelopers() {
    const map = new Map();
    CATALOG.forEach((a) => {
      if (!map.has(a.developer)) {
        map.set(a.developer, { name: a.developer, apps: [], totalRatings: 0, avgRating: 0 });
      }
      const d = map.get(a.developer);
      d.apps.push(a);
      d.totalRatings += a.ratingCount;
    });
    map.forEach((d) => {
      const sum = d.apps.reduce((s, a) => s + a.rating * a.ratingCount, 0);
      d.avgRating = d.totalRatings > 0 ? sum / d.totalRatings : 0;
    });
    return Array.from(map.values()).sort((a, b) => b.totalRatings - a.totalRatings);
  }

  function appsByDeveloper(devName) {
    return CATALOG.filter((a) => a.developer === devName);
  }

  /* ==========================================================================
   * App comparison utility (side-by-side feature compare)
   * ========================================================================*/

  function compareApps(idA, idB) {
    const a = getApp(idA);
    const b = getApp(idB);
    if (!a || !b) return null;
    return {
      a, b,
      differences: {
        rating:      a.rating - b.rating,
        ratingCount: a.ratingCount - b.ratingCount,
        size:        a.size - b.size,
        sameCategory: a.category === b.category,
        sharedTags:   (a.tags || []).filter((t) => (b.tags || []).indexOf(t) >= 0),
      },
    };
  }

  function findInCategory(category, limit) {
    return getByCategory(category).slice(0, limit || 20);
  }

  function randomApp() {
    return CATALOG[Math.floor(Math.random() * CATALOG.length)];
  }

  function randomApps(n) {
    const copy = CATALOG.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n || 5);
  }

  /* ==========================================================================
   * Price / localization placeholders (all apps are free in WebOS)
   * ========================================================================*/

  function priceLabel(app) {
    if (!app) return "Free";
    // Hook for future paid tiers; returns "Free" unless an override exists.
    return app.price || "Free";
  }

  function localizedCategory(categoryId) {
    // Future: localized strings keyed by document language. For now, passthrough.
    const found = CATEGORIES.find((c) => c.id === categoryId);
    return found ? found.label : categoryId;
  }

  function currencySymbol() { return "$"; }

  /* ==========================================================================
   * Install size accounting (for a storage dashboard)
   * ========================================================================*/

  function sizeOfInstalled() {
    return getInstalledList().reduce((s, a) => s + (a.size || 0), 0);
  }

  function sizeOfWishlist() {
    return getWishlistApps().reduce((s, a) => s + (a.size || 0), 0);
  }

  function totalCatalogSize() {
    return CATALOG.reduce((s, a) => s + (a.size || 0), 0);
  }

  /* ==========================================================================
   * Badges (e.g. "New", "Popular", "Editor's Pick")
   * ========================================================================*/

  function computeBadges(app) {
    if (!app) return [];
    const badges = [];
    // New: changelog date within 30 days
    const newest = new Date(app.changelog[0].date).getTime();
    if (Date.now() - newest < 1000 * 60 * 60 * 24 * 30) {
      badges.push({ id: "new", label: "New", color: "#10b981" });
    }
    // Popular: ratingCount > 8000
    if ((app.ratingCount || 0) > 8000) {
      badges.push({ id: "popular", label: "Popular", color: "#ec4899" });
    }
    // Editor's Pick: featured + high rating
    if (app.featured && (app.rating || 0) >= 4.6) {
      badges.push({ id: "editors", label: "Editor's Pick", color: "#f59e0b" });
    }
    // Top rated: rating >= 4.75
    if ((app.rating || 0) >= 4.75) {
      badges.push({ id: "top", label: "Top Rated", color: "#7c3aed" });
    }
    return badges;
  }

  function appsByBadge(badgeId) {
    return CATALOG.filter((a) => computeBadges(a).some((b) => b.id === badgeId));
  }

  /* ==========================================================================
   * Rotating banner messages (store-wide announcements)
   * ========================================================================*/

  const BANNERS = [
    { id: "welcome",   text: "Welcome to OsStore — discover apps crafted for WebOS.", icon: "🎉" },
    { id: "featured",  text: "Check out this week's featured apps.", icon: "⭐" },
    { id: "dev",       text: "Developer Kit collection — install 6 essentials in one click.", icon: "🛠" },
    { id: "games",     text: "Take a break with our Game Night picks.", icon: "🎮" },
    { id: "update",    text: "Remember to keep your apps up to date for the best experience.", icon: "🔄" },
  ];

  function currentBanner() {
    const dayIdx = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
    return BANNERS[dayIdx % BANNERS.length];
  }

  /* ==========================================================================
   * Recently viewed apps
   * ========================================================================*/

  const LS_KEY_RECENT = "webos.osstore.recent.v1";
  const RECENT_MAX = 20;

  function recordRecentView(id) {
    if (!id || !getApp(id)) return;
    let list = safeGet(LS_KEY_RECENT, []);
    if (!Array.isArray(list)) list = [];
    list = list.filter((x) => x !== id);
    list.unshift(id);
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    safeSet(LS_KEY_RECENT, list);
  }

  function getRecentlyViewed(limit) {
    const ids = safeGet(LS_KEY_RECENT, []) || [];
    return ids.slice(0, limit || RECENT_MAX).map(getApp).filter(Boolean);
  }

  function clearRecentlyViewed() {
    try { localStorage.removeItem(LS_KEY_RECENT); } catch (_) {}
  }

  /* ==========================================================================
   * Related / recommended apps for a given user (based on installs + tags)
   * ========================================================================*/

  function recommendations(limit) {
    const installed = getInstalledList();
    if (installed.length === 0) {
      return topRatedCharts(limit || 6);
    }
    const installedIds = new Set(installed.map((a) => a.id));
    const tagScore = {};
    installed.forEach((a) => {
      (a.tags || []).forEach((t) => {
        tagScore[t] = (tagScore[t] || 0) + 1;
      });
    });
    return CATALOG
      .filter((a) => !installedIds.has(a.id))
      .map((a) => {
        let score = 0;
        (a.tags || []).forEach((t) => { score += tagScore[t] || 0; });
        score += (a.rating || 0) * 0.5;
        score += Math.log10(Math.max(1, a.ratingCount)) * 0.3;
        return { app: a, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 6)
      .map((x) => x.app);
  }

  /* ==========================================================================
   * Wishlist (saved-for-later apps)
   * ========================================================================*/

  const LS_KEY_WISHLIST = "webos.osstore.wishlist.v1";

  function loadWishlist() {
    const raw = safeGet(LS_KEY_WISHLIST, []);
    return Array.isArray(raw) ? raw : [];
  }

  function saveWishlist(list) {
    safeSet(LS_KEY_WISHLIST, Array.isArray(list) ? list : []);
  }

  function addToWishlist(id) {
    if (!id || !getApp(id)) return false;
    const list = loadWishlist();
    if (list.indexOf(id) >= 0) return false;
    list.unshift(id);
    if (list.length > 100) list.length = 100;
    saveWishlist(list);
    emit("wishlist-change", { id, added: true });
    return true;
  }

  function removeFromWishlist(id) {
    const list = loadWishlist();
    const i = list.indexOf(id);
    if (i < 0) return false;
    list.splice(i, 1);
    saveWishlist(list);
    emit("wishlist-change", { id, added: false });
    return true;
  }

  function isWishlisted(id) {
    return loadWishlist().indexOf(id) >= 0;
  }

  function getWishlistApps() {
    return loadWishlist().map(getApp).filter(Boolean);
  }

  function clearWishlist() {
    saveWishlist([]);
    emit("wishlist-clear", {});
  }

  /* ==========================================================================
   * User reviews (per-app)
   * ========================================================================*/

  const LS_KEY_REVIEWS = "webos.osstore.myreviews.v1";

  function loadMyReviews() {
    return safeGet(LS_KEY_REVIEWS, {}) || {};
  }

  function saveMyReviews(obj) {
    safeSet(LS_KEY_REVIEWS, obj || {});
  }

  function submitReview(appId, rating, text) {
    const app = getApp(appId);
    if (!app) return false;
    const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 5));
    const db = loadMyReviews();
    db[appId] = {
      rating: r,
      text: String(text || "").slice(0, 600),
      date: new Date().toISOString().slice(0, 10),
      reviewer: "You",
    };
    saveMyReviews(db);
    emit("review-submit", { appId, rating: r });
    return true;
  }

  function getMyReview(appId) {
    return (loadMyReviews())[appId] || null;
  }

  function deleteMyReview(appId) {
    const db = loadMyReviews();
    if (db[appId]) {
      delete db[appId];
      saveMyReviews(db);
      return true;
    }
    return false;
  }

  /* ==========================================================================
   * Updates (fake update detection based on installed version vs latest)
   * ========================================================================*/

  const LS_KEY_INSTALLED_VERSIONS = "webos.osstore.installedVersions.v1";

  function recordInstalledVersion(id, version) {
    const db = safeGet(LS_KEY_INSTALLED_VERSIONS, {}) || {};
    db[id] = version;
    safeSet(LS_KEY_INSTALLED_VERSIONS, db);
  }

  function getInstalledVersion(id) {
    const db = safeGet(LS_KEY_INSTALLED_VERSIONS, {}) || {};
    return db[id] || null;
  }

  function hasUpdate(app) {
    if (!app || !isInstalled(app.id)) return false;
    const inst = getInstalledVersion(app.id);
    if (!inst) return false;
    return compareVersions(inst, app.version) < 0;
  }

  function compareVersions(a, b) {
    const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] || 0, vb = pb[i] || 0;
      if (va < vb) return -1;
      if (va > vb) return 1;
    }
    return 0;
  }

  function appsNeedingUpdate() {
    return getInstalledList().filter(hasUpdate);
  }

  async function updateApp(id) {
    const app = getApp(id);
    if (!app) return { ok: false, error: "Unknown app" };
    if (!isInstalled(id)) return { ok: false, error: "Not installed" };
    await delay(INSTALL_DURATION / 2);
    recordInstalledVersion(id, app.version);
    emit("update-complete", { id, version: app.version });
    if (window.AppStoreNotify && window.AppStoreNotify.updated) {
      window.AppStoreNotify.updated(app.name, app.version);
    }
    return { ok: true };
  }

  async function updateAllApps() {
    const targets = appsNeedingUpdate();
    let n = 0;
    for (const app of targets) {
      const r = await updateApp(app.id);
      if (r.ok) n++;
    }
    return n;
  }

  /* ==========================================================================
   * Collections (curated themed bundles)
   * ========================================================================*/

  const COLLECTIONS = [
    {
      id: "essentials",
      title: "Essentials",
      description: "Apps every WebOS user needs on day one.",
      ids: ["pronotes", "kanbanboard", "focustimer", "colorpicker", "pdfviewer"],
    },
    {
      id: "devkit",
      title: "Developer Kit",
      description: "A polished toolbox for engineers.",
      ids: ["jsonformatter", "regextester", "httptester", "diffviewer", "base64tool", "colorpalette"],
    },
    {
      id: "game-night",
      title: "Game Night",
      description: "Classic games to unwind with.",
      ids: ["chess", "tetris", "sudoku", "solitaire", "2048"],
    },
    {
      id: "creative-studio",
      title: "Creative Studio",
      description: "Design and creative tools in one click.",
      ids: ["pixelarteditor", "iconpack", "fontviewer", "colorpalette", "colorpicker"],
    },
    {
      id: "focus",
      title: "Deep Focus",
      description: "Tools to help you get in the zone.",
      ids: ["focustimer", "timetracker", "markdownpad", "mindmapper"],
    },
  ];

  function getCollections() { return COLLECTIONS.slice(); }

  function getCollection(id) {
    const c = COLLECTIONS.find((x) => x.id === id);
    if (!c) return null;
    return Object.assign({}, c, {
      apps: c.ids.map(getApp).filter(Boolean),
    });
  }

  async function installCollection(collectionId) {
    const c = getCollection(collectionId);
    if (!c) return 0;
    let n = 0;
    for (const app of c.apps) {
      if (!isInstalled(app.id)) {
        const r = await installApp(app.id, { quick: true });
        if (r.ok) n++;
      }
    }
    emit("collection-install", { id: collectionId, count: n });
    return n;
  }

  /* ==========================================================================
   * Bulk operations
   * ========================================================================*/

  async function installMany(ids) {
    let n = 0;
    for (const id of (ids || [])) {
      const r = await installApp(id, { quick: true });
      if (r.ok && !r.alreadyInstalled) n++;
    }
    return n;
  }

  function uninstallMany(ids) {
    let n = 0;
    (ids || []).forEach((id) => {
      const r = uninstallApp(id);
      if (r.ok && !r.notInstalled) n++;
    });
    return n;
  }

  function uninstallAll() {
    return uninstallMany(getInstalledList().map((a) => a.id));
  }

  /* ==========================================================================
   * Export / import store state
   * ========================================================================*/

  function exportState() {
    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      installed:        loadInstalled(),
      installedVersions: safeGet(LS_KEY_INSTALLED_VERSIONS, {}),
      wishlist:         loadWishlist(),
      myReviews:        loadMyReviews(),
    }, null, 2);
  }

  function importState(json) {
    try {
      const obj = typeof json === "string" ? JSON.parse(json) : json;
      if (!obj || typeof obj !== "object") return false;
      if (obj.installed)         saveInstalled(obj.installed);
      if (obj.installedVersions) safeSet(LS_KEY_INSTALLED_VERSIONS, obj.installedVersions);
      if (obj.wishlist)          saveWishlist(obj.wishlist);
      if (obj.myReviews)         saveMyReviews(obj.myReviews);
      // Re-place installed apps on desktop
      getInstalledList().forEach((app) => {
        placeAppOnDesktop(app);
        registerAppInStartMenu(app);
      });
      emit("state-imported", {});
      return true;
    } catch (e) {
      console.warn("[OsStore] importState failed:", e);
      return false;
    }
  }

  function resetStore() {
    if (!confirm("Reset OsStore? All installed apps, wishlist, and reviews will be cleared.")) {
      return false;
    }
    uninstallAll();
    clearWishlist();
    try { localStorage.removeItem(LS_KEY_REVIEWS); } catch (_) {}
    try { localStorage.removeItem(LS_KEY_INSTALLED_VERSIONS); } catch (_) {}
    emit("reset", {});
    return true;
  }

  /* ==========================================================================
   * Stats / analytics (about the user's store activity)
   * ========================================================================*/

  function storeStats() {
    const installed = getInstalledList();
    const wishlist = getWishlistApps();
    const totalSize = installed.reduce((s, a) => s + (a.size || 0), 0);
    const byCategory = {};
    installed.forEach((a) => {
      byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    });
    return {
      catalogSize:     CATALOG.length,
      installedCount:  installed.length,
      wishlistCount:   wishlist.length,
      totalInstalledSize: totalSize,
      totalInstalledSizeFormatted: formatSize(totalSize),
      byCategory,
      updatesAvailable: appsNeedingUpdate().length,
    };
  }

  /* ==========================================================================
   * Sorting helpers
   * ========================================================================*/

  const SORT_OPTIONS = [
    { id: "relevance", label: "Relevance" },
    { id: "rating",    label: "Highest rated" },
    { id: "popular",   label: "Most popular" },
    { id: "name",      label: "Name (A–Z)" },
    { id: "nameDesc",  label: "Name (Z–A)" },
    { id: "newest",    label: "Newest" },
    { id: "smallest",  label: "Smallest size" },
  ];

  function sortList(list, sortId) {
    const arr = (list || []).slice();
    switch (sortId) {
      case "rating":
        return arr.sort((a, b) => (b.rating - a.rating) ||
                                  (b.ratingCount - a.ratingCount));
      case "popular":
        return arr.sort((a, b) => b.ratingCount - a.ratingCount);
      case "name":
        return arr.sort((a, b) => a.name.localeCompare(b.name));
      case "nameDesc":
        return arr.sort((a, b) => b.name.localeCompare(a.name));
      case "newest":
        return arr.sort((a, b) => {
          const da = new Date(a.changelog[0].date).getTime();
          const db = new Date(b.changelog[0].date).getTime();
          return db - da;
        });
      case "smallest":
        return arr.sort((a, b) => (a.size || 0) - (b.size || 0));
      default:
        return arr;
    }
  }

  function getSortOptions() { return SORT_OPTIONS.slice(); }

  /* ==========================================================================
   * Tag index (which apps use which tags)
   * ========================================================================*/

  function tagIndex() {
    const idx = {};
    CATALOG.forEach((a) => {
      (a.tags || []).forEach((t) => {
        if (!idx[t]) idx[t] = [];
        idx[t].push(a.id);
      });
    });
    return idx;
  }

  function appsWithTag(tag) {
    if (!tag) return [];
    const t = String(tag).toLowerCase();
    return CATALOG.filter((a) => (a.tags || []).some((x) => x.toLowerCase() === t));
  }

  function allTags() {
    const counts = {};
    CATALOG.forEach((a) => {
      (a.tags || []).forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .map((t) => ({ tag: t, count: counts[t] }))
      .sort((a, b) => b.count - a.count);
  }

  /* ==========================================================================
   * Similar apps (shared category + tag overlap)
   * ========================================================================*/

  function similarApps(id, limit) {
    const seed = getApp(id);
    if (!seed) return [];
    const seedTags = new Set(seed.tags || []);
    return CATALOG
      .filter((a) => a.id !== id)
      .map((a) => {
        let score = 0;
        if (a.category === seed.category) score += 3;
        (a.tags || []).forEach((t) => { if (seedTags.has(t)) score += 1; });
        score += (a.rating || 0) * 0.2;
        return { app: a, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 4)
      .map((x) => x.app);
  }

  /* ==========================================================================
   * Featured rotation helpers
   * ========================================================================*/

  function dailyFeaturedApp() {
    const today = new Date();
    const seed = today.getFullYear() * 1000 + today.getMonth() * 50 + today.getDate();
    const featured = featuredApps();
    if (featured.length === 0) return null;
    return featured[seed % featured.length];
  }

  /* ==========================================================================
   * Template loader
   * ========================================================================*/

  async function ensureTemplateLoaded() {
    if (document.getElementById("appstore-app-template")) return true;
    try {
      const res = await fetch("apps/appStore/appStore.html", { cache: "force-cache" });
      if (!res.ok) return false;
      const html = await res.text();
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      const tmpl = wrap.querySelector("#appstore-app-template");
      if (tmpl) {
        document.body.appendChild(tmpl);
        return true;
      }
    } catch (e) {
      console.warn("[OsStore] template fetch failed:", e);
    }
    return false;
  }

  /* ==========================================================================
   * WindowManager registration
   * ========================================================================*/

  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    if (window.WindowManager.unregisterApp) {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id:        APP_ID,
      title:     APP_TITLE,
      icon:      APP_ICON,
      width:     1024,
      height:    660,
      minWidth:  620,
      minHeight: 460,
      category:  "System",
      pinned:    true,
      render(body, win) {
        ensureTemplateLoaded().then(() => {
          const opts = Object.assign({}, (win.opts && win.opts.storeOpts) || {}, {
            showDetail: (win.opts && win.opts.showDetail) || null,
          });
          const app = new AppStoreApp(body, win, opts);
          win._osstore = app;
          app.mount();
        });
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;font-family:var(--font-ui,sans-serif);font-size:13px;">
            Loading OsStore…
          </div>
        `;
      },
      onClose(win) {
        if (win._osstore) try { win._osstore.destroy(); } catch (_) {}
      },
    });

    console.log("%c[WebOS]%c OsStore registered",
      "color:#ec4899;font-weight:bold", "color:inherit");
  }

  /* ==========================================================================
   * Taskbar icon (shopping bag next to settings)
   * ========================================================================*/

  function installTaskbarIcon() {
    const tray = document.querySelector(".taskbar-tray");
    if (!tray) { setTimeout(installTaskbarIcon, 200); return; }
    if (document.getElementById("tray-osstore")) return;
    const settings = document.getElementById("tray-settings");
    const node = document.createElement("div");
    node.id = "tray-osstore";
    node.className = "tray-icon";
    node.title = "OsStore";
    node.textContent = "🛍";
    node.addEventListener("click", () => {
      if (window.WindowManager && window.WindowManager.openApp) {
        window.WindowManager.openApp(APP_ID);
      }
    });
    if (settings) tray.insertBefore(node, settings.nextSibling);
    else tray.insertBefore(node, tray.firstChild);
  }

  /* ==========================================================================
   * Public API
   * ========================================================================*/

  window.OsStore = {
    open(opts) {
      if (window.WindowManager && window.WindowManager.openApp) {
        return window.WindowManager.openApp(APP_ID, opts || {});
      }
      return null;
    },
    // Catalog
    getCatalog, getApp, getByCategory, searchCatalog,
    topFreeCharts, topRatedCharts, recentReleases, featuredApps,
    sortList, getSortOptions,
    tagIndex, appsWithTag, allTags, similarApps,
    dailyFeaturedApp,
    recordRecentView, getRecentlyViewed, clearRecentlyViewed,
    recommendations,
    computeBadges, appsByBadge, currentBanner,
    priceLabel, localizedCategory, currencySymbol,
    sizeOfInstalled, sizeOfWishlist, totalCatalogSize,
    compareApps, findInCategory, randomApp, randomApps,
    allDevelopers, appsByDeveloper,
    logEvent, getEventLog, clearEventLog,
    getPricingTiers,
    installedMetadata, sortInstalledBy,
    announceUpdateAvailable,
    // Collections
    getCollections, getCollection, installCollection,
    // Bulk
    installMany, uninstallMany, uninstallAll,
    // State
    getInstalledList, isInstalled,
    installApp, uninstallApp,
    // Wishlist
    addToWishlist, removeFromWishlist, isWishlisted,
    getWishlistApps, clearWishlist,
    // Reviews
    submitReview, getMyReview, deleteMyReview,
    // Updates
    hasUpdate, appsNeedingUpdate, updateApp, updateAllApps,
    recordInstalledVersion, getInstalledVersion, compareVersions,
    // Stats + export
    storeStats, exportState, importState, resetStore,
    // Events
    on,
    // Constants
    CATEGORIES, SORT_OPTIONS,
  };

  /* ==========================================================================
   * Boot
   * ========================================================================*/

  function boot() {
    registerApp();
    installTaskbarIcon();
    // Re-register installed apps' stubs so they appear in Start Menu
    setTimeout(restoreInstalledApps, 300);
    checkForUpdatesPeriodically();
  }

  if (window.WindowManager) boot();
  else window.addEventListener("DOMContentLoaded", boot);
})();
