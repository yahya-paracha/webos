/* ============================================================================
 * SoundWave — WebOS Music Player
 * ----------------------------------------------------------------------------
 * Self-contained music app with:
 *   - HTMLAudioElement-based playback wrapped in a Web Audio AudioContext
 *   - 5-band parametric EQ via BiquadFilterNodes + 6 presets
 *   - Live frequency-bar AND circular-waveform visualizers driven by an
 *     AnalyserNode
 *   - Library management (load files / folder, search, sort, playlists),
 *     persisted to FileSystem under /Music/library.json
 *   - Playback modes: normal, repeat-one, repeat-all, shuffle
 *   - Queue ("Up Next") system with per-row "Play next" / "Add to queue"
 *   - Mini-mode toggle, full keyboard shortcut suite
 *   - 30-track demo library shown when nothing real is loaded
 *
 * Registers with the WebOS WindowManager. canOpen() advertises support for
 * common audio extensions so the File Manager / context menu can route them.
 * ========================================================================= */
(function () {
  "use strict";

  /* =========================================================================
   * 0.  CONSTANTS
   * ====================================================================== */
  const APP_ID       = "musicPlayer";
  const APP_TITLE    = "SoundWave";
  const APP_ICON     = "🎵";
  const APP_CATEGORY = "Media";

  const AUDIO_EXTS   = ["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "weba"];
  const LIBRARY_PATH = "/Music/library.json";

  const CROSSFADE_MS = 500;

  const EQ_BANDS = [
    { freq: 60,    type: "lowshelf",  label: "60Hz"  },
    { freq: 250,   type: "peaking",   label: "250Hz" },
    { freq: 1000,  type: "peaking",   label: "1 kHz" },
    { freq: 4000,  type: "peaking",   label: "4 kHz" },
    { freq: 16000, type: "highshelf", label: "16 kHz" },
  ];

  const EQ_PRESETS = {
    "Flat":         [ 0,  0,  0,  0,  0],
    "Bass Boost":   [ 8,  6,  2, -1, -2],
    "Vocal":        [-2,  0,  4,  3,  1],
    "Electronic":   [ 5,  2, -2,  4,  6],
    "Classical":    [ 4,  2,  0,  2,  4],
    "Rock":         [ 5,  3, -2,  4,  6],
  };

  const VIS_MODES = ["bars", "circle"];

  /* =========================================================================
   * 1.  SMALL UTILITIES
   * ====================================================================== */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function uid(prefix) { return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 9); }

  function getExt(p) {
    if (!p) return "";
    const i = p.lastIndexOf(".");
    return i < 0 ? "" : p.slice(i + 1).toLowerCase();
  }

  function basename(p) {
    if (!p) return "";
    const segs = String(p).split("/");
    return segs[segs.length - 1] || "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  /**
   * Hash a string into a small integer (DJB2). Used to deterministically
   * generate gradient colors from song / album names.
   */
  function hashString(s) {
    let h = 5381;
    s = String(s || "");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  /**
   * Build a per-name CSS gradient suitable for an album-art placeholder.
   */
  function gradientFor(seed) {
    const h = hashString(seed || "");
    const a = h % 360;
    const b = (a + 60 + (h >> 8) % 60) % 360;
    return "linear-gradient(135deg, hsl(" + a + ",60%,45%) 0%, hsl(" + b + ",60%,30%) 100%)";
  }

  /**
   * Try to extract a friendly { title, artist, album } from a filename.
   * Patterns supported (in order):
   *   "Artist - Album - 03 - Title.mp3"
   *   "Artist - Title.mp3"
   *   "03 - Title.mp3"
   *   "Title.mp3"
   */
  function metaFromName(name) {
    const stem = String(name || "").replace(/\.[^.]+$/, "").trim();
    const parts = stem.split(/\s+-\s+/).map((s) => s.trim());
    if (parts.length >= 4) {
      return { title: parts.slice(3).join(" - "), artist: parts[0], album: parts[1] };
    }
    if (parts.length === 3 && /^\d+$/.test(parts[1])) {
      return { title: parts[2], artist: parts[0], album: "" };
    }
    if (parts.length === 3) {
      return { title: parts[2], artist: parts[0], album: parts[1] };
    }
    if (parts.length === 2) {
      if (/^\d+$/.test(parts[0])) return { title: parts[1], artist: "Unknown", album: "" };
      return { title: parts[1], artist: parts[0], album: "" };
    }
    return { title: stem || "Untitled", artist: "Unknown", album: "" };
  }

  /* =========================================================================
   * 2.  DEMO LIBRARY (30 tracks)
   *     Display-only — these have no playable URL. Realistic names so the
   *     UI does not look empty for first-time users.
   * ====================================================================== */
  const DEMO_TRACKS = [
    { title: "Neon Skyline",          artist: "Aurora Knox",       album: "Midnight Cartography",  duration: 217 },
    { title: "Glass Cathedral",       artist: "Aurora Knox",       album: "Midnight Cartography",  duration: 243 },
    { title: "Latitude 49",           artist: "Aurora Knox",       album: "Midnight Cartography",  duration: 198 },
    { title: "Boreal Drift",          artist: "Aurora Knox",       album: "Midnight Cartography",  duration: 312 },
    { title: "Subarctic Bloom",       artist: "Aurora Knox",       album: "Midnight Cartography",  duration: 256 },
    { title: "Velvet Equation",       artist: "Halcyon & Ash",     album: "Slow Burn",             duration: 281 },
    { title: "Long Way Home",         artist: "Halcyon & Ash",     album: "Slow Burn",             duration: 234 },
    { title: "Photograph in Reverse", artist: "Halcyon & Ash",     album: "Slow Burn",             duration: 189 },
    { title: "Marrow",                artist: "Halcyon & Ash",     album: "Slow Burn",             duration: 263 },
    { title: "August Postcard",       artist: "Halcyon & Ash",     album: "Slow Burn",             duration: 211 },
    { title: "Hydraulic Sun",         artist: "Lattice Foundry",   album: "Carbon Echoes",         duration: 354 },
    { title: "Steel Lullaby",         artist: "Lattice Foundry",   album: "Carbon Echoes",         duration: 297 },
    { title: "Reactor Garden",        artist: "Lattice Foundry",   album: "Carbon Echoes",         duration: 408 },
    { title: "Concrete Tide",         artist: "Lattice Foundry",   album: "Carbon Echoes",         duration: 318 },
    { title: "Subroutine 7",          artist: "Lattice Foundry",   album: "Carbon Echoes",         duration: 245 },
    { title: "Frostlight",            artist: "Sable Quartz",      album: "Polar Inversion",       duration: 273 },
    { title: "Antarctic Air Mail",    artist: "Sable Quartz",      album: "Polar Inversion",       duration: 308 },
    { title: "White Wolf Suite",      artist: "Sable Quartz",      album: "Polar Inversion",       duration: 421 },
    { title: "Saltwater Atlas",       artist: "Sable Quartz",      album: "Polar Inversion",       duration: 254 },
    { title: "Citrus Static",         artist: "Toy Compass",       album: "Pocket Theatre",        duration: 167 },
    { title: "Honey Loom",            artist: "Toy Compass",       album: "Pocket Theatre",        duration: 192 },
    { title: "Paper Lantern Parade",  artist: "Toy Compass",       album: "Pocket Theatre",        duration: 224 },
    { title: "Marmalade Sky",         artist: "Toy Compass",       album: "Pocket Theatre",        duration: 178 },
    { title: "Tiny Architect",        artist: "Toy Compass",       album: "Pocket Theatre",        duration: 201 },
    { title: "Bay Window",            artist: "Toy Compass",       album: "Pocket Theatre",        duration: 235 },
    { title: "Tetragram",             artist: "Vellum Hours",      album: "Quiet Mathematics",     duration: 339 },
    { title: "Asymptote",             artist: "Vellum Hours",      album: "Quiet Mathematics",     duration: 295 },
    { title: "Convex / Concave",      artist: "Vellum Hours",      album: "Quiet Mathematics",     duration: 412 },
    { title: "Manifold",              artist: "Vellum Hours",      album: "Quiet Mathematics",     duration: 268 },
    { title: "Boundary Layer",        artist: "Vellum Hours",      album: "Quiet Mathematics",     duration: 247 },
  ];

  /* =========================================================================
   * 3.  AUDIO ENGINE
   *     Wraps two HTMLAudioElement nodes and routes them through the EQ.
   *     Two elements allow short crossfades between tracks.
   * ====================================================================== */
  class AudioEngine {
    constructor(elA, elB) {
      this.elA = elA;
      this.elB = elB;
      this.activeEl = elA;
      this.idleEl   = elB;

      this.ctx = null;
      this.srcA = null;
      this.srcB = null;
      this.gainA = null;
      this.gainB = null;
      this.master = null;
      this.eq = [];
      this.analyser = null;

      this.volume = 0.8;
      this.muted = false;

      this._listeners = new Map(); // event name -> Set of fn
    }

    /**
     * Lazily set up the AudioContext on first user gesture so autoplay
     * policies don't break us.
     */
    _ensureCtx() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        // Fallback: no Web Audio. Visualizer / EQ will be disabled.
        this.ctx = null;
        return;
      }
      this.ctx = new Ctx();
      this.srcA = this.ctx.createMediaElementSource(this.elA);
      this.srcB = this.ctx.createMediaElementSource(this.elB);
      this.gainA = this.ctx.createGain();
      this.gainB = this.ctx.createGain();
      this.gainA.gain.value = 1;
      this.gainB.gain.value = 0;

      // EQ chain
      const merge = this.ctx.createGain();
      this.srcA.connect(this.gainA).connect(merge);
      this.srcB.connect(this.gainB).connect(merge);

      EQ_BANDS.forEach((b, i) => {
        const f = this.ctx.createBiquadFilter();
        f.type = b.type;
        f.frequency.value = b.freq;
        f.gain.value = 0;
        f.Q.value = 1;
        this.eq.push(f);
      });
      // chain merge -> eq[0] -> eq[1] -> ... -> master
      let prev = merge;
      this.eq.forEach((f) => { prev.connect(f); prev = f; });

      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      prev.connect(this.master);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.78;
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }

    on(name, fn) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set());
      this._listeners.get(name).add(fn);
    }
    off(name, fn) {
      const s = this._listeners.get(name);
      if (s) s.delete(fn);
    }
    _emit(name, data) {
      const s = this._listeners.get(name);
      if (!s) return;
      s.forEach((fn) => { try { fn(data); } catch (_) {} });
    }

    bindEvents() {
      [this.elA, this.elB].forEach((el) => {
        el.addEventListener("timeupdate", () => {
          if (el !== this.activeEl) return;
          this._emit("timeupdate", { time: el.currentTime, duration: el.duration });
        });
        el.addEventListener("loadedmetadata", () => {
          if (el !== this.activeEl) return;
          this._emit("loadedmetadata", { duration: el.duration });
        });
        el.addEventListener("ended", () => {
          if (el !== this.activeEl) return;
          this._emit("ended");
        });
        el.addEventListener("play",  () => { if (el === this.activeEl) this._emit("play"); });
        el.addEventListener("pause", () => { if (el === this.activeEl) this._emit("pause"); });
        el.addEventListener("error", () => {
          if (el === this.activeEl) this._emit("error", { error: el.error });
        });
        el.addEventListener("progress", () => {
          if (el !== this.activeEl) return;
          let buf = 0;
          try {
            if (el.buffered.length) buf = el.buffered.end(el.buffered.length - 1);
          } catch (_) {}
          this._emit("buffer", { buf, duration: el.duration });
        });
      });
    }

    /**
     * Load a track into the active element (no crossfade) and play.
     */
    async load(url) {
      this._ensureCtx();
      if (this.ctx && this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (_) {}
      }
      const el = this.activeEl;
      el.src = url;
      el.load();
      try {
        await el.play();
      } catch (_) {
        // Autoplay refused; user must press play
      }
    }

    /**
     * Load a track via crossfade. Plays the new track on the idle element,
     * fades it in while fading active out.
     */
    async crossfade(url) {
      this._ensureCtx();
      if (!this.ctx || !this.gainA || !this.gainB) {
        return this.load(url);
      }
      try { if (this.ctx.state === "suspended") await this.ctx.resume(); } catch (_) {}
      const next = this.idleEl;
      next.src = url;
      next.load();
      try { await next.play(); } catch (_) {}
      const t0 = this.ctx.currentTime;
      const t1 = t0 + CROSSFADE_MS / 1000;
      const activeIsA = this.activeEl === this.elA;
      const fromGain = activeIsA ? this.gainA : this.gainB;
      const toGain   = activeIsA ? this.gainB : this.gainA;
      try {
        fromGain.gain.cancelScheduledValues(t0);
        toGain.gain.cancelScheduledValues(t0);
        fromGain.gain.setValueAtTime(fromGain.gain.value, t0);
        toGain.gain.setValueAtTime(toGain.gain.value, t0);
        fromGain.gain.linearRampToValueAtTime(0, t1);
        toGain.gain.linearRampToValueAtTime(1, t1);
      } catch (_) {}
      // Swap active references after fade finishes
      const oldActive = this.activeEl;
      this.activeEl = next;
      this.idleEl   = oldActive;
      setTimeout(() => {
        try { oldActive.pause(); oldActive.currentTime = 0; } catch (_) {}
      }, CROSSFADE_MS + 60);
    }

    play()  { this._ensureCtx(); if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); return this.activeEl.play(); }
    pause() { this.activeEl.pause(); }
    stop()  {
      try {
        this.activeEl.pause();
        this.activeEl.currentTime = 0;
      } catch (_) {}
    }

    isPlaying() {
      const el = this.activeEl;
      return el && !el.paused && !el.ended && el.readyState > 2;
    }

    seek(t) {
      try { this.activeEl.currentTime = clamp(t, 0, this.activeEl.duration || 0); } catch (_) {}
    }
    seekRel(d) {
      try { this.activeEl.currentTime = clamp(this.activeEl.currentTime + d, 0, this.activeEl.duration || 0); } catch (_) {}
    }

    setVolume(v) {
      this.volume = clamp(v, 0, 1);
      if (this.master) {
        this.master.gain.value = this.muted ? 0 : this.volume;
      } else {
        this.elA.volume = this.muted ? 0 : this.volume;
        this.elB.volume = this.muted ? 0 : this.volume;
      }
    }

    setMuted(m) {
      this.muted = !!m;
      this.setVolume(this.volume);
    }

    setEqGain(idx, db) {
      if (this.eq[idx]) {
        this.eq[idx].gain.value = clamp(db, -12, 12);
      }
    }

    setEqPreset(name) {
      const arr = EQ_PRESETS[name];
      if (!arr) return null;
      arr.forEach((g, i) => this.setEqGain(i, g));
      return arr;
    }

    getAnalyser() { return this.analyser; }
    getDuration() { return this.activeEl.duration || 0; }
    getCurrent()  { return this.activeEl.currentTime || 0; }
  }

  /* =========================================================================
   * 4.  LIBRARY MANAGER
   *     Holds tracks + playlists. Persists to FileSystem at LIBRARY_PATH.
   * ====================================================================== */
  class Library {
    constructor() {
      this.tracks    = []; /* [{ id, url, title, artist, album, duration, added, fsPath?, file? }] */
      this.playlists = []; /* [{ id, name, trackIds: [] }] */
      this._listeners = new Set();
      this._dirty = false;
      this._urlCache = new Map(); // id -> objectURL
    }

    on(fn)  { this._listeners.add(fn); }
    off(fn) { this._listeners.delete(fn); }
    _emit() { this._listeners.forEach((fn) => { try { fn(); } catch (_) {} }); }

    /** Persist library metadata to FS. URL refs to in-memory blobs are NOT saved. */
    save() {
      const fs = window.FileSystem;
      if (!fs) return;
      try {
        // Ensure /Music exists
        if (!fs.exists("/Music")) {
          try { fs.createFolder("/Music"); } catch (_) {}
        }
        const out = {
          version: 1,
          updated: Date.now(),
          tracks: this.tracks.filter((t) => !t.demo).map((t) => ({
            id:       t.id,
            title:    t.title,
            artist:   t.artist,
            album:    t.album,
            duration: t.duration,
            added:    t.added,
            fsPath:   t.fsPath || null,
          })),
          playlists: this.playlists.map((p) => ({
            id: p.id, name: p.name, trackIds: p.trackIds.slice(),
          })),
        };
        fs.writeFile(LIBRARY_PATH, JSON.stringify(out));
        this._dirty = false;
      } catch (e) { /* swallow */ }
    }

    load() {
      const fs = window.FileSystem;
      if (!fs) return;
      try {
        if (!fs.exists(LIBRARY_PATH)) return;
        const text = fs.readFile(LIBRARY_PATH);
        const obj = JSON.parse(text);
        if (!obj || !Array.isArray(obj.tracks)) return;
        // We can only resurrect tracks with an fsPath (where the file is still on FS).
        this.tracks = obj.tracks.map((t) => ({
          id: t.id || uid("trk"),
          title: t.title || "Untitled",
          artist: t.artist || "Unknown",
          album: t.album || "",
          duration: t.duration || 0,
          added: t.added || Date.now(),
          fsPath: t.fsPath || null,
          url: t.fsPath ? this._fsPathToUrl(t.fsPath) : null,
          demo: false,
        })).filter((t) => !!t.url || !!t.fsPath);
        this.playlists = (obj.playlists || []).map((p) => ({
          id: p.id || uid("pl"), name: p.name || "Playlist", trackIds: p.trackIds || [],
        }));
        this._emit();
      } catch (_) { /* fine */ }
    }

    _fsPathToUrl(path) {
      const fs = window.FileSystem;
      if (!fs) return null;
      try {
        const text = fs.readFile(path);
        if (typeof text === "string" && text.startsWith("data:audio/")) return text;
        if (typeof text === "string" && text.startsWith("blob:"))       return text;
        // Plain raw text won't play; bail.
        return null;
      } catch (_) { return null; }
    }

    addTracks(tracks) {
      tracks.forEach((t) => {
        const exists = this.tracks.some((x) => x.url === t.url || (x.fsPath && x.fsPath === t.fsPath));
        if (!exists) this.tracks.push(t);
      });
      this._dirty = true;
      this._emit();
      this.save();
    }

    addFile(file) {
      const url = URL.createObjectURL(file);
      const meta = metaFromName(file.name);
      const t = {
        id: uid("trk"),
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: 0,
        added: Date.now(),
        url, file, demo: false,
        sourceName: file.name,
      };
      this._urlCache.set(t.id, url);
      // probe duration in background
      this._probeDuration(t);
      this.addTracks([t]);
      return t;
    }

    addFiles(files) {
      const arr = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const ext = getExt(f.name);
        if (AUDIO_EXTS.indexOf(ext) === -1 && !/^audio\//.test(f.type)) continue;
        arr.push(this.addFile(f));
      }
      return arr;
    }

    addFsTrack(path) {
      const fs = window.FileSystem;
      if (!fs) return null;
      let url = null;
      try {
        const text = fs.readFile(path);
        if (typeof text === "string" && text.startsWith("data:audio/")) {
          url = text;
        }
      } catch (_) { return null; }
      if (!url) return null;
      const meta = metaFromName(basename(path));
      const t = {
        id: uid("trk"),
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        duration: 0,
        added: Date.now(),
        url, fsPath: path, demo: false,
      };
      this._probeDuration(t);
      this.addTracks([t]);
      return t;
    }

    _probeDuration(track) {
      if (!track.url) return;
      const a = new Audio();
      a.preload = "metadata";
      a.src = track.url;
      a.addEventListener("loadedmetadata", () => {
        track.duration = a.duration || 0;
        this._emit();
      }, { once: true });
      // No need to remove on error
    }

    removeTrack(id) {
      const t = this.tracks.find((x) => x.id === id);
      if (!t) return;
      this.tracks = this.tracks.filter((x) => x.id !== id);
      this.playlists.forEach((p) => {
        p.trackIds = p.trackIds.filter((tid) => tid !== id);
      });
      const u = this._urlCache.get(id);
      if (u) { try { URL.revokeObjectURL(u); } catch (_) {} this._urlCache.delete(id); }
      this._emit();
      this.save();
    }

    createPlaylist(name) {
      const p = { id: uid("pl"), name: name || ("Playlist " + (this.playlists.length + 1)), trackIds: [] };
      this.playlists.push(p);
      this._emit();
      this.save();
      return p;
    }

    deletePlaylist(id) {
      this.playlists = this.playlists.filter((p) => p.id !== id);
      this._emit();
      this.save();
    }

    renamePlaylist(id, name) {
      const p = this.playlists.find((p) => p.id === id);
      if (p) { p.name = name; this._emit(); this.save(); }
    }

    addToPlaylist(plId, trackId) {
      const p = this.playlists.find((p) => p.id === plId);
      if (!p) return;
      if (p.trackIds.indexOf(trackId) === -1) p.trackIds.push(trackId);
      this._emit();
      this.save();
    }

    removeFromPlaylist(plId, trackId) {
      const p = this.playlists.find((p) => p.id === plId);
      if (!p) return;
      p.trackIds = p.trackIds.filter((id) => id !== trackId);
      this._emit();
      this.save();
    }

    getById(id) { return this.tracks.find((t) => t.id === id) || null; }

    getByPlaylist(id) {
      const p = this.playlists.find((p) => p.id === id);
      if (!p) return [];
      return p.trackIds.map((tid) => this.getById(tid)).filter(Boolean);
    }

    getAlbumTracks(album) {
      return this.tracks.filter((t) => t.album === album);
    }

    getArtistTracks(artist) {
      return this.tracks.filter((t) => t.artist === artist);
    }

    getAlbums() {
      const set = new Map();
      this.tracks.forEach((t) => {
        const key = t.album || "Unknown Album";
        if (!set.has(key)) set.set(key, { name: key, artist: t.artist, count: 0 });
        set.get(key).count++;
      });
      return Array.from(set.values());
    }

    getArtists() {
      const set = new Map();
      this.tracks.forEach((t) => {
        const key = t.artist || "Unknown";
        if (!set.has(key)) set.set(key, { name: key, count: 0 });
        set.get(key).count++;
      });
      return Array.from(set.values());
    }

    populateDemo() {
      const now = Date.now();
      this.tracks = DEMO_TRACKS.map((d, i) => ({
        id: "demo_" + i,
        title: d.title, artist: d.artist, album: d.album,
        duration: d.duration,
        added: now - (DEMO_TRACKS.length - i) * 60000,
        url: null, demo: true,
      }));
      this._emit();
    }

    isAllDemo() {
      return this.tracks.length > 0 && this.tracks.every((t) => t.demo);
    }
  }

  /* =========================================================================
   * 5.  VISUALIZER
   * ====================================================================== */
  class Visualizer {
    constructor(canvas, getAnalyser) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.getAnalyser = getAnalyser;
      this.mode = "bars";
      this._raf = null;
      this._buf = null;
      this._tbuf = null;
      this._running = false;
    }

    start() {
      if (this._running) return;
      this._running = true;
      const tick = () => {
        if (!this._running) return;
        this._render();
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      const ctx = this.ctx;
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    setMode(m) { if (VIS_MODES.indexOf(m) !== -1) this.mode = m; }
    cycleMode() { this.mode = (this.mode === "bars" ? "circle" : "bars"); }

    resize() {
      const c = this.canvas;
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(40, Math.floor(r.width  * dpr));
      const h = Math.max(40, Math.floor(r.height * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w; c.height = h;
      }
    }

    _render() {
      this.resize();
      const a = this.getAnalyser();
      if (!a) {
        this._renderIdle();
        return;
      }
      if (this.mode === "circle") this._renderCircle(a);
      else                        this._renderBars(a);
    }

    _renderIdle() {
      const ctx = this.ctx;
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.font = (12 * (window.devicePixelRatio || 1)) + "px Inter, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No audio source", w / 2, h / 2);
    }

    _renderBars(analyser) {
      if (!this._buf || this._buf.length !== analyser.frequencyBinCount) {
        this._buf = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this._buf);
      const ctx = this.ctx;
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      const N = 60;
      const step = Math.floor(this._buf.length / N);
      const gap = Math.max(1, Math.floor(w / N * 0.18));
      const bw  = (w - gap * (N - 1)) / N;
      for (let i = 0; i < N; i++) {
        // Average a small range of bins
        let sum = 0;
        for (let j = 0; j < step; j++) sum += this._buf[i * step + j] || 0;
        const v = sum / step / 255;
        const bh = Math.max(2, v * h * 0.95);
        const x  = i * (bw + gap);
        const y  = h - bh;
        const grd = ctx.createLinearGradient(x, h, x, y);
        grd.addColorStop(0, "#1ed760");
        grd.addColorStop(0.6, "#4f8ef7");
        grd.addColorStop(1, "#b66dff");
        ctx.fillStyle = grd;
        ctx.fillRect(x, y, bw, bh);
        // mirrored top-cap line
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillRect(x, y, bw, 2);
      }
    }

    _renderCircle(analyser) {
      if (!this._tbuf || this._tbuf.length !== analyser.fftSize) {
        this._tbuf = new Uint8Array(analyser.fftSize);
      }
      if (!this._buf || this._buf.length !== analyser.frequencyBinCount) {
        this._buf = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteTimeDomainData(this._tbuf);
      analyser.getByteFrequencyData(this._buf);
      const ctx = this.ctx;
      const w = this.canvas.width, h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const baseR = Math.min(w, h) * 0.25;
      // Frequency ring
      const N = 96;
      const step = Math.floor(this._buf.length / N);
      ctx.lineWidth = 2;
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += this._buf[i * step + j] || 0;
        const v = sum / step / 255;
        const ang = (i / N) * Math.PI * 2 - Math.PI / 2;
        const inner = baseR;
        const outer = baseR + v * (Math.min(w, h) * 0.22);
        const x1 = cx + Math.cos(ang) * inner;
        const y1 = cy + Math.sin(ang) * inner;
        const x2 = cx + Math.cos(ang) * outer;
        const y2 = cy + Math.sin(ang) * outer;
        const hue = (i / N) * 360;
        ctx.strokeStyle = "hsl(" + hue + ",80%,60%)";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      // Center waveform
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const len = this._tbuf.length;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const ang = t * Math.PI * 2 - Math.PI / 2;
        const v = (this._tbuf[i] - 128) / 128;
        const r = baseR * 0.9 + v * baseR * 0.4;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  /* =========================================================================
   * 6.  MAIN APP
   * ====================================================================== */
  class SoundWave {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts || {};
      this._unmounted = false;

      this.lib    = new Library();
      this.engine = null;
      this.viz    = null;

      // Playback state
      this.state = {
        currentId:    null,
        isPlaying:    false,
        repeatMode:   "off", /* off | one | all */
        shuffle:      false,
        queue:        [],    /* track ids */
        history:      [],    /* recently played ids */
        view:         "all", /* all | albums | artists | queue | equalizer | visualizer | playlist:<id> | album:<name> | artist:<name> */
        sort:         "title",
        search:       "",
        miniMode:     false,
        eqEnabled:    true,
        currentEq:    "Flat",
        eqGains:      [0, 0, 0, 0, 0],
      };

      // DOM cache
      this.dom = {};

      // Event removers
      this._handlers = [];
    }

    /* --------------------------------------------------------------------
     * 6.1 MOUNT / UNMOUNT
     * ----------------------------------------------------------------- */
    mount() {
      this.root.innerHTML = "";
      this._loadTemplate(this.root).then(() => {
        this._cacheDom();
        this._initEngine();
        this._initViz();
        this._wireSidebar();
        this._wireControls();
        this._wireSearch();
        this._wireKeyboard();
        this._wireDragDrop();

        // Load library; if empty, populate demo
        this.lib.load();
        if (!this.lib.tracks.length) this.lib.populateDemo();
        this.lib.on(() => {
          this._renderPlaylists();
          this._renderList();
          this._renderQueue();
          this._renderFakeBanner();
        });
        this._renderPlaylists();
        this._renderList();
        this._renderQueue();
        this._renderFakeBanner();

        // If a path was passed, try to open it
        if (this.opts && this.opts.openPath) {
          const t = this.lib.addFsTrack(this.opts.openPath);
          if (t) this.playTrack(t.id);
        }
      }).catch((err) => {
        console.error("[SoundWave] mount error:", err);
        this.root.innerHTML = '<div style="padding:24px;color:#fff;">Failed to mount SoundWave: ' + escapeHtml(err && err.message) + '</div>';
      });
    }

    destroy() {
      this._unmounted = true;
      if (this.engine) {
        try { this.engine.pause(); } catch (_) {}
      }
      if (this.viz) this.viz.stop();
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
     * 6.2 TEMPLATE LOADING
     * ----------------------------------------------------------------- */
    _loadTemplate(root) {
      return new Promise((resolve) => {
        const url = "apps/musicPlayer/musicPlayer.html";
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 400) {
            root.innerHTML = xhr.responseText;
          } else {
            root.innerHTML = this._fallbackTemplate();
          }
          this._injectStylesheet("apps/musicPlayer/musicPlayer.css");
          resolve();
        };
        xhr.onerror = () => {
          root.innerHTML = this._fallbackTemplate();
          this._injectStylesheet("apps/musicPlayer/musicPlayer.css");
          resolve();
        };
        xhr.send();
      });
    }

    _injectStylesheet(href) {
      if (document.querySelector('link[data-mp-css]')) return;
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.dataset.mpCss = "1";
      document.head.appendChild(l);
    }

    _fallbackTemplate() {
      return '<div class="mp-app" data-mp-root>' +
        '<div class="mp-full" data-mp-full>' +
        '<div class="mp-main">' +
        '<aside class="mp-sidebar"><div data-mp-playlists></div></aside>' +
        '<section class="mp-center"><div data-mp-list></div></section>' +
        '<aside class="mp-now"></aside>' +
        '</div>' +
        '<footer class="mp-controls"></footer>' +
        '</div>' +
        '<audio data-mp-audio-a></audio><audio data-mp-audio-b></audio>' +
        '</div>';
    }

    /* --------------------------------------------------------------------
     * 6.3 DOM CACHE
     * ----------------------------------------------------------------- */
    _cacheDom() {
      const r = this.root;
      const $  = (s) => r.querySelector(s);
      const $$ = (s) => Array.from(r.querySelectorAll(s));
      this.dom = {
        appRoot:     $('[data-mp-root]'),
        full:        $('[data-mp-full]'),
        miniRoot:    $('[data-mp-mini-root]'),

        sidebar:     $('[data-mp-sidebar]'),
        nav:         $('[data-mp-nav]'),
        navItems:    $$('[data-mp-view]'),
        playlists:   $('[data-mp-playlists]'),
        newPlaylistBtn: $('[data-mp-new-playlist]'),

        viewTitle:   $('[data-mp-view-title]'),
        search:      $('[data-mp-search]'),
        sort:        $('[data-mp-sort]'),
        list:        $('[data-mp-list]'),
        listHead:    r.querySelector('.mp-list-head'),

        fakeBanner:  $('[data-mp-fake-banner]'),
        fakeLoad2:   $('[data-mp-load-2]'),

        nowArt:      $('[data-mp-now-art]'),
        nowArtPh:    $('[data-mp-now-art-placeholder]'),
        nowEqBars:   $('[data-mp-eqbars]'),
        nowTitle:    $('[data-mp-now-title]'),
        nowArtist:   $('[data-mp-now-artist]'),
        nowAlbum:    $('[data-mp-now-album]'),
        visCanvas:   $('[data-mp-vis]'),
        visToggle:   $('[data-mp-vis-toggle]'),

        queueList:   $('[data-mp-queue-list]'),
        queueClear:  $('[data-mp-clear-queue]'),

        ctrlsLeft:   r.querySelector('.mp-ctrls-left'),
        miniArt:     $('[data-mp-mini-art]'),
        miniTitle:   $('[data-mp-mini-title]'),
        miniArtist:  $('[data-mp-mini-artist]'),

        btnShuffle:  $('[data-mp-shuffle]'),
        btnPrev:     $('[data-mp-prev]'),
        btnPlay:     $('[data-mp-play]'),
        btnNext:     $('[data-mp-next]'),
        btnRepeat:   $('[data-mp-repeat]'),

        timeCur:     $('[data-mp-time-cur]'),
        timeTot:     $('[data-mp-time-tot]'),
        progress:    $('[data-mp-progress]'),
        progressFill:$('[data-mp-progress-fill]'),
        progressBuf: $('[data-mp-progress-buf]'),
        progressKnob:$('[data-mp-progress-knob]'),
        progressTip: $('[data-mp-progress-tip]'),

        btnVisToggle2: $('[data-mp-vis-toggle-2]'),
        btnEqToggle:   $('[data-mp-eq-toggle]'),
        btnMute:       $('[data-mp-mute]'),
        volume:        $('[data-mp-volume]'),
        btnMini:       $('[data-mp-mini]'),

        // Mini mode
        mini2Art:     $('[data-mp-mini2-art]'),
        mini2Title:   $('[data-mp-mini2-title]'),
        mini2Artist:  $('[data-mp-mini2-artist]'),
        btnPrevMini:  $('[data-mp-prev-mini]'),
        btnPlayMini:  $('[data-mp-play-mini]'),
        btnNextMini:  $('[data-mp-next-mini]'),
        btnRestore:   $('[data-mp-restore]'),
        miniProgress: $('[data-mp-mini-progress]'),
        miniProgressFill: $('[data-mp-mini-progress-fill]'),

        // Modal
        modalRoot:    $('[data-mp-modal-root]'),
        modalTitle:   $('[data-mp-modal-title]'),
        modalBody:    $('[data-mp-modal-body]'),
        modalClose:   $('[data-mp-modal-close]'),

        // Audio
        audioA:       $('[data-mp-audio-a]'),
        audioB:       $('[data-mp-audio-b]'),

        loadBtn:      $('[data-mp-load]'),
        fileInput:    $('[data-mp-file-input]'),
      };
    }

    /* --------------------------------------------------------------------
     * 6.4 ENGINE INIT
     * ----------------------------------------------------------------- */
    _initEngine() {
      this.engine = new AudioEngine(this.dom.audioA, this.dom.audioB);
      this.engine.bindEvents();
      this.engine.on("timeupdate", (e) => this._onTimeUpdate(e));
      this.engine.on("loadedmetadata", (e) => this._onLoadedMeta(e));
      this.engine.on("ended", () => this._onEnded());
      this.engine.on("play",  () => { this.state.isPlaying = true;  this._reflectPlayState(); if (this.viz) this.viz.start(); })
      this.engine.on("pause", () => { this.state.isPlaying = false; this._reflectPlayState(); });
      this.engine.on("buffer", (e) => this._onBuffer(e));
      this.engine.on("error", () => {
        // Track failed; advance
        this._next(true);
      });

      // Initial volume
      this.engine.setVolume(0.8);
    }

    /* --------------------------------------------------------------------
     * 6.5 VISUALIZER INIT
     * ----------------------------------------------------------------- */
    _initViz() {
      if (!this.dom.visCanvas) return;
      this.viz = new Visualizer(this.dom.visCanvas, () => this.engine && this.engine.analyser);
      // Resize observer
      try {
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(() => this.viz.resize());
          ro.observe(this.dom.visCanvas);
          this._ro = ro;
        }
      } catch (_) {}
      this.viz._renderIdle();
    }

    /* --------------------------------------------------------------------
     * 6.6 SIDEBAR / NAV
     * ----------------------------------------------------------------- */
    _wireSidebar() {
      const d = this.dom;
      d.navItems.forEach((b) => {
        this.on(b, "click", () => this._setView(b.dataset.mpView));
      });
      if (d.newPlaylistBtn) {
        this.on(d.newPlaylistBtn, "click", () => this._dialogNewPlaylist());
      }
      if (d.loadBtn) {
        this.on(d.loadBtn, "click", () => d.fileInput && d.fileInput.click());
      }
      if (d.fileInput) {
        this.on(d.fileInput, "change", (ev) => {
          const files = ev.target.files;
          if (files && files.length) this.lib.addFiles(files);
          ev.target.value = "";
        });
      }
      if (d.fakeLoad2) {
        this.on(d.fakeLoad2, "click", () => d.fileInput && d.fileInput.click());
      }
    }

    _setView(view) {
      this.state.view = view;
      this._renderActiveNav();
      this._renderList();
      const titleMap = {
        all:        "All Songs",
        albums:     "Albums",
        artists:    "Artists",
        queue:      "Queue",
        equalizer:  "Equalizer",
        visualizer: "Visualizer",
      };
      let title = titleMap[view];
      if (!title && view.startsWith("playlist:")) {
        const id = view.slice("playlist:".length);
        const p = this.lib.playlists.find((p) => p.id === id);
        title = p ? p.name : "Playlist";
      } else if (!title && view.startsWith("album:")) {
        title = view.slice("album:".length);
      } else if (!title && view.startsWith("artist:")) {
        title = view.slice("artist:".length);
      }
      if (this.dom.viewTitle) this.dom.viewTitle.textContent = title || "Library";

      if (view === "equalizer")  this._showEqModal();
      if (view === "visualizer") {
        // Visualizer is always visible in the right panel; nothing else to do.
      }
    }

    _renderActiveNav() {
      const d = this.dom;
      d.navItems.forEach((b) => b.classList.toggle("active", b.dataset.mpView === this.state.view));
      // Playlists active state
      d.playlists.querySelectorAll(".mp-pl-btn").forEach((b) => {
        const pid = b.dataset.plid;
        b.classList.toggle("active", this.state.view === ("playlist:" + pid));
      });
    }

    _renderPlaylists() {
      const d = this.dom;
      if (!d.playlists) return;
      d.playlists.innerHTML = "";
      this.lib.playlists.forEach((p) => {
        const b = document.createElement("button");
        b.className = "mp-pl-btn";
        b.dataset.plid = p.id;
        b.textContent = "📋 " + p.name + "  (" + p.trackIds.length + ")";
        b.title = p.name;
        b.addEventListener("click", () => this._setView("playlist:" + p.id));
        b.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          this._showContextMenu(ev, [
            { label: "Rename", action: () => {
              const name = prompt("Rename playlist:", p.name);
              if (name) this.lib.renamePlaylist(p.id, name);
            }},
            { label: "Delete", action: () => {
              if (confirm("Delete playlist '" + p.name + "'?")) this.lib.deletePlaylist(p.id);
            }},
          ]);
        });
        d.playlists.appendChild(b);
      });
      this._renderActiveNav();
    }

    /* --------------------------------------------------------------------
     * 6.7 LIST RENDERING
     * ----------------------------------------------------------------- */
    _currentTracks() {
      const v = this.state.view;
      if (v === "queue") {
        return this.state.queue.map((id) => this.lib.getById(id)).filter(Boolean);
      }
      if (v === "albums" || v === "artists") {
        // Will be rendered specially below
        return [];
      }
      let arr;
      if (v === "all") arr = this.lib.tracks.slice();
      else if (v.startsWith("playlist:")) arr = this.lib.getByPlaylist(v.slice(9));
      else if (v.startsWith("album:"))    arr = this.lib.getAlbumTracks(v.slice(6));
      else if (v.startsWith("artist:"))   arr = this.lib.getArtistTracks(v.slice(7));
      else                                arr = this.lib.tracks.slice();
      return this._applySearchSort(arr);
    }

    _applySearchSort(arr) {
      const q = this.state.search.trim().toLowerCase();
      if (q) {
        arr = arr.filter((t) =>
          (t.title || "").toLowerCase().includes(q) ||
          (t.artist || "").toLowerCase().includes(q) ||
          (t.album || "").toLowerCase().includes(q)
        );
      }
      const k = this.state.sort;
      arr.sort((a, b) => {
        if (k === "duration") return (a.duration || 0) - (b.duration || 0);
        if (k === "added")    return (a.added || 0) - (b.added || 0);
        const av = (a[k] || "").toLowerCase();
        const bv = (b[k] || "").toLowerCase();
        if (av < bv) return -1; if (av > bv) return 1; return 0;
      });
      return arr;
    }

    _renderList() {
      const d = this.dom;
      if (!d.list) return;
      d.list.innerHTML = "";
      const v = this.state.view;
      if (v === "albums")  return this._renderAlbums();
      if (v === "artists") return this._renderArtists();
      const tracks = this._currentTracks();
      if (!tracks.length) {
        d.list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">🎧</div><div>Nothing here yet.</div></div>';
        return;
      }
      tracks.forEach((t, i) => d.list.appendChild(this._buildRow(t, i + 1)));
    }

    _buildRow(t, num) {
      const row = document.createElement("div");
      row.className = "mp-row";
      if (t.demo) row.classList.add("dimmed");
      if (this.state.currentId === t.id) row.classList.add("playing");
      row.dataset.tid = t.id;
      row.innerHTML =
        '<div class="mp-row-num">' +
          '<span class="mp-row-num-text">' + num + '</span>' +
          '<span class="mp-row-eq"><span></span><span></span><span></span></span>' +
        '</div>' +
        '<div class="mp-row-art-wrap">' +
          '<div class="mp-row-art" style="background:' + gradientFor(t.album || t.artist || t.title) + '">' +
            (t.demo ? "♪" : "♬") +
          '</div>' +
        '</div>' +
        '<div class="mp-row-meta">' +
          '<div class="mp-row-title">' + escapeHtml(t.title) + '</div>' +
          '<div class="mp-row-artist">' + escapeHtml(t.artist) + '</div>' +
        '</div>' +
        '<div class="mp-row-album">' + escapeHtml(t.album) + '</div>' +
        '<div class="mp-row-dur">' + fmtTime(t.duration) + '</div>' +
        '<div class="mp-row-act">' +
          '<button class="mp-row-act-btn" title="More">⋯</button>' +
        '</div>';
      const dbl = () => this.playTrack(t.id);
      row.addEventListener("dblclick", dbl);
      const playOnce = (ev) => {
        // Single click on title = select; we use double click to play.
        if (ev.target.closest('.mp-row-act-btn')) return;
      };
      row.addEventListener("click", playOnce);
      // Right-click context menu
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this._rowContextMenu(ev, t);
      });
      const moreBtn = row.querySelector('.mp-row-act-btn');
      if (moreBtn) moreBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const r = moreBtn.getBoundingClientRect();
        this._rowContextMenu({ clientX: r.right, clientY: r.bottom }, t);
      });
      return row;
    }

    _renderAlbums() {
      const d = this.dom;
      const albums = this.lib.getAlbums();
      d.list.innerHTML = "";
      if (!albums.length) {
        d.list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">💿</div>No albums yet.</div>';
        return;
      }
      albums.forEach((al) => {
        const row = document.createElement("div");
        row.className = "mp-row";
        row.innerHTML =
          '<div class="mp-row-num"></div>' +
          '<div class="mp-row-art-wrap">' +
            '<div class="mp-row-art" style="background:' + gradientFor(al.name) + '">💿</div>' +
          '</div>' +
          '<div class="mp-row-meta">' +
            '<div class="mp-row-title">' + escapeHtml(al.name) + '</div>' +
            '<div class="mp-row-artist">' + escapeHtml(al.artist || "Various") + '</div>' +
          '</div>' +
          '<div class="mp-row-album">' + al.count + ' tracks</div>' +
          '<div class="mp-row-dur"></div>' +
          '<div class="mp-row-act"></div>';
        row.addEventListener("click", () => this._setView("album:" + al.name));
        d.list.appendChild(row);
      });
    }

    _renderArtists() {
      const d = this.dom;
      const artists = this.lib.getArtists();
      d.list.innerHTML = "";
      if (!artists.length) {
        d.list.innerHTML = '<div class="mp-empty"><div class="mp-empty-ico">🎤</div>No artists yet.</div>';
        return;
      }
      artists.forEach((ar) => {
        const row = document.createElement("div");
        row.className = "mp-row";
        row.innerHTML =
          '<div class="mp-row-num"></div>' +
          '<div class="mp-row-art-wrap">' +
            '<div class="mp-row-art" style="background:' + gradientFor(ar.name) + '">🎤</div>' +
          '</div>' +
          '<div class="mp-row-meta">' +
            '<div class="mp-row-title">' + escapeHtml(ar.name) + '</div>' +
            '<div class="mp-row-artist">' + ar.count + ' tracks</div>' +
          '</div>' +
          '<div class="mp-row-album"></div>' +
          '<div class="mp-row-dur"></div>' +
          '<div class="mp-row-act"></div>';
        row.addEventListener("click", () => this._setView("artist:" + ar.name));
        d.list.appendChild(row);
      });
    }

    _renderFakeBanner() {
      const fb = this.dom.fakeBanner;
      if (!fb) return;
      fb.hidden = !this.lib.isAllDemo();
    }

    /* --------------------------------------------------------------------
     * 6.8 ROW CONTEXT MENU
     * ----------------------------------------------------------------- */
    _rowContextMenu(ev, t) {
      const items = [];
      if (!t.demo && t.url) {
        items.push({ label: "▶ Play",       action: () => this.playTrack(t.id) });
        items.push({ label: "⏭ Play next",   action: () => this.playNext(t.id) });
        items.push({ label: "＋ Add to queue", action: () => this.addToQueue(t.id) });
      } else if (t.demo) {
        items.push({ label: "Demo track (no audio)", disabled: true });
      } else {
        items.push({ label: "▶ Play",       action: () => this.playTrack(t.id) });
        items.push({ label: "⏭ Play next",   action: () => this.playNext(t.id) });
        items.push({ label: "＋ Add to queue", action: () => this.addToQueue(t.id) });
      }
      items.push({ sep: true });
      // Add to playlist submenu
      this.lib.playlists.forEach((p) => {
        items.push({ label: "→ " + p.name, action: () => this.lib.addToPlaylist(p.id, t.id) });
      });
      if (this.lib.playlists.length === 0) {
        items.push({ label: "(no playlists)", disabled: true });
      }
      items.push({ label: "＋ New playlist…", action: () => {
        const name = prompt("Playlist name:");
        if (!name) return;
        const p = this.lib.createPlaylist(name);
        this.lib.addToPlaylist(p.id, t.id);
      }});
      items.push({ sep: true });
      items.push({ label: "🗑 Remove from library", action: () => this.lib.removeTrack(t.id) });
      this._showContextMenu(ev, items);
    }

    _showContextMenu(ev, items) {
      this._closeContextMenu();
      const m = document.createElement("div");
      m.className = "mp-context-menu";
      items.forEach((it) => {
        if (it.sep) {
          const s = document.createElement("div");
          s.className = "mp-cm-sep";
          m.appendChild(s);
          return;
        }
        const i = document.createElement("div");
        i.className = "mp-cm-item";
        if (it.disabled) i.style.opacity = "0.4";
        i.textContent = it.label;
        if (!it.disabled && it.action) {
          i.addEventListener("click", () => {
            this._closeContextMenu();
            it.action();
          });
        }
        m.appendChild(i);
      });
      m.style.left = (ev.clientX) + "px";
      m.style.top  = (ev.clientY) + "px";
      document.body.appendChild(m);
      this._cm = m;
      const close = () => this._closeContextMenu();
      setTimeout(() => {
        document.addEventListener("click", close, { once: true });
        document.addEventListener("contextmenu", close, { once: true });
      }, 0);
    }

    _closeContextMenu() {
      if (this._cm) {
        try { this._cm.remove(); } catch (_) {}
        this._cm = null;
      }
    }

    /* --------------------------------------------------------------------
     * 6.9 PLAYBACK CORE
     * ----------------------------------------------------------------- */
    playTrack(id) {
      const t = this.lib.getById(id);
      if (!t) return;
      if (t.demo || !t.url) {
        // Demo tracks have no audio. Show a hint instead of crashing.
        this.state.currentId = id;
        this._reflectMeta(t);
        this._reflectPlayState();
        if (window.Taskbar && window.Taskbar.toast) {
          window.Taskbar.toast({ title: "Demo track", body: "Load your own music to play this UI for real.", kind: "info" });
        }
        return;
      }
      this.state.history.push(this.state.currentId);
      this.state.currentId = id;
      this._reflectMeta(t);
      // Crossfade only when there is a current track playing
      if (this.engine.isPlaying()) this.engine.crossfade(t.url);
      else                          this.engine.load(t.url);
      this.state.isPlaying = true;
      this._reflectPlayState();
      this._renderList();
      this._renderQueue();
      if (this.viz) this.viz.start();
    }

    playPause() {
      if (!this.engine) return;
      if (!this.state.currentId && this.lib.tracks.length) {
        const first = this.lib.tracks.find((t) => !t.demo && t.url);
        if (first) { this.playTrack(first.id); return; }
        if (this.lib.tracks[0]) this.playTrack(this.lib.tracks[0].id);
        return;
      }
      if (this.engine.isPlaying()) this.engine.pause();
      else this.engine.play();
    }

    playNext(id) {
      const idx = this.state.queue.indexOf(id);
      if (idx !== -1) this.state.queue.splice(idx, 1);
      this.state.queue.unshift(id);
      this._renderQueue();
    }

    addToQueue(id) {
      this.state.queue.push(id);
      this._renderQueue();
    }

    clearQueue() {
      this.state.queue = [];
      this._renderQueue();
    }

    _next(auto) {
      // 1. queue is highest priority
      if (this.state.queue.length) {
        const id = this.state.queue.shift();
        this._renderQueue();
        this.playTrack(id);
        return;
      }
      // 2. shuffle / repeat-all / linear
      const list = this._currentPlaybackList();
      if (!list.length) return;
      if (this.state.shuffle) {
        const cands = list.filter((t) => t.id !== this.state.currentId);
        const pick  = cands[Math.floor(Math.random() * cands.length)] || list[0];
        this.playTrack(pick.id);
        return;
      }
      const idx = list.findIndex((t) => t.id === this.state.currentId);
      let nextIdx;
      if (idx === -1) nextIdx = 0;
      else            nextIdx = idx + 1;
      if (nextIdx >= list.length) {
        if (this.state.repeatMode === "all") nextIdx = 0;
        else                                 return; // end of playlist
      }
      this.playTrack(list[nextIdx].id);
    }

    _prev() {
      if (this.engine.getCurrent() > 3) {
        this.engine.seek(0);
        return;
      }
      const list = this._currentPlaybackList();
      if (!list.length) return;
      const idx = list.findIndex((t) => t.id === this.state.currentId);
      let prev = idx - 1;
      if (prev < 0) prev = this.state.repeatMode === "all" ? list.length - 1 : 0;
      this.playTrack(list[prev].id);
    }

    _currentPlaybackList() {
      const v = this.state.view;
      if (v === "queue" || v === "equalizer" || v === "visualizer") return this.lib.tracks;
      const list = this._currentTracks();
      return list.length ? list : this.lib.tracks;
    }

    /* --------------------------------------------------------------------
     * 6.10 ENGINE EVENT HANDLERS
     * ----------------------------------------------------------------- */
    _onLoadedMeta(e) {
      if (this.dom.timeTot) this.dom.timeTot.textContent = fmtTime(e.duration);
      const t = this.lib.getById(this.state.currentId);
      if (t && (!t.duration || t.duration === 0)) {
        t.duration = e.duration || 0;
        this._renderList();
      }
    }

    _onTimeUpdate(e) {
      const d = this.dom;
      const tot = e.duration || 0;
      const cur = e.time || 0;
      const pct = tot > 0 ? (cur / tot) : 0;
      if (d.timeCur) d.timeCur.textContent = fmtTime(cur);
      if (d.progressFill) d.progressFill.style.width = (pct * 100) + "%";
      if (d.progressKnob) d.progressKnob.style.left  = (pct * 100) + "%";
      if (d.miniProgressFill) d.miniProgressFill.style.width = (pct * 100) + "%";
    }

    _onBuffer(e) {
      const d = this.dom;
      const tot = e.duration || 0;
      if (d.progressBuf && tot > 0) {
        d.progressBuf.style.width = (clamp(e.buf / tot, 0, 1) * 100) + "%";
      }
    }

    _onEnded() {
      if (this.state.repeatMode === "one") {
        this.engine.seek(0);
        this.engine.play();
        return;
      }
      this._next(true);
    }

    /* --------------------------------------------------------------------
     * 6.11 CONTROL WIRING
     * ----------------------------------------------------------------- */
    _wireControls() {
      const d = this.dom;
      if (d.btnPlay)    this.on(d.btnPlay,    "click", () => this.playPause());
      if (d.btnPrev)    this.on(d.btnPrev,    "click", () => this._prev());
      if (d.btnNext)    this.on(d.btnNext,    "click", () => this._next());
      if (d.btnShuffle) this.on(d.btnShuffle, "click", () => this._toggleShuffle());
      if (d.btnRepeat)  this.on(d.btnRepeat,  "click", () => this._cycleRepeat());

      if (d.btnPlayMini) this.on(d.btnPlayMini, "click", () => this.playPause());
      if (d.btnPrevMini) this.on(d.btnPrevMini, "click", () => this._prev());
      if (d.btnNextMini) this.on(d.btnNextMini, "click", () => this._next());
      if (d.btnRestore)  this.on(d.btnRestore,  "click", () => this._toggleMini());

      if (d.btnMute) this.on(d.btnMute, "click", () => this._toggleMute());
      if (d.volume) this.on(d.volume, "input", () => {
        const v = parseInt(d.volume.value, 10) / 100;
        this.engine.setVolume(v);
        this._reflectVolume();
      });

      if (d.btnMini) this.on(d.btnMini, "click", () => this._toggleMini());
      if (d.btnVisToggle2) this.on(d.btnVisToggle2, "click", () => this.viz && this.viz.cycleMode());
      if (d.visToggle)     this.on(d.visToggle,     "click", () => this.viz && this.viz.cycleMode());
      if (d.btnEqToggle)   this.on(d.btnEqToggle,   "click", () => this._showEqModal());

      if (d.queueClear) this.on(d.queueClear, "click", () => this.clearQueue());

      // Progress bar interaction
      if (d.progress) {
        const seekFrom = (ev) => {
          const r = d.progress.getBoundingClientRect();
          const pct = clamp((ev.clientX - r.left) / r.width, 0, 1);
          this.engine.seek(pct * (this.engine.getDuration() || 0));
        };
        let dragging = false;
        this.on(d.progress, "mousedown", (ev) => { dragging = true; seekFrom(ev); });
        this.on(window,     "mouseup",   () => dragging = false);
        this.on(window,     "mousemove", (ev) => { if (dragging) seekFrom(ev); });
        this.on(d.progress, "mousemove", (ev) => {
          if (!d.progressTip) return;
          const r = d.progress.getBoundingClientRect();
          const pct = clamp((ev.clientX - r.left) / r.width, 0, 1);
          d.progressTip.hidden = false;
          d.progressTip.style.left = (pct * 100) + "%";
          d.progressTip.textContent = fmtTime(pct * (this.engine.getDuration() || 0));
        });
        this.on(d.progress, "mouseleave", () => {
          if (d.progressTip) d.progressTip.hidden = true;
        });
      }
    }

    _toggleMute() {
      this.engine.setMuted(!this.engine.muted);
      this._reflectVolume();
    }

    _reflectVolume() {
      const d = this.dom;
      const muted = this.engine.muted;
      const v = this.engine.volume;
      if (d.btnMute) {
        d.btnMute.textContent = muted || v === 0 ? "🔇" : (v < 0.4 ? "🔈" : v < 0.75 ? "🔉" : "🔊");
        d.btnMute.classList.toggle("active", muted);
      }
      if (d.volume) d.volume.value = Math.round(v * 100);
    }

    _toggleShuffle() {
      this.state.shuffle = !this.state.shuffle;
      this.dom.btnShuffle && this.dom.btnShuffle.classList.toggle("active", this.state.shuffle);
    }

    _cycleRepeat() {
      const seq = ["off", "all", "one"];
      const i = seq.indexOf(this.state.repeatMode);
      const next = seq[(i + 1) % seq.length];
      this.state.repeatMode = next;
      const r = this.dom.btnRepeat;
      if (r) {
        r.classList.toggle("active", next !== "off");
        r.textContent = next === "one" ? "🔂" : "🔁";
        r.title = "Repeat: " + next;
      }
    }

    _toggleMini() {
      this.state.miniMode = !this.state.miniMode;
      this.dom.full.hidden     =  this.state.miniMode;
      this.dom.miniRoot.hidden = !this.state.miniMode;
    }

    /* --------------------------------------------------------------------
     * 6.12 SEARCH
     * ----------------------------------------------------------------- */
    _wireSearch() {
      const d = this.dom;
      if (d.search) this.on(d.search, "input", () => {
        this.state.search = d.search.value;
        this._renderList();
      });
      if (d.sort) this.on(d.sort, "change", () => {
        this.state.sort = d.sort.value;
        this._renderList();
      });
    }

    /* --------------------------------------------------------------------
     * 6.13 KEYBOARD
     * ----------------------------------------------------------------- */
    _wireKeyboard() {
      this.on(window, "keydown", (ev) => {
        if (this._unmounted) return;
        if (!this._isActiveWindow()) return;
        const t = ev.target;
        const isField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (isField) return;
        const k = ev.key;
        switch (k) {
          case " ":
            ev.preventDefault(); this.playPause(); return;
          case "ArrowLeft":
            ev.preventDefault(); this.engine.seekRel(-5); return;
          case "ArrowRight":
            ev.preventDefault(); this.engine.seekRel(+5); return;
          case "ArrowUp":
            ev.preventDefault();
            this.engine.setVolume(clamp(this.engine.volume + 0.05, 0, 1));
            this._reflectVolume();
            return;
          case "ArrowDown":
            ev.preventDefault();
            this.engine.setVolume(clamp(this.engine.volume - 0.05, 0, 1));
            this._reflectVolume();
            return;
          case "n": case "N":
            ev.preventDefault(); this._next(); return;
          case "p": case "P":
            ev.preventDefault(); this._prev(); return;
          case "s": case "S":
            ev.preventDefault(); this._toggleShuffle(); return;
          case "r": case "R":
            ev.preventDefault(); this._cycleRepeat(); return;
          case "m": case "M":
            ev.preventDefault(); this._toggleMute(); return;
          case "Escape":
            this._closeContextMenu();
            this._closeModal();
            return;
        }
      });
    }

    _isActiveWindow() {
      const r = this.dom.appRoot;
      if (!r) return false;
      const w = r.closest('.window');
      if (!w) return false;
      return w.classList.contains("active") || w === document.activeElement || w.contains(document.activeElement);
    }

    /* --------------------------------------------------------------------
     * 6.14 DRAG & DROP — drop audio files onto window to import
     * ----------------------------------------------------------------- */
    _wireDragDrop() {
      const r = this.dom.appRoot;
      if (!r) return;
      this.on(r, "dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      });
      this.on(r, "drop", (ev) => {
        ev.preventDefault();
        const files = ev.dataTransfer && ev.dataTransfer.files;
        if (files && files.length) this.lib.addFiles(files);
      });
    }

    /* --------------------------------------------------------------------
     * 6.15 NOW-PLAYING REFLECT
     * ----------------------------------------------------------------- */
    _reflectMeta(t) {
      const d = this.dom;
      const title = t ? t.title : "Nothing Playing";
      const artist = t ? t.artist : "—";
      const album  = t ? t.album  : "—";
      if (d.nowTitle)    d.nowTitle.textContent    = title;
      if (d.nowArtist)   d.nowArtist.textContent   = artist;
      if (d.nowAlbum)    d.nowAlbum.textContent    = album;
      if (d.miniTitle)   d.miniTitle.textContent   = title;
      if (d.miniArtist)  d.miniArtist.textContent  = artist;
      if (d.mini2Title)  d.mini2Title.textContent  = title;
      if (d.mini2Artist) d.mini2Artist.textContent = artist;
      const grad = gradientFor(t ? (t.album || t.artist || t.title) : "blank");
      if (d.nowArt)   d.nowArt.style.background   = grad;
      if (d.miniArt)  d.miniArt.style.background  = grad;
      if (d.mini2Art) d.mini2Art.style.background = grad;
    }

    _reflectPlayState() {
      const d = this.dom;
      const playing = this.state.isPlaying;
      const sym = playing ? "⏸" : "▶";
      if (d.btnPlay)     d.btnPlay.textContent     = sym;
      if (d.btnPlayMini) d.btnPlayMini.textContent = sym;
      if (d.nowEqBars)   d.nowEqBars.classList.toggle("on", playing);
      if (this.viz) {
        if (playing) this.viz.start();
      }
    }

    /* --------------------------------------------------------------------
     * 6.16 QUEUE PANEL
     * ----------------------------------------------------------------- */
    _renderQueue() {
      const d = this.dom;
      if (!d.queueList) return;
      d.queueList.innerHTML = "";
      if (!this.state.queue.length) {
        d.queueList.innerHTML = '<div style="padding:14px;color:var(--mp-fg-3);font-size:12px;text-align:center;">Queue is empty</div>';
        return;
      }
      this.state.queue.forEach((id, i) => {
        const t = this.lib.getById(id);
        if (!t) return;
        const row = document.createElement("div");
        row.className = "mp-q-row";
        row.innerHTML =
          '<div class="mp-q-num">' + (i + 1) + '</div>' +
          '<div class="mp-q-title">' + escapeHtml(t.title) + ' — ' + escapeHtml(t.artist) + '</div>' +
          '<div class="mp-q-dur">' + fmtTime(t.duration) + '</div>' +
          '<button title="Remove">✕</button>';
        row.addEventListener("click", () => this.playTrack(id));
        const x = row.querySelector("button");
        if (x) x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.state.queue.splice(i, 1);
          this._renderQueue();
        });
        d.queueList.appendChild(row);
      });
    }

    /* --------------------------------------------------------------------
     * 6.17 EQ MODAL
     * ----------------------------------------------------------------- */
    _showEqModal() {
      const d = this.dom;
      if (!d.modalRoot || !d.modalBody || !d.modalTitle) return;
      d.modalTitle.textContent = "Equalizer";
      d.modalRoot.hidden = false;

      // Build content
      const presets = Object.keys(EQ_PRESETS);
      d.modalBody.innerHTML =
        '<div class="mp-eq">' +
          '<div class="mp-eq-presets" data-eq-presets>' +
            presets.map((n) => '<button class="mp-eq-preset' + (n === this.state.currentEq ? ' active' : '') + '" data-preset="' + escapeHtml(n) + '">' + escapeHtml(n) + '</button>').join("") +
          '</div>' +
          '<div class="mp-eq-bands">' +
            EQ_BANDS.map((b, i) => {
              const v = this.state.eqGains[i] || 0;
              return '<div class="mp-eq-band">' +
                '<input type="range" min="-12" max="12" step="0.5" value="' + v + '" data-band="' + i + '" />' +
                '<span class="mp-eq-band-val" data-band-val="' + i + '">' + (v >= 0 ? "+" : "") + v + ' dB</span>' +
                '<span class="mp-eq-band-label">' + escapeHtml(b.label) + '</span>' +
              '</div>';
            }).join("") +
          '</div>' +
        '</div>';

      // Wire
      d.modalBody.querySelectorAll('[data-preset]').forEach((b) => {
        b.addEventListener("click", () => {
          this._applyPreset(b.dataset.preset);
          d.modalBody.querySelectorAll('[data-preset]').forEach((bb) => bb.classList.toggle("active", bb === b));
          // Update bands
          this.state.eqGains.forEach((g, i) => {
            const sl = d.modalBody.querySelector('[data-band="' + i + '"]');
            const va = d.modalBody.querySelector('[data-band-val="' + i + '"]');
            if (sl) sl.value = g;
            if (va) va.textContent = (g >= 0 ? "+" : "") + g + " dB";
          });
        });
      });
      d.modalBody.querySelectorAll('[data-band]').forEach((sl) => {
        sl.addEventListener("input", () => {
          const i = parseInt(sl.dataset.band, 10);
          const v = parseFloat(sl.value);
          this.state.eqGains[i] = v;
          this.engine.setEqGain(i, v);
          const va = d.modalBody.querySelector('[data-band-val="' + i + '"]');
          if (va) va.textContent = (v >= 0 ? "+" : "") + v + " dB";
          // Mark "Custom" — clear preset highlight
          d.modalBody.querySelectorAll('[data-preset]').forEach((bb) => bb.classList.remove("active"));
          this.state.currentEq = "Custom";
        });
      });
      if (d.modalClose) d.modalClose.onclick = () => this._closeModal();
    }

    _applyPreset(name) {
      const arr = this.engine.setEqPreset(name);
      if (arr) {
        this.state.eqGains = arr.slice();
        this.state.currentEq = name;
      }
    }

    _closeModal() {
      const d = this.dom;
      if (!d.modalRoot) return;
      d.modalRoot.hidden = true;
    }

    /* --------------------------------------------------------------------
     * 6.18 NEW PLAYLIST DIALOG
     * ----------------------------------------------------------------- */
    _dialogNewPlaylist() {
      const name = prompt("New playlist name:", "Playlist");
      if (!name) return;
      this.lib.createPlaylist(name);
    }
  }

  /* =========================================================================
   * 7.  REGISTER WITH WINDOW MANAGER
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
      minWidth: 720, minHeight: 460,
      category: APP_CATEGORY,
      pinned: true,
      canOpen: (md) => {
        if (!md) return false;
        if (md.type === "folder") return false;
        const ext = getExt(md.path || md.name || "");
        return AUDIO_EXTS.indexOf(ext) !== -1;
      },
      render(body, win) {
        const app = new SoundWave(body, win.opts || {});
        app.mount();
        win._soundwave = app;
      },
      onClose(win) {
        if (win._soundwave) win._soundwave.destroy();
      },
    });
    console.log("%c[WebOS]%c SoundWave registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* =========================================================================
   * 8.  EXTRA UTILITIES (exposed for tests & integration)
   * ====================================================================== */

  /**
   * Convert a duration in seconds to a "MM:SS" or "H:MM:SS" string.
   */
  function fmtDurationLong(s) {
    if (!isFinite(s) || s < 0) return "0:00";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    if (h > 0) {
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
    }
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  /**
   * Group a list of track-like objects by a key.
   */
  function groupBy(arr, key) {
    const out = {};
    arr.forEach((it) => {
      const k = (it[key] == null ? "" : String(it[key]));
      if (!out[k]) out[k] = [];
      out[k].push(it);
    });
    return out;
  }

  /**
   * Bucket frequency data into N buckets logarithmically (for visualizers).
   */
  function logBuckets(freqArray, sampleRate, bins, minHz, maxHz) {
    const N = freqArray.length;
    minHz = minHz || 30;
    maxHz = maxHz || sampleRate / 2;
    const out = new Float32Array(bins);
    const counts = new Uint16Array(bins);
    const lo = Math.log(minHz);
    const hi = Math.log(maxHz);
    for (let i = 1; i < N; i++) {
      const f = (i / N) * (sampleRate / 2);
      if (f < minHz || f > maxHz) continue;
      const t = (Math.log(f) - lo) / (hi - lo);
      const b = clamp(Math.floor(t * bins), 0, bins - 1);
      out[b] += freqArray[i];
      counts[b]++;
    }
    for (let b = 0; b < bins; b++) {
      if (counts[b] > 0) out[b] /= counts[b];
    }
    return out;
  }

  /**
   * Cosine-tapered window suitable for spectral smoothing.
   */
  function hannWindow(N) {
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      out[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    }
    return out;
  }

  /**
   * Compute a tiny RMS level over a signed-byte time-domain buffer.
   */
  function rmsLevel(buf128) {
    let sum = 0;
    for (let i = 0; i < buf128.length; i++) {
      const v = (buf128[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf128.length);
  }

  /**
   * Format a track's metadata for display in a single line.
   */
  function trackOneLiner(t) {
    if (!t) return "";
    const parts = [];
    if (t.title)  parts.push(t.title);
    if (t.artist) parts.push("—", t.artist);
    return parts.join(" ");
  }

  /**
   * Fisher–Yates shuffle in-place. Used to seed shuffle order.
   */
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /**
   * Heuristic to decide whether a value looks like a usable audio URL.
   */
  function isLikelyAudioUrl(s) {
    if (!s || typeof s !== "string") return false;
    if (s.startsWith("data:audio/"))  return true;
    if (s.startsWith("blob:"))        return true;
    if (/\.(mp3|wav|ogg|flac|aac|m4a|opus|weba)(\?|#|$)/i.test(s)) return true;
    return false;
  }

  /**
   * Convert a 0..1 linear gain to a dB string.
   */
  function gainToDb(g) {
    if (g <= 0) return "-∞ dB";
    const db = 20 * Math.log10(g);
    return (db >= 0 ? "+" : "") + db.toFixed(1) + " dB";
  }

  /**
   * Convert dB to a linear gain.
   */
  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  /**
   * Compute a simple BPM estimate by autocorrelating a low-pass envelope of
   * the time-domain buffer. Not exact; useful as a hint for visualizer pacing.
   */
  function estimateBpm(timeArray, sampleRate) {
    if (!timeArray || !timeArray.length) return 0;
    const N = timeArray.length;
    const env = new Float32Array(N);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const v = Math.abs((timeArray[i] - 128) / 128);
      lp = lp * 0.95 + v * 0.05;
      env[i] = lp;
    }
    let bestLag = 0, bestCorr = 0;
    const minLag = Math.floor(sampleRate / (200 / 60));   // 200 bpm
    const maxLag = Math.floor(sampleRate / (40 / 60));    // 40 bpm
    for (let lag = minLag; lag < Math.min(maxLag, N - 1); lag += 32) {
      let s = 0;
      for (let i = 0; i < N - lag; i += 16) s += env[i] * env[i + lag];
      if (s > bestCorr) { bestCorr = s; bestLag = lag; }
    }
    if (!bestLag) return 0;
    return Math.round(60 * sampleRate / bestLag);
  }

  /**
   * Smooth a Float32 array with a tiny moving average.
   */
  function smoothArray(arr, radius) {
    radius = clamp(radius | 0, 0, 16);
    if (radius === 0) return arr.slice();
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j < 0 || j >= arr.length) continue;
        s += arr[j]; n++;
      }
      out[i] = s / n;
    }
    return out;
  }

  /**
   * Decompose a track's "Artist - Album - 03 - Title" filename into a
   * normalized label dictionary. Companion to metaFromName().
   */
  function explodeFileName(name) {
    return metaFromName(name);
  }

  /**
   * Build a readable summary like "5 albums · 12 artists · 30 tracks" used by
   * tooltips and library overviews.
   */
  function librarySummary(lib) {
    return lib.getAlbums().length + " albums · " + lib.getArtists().length + " artists · " + lib.tracks.length + " tracks";
  }

  /**
   * Sum of all track durations in a library.
   */
  function totalDuration(tracks) {
    let s = 0;
    for (let i = 0; i < tracks.length; i++) s += (tracks[i].duration || 0);
    return s;
  }

  /**
   * Convert a list of tracks to an M3U8 playlist string. Useful for export.
   */
  function toM3U(tracks) {
    const lines = ["#EXTM3U"];
    tracks.forEach((t) => {
      const dur = Math.round(t.duration || 0);
      lines.push("#EXTINF:" + dur + "," + (t.artist || "Unknown") + " - " + (t.title || "Untitled"));
      lines.push(t.url || t.fsPath || ("#missing-" + t.id));
    });
    return lines.join("\n") + "\n";
  }

  /**
   * Parse a minimal M3U8 file back into a list of skeleton track records.
   * Real URLs are kept as-is; the FileSystem layer can resolve them later.
   */
  function fromM3U(text) {
    if (!text) return [];
    const out = [];
    const lines = String(text).split(/\r?\n/);
    let pendingMeta = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      if (ln.startsWith("#EXTINF:")) {
        const rest = ln.slice("#EXTINF:".length);
        const comma = rest.indexOf(",");
        const dur = parseInt(rest.slice(0, comma), 10) || 0;
        const meta = rest.slice(comma + 1);
        const dash = meta.indexOf(" - ");
        pendingMeta = (dash !== -1)
          ? { artist: meta.slice(0, dash), title: meta.slice(dash + 3), duration: dur }
          : { title: meta, artist: "", duration: dur };
        continue;
      }
      if (ln.startsWith("#")) continue;
      const t = Object.assign({
        id: uid("trk"),
        url: ln, title: "Untitled", artist: "", album: "", duration: 0,
        added: Date.now(),
      }, pendingMeta || {});
      out.push(t);
      pendingMeta = null;
    }
    return out;
  }

  /**
   * Crude similarity score between two strings — used by the search box for
   * fuzzy matching when the exact substring search fails.
   */
  function similarity(a, b) {
    a = String(a || "").toLowerCase();
    b = String(b || "").toLowerCase();
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 6) return 0;
    const dp = new Int16Array((m + 1) * (n + 1));
    for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        const del = dp[(i - 1) * (n + 1) + j] + 1;
        const ins = dp[i * (n + 1) + (j - 1)] + 1;
        const sub = dp[(i - 1) * (n + 1) + (j - 1)] + cost;
        dp[i * (n + 1) + j] = Math.min(del, ins, sub);
      }
    }
    const dist = dp[m * (n + 1) + n];
    const max = Math.max(m, n);
    return 1 - (dist / max);
  }

  /**
   * Decibel curve helper — converts a 0..1 slider into a 0..1 audible gain.
   * Mirrors how OS volume sliders typically feel less linear than they look.
   */
  function audibleGain(slider01) {
    const v = clamp(slider01, 0, 1);
    if (v <= 0) return 0;
    return Math.pow(v, 2.5);
  }

  /**
   * Inverse of audibleGain — given an audible gain, return the slider value
   * that would produce it. Used when restoring saved volume.
   */
  function audibleSlider(gain01) {
    const v = clamp(gain01, 0, 1);
    return Math.pow(v, 1 / 2.5);
  }

  /**
   * Compute peak amplitude for a Uint8 time-domain buffer (returns 0..1).
   */
  function peakLevel(buf) {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128);
      if (v > peak) peak = v;
    }
    return peak / 128;
  }

  /**
   * Crude beat detector — fires `cb()` whenever the bass band exceeds a
   * dynamic threshold. The caller is responsible for invoking step() at a
   * regular cadence with fresh frequency data.
   */
  function makeBeatDetector(opts) {
    opts = opts || {};
    const sensitivity = opts.sensitivity || 1.4;
    const decay = opts.decay || 0.985;
    let avg = 0;
    let lastFireAt = 0;
    return {
      step(freqArray, cb) {
        // Bass band: bottom ~5% of bins
        const lim = Math.max(8, Math.floor(freqArray.length * 0.05));
        let sum = 0;
        for (let i = 1; i < lim; i++) sum += freqArray[i];
        const inst = sum / (lim - 1);
        avg = avg * decay + inst * (1 - decay);
        const now = performance.now();
        if (inst > avg * sensitivity && now - lastFireAt > 180) {
          lastFireAt = now;
          if (cb) cb({ time: now, intensity: inst / 255 });
        }
      },
      reset() { avg = 0; lastFireAt = 0; },
    };
  }

  /**
   * Lightweight ring buffer used to keep a rolling window of recent samples
   * for visualizers that want to render "trails" rather than instantaneous
   * spectra.
   */
  class RingBuffer {
    constructor(capacity) {
      this.capacity = Math.max(1, capacity | 0);
      this.buf = new Array(this.capacity);
      this.size = 0;
      this.head = 0;
    }
    push(v) {
      this.buf[this.head] = v;
      this.head = (this.head + 1) % this.capacity;
      if (this.size < this.capacity) this.size++;
    }
    forEach(fn) {
      for (let i = 0; i < this.size; i++) {
        const idx = (this.head - this.size + i + this.capacity) % this.capacity;
        fn(this.buf[idx], i);
      }
    }
    last() {
      if (this.size === 0) return undefined;
      const idx = (this.head - 1 + this.capacity) % this.capacity;
      return this.buf[idx];
    }
    clear() { this.size = 0; this.head = 0; }
  }

  /**
   * Compute total play time per artist. Useful for listening-stats panels.
   * Argument is an array of { artist, durationPlayedSec }.
   */
  function rollupListenTime(events) {
    const map = new Map();
    events.forEach((e) => {
      const k = e.artist || "Unknown";
      map.set(k, (map.get(k) || 0) + (e.durationPlayedSec || 0));
    });
    return Array.from(map.entries())
      .map(([artist, total]) => ({ artist, total }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Format a track count + total length: "42 tracks · 2 h 14 min".
   */
  function trackStats(tracks) {
    const s = totalDuration(tracks);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const dur = h > 0 ? (h + " h " + m + " min") : (m + " min");
    return tracks.length + " tracks · " + dur;
  }

  /**
   * Tiny LRU cache helper (used for object URLs created during a session).
   */
  class LRU {
    constructor(max) {
      this.max = Math.max(1, max | 0);
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return undefined;
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    set(key, val) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, val);
      while (this.map.size > this.max) {
        const first = this.map.keys().next().value;
        this.map.delete(first);
      }
    }
    has(key) { return this.map.has(key); }
    delete(key) { return this.map.delete(key); }
    clear() { this.map.clear(); }
    get size() { return this.map.size; }
  }

  /**
   * Pretty-print a number of bytes (used in library inspector).
   */
  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  /**
   * Convert HSL into a CSS color string.
   */
  function hsl(h, s, l, a) {
    if (a == null) return "hsl(" + h + "," + s + "%," + l + "%)";
    return "hsla(" + h + "," + s + "%," + l + "%," + a + ")";
  }

  /**
   * Build a small polyline path from a series of [x, y] tuples.
   */
  function polyline(points) {
    if (!points.length) return "";
    let out = "M" + points[0][0] + "," + points[0][1];
    for (let i = 1; i < points.length; i++) {
      out += " L" + points[i][0] + "," + points[i][1];
    }
    return out;
  }

  /**
   * Tag-list parser: "chill;late-night;jazz" → ["chill","late-night","jazz"].
   * Empty / whitespace tokens are dropped.
   */
  function parseTags(s) {
    if (!s) return [];
    return String(s).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  }

  /**
   * Inverse of parseTags.
   */
  function joinTags(tags) {
    if (!tags || !tags.length) return "";
    return tags.join("; ");
  }

  /**
   * Compute a perceived loudness number 0..1 from a frequency array. This is
   * NOT EBU R128, just a soft approximation that weights bass and presence.
   */
  function perceivedLoudness(freqArray) {
    if (!freqArray || !freqArray.length) return 0;
    const N = freqArray.length;
    const wBass = 0.6, wMid = 1.0, wHigh = 0.5;
    const bassEnd = Math.floor(N * 0.07);
    const midEnd  = Math.floor(N * 0.45);
    let bass = 0, mid = 0, high = 0;
    for (let i = 0; i < bassEnd; i++)        bass += freqArray[i];
    for (let i = bassEnd; i < midEnd; i++)   mid  += freqArray[i];
    for (let i = midEnd; i < N; i++)         high += freqArray[i];
    bass /= bassEnd || 1;
    mid  /= (midEnd - bassEnd) || 1;
    high /= (N - midEnd) || 1;
    const total = (bass * wBass + mid * wMid + high * wHigh) / (wBass + wMid + wHigh);
    return clamp(total / 255, 0, 1);
  }

  /**
   * Map a [0..1] envelope to a color string for visualizer accents.
   */
  function levelToColor(level) {
    const t = clamp(level, 0, 1);
    const hue = 140 - t * 140; // green → red
    return hsl(hue, 80, 55);
  }

  /**
   * Produce the "queue counter" badge string used in the sidebar header.
   */
  function queueBadge(count) {
    if (!count) return "";
    if (count > 99) return "99+";
    return String(count);
  }

  /**
   * Sleep timer helper — invokes `cb()` after `minutes`. Returns an object
   * with cancel() and remaining(). Falls back to setInterval(60s) so it can
   * survive tab throttling reasonably well.
   */
  function makeSleepTimer(minutes, cb) {
    let remaining = Math.max(0, minutes | 0);
    const startedAt = Date.now();
    const totalMs = remaining * 60 * 1000;
    const handle = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalMs) {
        clearInterval(handle);
        try { cb && cb(); } catch (_) {}
      }
    }, 1000);
    return {
      cancel() { clearInterval(handle); },
      remaining() {
        const elapsed = Date.now() - startedAt;
        return Math.max(0, totalMs - elapsed);
      },
      remainingMinutes() {
        return Math.ceil(this.remaining() / 60000);
      },
    };
  }

  /**
   * Produce a stable color triplet for a string seed. Useful when generating
   * placeholder thumbnails on the fly.
   */
  function seedColors(seed) {
    const h = hashString(seed);
    const a = h % 360;
    const b = (a + 60) % 360;
    const c = (a + 200) % 360;
    return [hsl(a, 60, 45), hsl(b, 65, 35), hsl(c, 55, 25)];
  }

  /**
   * Render a placeholder album-art canvas given a seed. Returns a dataURL.
   * Callers can use this to populate <img src> for offline display.
   */
  function renderPlaceholderArt(seed, size) {
    size = size || 200;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const ctx = c.getContext("2d");
    const colors = seedColors(seed);
    const grd = ctx.createLinearGradient(0, 0, size, size);
    grd.addColorStop(0, colors[0]);
    grd.addColorStop(0.5, colors[1]);
    grd.addColorStop(1, colors[2]);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    // Glyph
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "bold " + (size * 0.5) + "px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const letter = (String(seed || "?").trim()[0] || "?").toUpperCase();
    ctx.fillText(letter, size / 2, size / 2);
    return c.toDataURL("image/png");
  }

  /**
   * Stringify a track in compact "discoverable" format used by hover titles.
   */
  function trackTooltip(t) {
    if (!t) return "";
    const parts = [];
    parts.push(t.title || "Untitled");
    if (t.artist) parts.push("by " + t.artist);
    if (t.album)  parts.push("on " + t.album);
    if (t.duration) parts.push("(" + fmtTime(t.duration) + ")");
    return parts.join(" ");
  }

  /**
   * Mark whether two tracks should be considered duplicates.
   * Two tracks are duplicates when title + artist match (case-insensitive),
   * regardless of album or duration.
   */
  function looksLikeDuplicate(a, b) {
    if (!a || !b) return false;
    const norm = (s) => String(s || "").trim().toLowerCase();
    return norm(a.title) === norm(b.title) && norm(a.artist) === norm(b.artist);
  }

  /**
   * De-duplicate a track array preserving original order.
   */
  function dedupeTracks(tracks) {
    const out = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!out.some((x) => looksLikeDuplicate(x, t))) out.push(t);
    }
    return out;
  }

  /**
   * Build a small JSON describing the player snapshot. Useful for tests and
   * for persisting playback continuation across reloads.
   */
  function snapshotState(app) {
    if (!app) return null;
    return {
      currentId: app.state.currentId,
      isPlaying: app.state.isPlaying,
      time:      app.engine ? app.engine.getCurrent() : 0,
      duration:  app.engine ? app.engine.getDuration() : 0,
      volume:    app.engine ? app.engine.volume : 1,
      muted:     app.engine ? app.engine.muted : false,
      shuffle:   app.state.shuffle,
      repeat:    app.state.repeatMode,
      queue:     app.state.queue.slice(),
      view:      app.state.view,
    };
  }

  /**
   * Convenience: clamp number to [0, +Infinity).
   */
  function clampNonNeg(v) { return v < 0 ? 0 : v; }

  /**
   * Turn a 0..1 progress into a small SVG `path d` for circular indicators.
   * The path traces an arc from 12-o'clock clockwise.
   */
  function arcPath(progress, cx, cy, r) {
    progress = clamp(progress, 0, 0.9999);
    const ang = progress * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    const large = progress > 0.5 ? 1 : 0;
    return "M" + cx + "," + (cy - r) +
           " A" + r + "," + r + " 0 " + large + " 1 " + x + "," + y;
  }

  /**
   * Compose a CSS transform string for a knob slider.
   */
  function knobTransform(pct) {
    return "translate(-50%, -50%) translate(" + (pct * 100) + "%, 0)";
  }

  /* =========================================================================
   * 9.  EXPORTS
   * ====================================================================== */
  window.SoundWave = {
    APP_ID, AUDIO_EXTS, EQ_BANDS, EQ_PRESETS, VIS_MODES,
    fmtTime, fmtDurationLong, gradientFor, hashString, metaFromName,
    groupBy, logBuckets, hannWindow, rmsLevel, trackOneLiner,
    shuffleInPlace, isLikelyAudioUrl, gainToDb, dbToGain,
    estimateBpm, smoothArray, explodeFileName, librarySummary,
    totalDuration, toM3U, fromM3U, similarity,
    audibleGain, audibleSlider, peakLevel, makeBeatDetector,
    RingBuffer, rollupListenTime, trackStats, LRU,
    fmtBytes, hsl, polyline, parseTags, joinTags,
    perceivedLoudness, levelToColor, queueBadge, makeSleepTimer,
    seedColors, renderPlaceholderArt, trackTooltip,
    looksLikeDuplicate, dedupeTracks, snapshotState,
    clampNonNeg, arcPath, knobTransform,
    open(path) {
      return window.WindowManager.openApp(APP_ID, { openPath: path });
    },
  };

})();
