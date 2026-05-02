/* ============================================================================
 * WebOS — aria.js
 * ----------------------------------------------------------------------------
 * ARIA — the built-in AI assistant for WebOS.
 *
 *   - Connects directly to the Anthropic API from the browser
 *   - Streaming responses via fetch + ReadableStream
 *   - Multiple conversations (stored in FileSystem at /.aria/conversations/)
 *   - Markdown rendering (bold, italic, code, lists, headers, blockquotes)
 *   - Syntax highlighting for code blocks
 *   - Copy button on every code block
 *   - Voice input (Web Speech API) with graceful fallback
 *   - Suggested prompts on empty conversation
 *   - Export to .txt / .md
 *   - Settings slide-in panel (API key, temperature, max tokens, system prompt)
 *   - Keyboard shortcuts (Ctrl+N, Ctrl+Delete, Escape, Win+A)
 *
 * Public API on  window.ARIA
 * ==========================================================================*/

(function () {
  "use strict";

  /* ==========================================================================
   * Constants
   * ========================================================================*/

  const APP_ID     = "aria";
  const APP_TITLE  = "ARIA";
  const APP_ICON   = "🤖";

  const API_ENDPOINT = "https://api.anthropic.com/v1/messages";
  const DEFAULT_MODEL = "claude-sonnet-4-20250514";

  const LS_KEY_APIKEY     = "webos.aria.apikey";
  const LS_KEY_SETTINGS   = "webos.aria.settings.v1";
  const LS_KEY_ACTIVE     = "webos.aria.active.v1";

  const FS_DIR            = "/.aria";
  const FS_CONV_DIR       = "/.aria/conversations";
  const FS_APIKEY_PATH    = "/.aria/apikey";
  const FS_SETTINGS_PATH  = "/.aria/settings.json";

  const MAX_INPUT_CHARS    = 8000;
  const MAX_CONVERSATIONS  = 100;
  const MAX_TITLE_LEN      = 80;
  const AUTO_TITLE_FROM    = 54; // characters from first user message
  const STREAM_KEEPALIVE_MS = 60000;

  const DEFAULT_SYSTEM_PROMPT = "You are ARIA, the built-in AI assistant " +
    "for WebOS. You are helpful, concise, and knowledgeable about technology. " +
    "You can help with coding, writing, math, and general questions. " +
    "When showing code always use markdown code blocks with language.";

  const DEFAULT_SETTINGS = {
    model:        DEFAULT_MODEL,
    temperature:  0.7,
    maxTokens:    2048,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };

  const SUGGESTED_PROMPTS = [
    { icon: "💻", text: "Explain how WebOS was built" },
    { icon: "🐍", text: "Write a Python script to sort a list" },
    { icon: "🌐", text: "What is the difference between TCP and UDP?" },
    { icon: "✉",  text: "Help me write a professional email" },
    { icon: "⚡", text: "Explain async/await in JavaScript" },
    { icon: "🎨", text: "Suggest a color palette for a modern portfolio" },
  ];

  /* ==========================================================================
   * Utilities
   * ========================================================================*/

  function uid() {
    return "c_" + Date.now().toString(36) + "_" +
           Math.floor(Math.random() * 1e6).toString(36);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function safeLocalGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function safeLocalSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (_) { return false; }
  }

  function safeLocalGetRaw(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : raw;
    } catch (_) { return fallback; }
  }

  function safeLocalSetRaw(key, val) {
    try {
      localStorage.setItem(key, val);
      return true;
    } catch (_) { return false; }
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit", minute: "2-digit",
      });
    }
    return d.toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    }) + " " + d.toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit",
    });
  }

  function formatRelative(ts) {
    if (!ts) return "";
    const diff = Math.max(0, Date.now() - ts);
    const s = Math.floor(diff / 1000);
    if (s < 60)  return "just now";
    const m = Math.floor(s / 60);
    if (m < 60)  return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24)  return h + "h ago";
    const d = Math.floor(h / 24);
    if (d < 7)   return d + "d ago";
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short", day: "numeric",
    });
  }

  /* ==========================================================================
   * API key storage — localStorage + FileSystem
   * ========================================================================*/

  function saveApiKey(key) {
    const k = String(key || "").trim();
    safeLocalSetRaw(LS_KEY_APIKEY, k);
    // Also write to FS so backup tools / terminal can see it
    if (window.FileSystem) {
      try {
        if (!window.FileSystem.exists(FS_DIR)) {
          window.FileSystem.createFolder(FS_DIR, { hidden: true, recursive: true });
        }
        window.FileSystem.writeFile(FS_APIKEY_PATH, k, {
          kind: "text", hidden: true, mime: "text/plain",
        });
      } catch (e) {
        console.warn("[ARIA] saveApiKey FS:", e);
      }
    }
  }

  function loadApiKey() {
    let k = safeLocalGetRaw(LS_KEY_APIKEY, "");
    if (!k && window.FileSystem) {
      try {
        if (window.FileSystem.exists(FS_APIKEY_PATH)) {
          k = window.FileSystem.readFile(FS_APIKEY_PATH, { noRecent: true }) || "";
          if (k) safeLocalSetRaw(LS_KEY_APIKEY, k);
        }
      } catch (_) {}
    }
    return (k || "").trim();
  }

  function clearApiKey() {
    try { localStorage.removeItem(LS_KEY_APIKEY); } catch (_) {}
    if (window.FileSystem) {
      try {
        if (window.FileSystem.exists(FS_APIKEY_PATH)) {
          window.FileSystem.deleteFile(FS_APIKEY_PATH);
        }
      } catch (_) {}
    }
  }

  /* ==========================================================================
   * Settings storage
   * ========================================================================*/

  function loadSettings() {
    const ls = safeLocalGet(LS_KEY_SETTINGS, null);
    let merged = Object.assign({}, DEFAULT_SETTINGS, ls || {});
    // Try FS too
    if (window.FileSystem && window.FileSystem.exists(FS_SETTINGS_PATH)) {
      try {
        const raw = window.FileSystem.readFile(FS_SETTINGS_PATH, { noRecent: true });
        if (raw) {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === "object") merged = Object.assign(merged, obj);
        }
      } catch (_) {}
    }
    // Validate
    merged.temperature = clamp(Number(merged.temperature) || 0.7, 0, 1);
    merged.maxTokens   = clamp(parseInt(merged.maxTokens, 10) || 2048, 64, 32768);
    if (!merged.model) merged.model = DEFAULT_MODEL;
    if (!merged.systemPrompt) merged.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    return merged;
  }

  function saveSettings(s) {
    safeLocalSet(LS_KEY_SETTINGS, s);
    if (window.FileSystem) {
      try {
        if (!window.FileSystem.exists(FS_DIR)) {
          window.FileSystem.createFolder(FS_DIR, { hidden: true });
        }
        window.FileSystem.writeFile(
          FS_SETTINGS_PATH,
          JSON.stringify(s, null, 2),
          { kind: "text", mime: "application/json", hidden: true }
        );
      } catch (_) {}
    }
  }

  /* ==========================================================================
   * Conversation storage (FileSystem-backed)
   * ========================================================================*/

  function convPath(id) {
    return FS_CONV_DIR + "/" + id + ".json";
  }

  function ensureConvDir() {
    if (!window.FileSystem) return;
    try {
      if (!window.FileSystem.exists(FS_DIR)) {
        window.FileSystem.createFolder(FS_DIR, { hidden: true, recursive: true });
      }
      if (!window.FileSystem.exists(FS_CONV_DIR)) {
        window.FileSystem.createFolder(FS_CONV_DIR, { hidden: true, recursive: true });
      }
    } catch (e) {
      console.warn("[ARIA] ensureConvDir:", e);
    }
  }

  function listConversationsFromFs() {
    if (!window.FileSystem) return [];
    ensureConvDir();
    const out = [];
    try {
      const items = window.FileSystem.listDir(FS_CONV_DIR, { showHidden: true });
      for (const it of items) {
        if (it.kind !== "file") continue;
        if (!/\.json$/.test(it.name)) continue;
        try {
          const raw = window.FileSystem.readFile(it.path, { noRecent: true });
          if (!raw) continue;
          const obj = JSON.parse(raw);
          if (obj && obj.id && Array.isArray(obj.messages)) {
            out.push(obj);
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[ARIA] listConversationsFromFs:", e);
    }
    // Sort most recent first
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  function listConversationsFromLs() {
    // Fallback when FS is unavailable
    const raw = safeLocalGet("webos.aria.conv.index", []);
    if (!Array.isArray(raw)) return [];
    return raw.map((id) => safeLocalGet("webos.aria.conv." + id, null))
              .filter(Boolean)
              .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function listConversations() {
    const fs = listConversationsFromFs();
    if (fs.length > 0) return fs;
    return listConversationsFromLs();
  }

  function loadConversation(id) {
    if (!id) return null;
    if (window.FileSystem && window.FileSystem.exists(convPath(id))) {
      try {
        const raw = window.FileSystem.readFile(convPath(id), { noRecent: true });
        if (raw) return JSON.parse(raw);
      } catch (_) {}
    }
    return safeLocalGet("webos.aria.conv." + id, null);
  }

  function saveConversation(conv) {
    if (!conv || !conv.id) return false;
    conv.updatedAt = Date.now();
    const json = JSON.stringify(conv, null, 0);

    if (window.FileSystem) {
      ensureConvDir();
      try {
        window.FileSystem.writeFile(convPath(conv.id), json, {
          kind: "text", mime: "application/json", hidden: true,
        });
      } catch (e) {
        console.warn("[ARIA] saveConversation FS:", e);
      }
    }

    safeLocalSet("webos.aria.conv." + conv.id, conv);
    // Update index
    const index = safeLocalGet("webos.aria.conv.index", []);
    if (Array.isArray(index) && index.indexOf(conv.id) < 0) {
      index.unshift(conv.id);
      if (index.length > MAX_CONVERSATIONS) index.length = MAX_CONVERSATIONS;
      safeLocalSet("webos.aria.conv.index", index);
    }
    return true;
  }

  function deleteConversation(id) {
    if (!id) return false;
    if (window.FileSystem) {
      try {
        if (window.FileSystem.exists(convPath(id))) {
          window.FileSystem.deleteFile(convPath(id), { permanent: true });
        }
      } catch (e) {
        console.warn("[ARIA] deleteConversation:", e);
      }
    }
    try { localStorage.removeItem("webos.aria.conv." + id); } catch (_) {}
    const index = safeLocalGet("webos.aria.conv.index", []);
    if (Array.isArray(index)) {
      const next = index.filter((x) => x !== id);
      safeLocalSet("webos.aria.conv.index", next);
    }
    return true;
  }

  function createConversation(firstText) {
    const id = uid();
    const title = (firstText && firstText.trim())
      ? truncateTitle(firstText.trim())
      : "New chat";
    const conv = {
      id,
      title,
      model: loadSettings().model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    saveConversation(conv);
    return conv;
  }

  function truncateTitle(s) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    if (s.length <= AUTO_TITLE_FROM) return s;
    return s.slice(0, AUTO_TITLE_FROM - 1).trim() + "…";
  }

  /* ==========================================================================
   * Simple syntax highlighter (works offline; no dependencies)
   *
   * Supports: JavaScript/TypeScript, Python, JSON, HTML, CSS, SQL, Bash.
   * ========================================================================*/

  const KW = {
    js: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|this|null|undefined|true|false|typeof|instanceof|in|of|try|catch|finally|throw|import|export|from|as|default|async|await|yield|static|super|void|delete|debugger)\b/g,
    py: /\b(def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|lambda|try|except|finally|raise|with|yield|async|await|None|True|False|and|or|not|is|in|global|nonlocal|assert|del)\b/g,
    sh: /\b(if|then|else|elif|fi|for|do|done|while|case|esac|function|return|in|break|continue|export|echo|source|alias|unset|local)\b/g,
    sql: /\b(SELECT|FROM|WHERE|AND|OR|NOT|NULL|INSERT|INTO|VALUES|UPDATE|SET|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|CREATE|TABLE|DROP|ALTER|ADD|PRIMARY|KEY|FOREIGN|REFERENCES|INDEX|UNIQUE|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|END|UNION|ALL|EXISTS|IN|BETWEEN|LIKE|IS)\b/gi,
  };

  function detectLang(lang, code) {
    const l = String(lang || "").toLowerCase();
    if (["js", "javascript", "jsx", "ts", "typescript", "tsx", "node"].includes(l)) return "js";
    if (["py", "python", "python3"].includes(l)) return "py";
    if (["json"].includes(l)) return "json";
    if (["html", "xml", "svg", "vue", "htm"].includes(l)) return "html";
    if (["css", "scss", "less"].includes(l)) return "css";
    if (["bash", "sh", "shell", "zsh"].includes(l)) return "sh";
    if (["sql", "psql", "mysql"].includes(l)) return "sql";
    if (l) return "generic";
    // Sniff
    if (/^\s*</.test(code)) return "html";
    if (/\bdef\s+\w+\s*\(/.test(code)) return "py";
    if (/(function|=>|const|let|var)\b/.test(code)) return "js";
    return "generic";
  }

  function highlightJs(src) {
    let html = escapeHtml(src);
    // Strings: single, double, template
    html = html.replace(/(`[^`\\]*(?:\\.[^`\\]*)*`|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/g,
      (m) => `<span class="tk-str">${m}</span>`);
    // Comments
    html = html.replace(/\/\/[^\n]*/g, (m) => `<span class="tk-cmt">${m}</span>`);
    html = html.replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="tk-cmt">${m}</span>`);
    // Numbers
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, `<span class="tk-num">$1</span>`);
    // Keywords
    html = html.replace(KW.js, `<span class="tk-kw">$1</span>`);
    // Function names
    html = html.replace(/(\b[A-Za-z_$][\w$]*)(?=\s*\()/g, (m) => {
      if (/^(if|for|while|switch|return|throw|new|typeof|await|function)$/.test(m)) return m;
      return `<span class="tk-fn">${m}</span>`;
    });
    return html;
  }

  function highlightPy(src) {
    let html = escapeHtml(src);
    html = html.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')/g,
      (m) => `<span class="tk-str">${m}</span>`);
    html = html.replace(/(#[^\n]*)/g, (m) => `<span class="tk-cmt">${m}</span>`);
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, `<span class="tk-num">$1</span>`);
    html = html.replace(KW.py, `<span class="tk-kw">$1</span>`);
    html = html.replace(/\b(def|class)\s+([A-Za-z_]\w*)/g,
      (_, kw, name) => `<span class="tk-kw">${kw}</span> <span class="tk-fn">${name}</span>`);
    return html;
  }

  function highlightJson(src) {
    let html = escapeHtml(src);
    html = html.replace(/("(\\.|[^"\\])*")(\s*:)/g,
      `<span class="tk-typ">$1</span>$3`);
    html = html.replace(/(?<!["\w])("(\\.|[^"\\])*")(?!\s*:)/g,
      `<span class="tk-str">$1</span>`);
    html = html.replace(/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
      `<span class="tk-num">$1</span>`);
    html = html.replace(/\b(true|false|null)\b/g,
      `<span class="tk-kw">$1</span>`);
    return html;
  }

  function highlightHtml(src) {
    let html = escapeHtml(src);
    html = html.replace(/(&lt;!--[\s\S]*?--&gt;)/g,
      `<span class="tk-cmt">$1</span>`);
    html = html.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g,
      `$1<span class="tk-kw">$2</span>`);
    html = html.replace(/(\s[a-zA-Z-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g,
      `<span class="tk-fn">$1</span>$2<span class="tk-str">$3</span>`);
    return html;
  }

  function highlightCss(src) {
    let html = escapeHtml(src);
    html = html.replace(/\/\*[\s\S]*?\*\//g,
      (m) => `<span class="tk-cmt">${m}</span>`);
    html = html.replace(/([.#][A-Za-z0-9_\-]+|[A-Za-z]+)(\s*\{)/g,
      `<span class="tk-typ">$1</span>$2`);
    html = html.replace(/(^|\s)([a-z-]+)(\s*:)/g,
      `$1<span class="tk-fn">$2</span>$3`);
    html = html.replace(/("[^"]*"|'[^']*')/g,
      `<span class="tk-str">$1</span>`);
    html = html.replace(/\b(\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?)\b/g,
      `<span class="tk-num">$1</span>`);
    return html;
  }

  function highlightSql(src) {
    let html = escapeHtml(src);
    html = html.replace(/--[^\n]*/g, (m) => `<span class="tk-cmt">${m}</span>`);
    html = html.replace(/("[^"]*"|'[^']*')/g,
      (m) => `<span class="tk-str">${m}</span>`);
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, `<span class="tk-num">$1</span>`);
    html = html.replace(KW.sql, (m) => `<span class="tk-kw">${m.toUpperCase()}</span>`);
    return html;
  }

  function highlightSh(src) {
    let html = escapeHtml(src);
    html = html.replace(/#[^\n]*/g, (m) => `<span class="tk-cmt">${m}</span>`);
    html = html.replace(/"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g,
      (m) => `<span class="tk-str">${m}</span>`);
    html = html.replace(/\$\{?\w+\}?/g,
      (m) => `<span class="tk-fn">${m}</span>`);
    html = html.replace(KW.sh, `<span class="tk-kw">$1</span>`);
    return html;
  }

  function highlight(code, lang) {
    try {
      // Prefer textEditor.js tokenizer if available & compatible
      if (window.TextEditor && typeof window.TextEditor.highlight === "function") {
        const out = window.TextEditor.highlight(code, lang);
        if (out) return out;
      }
    } catch (_) {}
    const l = detectLang(lang, code);
    switch (l) {
      case "js":   return highlightJs(code);
      case "py":   return highlightPy(code);
      case "json": return highlightJson(code);
      case "html": return highlightHtml(code);
      case "css":  return highlightCss(code);
      case "sql":  return highlightSql(code);
      case "sh":   return highlightSh(code);
      default:     return escapeHtml(code);
    }
  }

  /* ==========================================================================
   * Markdown renderer — limited subset, safe
   *
   * Supported:
   *   - ``` fenced code blocks with language
   *   - `inline code`
   *   - **bold**, __bold__
   *   - *italic*, _italic_
   *   - ## headers (levels 1–4)
   *   - * / - / + bullet lists, nested
   *   - 1. numbered lists
   *   - > blockquote
   *   - horizontal rules ---
   *   - links [text](url)
   *   - line breaks
   * ========================================================================*/

  function renderMarkdown(src) {
    if (!src) return "";
    // Split into fenced code / prose segments
    const segments = [];
    const re = /```([a-zA-Z0-9+-_]*)\n([\s\S]*?)```/g;
    let lastIndex = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > lastIndex) {
        segments.push({ type: "prose", text: src.slice(lastIndex, m.index) });
      }
      segments.push({ type: "code", lang: m[1] || "", text: m[2] || "" });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < src.length) {
      segments.push({ type: "prose", text: src.slice(lastIndex) });
    }
    return segments.map((s) =>
      s.type === "code" ? renderCodeBlock(s.text, s.lang) : renderProse(s.text)
    ).join("");
  }

  function renderCodeBlock(code, lang) {
    const label = lang || "text";
    const highlighted = highlight(code.replace(/\n$/, ""), lang);
    const escaped = escapeHtml(code);
    return `
      <div class="aria-code-block" data-lang="${escapeHtml(label)}">
        <div class="aria-code-head">
          <span>${escapeHtml(label)}</span>
          <button class="aria-code-copy" data-copy="${encodeURIComponent(code)}">Copy</button>
        </div>
        <pre class="aria-code-body"><code>${highlighted}</code></pre>
      </div>
    `;
  }

  function renderProse(src) {
    // Split by blank lines (paragraphs), but preserve list groups
    const lines = src.split(/\n/);
    let out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      // Horizontal rule
      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push("<hr/>");
        i++; continue;
      }

      // Headers
      const hm = /^(\s*)(#{1,4})\s+(.+)$/.exec(line);
      if (hm) {
        const level = hm[2].length;
        out.push(`<h${level}>${inlineMd(hm[3].trim())}</h${level}>`);
        i++; continue;
      }

      // Blockquote (possibly multi-line)
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${inlineMd(buf.join("\n").replace(/\n+/g, "<br/>"))}</blockquote>`);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const { html, nextI } = collectList(lines, i, /^\s*[-*+]\s+(.*)$/, "ul");
        out.push(html);
        i = nextI;
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const { html, nextI } = collectList(lines, i, /^\s*\d+\.\s+(.*)$/, "ol");
        out.push(html);
        i = nextI;
        continue;
      }

      // Paragraph (collect consecutive non-blank lines)
      const buf = [line];
      i++;
      while (i < lines.length &&
             !/^\s*$/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) &&
             !/^\s*#/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
    }
    return out.join("");
  }

  function collectList(lines, i, re, tag) {
    const items = [];
    while (i < lines.length) {
      const l = lines[i];
      const m = re.exec(l);
      if (!m) break;
      let item = m[1];
      i++;
      // Continuation of same item (indented lines) → append
      while (i < lines.length && /^\s{2,}/.test(lines[i]) && !re.test(lines[i])) {
        item += "\n" + lines[i].trim();
        i++;
      }
      items.push(inlineMd(item));
    }
    return {
      html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`,
      nextI: i,
    };
  }

  function inlineMd(text) {
    if (!text) return "";
    let t = escapeHtml(text);
    // Inline code
    t = t.replace(/`([^`]+?)`/g, (_, c) => `<code>${c}</code>`);
    // Bold **...** and __...__
    t = t.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
    // Italic *...* and _..._ (avoid clobbering bold)
    t = t.replace(/(^|[^*_])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/(^|[^*_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
    // Links [text](url)
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) =>
        `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
    // Line breaks inside paragraph (double spaces or explicit \n from caller)
    t = t.replace(/  \n/g, "<br/>");
    return t;
  }

  /* ==========================================================================
   * Main app class
   * ========================================================================*/

  class AriaApp {
    constructor(body, win) {
      this.body = body;
      this.win  = win;
      this.refs = {};
      this.settings = loadSettings();
      this.apiKey = loadApiKey();

      this.currentConv = null;
      this.streamingAbort = null;
      this.streamingBubbleEl = null;
      this.rec = null;      // SpeechRecognition
      this.recActive = false;

      this._boundDocKey = this._onDocKey.bind(this);
    }

    /* ------------------------------------------------------------------ */
    mount() {
      const tmpl = document.getElementById("aria-app-template");
      let rootHtml;
      if (tmpl) {
        rootHtml = tmpl.innerHTML;
      } else {
        // Embedded fallback (in case aria.html isn't inlined)
        rootHtml = this._embeddedTemplate();
      }
      this.body.innerHTML = rootHtml;

      // Stylesheet (injected once)
      this._ensureStyle();

      // Collect refs
      this._collectRefs();

      // Wire UI
      this._wireTopBar();
      this._wireSidebar();
      this._wireInput();
      this._wireSettings();
      this._wireSetup();
      this._wireSuggestions();

      // Global shortcuts within this window
      document.addEventListener("keydown", this._boundDocKey, true);

      // Restore last conversation OR create new
      this._bootstrap();

      // Auto-grow input
      this._autoGrow();
    }

    destroy() {
      this._abortStream();
      document.removeEventListener("keydown", this._boundDocKey, true);
      try { this.rec && this.rec.stop && this.rec.stop(); } catch (_) {}
    }

    /* ------------------------------------------------------------------ */
    _ensureStyle() {
      if (document.getElementById("aria-inline-css-loader")) return;
      const link = document.createElement("link");
      link.id = "aria-inline-css-loader";
      link.rel = "stylesheet";
      link.href = "apps/aria/aria.css";
      document.head.appendChild(link);
    }

    _collectRefs() {
      this.body.querySelectorAll("[data-ref]").forEach((el) => {
        this.refs[el.getAttribute("data-ref")] = el;
      });
      this.rootEl = this.body.querySelector(".aria-root");
    }

    _embeddedTemplate() {
      // Minimal fallback only; full template lives in aria.html
      return `
        <div class="aria-root">
          <aside class="aria-sidebar" data-ref="sidebar">
            <div class="aria-sidebar-top">
              <button class="aria-new-btn" data-ref="newChatBtn">New chat</button>
            </div>
            <div class="aria-threads-wrap">
              <div class="aria-threads" data-ref="threads"></div>
            </div>
            <div class="aria-sidebar-bottom">
              <button class="aria-settings-btn" data-ref="settingsBtn">⚙</button>
            </div>
          </aside>
          <main class="aria-main">
            <header class="aria-topbar">
              <input class="aria-title-input" data-ref="titleInput" />
              <button class="aria-icon-btn" data-ref="exportBtn">Export</button>
              <button class="aria-icon-btn" data-ref="clearBtn">Clear</button>
            </header>
            <section class="aria-messages" data-ref="messages"></section>
            <section class="aria-suggestions" data-ref="suggestions" hidden>
              <div class="aria-suggestion-grid" data-ref="suggestionGrid"></div>
            </section>
            <section class="aria-setup" data-ref="setupScreen" hidden></section>
            <footer class="aria-input-area" data-ref="inputArea">
              <div class="aria-input-wrap">
                <button class="aria-input-btn" data-ref="voiceBtn">🎙</button>
                <textarea class="aria-input" data-ref="input"></textarea>
                <button class="aria-send-btn" data-ref="sendBtn">➤</button>
              </div>
            </footer>
          </main>
        </div>
      `;
    }

    /* ==================================================================
     * Bootstrap
     * ================================================================*/
    _bootstrap() {
      if (!this.apiKey) {
        this._showSetupScreen();
        return;
      }
      // Load last active conv
      const lastId = safeLocalGet(LS_KEY_ACTIVE, null);
      const list = listConversations();

      if (lastId) {
        const found = list.find((c) => c.id === lastId);
        if (found) {
          this._openConversation(found);
          this._renderThreads();
          return;
        }
      }

      if (list.length > 0) {
        this._openConversation(list[0]);
      } else {
        this._newConversation();
      }
      this._renderThreads();
    }

    /* ==================================================================
     * Setup screen
     * ================================================================*/
    _showSetupScreen() {
      if (this.refs.setupScreen) this.refs.setupScreen.hidden = false;
      if (this.refs.messages)    this.refs.messages.style.display = "none";
      if (this.refs.suggestions) this.refs.suggestions.hidden = true;
      if (this.refs.inputArea)   this.refs.inputArea.hidden = true;
    }

    _hideSetupScreen() {
      if (this.refs.setupScreen) this.refs.setupScreen.hidden = true;
      if (this.refs.messages)    this.refs.messages.style.display = "";
      if (this.refs.inputArea)   this.refs.inputArea.hidden = false;
    }

    _wireSetup() {
      const { setupKey, setupEye, setupSave, setupTest, setupMsg } = this.refs;
      if (!setupKey) return;

      if (setupEye) {
        setupEye.addEventListener("click", () => {
          setupKey.type = setupKey.type === "password" ? "text" : "password";
        });
      }

      if (setupSave) {
        setupSave.addEventListener("click", () => {
          const k = setupKey.value.trim();
          if (!k.startsWith("sk-ant-")) {
            this._setMsg(setupMsg, "That doesn't look like an Anthropic API key.", "err");
            return;
          }
          saveApiKey(k);
          this.apiKey = k;
          this._setMsg(setupMsg, "Saved. Loading ARIA…", "ok");
          setTimeout(() => {
            this._hideSetupScreen();
            this._bootstrap();
          }, 400);
        });
      }

      if (setupTest) {
        setupTest.addEventListener("click", async () => {
          const k = setupKey.value.trim();
          if (!k) {
            this._setMsg(setupMsg, "Enter an API key first.", "err");
            return;
          }
          this._setMsg(setupMsg, "Testing connection…", "info");
          const result = await this._testKey(k);
          if (result.ok) this._setMsg(setupMsg, "Connected successfully! ✓", "ok");
          else this._setMsg(setupMsg, "Failed: " + result.error, "err");
        });
      }
    }

    _setMsg(el, text, kind) {
      if (!el) return;
      el.textContent = text;
      el.classList.remove("ok","err","info");
      if (kind) el.classList.add(kind);
    }

    async _testKey(key) {
      try {
        const res = await fetch(API_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: this.settings.model || DEFAULT_MODEL,
            max_tokens: 16,
            messages: [{ role: "user", content: "ping" }],
          }),
        });
        if (res.ok) return { ok: true };
        const txt = await res.text();
        let detail;
        try { detail = JSON.parse(txt); } catch (_) { detail = { raw: txt }; }
        const msg = detail && detail.error && detail.error.message
          ? detail.error.message
          : ("HTTP " + res.status);
        return { ok: false, error: msg };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }

    /* ==================================================================
     * Topbar
     * ================================================================*/
    _wireTopBar() {
      const {
        titleInput, exportBtn, clearBtn, sidebarToggle, modelBadge,
      } = this.refs;

      if (titleInput) {
        titleInput.addEventListener("change", () => {
          if (!this.currentConv) return;
          const v = titleInput.value.trim() || "Untitled";
          this.currentConv.title = v.slice(0, MAX_TITLE_LEN);
          saveConversation(this.currentConv);
          this._renderThreads();
        });
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") titleInput.blur();
        });
      }

      if (exportBtn) {
        exportBtn.addEventListener("click", () => this._exportConversation());
      }

      if (clearBtn) {
        clearBtn.addEventListener("click", () => {
          if (!this.currentConv) return;
          const ok = confirm("Clear all messages in this conversation?");
          if (!ok) return;
          this.currentConv.messages = [];
          this.currentConv.title = "New chat";
          saveConversation(this.currentConv);
          this._renderMessages();
          this._renderThreads();
          if (this.refs.titleInput) this.refs.titleInput.value = this.currentConv.title;
        });
      }

      if (sidebarToggle) {
        sidebarToggle.addEventListener("click", () => {
          this.rootEl.classList.toggle("aria-sidebar-hidden");
          this.rootEl.classList.toggle("aria-sidebar-visible");
        });
      }

      if (modelBadge) {
        modelBadge.textContent = this._prettyModel(this.settings.model);
      }
    }

    _prettyModel(model) {
      if (!model) return "Claude";
      if (/opus/i.test(model)) return "Claude Opus 4";
      if (/haiku/i.test(model)) return "Claude Haiku";
      if (/sonnet-4/i.test(model)) return "Claude Sonnet 4";
      if (/sonnet/i.test(model)) return "Claude 3.5 Sonnet";
      return "Claude";
    }

    /* ==================================================================
     * Sidebar / threads
     * ================================================================*/
    _wireSidebar() {
      const { newChatBtn, settingsBtn, threads } = this.refs;
      if (newChatBtn) {
        newChatBtn.addEventListener("click", () => this._newConversation());
      }
      if (settingsBtn) {
        settingsBtn.addEventListener("click", () => this._openSettings());
      }
      if (threads) {
        threads.addEventListener("click", (e) => {
          const del = e.target.closest(".aria-thread-delete");
          if (del) {
            e.stopPropagation();
            const id = del.getAttribute("data-delete");
            this._deleteConversation(id);
            return;
          }
          const th = e.target.closest(".aria-thread");
          if (th) {
            const id = th.getAttribute("data-id");
            if (id && (!this.currentConv || this.currentConv.id !== id)) {
              const conv = loadConversation(id);
              if (conv) this._openConversation(conv);
            }
          }
        });
      }
    }

    _renderThreads() {
      const threads = this.refs.threads;
      if (!threads) return;
      const list = listConversations();
      if (list.length === 0) {
        threads.innerHTML = `<div class="aria-threads-empty">No conversations yet</div>`;
        return;
      }
      threads.innerHTML = list.map((c) => {
        const active = this.currentConv && this.currentConv.id === c.id;
        const lastMsg = c.messages && c.messages.length
          ? c.messages[c.messages.length - 1]
          : null;
        const preview = lastMsg
          ? (lastMsg.role === "user" ? "You: " : "") +
            String(lastMsg.content || "").replace(/\s+/g, " ").slice(0, 56)
          : "No messages yet";
        return `
          <div class="aria-thread ${active ? "active" : ""}"
               data-id="${escapeHtml(c.id)}"
               role="listitem">
            <div class="aria-thread-body">
              <div class="aria-thread-title">${escapeHtml(c.title || "Untitled")}</div>
              <div class="aria-thread-meta">${escapeHtml(formatRelative(c.updatedAt))} · ${escapeHtml(preview)}</div>
            </div>
            <button class="aria-thread-delete"
                    data-delete="${escapeHtml(c.id)}"
                    title="Delete conversation">✕</button>
          </div>
        `;
      }).join("");
    }

    _newConversation() {
      this._abortStream();
      const conv = createConversation("");
      this.currentConv = conv;
      safeLocalSet(LS_KEY_ACTIVE, conv.id);
      if (this.refs.titleInput) this.refs.titleInput.value = conv.title;
      this._renderThreads();
      this._renderMessages();
      if (this.refs.input) this.refs.input.focus();
    }

    _openConversation(conv) {
      this._abortStream();
      this.currentConv = conv;
      safeLocalSet(LS_KEY_ACTIVE, conv.id);
      if (this.refs.titleInput) this.refs.titleInput.value = conv.title || "New chat";
      this._renderThreads();
      this._renderMessages();
    }

    _deleteConversation(id) {
      if (!id) return;
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      deleteConversation(id);
      if (this.currentConv && this.currentConv.id === id) {
        const rest = listConversations();
        if (rest.length > 0) this._openConversation(rest[0]);
        else this._newConversation();
      }
      this._renderThreads();
    }

    /* ==================================================================
     * Messages render
     * ================================================================*/
    _renderMessages() {
      const box = this.refs.messages;
      if (!box) return;
      const conv = this.currentConv;
      const empty = !conv || !conv.messages || conv.messages.length === 0;

      if (empty) {
        box.innerHTML = `
          <div class="aria-empty">
            <div class="aria-empty-logo">🤖</div>
            <h3>How can I help you today?</h3>
            <div class="aria-empty-text">
              Ask me anything — code help, writing, math, explanations.
              I can stream answers in real time and format code blocks.
            </div>
          </div>
        `;
        if (this.refs.suggestions) {
          this.refs.suggestions.hidden = false;
        }
      } else {
        box.innerHTML = "";
        let lastRole = null;
        conv.messages.forEach((m) => {
          const needMeta = m.role !== lastRole;
          if (needMeta) {
            const meta = document.createElement("div");
            meta.className = "aria-msg-meta " + m.role;
            meta.textContent = (m.role === "user" ? "You" : "ARIA") + " · " + formatTime(m.ts || conv.updatedAt);
            box.appendChild(meta);
          }
          this._appendMessageRow(m, false);
          lastRole = m.role;
        });
        if (this.refs.suggestions) this.refs.suggestions.hidden = true;
        // Scroll to bottom
        requestAnimationFrame(() => {
          box.scrollTop = box.scrollHeight;
        });
      }
    }

    _appendMessageRow(msg, scroll) {
      const box = this.refs.messages;
      if (!box) return null;
      const row = document.createElement("div");
      row.className = "aria-msg-row " + msg.role + (msg.error ? " error" : "");
      const bubble = document.createElement("div");
      bubble.className = "aria-bubble";
      if (msg.role === "user") {
        bubble.textContent = msg.content;
        // User messages: preserve plain text with line breaks
        bubble.innerHTML = inlineMd(msg.content || "").replace(/\n/g, "<br/>");
      } else {
        bubble.innerHTML = renderMarkdown(msg.content || "");
        // Wire copy buttons
        this._wireCopyButtons(bubble);
      }
      row.appendChild(bubble);
      box.appendChild(row);
      if (scroll !== false) {
        box.scrollTop = box.scrollHeight;
      }
      return { row, bubble };
    }

    _wireCopyButtons(scope) {
      (scope || document).querySelectorAll(".aria-code-copy").forEach((btn) => {
        if (btn.dataset.wired) return;
        btn.dataset.wired = "1";
        btn.addEventListener("click", async () => {
          const raw = decodeURIComponent(btn.getAttribute("data-copy") || "");
          const ok = await copyToClipboard(raw);
          btn.textContent = ok ? "Copied ✓" : "Failed";
          btn.classList.toggle("copied", !!ok);
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 1400);
        });
      });
    }

    /* ==================================================================
     * Suggestions
     * ================================================================*/
    _wireSuggestions() {
      const grid = this.refs.suggestionGrid;
      if (!grid) return;
      grid.innerHTML = SUGGESTED_PROMPTS.map((p) => `
        <button class="aria-suggestion" data-prompt="${escapeHtml(p.text)}">
          <span class="aria-suggestion-icon">${escapeHtml(p.icon)}</span>
          <span>${escapeHtml(p.text)}</span>
        </button>
      `).join("");
      grid.addEventListener("click", (e) => {
        const b = e.target.closest(".aria-suggestion");
        if (!b) return;
        const prompt = b.getAttribute("data-prompt");
        if (this.refs.input) this.refs.input.value = prompt;
        this._sendMessage();
      });
    }

    /* ==================================================================
     * Input wiring
     * ================================================================*/
    _wireInput() {
      const { input, sendBtn, voiceBtn, attachBtn, charCounter } = this.refs;
      if (!input) return;

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          this._sendMessage();
        }
      });
      input.addEventListener("input", () => {
        this._autoGrow();
        this._updateCharCounter();
      });
      if (sendBtn) sendBtn.addEventListener("click", () => this._sendMessage());
      if (voiceBtn) voiceBtn.addEventListener("click", () => this._toggleVoice());
      if (attachBtn) {
        attachBtn.addEventListener("click", () => {
          if (window.Notifications) {
            window.Notifications.info(
              "Attachments",
              "File attachments will be available in a future release.",
              { appName: "ARIA", appIcon: APP_ICON, duration: 2500 }
            );
          }
        });
      }
      this._updateCharCounter();
    }

    _autoGrow() {
      const input = this.refs.input;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = Math.min(180, input.scrollHeight) + "px";
    }

    _updateCharCounter() {
      const input = this.refs.input;
      const c = this.refs.charCounter;
      if (!input || !c) return;
      const n = input.value.length;
      c.textContent = n + (n > 0 ? " / " + MAX_INPUT_CHARS : "");
      c.classList.toggle("warn",  n > MAX_INPUT_CHARS * 0.85 && n <= MAX_INPUT_CHARS);
      c.classList.toggle("error", n > MAX_INPUT_CHARS);
    }

    /* ==================================================================
     * Voice input
     * ================================================================*/
    _toggleVoice() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const { voiceBtn, recIndicator, input } = this.refs;
      if (!SR) {
        if (window.Notifications) {
          window.Notifications.warning(
            "Voice input unavailable",
            "Your browser doesn't support the Web Speech API. Try Chrome or Edge.",
            { appName: "ARIA", appIcon: APP_ICON, duration: 4000 }
          );
        }
        return;
      }
      if (this.recActive) {
        try { this.rec.stop(); } catch (_) {}
        return;
      }
      const rec = new SR();
      this.rec = rec;
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = (navigator.language || "en-US");

      let finalText = "";
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (input) {
          input.value = (finalText + interim).trim();
          this._autoGrow();
          this._updateCharCounter();
        }
      };
      rec.onstart = () => {
        this.recActive = true;
        if (voiceBtn) voiceBtn.classList.add("recording");
        if (recIndicator) recIndicator.hidden = false;
      };
      rec.onend = () => {
        this.recActive = false;
        if (voiceBtn) voiceBtn.classList.remove("recording");
        if (recIndicator) recIndicator.hidden = true;
      };
      rec.onerror = (e) => {
        console.warn("[ARIA] voice error:", e);
        if (window.Notifications) {
          window.Notifications.error(
            "Voice input error",
            e.error || "Unknown error",
            { appName: "ARIA", appIcon: APP_ICON, duration: 3000 }
          );
        }
      };
      try { rec.start(); } catch (e) {
        console.error("[ARIA] voice start failed:", e);
      }
    }

    /* ==================================================================
     * Send message / streaming
     * ================================================================*/
    async _sendMessage() {
      if (!this.apiKey) {
        this._showSetupScreen();
        return;
      }
      const input = this.refs.input;
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      if (text.length > MAX_INPUT_CHARS) {
        if (window.Notifications) {
          window.Notifications.error(
            "Too long",
            "Please limit your message to " + MAX_INPUT_CHARS + " characters.",
            { appName: "ARIA", appIcon: APP_ICON }
          );
        }
        return;
      }
      if (this.streamingAbort) {
        // Currently streaming — cancel
        this._abortStream();
      }
      input.value = "";
      this._autoGrow();
      this._updateCharCounter();

      if (!this.currentConv) this._newConversation();
      const conv = this.currentConv;

      // Hide suggestions
      if (this.refs.suggestions) this.refs.suggestions.hidden = true;

      // Push user message
      const now = Date.now();
      conv.messages.push({ role: "user", content: text, ts: now });
      if (conv.messages.length === 1 && (!conv.title || conv.title === "New chat")) {
        conv.title = truncateTitle(text);
        if (this.refs.titleInput) this.refs.titleInput.value = conv.title;
      }
      saveConversation(conv);

      // Remove empty placeholder if any
      const empty = this.refs.messages && this.refs.messages.querySelector(".aria-empty");
      if (empty) this.refs.messages.innerHTML = "";

      // Meta + user bubble
      const box = this.refs.messages;
      const meta = document.createElement("div");
      meta.className = "aria-msg-meta user";
      meta.textContent = "You · " + formatTime(now);
      box.appendChild(meta);
      this._appendMessageRow({ role: "user", content: text });

      // Assistant bubble with thinking indicator
      const metaA = document.createElement("div");
      metaA.className = "aria-msg-meta assistant";
      metaA.textContent = "ARIA · " + formatTime(Date.now());
      box.appendChild(metaA);
      const row = document.createElement("div");
      row.className = "aria-msg-row assistant streaming";
      const bubble = document.createElement("div");
      bubble.className = "aria-bubble";
      bubble.innerHTML = `<span class="aria-thinking">
        <span class="aria-thinking-dot"></span>
        <span class="aria-thinking-dot"></span>
        <span class="aria-thinking-dot"></span>
      </span>`;
      row.appendChild(bubble);
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;

      this.streamingBubbleEl = bubble;

      // Stream
      const streamStart = Date.now();
      try {
        await this._streamCompletion(conv, bubble);
        row.classList.remove("streaming");
        this._renderThreads();
        // Notify if long
        if (window.AriaNotify && (Date.now() - streamStart) > 10000) {
          const preview = (bubble.textContent || "").slice(0, 80).trim();
          window.AriaNotify.responseReady(preview);
        }
      } catch (e) {
        row.classList.remove("streaming");
        if (e.name === "AbortError") {
          bubble.innerHTML = `<em>(cancelled)</em>`;
        } else {
          row.classList.add("error");
          bubble.textContent = "Error: " + (e.message || String(e));
          if (window.Notifications) {
            window.Notifications.error(
              "ARIA error",
              e.message || "Failed to connect to Anthropic.",
              { appName: "ARIA", appIcon: APP_ICON, duration: 4500 }
            );
          }
        }
      } finally {
        this.streamingAbort = null;
        this.streamingBubbleEl = null;
      }
    }

    _abortStream() {
      if (this.streamingAbort) {
        try { this.streamingAbort.abort(); } catch (_) {}
        this.streamingAbort = null;
      }
    }

    async _streamCompletion(conv, bubble) {
      const messages = conv.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => m.content && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));

      const body = {
        model:       this.settings.model || DEFAULT_MODEL,
        max_tokens:  this.settings.maxTokens || 2048,
        temperature: this.settings.temperature,
        system:      this.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
        messages,
        stream:      true,
      };

      const controller = new AbortController();
      this.streamingAbort = controller;
      const res = await fetch(API_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const txt = await res.text();
        let msg = "HTTP " + res.status;
        try {
          const obj = JSON.parse(txt);
          if (obj && obj.error && obj.error.message) msg = obj.error.message;
        } catch (_) {}
        throw new Error(msg);
      }

      if (!res.body) {
        // No streaming support; fall back to plain JSON
        const text = await res.text();
        let full = "";
        try {
          const obj = JSON.parse(text);
          if (obj && Array.isArray(obj.content)) {
            full = obj.content.map((c) => c.text || "").join("");
          }
        } catch (_) {}
        this._finalizeAssistant(conv, bubble, full);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let acc = "";

      // Clear thinking dots before first token
      let cleared = false;
      const clearDots = () => {
        if (cleared) return;
        bubble.innerHTML = "";
        cleared = true;
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = parseSseEvent(chunk);
          if (!event) continue;
          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta && typeof delta.text === "string") {
              clearDots();
              acc += delta.text;
              bubble.innerHTML = renderMarkdown(acc);
              this._wireCopyButtons(bubble);
              this._scrollIfNearBottom();
            }
          } else if (event.type === "message_stop") {
            // End
          } else if (event.type === "error") {
            throw new Error(event.error && event.error.message || "stream error");
          }
        }
      }
      this._finalizeAssistant(conv, bubble, acc);
    }

    _finalizeAssistant(conv, bubble, text) {
      bubble.innerHTML = renderMarkdown(text);
      this._wireCopyButtons(bubble);
      conv.messages.push({ role: "assistant", content: text, ts: Date.now() });
      saveConversation(conv);
    }

    _scrollIfNearBottom() {
      const box = this.refs.messages;
      if (!box) return;
      const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
      if (dist < 80) box.scrollTop = box.scrollHeight;
    }

    /* ==================================================================
     * Settings panel
     * ================================================================*/
    _wireSettings() {
      const {
        settingsPanel, settingsClose, settingsKey, settingsEye,
        settingsTest, settingsMsg, tempSlider, tempValue,
        maxTokens, systemPrompt, modelSelect, resetBtn, saveBtn,
      } = this.refs;

      if (!settingsPanel) return;

      // Initial values
      if (settingsKey)    settingsKey.value    = this.apiKey;
      if (tempSlider)     tempSlider.value     = this.settings.temperature;
      if (tempValue)      tempValue.textContent= this.settings.temperature;
      if (maxTokens)      maxTokens.value      = this.settings.maxTokens;
      if (systemPrompt)   systemPrompt.value   = this.settings.systemPrompt;
      if (modelSelect)    modelSelect.value    = this.settings.model;

      if (settingsEye) {
        settingsEye.addEventListener("click", () => {
          settingsKey.type = settingsKey.type === "password" ? "text" : "password";
        });
      }
      if (tempSlider) {
        tempSlider.addEventListener("input", () => {
          tempValue.textContent = Number(tempSlider.value).toFixed(2);
        });
      }
      if (settingsClose) {
        settingsClose.addEventListener("click", () => this._closeSettings());
      }
      if (settingsTest) {
        settingsTest.addEventListener("click", async () => {
          const k = (settingsKey.value || "").trim();
          if (!k) {
            this._setMsg(settingsMsg, "Enter an API key first.", "err");
            return;
          }
          this._setMsg(settingsMsg, "Testing connection…", "info");
          const r = await this._testKey(k);
          this._setMsg(settingsMsg, r.ok ? "Connected ✓" : ("Failed: " + r.error), r.ok ? "ok" : "err");
        });
      }
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          if (!confirm("Reset ARIA settings to defaults? Your API key is kept.")) return;
          this.settings = Object.assign({}, DEFAULT_SETTINGS);
          saveSettings(this.settings);
          if (tempSlider)   tempSlider.value = this.settings.temperature;
          if (tempValue)    tempValue.textContent = this.settings.temperature;
          if (maxTokens)    maxTokens.value = this.settings.maxTokens;
          if (systemPrompt) systemPrompt.value = this.settings.systemPrompt;
          if (modelSelect)  modelSelect.value = this.settings.model;
          this._setMsg(settingsMsg, "Defaults restored.", "ok");
          if (this.refs.modelBadge) this.refs.modelBadge.textContent = this._prettyModel(this.settings.model);
        });
      }
      if (saveBtn) {
        saveBtn.addEventListener("click", () => {
          const k = (settingsKey.value || "").trim();
          if (k) { saveApiKey(k); this.apiKey = k; }
          this.settings.temperature  = clamp(parseFloat(tempSlider.value), 0, 1);
          this.settings.maxTokens    = parseInt(maxTokens.value, 10);
          this.settings.systemPrompt = systemPrompt.value.trim() || DEFAULT_SYSTEM_PROMPT;
          this.settings.model        = modelSelect.value;
          saveSettings(this.settings);
          if (this.refs.modelBadge) this.refs.modelBadge.textContent = this._prettyModel(this.settings.model);
          this._setMsg(settingsMsg, "Saved ✓", "ok");
          setTimeout(() => this._closeSettings(), 500);
        });
      }
    }

    _openSettings() {
      const p = this.refs.settingsPanel;
      if (!p) return;
      p.hidden = false;
      p.classList.remove("aria-out");
    }

    _closeSettings() {
      const p = this.refs.settingsPanel;
      if (!p) return;
      p.classList.add("aria-out");
      setTimeout(() => { p.hidden = true; p.classList.remove("aria-out"); }, 240);
    }

    /* ==================================================================
     * Export
     * ================================================================*/
    _exportConversation() {
      if (!this.currentConv || !this.currentConv.messages.length) {
        if (window.Notifications) {
          window.Notifications.warning("Nothing to export",
            "This conversation has no messages yet.",
            { appName: "ARIA", appIcon: APP_ICON });
        }
        return;
      }
      const choice = prompt(
        "Export format?\nType 'md' for Markdown or 'txt' for plain text.",
        "md"
      );
      if (choice == null) return;
      const fmt = choice.toLowerCase().trim();
      if (fmt !== "md" && fmt !== "txt") return;

      const conv = this.currentConv;
      const lines = [];
      lines.push("# " + (conv.title || "Conversation"));
      lines.push("");
      lines.push("_Exported on " + new Date().toLocaleString() + "_");
      lines.push("");
      lines.push("---");
      lines.push("");
      conv.messages.forEach((m) => {
        const when = formatTime(m.ts || conv.updatedAt);
        const who = m.role === "user" ? "You" : "ARIA";
        if (fmt === "md") {
          lines.push("### " + who + " · " + when);
          lines.push("");
          lines.push(m.content || "");
          lines.push("");
        } else {
          lines.push("[" + when + "] " + who + ":");
          lines.push(m.content || "");
          lines.push("");
        }
      });
      const body = lines.join("\n");
      const safe = (conv.title || "Conversation").replace(/[^\w\s.-]/g, "").trim()
                   .replace(/\s+/g, "_").slice(0, 40) || "Conversation";
      const filename = safe + "." + fmt;
      if (!window.FileSystem) {
        // Offline fallback: prompt download
        const blob = new Blob([body], { type: fmt === "md" ? "text/markdown" : "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return;
      }
      try {
        const base = "/Documents";
        if (!window.FileSystem.exists(base)) {
          window.FileSystem.createFolder(base, { recursive: true });
        }
        let p = base + "/" + filename;
        let n = 1;
        while (window.FileSystem.exists(p)) {
          p = base + "/" + safe + "_" + n + "." + fmt;
          n++;
        }
        window.FileSystem.writeFile(p, body, {
          kind: "text",
          mime: fmt === "md" ? "text/markdown" : "text/plain",
          announce: true,
          appName: "ARIA",
        });
        if (window.Notifications) {
          window.Notifications.success(
            "Conversation exported",
            p,
            {
              appName: "ARIA",
              appIcon: APP_ICON,
              duration: 3500,
              actionLabel: "Open",
              action: () => {
                if (window.WindowManager && window.WindowManager.openApp) {
                  window.WindowManager.openApp("filemanager", { startPath: base });
                }
              },
            }
          );
        }
      } catch (e) {
        if (window.Notifications) {
          window.Notifications.error("Export failed", e.message, {
            appName: "ARIA", appIcon: APP_ICON });
        }
      }
    }

    /* ==================================================================
     * Keyboard shortcuts (scoped to ARIA window)
     * ================================================================*/
    _onDocKey(e) {
      // Only handle keys when this window is focused (has descendant focus)
      if (!this.body.contains(document.activeElement) && !this.body.contains(e.target)) {
        // Let through to global handlers
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "n" || e.key === "N") {
          // Only if the focus is inside us AND not inside a generic input
          if (this._isOurFocus()) {
            e.preventDefault();
            this._newConversation();
            return;
          }
        }
        if (e.key === "Delete") {
          if (this._isOurFocus() && this.currentConv) {
            e.preventDefault();
            this._deleteConversation(this.currentConv.id);
            return;
          }
        }
      }
      if (e.key === "Escape") {
        const p = this.refs.settingsPanel;
        if (p && !p.hidden) {
          e.preventDefault();
          this._closeSettings();
        }
      }
    }

    _isOurFocus() {
      const a = document.activeElement;
      if (!a) return false;
      if (!this.body.contains(a)) return false;
      return true;
    }
  }

  /* ==========================================================================
   * Conversation folders / tagging (lightweight, localStorage only)
   * ========================================================================*/

  const LS_KEY_TAGS = "webos.aria.tags.v1";

  function getTags() {
    return safeLocalGet(LS_KEY_TAGS, {}) || {};
  }

  function setTags(convId, tags) {
    if (!convId) return false;
    const db = getTags();
    db[convId] = Array.isArray(tags) ? tags.slice(0, 8) : [];
    safeLocalSet(LS_KEY_TAGS, db);
    return true;
  }

  function addTag(convId, tag) {
    if (!convId || !tag) return false;
    const t = String(tag).trim().toLowerCase().slice(0, 24);
    if (!t) return false;
    const db = getTags();
    const cur = new Set(db[convId] || []);
    cur.add(t);
    db[convId] = Array.from(cur).slice(0, 8);
    safeLocalSet(LS_KEY_TAGS, db);
    return true;
  }

  function removeTag(convId, tag) {
    if (!convId || !tag) return false;
    const db = getTags();
    const cur = (db[convId] || []).filter((x) => x !== tag);
    db[convId] = cur;
    safeLocalSet(LS_KEY_TAGS, db);
    return true;
  }

  function getAllTags() {
    const db = getTags();
    const counts = {};
    Object.values(db).forEach((arr) => {
      (arr || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    });
    return counts;
  }

  function filterByTag(tag) {
    const db = getTags();
    const ids = Object.keys(db).filter((id) => (db[id] || []).indexOf(tag) >= 0);
    return listConversations().filter((c) => ids.indexOf(c.id) >= 0);
  }

  /* ==========================================================================
   * Message role replacement utilities
   * ========================================================================*/

  function countMessagesByRole(conv, role) {
    if (!conv || !conv.messages) return 0;
    return conv.messages.filter((m) => m.role === role).length;
  }

  function lastMessage(conv) {
    if (!conv || !conv.messages || conv.messages.length === 0) return null;
    return conv.messages[conv.messages.length - 1];
  }

  function firstUserMessage(conv) {
    if (!conv || !conv.messages) return null;
    return conv.messages.find((m) => m.role === "user") || null;
  }

  /* ==========================================================================
   * Draft auto-save (per-conversation in-progress input text)
   * ========================================================================*/

  function saveDraft(convId, text) {
    if (!convId) return;
    const key = "webos.aria.draft." + convId;
    if (text && text.length > 0) safeLocalSetRaw(key, text);
    else try { localStorage.removeItem(key); } catch (_) {}
  }

  function loadDraft(convId) {
    if (!convId) return "";
    return safeLocalGetRaw("webos.aria.draft." + convId, "");
  }

  function clearAllDrafts() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("webos.aria.draft.")) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
      return keys.length;
    } catch (_) { return 0; }
  }

  /* ==========================================================================
   * Message content sanitization helpers
   * ========================================================================*/

  function stripCodeBlocks(text) {
    if (!text) return "";
    return String(text).replace(/```[\s\S]*?```/g, "[code]");
  }

  function extractCodeBlocks(text) {
    if (!text) return [];
    const out = [];
    const re = /```([a-zA-Z0-9+-_]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ lang: m[1] || "", code: m[2] || "" });
    }
    return out;
  }

  function countCodeBlocks(conv) {
    if (!conv || !conv.messages) return 0;
    let n = 0;
    conv.messages.forEach((m) => { n += extractCodeBlocks(m.content || "").length; });
    return n;
  }

  /* ==========================================================================
   * Conversation merge (combine two conversations into one)
   * ========================================================================*/

  function mergeConversations(idA, idB, newTitle) {
    const a = loadConversation(idA);
    const b = loadConversation(idB);
    if (!a || !b) return null;
    const merged = {
      id: uid(),
      title: newTitle || (a.title + " + " + b.title).slice(0, MAX_TITLE_LEN),
      model: a.model || b.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [].concat(a.messages || [], b.messages || []),
    };
    saveConversation(merged);
    return merged;
  }

  /* ==========================================================================
   * Conversation summary (uses last-assistant text as short summary)
   * ========================================================================*/

  function shortSummary(conv, maxChars) {
    if (!conv || !conv.messages || conv.messages.length === 0) return "";
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant");
    const source = lastAssistant ? lastAssistant.content : conv.messages[0].content;
    if (!source) return "";
    const plain = String(source).replace(/```[\s\S]*?```/g, "")
                                .replace(/[#*`_>~]/g, " ")
                                .replace(/\s+/g, " ")
                                .trim();
    const max = maxChars || 140;
    return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
  }

  /* ==========================================================================
   * Streaming state machine helpers (used internally)
   * ========================================================================*/

  function newStreamState() {
    return {
      startedAt: Date.now(),
      endedAt:   0,
      tokens:    0,
      chunks:    0,
      aborted:   false,
      error:     null,
    };
  }

  function markStreamChunk(st, text) {
    if (!st) return;
    st.chunks++;
    st.tokens += estimateTokens(text);
  }

  function markStreamEnd(st) {
    if (!st) return;
    st.endedAt = Date.now();
  }

  function streamDurationMs(st) {
    if (!st || !st.startedAt) return 0;
    return (st.endedAt || Date.now()) - st.startedAt;
  }

  function streamTokensPerSecond(st) {
    const dur = streamDurationMs(st);
    if (dur <= 0) return 0;
    return Math.round((st.tokens / dur) * 1000);
  }

  /* ==========================================================================
   * Conversation export to HTML (shareable single file)
   * ========================================================================*/

  function exportConversationAsHtml(conv) {
    if (!conv) return "";
    const title = escapeHtml(conv.title || "Conversation");
    const msgs = (conv.messages || []).map((m) => {
      const role = m.role === "user" ? "You" : "ARIA";
      const when = formatTime(m.ts || conv.updatedAt);
      const body = m.role === "user"
        ? escapeHtml(m.content || "").replace(/\n/g, "<br/>")
        : renderMarkdown(m.content || "");
      return `<div class="m ${m.role}"><h4>${role} <small>${when}</small></h4><div>${body}</div></div>`;
    }).join("\n");
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;max-width:780px;margin:30px auto;padding:0 20px;color:#1b1f2e;background:#fafbff;}
  h1{letter-spacing:-0.02em;}
  .m{padding:14px 18px;margin-bottom:14px;border-radius:10px;}
  .m.user{background:#eef2ff;}
  .m.assistant{background:white;border:1px solid #e5e7eb;}
  .m h4{margin:0 0 8px;font-size:13px;color:#475569;}
  .m small{color:#94a3b8;font-weight:normal;}
  pre{background:#0b1020;color:#e6e9f2;padding:10px 12px;border-radius:6px;overflow-x:auto;font-size:13px;}
  code{font-family:'JetBrains Mono',ui-monospace,monospace;background:rgba(0,0,0,.05);padding:1px 5px;border-radius:3px;}
  pre code{background:transparent;padding:0;}
</style></head><body>
<h1>${title}</h1>
<p><em>Exported from ARIA on ${new Date().toLocaleString()}</em></p>
<hr/>
${msgs}
</body></html>`;
  }

  /* ==========================================================================
   * Keyboard shortcut help dialog (shown with Ctrl+/)
   * ========================================================================*/

  const SHORTCUTS = [
    { keys: "Enter",            desc: "Send message" },
    { keys: "Shift+Enter",      desc: "Insert newline" },
    { keys: "Ctrl+N",           desc: "New conversation" },
    { keys: "Ctrl+Delete",      desc: "Delete current conversation" },
    { keys: "Esc",              desc: "Close settings panel" },
    { keys: "Win+A",            desc: "Open ARIA (global)" },
    { keys: "Ctrl+/",           desc: "Show this help" },
  ];

  function getShortcuts() { return SHORTCUTS.slice(); }

  /* ==========================================================================
   * Code block language map (pretty labels)
   * ========================================================================*/

  const LANG_LABELS = {
    js: "JavaScript", javascript: "JavaScript",
    ts: "TypeScript", typescript: "TypeScript",
    py: "Python", python: "Python",
    json: "JSON", yaml: "YAML", toml: "TOML",
    sh: "Shell", bash: "Bash", zsh: "Zsh",
    html: "HTML", xml: "XML", css: "CSS", scss: "SCSS",
    sql: "SQL", go: "Go", rust: "Rust", java: "Java",
    kotlin: "Kotlin", swift: "Swift", c: "C", cpp: "C++",
    cs: "C#", rb: "Ruby", php: "PHP", lua: "Lua",
    r: "R", md: "Markdown", markdown: "Markdown",
  };

  function prettyLang(lang) {
    if (!lang) return "text";
    return LANG_LABELS[String(lang).toLowerCase()] || lang;
  }

  /* ==========================================================================
   * Markdown post-processor: enhance rendered output with features such as
   * task-list checkboxes, collapsible details, and auto-linking of bare URLs.
   * Applied at render time by wrapping renderMarkdown output.
   * ========================================================================*/

  function enhanceMarkdownHtml(html) {
    if (!html) return "";
    // Task-list items: [ ] and [x]
    html = html.replace(/<li>\s*\[ \]\s+/g, '<li class="aria-task"><input type="checkbox" disabled> ');
    html = html.replace(/<li>\s*\[x\]\s+/gi, '<li class="aria-task done"><input type="checkbox" checked disabled> ');
    // Bare URL auto-link (inside <p>, outside of <a>)
    html = html.replace(
      /(^|[^">])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
      (_, pre, url) => pre + `<a href="${url}" target="_blank" rel="noopener">${url}</a>`
    );
    return html;
  }

  /* ==========================================================================
   * Emoji aliases (converts :smile: → 😄 etc.)
   * ========================================================================*/

  const EMOJI_ALIASES = {
    ":smile:": "😄", ":laughing:": "😆", ":blush:": "😊",
    ":sunglasses:": "😎", ":thinking:": "🤔", ":cry:": "😢",
    ":wink:": "😉", ":heart:": "❤️", ":fire:": "🔥",
    ":+1:": "👍", ":-1:": "👎", ":ok:": "👌",
    ":rocket:": "🚀", ":star:": "⭐", ":warning:": "⚠️",
    ":check:": "✅", ":x:": "❌", ":bulb:": "💡",
    ":bug:": "🐛", ":wave:": "👋", ":tada:": "🎉",
  };

  function applyEmojiAliases(text) {
    if (!text) return text;
    return text.replace(/:[a-z0-9_+-]+:/gi, (m) =>
      EMOJI_ALIASES[m.toLowerCase()] || m);
  }

  /* ==========================================================================
   * Request retry with exponential backoff (for transient errors)
   * ========================================================================*/

  async function retryableFetch(url, init, maxRetries) {
    const max = maxRetries != null ? maxRetries : 2;
    let lastError = null;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await fetch(url, init);
        if (res.ok) return res;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return res;
        }
        lastError = new Error("HTTP " + res.status);
      } catch (e) {
        lastError = e;
      }
      if (attempt < max) {
        const delay = Math.min(8000, 500 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || new Error("Request failed");
  }

  /* ==========================================================================
   * Prune / housekeeping
   * ========================================================================*/

  function pruneEmptyConversations() {
    const all = listConversations();
    let removed = 0;
    all.forEach((c) => {
      if (!c.messages || c.messages.length === 0) {
        deleteConversation(c.id);
        removed++;
      }
    });
    return removed;
  }

  function pruneOlderThan(ms) {
    const cutoff = Date.now() - (ms || 1000 * 60 * 60 * 24 * 30);
    const all = listConversations();
    let removed = 0;
    all.forEach((c) => {
      if ((c.updatedAt || 0) < cutoff) {
        deleteConversation(c.id);
        removed++;
      }
    });
    return removed;
  }

  function totalStorageSize() {
    let bytes = 0;
    listConversations().forEach((c) => {
      bytes += JSON.stringify(c).length;
    });
    return bytes;
  }

  /* ==========================================================================
   * SSE parser for Anthropic event stream
   * ========================================================================*/

  function parseSseEvent(chunk) {
    if (!chunk || !chunk.trim()) return null;
    const lines = chunk.split("\n");
    let event = null, dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join("\n");
    if (!dataStr) return null;
    try {
      const data = JSON.parse(dataStr);
      if (!data) return null;
      return Object.assign({ type: event || data.type || "" }, data);
    } catch (_) {
      return null;
    }
  }

  /* ==========================================================================
   * Clipboard helper
   * ========================================================================*/

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }

  /* ==========================================================================
   * Template loader — inline aria.html into the document as a <template>
   * ========================================================================*/

  async function ensureTemplateLoaded() {
    if (document.getElementById("aria-app-template")) return true;
    try {
      const res = await fetch("apps/aria/aria.html", { cache: "force-cache" });
      if (!res.ok) return false;
      const html = await res.text();
      const wrap = document.createElement("div");
      wrap.innerHTML = html;
      const tmpl = wrap.querySelector("#aria-app-template");
      if (tmpl) {
        document.body.appendChild(tmpl);
        return true;
      }
    } catch (e) {
      console.warn("[ARIA] template fetch failed:", e);
    }
    return false;
  }

  /* ==========================================================================
   * Conversation helpers: filtering by date, by model, by length
   * ========================================================================*/

  function filterByDateRange(startTs, endTs) {
    const list = listConversations();
    const s = startTs || 0;
    const e = endTs || Number.MAX_SAFE_INTEGER;
    return list.filter((c) => (c.updatedAt || 0) >= s && (c.updatedAt || 0) <= e);
  }

  function filterByModel(model) {
    if (!model) return listConversations();
    return listConversations().filter((c) => c.model === model);
  }

  function filterByLength(minMessages) {
    const n = parseInt(minMessages, 10) || 0;
    return listConversations().filter((c) => (c.messages || []).length >= n);
  }

  function sortConversationsBy(criterion) {
    const list = listConversations();
    switch (criterion) {
      case "newest":
        return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      case "oldest":
        return list.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      case "longest":
        return list.sort((a, b) =>
          (b.messages || []).length - (a.messages || []).length);
      case "shortest":
        return list.sort((a, b) =>
          (a.messages || []).length - (b.messages || []).length);
      case "title":
        return list.sort((a, b) =>
          String(a.title || "").localeCompare(String(b.title || "")));
      default:
        return list;
    }
  }

  /* ==========================================================================
   * Conversation search / filter / rename / duplicate
   * ========================================================================*/

  function searchConversations(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return listConversations();
    return listConversations().filter((c) => {
      if ((c.title || "").toLowerCase().includes(q)) return true;
      return (c.messages || []).some((m) =>
        (m.content || "").toLowerCase().includes(q)
      );
    });
  }

  function renameConversation(id, newTitle) {
    const conv = loadConversation(id);
    if (!conv) return false;
    conv.title = String(newTitle || "Untitled").slice(0, MAX_TITLE_LEN);
    saveConversation(conv);
    return true;
  }

  function duplicateConversation(id) {
    const src = loadConversation(id);
    if (!src) return null;
    const copy = {
      id: uid(),
      title: (src.title || "Untitled") + " (copy)",
      model: src.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: JSON.parse(JSON.stringify(src.messages || [])),
    };
    saveConversation(copy);
    return copy;
  }

  function exportAllConversations() {
    const all = listConversations();
    return JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      conversations: all,
    }, null, 2);
  }

  function importConversations(json) {
    try {
      const obj = typeof json === "string" ? JSON.parse(json) : json;
      if (!obj || !Array.isArray(obj.conversations)) return 0;
      let n = 0;
      obj.conversations.forEach((c) => {
        if (!c || !c.id || !Array.isArray(c.messages)) return;
        // Give new id if collision
        const exists = loadConversation(c.id);
        if (exists) c.id = uid();
        saveConversation(c);
        n++;
      });
      return n;
    } catch (e) {
      console.warn("[ARIA] importConversations failed:", e);
      return 0;
    }
  }

  /* ==========================================================================
   * Conversation stats
   * ========================================================================*/

  function conversationStats(conv) {
    if (!conv) return null;
    const messages = conv.messages || [];
    const users = messages.filter((m) => m.role === "user").length;
    const assistants = messages.filter((m) => m.role === "assistant").length;
    let totalChars = 0;
    messages.forEach((m) => { totalChars += (m.content || "").length; });
    return {
      id: conv.id,
      title: conv.title,
      messageCount: messages.length,
      userTurns: users,
      assistantTurns: assistants,
      approxTokens: Math.round(totalChars / 4),
      charCount: totalChars,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  function allConversationStats() {
    return listConversations().map(conversationStats);
  }

  /* ==========================================================================
   * Regenerate / edit / copy message helpers
   *
   * These are usable programmatically; UI wiring lives in the class.
   * ========================================================================*/

  function regenerateLast(conv) {
    if (!conv || !conv.messages || conv.messages.length === 0) return false;
    // Drop trailing assistant message(s)
    while (conv.messages.length > 0 &&
           conv.messages[conv.messages.length - 1].role === "assistant") {
      conv.messages.pop();
    }
    saveConversation(conv);
    return true;
  }

  function editUserMessage(conv, index, newContent) {
    if (!conv || !conv.messages) return false;
    const m = conv.messages[index];
    if (!m || m.role !== "user") return false;
    m.content = String(newContent || "");
    // Drop everything after this user message
    conv.messages = conv.messages.slice(0, index + 1);
    saveConversation(conv);
    return true;
  }

  /* ==========================================================================
   * Token estimator (rough, 1 token ≈ 4 characters)
   * ========================================================================*/

  function estimateTokens(text) {
    if (!text) return 0;
    // Rough heuristic: 1 token ≈ 4 English characters; code a bit denser
    return Math.ceil(String(text).length / 4);
  }

  function estimateConversationTokens(conv) {
    if (!conv || !conv.messages) return 0;
    let t = estimateTokens(loadSettings().systemPrompt || "");
    conv.messages.forEach((m) => { t += estimateTokens(m.content || ""); });
    return t;
  }

  /* ==========================================================================
   * Built-in system prompt presets
   * ========================================================================*/

  const PROMPT_PRESETS = [
    { name: "Default (WebOS assistant)", prompt: DEFAULT_SYSTEM_PROMPT },
    { name: "Coding expert",
      prompt: "You are ARIA, an expert software engineer. Provide concise, " +
              "production-quality code with explanations. Prefer modern " +
              "idioms, highlight edge cases, and avoid unnecessary dependencies." },
    { name: "Writing coach",
      prompt: "You are ARIA, a writing coach. Help the user improve clarity, " +
              "structure, and tone. Suggest edits and explain why. Avoid rewriting " +
              "unless asked." },
    { name: "Terse (minimal answers)",
      prompt: "You are ARIA. Reply with the shortest correct answer possible." },
    { name: "Teacher",
      prompt: "You are ARIA, a patient teacher. Break concepts into small steps, " +
              "provide examples, and check understanding with short questions." },
  ];

  function getPromptPresets() { return PROMPT_PRESETS.slice(); }

  /* ==========================================================================
   * Legacy / utility helpers for debugging
   * ========================================================================*/

  function debugExport() {
    return {
      apiKey:        !!loadApiKey(),
      settings:      loadSettings(),
      conversationCount: listConversations().length,
      activeId:      safeLocalGet(LS_KEY_ACTIVE, null),
    };
  }

  function resetAll() {
    if (!confirm("Reset ARIA? This will delete all conversations and settings.")) return false;
    // Delete all conversations
    const all = listConversations();
    all.forEach((c) => deleteConversation(c.id));
    // Clear settings and active marker
    try { localStorage.removeItem(LS_KEY_SETTINGS); } catch (_) {}
    try { localStorage.removeItem(LS_KEY_ACTIVE); } catch (_) {}
    if (window.FileSystem && window.FileSystem.exists(FS_SETTINGS_PATH)) {
      try { window.FileSystem.deleteFile(FS_SETTINGS_PATH, { permanent: true }); } catch (_) {}
    }
    return true;
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
      width:     960,
      height:    640,
      minWidth:  560,
      minHeight: 420,
      category:  "AI",
      pinned:    true,

      render(body, win) {
        // Ensure template is available (async — but OK to create app and refill)
        ensureTemplateLoaded().then(() => {
          const app = new AriaApp(body, win);
          win._ariaApp = app;
          app.mount();
        });
        body.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#a5b4fc;font-family:var(--font-ui,Inter),sans-serif;font-size:13px;">
            <span class="aria-thinking">
              <span class="aria-thinking-dot"></span>
              <span class="aria-thinking-dot"></span>
              <span class="aria-thinking-dot"></span>
            </span>
            <span style="margin-left:10px;">Loading ARIA…</span>
          </div>
        `;
      },

      onClose(win) {
        if (win._ariaApp) {
          try { win._ariaApp.destroy(); } catch (_) {}
        }
      },
    });

    console.log(
      "%c[WebOS]%c ARIA registered",
      "color:#7c3aed;font-weight:bold", "color:inherit"
    );
  }

  /* ==========================================================================
   * Win+A global shortcut
   * ========================================================================*/

  function wireGlobalShortcut() {
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.getModifierState && e.getModifierState("Meta")) &&
          (e.key === "a" || e.key === "A")) {
        // Only if no text input has focus
        const tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        if (window.WindowManager && window.WindowManager.openApp) {
          window.WindowManager.openApp(APP_ID);
        }
      }
    }, true);
  }

  /* ==========================================================================
   * Public API
   * ========================================================================*/

  window.ARIA = {
    open(opts) {
      if (window.WindowManager && window.WindowManager.openApp) {
        return window.WindowManager.openApp(APP_ID, opts || {});
      }
      return null;
    },
    hasApiKey() { return !!loadApiKey(); },
    setApiKey(k) { saveApiKey(k); },
    clearApiKey, saveApiKey, loadApiKey,
    listConversations, loadConversation,
    deleteConversation, saveConversation,
    searchConversations, renameConversation, duplicateConversation,
    filterByDateRange, filterByModel, filterByLength, sortConversationsBy,
    exportAllConversations, importConversations,
    conversationStats, allConversationStats,
    regenerateLast, editUserMessage,
    estimateTokens, estimateConversationTokens,
    pruneEmptyConversations, pruneOlderThan, totalStorageSize,
    getPromptPresets, getShortcuts, prettyLang,
    applyEmojiAliases, enhanceMarkdownHtml,
    exportConversationAsHtml, mergeConversations, shortSummary,
    saveDraft, loadDraft, clearAllDrafts,
    stripCodeBlocks, extractCodeBlocks, countCodeBlocks,
    getTags, setTags, addTag, removeTag, getAllTags, filterByTag,
    countMessagesByRole, lastMessage, firstUserMessage,
    newStreamState, markStreamChunk, markStreamEnd,
    streamDurationMs, streamTokensPerSecond,
    loadSettings, saveSettings,
    renderMarkdown, highlight,
    debugExport, resetAll,
    DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT,
  };

  /* ==========================================================================
   * Boot
   * ========================================================================*/

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  wireGlobalShortcut();
})();
