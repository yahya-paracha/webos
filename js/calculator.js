/* ============================================================================
 * CalcPro — WebOS Calculator (calculator.js)
 * ============================================================================
 * Modes:
 *   - Standard    : basic arithmetic (+, -, *, /, %, ±), memory
 *   - Scientific  : trig, log, exp, pow, factorial, constants, parentheses
 *   - Programmer  : HEX / DEC / OCT / BIN simultaneous display, bitwise ops,
 *                   word-size toggle (8/16/32/64), shifts
 *   - Unit        : length, weight, temperature, area, volume, speed, time,
 *                   data storage
 *   - Currency    : 20 hardcoded currencies with static rates
 *
 * Expression parser: implements proper operator precedence via shunting-yard
 * and RPN evaluation; supports unary functions, parentheses, constants.
 *
 * Keyboard: digits, operators, Enter (=), Escape (clear), Backspace (delete),
 * Ctrl+C / Ctrl+V copy-paste display.
 *
 * Registers as app id "calculator" via WindowManager. Replaces the stub
 * calculator registration included in windowManager.js.
 * ========================================================================= */
(function () {
  "use strict";

  /* -------------------------------------------------------------------------
   * CONSTANTS
   * ---------------------------------------------------------------------- */
  const APP_ID       = "calculator";
  const APP_TITLE    = "CalcPro";
  const APP_ICON     = "🧮";
  const APP_CATEGORY = "Productivity";

  const HISTORY_LIMIT = 50;
  const STORAGE_KEY_HISTORY  = "webos.calcpro.history";
  const STORAGE_KEY_MEMORY   = "webos.calcpro.memory";
  const STORAGE_KEY_SETTINGS = "webos.calcpro.settings";

  /* -------------------------------------------------------------------------
   * UNIT CONVERSION TABLES
   * ---------------------------------------------------------------------- */
  // Linear units: map unit -> factor to base. Base differs per category.
  const UNITS = {
    length: {
      base: "m",
      items: {
        mm:  { name: "Millimeter",   factor: 0.001 },
        cm:  { name: "Centimeter",   factor: 0.01 },
        m:   { name: "Meter",        factor: 1 },
        km:  { name: "Kilometer",    factor: 1000 },
        in:  { name: "Inch",         factor: 0.0254 },
        ft:  { name: "Foot",         factor: 0.3048 },
        yd:  { name: "Yard",         factor: 0.9144 },
        mi:  { name: "Mile",         factor: 1609.344 },
        nmi: { name: "Nautical Mile",factor: 1852 },
      }
    },
    weight: {
      base: "kg",
      items: {
        mg:  { name: "Milligram",    factor: 0.000001 },
        g:   { name: "Gram",         factor: 0.001 },
        kg:  { name: "Kilogram",     factor: 1 },
        t:   { name: "Metric Ton",   factor: 1000 },
        oz:  { name: "Ounce",        factor: 0.028349523125 },
        lb:  { name: "Pound",        factor: 0.45359237 },
        st:  { name: "Stone",        factor: 6.35029318 },
      }
    },
    temperature: {
      base: "C",
      items: {
        C: { name: "Celsius" },
        F: { name: "Fahrenheit" },
        K: { name: "Kelvin" },
      }
    },
    area: {
      base: "m2",
      items: {
        mm2: { name: "Square Millimeter", factor: 0.000001 },
        cm2: { name: "Square Centimeter", factor: 0.0001 },
        m2:  { name: "Square Meter",      factor: 1 },
        km2: { name: "Square Kilometer",  factor: 1000000 },
        ha:  { name: "Hectare",           factor: 10000 },
        ac:  { name: "Acre",              factor: 4046.8564224 },
        ft2: { name: "Square Foot",       factor: 0.09290304 },
        in2: { name: "Square Inch",       factor: 0.00064516 },
      }
    },
    volume: {
      base: "L",
      items: {
        ml:   { name: "Milliliter",   factor: 0.001 },
        L:    { name: "Liter",        factor: 1 },
        m3:   { name: "Cubic Meter",  factor: 1000 },
        cm3:  { name: "Cubic Cm",     factor: 0.001 },
        in3:  { name: "Cubic Inch",   factor: 0.016387064 },
        ft3:  { name: "Cubic Foot",   factor: 28.316846592 },
        gal_us: { name: "US Gallon",  factor: 3.785411784 },
        gal_uk: { name: "UK Gallon",  factor: 4.54609 },
        floz_us:{ name: "US Fl Ounce",factor: 0.0295735295625 },
        floz_uk:{ name: "UK Fl Ounce",factor: 0.0284130625 },
      }
    },
    speed: {
      base: "mps",
      items: {
        mps:  { name: "Meter/Second",       factor: 1 },
        kmh:  { name: "Kilometer/Hour",     factor: 1/3.6 },
        mph:  { name: "Mile/Hour",          factor: 0.44704 },
        fps:  { name: "Foot/Second",        factor: 0.3048 },
        kn:   { name: "Knot",               factor: 0.514444 },
        mach: { name: "Mach",               factor: 340.29 },
      }
    },
    time: {
      base: "s",
      items: {
        ns:  { name: "Nanosecond",  factor: 1e-9 },
        us:  { name: "Microsecond", factor: 1e-6 },
        ms:  { name: "Millisecond", factor: 0.001 },
        s:   { name: "Second",      factor: 1 },
        min: { name: "Minute",      factor: 60 },
        h:   { name: "Hour",        factor: 3600 },
        day: { name: "Day",         factor: 86400 },
        wk:  { name: "Week",        factor: 604800 },
        mo:  { name: "Month",       factor: 2629800 },
        yr:  { name: "Year",        factor: 31557600 },
      }
    },
    data: {
      base: "B",
      items: {
        b:   { name: "Bit",       factor: 0.125 },
        B:   { name: "Byte",      factor: 1 },
        KB:  { name: "Kilobyte",  factor: 1024 },
        MB:  { name: "Megabyte",  factor: 1048576 },
        GB:  { name: "Gigabyte",  factor: 1073741824 },
        TB:  { name: "Terabyte",  factor: 1099511627776 },
        PB:  { name: "Petabyte",  factor: 1125899906842624 },
      }
    }
  };

  /* -------------------------------------------------------------------------
   * CURRENCY RATES (static, offline — denominated in USD)
   * ---------------------------------------------------------------------- */
  const CURRENCY_UPDATED = "2026-01-15";
  const CURRENCIES = {
    USD: { name: "US Dollar",              symbol: "$",     rate: 1.0000 },
    EUR: { name: "Euro",                   symbol: "€",     rate: 0.9250 },
    GBP: { name: "British Pound",          symbol: "£",     rate: 0.7850 },
    JPY: { name: "Japanese Yen",           symbol: "¥",     rate: 149.35 },
    CNY: { name: "Chinese Yuan",           symbol: "¥",     rate: 7.1800 },
    CAD: { name: "Canadian Dollar",        symbol: "C$",    rate: 1.3500 },
    AUD: { name: "Australian Dollar",      symbol: "A$",    rate: 1.5200 },
    CHF: { name: "Swiss Franc",            symbol: "CHF",   rate: 0.8850 },
    HKD: { name: "Hong Kong Dollar",       symbol: "HK$",   rate: 7.8100 },
    SGD: { name: "Singapore Dollar",       symbol: "S$",    rate: 1.3400 },
    KRW: { name: "South Korean Won",       symbol: "₩",     rate: 1345.5 },
    INR: { name: "Indian Rupee",           symbol: "₹",     rate: 83.20 },
    MXN: { name: "Mexican Peso",           symbol: "MX$",   rate: 17.35 },
    BRL: { name: "Brazilian Real",         symbol: "R$",    rate: 5.18 },
    RUB: { name: "Russian Ruble",          symbol: "₽",     rate: 92.10 },
    ZAR: { name: "South African Rand",     symbol: "R",     rate: 18.65 },
    SEK: { name: "Swedish Krona",          symbol: "kr",    rate: 10.45 },
    NOK: { name: "Norwegian Krone",        symbol: "kr",    rate: 10.80 },
    NZD: { name: "New Zealand Dollar",     symbol: "NZ$",   rate: 1.6450 },
    TRY: { name: "Turkish Lira",           symbol: "₺",     rate: 32.40 },
  };

  /* -------------------------------------------------------------------------
   * UTILS
   * ---------------------------------------------------------------------- */
  function $(root, s)  { return root.querySelector(s); }
  function $$(root, s) { return Array.from(root.querySelectorAll(s)); }
  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function formatNumber(n, maxFrac) {
    if (n === null || n === undefined || n !== n) return "NaN";
    if (!isFinite(n)) return n > 0 ? "∞" : "-∞";
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toString();
    const digits = maxFrac === undefined ? 12 : maxFrac;
    let s = n.toPrecision(digits);
    // Strip trailing zeros after decimal
    if (s.indexOf(".") !== -1 && s.indexOf("e") === -1) {
      s = s.replace(/\.?0+$/, "");
    }
    return s;
  }
  function safeJSONParse(s, fallback) {
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }

  /* -------------------------------------------------------------------------
   * EXPRESSION PARSER (shunting-yard + RPN eval)
   *   Handles: + - * / % ^ parens, unary minus/plus, functions (sin, cos, …),
   *   constants (pi, e).
   * ---------------------------------------------------------------------- */
  const OPS = {
    "+": { prec: 1, assoc: "L", arity: 2, fn: (a, b) => a + b },
    "-": { prec: 1, assoc: "L", arity: 2, fn: (a, b) => a - b },
    "*": { prec: 2, assoc: "L", arity: 2, fn: (a, b) => a * b },
    "/": { prec: 2, assoc: "L", arity: 2, fn: (a, b) => a / b },
    "%": { prec: 2, assoc: "L", arity: 2, fn: (a, b) => a % b },
    "^": { prec: 4, assoc: "R", arity: 2, fn: (a, b) => Math.pow(a, b) },
    "u-":{ prec: 3, assoc: "R", arity: 1, fn: (a)    => -a },
    "u+":{ prec: 3, assoc: "R", arity: 1, fn: (a)    =>  a },
  };

  const FUNCS_RAD = {
    sin:  Math.sin,  cos:  Math.cos,  tan:  Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    asinh:Math.asinh, acosh:Math.acosh, atanh:Math.atanh,
    log:  Math.log10 || ((x) => Math.log(x) / Math.LN10),
    ln:   Math.log,
    log2: Math.log2  || ((x) => Math.log(x) / Math.LN2),
    sqrt: Math.sqrt,
    cbrt: Math.cbrt || ((x) => Math.sign(x) * Math.pow(Math.abs(x), 1/3)),
    abs:  Math.abs,
    exp:  Math.exp,
    sign: Math.sign,
    floor:Math.floor, ceil: Math.ceil, round: Math.round,
    fact: (n) => {
      if (n < 0 || n !== Math.floor(n)) return NaN;
      if (n > 170) return Infinity;
      let r = 1;
      for (let i = 2; i <= n; i++) r *= i;
      return r;
    },
  };
  const FUNCS_DEG = {
    sin:  (x) => Math.sin(x * Math.PI / 180),
    cos:  (x) => Math.cos(x * Math.PI / 180),
    tan:  (x) => Math.tan(x * Math.PI / 180),
    asin: (x) => Math.asin(x) * 180 / Math.PI,
    acos: (x) => Math.acos(x) * 180 / Math.PI,
    atan: (x) => Math.atan(x) * 180 / Math.PI,
  };
  const CONSTS = {
    pi: Math.PI,
    e:  Math.E,
    phi:(1 + Math.sqrt(5)) / 2,
  };

  function tokenizeExpr(s) {
    const tokens = [];
    const len = s.length;
    let i = 0;
    while (i < len) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i;
        let hasDot = false;
        while (j < len && /[0-9.]/.test(s[j])) {
          if (s[j] === ".") {
            if (hasDot) break;
            hasDot = true;
          }
          j++;
        }
        // scientific notation
        if (j < len && (s[j] === "e" || s[j] === "E")) {
          j++;
          if (s[j] === "+" || s[j] === "-") j++;
          while (j < len && /[0-9]/.test(s[j])) j++;
        }
        tokens.push({ type: "num", value: parseFloat(s.slice(i, j)) });
        i = j;
        continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i;
        while (j < len && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const word = s.slice(i, j);
        tokens.push({ type: "ident", value: word });
        i = j;
        continue;
      }
      if ("+-*/%^()".indexOf(c) !== -1) {
        tokens.push({ type: "op", value: c });
        i++;
        continue;
      }
      if (c === ",") {
        tokens.push({ type: "comma" });
        i++;
        continue;
      }
      // unknown char, skip to avoid infinite loop
      i++;
    }
    return tokens;
  }

  function toRPN(tokens) {
    const out = [];
    const ops = [];
    let prev = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "num") {
        out.push(t);
      } else if (t.type === "ident") {
        // determine function vs constant
        const next = tokens[i + 1];
        if (next && next.type === "op" && next.value === "(") {
          ops.push({ type: "func", value: t.value });
        } else {
          // treat as constant
          out.push({ type: "const", value: t.value });
        }
      } else if (t.type === "op") {
        if (t.value === "(") ops.push(t);
        else if (t.value === ")") {
          while (ops.length && !(ops[ops.length-1].type === "op" && ops[ops.length-1].value === "(")) {
            out.push(ops.pop());
          }
          ops.pop(); // remove '('
          if (ops.length && ops[ops.length-1].type === "func") {
            out.push(ops.pop());
          }
        } else {
          let op = t.value;
          // detect unary
          if (op === "-" || op === "+") {
            if (!prev ||
                (prev.type === "op" && prev.value !== ")") ||
                prev.type === "comma") {
              op = "u" + op;
            }
          }
          const info = OPS[op];
          if (!info) { prev = t; continue; }
          while (ops.length) {
            const top = ops[ops.length-1];
            if (top.type === "func") { out.push(ops.pop()); continue; }
            if (top.type === "op" && top.value !== "(") {
              const topInfo = OPS[top.value];
              if (!topInfo) break;
              if ((info.assoc === "L" && info.prec <= topInfo.prec) ||
                  (info.assoc === "R" && info.prec <  topInfo.prec)) {
                out.push(ops.pop()); continue;
              }
            }
            break;
          }
          ops.push({ type: "op", value: op });
        }
      } else if (t.type === "comma") {
        while (ops.length && !(ops[ops.length-1].type === "op" && ops[ops.length-1].value === "(")) {
          out.push(ops.pop());
        }
      }
      prev = t;
    }
    while (ops.length) {
      const top = ops.pop();
      if (top.type === "op" && (top.value === "(" || top.value === ")")) continue;
      out.push(top);
    }
    return out;
  }

  function evalRPN(rpn, angleMode) {
    const stack = [];
    const funcs = angleMode === "deg" ? Object.assign({}, FUNCS_RAD, FUNCS_DEG) : FUNCS_RAD;
    for (const t of rpn) {
      if (t.type === "num") stack.push(t.value);
      else if (t.type === "const") {
        const name = String(t.value).toLowerCase();
        if (name in CONSTS) stack.push(CONSTS[name]);
        else throw new Error("Unknown constant: " + t.value);
      } else if (t.type === "func") {
        const a = stack.pop();
        const name = String(t.value).toLowerCase();
        if (!(name in funcs)) throw new Error("Unknown function: " + t.value);
        stack.push(funcs[name](a));
      } else if (t.type === "op") {
        const info = OPS[t.value];
        if (!info) throw new Error("Unknown op: " + t.value);
        if (info.arity === 1) {
          const a = stack.pop();
          stack.push(info.fn(a));
        } else {
          const b = stack.pop();
          const a = stack.pop();
          stack.push(info.fn(a, b));
        }
      }
    }
    if (stack.length !== 1) throw new Error("Expression error");
    return stack[0];
  }

  function evaluateExpression(expr, angleMode) {
    const toks = tokenizeExpr(expr);
    if (!toks.length) return 0;
    const rpn = toRPN(toks);
    return evalRPN(rpn, angleMode || "rad");
  }

  /* -------------------------------------------------------------------------
   * PROGRAMMER MODE helpers
   * ---------------------------------------------------------------------- */
  function toBigInt(v) {
    try {
      if (typeof v === "bigint") return v;
      return BigInt(Math.trunc(Number(v)));
    } catch (_) { return 0n; }
  }

  function maskToWord(b, wordSize) {
    // interpret `b` as unsigned in `wordSize` bits; return unsigned BigInt
    const mask = (1n << BigInt(wordSize)) - 1n;
    if (b < 0n) {
      // two's complement
      return (b & mask);
    }
    return b & mask;
  }

  function signedView(uBig, wordSize) {
    const m = (1n << BigInt(wordSize)) - 1n;
    const sign = 1n << BigInt(wordSize - 1);
    if (uBig & sign) return uBig - (m + 1n);
    return uBig;
  }

  function formatBase(uBig, base, wordSize) {
    const masked = maskToWord(uBig, wordSize);
    switch (base) {
      case "HEX": {
        let s = masked.toString(16).toUpperCase();
        // group every 4
        s = s.replace(/(.)(?=(.{4})+$)/g, "$1 ");
        return s;
      }
      case "DEC": return signedView(masked, wordSize).toString();
      case "OCT": return masked.toString(8);
      case "BIN": {
        let s = masked.toString(2).padStart(wordSize, "0");
        s = s.replace(/(.)(?=(.{4})+$)/g, "$1 ");
        return s;
      }
      default: return masked.toString();
    }
  }

  function parseBase(s, base) {
    if (!s) return 0n;
    s = String(s).replace(/\s+/g, "");
    try {
      if (base === "HEX") return BigInt("0x" + s);
      if (base === "OCT") return BigInt("0o" + s);
      if (base === "BIN") return BigInt("0b" + s);
      if (s === "-" || s === "+") return 0n;
      // DEC can be negative
      return BigInt(s);
    } catch (_) { return 0n; }
  }

  function validDigitForBase(d, base) {
    if (base === "HEX") return /[0-9A-F]/i.test(d);
    if (base === "DEC") return /[0-9]/.test(d);
    if (base === "OCT") return /[0-7]/.test(d);
    if (base === "BIN") return /[01]/.test(d);
    return false;
  }

  /* -------------------------------------------------------------------------
   * UNIT CONVERSION
   * ---------------------------------------------------------------------- */
  function convertUnit(category, fromUnit, toUnit, value) {
    const v = Number(value);
    if (!isFinite(v)) return NaN;
    if (category === "temperature") {
      let k;
      if      (fromUnit === "C") k = v + 273.15;
      else if (fromUnit === "F") k = (v - 32) * 5/9 + 273.15;
      else                       k = v;
      if      (toUnit === "C") return k - 273.15;
      else if (toUnit === "F") return (k - 273.15) * 9/5 + 32;
      return k;
    }
    const cat = UNITS[category];
    if (!cat) return NaN;
    const f = cat.items[fromUnit];
    const t = cat.items[toUnit];
    if (!f || !t) return NaN;
    const baseVal = v * f.factor;
    return baseVal / t.factor;
  }

  function convertCurrency(fromCode, toCode, value) {
    const v = Number(value);
    if (!isFinite(v)) return NaN;
    const f = CURRENCIES[fromCode];
    const t = CURRENCIES[toCode];
    if (!f || !t) return NaN;
    const usd = v / f.rate;
    return usd * t.rate;
  }

  /* -------------------------------------------------------------------------
   * HTML TEMPLATE (inlined to avoid fetch)
   * ---------------------------------------------------------------------- */
  const HTML_TEMPLATE = `
<div class="cp-root" data-cp-root>
  <div class="cp-tabs" role="tablist">
    <button class="cp-tab is-active" data-mode="standard"   role="tab">Standard</button>
    <button class="cp-tab"            data-mode="scientific" role="tab">Scientific</button>
    <button class="cp-tab"            data-mode="programmer" role="tab">Programmer</button>
    <button class="cp-tab"            data-mode="unit"       role="tab">Unit Converter</button>
    <button class="cp-tab"            data-mode="currency"   role="tab">Currency</button>
    <span class="cp-tab-spacer"></span>
    <button class="cp-icon-btn" data-cp-history-toggle title="History">🕓</button>
  </div>
  <div class="cp-main">
    <div class="cp-display-area">
      <div class="cp-display-expr" data-cp-expr>&nbsp;</div>
      <div class="cp-display-main" data-cp-display>0</div>
      <div class="cp-display-meta">
        <span class="cp-mem-indicator" data-cp-mem-indicator hidden>M</span>
        <span class="cp-mode-label" data-cp-mode-label>Standard</span>
      </div>
    </div>
    <div class="cp-panels" data-cp-panels>
      ${buildStandardPanelHTML()}
      ${buildScientificPanelHTML()}
      ${buildProgrammerPanelHTML()}
      ${buildUnitPanelHTML()}
      ${buildCurrencyPanelHTML()}
    </div>
  </div>
  <aside class="cp-history" data-cp-history hidden>
    <div class="cp-history-head">
      <span>History</span>
      <button class="cp-icon-btn" data-cp-history-clear title="Clear all">🗑</button>
      <button class="cp-icon-btn" data-cp-history-close title="Close">✕</button>
    </div>
    <div class="cp-history-list" data-cp-history-list>
      <div class="cp-history-empty">No calculations yet.</div>
    </div>
  </aside>
</div>
`;

  function buildStandardPanelHTML() {
    const memBtns = `
      <div class="cp-mem-row">
        <button class="cp-btn cp-btn-mem" data-cp-mem="MC">MC</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="MR">MR</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="M+">M+</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="M-">M−</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="MS">MS</button>
      </div>`;
    const layout = [
      ["fn","%","%"], ["fn","CE","CE"], ["fn","C","C"], ["fn","BACK","⌫"],
      ["fn","1/x","1/x"], ["fn","x^2","x²"], ["fn","sqrt","√x"], ["op","/","÷"],
      ["num","7","7"], ["num","8","8"], ["num","9","9"], ["op","*","×"],
      ["num","4","4"], ["num","5","5"], ["num","6","6"], ["op","-","−"],
      ["num","1","1"], ["num","2","2"], ["num","3","3"], ["op","+","+"],
      ["fn","neg","±"], ["num","0","0"], ["num",".","."], ["eq","=","="],
    ];
    const cells = layout.map((r) =>
      `<button class="cp-btn cp-btn-${r[0]}" data-cp-key="${escapeHtml(r[1])}">${escapeHtml(r[2])}</button>`
    ).join("");
    return `
      <div class="cp-panel cp-panel-standard is-active" data-panel="standard">
        ${memBtns}
        <div class="cp-grid cp-grid-std">${cells}</div>
      </div>`;
  }

  function buildScientificPanelHTML() {
    const memBtns = `
      <div class="cp-mem-row">
        <button class="cp-btn cp-btn-mem" data-cp-mem="MC">MC</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="MR">MR</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="M+">M+</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="M-">M−</button>
        <button class="cp-btn cp-btn-mem" data-cp-mem="MS">MS</button>
      </div>`;
    const layout = [
      ["fn","2nd","2nd"], ["fn","pi","π"],   ["fn","e","e"],    ["fn","C","C"],   ["fn","BACK","⌫"],
      ["fn","x^2","x²"],  ["fn","x^3","x³"], ["fn","x^y","xʸ"], ["fn","exp","exp"],["fn","abs","|x|"],
      ["fn","sqrt","√x"], ["fn","cbrt","∛x"],["fn","yroot","ʸ√x"],["fn","ln","ln"],["fn","log","log"],
      ["fn","sin","sin"], ["fn","cos","cos"],["fn","tan","tan"],["fn","log2","log₂"],["fn","fact","n!"],
      ["fn","asin","sin⁻¹"],["fn","acos","cos⁻¹"],["fn","atan","tan⁻¹"],["fn","1/x","1/x"],["fn","%","%"],
      ["fn","(","("],["fn",")",")"], ["num","7","7"],["num","8","8"],["num","9","9"],
      ["op","/","÷"],["op","*","×"], ["num","4","4"],["num","5","5"],["num","6","6"],
      ["op","+","+"],["op","-","−"], ["num","1","1"],["num","2","2"],["num","3","3"],
      ["fn","neg","±"],["num","0","0"],["num",".","."],
    ];
    const cells = layout.map((r) =>
      `<button class="cp-btn cp-btn-${r[0]}" data-cp-key="${escapeHtml(r[1])}">${escapeHtml(r[2])}</button>`
    ).join("");
    const equals = `<button class="cp-btn cp-btn-eq" data-cp-key="=" style="grid-column:span 2;">=</button>`;
    return `
      <div class="cp-panel cp-panel-sci" data-panel="scientific">
        <div class="cp-sci-header">
          <button class="cp-chip" data-cp-angle="deg">DEG</button>
          <button class="cp-chip is-active" data-cp-angle="rad">RAD</button>
          <button class="cp-chip" data-cp-hyp>HYP</button>
          <button class="cp-chip" data-cp-inv>INV</button>
        </div>
        ${memBtns}
        <div class="cp-grid cp-grid-sci">${cells}${equals}</div>
      </div>`;
  }

  function buildProgrammerPanelHTML() {
    const layout = [
      ["fn","A","A"],["fn","B","B"],["fn","C_HEX","C"],["fn","D","D"],["fn","E","E"],["fn","F","F"],
      ["fn","AND","AND"],["fn","OR","OR"],["fn","XOR","XOR"],["fn","NOT","NOT"],["fn","LSH","≪"],["fn","RSH","≫"],
      ["fn","C","C"],["fn","BACK","⌫"],["num","7","7"],["num","8","8"],["num","9","9"],["op","/","÷"],
      ["op","*","×"],["op","%","%"],["num","4","4"],["num","5","5"],["num","6","6"],["op","-","−"],
      ["op","+","+"],["fn","neg","±"],["num","1","1"],["num","2","2"],["num","3","3"],
    ];
    const cells = layout.map((r) =>
      `<button class="cp-btn cp-btn-${r[0]}" data-cp-key="${escapeHtml(r[1])}">${escapeHtml(r[2])}</button>`
    ).join("");
    return `
      <div class="cp-panel cp-panel-prog" data-panel="programmer">
        <div class="cp-prog-views">
          <div class="cp-prog-row" data-cp-prog-row="HEX"><span class="cp-prog-label">HEX</span><span class="cp-prog-value" data-cp-prog-value="HEX">0</span></div>
          <div class="cp-prog-row is-active" data-cp-prog-row="DEC"><span class="cp-prog-label">DEC</span><span class="cp-prog-value" data-cp-prog-value="DEC">0</span></div>
          <div class="cp-prog-row" data-cp-prog-row="OCT"><span class="cp-prog-label">OCT</span><span class="cp-prog-value" data-cp-prog-value="OCT">0</span></div>
          <div class="cp-prog-row" data-cp-prog-row="BIN"><span class="cp-prog-label">BIN</span><span class="cp-prog-value" data-cp-prog-value="BIN">0</span></div>
        </div>
        <div class="cp-sci-header">
          <button class="cp-chip" data-cp-base="HEX">HEX</button>
          <button class="cp-chip is-active" data-cp-base="DEC">DEC</button>
          <button class="cp-chip" data-cp-base="OCT">OCT</button>
          <button class="cp-chip" data-cp-base="BIN">BIN</button>
          <span class="cp-spacer"></span>
          <button class="cp-chip" data-cp-word="8">8</button>
          <button class="cp-chip" data-cp-word="16">16</button>
          <button class="cp-chip" data-cp-word="32">32</button>
          <button class="cp-chip is-active" data-cp-word="64">64</button>
        </div>
        <div class="cp-grid cp-grid-prog">
          ${cells}
          <button class="cp-btn cp-btn-eq" data-cp-key="=" style="grid-row:span 2;">=</button>
          <button class="cp-btn cp-btn-num" data-cp-key="0" style="grid-column:span 5;">0</button>
        </div>
      </div>`;
  }

  function buildUnitPanelHTML() {
    return `
      <div class="cp-panel cp-panel-unit" data-panel="unit">
        <div class="cp-unit-cat-row">
          <label class="cp-field-label">Category</label>
          <select class="cp-select" data-cp-unit-cat>
            <option value="length">Length</option>
            <option value="weight">Weight</option>
            <option value="temperature">Temperature</option>
            <option value="area">Area</option>
            <option value="volume">Volume</option>
            <option value="speed">Speed</option>
            <option value="time">Time</option>
            <option value="data">Data Storage</option>
          </select>
        </div>
        <div class="cp-unit-row">
          <div class="cp-unit-col">
            <select class="cp-select" data-cp-unit-from></select>
            <input type="text" class="cp-input cp-unit-input" data-cp-unit-from-val value="1" />
          </div>
          <div class="cp-unit-arrow" data-cp-unit-swap title="Swap">⇌</div>
          <div class="cp-unit-col">
            <select class="cp-select" data-cp-unit-to></select>
            <input type="text" class="cp-input cp-unit-input" data-cp-unit-to-val value="0" readonly />
          </div>
        </div>
        <div class="cp-unit-info" data-cp-unit-info></div>
        <div class="cp-grid cp-grid-unit">
          <button class="cp-btn cp-btn-num" data-cp-unit-key="7">7</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="8">8</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="9">9</button>
          <button class="cp-btn cp-btn-fn"  data-cp-unit-key="C">C</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="4">4</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="5">5</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="6">6</button>
          <button class="cp-btn cp-btn-fn"  data-cp-unit-key="BACK">⌫</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="1">1</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="2">2</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="3">3</button>
          <button class="cp-btn cp-btn-fn"  data-cp-unit-key="neg">±</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key="0" style="grid-column:span 2;">0</button>
          <button class="cp-btn cp-btn-num" data-cp-unit-key=".">.</button>
          <button class="cp-btn cp-btn-eq"  data-cp-unit-key="COPY">Copy</button>
        </div>
      </div>`;
  }

  function buildCurrencyPanelHTML() {
    return `
      <div class="cp-panel cp-panel-curr" data-panel="currency">
        <div class="cp-unit-row">
          <div class="cp-unit-col">
            <select class="cp-select" data-cp-curr-from></select>
            <input type="text" class="cp-input cp-unit-input" data-cp-curr-from-val value="1" />
          </div>
          <div class="cp-unit-arrow" data-cp-curr-swap title="Swap">⇌</div>
          <div class="cp-unit-col">
            <select class="cp-select" data-cp-curr-to></select>
            <input type="text" class="cp-input cp-unit-input" data-cp-curr-to-val value="0" readonly />
          </div>
        </div>
        <div class="cp-unit-info">
          Rates last updated: <span data-cp-curr-date></span> (static offline table)
        </div>
        <div class="cp-curr-table" data-cp-curr-table></div>
      </div>`;
  }

  /* -------------------------------------------------------------------------
   * CALCULATOR INSTANCE CLASS
   * ---------------------------------------------------------------------- */
  class CalcPro {
    constructor(body, winOpts) {
      this.body = body;
      this.winOpts = winOpts || {};
      this.root = null;

      // shared state
      this.mode = "standard";           // standard | scientific | programmer | unit | currency
      this.display = "0";               // main display as string
      this.expression = "";             // expression preview
      this.lastAnswer = 0;              // 'ans'
      this.justEvaluated = false;       // if true, next digit resets display

      // scientific extras
      this.angleMode = "rad";           // rad | deg
      this.hypOn = false;
      this.invOn = false;

      // programmer
      this.progValue = 0n;              // unsigned BigInt within wordSize
      this.progBase  = "DEC";           // HEX/DEC/OCT/BIN
      this.progWord  = 64;              // 8 / 16 / 32 / 64
      this.progPending = null;          // { op, a }
      this.progPendingExpr = "";

      // memory
      this.memory = 0;
      this.hasMemory = false;

      // history
      this.history = [];

      // keyboard handler registered once
      this.keyHandler = null;
      this.destroyed = false;

      this._loadPersisted();
    }

    /* ------------------------------------------------------------
     * MOUNT / UNMOUNT
     * --------------------------------------------------------- */
    mount() {
      this.body.innerHTML = HTML_TEMPLATE;
      this.root = $(this.body, "[data-cp-root]");
      this._bindTabs();
      this._bindStandard();
      this._bindScientific();
      this._bindProgrammer();
      this._bindUnit();
      this._bindCurrency();
      this._bindHistory();
      this._bindKeyboard();
      this._renderDisplay();
      this._renderMemory();
      this._renderHistory();
      this._renderProgAll();
      this._populateUnitSelects();
      this._populateCurrencySelects();
      this._renderCurrencyTable();
      this._updateUnitResult();
      this._updateCurrencyResult();
    }

    destroy() {
      this.destroyed = true;
      if (this.keyHandler) {
        document.removeEventListener("keydown", this.keyHandler, true);
        this.keyHandler = null;
      }
    }

    /* ------------------------------------------------------------
     * PERSISTENCE
     * --------------------------------------------------------- */
    _loadPersisted() {
      try {
        const h = localStorage.getItem(STORAGE_KEY_HISTORY);
        if (h) this.history = safeJSONParse(h, []).slice(0, HISTORY_LIMIT);
        const m = localStorage.getItem(STORAGE_KEY_MEMORY);
        if (m) {
          const mv = safeJSONParse(m, null);
          if (mv && typeof mv.v === "number") {
            this.memory = mv.v;
            this.hasMemory = !!mv.h;
          }
        }
      } catch (_) {}
    }

    _savePersisted() {
      try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(this.history));
        localStorage.setItem(STORAGE_KEY_MEMORY,  JSON.stringify({ v: this.memory, h: this.hasMemory }));
      } catch (_) {}
    }

    /* ------------------------------------------------------------
     * TABS (mode switching)
     * --------------------------------------------------------- */
    _bindTabs() {
      $$(this.root, ".cp-tab").forEach((b) => {
        b.addEventListener("click", () => this.switchMode(b.dataset.mode));
      });
    }

    switchMode(mode) {
      if (this.mode === mode) return;
      this.mode = mode;
      $$(this.root, ".cp-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.mode === mode));
      $$(this.root, ".cp-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === mode));
      const label = { standard: "Standard", scientific: "Scientific", programmer: "Programmer",
        unit: "Unit Converter", currency: "Currency" }[mode] || mode;
      const lab = $(this.root, "[data-cp-mode-label]");
      if (lab) lab.textContent = label;
      this._renderDisplay();
      if (mode === "programmer") this._renderProgAll();
    }

    /* ------------------------------------------------------------
     * STANDARD / SCIENTIFIC keypad
     * --------------------------------------------------------- */
    _bindStandard() {
      this._bindCommonKeys("[data-panel='standard']");
      $$(this.root, "[data-panel='standard'] [data-cp-mem]").forEach((b) => {
        b.addEventListener("click", () => this._handleMem(b.dataset.cpMem));
      });
    }

    _bindScientific() {
      this._bindCommonKeys("[data-panel='scientific']");
      $$(this.root, "[data-panel='scientific'] [data-cp-mem]").forEach((b) => {
        b.addEventListener("click", () => this._handleMem(b.dataset.cpMem));
      });
      $$(this.root, "[data-cp-angle]").forEach((b) => {
        b.addEventListener("click", () => {
          this.angleMode = b.dataset.cpAngle;
          $$(this.root, "[data-cp-angle]").forEach((x) =>
            x.classList.toggle("is-active", x.dataset.cpAngle === this.angleMode));
        });
      });
      const hyp = $(this.root, "[data-cp-hyp]");
      if (hyp) hyp.addEventListener("click", () => {
        this.hypOn = !this.hypOn;
        hyp.classList.toggle("is-active", this.hypOn);
      });
      const inv = $(this.root, "[data-cp-inv]");
      if (inv) inv.addEventListener("click", () => {
        this.invOn = !this.invOn;
        inv.classList.toggle("is-active", this.invOn);
      });
    }

    _bindCommonKeys(sel) {
      $$(this.root, sel + " [data-cp-key]").forEach((b) => {
        b.addEventListener("click", (ev) => {
          const r = b.getBoundingClientRect();
          b.style.setProperty("--x", ((ev.clientX - r.left) / r.width * 100) + "%");
          b.style.setProperty("--y", ((ev.clientY - r.top) / r.height * 100) + "%");
          b.classList.remove("is-press"); void b.offsetWidth; b.classList.add("is-press");
          this._handleKey(b.dataset.cpKey);
        });
      });
    }

    _handleKey(key) {
      // digits / dot
      if (/^[0-9]$/.test(key) || key === ".") {
        this._inputDigit(key);
        return;
      }
      // sign
      if (key === "neg") { this._toggleSign(); return; }
      // operators
      if (["+","-","*","/","^","%"].indexOf(key) !== -1) {
        this._inputOperator(key);
        return;
      }
      if (key === "(") { this._appendExpr("("); return; }
      if (key === ")") { this._appendExpr(")"); return; }
      if (key === "=") { this._equals(); return; }
      if (key === "C") { this._clearAll(); return; }
      if (key === "CE") { this._clearEntry(); return; }
      if (key === "BACK") { this._backspace(); return; }
      // functions
      if (key === "pi") { this._setDisplay(formatNumber(Math.PI)); this.justEvaluated = true; return; }
      if (key === "e")  { this._setDisplay(formatNumber(Math.E));  this.justEvaluated = true; return; }
      if (key === "1/x")  { this._applyFn((v) => 1 / v, "1/"); return; }
      if (key === "x^2")  { this._applyFn((v) => v * v, "sqr(", ")"); return; }
      if (key === "x^3")  { this._applyFn((v) => v * v * v, "cube(", ")"); return; }
      if (key === "sqrt") { this._applyFn(Math.sqrt, "√("); return; }
      if (key === "cbrt") { this._applyFn(FUNCS_RAD.cbrt, "∛("); return; }
      if (key === "abs")  { this._applyFn(Math.abs, "|", "|"); return; }
      if (key === "exp")  { this._applyFn(Math.exp, "exp("); return; }
      if (key === "ln")   { this._applyFn(Math.log, "ln("); return; }
      if (key === "log")  { this._applyFn(FUNCS_RAD.log, "log("); return; }
      if (key === "log2") { this._applyFn(FUNCS_RAD.log2, "log₂("); return; }
      if (key === "fact") { this._applyFn(FUNCS_RAD.fact, "fact("); return; }
      if (key === "sin" || key === "cos" || key === "tan" ||
          key === "asin" || key === "acos" || key === "atan") {
        let fname = key;
        // If INV is on for sin->asin, etc.
        const inv = this.invOn;
        const hyp = this.hypOn;
        // normalize
        let base = fname;
        if (fname.startsWith("a")) base = fname.slice(1);
        if (hyp && !inv) fname = base + "h";
        else if (hyp && inv) fname = "a" + base + "h";
        else if (inv) fname = "a" + base;
        else fname = base;
        const fns = this.angleMode === "deg" ? Object.assign({}, FUNCS_RAD, FUNCS_DEG) : FUNCS_RAD;
        const fn = fns[fname];
        if (fn) this._applyFn(fn, fname + "(");
        return;
      }
      if (key === "x^y")  { this._inputOperator("^"); return; }
      if (key === "yroot") { this._inputOperator("^(1/"); return; }
      if (key === "2nd") { this.invOn = !this.invOn; const inv = $(this.root, "[data-cp-inv]"); if (inv) inv.classList.toggle("is-active", this.invOn); return; }
    }

    _inputDigit(d) {
      if (this.justEvaluated) {
        this.display = d === "." ? "0." : d;
        this.expression = "";
        this.justEvaluated = false;
        this._renderDisplay();
        return;
      }
      if (d === ".") {
        if (this.display.indexOf(".") !== -1) return;
        this.display = this.display + ".";
      } else {
        if (this.display === "0") this.display = d;
        else if (this.display === "-0") this.display = "-" + d;
        else this.display = this.display + d;
      }
      this._renderDisplay();
    }

    _toggleSign() {
      if (this.display === "0" || this.display === "") return;
      if (this.display.startsWith("-")) this.display = this.display.slice(1);
      else this.display = "-" + this.display;
      this._renderDisplay();
    }

    _inputOperator(op) {
      if (this.display === "" && !this.expression) return;
      const disp = this.display;
      if (!this.expression) {
        this.expression = disp + " " + this._prettyOp(op) + " ";
      } else if (/[+\-*/^%(]\s*$/.test(this.expression.trim())) {
        // if trailing op, replace (unless last is ')')
        if (/[+\-*/^%]\s*$/.test(this.expression.trim())) {
          this.expression = this.expression.trimEnd().replace(/[+\-*/^%]\s*$/, "") + " " + this._prettyOp(op) + " ";
        } else if (this.justEvaluated) {
          this.expression = disp + " " + this._prettyOp(op) + " ";
        } else {
          this.expression += disp + " " + this._prettyOp(op) + " ";
        }
      } else {
        this.expression += disp + " " + this._prettyOp(op) + " ";
      }
      this.display = "0";
      this.justEvaluated = false;
      this._renderDisplay();
    }

    _appendExpr(s) {
      // Only for ( and )
      if (s === "(") {
        this.expression += (this.expression ? " " : "") + "(";
        this.display = "0";
        this.justEvaluated = false;
      } else if (s === ")") {
        this.expression += this.display + " )";
        this.display = "0";
        this.justEvaluated = false;
      }
      this._renderDisplay();
    }

    _applyFn(fn, prefix, suffix) {
      try {
        const v = parseFloat(this.display);
        const r = fn(v);
        if (!isFinite(r) || r !== r) { this._setDisplay("Error"); return; }
        const exprPiece = (prefix || "") + this.display + (suffix || (prefix && prefix.endsWith("(") ? ")" : ""));
        this.history.unshift({ expr: exprPiece, result: formatNumber(r), ts: Date.now() });
        this._trimHistory();
        this._renderHistory();
        this._savePersisted();
        this._setDisplay(formatNumber(r));
        this.justEvaluated = true;
      } catch (e) {
        this._setDisplay("Error");
      }
    }

    _prettyOp(op) {
      switch (op) {
        case "*": return "×";
        case "/": return "÷";
        case "-": return "−";
        default: return op;
      }
    }
    _rawOp(op) {
      switch (op) {
        case "×": return "*";
        case "÷": return "/";
        case "−": return "-";
        default: return op;
      }
    }

    _equals() {
      const exprRaw = (this.expression + " " + this.display)
        .trim()
        .replace(/×/g, "*")
        .replace(/÷/g, "/")
        .replace(/−/g, "-");
      if (!exprRaw) return;
      try {
        const result = evaluateExpression(exprRaw, this.angleMode);
        if (!isFinite(result) || result !== result) {
          this._setDisplay("Error"); return;
        }
        const fullExpr = this.expression + this.display;
        this.lastAnswer = result;
        this.history.unshift({
          expr: fullExpr.replace(/\s+/g, " ").trim(),
          result: formatNumber(result),
          ts: Date.now(),
        });
        this._trimHistory();
        this._renderHistory();
        this._savePersisted();
        this.expression = "";
        this.display = formatNumber(result);
        this.justEvaluated = true;
        this._renderDisplay();
      } catch (e) {
        this._setDisplay("Error");
      }
    }

    _clearAll() {
      this.display = "0";
      this.expression = "";
      this.justEvaluated = false;
      this._renderDisplay();
    }
    _clearEntry() {
      this.display = "0";
      this.justEvaluated = false;
      this._renderDisplay();
    }
    _backspace() {
      if (this.justEvaluated) { this._clearEntry(); return; }
      if (this.display.length <= 1 || (this.display.length === 2 && this.display.startsWith("-"))) {
        this.display = "0";
      } else {
        this.display = this.display.slice(0, -1);
      }
      this._renderDisplay();
    }

    _setDisplay(s) {
      this.display = s;
      this._renderDisplay();
    }
    _renderDisplay() {
      const d = $(this.root, "[data-cp-display]");
      const e = $(this.root, "[data-cp-expr]");
      if (d) d.textContent = this.display;
      if (e) e.innerHTML = this.expression ? escapeHtml(this.expression) : "&nbsp;";
    }

    _trimHistory() {
      if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
    }

    /* ------------------------------------------------------------
     * MEMORY
     * --------------------------------------------------------- */
    _handleMem(op) {
      const v = parseFloat(this.display) || 0;
      switch (op) {
        case "MC": this.memory = 0; this.hasMemory = false; break;
        case "MR": this.display = formatNumber(this.memory); this.justEvaluated = true; this._renderDisplay(); break;
        case "M+": this.memory += v; this.hasMemory = true; break;
        case "M-": this.memory -= v; this.hasMemory = true; break;
        case "MS": this.memory  = v; this.hasMemory = true; break;
      }
      this._renderMemory();
      this._savePersisted();
    }
    _renderMemory() {
      $$(this.root, "[data-cp-mem-indicator]").forEach((el) => { el.hidden = !this.hasMemory; });
    }

    /* ------------------------------------------------------------
     * PROGRAMMER MODE
     * --------------------------------------------------------- */
    _bindProgrammer() {
      $$(this.root, "[data-panel='programmer'] [data-cp-key]").forEach((b) => {
        b.addEventListener("click", (ev) => {
          const r = b.getBoundingClientRect();
          b.style.setProperty("--x", ((ev.clientX - r.left) / r.width * 100) + "%");
          b.style.setProperty("--y", ((ev.clientY - r.top) / r.height * 100) + "%");
          b.classList.remove("is-press"); void b.offsetWidth; b.classList.add("is-press");
          this._handleProgKey(b.dataset.cpKey);
        });
      });
      $$(this.root, "[data-cp-base]").forEach((b) => {
        b.addEventListener("click", () => this._setProgBase(b.dataset.cpBase));
      });
      $$(this.root, "[data-cp-word]").forEach((b) => {
        b.addEventListener("click", () => this._setProgWord(parseInt(b.dataset.cpWord, 10)));
      });
      $$(this.root, "[data-cp-prog-row]").forEach((r) => {
        r.addEventListener("click", () => this._setProgBase(r.dataset.cpProgRow));
      });
    }

    _setProgBase(base) {
      this.progBase = base;
      $$(this.root, "[data-cp-base]").forEach((b) => b.classList.toggle("is-active", b.dataset.cpBase === base));
      $$(this.root, "[data-cp-prog-row]").forEach((r) => r.classList.toggle("is-active", r.dataset.cpProgRow === base));
      // disable hex letters when base is not HEX
      $$(this.root, "[data-panel='programmer'] [data-cp-key]").forEach((b) => {
        const k = b.dataset.cpKey;
        if (["A","B","C_HEX","D","E","F"].indexOf(k) !== -1) {
          b.classList.toggle("is-disabled", base !== "HEX");
        }
        // disable non-binary digits when BIN
        if (/^[0-9]$/.test(k)) {
          b.classList.toggle("is-disabled", !validDigitForBase(k, base));
        }
      });
      this._renderProgAll();
    }

    _setProgWord(w) {
      this.progWord = w;
      $$(this.root, "[data-cp-word]").forEach((b) => b.classList.toggle("is-active", parseInt(b.dataset.cpWord, 10) === w));
      this.progValue = maskToWord(this.progValue, w);
      this._renderProgAll();
    }

    _handleProgKey(key) {
      // hex/digit
      if (/^[0-9]$/.test(key) || ["A","B","C_HEX","D","E","F"].indexOf(key) !== -1) {
        const d = key === "C_HEX" ? "C" : key;
        if (!validDigitForBase(d, this.progBase)) return;
        const cur = formatBase(this.progValue, this.progBase, this.progWord).replace(/\s+/g, "");
        let nxt;
        if (cur === "0") nxt = d;
        else nxt = cur + d;
        try {
          this.progValue = maskToWord(parseBase(nxt, this.progBase), this.progWord);
        } catch (_) { /* ignore */ }
        this._renderProgAll();
        return;
      }
      if (key === "C") { this.progValue = 0n; this.progPending = null; this.progPendingExpr = ""; this._renderProgAll(); return; }
      if (key === "BACK") {
        let cur = formatBase(this.progValue, this.progBase, this.progWord).replace(/\s+/g, "");
        if (cur.length <= 1) cur = "0"; else cur = cur.slice(0, -1);
        this.progValue = maskToWord(parseBase(cur, this.progBase), this.progWord);
        this._renderProgAll();
        return;
      }
      if (key === "neg") {
        const signed = signedView(this.progValue, this.progWord);
        this.progValue = maskToWord(-signed, this.progWord);
        this._renderProgAll();
        return;
      }
      if (["AND","OR","XOR","LSH","RSH","+","-","*","/","%"].indexOf(key) !== -1) {
        if (this.progPending) this._applyProgPending();
        this.progPending = { op: key, a: this.progValue };
        this.progPendingExpr = formatBase(this.progValue, this.progBase, this.progWord) + " " + this._progOpSymbol(key) + " ";
        this.progValue = 0n;
        this._renderProgAll();
        return;
      }
      if (key === "NOT") {
        const mask = (1n << BigInt(this.progWord)) - 1n;
        this.progValue = (~this.progValue) & mask;
        this._renderProgAll();
        return;
      }
      if (key === "=") {
        this._applyProgPending();
        return;
      }
    }

    _progOpSymbol(op) {
      switch (op) {
        case "AND": return "AND";
        case "OR":  return "OR";
        case "XOR": return "XOR";
        case "LSH": return "≪";
        case "RSH": return "≫";
        case "*":   return "×";
        case "/":   return "÷";
        case "-":   return "−";
        default:    return op;
      }
    }

    _applyProgPending() {
      if (!this.progPending) {
        this.progPendingExpr = "";
        this._renderProgAll();
        return;
      }
      const a = this.progPending.a;
      const b = this.progValue;
      const wm = this.progWord;
      const mask = (1n << BigInt(wm)) - 1n;
      let r = 0n;
      try {
        switch (this.progPending.op) {
          case "AND": r = (a & b) & mask; break;
          case "OR":  r = (a | b) & mask; break;
          case "XOR": r = (a ^ b) & mask; break;
          case "LSH": r = (a << BigInt(Number(b & 63n))) & mask; break;
          case "RSH": r = (a >> BigInt(Number(b & 63n))) & mask; break;
          case "+":   r = maskToWord(signedView(a, wm) + signedView(b, wm), wm); break;
          case "-":   r = maskToWord(signedView(a, wm) - signedView(b, wm), wm); break;
          case "*":   r = maskToWord(signedView(a, wm) * signedView(b, wm), wm); break;
          case "/":   r = b === 0n ? 0n : maskToWord(signedView(a, wm) / signedView(b, wm), wm); break;
          case "%":   r = b === 0n ? 0n : maskToWord(signedView(a, wm) % signedView(b, wm), wm); break;
        }
      } catch (_) { r = 0n; }
      const expr = this.progPendingExpr + formatBase(b, this.progBase, wm);
      this.history.unshift({
        expr: "[" + this.progBase + "] " + expr,
        result: formatBase(r, this.progBase, wm),
        ts: Date.now(),
      });
      this._trimHistory();
      this._renderHistory();
      this._savePersisted();
      this.progValue = r;
      this.progPending = null;
      this.progPendingExpr = "";
      this._renderProgAll();
    }

    _renderProgAll() {
      ["HEX","DEC","OCT","BIN"].forEach((b) => {
        const el = $(this.root, `[data-cp-prog-value="${b}"]`);
        if (el) el.textContent = formatBase(this.progValue, b, this.progWord);
      });
      // Main display
      if (this.mode === "programmer") {
        const d = $(this.root, "[data-cp-display]");
        if (d) d.textContent = formatBase(this.progValue, this.progBase, this.progWord);
        const e = $(this.root, "[data-cp-expr]");
        if (e) e.innerHTML = this.progPendingExpr ? escapeHtml(this.progPendingExpr) : "&nbsp;";
      }
    }

    /* ------------------------------------------------------------
     * UNIT CONVERTER
     * --------------------------------------------------------- */
    _bindUnit() {
      const cat = $(this.root, "[data-cp-unit-cat]");
      const from = $(this.root, "[data-cp-unit-from]");
      const to   = $(this.root, "[data-cp-unit-to]");
      const fromV= $(this.root, "[data-cp-unit-from-val]");
      const swap = $(this.root, "[data-cp-unit-swap]");
      if (cat) cat.addEventListener("change", () => { this._populateUnitSelects(); this._updateUnitResult(); });
      if (from) from.addEventListener("change", () => this._updateUnitResult());
      if (to)   to.addEventListener("change",   () => this._updateUnitResult());
      if (fromV) fromV.addEventListener("input", () => this._updateUnitResult());
      if (swap) swap.addEventListener("click", () => {
        const f = from.value; from.value = to.value; to.value = f;
        this._updateUnitResult();
      });
      // keypad
      $$(this.root, "[data-cp-unit-key]").forEach((b) => {
        b.addEventListener("click", () => this._handleUnitKey(b.dataset.cpUnitKey));
      });
    }

    _populateUnitSelects() {
      const cat = $(this.root, "[data-cp-unit-cat]");
      const category = cat ? cat.value : "length";
      const fromSel = $(this.root, "[data-cp-unit-from]");
      const toSel   = $(this.root, "[data-cp-unit-to]");
      if (!fromSel || !toSel) return;
      const items = UNITS[category].items;
      const keys = Object.keys(items);
      const options = keys.map((k) =>
        `<option value="${escapeHtml(k)}">${escapeHtml(items[k].name)} (${escapeHtml(k)})</option>`
      ).join("");
      fromSel.innerHTML = options;
      toSel.innerHTML   = options;
      fromSel.value = keys[0];
      toSel.value   = keys[1] || keys[0];
    }

    _updateUnitResult() {
      const cat = $(this.root, "[data-cp-unit-cat]");
      const from = $(this.root, "[data-cp-unit-from]");
      const to   = $(this.root, "[data-cp-unit-to]");
      const fromV= $(this.root, "[data-cp-unit-from-val]");
      const toV  = $(this.root, "[data-cp-unit-to-val]");
      const info = $(this.root, "[data-cp-unit-info]");
      if (!cat || !from || !to || !fromV || !toV) return;
      const v = parseFloat(fromV.value);
      const r = convertUnit(cat.value, from.value, to.value, v);
      if (isNaN(r)) toV.value = "—";
      else toV.value = formatNumber(r);
      if (info) {
        if (!isNaN(r) && !isNaN(v)) {
          info.textContent = `1 ${from.value} = ${formatNumber(convertUnit(cat.value, from.value, to.value, 1))} ${to.value}`;
        } else info.textContent = "";
      }
    }

    _handleUnitKey(k) {
      const inp = $(this.root, "[data-cp-unit-from-val]");
      if (!inp) return;
      if (k === "C") { inp.value = "0"; this._updateUnitResult(); return; }
      if (k === "BACK") { inp.value = inp.value.slice(0, -1) || "0"; this._updateUnitResult(); return; }
      if (k === "neg") {
        inp.value = inp.value.startsWith("-") ? inp.value.slice(1) : "-" + inp.value;
        this._updateUnitResult();
        return;
      }
      if (k === "COPY") {
        const out = $(this.root, "[data-cp-unit-to-val]");
        if (out && navigator.clipboard) navigator.clipboard.writeText(out.value).catch(() => {});
        return;
      }
      if (/^[0-9.]$/.test(k)) {
        if (inp.value === "0" && k !== ".") inp.value = k;
        else if (k === "." && inp.value.indexOf(".") !== -1) return;
        else inp.value = inp.value + k;
        this._updateUnitResult();
      }
    }

    /* ------------------------------------------------------------
     * CURRENCY
     * --------------------------------------------------------- */
    _bindCurrency() {
      const from = $(this.root, "[data-cp-curr-from]");
      const to   = $(this.root, "[data-cp-curr-to]");
      const fromV= $(this.root, "[data-cp-curr-from-val]");
      const swap = $(this.root, "[data-cp-curr-swap]");
      const date = $(this.root, "[data-cp-curr-date]");
      if (date) date.textContent = CURRENCY_UPDATED;
      if (from) from.addEventListener("change", () => this._updateCurrencyResult());
      if (to)   to.addEventListener("change",   () => this._updateCurrencyResult());
      if (fromV) fromV.addEventListener("input", () => this._updateCurrencyResult());
      if (swap) swap.addEventListener("click", () => {
        const f = from.value; from.value = to.value; to.value = f;
        this._updateCurrencyResult();
      });
    }

    _populateCurrencySelects() {
      const fromSel = $(this.root, "[data-cp-curr-from]");
      const toSel   = $(this.root, "[data-cp-curr-to]");
      if (!fromSel || !toSel) return;
      const codes = Object.keys(CURRENCIES);
      const options = codes.map((c) =>
        `<option value="${escapeHtml(c)}">${escapeHtml(c)} — ${escapeHtml(CURRENCIES[c].name)}</option>`
      ).join("");
      fromSel.innerHTML = options;
      toSel.innerHTML   = options;
      fromSel.value = "USD";
      toSel.value   = "EUR";
    }

    _renderCurrencyTable() {
      const tbl = $(this.root, "[data-cp-curr-table]");
      if (!tbl) return;
      const rows = Object.keys(CURRENCIES).map((c) => {
        const { name, rate, symbol } = CURRENCIES[c];
        return `<div class="cp-curr-table-row">
          <span class="cp-curr-code">${escapeHtml(c)}</span>
          <span class="cp-curr-name">${escapeHtml(symbol)} ${escapeHtml(name)}</span>
          <span class="cp-curr-rate">1 USD = ${formatNumber(rate)} ${escapeHtml(c)}</span>
        </div>`;
      }).join("");
      tbl.innerHTML = rows;
    }

    _updateCurrencyResult() {
      const from = $(this.root, "[data-cp-curr-from]");
      const to   = $(this.root, "[data-cp-curr-to]");
      const fromV= $(this.root, "[data-cp-curr-from-val]");
      const toV  = $(this.root, "[data-cp-curr-to-val]");
      if (!from || !to || !fromV || !toV) return;
      const v = parseFloat(fromV.value);
      const r = convertCurrency(from.value, to.value, v);
      toV.value = isNaN(r) ? "—" : formatNumber(r, 6);
    }

    /* ------------------------------------------------------------
     * HISTORY PANEL
     * --------------------------------------------------------- */
    _bindHistory() {
      const toggle = $(this.root, "[data-cp-history-toggle]");
      const close  = $(this.root, "[data-cp-history-close]");
      const clr    = $(this.root, "[data-cp-history-clear]");
      if (toggle) toggle.addEventListener("click", () => {
        const p = $(this.root, "[data-cp-history]");
        p.hidden = !p.hidden;
      });
      if (close) close.addEventListener("click", () => {
        const p = $(this.root, "[data-cp-history]"); p.hidden = true;
      });
      if (clr) clr.addEventListener("click", () => {
        if (!confirm("Clear all history?")) return;
        this.history.length = 0;
        this._renderHistory();
        this._savePersisted();
      });
    }

    _renderHistory() {
      const list = $(this.root, "[data-cp-history-list]");
      if (!list) return;
      if (!this.history.length) {
        list.innerHTML = `<div class="cp-history-empty">No calculations yet.</div>`;
        return;
      }
      list.innerHTML = this.history.map((h, i) =>
        `<div class="cp-history-item" data-cp-hist-idx="${i}">
          <div class="cp-history-expr">${escapeHtml(h.expr)} =</div>
          <div class="cp-history-result">${escapeHtml(h.result)}</div>
        </div>`
      ).join("");
      $$(list, "[data-cp-hist-idx]").forEach((n) => {
        n.addEventListener("click", () => {
          const h = this.history[parseInt(n.dataset.cpHistIdx, 10)];
          if (!h) return;
          this._setDisplay(h.result);
          this.expression = "";
          this.justEvaluated = true;
        });
      });
    }

    /* ------------------------------------------------------------
     * KEYBOARD
     * --------------------------------------------------------- */
    _bindKeyboard() {
      const self = this;
      this.keyHandler = (ev) => {
        if (self.destroyed || !self.root || !self.root.isConnected) return;
        if (!self.root.contains(document.activeElement) && !self.root.matches(":hover")) return;

        // Allow typing inside inputs (unit/currency)
        const inField = ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT");
        if (inField) return;

        const k = ev.key;
        if (self.mode === "programmer") {
          if (k === "Escape") { ev.preventDefault(); self.progValue = 0n; self._renderProgAll(); return; }
          if (k === "Backspace") { ev.preventDefault(); self._handleProgKey("BACK"); return; }
          if (k === "Enter" || k === "=") { ev.preventDefault(); self._handleProgKey("="); return; }
          if (/^[0-9A-Fa-f]$/.test(k)) {
            ev.preventDefault();
            const key = /[A-F]/.test(k.toUpperCase()) ? (k.toUpperCase() === "C" ? "C_HEX" : k.toUpperCase()) : k;
            self._handleProgKey(key);
            return;
          }
          if ("+-*/%".indexOf(k) !== -1) { ev.preventDefault(); self._handleProgKey(k); return; }
          if (k === "&") { ev.preventDefault(); self._handleProgKey("AND"); return; }
          if (k === "|") { ev.preventDefault(); self._handleProgKey("OR"); return; }
          if (k === "^") { ev.preventDefault(); self._handleProgKey("XOR"); return; }
          if (k === "~") { ev.preventDefault(); self._handleProgKey("NOT"); return; }
          return;
        }
        // Standard / Scientific keyboard
        if (/^[0-9]$/.test(k) || k === ".") {
          ev.preventDefault(); self._handleKey(k); return;
        }
        if (k === "+" || k === "-" || k === "*" || k === "/" || k === "%" || k === "^") {
          ev.preventDefault(); self._handleKey(k); return;
        }
        if (k === "(" || k === ")") { ev.preventDefault(); self._handleKey(k); return; }
        if (k === "Enter" || k === "=") { ev.preventDefault(); self._handleKey("="); return; }
        if (k === "Escape") { ev.preventDefault(); self._handleKey("C"); return; }
        if (k === "Backspace") { ev.preventDefault(); self._handleKey("BACK"); return; }
        if (k === "Delete") { ev.preventDefault(); self._handleKey("CE"); return; }
        // copy
        if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === "c" && !ev.shiftKey && !ev.altKey) {
          try { navigator.clipboard && navigator.clipboard.writeText(self.display); } catch (_) {}
        }
        // paste
        if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === "v" && !ev.shiftKey && !ev.altKey) {
          if (navigator.clipboard) navigator.clipboard.readText().then((t) => {
            const n = parseFloat(t);
            if (isFinite(n)) { self._setDisplay(formatNumber(n)); self.justEvaluated = true; }
          }).catch(() => {});
        }
      };
      document.addEventListener("keydown", this.keyHandler, true);
    }
  }

  /* -------------------------------------------------------------------------
   * CSS AUTO-LINK
   * ---------------------------------------------------------------------- */
  (function ensureCss() {
    const href = "apps/calculator/calculator.css";
    const has = Array.from(document.styleSheets).some((s) => (s.href || "").endsWith(href));
    if (!has) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      document.head.appendChild(l);
    }
  })();

  /* -------------------------------------------------------------------------
   * REGISTER WITH WINDOW MANAGER
   * ---------------------------------------------------------------------- */
  function registerApp() {
    if (!window.WindowManager || !window.WindowManager.registerApp) {
      window.addEventListener("webos:wmready", registerApp, { once: true });
      return;
    }
    // Override the stub registration made by windowManager.registerBuiltIns
    if (typeof window.WindowManager.unregisterApp === "function") {
      window.WindowManager.unregisterApp(APP_ID);
    }
    window.WindowManager.registerApp({
      id: APP_ID,
      title: APP_TITLE,
      icon: APP_ICON,
      width: 460, height: 620,
      minWidth: 360, minHeight: 480,
      category: APP_CATEGORY,
      pinned: true,
      render(body, win) {
        const c = new CalcPro(body, win.opts || {});
        c.mount();
        win._calcpro = c;
      },
      onClose(win) {
        if (win._calcpro) win._calcpro.destroy();
      },
    });
    console.log("%c[WebOS]%c CalcPro Calculator registered",
      "color:#7c3aed;font-weight:bold", "color:inherit");
  }

  if (window.WindowManager) registerApp();
  else window.addEventListener("DOMContentLoaded", registerApp);

  /* -------------------------------------------------------------------------
   * ADDITIONAL MATH HELPERS
   *   Higher-level mathematical utilities that are not strictly needed for
   *   the basic calculator logic, but are exposed publicly and used by a
   *   handful of convenience buttons (and, in the future, by other apps
   *   that want to share CalcPro's numerical capabilities).
   * ---------------------------------------------------------------------- */

  /**
   * Greatest common divisor (Euclid's algorithm). Works on absolute values
   * and always returns a non-negative integer. `gcd(0, n) === n`.
   */
  function gcd(a, b) {
    a = Math.abs(Math.trunc(a));
    b = Math.abs(Math.trunc(b));
    while (b) { const t = b; b = a % b; a = t; }
    return a;
  }

  /**
   * Least common multiple. `lcm(0, _) === 0` by convention.
   */
  function lcm(a, b) {
    if (a === 0 || b === 0) return 0;
    return Math.abs(Math.trunc(a) * Math.trunc(b)) / gcd(a, b);
  }

  /**
   * Binomial coefficient "n choose k". Uses the iterative formulation so
   * that intermediate values stay bounded for moderately large n.
   */
  function binomial(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    k = Math.min(k, n - k);
    let result = 1;
    for (let i = 0; i < k; i++) {
      result = (result * (n - i)) / (i + 1);
    }
    return Math.round(result);
  }

  /**
   * Primality test using trial division up to sqrt(n). Good enough for
   * the magnitudes a human-driven calculator actually encounters.
   */
  function isPrime(n) {
    n = Math.trunc(n);
    if (n < 2) return false;
    if (n < 4) return true;
    if (n % 2 === 0) return false;
    const limit = Math.floor(Math.sqrt(n));
    for (let i = 3; i <= limit; i += 2) {
      if (n % i === 0) return false;
    }
    return true;
  }

  /**
   * Prime factorization. Returns an array of prime factors in ascending
   * order (with repetition for multiplicity).
   */
  function primeFactors(n) {
    n = Math.abs(Math.trunc(n));
    const out = [];
    if (n < 2) return out;
    for (let p = 2; p * p <= n; p++) {
      while (n % p === 0) { out.push(p); n = n / p; }
    }
    if (n > 1) out.push(n);
    return out;
  }

  /**
   * Sum and mean for an array of numbers. Returns `null` if the input is
   * empty to make the caller explicitly handle that case.
   */
  function sum(arr)  { return arr.reduce((a, b) => a + Number(b), 0); }
  function mean(arr) { return arr.length ? sum(arr) / arr.length : null; }

  /**
   * Sample variance / standard deviation. Uses the unbiased (n - 1)
   * denominator when there are at least two samples.
   */
  function variance(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    let s = 0;
    for (const v of arr) s += (v - m) * (v - m);
    return s / (arr.length - 1);
  }
  function stdev(arr) { return Math.sqrt(variance(arr)); }

  /**
   * Median. Non-destructive (copies the input before sorting).
   */
  function median(arr) {
    if (!arr.length) return null;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Linear interpolation and inverse (t=0 => a, t=1 => b).
   */
  function lerp(a, b, t)        { return a + (b - a) * t; }
  function inverseLerp(a, b, v) { return b === a ? 0 : (v - a) / (b - a); }

  /**
   * Clamp a value to the closed interval [lo, hi]. If lo > hi, the bounds
   * are swapped to behave intuitively.
   */
  function clamp(x, lo, hi) {
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return Math.max(lo, Math.min(hi, x));
  }

  /**
   * Normalize a value to [0,1] given input range [a,b]. Used by the
   * minimap-style scrollers (future extension).
   */
  function normalize(x, a, b) { return b === a ? 0 : (x - a) / (b - a); }

  /**
   * Round `x` to `digits` decimal places while avoiding floating-point
   * drift around powers of 10. Matches the display formatting used by
   * the standard-mode `=` button.
   */
  function roundTo(x, digits) {
    const p = Math.pow(10, digits || 0);
    return Math.round(x * p) / p;
  }

  /* -------------------------------------------------------------------------
   * PHYSICAL CONSTANTS
   *   Exposed via CalcPro.CONSTANTS for advanced users and for use by the
   *   scientific mode in a future extension. Values are CODATA 2018 where
   *   applicable, otherwise widely accepted textbook values.
   * ---------------------------------------------------------------------- */
  const PHYSICAL_CONSTANTS = {
    c:   { name: "Speed of light",           value: 299792458,             unit: "m/s" },
    G:   { name: "Gravitational constant",   value: 6.67430e-11,           unit: "m³/(kg·s²)" },
    h:   { name: "Planck constant",          value: 6.62607015e-34,        unit: "J·s" },
    hbar:{ name: "Reduced Planck constant",  value: 1.054571817e-34,       unit: "J·s" },
    k:   { name: "Boltzmann constant",       value: 1.380649e-23,          unit: "J/K" },
    e:   { name: "Elementary charge",        value: 1.602176634e-19,       unit: "C" },
    Na:  { name: "Avogadro constant",        value: 6.02214076e23,         unit: "1/mol" },
    R:   { name: "Gas constant",             value: 8.314462618,           unit: "J/(mol·K)" },
    me:  { name: "Electron mass",            value: 9.1093837015e-31,      unit: "kg" },
    mp:  { name: "Proton mass",              value: 1.67262192369e-27,     unit: "kg" },
    mn:  { name: "Neutron mass",             value: 1.67492749804e-27,     unit: "kg" },
    eps0:{ name: "Vacuum permittivity",      value: 8.8541878128e-12,      unit: "F/m" },
    mu0: { name: "Vacuum permeability",      value: 1.25663706212e-6,      unit: "N/A²" },
    g0:  { name: "Standard gravity",         value: 9.80665,               unit: "m/s²" },
    atm: { name: "Standard atmosphere",      value: 101325,                unit: "Pa" },
    Rinf:{ name: "Rydberg constant",         value: 10973731.568160,       unit: "1/m" },
    sigma:{ name:"Stefan-Boltzmann constant",value: 5.670374419e-8,        unit: "W/(m²·K⁴)" },
    F:   { name: "Faraday constant",         value: 96485.33212,           unit: "C/mol" },
  };

  /* -------------------------------------------------------------------------
   * EXTRA FORMATTING HELPERS
   *   Shared between modes for consistent display of numbers, bases, and
   *   engineering-notation values.
   * ---------------------------------------------------------------------- */

  /**
   * Format a number using engineering notation (exponents that are
   * multiples of 3). Used by the scientific panel's "ENG" toggle (planned).
   */
  function formatEngineering(n, sigFigs) {
    if (!isFinite(n)) return n > 0 ? "∞" : "-∞";
    if (n === 0) return "0";
    sigFigs = sigFigs || 6;
    const exp = Math.floor(Math.log10(Math.abs(n)) / 3) * 3;
    const mant = n / Math.pow(10, exp);
    return mant.toPrecision(sigFigs) + "e" + (exp >= 0 ? "+" : "") + exp;
  }

  /**
   * Format a number with explicit thousands separators in the decimal
   * portion only. Examples:
   *   1234567       -> "1,234,567"
   *   1234567.890   -> "1,234,567.890"
   *   -1234.5       -> "-1,234.5"
   */
  function formatThousands(n) {
    const s = String(n);
    const parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  /**
   * Pretty-print a duration in seconds as a compact human string (used by
   * the unit converter's time category).
   */
  function formatDuration(seconds) {
    seconds = Math.abs(Number(seconds) || 0);
    if (seconds < 60) return formatNumber(seconds) + " s";
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    if (m < 60) return m + "m " + formatNumber(s) + "s";
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    if (h < 24) return h + "h " + mm + "m";
    const d = Math.floor(h / 24);
    const hh = h - d * 24;
    return d + "d " + hh + "h";
  }

  /**
   * Pretty-print a byte count as a binary-prefixed value (KB / MB / GB / …).
   * Mirrors the convention used in the data-storage unit category.
   */
  function formatBytes(bytes) {
    bytes = Number(bytes) || 0;
    if (Math.abs(bytes) < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let v = bytes / 1024;
    let i = 0;
    while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return formatNumber(v, 4) + " " + units[i];
  }

  /* -------------------------------------------------------------------------
   * PUBLIC HELPERS FOR TESTING
   *   These are exposed on the CalcPro singleton so Day 4 integration tests
   *   (and any curious console user) can exercise the internal building
   *   blocks directly without needing a window instance.
   * ---------------------------------------------------------------------- */
  function selfTest() {
    const assertEq = (name, got, want, eps) => {
      eps = eps || 1e-10;
      const ok = Math.abs(got - want) <= eps;
      if (!ok) console.warn("[CalcPro self-test]", name, "FAIL", got, "expected", want);
      return ok;
    };
    let passed = 0, total = 0;
    const T = (name, got, want, eps) => { total++; if (assertEq(name, got, want, eps)) passed++; };

    T("2+3",        evaluateExpression("2+3"),          5);
    T("2+3*4",      evaluateExpression("2+3*4"),        14);
    T("(2+3)*4",    evaluateExpression("(2+3)*4"),      20);
    T("-5+3",       evaluateExpression("-5+3"),         -2);
    T("2^10",       evaluateExpression("2^10"),         1024);
    T("sqrt(9)",    evaluateExpression("sqrt(9)"),      3);
    T("sin(0)",     evaluateExpression("sin(0)"),       0);
    T("cos(pi)",    evaluateExpression("cos(pi)"),      -1, 1e-9);
    T("log(100)",   evaluateExpression("log(100)"),     2,  1e-9);
    T("fact(5)",    evaluateExpression("fact(5)"),      120);
    T("gcd(12,18)", gcd(12,18),                         6);
    T("lcm(4,6)",   lcm(4,6),                           12);
    T("binomial(5,2)", binomial(5,2),                   10);
    T("mean([1,2,3,4])",mean([1,2,3,4]),                2.5);
    T("median([1,2,3])",median([1,2,3]),                2);
    T("convertUnit len cm->m", convertUnit("length","cm","m",100), 1);
    T("convertUnit temp C->F", convertUnit("temperature","C","F",100), 212);
    T("convertUnit weight kg->lb", convertUnit("weight","kg","lb",1), 2.20462262184878, 1e-8);

    // Programmer
    const prog = (a, op, b, base, word) => {
      const A = parseBase(a, base);
      const B = parseBase(b, base);
      const mask = (1n << BigInt(word)) - 1n;
      let r = 0n;
      if (op === "AND") r = (A & B) & mask;
      else if (op === "OR")  r = (A | B) & mask;
      else if (op === "XOR") r = (A ^ B) & mask;
      return r;
    };
    const got = prog("FF", "AND", "0F", "HEX", 64);
    T("0xFF AND 0x0F", Number(got), 0x0F);

    console.log("%c[CalcPro self-test]%c " + passed + "/" + total + " passed.",
      "color:#7c3aed;font-weight:bold", "color:inherit");
    return { passed, total };
  }

  /* -------------------------------------------------------------------------
   * EXPOSE
   * ---------------------------------------------------------------------- */
  window.CalcPro = {
    APP_ID,
    UNITS, CURRENCIES, CURRENCY_UPDATED,
    CONSTANTS: PHYSICAL_CONSTANTS,
    // expression engine
    evaluate: evaluateExpression,
    tokenize: tokenizeExpr,
    toRPN, evalRPN,
    // conversions
    convertUnit, convertCurrency,
    // math helpers
    gcd, lcm, binomial, isPrime, primeFactors,
    sum, mean, variance, stdev, median,
    lerp, inverseLerp, clamp, normalize, roundTo,
    // formatting
    formatNumber, formatEngineering, formatThousands,
    formatDuration, formatBytes,
    formatBase, parseBase, maskToWord, signedView,
    // lifecycle / UI
    open() { return window.WindowManager.openApp(APP_ID); },
    selfTest,
  };

  /* -------------------------------------------------------------------------
   * BACKWARDS-COMPAT ALIASES
   *   A handful of well-known method names from classic desktop calculators
   *   that third-party code might probe for. Each one is forwarded to the
   *   appropriate internal helper so external scripts don't have to worry
   *   about CalcPro's exact naming conventions.
   * ---------------------------------------------------------------------- */
  window.CalcPro.compute            = evaluateExpression;
  window.CalcPro.calculate          = evaluateExpression;
  window.CalcPro.eval               = evaluateExpression;
  window.CalcPro.convert            = convertUnit;
  window.CalcPro.exchange           = convertCurrency;
  window.CalcPro.hex                = (n, w) => formatBase(toBigInt(n), "HEX", w || 64);
  window.CalcPro.oct                = (n, w) => formatBase(toBigInt(n), "OCT", w || 64);
  window.CalcPro.bin                = (n, w) => formatBase(toBigInt(n), "BIN", w || 64);

  /* -------------------------------------------------------------------------
   * FRACTION HELPERS
   *   Basic rational arithmetic for the scientific mode's (planned) fraction
   *   toggle. Represents fractions as {n, d} pairs with d > 0, always kept
   *   in reduced form.
   * ---------------------------------------------------------------------- */
  function makeFraction(n, d) {
    n = Math.trunc(n);
    d = Math.trunc(d);
    if (d === 0) return { n: 0, d: 0 }; // invalid sentinel
    if (d < 0)   { n = -n; d = -d; }
    const g = gcd(n, d) || 1;
    return { n: n / g, d: d / g };
  }
  function fracAdd(a, b) { return makeFraction(a.n * b.d + b.n * a.d, a.d * b.d); }
  function fracSub(a, b) { return makeFraction(a.n * b.d - b.n * a.d, a.d * b.d); }
  function fracMul(a, b) { return makeFraction(a.n * b.n,             a.d * b.d); }
  function fracDiv(a, b) { return makeFraction(a.n * b.d,             a.d * b.n); }
  function fracToString(f) { return f.d === 1 ? String(f.n) : f.n + "/" + f.d; }
  function fracToNumber(f) { return f.d === 0 ? NaN : f.n / f.d; }

  /**
   * Convert a floating-point number to its best rational approximation
   * using continued fractions. Caps the denominator to avoid runaway
   * precision on irrationals.
   */
  function numberToFraction(x, maxDenominator) {
    maxDenominator = maxDenominator || 10000;
    if (!isFinite(x)) return { n: 0, d: 0 };
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    let h1 = 1, h0 = 0, k1 = 0, k0 = 1;
    let a = Math.floor(x);
    let f = x - a;
    while (true) {
      const h2 = a * h1 + h0;
      const k2 = a * k1 + k0;
      if (k2 > maxDenominator) break;
      h0 = h1; h1 = h2;
      k0 = k1; k1 = k2;
      if (f < 1e-12) break;
      const next = 1 / f;
      a = Math.floor(next);
      f = next - a;
    }
    return { n: sign * h1, d: k1 };
  }

  /* -------------------------------------------------------------------------
   * MATRIX HELPERS
   *   Small fixed-size matrix utilities used by the (planned) matrix panel.
   *   Representation: an array of arrays, row-major, all rows equal length.
   * ---------------------------------------------------------------------- */
  function matZeros(rows, cols) {
    const m = new Array(rows);
    for (let r = 0; r < rows; r++) {
      m[r] = new Array(cols).fill(0);
    }
    return m;
  }
  function matIdentity(n) {
    const m = matZeros(n, n);
    for (let i = 0; i < n; i++) m[i][i] = 1;
    return m;
  }
  function matTranspose(a) {
    const rows = a.length, cols = a[0].length;
    const out = matZeros(cols, rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out[c][r] = a[r][c];
    return out;
  }
  function matAdd(a, b) {
    const rows = a.length, cols = a[0].length;
    const out = matZeros(rows, cols);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out[r][c] = a[r][c] + b[r][c];
    return out;
  }
  function matMul(a, b) {
    const ar = a.length, ac = a[0].length, bc = b[0].length;
    const out = matZeros(ar, bc);
    for (let r = 0; r < ar; r++)
      for (let c = 0; c < bc; c++) {
        let s = 0;
        for (let k = 0; k < ac; k++) s += a[r][k] * b[k][c];
        out[r][c] = s;
      }
    return out;
  }
  function matDet2(a) {
    return a[0][0] * a[1][1] - a[0][1] * a[1][0];
  }
  function matDet3(a) {
    return (
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
    );
  }

  /* -------------------------------------------------------------------------
   * NUMBER BASE SANITY TESTS
   *   Quick sanity sweep over the programmer-mode base conversion logic.
   *   Run via `CalcPro.selfTest()` or automatically on load via the
   *   query-string flag `?calcpro-selftest=1`.
   * ---------------------------------------------------------------------- */
  function baseSanity() {
    const cases = [
      { dec: "0",   hex: "0",     bin: "0" },
      { dec: "1",   hex: "1",     bin: "1" },
      { dec: "15",  hex: "F",     bin: "1111" },
      { dec: "16",  hex: "10",    bin: "10000" },
      { dec: "255", hex: "FF",    bin: "11111111" },
      { dec: "256", hex: "100",   bin: "100000000" },
      { dec: "1023",hex: "3FF",   bin: "1111111111" },
    ];
    let ok = 0;
    for (const c of cases) {
      const u = parseBase(c.dec, "DEC");
      const hex = formatBase(u, "HEX", 64).replace(/\s+/g, "");
      const bin = formatBase(u, "BIN", 64).replace(/\s+/g, "").replace(/^0+/, "") || "0";
      if (hex === c.hex && bin === c.bin) ok++;
      else console.warn("[CalcPro baseSanity]", c, "got", { hex, bin });
    }
    return ok === cases.length;
  }

  /* -------------------------------------------------------------------------
   * EXPOSE EXTRA HELPERS
   * ---------------------------------------------------------------------- */
  Object.assign(window.CalcPro, {
    // fractions
    makeFraction, fracAdd, fracSub, fracMul, fracDiv,
    fracToString, fracToNumber, numberToFraction,
    // matrices
    matZeros, matIdentity, matTranspose, matAdd, matMul, matDet2, matDet3,
    // sanity
    baseSanity,
  });

  /* -------------------------------------------------------------------------
   * DIAGNOSTICS EVENT
   *   Fire a custom window event so other parts of WebOS (taskbar badges,
   *   developer console, etc.) can know when CalcPro has been loaded and
   *   is ready to accept programmatic calls.
   * ---------------------------------------------------------------------- */
  try {
    window.dispatchEvent(new CustomEvent("webos:calcpro-ready", {
      detail: { version: "1.0.0", modes: 5, currencies: Object.keys(CURRENCIES).length }
    }));
  } catch (_) { /* Older browsers without CustomEvent support */ }

  // Optional self-test via query string
  try {
    if (typeof location !== "undefined" && /[?&]calcpro-selftest=1/.test(location.search)) {
      setTimeout(() => { selfTest(); baseSanity(); }, 250);
    }
  } catch (_) {}

})();

