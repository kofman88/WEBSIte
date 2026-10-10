/* CHM BREAKER — web app (static SPA, no build step).
 *
 * Port of the Telegram Mini App (miniapp/static/app.js): the same screens and
 * texts, but the Telegram glue is gone — the site JWT is the session
 * (localStorage/sessionStorage chm_access + chm_refresh, one refresh on 401,
 * then an in-app login screen), back navigation is the browser history and
 * the API base is /api/app/* (the Mini App routes one-to-one, see
 * miniapp/API.md). `?demo=1|pro|empty` keeps the built-in mock backend for
 * design previews without a backend.
 *
 * Security: every string that comes from the API is inserted with textContent
 * (via the h() helper). innerHTML is only used for constant SVG icon markup.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------
  var QS = new URLSearchParams(location.search);
  var DEMO = /^(1|pro|empty)$/.test(QS.get("demo") || "");   // design preview on the built-in mock, no backend
  var API_BASE = "/api/app/";     // the Mini App routes one-to-one (miniapp/API.md)
  var AUTH_BASE = "/api/auth/";   // site auth: login / register / refresh / 2fa / oauth
  // TODO(pricing): point at /pricing once the site checkout page exists.
  var CHECKOUT_URL = "/subscriptions.html";
  var ACCOUNT_URL = "/settings.html";   // «Аккаунт и безопасность»: пароль, 2FA, сессии, Telegram, push
  // ?next=<site path>: the page a legacy screen sent a visitor without a session from
  // (frontend/app.js requireAuth, ops.js) — after sign-in the app returns there instead of opening
  // itself. Same origin only, and only an exact path of this list: an absolute URL, //host, a
  // backslash, javascript: or anything else is ignored (the app opens as usual).
  var NEXT_PATHS = ["/settings.html", "/subscriptions.html", "/ops.html", "/admin.html"];
  function safeNext(raw) {
    if (typeof raw !== "string" || !raw || raw.length > 64) return "";
    if (raw.charAt(0) !== "/" || raw.charAt(1) === "/" || /[\\\s:%?#@]/.test(raw)) return "";
    return NEXT_PATHS.indexOf(raw) >= 0 ? raw : "";
  }
  var NEXT = DEMO ? "" : safeNext(QS.get("next"));
  var FX = window.CHMFX || null;   // splash.js: sound + haptics with a persisted on/off pref

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = String(v);
        else if (k === "style") el.style.cssText = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    for (var i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }
  function $(sel) { return document.querySelector(sel); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // Constant (trusted) SVG markup only.
  var ICONS = {
    lock: '<svg class="ico lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    tg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M7.5 12.2l8.2-3.6-1.6 7.8-2.9-2.1-1.6 1.5.2-2.6 3.6-3.4"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13.5 2.5L5.5 13.5h6l-1.5 8 8-11h-6l1.5-8z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M16.2 16.2L21 21"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="M7 15V9M12 15V5M17 15v-4"/></svg>',
    none: '<svg class="ico none-art" viewBox="0 0 72 72"><rect x="8" y="8" width="56" height="56" rx="4" stroke-dasharray="3 4"/><path d="M18 46l10-10 8 6 16-18" stroke-opacity=".45"/><path d="M26 58h20" /><circle cx="36" cy="36" r="2.5" fill="currentColor"/></svg>',
    // Strategy pictograms
    LEVELS: '<svg viewBox="0 0 64 46" fill="none"><path d="M2 11h60" stroke="#ff2a4d" stroke-width="1.2" stroke-dasharray="3 3"/><path d="M2 35h60" stroke="#3df2a0" stroke-width="1.2" stroke-dasharray="3 3"/><path d="M3 30l7-14 6 13 7-17 6 18 7-15 6 6 8-20 9 9" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="49" cy="7" r="2.4" fill="#ff2a4d"/></svg>',
    SMC: '<svg viewBox="0 0 64 46" fill="none"><rect x="6" y="27" width="20" height="10" fill="rgba(61,242,160,.18)" stroke="#3df2a0" stroke-width="1"/><rect x="36" y="7" width="22" height="9" fill="rgba(255,42,77,.18)" stroke="#ff2a4d" stroke-width="1"/><path d="M10 25v-6M16 34V20M22 30v-9M30 26V14M36 22V10M42 18V6M48 22v-7M54 28V16" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/><path d="M4 42h56" stroke="rgba(255,255,255,.25)"/></svg>',
    VOLUME: '<svg viewBox="0 0 64 46" fill="none"><path d="M6 44V34M13 44V30M20 44V36M27 44V24M34 44V32M41 44V20M48 44V28M55 44V16" stroke="rgba(255,255,255,.55)" stroke-width="3.2"/><path d="M3 26C14 26 18 14 30 14s16 8 31-10" stroke="#ff2a4d" stroke-width="1.6" stroke-linecap="round"/><path d="M3 32c12 0 18-8 30-8s18 2 28-10" stroke="#a855f7" stroke-width="1.2" stroke-linecap="round" stroke-dasharray="2 2"/></svg>',
    // Promo banner art: glowing candles + bolt
    PROMO: '<svg viewBox="0 0 120 120" fill="none"><defs><linearGradient id="pg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#e9d5ff" stop-opacity=".55"/></linearGradient><linearGradient id="pg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5c7a"/><stop offset="1" stop-color="#e8193c"/></linearGradient><filter id="pgl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs><g opacity=".9"><path d="M14 88v22M30 70v40M46 78v30M62 50v52M78 58v44M94 30v60" stroke="rgba(255,255,255,.55)" stroke-width="1.3"/><rect x="9" y="92" width="10" height="14" rx="1" fill="url(#pg1)" opacity=".5"/><rect x="25" y="76" width="10" height="26" rx="1" fill="url(#pg1)" opacity=".62"/><rect x="41" y="84" width="10" height="16" rx="1" fill="rgba(30,0,60,.55)" stroke="#fff" stroke-opacity=".6"/><rect x="57" y="58" width="10" height="34" rx="1" fill="url(#pg1)" opacity=".8"/><rect x="73" y="66" width="10" height="26" rx="1" fill="rgba(30,0,60,.55)" stroke="#fff" stroke-opacity=".6"/><rect x="89" y="36" width="10" height="44" rx="1" fill="url(#pg1)"/></g><path d="M8 98L30 80l16 6 16-26 16 8 22-36" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" filter="url(#pgl)" opacity=".7"/><path d="M8 98L30 80l16 6 16-26 16 8 22-36" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M100 26l8-2-1 8" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><g transform="translate(64 2) rotate(8)"><path d="M18 0L4 24h11l-4 20 17-28H17L21 0z" fill="url(#pg2)" filter="url(#pgl)" opacity=".8"/><path d="M18 0L4 24h11l-4 20 17-28H17L21 0z" fill="url(#pg2)" stroke="#fff" stroke-width=".8"/></g></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/></svg>',
    dna: '<svg viewBox="0 0 24 24"><path d="M7 3c0 5 10 6 10 9s-10 4-10 9"/><path d="M17 3c0 5-10 6-10 9s10 4 10 9"/><path d="M8.5 6.5h7M8.5 17.5h7M10 12h4"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5h4"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M18 12v3M15 12v2"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M12 4l8 4-8 4-8-4 8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/></svg>',
    bars: '<svg viewBox="0 0 24 24"><path d="M4 20h16"/><path d="M6 16v-5M10 16V6M14 16v-8M18 16v-3"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8L12 3.5z"/></svg>',
    help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7"/><path d="M12 17h.01"/></svg>',
    msg: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4V5z"/><path d="M8 9h8M8 12h5"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5h10"/></svg>',
    sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l4 3.5v-11L7 10H4z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3l9-16z"/><path d="M12 10v4M12 17h.01"/></svg>',
    ton: '<svg viewBox="0 0 24 24"><path d="M5 5h14l-7 15L5 5z"/><path d="M12 5v15"/></svg>'
  };
  function icon(name) {
    var t = document.createElement("template");
    t.innerHTML = ICONS[name];
    return t.content.firstChild;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function num(x) { if (x === null || x === undefined || x === "") return null; var n = Number(x); return isFinite(n) ? n : null; }
  function priceDecimals(p) {
    var a = Math.abs(p);
    if (a >= 1000) return 2;
    if (a >= 100) return 3;
    if (a >= 1) return 4;
    if (a === 0) return 2;
    return Math.min(12, Math.ceil(-Math.log10(a)) + 3); // 4 significant digits
  }
  function fmtPrice(x) {
    var p = num(x);
    if (p === null) return "—";
    return p.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: priceDecimals(p) });
  }
  function sign(n) { return n > 0 ? "+" : n < 0 ? "−" : ""; }
  function fmtPct(x, digits) {
    var p = num(x);
    if (p === null) return "—";
    return sign(p) + Math.abs(p).toFixed(digits == null ? 2 : digits) + "%";
  }
  function fmtR(x, digits) {
    var r = num(x);
    if (r === null) return "—";
    var d = digits == null ? 1 : digits;
    if (Math.abs(r) < Math.pow(10, -d) / 2) return "0R";
    return sign(r) + Math.abs(r).toFixed(d) + "R";
  }
  function signCls(x) { var n = num(x); return n === null ? "muted" : n > 0 ? "up" : n < 0 ? "down" : "muted"; }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtDate(ts) {
    var t = num(ts); if (!t) return "—";
    var d = new Date(t * 1000);
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear();
  }
  function fmtDateTime(ts) {
    var t = num(ts); if (!t) return "—";
    var d = new Date(t * 1000);
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function ago(ts) {
    var t = num(ts); if (!t) return "";
    var sec = Math.max(0, Date.now() / 1000 - t);
    if (sec < 60) return "только что";
    if (sec < 3600) return Math.floor(sec / 60) + " мин назад";
    if (sec < 86400) return Math.floor(sec / 3600) + " ч назад";
    return Math.floor(sec / 86400) + " д назад";
  }
  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  function daysLeft(ts) {
    var t = num(ts); if (!t) return null;
    return Math.max(0, Math.ceil((t - Date.now() / 1000) / 86400));
  }
  // [STATS-HONEST] реальное окно статистики: данных меньше, чем days → «с 6 окт» (по first_ts)
  var MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  function statWindow(st, short) {
    var days = num(st && st.days) || 30, ft = num(st && st.first_ts);
    if (ft && Math.ceil((Date.now() / 1000 - ft) / 86400) < days) {
      var d = new Date(ft * 1000);
      return "с " + d.getDate() + " " + MONTHS_SHORT[d.getMonth()];
    }
    return short ? days + "д" : "за " + days + " дн.";
  }
  // [STATS-HONEST] честные поля aggregate с откатом на старые (старый бэкенд)
  function pick(o, k, fb) { return o && o[k] !== undefined && o[k] !== null ? o[k] : (o ? o[fb] : undefined); }
  function pctFrom(base, v) {
    var b = num(base), x = num(v);
    if (!b || x === null) return null;
    return (x - b) / b * 100;
  }
  function isLong(sig) { return String(sig.direction || "").toUpperCase() === "LONG"; }
  function pairOf(sig) { return sig.pair || ((sig.symbol || "?") + "/USDT"); }
  function statusKey(sig) { return String(sig.status || "").toLowerCase(); }
  // [STATS-HONEST] sig.final — итог окончательный (закрытая на бирже / вручную TP1-TP2 уже не «в работе»)
  function isLive(sig) { if (sig && sig.final === true) return false; var st = statusKey(sig); return st === "open" || st === "tp1" || st === "tp2"; }
  function rOf(sig, level) {
    // [R-FROM-ORIGINAL-SL] риск = расстояние до исходного стопа (sl0); текущий sl после БУ равен входу
    var e = num(sig.entry), sl = num(sig.sl0) || num(sig.sl), l = num(level);
    if (e === null || sl === null || l === null || !l) return null;
    var risk = Math.abs(e - sl);
    if (!risk) return null;
    return (isLong(sig) ? l - e : e - l) / risk;
  }
  // R the trade is worth now (live) or finished with (closed). null = unknown.
  function finalR(sig) {
    var rr = num(sig.rr);
    if (rr !== null) return rr;
    var st = statusKey(sig);
    if (st === "sl") return -1;
    if (st === "be") return 0;
    if (/^tp[123]$/.test(st)) return rOf(sig, sig[st]);
    return null;
  }
  function liveR(sig) {
    var rn = num(sig.r_now);
    if (rn !== null) return rn;
    if (num(sig.price) !== null) return rOf(sig, sig.price);
    return null;
  }
  function curR(sig) { return isLive(sig) ? liveR(sig) : finalR(sig); }

  // ---------------------------------------------------------------------------
  // Domain meta
  // ---------------------------------------------------------------------------
  var STRATS = {
    LEVELS: { n: "01", name: "Уровни", full: "Уровни", desc: "Отскоки и пробои уровней поддержки/сопротивления" },
    SMC: { n: "02", name: "SMC", full: "Smart Money", desc: "Order blocks, FVG, сбор ликвидности" },
    VOLUME: { n: "03", name: "Объём + MA", full: "Объём + MA", desc: "MA cross, отскок от EMA200, объём" }
  };
  var STRAT_ORDER = ["LEVELS", "SMC", "VOLUME"];
  var PARALLEL_NOTE = "Сигналы идут со всех включённых стратегий; одна монета в одну сторону — один сигнал.";
  function stratName(k) { return (STRATS[k] && STRATS[k].name) || String(k || "—"); }

  var STATUS = {
    open: { t: "Открыт", c: "open" },
    tp1: { t: "TP1 ✓", c: "win" },
    tp2: { t: "TP2 ✓", c: "win" },
    tp3: { t: "TP3 ✓", c: "win" },
    sl: { t: "SL", c: "loss" },
    be: { t: "БУ", c: "be" },
    closed: { t: "Закрыт", c: "be" },
    skip: { t: "Пропуск", c: "be" },
    expired: { t: "⏱ По времени", c: "be" },
    missed: { t: "⛔ Без входа", c: "be" }
  };
  function statusOf(sig) { return STATUS[statusKey(sig)] || { t: String(sig.status || "—").toUpperCase(), c: "be" }; }
  function stageOf(sig) {
    var st = statusKey(sig);
    return st === "tp3" ? 3 : st === "tp2" ? 2 : (st === "tp1" || st === "be") ? 1 : 0;
  }
  var FINAL_WORD = { tp3: "TP3 взят", sl: "Стоп", be: "Безубыток", closed: "Закрыт", skip: "Пропущен", expired: "Закрыт по времени (72ч)", missed: "Не входить — ушла без отката" };
  var TREND_TF = ["H1", "H4", "D1", "W1"];
  var TREND_WORD = { up: "вверх", down: "вниз", flat: "флэт", unknown: "нет данных" };

  var ERRORS = {
    already_set: "Итог уже зафиксирован — изменить нельзя.",
    exchange_trade: "Сделка на бирже — итог приходит с биржи.",
    rate_limited: "Слишком много запросов. Подождите минуту и попробуйте снова.",
    bad_symbol: "Монета не найдена. Проверьте тикер — например, BTC или ETH.",
    timeout: "Сервер отвечает слишком долго. Попробуйте ещё раз.",
    pro_required: "Доступно в Pro",
    already_active: "Челлендж уже идёт — завершите текущий.",
    // QUIRK(ui-inventory §10.1): the bot's table had `bad_request` twice and the later
    // key ("Недопустимое значение.") won; the dead "Проверьте значения в анкете." is dropped.
    both_dirs: "LONG и SHORT одновременно — доступно в Pro",
    unauthorized: "Сессия истекла. Войдите снова.",
    network: "Нет связи с сервером. Проверьте интернет.",
    no_data: "График пока недоступен.",
    not_found: "Не найдено.",
    nothing_to_change: "Нечего сохранять.",
    bad_strategy: "Неизвестная стратегия.",
    genome_not_ready: "Геном ещё не готов — эволюция продолжается.",
    genome_unavailable: "Геном временно недоступен.",
    invalid_keys: "Ключи не прошли проверку. Проверьте API key, secret и права на фьючерсы.",
    unavailable: "Раздел временно недоступен. Попробуйте позже.",
    bad_request: "Недопустимое значение."
  };
  function errText(code) { return ERRORS[code] || "Что-то пошло не так. Попробуйте позже."; }

  // ---------------------------------------------------------------------------
  // Web glue (replaces the Telegram WebApp glue)
  // ---------------------------------------------------------------------------
  function hap(kind) {
    if (!FX) return;
    try { FX.hap(kind); } catch (e) { /* no haptics */ }
  }
  // «Оформить Pro» → the site checkout page (was: t.me/<bot>?start=subscribe).
  function openCheckout() {
    hap("medium");
    location.href = CHECKOUT_URL;
  }
  function openExternal(url) {
    hap("medium");
    try { window.open(url, "_blank", "noopener"); } catch (e) { toast("Не удалось открыть ссылку", true); }
  }

  // Back navigation = browser history. The signal detail and every settings
  // sub-screen push a history entry; popstate re-applies the recorded screen;
  // the in-page «Назад» buttons call history.back() whenever there is an entry
  // of ours to go back to (deep links start with none → step back in place).
  var NAV = { depth: 0, applying: false };
  function navState() {
    if (IB.open) return { chm: "inbox", tab: S.tab, sub: S.sub, d: NAV.depth };
    if (S.detail) return { chm: "detail", id: S.detail.id, tab: S.tab, sub: S.sub, d: NAV.depth };
    if (S.sub) return { chm: "sub", sub: S.sub, d: NAV.depth };
    return { chm: "tab", tab: S.tab, d: NAV.depth };
  }
  function navPush() {
    if (NAV.applying) return;
    NAV.depth++;
    try { history.pushState(navState(), ""); } catch (e) { /* file:// etc. */ }
  }
  function navReplace() {
    if (NAV.applying) return;
    try { history.replaceState(navState(), ""); } catch (e) { /* ignore */ }
  }
  function syncTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute("data-tab") === S.tab;
      tabs[i].classList.toggle("is-active", on);
      if (on) tabs[i].setAttribute("aria-current", "page"); else tabs[i].removeAttribute("aria-current");
    }
  }
  // Apply a history entry (popstate): open/close the detail, enter/leave a sub-screen.
  function applyNav(st) {
    if (S.auth) return;   // the login screen owns the view
    NAV.applying = true;
    try {
      st = st && st.chm ? st : { chm: "tab", tab: S.tab, d: 0 };
      NAV.depth = num(st.d) || 0;
      if (st.chm === "inbox") { if (!IB.open) openInbox(true); return; }
      if (IB.open) { closeInbox(true); render(); }
      if (st.chm === "detail") {
        var sig = S.sigById[st.id];
        if (sig) { if (st.sub) { S.tab = "profile"; S.sub = st.sub; syncTabs(); } openDetail(sig); return; }
        st = { chm: "tab", tab: S.tab };
      }
      var hadDetail = !!S.detail;
      if (hadDetail) closeDetail(true);
      if (st.chm === "sub") { S.tab = "profile"; S.sub = st.sub; syncTabs(); render(); window.scrollTo(0, 0); return; }
      if (st.tab && /^(home|signals|analyze|profile)$/.test(st.tab)) S.tab = st.tab;
      S.sub = null; syncTabs(); render();
      window.scrollTo(0, hadDetail ? S.savedScroll : 0);
    } finally { NAV.applying = false; }
  }
  function goBack() {
    if (NAV.depth > 0) { hap("light"); history.back(); return; }
    if (IB.open) { closeInbox(); navReplace(); return; }
    // Deep link (no history entry of ours yet): step back in place.
    if (S.detail) { closeDetail(); navReplace(); return; }
    if (S.sub && S.sub !== "settings") { openSub("settings", true); return; }
    if (S.sub) { hap("light"); S.sub = null; render(); window.scrollTo(0, 0); navReplace(); }
  }
  // «Направления L / S — в профиле»: leave the settings area for the Profile root.
  function leaveSub() { hap("light"); S.sub = null; NAV.depth = 0; render(); window.scrollTo(0, 0); navReplace(); }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  function ApiError(code) { this.code = code; this.message = code; }
  ApiError.prototype = Object.create(Error.prototype);

  // Site session: the same keys and «remember me» semantics as the site's
  // frontend/app.js Auth helper (chm_access / chm_refresh / chm_user in
  // localStorage, or sessionStorage when chm_session_only=1; an admin
  // impersonation token in sessionStorage.chm_imp_access wins and never refreshes).
  var Auth = {
    _store: function () {
      try { if (sessionStorage.getItem("chm_session_only") === "1") return sessionStorage; } catch (e) { /* private mode */ }
      return localStorage;
    },
    setRemember: function (persist) {
      try { if (persist) sessionStorage.removeItem("chm_session_only"); else sessionStorage.setItem("chm_session_only", "1"); } catch (e) { /* ignore */ }
    },
    access: function () {
      try { return sessionStorage.getItem("chm_imp_access") || localStorage.getItem("chm_access") || sessionStorage.getItem("chm_access") || ""; } catch (e) { return ""; }
    },
    refresh: function () {
      try {
        if (sessionStorage.getItem("chm_imp_access")) return "";
        return localStorage.getItem("chm_refresh") || sessionStorage.getItem("chm_refresh") || "";
      } catch (e) { return ""; }
    },
    setTokens: function (access, refresh) {
      var store = this._store(), other = store === localStorage ? sessionStorage : localStorage;
      try { other.removeItem("chm_access"); other.removeItem("chm_refresh"); } catch (e) { /* ignore */ }
      try {
        if (access) store.setItem("chm_access", access);
        if (refresh) store.setItem("chm_refresh", refresh);
      } catch (e) { /* ignore */ }
    },
    setUser: function (u) {
      var store = this._store(), other = store === localStorage ? sessionStorage : localStorage;
      try { other.removeItem("chm_user"); } catch (e) { /* ignore */ }
      try { store.setItem("chm_user", JSON.stringify(u)); } catch (e) { /* ignore */ }
    },
    clear: function () {
      try {
        ["chm_access", "chm_refresh", "chm_user"].forEach(function (k) { localStorage.removeItem(k); sessionStorage.removeItem(k); });
        sessionStorage.removeItem("chm_session_only");
      } catch (e) { /* ignore */ }
    }
  };
  // One refresh in flight at a time; every 401 waits for the same promise.
  var refreshing = null;
  function tryRefresh() {
    if (refreshing) return refreshing;
    var rt = Auth.refresh();
    if (!rt) return Promise.resolve(false);
    refreshing = fetch(AUTH_BASE + "refresh", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ refreshToken: rt }), credentials: "same-origin", cache: "no-store"
    }).then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d || !d.accessToken) return false;
        Auth.setTokens(d.accessToken, d.refreshToken);
        if (d.user) Auth.setUser(d.user);
        return true;
      })
      .catch(function () { return false; })
      .then(function (ok) { refreshing = null; return ok; });
    return refreshing;
  }
  // Final 401 → the in-app login screen (not a fatal screen).
  function unauthorized() {
    Auth.clear();
    showLogin(errText("unauthorized"));
    return new ApiError("unauthorized");
  }

  function api(path, opts, retried) {
    opts = opts || {};
    if (DEMO) return Mock.handle(path, opts);
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 20000) : null;
    var headers = { "Accept": "application/json" };
    var tok = Auth.access();
    if (tok) headers["Authorization"] = "Bearer " + tok;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch((opts.base || API_BASE) + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.status === 401) {
          if (retried) throw unauthorized();
          return tryRefresh().then(function (ok) {
            if (ok) return api(path, opts, true);
            throw unauthorized();
          });
        }
        // HTTP 403 from the site's auth middleware (ACCOUNT_DISABLED) arrives in the Mini App
        // envelope as `unauthorized`; no refresh can fix it → the login screen with the reason.
        if (res.status === 403 && data && data.error === "unauthorized") {
          Auth.clear();
          showLogin(data.code === "ACCOUNT_DISABLED" ? AUTH_ERRORS.ACCOUNT_DISABLED : errText("unauthorized"));
          throw new ApiError("unauthorized");
        }
        if (!data) throw new ApiError(res.status === 429 ? "rate_limited" : res.status === 504 ? "timeout" : res.status === 404 ? "not_found" : "network");
        return data;
      });
    }, function (err) {
      throw new ApiError(err && err.name === "AbortError" ? "timeout" : "network");
    }).finally(function () { if (timer) clearTimeout(timer); });
  }
  function okOrThrow(d) {
    if (!d || !d.ok) throw new ApiError((d && d.error) || "network");
    return d;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var S = {
    me: null,
    dash: null,
    dashAt: 0,
    tab: "home",
    sigFilter: "all",
    sigStrat: "ALL",
    sigs: {},          // filter -> {list, at}
    sigLoading: false,
    an: { symbol: "", strategy: "AUTO", loading: false, startedAt: 0, result: null, error: null },
    detail: null,      // open signal
    savedScroll: 0,
    busyToggle: false,
    busyPref: false,
    busyTrade: false,
    busyGenome: false,
    genome: null,      // null = not loaded, {hidden:true} = endpoint unavailable
    genomeLoading: false,
    sub: null,         // settings sub-screen inside the Profile tab: "settings" | section id
    sec: {},           // section caches: key -> {loading, data, err, at}
    saving: 0,
    auth: null,           // login screen state (null = session ok / demo)
    sigById: {},          // signals seen so far (restores the detail overlay from history)
    exForm: null,      // exchange whose key form is open
    exBusy: false,
    exRemoveArm: null,
    statsDays: 30,
    statsStrat: "",
    fb: { type: "idea", text: "", sent: null, busy: false }
  };

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------
  var view = $("#view");
  var detailEl = $("#detail");
  var toastTimer = null;

  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 3200 : 2200);
  }

  function setPlanBadge() {
    var b = $("#plan-badge");
    var u = S.me && S.me.user;
    if (!u) { b.textContent = "···"; return; }
    b.textContent = u.is_pro ? "PRO" : "FREE";
    b.className = "badge badge-plan " + (u.is_pro ? "is-pro" : "is-free");
    $("#demo-badge").hidden = !DEMO;
  }

  function setTab(tab, opts) {
    if (S.detail) closeDetail(true);
    if (IB.open) closeInbox(true);
    if (S.tab !== tab || S.sub) hap("select");
    S.tab = tab;
    S.sub = null;
    syncTabs();
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);
    render();
    NAV.depth = 0; navReplace();   // tabs are top-level: the current history entry becomes this tab
  }

  function render() {
    if (S.auth) { renderLogin(); return; }   // the login screen is sticky until the session is back
    clear(view);
    var screen;
    if (S.tab === "home") screen = renderHome();
    else if (S.tab === "signals") screen = renderSignals();
    else if (S.tab === "analyze") screen = renderAnalyze();
    else if (S.sub) screen = renderSub();
    else screen = renderProfile();
    view.appendChild(screen);
  }
  // Re-render the current tab without jumping (after async loads / toggles).
  function rerender(tab) {
    if (S.detail || (tab && S.tab !== tab)) return;
    var y = window.scrollY;
    render();
    view.firstChild && view.firstChild.classList.add("no-anim");
    window.scrollTo(0, y);
  }

  // ---------------------------------------------------------------------------
  // LOGIN — the site JWT session (replaces the Telegram «Нет доступа» screen)
  //   email + password (POST /api/auth/login, 2FA step when the server asks),
  //   «Зарегистрироваться» (POST /api/auth/register), «Войти через Telegram»
  //   (Telegram Login Widget popup → POST /api/auth/oauth/telegram), remember-me.
  // ---------------------------------------------------------------------------
  var providers = null;   // GET /api/auth/oauth/providers → { telegram: { enabled, username }, google: {…} }
  var AUTH_ERRORS = {
    INVALID_CREDENTIALS: "Неверный email или пароль.",
    ACCOUNT_DISABLED: "Аккаунт заблокирован. Напишите в поддержку.",
    EMAIL_EXISTS: "Этот email уже зарегистрирован — войдите.",
    EMAIL_NOT_VERIFIED: "Подтвердите email по ссылке из письма.",
    INVALID_2FA: "Неверный код. Попробуйте ещё раз.",
    VALIDATION_ERROR: "Проверьте email и пароль: минимум 8 символов, буквы и цифры.",
    RATE_LIMITED: "Слишком много попыток. Подождите минуту и попробуйте снова.",
    GEO_BLOCKED: "Регистрация недоступна в вашем регионе.",
    OAUTH_DISABLED: "Вход через Telegram не настроен на сервере.",
    INVALID_SIGNATURE: "Не удалось подтвердить вход через Telegram.",
    INVALID_PAYLOAD: "Не удалось подтвердить вход через Telegram.",
    EXPIRED: "Подтверждение Telegram устарело — попробуйте снова.",
    TIMEOUT: "Сервер отвечает слишком долго. Попробуйте ещё раз.",
    NETWORK: "Нет связи с сервером. Проверьте интернет."
  };
  function authErrText(e) {
    if (e && e.code && AUTH_ERRORS[e.code]) return AUTH_ERRORS[e.code];
    if (e && e.status === 429) return AUTH_ERRORS.RATE_LIMITED;
    if (e && e.status === 401) return AUTH_ERRORS.INVALID_CREDENTIALS;
    if (e && e.status === 400) return AUTH_ERRORS.VALIDATION_ERROR;
    return "Не удалось войти. Попробуйте позже.";
  }
  // POST /api/auth/<path>; resolves the JSON body, rejects with {status, code}.
  function authCall(path, body) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    return fetch(AUTH_BASE + path, {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body || {}), credentials: "same-origin", cache: "no-store", signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok) {
          var e = new Error((d && (d.error || d.message)) || ("HTTP " + res.status));
          e.status = res.status;
          e.code = (d && d.code) || (res.status === 429 ? "RATE_LIMITED" : "");
          throw e;
        }
        return d || {};
      });
    }, function (err) {
      var e = new Error("network");
      e.code = err && err.name === "AbortError" ? "TIMEOUT" : "NETWORK";
      throw e;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }
  function resetState() {
    Live.stop();
    if (S.detail) closeDetail(true);
    if (IB.open) closeInbox(true);
    IB.list = []; IB.answers = {};
    S.me = null; S.dash = null; S.dashAt = 0; S.dashLoading = false;
    S.sigs = {}; S.sec = {}; S.genome = null; S.sigById = {}; S.sub = null;
    S.an = { symbol: "", strategy: "AUTO", loading: false, startedAt: 0, result: null, error: null };
    S.fb = { type: "idea", text: "", sent: null, busy: false };
    S.exForm = null; S.exRemoveArm = null;
    chForm = null;
    NAV.depth = 0;
    setUnread(0);
  }
  function showLogin(notice) {
    if (!S.auth) S.auth = { mode: "login", busy: false, pending: null, remember: true, email: "", err: null, notice: null };
    if (notice) S.auth.notice = notice;
    resetState();
    setPlanBadge();
    renderLogin();
    if (providers === null) loadProviders();
  }
  function loadProviders() {
    providers = {};
    fetch(AUTH_BASE + "oauth/providers", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { providers = d && typeof d === "object" ? d : {}; })
      .catch(function () { providers = {}; })
      .then(function () {
        // Swap only the buttons under the form: a full re-render would wipe what the user is typing.
        var old = document.getElementById("login-alt");
        if (S.auth && old && old.parentNode) old.parentNode.replaceChild(loginAlt(S.auth), old);
      });
  }
  function loginAlt(a) {
    var alt = h("div", { class: "stack", id: "login-alt" });
    if (a.mode === "login") {
      alt.appendChild(h("button", { class: "btn btn-dark btn-block", type: "button", onclick: function () { hap("light"); a.mode = "register"; a.err = null; renderLogin(); } }, "Зарегистрироваться"));
      var tgp = providers && providers.telegram;
      if (tgp && tgp.enabled && tgp.username) {
        alt.appendChild(h("button", { class: "btn btn-dark btn-block", type: "button", disabled: a.busy ? true : null, onclick: function () { loginWithTelegram(tgp.username); } }, "Войти через Telegram", icon("tg")));
      }
      alt.appendChild(h("a", { class: "login-link", href: "/?login=1", text: "Забыли пароль? Восстановить на сайте" }));
    } else {
      alt.appendChild(h("button", { class: "btn btn-dark btn-block", type: "button", onclick: function () { hap("light"); a.mode = "login"; a.err = null; a.pending = null; renderLogin(); } },
        a.mode === "2fa" ? "Назад" : "У меня есть аккаунт — войти"));
    }
    return alt;
  }
  function renderLogin() {
    var a = S.auth;
    if (!a) return;
    var typed = view.querySelector("form.login-form input[name=email]");
    if (typed && typed.value) a.email = String(typed.value).trim();
    if (S.detail) closeDetail(true);
    view.hidden = false; detailEl.hidden = true;
    $("#tabbar").hidden = true;
    clear(view);
    var root = h("div", { class: "screen login" });
    root.appendChild(h("div", { class: "login-mark", "aria-hidden": "true" },
      s("svg", { viewBox: "0 0 24 24", class: "brand-mark" }, s("path", { d: "M13.5 2L5 13.5h6L9.5 22 19 9.5h-6.2L13.5 2z" }))));
    root.appendChild(heading(a.mode === "register" ? "Регистрация" : a.mode === "2fa" ? "Код подтверждения" : "Вход", "center"));
    root.appendChild(h("p", { class: "desc center", text: a.mode === "register"
      ? "Создайте аккаунт — сигналы, статистика и настройки будут доступны здесь и на сайте."
      : a.mode === "2fa" ? "Введите код из приложения-аутентификатора." : "Войдите в аккаунт сайта, чтобы открыть приложение." }));
    var form = h("form", { class: "card pad login-form", novalidate: true, autocomplete: "on" });
    var email = null, pass = null, code = null;
    if (a.mode === "2fa") {
      code = h("input", { class: "inp", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "16", placeholder: "000000", "aria-label": "Код подтверждения" });
      form.appendChild(h("div", null, h("span", { class: "label inp-label", text: "[Код из приложения]" }), code));
    } else {
      email = h("input", { class: "inp", type: "email", name: "email", autocomplete: "email", autocapitalize: "off", spellcheck: "false", placeholder: "you@example.com", "aria-label": "Email", value: a.email || "" });
      pass = h("input", { class: "inp", type: "password", name: "password", autocomplete: a.mode === "register" ? "new-password" : "current-password",
        placeholder: a.mode === "register" ? "Минимум 8 символов, буквы и цифры" : "Пароль", "aria-label": "Пароль" });
      var pw = h("div", { class: "inp-wrap" }, pass,
        h("button", { class: "icon-btn", type: "button", "aria-label": "Показать", onclick: function () { hap("select"); pass.type = pass.type === "password" ? "text" : "password"; } }, icon("eye")));
      form.appendChild(h("div", null, h("span", { class: "label inp-label", text: "[Email]" }), email));
      form.appendChild(h("div", null, h("span", { class: "label inp-label", text: "[Пароль]" }), pw));
      if (a.mode === "login") {
        form.appendChild(toggleRow(["Запомнить меня"], "Оставаться в системе на этом устройстве",
          switchEl(a.remember, { aria: "Запомнить меня", onChange: function (v) { a.remember = v; } }), "dense"));
      }
    }
    if (a.err) form.appendChild(h("p", { class: "login-err", role: "alert", text: a.err }));
    else if (a.notice) form.appendChild(h("p", { class: "hint login-notice", text: a.notice }));
    var submitText = a.mode === "register" ? "Зарегистрироваться" : a.mode === "2fa" ? "Подтвердить" : "Войти";
    form.appendChild(h("button", { class: "btn btn-red btn-block", type: "submit", disabled: a.busy ? true : null }, a.busy ? "Секунду…" : submitText, icon("arrow")));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (a.busy) return;
      if (a.mode === "2fa") { submit2FA(String(code.value || "").trim()); return; }
      a.email = String(email.value || "").trim();
      var pwv = String(pass.value || "");
      if (!a.email || !pwv) { hap("error"); a.err = "Введите email и пароль."; renderLogin(); return; }
      if (a.mode === "register") submitRegister(a.email, pwv); else submitLogin(a.email, pwv);
    });
    root.appendChild(form);
    root.appendChild(loginAlt(a));
    view.appendChild(root);
    var focusEl = code || (a.email ? pass : email);
    if (focusEl && !a.busy) setTimeout(function () { try { focusEl.focus(); } catch (e) { /* ignore */ } }, 40);
  }
  function finishLogin(d) {
    var a = S.auth;
    if (!d || !d.accessToken) {
      if (a) { a.busy = false; a.err = "Не удалось войти. Попробуйте позже."; renderLogin(); }
      return;
    }
    Auth.setTokens(d.accessToken, d.refreshToken);
    if (d.user) Auth.setUser(d.user);
    if (NEXT) { location.replace(NEXT); return; }   // back to the page that sent the visitor here
    S.auth = null;
    hap("success");
    $("#tabbar").hidden = false;
    syncTabs();
    NAV.depth = 0; navReplace();
    render();
    loadCore();
  }
  function submitLogin(email, password) {
    var a = S.auth;
    a.busy = true; a.err = null; renderLogin(); hap("light");
    Auth.setRemember(a.remember);
    authCall("login", { email: email, password: password }).then(function (d) {
      if (d && d.twoFactorRequired) { a.pending = d.pendingToken; a.mode = "2fa"; a.busy = false; a.err = null; renderLogin(); return; }
      finishLogin(d);
    }).catch(function (e) { a.busy = false; a.err = authErrText(e); hap("error"); renderLogin(); });
  }
  function submit2FA(code) {
    var a = S.auth;
    if (!code) { hap("error"); a.err = "Введите код."; renderLogin(); return; }
    a.busy = true; a.err = null; renderLogin(); hap("light");
    authCall("2fa/verify-login", { pendingToken: a.pending, code: code }).then(finishLogin)
      .catch(function (e) { a.busy = false; a.err = authErrText(e); hap("error"); renderLogin(); });
  }
  function submitRegister(email, password) {
    var a = S.auth;
    a.busy = true; a.err = null; renderLogin(); hap("light");
    Auth.setRemember(true);
    authCall("register", { email: email, password: password }).then(finishLogin)
      .catch(function (e) { a.busy = false; a.err = authErrText(e); hap("error"); renderLogin(); });
  }
  function logout() {
    hap("light");
    if (DEMO) { location.href = location.pathname; return; }   // the demo has no session: leave the preview
    var rt = Auth.refresh();
    (rt ? authCall("logout", { refreshToken: rt }).catch(function () { /* already gone */ }) : Promise.resolve()).then(function () {
      Auth.clear();
      showLogin("Вы вышли из аккаунта.");
    });
  }
  // Telegram Login Widget without its third-party script: the official popup
  // (oauth.telegram.org) posts {event:"auth_result", result:{id, first_name,
  // username, photo_url, auth_date, hash}} to the opener; when popups are
  // blocked it falls back to a same-window redirect that returns with
  // #tgAuthResult=<base64 json>. Either way the payload goes to
  // POST /api/auth/oauth/telegram, which verifies the hash with the bot token.
  var tgPopup = null;
  function loginWithTelegram(username) {
    var a = S.auth;
    if (!a || a.busy) return;
    hap("medium");
    var bot = String(username).replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
    var url = "https://oauth.telegram.org/auth?bot_id=" + encodeURIComponent(bot) + "&origin=" + encodeURIComponent(location.origin) +
      "&embed=1&request_access=write&return_to=" + encodeURIComponent(location.origin + location.pathname);
    var w = 550, hh = 470;
    var left = Math.max(0, Math.round(((window.screen && window.screen.width) || w) / 2 - w / 2));
    var top = Math.max(0, Math.round(((window.screen && window.screen.height) || hh) / 2 - hh / 2));
    try { tgPopup = window.open(url, "tg_login", "width=" + w + ",height=" + hh + ",left=" + left + ",top=" + top); } catch (e) { tgPopup = null; }
    if (!tgPopup) { location.href = url; return; }
    a.err = null; a.notice = "Подтвердите вход в окне Telegram…";
    renderLogin();
  }
  function onTgMessage(ev) {
    if (!/^https:\/\/oauth\.telegram\.org$/.test(ev.origin || "")) return;
    var data = ev.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return; } }
    if (!data || data.event !== "auth_result" || !data.result || typeof data.result !== "object") return;
    try { if (tgPopup && !tgPopup.closed) tgPopup.close(); } catch (e) { /* ignore */ }
    finishTelegram(data.result);
  }
  function tgAuthFromHash() {
    var m = /[#&]tgAuthResult=([^&]+)/.exec(location.hash || "");
    if (!m) return null;
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ }
    try {
      var b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      b += new Array((4 - b.length % 4) % 4 + 1).join("=");
      var o = JSON.parse(atob(b));
      return o && typeof o === "object" && o.hash ? o : null;
    } catch (e) { return null; }
  }
  function finishTelegram(result) {
    if (!S.auth) showLogin();
    var a = S.auth;
    a.busy = true; a.err = null; a.notice = null; renderLogin();
    var body = {};
    ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"].forEach(function (k) { if (result[k] != null) body[k] = result[k]; });
    authCall("oauth/telegram", body).then(finishLogin)
      .catch(function (e) { a.busy = false; a.err = authErrText(e); hap("error"); renderLogin(); });
  }

  // ---------------------------------------------------------------------------
  // Shared components
  // ---------------------------------------------------------------------------
  function stars(q) {
    var n = Math.max(0, Math.min(5, Math.round(num(q) || 0)));
    var el = h("span", { class: "stars", title: "Качество " + n + "/5", "aria-label": "Качество " + n + " из 5" });
    for (var i = 0; i < 5; i++) el.appendChild(h("span", { class: i < n ? "" : "off", text: "★", "aria-hidden": "true" }));
    return el;
  }
  function dirBadge(sig) {
    var l = isLong(sig);
    return h("span", { class: "dir " + (l ? "long" : "short"), text: (l ? "▲ LONG" : "▼ SHORT") });
  }
  // [TREND-MONITOR] сигнал против тренда BTC — аккуратный чип в строке меты
  function ctBadge(sig) {
    if (!sig || !sig.counter_trend) return null;
    return h("span", { class: "ct", title: "Сигнал против тренда BTC 15m" }, h("i", { "aria-hidden": "true", text: "⚠" }), "против тренда");
  }
  // [MTF-ALIGNED] сигнал по тренду BTC сразу на 15m · 1H · 4H
  function mtfBadge(sig) {
    if (!sig || !sig.mtf_aligned || sig.counter_trend) return null;
    return h("span", { class: "mtf", title: "По тренду BTC на 15m, 1H и 4H" }, h("i", { "aria-hidden": "true", text: "🎯" }), "все ТФ");
  }
  var TREND_TFS = ["15m", "1H", "4H", "1D", "1W", "1M"];
  var TREND_TF_NAME = { "15m": "15M", "1H": "1H", "4H": "4H", "1D": "ДЕНЬ", "1W": "НЕДЕЛЯ", "1M": "МЕСЯЦ" };
  var TREND_W = { LONG: "ЛОНГ", SHORT: "ШОРТ", RANGE: "БОКОВИК" };
  function trendCls(t) { return t === "LONG" ? "long" : t === "SHORT" ? "short" : t === "RANGE" ? "flat" : "none"; }
  function agoShort(ts) {
    var t = num(ts); if (!t) return "";
    var sec = Math.max(0, Date.now() / 1000 - t);
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + " мин";
    if (sec < 86400) return Math.floor(sec / 3600) + " ч";
    return Math.floor(sec / 86400) + " д";
  }
  // Карточка «Тренд BTC»: приоритетная сторона + плитки 15m / 1H / 4H.
  function marketTrendStrip(compact) {
    var mt = (S.dash && S.dash.market_trend) || {};
    if (!TREND_TFS.some(function (tf) { return mt[tf] && mt[tf].trend; })) return null;
    var t15 = mt["15m"] && mt["15m"].trend;
    var cls = trendCls(t15);
    var card = h("div", { class: "card mtrend " + cls + (compact ? " compact" : ""), role: "group", "aria-label": "Тренд BTC" });
    // приоритет — по 15m (ТФ сигналов), старшие ТФ — контекст
    var prio = t15 === "LONG" ? ["▲", "лонги в приоритете · 15m"] : t15 === "SHORT" ? ["▼", "шорты в приоритете · 15m"] : t15 === "RANGE" ? ["↔", "боковик — без приоритета"] : ["·", "тренд считается"];
    // [TREND-ALIGNED] 15m · 1H · 4H в одну сторону — рынок выстроился
    var al = ["15m", "1H", "4H"].every(function (tf) { return mt[tf] && mt[tf].trend === t15; }) && (t15 === "LONG" || t15 === "SHORT");
    if (al) prio = [prio[0], "все ТФ в " + (t15 === "LONG" ? "лонг" : "шорт")];
    card.appendChild(h("div", { class: "mtrend-top" },
      h("span", { class: "mtrend-k" }, h("i", { class: "mtrend-dot", "aria-hidden": "true" }), "Тренд BTC"),
      h("span", { class: "mtrend-prio " + cls }, h("b", { "aria-hidden": "true", text: prio[0] }), prio[1])));
    var grid = h("div", { class: "mtrend-grid" });
    TREND_TFS.forEach(function (tf) {
      var st = mt[tf] || {};
      var t = st.trend || "";
      var c = trendCls(t);
      var tile = h("div", { class: "mtile " + c + (tf === "15m" ? " main" : ""), title: "BTC " + tf + (st.ema ? " · EMA " + st.ema : "") },
        h("span", { class: "mtile-tf" }, h("span", { text: TREND_TF_NAME[tf] || tf.toUpperCase() }), st.ema ? h("em", { text: st.ema }) : null),
        h("b", { class: "mtile-dir" }, t ? [h("i", { "aria-hidden": "true", text: t === "LONG" ? "▲" : t === "SHORT" ? "▼" : "↔" }), TREND_W[t] || t] : "—"));
      var since = agoShort(st.since);
      var strength = (st.strength != null && t) ? Math.max(0, Math.min(100, num(st.strength))) : null;
      // «уже 3 ч» без силы, «3 ч · 86%» с силой — иначе не влезает в плитку
      tile.appendChild(h("span", { class: "mtile-since", title: strength != null ? "Сила тренда (лента EMA): " + strength + "%" : null,
        text: t ? (strength != null ? (since ? since + " · " : "") + strength + "%" : (since ? "уже " + since : "")) : "нет данных" }));
      // [RIBBON-STRENGTH] полоска силы тренда (доля выстроенных EMA ленты)
      if (strength != null) tile.appendChild(h("i", { class: "mtile-bar", "aria-hidden": "true" }, h("b", { style: "width:" + strength + "%" })));
      grid.appendChild(tile);
    });
    card.appendChild(grid);
    return card;
  }
  function statusBadge(sig) {
    var st = statusOf(sig);
    return h("span", { class: "st " + st.c, text: st.t });
  }
  function label(text, cls) { return h("span", { class: "label" + (cls ? " " + cls : ""), text: text }); }
  function bracket(text) { return "[" + text + "]"; }
  function heading(text, cls) { return h("div", { class: "h1" + (cls ? " " + cls : ""), text: text }); }
  function sectionTitle(text, linkText, onLink) {
    return h("div", { class: "h2" },
      h("span", { text: text }),
      linkText ? h("button", { class: "link", type: "button", onclick: onLink, text: linkText }) : null);
  }
  function tag(text, cls) { return h("span", { class: "tag" + (cls ? " " + cls : ""), text: text }); }
  function rVal(x, cls) { return h("span", { class: "rv " + signCls(x) + (cls ? " " + cls : ""), text: fmtR(x) }); }
  function skeleton(hgt, extra) { return h("div", { class: "sk", style: "height:" + hgt + "px;" + (extra || "") }); }
  function emptyCard(title, text, btn) {
    return h("div", { class: "card empty" }, icon("none"), h("div", { class: "cond", text: title }), h("div", { text: text }), btn || null);
  }

  // Strategy state from /me. `enabled` = this strategy is sending signals now.
  function stratCfg(k) {
    var all = (S.me && S.me.strategies) || {};
    var c = all[k] || { long: false, short: false, locked: true };
    var locked = !!c.locked;
    var primary = c.primary != null ? !!c.primary : !!(S.me && S.me.strategy === k);
    var enabled = c.enabled != null ? (!!c.enabled && !locked) : (primary && !locked && !!(c.long || c.short));
    return { long: enabled && !!c.long, short: enabled && !!c.short, locked: locked, primary: primary, enabled: enabled };
  }
  function enabledKeys() { return STRAT_ORDER.filter(function (k) { return stratCfg(k).enabled; }); }
  function dirsText(c) { return c.long && c.short ? "L+S" : c.long ? "L" : c.short ? "S" : "—"; }
  function stratStatusTags(c) {
    var out = [];
    if (c.locked) { out.push(h("span", { class: "tag locked" }, icon("lock"), "Pro")); return out; }
    if (c.primary) out.push(tag("Основная", "primary"));
    out.push(c.enabled ? tag("В работе", "on") : tag("Выкл", "off"));
    return out;
  }
  function lsPills(c) {
    return h("div", { class: "ls" },
      h("span", { class: c.long ? "on-l" : "", text: "L " + (c.long ? "ON" : "OFF") }),
      h("span", { class: c.short ? "on-s" : "", text: "S " + (c.short ? "ON" : "OFF") }));
  }

  // Horizontal R scale: SL(−1R) … entry(0) … TP1/TP2/TP3 with a marker for
  // the live/final R. Pure geometry — no API strings go through innerHTML.
  function tpLevels(sig) {
    var out = [], stage = stageOf(sig);
    ["tp1", "tp2", "tp3"].forEach(function (k, i) {
      var r = rOf(sig, sig[k]);
      if (r === null || r <= 0) return;
      out.push({ k: k.toUpperCase(), key: k, r: r, hit: stage > i });
    });
    return out;
  }
  function rTrack(sig, compact) {
    var tps = tpLevels(sig);
    var cur = curR(sig);
    var st = statusKey(sig);
    var lo = -1, hi = Math.max(1, tps.length ? tps[tps.length - 1].r : 1);
    var curC = cur === null ? null : Math.max(lo - 0.3, Math.min(hi + 0.3, cur));
    if (curC !== null) { lo = Math.min(lo, curC); hi = Math.max(hi, curC); }
    var span = hi - lo;
    var P = function (r) { return (r - lo) / span * 100; };
    var pc = function (r) { return P(r).toFixed(2) + "%"; };
    var bar = h("div", { class: "rt-bar" },
      h("i", { class: "rt-zone neg", style: "left:0;width:" + pc(0) }),
      h("i", { class: "rt-zone pos", style: "left:" + pc(0) + ";right:0" }));
    if (curC !== null && curC !== 0) {
      bar.appendChild(h("i", { class: "rt-fill " + (curC > 0 ? "pos" : "neg"),
        style: "left:" + pc(Math.min(0, curC)) + ";width:" + (Math.abs(curC) / span * 100).toFixed(2) + "%" }));
    }
    var ticks = [{ k: "SL", r: -1, cls: st === "sl" ? "hit-sl" : "sl" }, { k: compact ? "0" : "Вход", r: 0, cls: "entry" }];
    tps.forEach(function (t) { ticks.push({ k: t.k, r: t.r, cls: t.hit ? "hit" : "" }); });
    ticks.forEach(function (t) { bar.appendChild(h("b", { class: "rt-tick " + t.cls, style: "left:" + pc(t.r) })); });
    if (curC !== null) bar.appendChild(h("em", { class: "rt-dot " + (curC >= 0 ? "pos" : "neg") + (isLive(sig) ? " live" : ""), style: "left:" + pc(curC) }));
    var wrap = h("div", { class: "rtrack" + (compact ? " compact" : ""), role: "img",
      "aria-label": "Шкала R: стоп −1R" + tps.map(function (t) { return ", " + t.k + " " + fmtR(t.r); }).join("") + (cur !== null ? ", сейчас " + fmtR(cur) : "") }, bar);
    if (!compact) {
      var labels = h("div", { class: "rt-labels", "aria-hidden": "true" });
      ticks.forEach(function (t) {
        var p = P(t.r);
        var al = p < 7 ? "l" : p > 93 ? "r" : "c";
        labels.appendChild(h("span", { class: "al-" + al + " " + t.cls, style: "left:" + pc(t.r), text: t.k }));
      });
      wrap.appendChild(labels);
    }
    return wrap;
  }

  // Equity curve sparkline from stats.equity ([{t, r}] cumulative R).
  var eqSeq = 0;
  function equityPlot(eq) {
    var W = 300, H = 64, PAD = 5;
    var vals = [0].concat(eq.map(function (p) { return num(p && p.r) || 0; }));
    var mn = Math.min(0, Math.min.apply(null, vals)), mx = Math.max(0, Math.max.apply(null, vals));
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var n = vals.length;
    var X = function (i) { return (i / (n - 1) * W).toFixed(2); };
    var Yn = function (v) { return PAD + (mx - v) / (mx - mn) * (H - 2 * PAD); };
    var Y = function (v) { return Yn(v).toFixed(2); };
    var zy = Y(0);
    var line = vals.map(function (v, i) { return (i ? "L" : "M") + X(i) + " " + Y(v); }).join("");
    var area = line + "L" + X(n - 1) + " " + zy + "L0 " + zy + "Z";
    var id = "eqc" + (++eqSeq);
    var svg = s("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", "aria-hidden": "true" });
    svg.appendChild(s("defs", null,
      s("clipPath", { id: id + "u" }, s("rect", { x: 0, y: -1, width: W, height: +zy + 1 })),
      s("clipPath", { id: id + "d" }, s("rect", { x: 0, y: zy, width: W, height: H - zy + 1 }))));
    svg.appendChild(s("line", { x1: 0, x2: W, y1: zy, y2: zy, class: "eq-zero" }));
    [["u", "pos"], ["d", "neg"]].forEach(function (p) {
      svg.appendChild(s("g", { "clip-path": "url(#" + id + p[0] + ")", class: "eq-" + p[1] },
        s("path", { d: area, class: "eq-area" }),
        s("path", { d: line, class: "eq-line" })));
    });
    var last = vals[n - 1];
    return h("div", { class: "eq-plot" }, svg,
      h("i", { class: "eq-dot " + (last >= 0 ? "pos" : "neg"), style: "top:" + (Yn(last) / H * 100).toFixed(2) + "%" }));
  }

  // ---------------------------------------------------------------------------
  // HOME
  // ---------------------------------------------------------------------------
  function homeSkeleton() {
    return h("div", null,
      skeleton(178, "margin-top:8px"),
      h("div", { class: "stats" }, skeleton(84), skeleton(84), skeleton(84)),
      skeleton(150, "margin-top:8px"),
      skeleton(104, "margin-top:8px"),
      skeleton(26, "margin-top:28px;width:50%"),
      h("div", { class: "strat-list mt12" }, skeleton(96), skeleton(96), skeleton(96)));
  }

  function renderHome() {
    var root = h("div", { class: "screen" });
    if (!S.me || !S.dash) { root.appendChild(homeSkeleton()); return root; }
    root.appendChild(banner());
    var mts = marketTrendStrip();
    if (mts) root.appendChild(mts);
    root.appendChild(statsBlock());
    var chc = challengeCard();
    if (chc) root.appendChild(chc);
    root.appendChild(equityCard());
    root.appendChild(marketBlock());

    root.appendChild(sectionTitle("Стратегии", bracket("Настроить"), function () { openSub("strategies"); }));
    root.appendChild(h("p", { class: "hint", text: PARALLEL_NOTE }));
    var list = h("div", { class: "strat-list" });
    STRAT_ORDER.forEach(function (k) { list.appendChild(stratRow(k)); });
    root.appendChild(list);

    root.appendChild(sectionTitle("Последние сигналы", bracket("Все"), function () { setTab("signals"); }));
    var recent = S.dash.recent || [];
    if (!recent.length) {
      root.appendChild(emptyCard("Пока пусто", "Новые сигналы появятся здесь, как только бот найдёт сетап."));
    } else {
      var row = h("div", { class: "hscroll" });
      recent.slice(0, 6).forEach(function (sig) { row.appendChild(offerCard(sig)); });
      root.appendChild(row);
    }
    return root;
  }

  function banner() {
    var u = S.me.user || {};
    var on = enabledKeys();
    var foot = h("div", { class: "promo-foot" });
    if (u.is_pro) {
      foot.appendChild(h("span", { class: "promo-k", text: on.length ? "Сигналы от:" : "Нет активных" }));
      on.forEach(function (k) {
        var c = stratCfg(k);
        foot.appendChild(h("span", { class: "pchip" + (c.primary ? " is-primary" : ""), title: c.primary ? "Основная стратегия" : "Работает параллельно" },
          stratName(k), h("b", { text: dirsText(c) })));
      });
      if (!on.length) foot.appendChild(h("span", { class: "pchip off", text: "Включите стратегию в профиле" }));
      var dl = daysLeft(u.sub_expires);
      return h("div", { class: "promo is-pro" },
        h("div", { class: "promo-art" }, icon("PROMO")),
        h("div", { class: "promo-text" },
          h("div", { class: "promo-title sm" },
            h("span", { class: "nw", text: on.length ? on.length + " " + plural(on.length, "стратегия", "стратегии", "стратегий") : "Сигналы" }), " ",
            h("span", { class: "nw", text: on.length ? "в работе" : "на паузе" })),
          h("div", { class: "promo-sub", text: "Pro до " + fmtDate(u.sub_expires) + (dl !== null ? " · " + dl + " дн." : "") }),
          h("button", { class: "btn", type: "button", onclick: function () { openSub("settings"); } }, "Настроить", icon("gear"))),
        foot);
    }
    foot.appendChild(h("span", { class: "promo-k", text: "Free:" }));
    on.forEach(function (k) {
      var c = stratCfg(k);
      foot.appendChild(h("span", { class: "pchip is-primary" }, stratName(k), h("b", { text: dirsText(c) })));
    });
    if (!on.length) foot.appendChild(h("span", { class: "pchip off", text: "сигналы выключены" }));
    var lockedNames = STRAT_ORDER.filter(function (k) { return stratCfg(k).locked; }).map(stratName);
    if (lockedNames.length) foot.appendChild(h("span", { class: "pchip locked" }, icon("lock"), lockedNames.join(" · ")));
    return h("div", { class: "promo" },
      h("div", { class: "promo-art" }, icon("PROMO")),
      h("div", { class: "promo-text" },
        h("div", { class: "promo-title" }, h("span", { class: "nw", text: "PRO —" }), " ", h("span", { class: "nw", text: "$69/мес" })),
        h("div", { class: "promo-sub", text: "Все стратегии параллельно и автотрейд" }),
        h("button", { class: "btn", type: "button", onclick: openCheckout }, "Оформить Pro", icon("arrow"))),
      foot);
  }

  function statsBlock() {
    var st = S.dash.stats || {};
    // [STATS-HONEST] win rate — по ОКОНЧАТЕЛЬНЫМ итогам (без TP1/TP2 в работе); итог R — после издержек
    var ft = num(pick(st, "final_trades", "trades")), fw = num(pick(st, "final_wins", "wins"));
    var wr = num(pick(st, "final_win_rate", "win_rate"));
    var gross = num(st.total_rr), net = num(pick(st, "net_rr", "total_rr")), r7 = num(pick(st, "net_rr_7d", "rr_7d"));
    var hasNet = num(st.net_rr) !== null;
    return h("div", { class: "stats" },
      h("div", { class: "card stat" }, label("[Win rate]"),
        h("div", { class: "stat-val" }, wr === null || !ft ? "—" : wr.toFixed(wr >= 99.95 ? 0 : 1), ft ? h("small", { text: "%" }) : null),
        // [STATS-HONEST] «23 из 42 закрытых» длиннее старого «в плюс» — переносится (.stat-sub.wrap), не обрезается «…»
        h("div", { class: "stat-sub wrap", text: ft ? (fw || 0) + " из " + ft + " закрытых" : "нет итогов" })),
      h("div", { class: "card stat" }, label("[Итог R]"),
        h("div", { class: "stat-val " + signCls(net), text: net === null ? "—" : fmtR(net) }),
        hasNet ? h("div", { class: "stat-sub wrap", title: "Без комиссий и проскальзывания (" + (num(st.cost_pct) || 0) + "% цены на сделку)" },
          "до комиссий ", h("span", { class: signCls(gross), text: gross === null ? "—" : fmtR(gross) })) : null,
        h("div", { class: "stat-sub" }, "7д: ", h("span", { class: signCls(r7), text: r7 === null ? "—" : fmtR(r7) }))),
      h("div", { class: "card stat" }, label("[Сигналов]"),
        h("div", { class: "stat-val", text: st.signals != null ? String(st.signals) : "—" }),
        h("div", { class: "stat-sub", text: statWindow(st) + (num(st.expired) ? " · без итога " + st.expired : "") })));
  }

  function equityCard() {
    var st = S.dash.stats || {};
    // [STATS-HONEST] кривая — net R (после издержек); ось X — номер сигнала с итогом, не время
    var eq = Array.isArray(st.equity_net) ? st.equity_net : Array.isArray(st.equity) ? st.equity : [];
    var last = eq.length ? num(eq[eq.length - 1].r) : null;
    var open = num(pick(st, "open_live", "open")), best = num(st.best_rr);
    var body = eq.length >= 1 ? equityPlot(eq) : h("div", { class: "eq-empty" },
      h("span", { text: "Кривая появится после первых сигналов с итогом" }));
    return h("div", { class: "card equity" },
      h("div", { class: "eq-head" },
        label("[Кривая R · " + statWindow(st, true) + "]"),
        last !== null ? rVal(last) : label("—")),
      body,
      eq.length >= 1 ? h("div", { class: "eq-cap", text: (Array.isArray(st.equity_net) ? "R после комиссий · " : "") + "по оси X — номер сигнала (1…" + eq.length + ")" }) : null,
      h("div", { class: "eq-foot" },
        h("div", null, label("Открыто"), h("b", { class: open ? "amber" : "", text: open === null ? "—" : String(open) })),
        h("div", null, label("Лучший"), h("b", { class: signCls(best), text: best === null ? "—" : fmtR(best) })),
        // [STATS-HONEST] подпись — треть карточки: на 320 px это ~73 px ≈ 11 моно-символов (label nowrap);
        // «Плюс / ноль / минус» не влезала и обрезалась до «ПЛЮС / НОЛЬ / М» — полное название в title
        h("div", { title: "Плюс / ноль / минус" }, label("+ / 0 / −"),
          h("b", null, h("span", { class: "up", text: String(num(pick(st, "final_wins", "wins")) || 0) }), h("span", { class: "dim", text: " / " }),
            h("span", { class: "muted", text: String(num(pick(st, "final_be", "be")) || 0) }), h("span", { class: "dim", text: " / " }),
            h("span", { class: "down", text: String(num(pick(st, "final_losses", "losses")) || 0) })))),
      num(st.signals) ? h("div", { style: "padding:0 14px 14px" },
        h("button", { class: "btn btn-ghost btn-block btn-sm", type: "button", onclick: shareResults }, "📤 Поделиться результатом")) : null);
  }

  // [SHARE-CARD] картинка результатов рисуется на клиенте (canvas): POST share
  // держит лимит 3/10 мин и отдаёт статистику; затем Web Share API, иначе скачивание.
  function shareResults(ev) {
    var btn = ev && ev.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = "Готовлю картинку…"; }
    hap("light");
    api("share", { body: { days: 30 } }).then(function (d) {
      if (!d || !d.ok) {
        if (d && d.error === "no_data") toast("Пока нет сигналов с итогом", true);
        else if (d && d.error === "rate_limited") toast("Не чаще 3 раз за 10 минут", true);
        else toast("Не удалось собрать картинку", true);
        return null;
      }
      var st = d.stats && typeof d.stats === "object" ? d.stats : ((S.dash && S.dash.stats) || {});
      return shareCard(st, num(d.days) || 30).then(function (how) {
        if (how === "cancelled") return;
        hap("success");
        toast(how === "shared" ? "Картинка отправлена — перешли её кому хочешь" : "Картинка сохранена — перешли её кому хочешь");
      });
    }).catch(function (e) { if (!e || e.code !== "unauthorized") toast("Не удалось собрать картинку", true); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = "📤 Поделиться результатом"; } });
  }
  function shareCard(st, days) {
    var W = 1080, H = 720;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0a0305"); bg.addColorStop(1, "#2e060e");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = "#ff2a4d"; g.font = "700 44px 'Oswald', 'Arial Narrow', sans-serif";
    g.fillText("CHM BREAKER", 64, 92);
    g.fillStyle = "rgba(246,238,240,.6)"; g.font = "500 22px 'JetBrains Mono', monospace";
    g.fillText("Мои результаты · " + days + " дн.", 64, 132);
    var wr = num(st.win_rate), tr = num(st.total_rr), trades = num(st.trades) || 0;
    var cols = [
      ["WIN RATE", wr === null || !trades ? "—" : wr.toFixed(wr >= 99.95 ? 0 : 1) + "%", "#f6eef0"],
      ["ИТОГ R", tr === null ? "—" : fmtR(tr), tr > 0 ? "#3df2a0" : tr < 0 ? "#ff2a4d" : "#f6eef0"],
      ["СИГНАЛОВ", st.signals != null ? String(st.signals) : "—", "#f6eef0"]
    ];
    cols.forEach(function (col, i) {
      var x = 64 + i * 330;
      g.fillStyle = "rgba(246,238,240,.45)"; g.font = "600 18px 'JetBrains Mono', monospace";
      g.fillText(col[0], x, 220);
      g.fillStyle = col[2]; g.font = "700 72px 'Oswald', 'Arial Narrow', sans-serif";
      g.fillText(col[1], x, 300);
    });
    g.fillStyle = "rgba(246,238,240,.55)"; g.font = "500 20px 'JetBrains Mono', monospace";
    g.fillText("+" + (num(st.wins) || 0) + " / −" + (num(st.losses) || 0) + " · лучший " + fmtR(st.best_rr) + " · 7д " + fmtR(st.rr_7d), 64, 356);
    var eq = Array.isArray(st.equity) ? st.equity : [];
    var vals = [0].concat(eq.map(function (p) { return num(p && p.r) || 0; }));
    var mn = Math.min(0, Math.min.apply(null, vals)), mx = Math.max(0, Math.max.apply(null, vals));
    if (mx - mn < 1e-9) { mx += 1; mn -= 1; }
    var px = 64, py = 400, pw = W - 128, ph = 230;
    var X = function (i) { return px + (vals.length > 1 ? i / (vals.length - 1) : 0) * pw; };
    var Y = function (v) { return py + (mx - v) / (mx - mn) * ph; };
    g.strokeStyle = "rgba(255,255,255,.12)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, Y(0)); g.lineTo(px + pw, Y(0)); g.stroke();
    var last = vals[vals.length - 1];
    g.strokeStyle = last >= 0 ? "#3df2a0" : "#ff2a4d"; g.lineWidth = 4; g.lineJoin = "round";
    g.beginPath();
    vals.forEach(function (v, i) { if (i) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v)); });
    g.stroke();
    g.fillStyle = "rgba(246,238,240,.35)"; g.font = "500 18px 'JetBrains Mono', monospace";
    g.fillText("chmup.top/app · не финансовая рекомендация", 64, H - 40);
    return new Promise(function (resolve, reject) {
      var finish = function (blob) {
        if (!blob) { reject(new Error("blob")); return; }
        var file = null;
        try { file = new File([blob], "chm-breaker-" + days + "d.png", { type: "image/png" }); } catch (e) { file = null; }
        if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: "CHM BREAKER", text: "Мои результаты за " + days + " дн." })
            .then(function () { resolve("shared"); }, function (e) { resolve(e && e.name === "AbortError" ? "cancelled" : downloadBlob(blob, file.name)); });
          return;
        }
        resolve(downloadBlob(blob, "chm-breaker-" + days + "d.png"));
      };
      try { c.toBlob(finish, "image/png"); } catch (e) { reject(e); }
    });
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = h("a", { href: url, download: name, style: "position:fixed;left:-9999px" });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1500);
    return "saved";
  }

  function trendRow(sym) {
    var t = (S.dash.trend || {})[sym] || {};
    var row = h("div", { class: "trend", role: "list", "aria-label": "Тренд " + sym + " по EMA50/200, как в карточке «Тренд BTC»" });
    TREND_TF.forEach(function (tf) {
      var v = String(t[tf] || "unknown");
      if (!TREND_WORD[v]) v = "unknown";
      row.appendChild(h("span", { class: "td " + v, role: "listitem", title: tf + ": " + TREND_WORD[v], "aria-label": tf + " " + TREND_WORD[v] },
        h("i", { "aria-hidden": "true" }), tf));
    });
    return row;
  }

  function marketBlock() {
    var mk = S.dash.market || {};
    var strip = h("div", { class: "card market" });
    ["BTC", "ETH"].forEach(function (sym) {
      var m = mk[sym];
      var ch = m ? num(m.change_pct) : null;
      strip.appendChild(h("div", { class: "mkt" },
        h("div", { class: "mkt-head" },
          h("span", { class: "mkt-sym", text: sym }),
          h("span", { class: "chg " + signCls(ch), title: "Изменение за 24 часа", text: ch === null ? "—" : fmtPct(ch) })),
        h("span", { class: "mkt-price", text: m && num(m.price) ? fmtPrice(m.price) + " $" : "—" }),
        trendRow(sym)));
    });
    return strip;
  }

  // [STRATEGY-RATING] общий рейтинг по уникальным сигналам всех юзеров за 30 дн.
  function ratingLine(k) {
    var rt = (S.dash.rating || {}).by_strategy || {};
    var r = rt[k];
    if (!r || !num(r.trades)) return null;
    var isBest = (S.dash.rating || {}).best === k;
    return h("div", { class: "mini-stats rating" + (isBest ? " best" : "") },
      h("span", null, label(isBest ? "🏆 Все юзеры" : "Все юзеры"), h("b", { class: signCls(r.total_rr), text: fmtR(r.total_rr) })),
      h("span", null, label("WR"), h("b", { text: (num(r.win_rate) || 0).toFixed(0) + "%" })),
      h("span", null, label("Сигн."), h("b", { text: String(num(r.signals) || 0) })));
  }
  function stratRow(k) {
    var c = stratCfg(k);
    var ps = ((S.dash.stats || {}).per_strategy || {})[k] || null;
    var statsEl;
    if (ps && num(ps.signals) && !c.locked) {
      // [STATS-HONEST] WR — по окончательным итогам, «Итог» — net R (как в блоке сверху)
      var psFt = num(pick(ps, "final_trades", "trades")), psNet = pick(ps, "net_rr", "total_rr");
      statsEl = h("div", { class: "mini-stats" },
        h("span", null, label("WR"), h("b", { text: psFt ? (num(pick(ps, "final_win_rate", "win_rate")) || 0).toFixed(0) + "%" : "—" })),
        h("span", null, label("Итог"), h("b", { class: signCls(psNet), text: num(ps.trades) ? fmtR(psNet) : "—" })),
        h("span", null, label("Сигн."), h("b", { text: String(ps.signals) })));
    } else {
      statsEl = h("div", { class: "mini-stats none" }, label(c.locked ? "Доступно в Pro" : "Нет сигналов за 30 дн."));
    }
    var rating = ratingLine(k);
    return h("button", {
      class: "card srow" + (c.locked ? " is-locked" : "") + (c.enabled ? " is-on" : "") + (c.primary ? " is-primary" : ""),
      type: "button", "aria-label": STRATS[k].full + (c.enabled ? ", в работе" : c.locked ? ", доступно в Pro" : ", выключена"),
      onclick: function () { hap("light"); setTab("profile"); }
    },
      h("div", { class: "srow-art" }, icon(k)),
      h("div", { class: "srow-body" },
        h("div", { class: "srow-top" },
          h("div", { class: "srow-name" }, label(bracket(STRATS[k].n)), h("span", { class: "strat-name", text: STRATS[k].name })),
          c.locked ? h("span", { class: "tag locked" }, icon("lock"), "Pro") : lsPills(c)),
        h("div", { class: "srow-tags" }, c.locked ? h("span", { class: "srow-desc", text: STRATS[k].desc }) : stratStatusTags(c)),
        statsEl, rating));
  }

  function liveLine(sig) {
    if (isLive(sig)) {
      var r = liveR(sig);
      if (r === null) return h("div", { class: "live-line" }, label("Цена обновляется…"));
      return h("div", { class: "live-line" },
        h("span", { class: "live-k" }, h("i", { class: "pulse", "aria-hidden": "true" }), "сейчас"),
        rVal(r),
        num(sig.price) !== null ? h("span", { class: "live-p", text: fmtPrice(sig.price) }) : null);
    }
    var f = finalR(sig);
    return h("div", { class: "live-line" }, h("span", { class: "live-k", text: "итог" }), f === null ? label("—") : rVal(f));
  }

  function offerCard(sig) {
    var open = function () { hap("light"); openDetail(sig); };
    // [TREND-MONITOR] чип «против тренда» — отдельной строкой, чтобы не обрезался краем карточки
    return h("div", { class: "card offer" + (sig && sig.counter_trend ? " is-ct" : "") },
      h("div", { class: "offer-head" },
        h("span", { class: "offer-pair", text: pairOf(sig) }),
        dirBadge(sig)),
      h("div", { class: "row between" }, label(bracket(stratName(sig.strategy) + " · " + String(sig.timeframe || "").toUpperCase())), stars(sig.quality)),
      sig && (sig.counter_trend || sig.mtf_aligned) ? h("div", { class: "offer-ct" }, ctBadge(sig), mtfBadge(sig)) : null,
      h("div", { class: "row between" }, statusBadge(sig), liveLine(sig)),
      rTrack(sig, false),
      h("div", { class: "offer-price" },
        h("span", null, label("Вход"), h("b", { text: fmtPrice(sig.entry) })),
        label(ago(sig.created_at))),
      h("div", { class: "offer-actions" },
        h("button", { class: "btn btn-red", type: "button", onclick: open }, "Подробнее", icon("arrow"))));
  }

  // ---------------------------------------------------------------------------
  // SIGNALS
  // ---------------------------------------------------------------------------
  // [SIGNALS-STRATEGY-FILTER] ключ кэша = статус + стратегия; стратегию фильтрует сервер
  function sigKey() { return S.sigFilter + (S.sigStrat && S.sigStrat !== "ALL" ? ":" + S.sigStrat : ""); }
  var SIG_LIMIT = 50;   // [STATS-HONEST] окно списка сигналов — «последние 50»
  function loadSignals(force) {
    var f = sigKey();
    var c = S.sigs[f];
    if (S.sigLoading || (!force && c && Date.now() - c.at < 30000)) return;
    S.sigLoading = true;
    if (force) rerender("signals");
    api("signals?status=" + encodeURIComponent(S.sigFilter) + "&limit=" + SIG_LIMIT + (S.sigStrat && S.sigStrat !== "ALL" ? "&strategy=" + encodeURIComponent(S.sigStrat) : "")).then(function (d) {
      okOrThrow(d);
      S.sigs[f] = { list: Array.isArray(d.signals) ? d.signals : [], at: Date.now() };
      if (force) hap("success");
    }).catch(function (e) {
      if (e.code !== "unauthorized") toast(errText(e.code), true);
      if (!S.sigs[f]) S.sigs[f] = { list: [], at: 0, err: true };
    }).then(function () {
      S.sigLoading = false;
      rerender("signals");
    });
  }

  function sigValue(sig) { return curR(sig); }

  function renderSignals() {
    var root = h("div", { class: "screen" });
    root.appendChild(heading("Сигналы", "center"));
    root.appendChild(h("p", { class: "hint sig-window", text: "последние " + SIG_LIMIT }));   // [STATS-HONEST]
    var filters = [["all", "Все"], ["open", "Открытые"], ["closed", "Закрытые"]];
    var chips = h("div", { class: "chips", role: "tablist", "aria-label": "Статус" });
    filters.forEach(function (f) {
      chips.appendChild(h("button", {
        class: "chip" + (S.sigFilter === f[0] ? " on" : ""), type: "button", role: "tab", "aria-selected": S.sigFilter === f[0] ? "true" : "false",
        onclick: function () { if (S.sigFilter === f[0]) return; hap("select"); S.sigFilter = f[0]; render(); loadSignals(); }
      }, f[1]));
    });
    var refresh = h("button", { class: "icon-btn" + (S.sigLoading ? " spin" : ""), type: "button", "aria-label": "Обновить",
      onclick: function () { hap("light"); loadSignals(true); } }, icon("refresh"));
    root.appendChild(h("div", { class: "row between filter-bar" }, chips, refresh));

    var sChips = h("div", { class: "chips scroll chips-sm", "aria-label": "Стратегия" });
    [["ALL", "Все стратегии"]].concat(STRAT_ORDER.map(function (k) { return [k, stratName(k)]; })).forEach(function (f) {
      sChips.appendChild(h("button", {
        class: "chip" + (S.sigStrat === f[0] ? " on-soft" : ""), type: "button", "aria-pressed": S.sigStrat === f[0] ? "true" : "false",
        onclick: function () { if (S.sigStrat === f[0]) return; hap("select"); S.sigStrat = f[0]; render(); loadSignals(); }
      }, f[1]));
    });
    root.appendChild(sChips);
    var mts = marketTrendStrip(true);   // [TREND-MONITOR] тот же блок, что на главной
    if (mts) root.appendChild(mts);
    else if (!S.dash && !S.dashLoading) { S.dashLoading = true; refreshDash(); }

    var c = S.sigs[sigKey()];
    var list = h("div", { class: "sig-list" });
    if (!c) {
      for (var i = 0; i < 4; i++) list.appendChild(skeleton(118));
      loadSignals();
      root.appendChild(list);
      return root;
    }
    var items = c.list.filter(function (x) { return S.sigStrat === "ALL" || String(x.strategy || "").toUpperCase() === S.sigStrat; });
    if (items.length) root.appendChild(summaryBar(items));
    if (!items.length) {
      var byStrat = S.sigStrat && S.sigStrat !== "ALL";
      var title = c.err ? "Не удалось загрузить" : (byStrat ? "Нет сигналов: " + stratName(S.sigStrat) : S.sigFilter === "open" ? "Открытых сигналов нет" : "Сигналов нет");
      var text = c.err ? "Проверьте связь и обновите список." : (byStrat ? "По этой стратегии у вас ещё не было сигналов. Проверьте, что она включена в настройках." : "Как только бот найдёт сетап — он появится здесь.");
      list.appendChild(emptyCard(title, text, c.err ? h("button", { class: "btn btn-dark btn-sm mt12", type: "button", onclick: function () { loadSignals(true); } }, "Повторить", icon("refresh")) : null));
    } else {
      items.forEach(function (sig) { list.appendChild(signalCard(sig)); });
      if (Date.now() - c.at > 30000) loadSignals();
    }
    root.appendChild(list);
    return root;
  }

  // [STATS-HONEST] Σ R разделена: закрытые — net R окончательных итогов (после издержек),
  // открытые — R «сейчас» по текущей цене; «В плюсе» — только закрытые
  function summaryBar(items) {
    var live = 0, closedN = 0, plus = 0, closedR = 0, openN = 0, openR = 0;
    items.forEach(function (x) {
      if (isLive(x)) {
        live++;
        var lv = liveR(x);
        if (lv !== null) { openN++; openR += lv; }
        return;
      }
      var f = finalR(x);
      if (f === null) return;
      closedN++;
      // [STATS-HONEST] как final_wins в db/signal_stats.aggregate: БУ (статус be, даже +0.02R биржевого
      // выхода) и 0R — не «в плюсе»; R брутто (до комиссий), как WIN RATE на Главной
      if (statusKey(x) !== "be" && f > 0) plus++;
      var nr = num(x.net_rr);
      closedR += nr !== null ? nr : f;
    });
    return h("div", { class: "card sumbar" },
      h("div", null, label("Сигналов"), h("b", { text: String(items.length) })),
      h("div", null, label("Открыто"), h("b", { class: live ? "amber" : "", text: String(live) })),
      h("div", { title: "Закрытые с R > 0 до комиссий; БУ — не в плюсе (как WIN RATE на Главной)" }, label("В плюсе"), h("b", { text: closedN ? plus + "/" + closedN : "—" })),
      h("div", { class: "sumbar-r", title: "Закрытые — R после комиссий; открытые — R по текущей цене" }, label("Σ R"),
        h("span", { class: "sumbar-rv" }, "закрытые ", h("b", { class: signCls(closedN ? closedR : null), text: closedN ? fmtR(closedR) : "—" }),
          h("span", { class: "dim", text: " · " }), "открытые ", h("b", { class: signCls(openN ? openR : null), text: openN ? fmtR(openR) : "—" }))));
  }

  function signalCard(sig) {
    var live = isLive(sig);
    var v = sigValue(sig);
    var right;
    if (live) {
      right = v === null ? label("цена обновляется…")
        : h("span", { class: "sig-now" }, h("span", { class: "live-k" }, h("i", { class: "pulse", "aria-hidden": "true" }), "сейчас"), rVal(v),
          num(sig.price) !== null ? h("span", { class: "live-p", text: fmtPrice(sig.price) }) : null);
    } else {
      right = h("span", { class: "sig-now" }, h("span", { class: "live-k", text: "итог" }), v === null ? label("—") : rVal(v));
    }
    return h("button", { class: "card sig" + (live ? " is-live" : "") + (sig.counter_trend ? " is-ct" : ""), type: "button", "aria-label": pairOf(sig) + " " + (isLong(sig) ? "LONG" : "SHORT") + ", " + statusOf(sig).t + (sig.counter_trend ? ", против тренда" : ""),
      onclick: function () { hap("light"); openDetail(sig); } },
      h("div", { class: "sig-head" },
        h("div", { class: "sig-title" }, h("span", { class: "sig-pair", text: pairOf(sig) }), dirBadge(sig)),
        statusBadge(sig)),
      h("div", { class: "sig-meta" },
        label(bracket(stratName(sig.strategy) + " · " + String(sig.timeframe || "—").toUpperCase())),
        stars(sig.quality),
        h("span", { class: "label sig-ago", text: ago(sig.created_at) })),
      // чипы тренда — отдельной строкой, чтобы «N ч назад» не переносилось
      sig.counter_trend || sig.mtf_aligned ? h("div", { class: "sig-flags" }, ctBadge(sig), mtfBadge(sig)) : null,
      rTrack(sig, true),
      h("div", { class: "sig-foot" },
        h("span", { class: "sig-entry" }, label("Вход"), h("b", { text: fmtPrice(sig.entry) })),
        right));
  }

  // ---------------------------------------------------------------------------
  // SIGNAL DETAIL
  // ---------------------------------------------------------------------------
  function openDetail(sig) {
    S.detail = sig;
    if (sig && sig.id != null) S.sigById[sig.id] = sig;
    S.savedScroll = window.scrollY || 0;
    view.hidden = true;
    $("#tabbar").hidden = true;
    detailEl.hidden = false;
    renderDetail(sig);
    window.scrollTo(0, 0);
    navPush();
  }
  function closeDetail(silent) {
    if (!S.detail) return;
    S.detail = null;
    detailEl.hidden = true;
    clear(detailEl);
    view.hidden = false;
    $("#tabbar").hidden = false;
    if (!silent) { hap("light"); render(); window.scrollTo(0, S.savedScroll); }
  }

  function timeline(sig) {
    var stage = stageOf(sig);
    var st = statusKey(sig);
    var failed = st === "sl";
    var be = st === "be";
    var tl = h("div", { class: "timeline" });
    var nodes = [["Вход", 0], ["TP1", 1], ["TP2", 2], ["TP3", 3]];
    nodes.forEach(function (n, i) {
      var cls = "tl-node";
      var dotContent;
      if (i === 0 || stage >= n[1]) { cls += " done"; dotContent = icon("check"); }
      else if (failed && i === stage + 1) { cls += " fail"; dotContent = icon("x"); }
      else if (!failed && !be && i === stage + 1 && (st === "open" || st.indexOf("tp") === 0)) { cls += " cur"; dotContent = document.createTextNode(String(i)); }
      else dotContent = document.createTextNode(String(i));
      if (i > 0) {
        var lc = "tl-line" + (stage >= n[1] ? " done" : (failed && i === stage + 1) ? " fail" : "");
        tl.appendChild(h("div", { class: lc }));
      }
      tl.appendChild(h("div", { class: cls }, h("div", { class: "tl-dot" }, dotContent), label(failed && i === stage + 1 ? "SL" : (be && i === stage + 1 ? "БУ" : n[0]))));
    });
    return tl;
  }

  // Level ladder TP3 → SL with R distance, % from entry, hit marks and a live
  // price row slotted in at its R position.
  function ladder(sig) {
    var st = statusKey(sig);
    var rows = tpLevels(sig).slice().reverse().map(function (t) {
      return { k: t.k, p: sig[t.key], r: t.r, cls: t.hit ? "hit" : "", mark: t.hit ? "check" : null, note: t.hit ? "достигнут" : "" };
    });
    rows.push({ k: "Вход", p: sig.entry, r: 0, cls: "entry" + (st === "be" ? " be" : ""), mark: null, note: st === "be" ? "стоп в БУ" : "" });
    rows.push({ k: "SL", p: sig.sl, r: -1, cls: "sl" + (st === "sl" ? " hit-sl" : ""), mark: st === "sl" ? "x" : null, note: st === "sl" ? "стоп" : "" });
    var lr = isLive(sig) && num(sig.price) !== null ? liveR(sig) : null;
    if (lr !== null) {
      var at = rows.length;
      for (var i = 0; i < rows.length; i++) { if (rows[i].r < lr) { at = i; break; } }
      rows.splice(at, 0, { live: true, k: "Цена", p: sig.price, r: lr });
    }
    var box = h("div", { class: "ladder", role: "table", "aria-label": "Уровни сигнала" });
    box.appendChild(h("div", { class: "lad-row lad-h", role: "row" },
      h("span"), label("Цена"), label("% от входа", "ta-r"), label("R", "ta-r"), h("span")));
    rows.forEach(function (r) {
      var pct = r.k === "Вход" ? null : pctFrom(sig.entry, r.p);
      var mark = r.mark ? icon(r.mark) : null;
      if (mark) mark.setAttribute("class", "ico ok" + (r.mark === "x" ? " down" : ""));
      box.appendChild(h("div", { class: "lad-row " + (r.live ? "live " + (r.r >= 0 ? "pos" : "neg") : r.cls), role: "row", title: r.note || null },
        h("span", { class: "k" }, r.live ? h("i", { class: "pulse", "aria-hidden": "true" }) : null, r.k),
        h("span", { class: "v", text: fmtPrice(r.p) }),
        h("span", { class: "pct", text: pct === null ? "" : fmtPct(pct) }),
        h("span", { class: "r " + (r.live ? signCls(r.r) : ""), text: r.k === "Вход" ? "0R" : fmtR(r.r) }),
        mark || h("span", { class: "mk" })));
    });
    return box;
  }

  function renderDetail(sig) {
    clear(detailEl);
    var inner = h("div", { class: "detail-inner screen" });
    inner.appendChild(h("button", { class: "back", type: "button", onclick: goBack }, icon("back"), "Назад"));

    inner.appendChild(h("div", { class: "detail-title" },
      h("div", { class: "h1", text: pairOf(sig) }),
      statusBadge(sig)));
    inner.appendChild(h("div", { class: "sig-meta", style: "margin-top:10px" },
      dirBadge(sig), ctBadge(sig), mtfBadge(sig), label(bracket(stratName(sig.strategy) + " · " + String(sig.timeframe || "—").toUpperCase())), stars(sig.quality)));
    inner.appendChild(h("div", { class: "created" }, label("Создан " + fmtDateTime(sig.created_at)), label("· " + ago(sig.created_at), "label-b")));

    // Live / result panel
    var live = isLive(sig);
    var v = curR(sig);
    inner.appendChild(h("div", { class: "card now-card" + (live ? " is-live" : "") },
      h("div", null,
        label(live ? "[Сейчас]" : "[Итог]"),
        live ? h("div", { class: "now-price", text: num(sig.price) !== null ? fmtPrice(sig.price) + " $" : "—" })
          : h("div", { class: "now-price", text: FINAL_WORD[statusKey(sig)] || statusOf(sig).t })),
      h("div", { class: "now-r" },
        h("div", { class: "now-rv " + signCls(v), text: v === null ? "—" : fmtR(v, 2) }),
        label(live ? (num(sig.price) !== null ? fmtPct(pctFrom(sig.entry, sig.price)) + " от входа" : "цена обновляется") : "результат"))));

    var chart = h("div", { class: "chart-box" }, skeleton(220, "width:100%;border-radius:0"));
    inner.appendChild(chart);
    api("signals/" + encodeURIComponent(sig.id) + "/chart", { timeout: 30000 }).then(function (d) {
      if (S.detail !== sig) return;
      clear(chart);
      var node = chartNode(d, sig, "График " + pairOf(sig));
      chart.appendChild(node || label(errText((d && d.error) || "no_data")));
    }).catch(function (e) {
      if (S.detail !== sig) return;
      clear(chart); chart.appendChild(label(errText(e.code === "timeout" || e.code === "not_found" ? "no_data" : e.code)));
    });

    inner.appendChild(timeline(sig));
    inner.appendChild(h("div", { class: "card pad mt12" }, rTrack(sig, false), ladder(sig)));

    inner.appendChild(tradeCard(sig));          // [TRADE-BUTTONS]
    inner.appendChild(manualResultCard(sig));   // [MANUAL-RESULT]

    var k = String(sig.strategy || "").toUpperCase();
    inner.appendChild(h("div", { class: "card note strat-note" },
      h("span", { class: "srow-art sm" }, STRATS[k] ? icon(k) : null),
      h("span", null,
        h("b", { text: (STRATS[k] ? STRATS[k].full : stratName(k)) }),
        " — " + (STRATS[k] ? STRATS[k].desc : "стратегия бота") + ". " + (isLong(sig) ? "Лонг" : "Шорт") + " на " + String(sig.timeframe || "—").toUpperCase() +
        "; 1R — расстояние от входа до стопа.")));

    inner.appendChild(h("div", { class: "stack" },
      h("button", { class: "btn btn-red btn-block", type: "button", onclick: function () {
        hap("light");
        S.an.symbol = String(sig.symbol || "").toUpperCase();
        closeDetail(true);
        setTab("analyze");
      } }, "Анализ " + String(sig.symbol || "монеты"), icon("search"))));

    detailEl.appendChild(inner);
  }

  // [TRADE-BUTTONS] the trade buttons of the delivered signal card (the bot's inline keyboard):
  // «✅ Открыть сделку» (confirm mode) or 50% / 100% / SL→BE / progress under an auto-trade —
  // GET trades/{id}/card lists them with their route (decision D16: only the buttons the card
  // still carries, only for the owner); a press goes through the trade-ops queue. The answer is the
  // bot's text (HTML, shown as plain text). The hold-lock dialog's two buttons come in the answer.
  var TRADE_TIMEOUT = 30000;           // > routes/appTrade.js EXEC_WAIT_S (25 s)
  var TRADE_ROUTES = [                 // = services/engine/signalDelivery.js ACTION_ROUTES
    [/^exec_trade_(.+)$/, "POST", "exec"],
    [/^qc_half_(.+)$/, "POST", "qc/half"],
    [/^qc_full_force_(.+)$/, "POST", "qc/force"],
    [/^qc_full_(.+)$/, "POST", "qc/full"],
    [/^qc_be_(.+)$/, "POST", "qc/be"],
    [/^qc_refresh_(.+)$/, "GET", "progress"]
  ];
  function tradeRoute(action, tradeId) {
    var a = String(action || "");
    if (a === "qc_holdlock_wait") return { method: "POST", path: "trades/" + encodeURIComponent(tradeId) + "/qc/wait" };
    for (var i = 0; i < TRADE_ROUTES.length; i++) {
      var m = TRADE_ROUTES[i][0].exec(a);
      if (m) return { method: TRADE_ROUTES[i][1], path: "trades/" + encodeURIComponent(m[1]) + "/" + TRADE_ROUTES[i][2] };
    }
    return null;
  }
  // the bot's Telegram HTML (<b>, <i>, <code>, entities) → text for textContent
  function htmlText(s) {
    return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  function tradeCard(sig) {
    var box = h("div", { class: "card pad trade-card", hidden: "hidden" });
    var answer = null;
    function buttonsOf(rows) {
      var out = [];
      (Array.isArray(rows) ? rows : []).forEach(function (row) {
        (Array.isArray(row) ? row : []).forEach(function (b) {
          if (!b || b.kind === "url") return;
          var r = b.api || tradeRoute(b.action, sig.id);
          if (r) out.push({ label: String(b.label || ""), action: String(b.action || ""), api: r });
        });
      });
      return out;
    }
    function draw(btns, extra) {
      clear(box);
      if (!btns.length && !answer) { box.setAttribute("hidden", "hidden"); return; }
      box.removeAttribute("hidden");
      box.appendChild(h("div", { class: "h2" }, h("span", { text: "Сделка" })));
      if (answer) box.appendChild(h("p", { class: "trade-answer" + (answer.err ? " err" : ""), text: answer.text }));
      var all = (extra || []).concat(btns);
      if (all.length) {
        var wrap = h("div", { class: "stack", style: "margin-top:8px" });
        all.forEach(function (b) {
          wrap.appendChild(h("button", { class: "btn " + (/^exec_trade_/.test(b.action) ? "btn-red" : "btn-dark") + " btn-block", type: "button", disabled: S.busyTrade ? "disabled" : null,
            onclick: function () { press(b); } }, b.label));
        });
        box.appendChild(wrap);
      }
    }
    function load(extra) {
      api("trades/" + encodeURIComponent(sig.id) + "/card", { timeout: 15000 }).then(function (d) {
        if (S.detail !== sig) return;
        draw(d && d.ok ? buttonsOf(d.actions) : [], extra);
      }).catch(function () { if (S.detail === sig) draw([], extra); });
    }
    function press(b) {
      if (S.busyTrade) return;
      S.busyTrade = true; hap("light");
      var opt = { method: b.api.method, timeout: TRADE_TIMEOUT };
      if (b.api.method === "POST") opt.body = {};
      var extra = null;
      api(b.api.path, opt).then(function (d) {
        if (d && d.pending) { answer = { text: "Заявка принята — ответ придёт в уведомления.", err: false }; return; }
        var text = d && (d.text || d.message || (d.alert && d.alert.text));
        answer = text ? { text: htmlText(text), err: !(d && d.ok) } : null;
        if (!text && d && !d.ok) answer = { text: errText(d.error || "network"), err: true };
        // the hold-lock dialog: its «Всё равно закрыть» / «Подождать» buttons
        (d && Array.isArray(d.effects) ? d.effects : []).forEach(function (e) {
          if (e && e.op === "send" && e.keyboard) extra = buttonsOf(e.keyboard);
        });
      }).catch(function (e) {
        answer = { text: errText(e.code), err: true };
      }).finally(function () {
        S.busyTrade = false;
        S.sigs = {}; S.dashAt = 0;
        if (S.detail === sig) load(extra);
      });
    }
    load(null);
    return box;
  }

  // [MANUAL-RESULT] ручной итог + заметка к сигналу
  var MANUAL_OPTS = [["TP1", "TP1"], ["TP2", "TP2"], ["TP3", "TP3"], ["SL", "Стоп"], ["BE", "БУ"], ["SKIP", "Пропустил"]];
  function manualResultCard(sig) {
    var st = statusKey(sig);
    var canSet = (st === "open" || st === "expired" || (st === "skip" && !sig.manual)) && !sig.on_exchange;
    var card = h("div", { class: "card pad manual" });
    card.appendChild(h("div", { class: "h2" }, h("span", { text: "Мой результат" })));
    if (canSet) {
      card.appendChild(h("p", { class: "hint", text: "Вошли сами? Отметьте, как закрылась сделка — попадёт в вашу статистику." }));
      var seg = h("div", { class: "seg" });
      MANUAL_OPTS.forEach(function (o) {
        seg.appendChild(h("button", { class: "seg-b", type: "button", onclick: function () {
          if (S.busyPref) return;
          S.busyPref = true; hap("select");
          api("signals/" + encodeURIComponent(sig.id) + "/result", { method: "POST", body: { result: o[0] } }).then(function (d) {
            okOrThrow(d);
            if (d.signal) Object.assign(sig, d.signal);
            S.sigs = {}; S.dashAt = 0;
            toast("Сохранено: " + o[1]);
            renderDetail(sig);
          }).catch(function (e) { toast(errText(e.code === "already_set" ? "already_set" : e.code), true); }).finally(function () { S.busyPref = false; });
        } }, o[1]));
      });
      card.appendChild(seg);
    } else {
      card.appendChild(h("p", { class: "hint", text: sig.on_exchange ? "Сделка на бирже — итог приходит с биржи." : "Итог зафиксирован: " + (FINAL_WORD[st] || statusOf(sig).t) + "." }));
    }
    var ta = h("textarea", { class: "inp", rows: "2", maxlength: "500", placeholder: "Заметка: почему вошли / не вошли, что заметили…" });
    ta.value = sig.note || "";
    var save = h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: function () {
      if (S.busyPref) return;
      S.busyPref = true; hap("light");
      api("signals/" + encodeURIComponent(sig.id) + "/result", { method: "POST", body: { note: ta.value } }).then(function (d) {
        okOrThrow(d);
        if (d.signal) Object.assign(sig, d.signal);
        S.sigs = {};
        toast("Заметка сохранена");
      }).catch(function (e) { toast(errText(e.code), true); }).finally(function () { S.busyPref = false; });
    } }, "Сохранить заметку");
    card.appendChild(h("div", { class: "stack", style: "margin-top:10px" }, ta, save));
    return card;
  }

  function chartImage(png, alt) {
    var img = h("img", { alt: alt || "График", loading: "lazy", decoding: "async" });
    img.src = "data:image/png;base64," + String(png).replace(/[^A-Za-z0-9+/=]/g, "");
    return img;
  }
  // Chart payload → node: the port's server sends candles + overlays (drawn by
  // chart.js on a canvas, decision D3); a base64 PNG is still accepted.
  function chartNode(d, sig, alt) {
    if (!d || !d.ok) return null;
    if (Array.isArray(d.candles) && d.candles.length && window.CHMChart) {
      try { return window.CHMChart.render(d, sig || {}, alt); } catch (e) { /* fall through to png */ }
    }
    var png = d.png || d.image;
    return png ? chartImage(png, alt) : null;
  }

  // Seeded PRNG so mock candles/sparklines are stable across renders.
  function seeded(str) {
    var x = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619) >>> 0;
    return function () {
      x = (x + 0x6D2B79F5) >>> 0;
      var t = x;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Random-walk candles that finish near `end`, used for the analyze loader & demo charts.
  function genCandles(seed, n, end, vol, trendSign) {
    var r = seeded(seed);
    var p = end * (1 - trendSign * vol * (6 + r() * 6));
    var out = [];
    for (var i = 0; i < n; i++) {
      var left = n - i;
      var drift = (end - p) / left * 0.85;
      var o = p;
      var c = o + drift + (r() - 0.5) * vol * end * 1.6;
      var hi = Math.max(o, c) + r() * vol * end * 0.8;
      var lo = Math.min(o, c) - r() * vol * end * 0.8;
      out.push({ o: o, h: hi, l: lo, c: c });
      p = c;
    }
    return out;
  }
  function levelRows(sig) {
    var st = statusKey(sig);
    var stage = stageOf(sig);
    var rows = [["Вход", sig.entry, null, "entry"], ["SL", sig.sl, -1, st === "sl" ? "hit-sl" : ""]];
    ["tp1", "tp2", "tp3"].forEach(function (k, i) {
      if (!num(sig[k])) return;
      rows.push([k.toUpperCase(), sig[k], rOf(sig, sig[k]), stage > i ? "hit" : ""]);
    });
    var box = h("div", { class: "levels" });
    rows.forEach(function (r) {
      var mark = null;
      if (r[3] === "hit") mark = icon("check");
      else if (r[3] === "hit-sl") mark = icon("x");
      if (mark) mark.setAttribute("class", "ico ok" + (r[3] === "hit-sl" ? " down" : ""));
      box.appendChild(h("div", { class: "lvl " + r[3] },
        h("span", { class: "k", text: r[0] }),
        h("span", { class: "v", text: fmtPrice(r[1]) }),
        h("span", { class: "r", text: r[2] == null ? "" : fmtR(r[2]) }),
        mark || h("span")));
    });
    return box;
  }
  function infoLabel(text) { return h("span", { class: "label" }, h("span", { style: "text-transform:none", text: "i " }), text); }
  // ---------------------------------------------------------------------------
  // ANALYZE
  // ---------------------------------------------------------------------------
  var anTimer = null;

  function runAnalyze() {
    if (S.an.loading) { hap("light"); return; }   // [AUDIT F-1] Enter во время запроса → второй POST
    var sym = String(S.an.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (sym.length > 4 && /USDT$/.test(sym)) sym = sym.slice(0, -4);
    if (!sym) { hap("error"); toast("Введите тикер монеты, например BTC", true); return; }
    S.an.symbol = sym;
    S.an.loading = true; S.an.result = null; S.an.error = null; S.an.startedAt = Date.now();
    hap("medium");
    render();
    clearInterval(anTimer);
    anTimer = setInterval(function () {
      var el = document.getElementById("an-elapsed");
      if (el) el.textContent = "00:" + pad2(Math.min(99, Math.floor((Date.now() - S.an.startedAt) / 1000)));
    }, 500);
    api("analyze", { method: "POST", body: { symbol: sym, strategy: S.an.strategy }, timeout: 60000 }).then(function (d) {
      if (!d || !d.ok) throw new ApiError((d && d.error) || "network");
      S.an.result = d;
      hap(d.signal ? "success" : "warning");
    }).catch(function (e) {
      S.an.error = e.code || "network";
      hap("error");
    }).then(function () {
      S.an.loading = false;
      clearInterval(anTimer);
      if (S.tab === "analyze" && !S.detail) render();
    });
  }

  function renderAnalyze() {
    var root = h("div", { class: "screen" });
    root.appendChild(heading("Анализ", "center"));

    var input = h("input", {
      type: "text", inputmode: "text", autocapitalize: "characters", autocomplete: "off", autocorrect: "off",
      spellcheck: "false", maxlength: "15", placeholder: "BTC", value: S.an.symbol, "aria-label": "Тикер монеты",
      enterkeyhint: "go"
    });
    input.addEventListener("input", function () {
      var v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 15);
      if (v !== input.value) input.value = v;
      S.an.symbol = v;
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { input.blur(); runAnalyze(); } });

    var quick = h("div", { class: "chips scroll chips-sm" });
    ["BTC", "ETH", "SOL", "TON", "XRP", "DOGE"].forEach(function (t) {
      quick.appendChild(h("button", { class: "chip", type: "button", onclick: function () {
        hap("select"); S.an.symbol = t; input.value = t;
      } }, t));
    });

    var stratChips = h("div", { class: "chips" });
    [["LEVELS", "Уровни"], ["SMC", "SMC"], ["VOLUME", "Объём+MA"], ["AUTO", "🤖 Авто"]].forEach(function (c) {
      stratChips.appendChild(h("button", {
        class: "chip" + (S.an.strategy === c[0] ? " on" : ""), type: "button",
        onclick: function () { if (S.an.loading) return; hap("select"); S.an.strategy = c[0]; render(); }
      }, c[1]));
    });

    root.appendChild(h("div", { class: "an-form" },
      h("div", { class: "field" },
        h("label", { class: "field-box" }, label("[Монета · USDT-перп]"), input),
        h("button", { class: "icon-btn", type: "button", style: "width:56px;height:auto", "aria-label": "Очистить",
          onclick: function () { hap("light"); S.an.symbol = ""; S.an.result = null; S.an.error = null; render(); var i = view.querySelector("input"); if (i) i.focus(); } }, icon("close"))),
      quick,
      label("[Стратегия]"),
      stratChips,
      h("button", { class: "btn btn-red btn-block", type: "button", disabled: S.an.loading, onclick: function () { input.blur(); runAnalyze(); } },
        S.an.loading ? "Анализирую…" : "Анализировать", icon("search"))));

    if (S.an.loading) root.appendChild(loadingCard());
    else if (S.an.error) root.appendChild(h("div", { class: "card pad result" },
      h("div", { class: "cond", style: "font-size:22px;color:var(--red)", text: "Ошибка" }),
      h("p", { class: "muted", style: "margin:6px 0 0", text: errText(S.an.error) }),
      S.an.error === "pro_required" ? h("button", { class: "btn btn-red btn-sm mt12", type: "button", onclick: openCheckout }, "Тариф Pro") : null));
    else if (S.an.result) root.appendChild(resultView(S.an.result));
    else root.appendChild(h("p", { class: "desc", style: "margin-top:16px", text:
      "Бот прогонит монету через реальные движки стратегий и найдёт действующий сетап на последних закрытых свечах. «Авто» выберет лучший по качеству, свежести и RR." }));
    return root;
  }

  function loadingCard() {
    var svg = s("svg", { viewBox: "0 0 300 70", preserveAspectRatio: "none" });
    var cs = genCandles("scan" + S.an.symbol, 30, 100, 0.012, 0);
    var lo = Infinity, hi = -Infinity;
    cs.forEach(function (c) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    var grp = s("g", { class: "cnds" });
    cs.forEach(function (c, i) {
      var y = function (v) { return 64 - (v - lo) / (hi - lo) * 58; };
      var x = 6 + i * 9.8;
      var up = c.c >= c.o;
      // each candle is its own <g> so CSS can bob it with a phase-shifted delay
      var g = s("g", { class: "cnd", style: "--i:" + i });
      g.appendChild(s("line", { x1: x, x2: x, y1: y(c.h), y2: y(c.l), stroke: up ? "rgba(255,255,255,.38)" : "rgba(255,42,77,.65)", "stroke-width": 1 }));
      g.appendChild(s("rect", { x: x - 3, y: Math.min(y(c.o), y(c.c)), width: 6, height: Math.max(1, Math.abs(y(c.o) - y(c.c))), fill: up ? "rgba(255,255,255,.22)" : "rgba(255,42,77,.6)" }));
      grp.appendChild(g);
    });
    svg.appendChild(grp);
    var sec = Math.floor((Date.now() - S.an.startedAt) / 1000);
    return h("div", { class: "card loading" },
      h("div", { class: "scan" }, svg),
      h("div", { class: "cond", text: "Сканирую " + S.an.symbol }),
      h("div", { class: "row", style: "justify-content:center;gap:10px;margin-top:6px" },
        label(bracket(S.an.strategy === "AUTO" ? "Уровни · SMC · Объём" : stratName(S.an.strategy))),
        h("span", { class: "label", id: "an-elapsed", text: "00:" + pad2(sec) })),
      h("p", { class: "muted", style: "margin:10px 0 0;font-size:12px", text: "Обычно это занимает 5–20 секунд" }));
  }

  function resultView(d) {
    var wrap = h("div", { class: "result" });
    var sym = String(d.symbol || S.an.symbol || "");
    var pr = d.price;
    wrap.appendChild(h("div", { class: "coin-head" },
      h("span", { class: "cond", text: sym + "/USDT" }),
      pr && pr.price != null ? h("div", { style: "text-align:right" },
        h("div", { class: "mkt-price", text: fmtPrice(pr.price) + " $" }),
        h("div", { class: "chg " + (num(pr.change_pct) > 0 ? "up" : num(pr.change_pct) < 0 ? "down" : "muted"), text: fmtPct(pr.change_pct) + " · 24H" })) : null));

    var tried = (d.tried || []).map(stratName).join(" · ");
    var sig = d.signal;
    if (sig) {
      var card = h("div", { class: "card pad mt8" });
      card.appendChild(h("div", { class: "result-head" },
        h("div", null,
          label(bracket(stratName(sig.strategy) + (sig.bars_ago ? " · " + sig.bars_ago + " св. назад" : " · последняя свеча"))),
          h("div", { class: "cond", style: "font-size:26px;line-height:1.05;margin-top:6px", text: String(sig.setup || "Сетап") })),
        h("div", { class: "sig-badges" }, dirBadge(sig), stars(sig.quality))));
      var chartEl = chartNode(d, sig, "График " + sym);
      if (chartEl) card.appendChild(h("div", { class: "chart-box" }, chartEl));
      var price = h("div", { class: "price-line" },
        h("b", { text: fmtPrice(sig.entry) + " $" }),
        infoLabel(bracket("до TP3 " + fmtR(rOf(sig, sig.tp3)))));
      card.appendChild(price);
      card.appendChild(levelRows(sig));
      if (sig.reasons && sig.reasons.length) {
        var ul = h("ul", { class: "reasons" });
        sig.reasons.forEach(function (r, i) { ul.appendChild(h("li", null, h("span", { text: bracket(pad2(i + 1)) }), h("span", { text: String(r) }))); });
        card.appendChild(h("div", { class: "mt12" }, label("[Почему]"), ul));
      }
      if (tried) card.appendChild(h("div", { class: "mt12" }, label("Проверено: " + tried)));
      wrap.appendChild(card);
      wrap.appendChild(h("p", { class: "desc", text: "Не финансовая рекомендация. Сетап актуален, пока цена не ушла от зоны входа." }));
    } else {
      var none = h("div", { class: "card pad mt8", style: "text-align:center" },
        icon("none"),
        h("div", { class: "cond", style: "font-size:22px", text: "Сейчас нет действующего сетапа" }),
        h("p", { class: "muted", style: "margin:8px 0 0;font-size:13px", text: "По " + sym + " ни одна стратегия не даёт входа на последних свечах. Загляните позже или попробуйте другую монету." }),
        tried ? h("div", { class: "mt12" }, label(bracket("Проверено: " + tried))) : null);
      var noneChart = chartNode(d, null, "График " + sym);
      if (noneChart) none.appendChild(h("div", { class: "chart-box" }, noneChart));
      wrap.appendChild(none);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // PROFILE
  // ---------------------------------------------------------------------------
  function switchEl(checked, opts) {
    opts = opts || {};
    var inp = h("input", { type: "checkbox", role: "switch", "aria-label": opts.aria || null });
    inp.checked = !!checked;
    if (opts.disabled) inp.disabled = true;
    inp.addEventListener("change", function () { opts.onChange(inp.checked, inp); });
    return h("span", { class: "sw" + (opts.cls ? " " + opts.cls : "") }, inp, h("span", { "aria-hidden": "true" }));
  }
  // Whole row is a <label> → the full ≥52px row is the tap target.
  // [QUIET-HOURS] окно часов UTC без звука: выкл / 22–07 / 23–08 / 00–09 / 01–10
  var QUIET_PRESETS = [[-1, -1, "Выкл"], [22, 7, "22–07"], [23, 8, "23–08"], [0, 9, "00–09"], [1, 10, "01–10"]];
  function quietHoursRow(prefs) {
    var cur = String(num(prefs.quiet_start) === null ? -1 : prefs.quiet_start) + "_" + String(num(prefs.quiet_end) === null ? -1 : prefs.quiet_end);
    var seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Тихие часы" });
    QUIET_PRESETS.forEach(function (p) {
      var key = p[0] + "_" + p[1];
      seg.appendChild(h("button", { class: "seg-b" + (key === cur ? " on" : ""), type: "button", role: "radio", "aria-checked": key === cur ? "true" : "false",
        onclick: function () {
          if (S.busyPref) return;
          S.busyPref = true; hap("light");
          api("settings", { method: "POST", body: { quiet_start: p[0], quiet_end: p[1] } }).then(function (d) {
            okOrThrow(d); S.me.prefs = d.prefs || S.me.prefs; render();
          }).catch(function (e) { toast(errText(e.code)); }).finally(function () { S.busyPref = false; });
        } }, p[2]));
    });
    return h("div", { class: "tg-row col" },
      h("span", { class: "tg-text" }, h("span", { class: "tg-title" }, icon("bell"), "Тихие часы (UTC)"),
        h("span", { class: "tg-sub", text: "В это окно сигналы, прогресс и смена тренда приходят без звука" })),
      seg);
  }
  function toggleRow(titleNodes, sub, sw, cls) {
    return h("label", { class: "tg-row" + (cls ? " " + cls : "") },
      h("span", { class: "tg-text" }, h("span", { class: "tg-title" }, titleNodes), sub ? h("span", { class: "tg-sub", text: sub }) : null),
      sw);
  }

  function toggleStrategy(key, side, value, inp) {
    var c = stratCfg(key);
    if (S.busyToggle) { inp.checked = !value; return; }
    if (c.locked) { inp.checked = false; hap("warning"); toast(errText("pro_required"), true); return; }
    // Send exactly what the user sees: a strategy that is not running shows
    // both directions OFF, so flags left over from earlier are not revived.
    var body = { strategy: key, long: side === "long" ? value : c.long, short: side === "short" ? value : c.short };
    S.busyToggle = true;
    hap("light");
    api("strategy", { method: "POST", body: body }).then(function (d) {
      okOrThrow(d);
      if (d.strategies) S.me.strategies = d.strategies;
      if (d.strategy) S.me.strategy = d.strategy;
      hap("success");
      var nc = stratCfg(key);
      toast(stratName(key) + " · " + side.toUpperCase() + (value ? " включён" : " выключен") +
        (value && nc.enabled && !nc.primary ? " — параллельно с основной" : ""));
    }).catch(function (e) {
      inp.checked = !value;
      hap("error");
      if (e.code !== "unauthorized") toast(errText(e.code === "pro_required" && body.long && body.short && !c.locked ? "both_dirs" : e.code), true);
    }).then(function () {
      S.busyToggle = false;
      rerender("profile");
    });
  }

  function setPref(key, value, inp, prev) {
    if (S.busyPref) { inp.checked = prev; return; }
    var body = {};
    body[key] = value;
    S.busyPref = true;
    hap("light");
    api("settings", { method: "POST", body: body }).then(function (d) {
      okOrThrow(d);
      S.me.prefs = d.prefs || S.me.prefs;
      if (key === "genome_auto_apply" && S.genome && !S.genome.hidden) S.genome.auto_apply = !!value;
      hap("success");
    }).catch(function (e) {
      inp.checked = prev;
      hap("error");
      if (e.code !== "unauthorized") toast(errText(e.code), true);
    }).then(function () {
      S.busyPref = false;
      rerender("profile");
    });
  }

  function loadGenome() {
    if (S.genomeLoading) return;
    S.genomeLoading = true;
    api("genome").then(function (d) {
      if (!d || d.ok === false || typeof d !== "object") throw new ApiError((d && d.error) || "not_found");
      S.genome = d;
    }).catch(function () {
      S.genome = { hidden: true };   // endpoint missing / failing → hide the block
    }).then(function () {
      S.genomeLoading = false;
      rerender("profile");
    });
  }

  function applyGenome(k) {
    if (S.busyGenome) return;
    S.busyGenome = true;
    hap("medium");
    rerender("profile");
    api("genome/apply", { method: "POST", body: { strategy: k } }).then(function (d) {
      okOrThrow(d);
      if (S.genome && S.genome.strategies && S.genome.strategies[k]) S.genome.strategies[k].applied = true;
      hap("success");
      toast("Геном применён: " + stratName(k));
    }).catch(function (e) {
      hap("error");
      if (e.code !== "unauthorized") toast(errText(e.code), true);
    }).then(function () {
      S.busyGenome = false;
      rerender("profile");
    });
  }

  function strategyCard(k) {
    var c = stratCfg(k);
    var u = S.me.user || {};
    var ps = (((S.dash || {}).stats || {}).per_strategy || {})[k];
    var card = h("div", { class: "card strat-card" + (c.enabled ? " is-on" : "") + (c.locked ? " is-locked" : "") },
      h("div", { class: "strat-card-head" },
        h("span", { class: "srow-art sm" }, icon(k)),
        h("div", { style: "min-width:0;flex:1" },
          h("div", { class: "row", style: "gap:6px" }, label(bracket(STRATS[k].n)), h("span", { class: "cond", text: STRATS[k].full })),
          h("div", { class: "desc", text: STRATS[k].desc })),
        h("div", { class: "tags-col" }, stratStatusTags(c))));
    if (ps && num(ps.signals) && !c.locked) {
      card.appendChild(h("div", { class: "mini-stats line" },
        h("span", null, label("WR"), h("b", { text: num(ps.trades) ? (num(ps.win_rate) || 0).toFixed(1) + "%" : "—" })),
        h("span", null, label("Итог"), h("b", { class: signCls(ps.total_rr), text: num(ps.trades) ? fmtR(ps.total_rr) : "—" })),
        h("span", null, label("7д"), h("b", { class: signCls(ps.rr_7d), text: num(ps.trades) ? fmtR(ps.rr_7d) : "—" })),
        h("span", null, label("Сигн."), h("b", { text: String(ps.signals) }))));
    }
    if (c.locked) {
      card.appendChild(h("div", { class: "lock-cta" },
        h("p", { text: "Доступно в Pro — работает параллельно с вашими стратегиями" }),
        h("button", { class: "btn btn-red btn-sm", type: "button", onclick: openCheckout }, "Pro")));
      return card;
    }
    ["long", "short"].forEach(function (side) {
      var on = c[side];
      card.appendChild(toggleRow(
        [h("span", { class: "dir " + side, text: side === "long" ? "▲ LONG" : "▼ SHORT" })],
        side === "long" ? "Сигналы на покупку" : "Сигналы на продажу",
        switchEl(on, { cls: side, aria: STRATS[k].full + " " + side.toUpperCase(), onChange: function (v, inp) { toggleStrategy(k, side, v, inp); } }),
        "dense"));
    });
    if (!u.is_pro && k === "LEVELS") card.appendChild(h("div", { class: "tg-foot", text: "Free: одно направление — LONG или SHORT" }));
    return card;
  }

  function genomeBlock() {
    var g = S.genome;
    if (g === null) { loadGenome(); return h("div", null, sectionTitle("Геном"), skeleton(160)); }
    if (!g || g.hidden) return null;
    var wrap = h("div", null, sectionTitle("Геном"));
    if (!g.available) {
      wrap.appendChild(h("div", { class: "card genome locked" },
        h("div", { class: "g-lock" }, icon("dna"),
          h("div", null,
            h("div", { class: "cond", text: "Strategy Genome" }),
            h("p", { text: "Генетический алгоритм подбирает параметры стратегий под текущий рынок и применяет лучшие. Доступно в Pro." }))),
        h("button", { class: "btn btn-red btn-block", type: "button", onclick: openCheckout }, "Открыть в Pro", icon("bolt"))));
      return wrap;
    }
    var prefs = S.me.prefs || {};
    var auto = prefs.genome_auto_apply != null ? !!prefs.genome_auto_apply : !!g.auto_apply;
    var card = h("div", { class: "card genome" });
    card.appendChild(toggleRow([icon("dna"), "Авто-применение генома"],
      "Лучший найденный набор параметров включается сам",
      switchEl(auto, { aria: "Авто-применение генома", onChange: function (v, inp) { setPref("genome_auto_apply", v, inp, !v); } })));
    var gs = g.strategies || {};
    STRAT_ORDER.forEach(function (k) {
      var x = gs[k];
      if (!x) return;
      var gen = num(x.generation);
      var wr = num(x.win_rate);
      var pf = num(x.profit_factor), tr = num(x.trades);
      var row = h("div", { class: "g-row" },
        h("div", { class: "g-head" },
          h("div", { class: "row", style: "gap:6px;min-width:0" }, label(bracket(STRATS[k].n)), h("span", { class: "strat-name", text: STRATS[k].name })),
          gen === null ? tag("Нет данных", "off") : x.applied ? tag("Применён", "on")
            : h("button", { class: "btn btn-dark btn-sm g-apply", type: "button", disabled: S.busyGenome ? true : null,
                onclick: function () { applyGenome(k); } }, "Применить")));
      if (gen === null) {
        row.appendChild(h("div", { class: "g-empty", text: "Эволюция ещё не запускалась" }));
      } else {
        row.appendChild(h("div", { class: "g-kv" },
          h("span", null, label("Поколение"), h("b", { text: String(gen) })),
          h("span", null, label("WR"), h("b", { text: wr === null ? "—" : wr.toFixed(1) + "%" })),
          h("span", null, label("PF"), h("b", { class: pf === null ? "" : pf >= 1 ? "up" : "down", text: pf === null ? "—" : pf.toFixed(2) })),
          tr !== null ? h("span", null, label("Сделок"), h("b", { text: String(tr) }))
            : h("span", null, label("ТФ"), h("b", { text: x.timeframe ? String(x.timeframe).toUpperCase() : "—" }))));
        row.appendChild(h("div", { class: "g-foot" }, label("Эволюция: " + (num(x.updated_at) ? fmtDate(x.updated_at) + " · " + ago(x.updated_at) : "—"))));
      }
      card.appendChild(row);
    });
    wrap.appendChild(card);
    return wrap;
  }

  function profileSkeleton() {
    return h("div", null, skeleton(84), skeleton(120, "margin-top:8px"), skeleton(26, "margin-top:28px;width:50%"),
      skeleton(150, "margin-top:12px"), skeleton(150, "margin-top:8px"));
  }

  function renderProfile() {
    var root = h("div", { class: "screen" });
    root.appendChild(heading("Профиль", "center"));
    if (!S.me) { root.appendChild(profileSkeleton()); return root; }
    var u = S.me.user || {};
    var name = u.first_name || u.username || "Трейдер";

    root.appendChild(h("div", { class: "card user-card" },
      h("div", { class: "avatar", text: String(name).trim().charAt(0).toUpperCase() || "?" }),
      h("div", { style: "min-width:0;flex:1" },
        h("div", { class: "user-name", text: name }),
        h("div", { class: "row", style: "margin-top:6px;flex-wrap:wrap" },
          u.username ? label("@" + u.username, "label-b") : null,
          label(bracket("ID " + (u.id != null ? u.id : "—")))))));

    // Plan
    var dl = daysLeft(u.sub_expires);
    var plan = h("div", { class: "card plan" + (u.is_pro ? " is-pro" : "") },
      h("div", { class: "plan-top" },
        h("div", null, label("[Тариф]"), h("div", { class: "plan-name", text: u.plan_label || (u.is_pro ? "Pro" : "Free") })),
        u.is_pro ? h("div", { class: "ta-r" }, label("[Действует до]"), h("b", { text: fmtDate(u.sub_expires) }),
          dl !== null ? h("div", { class: "label label-b", text: "осталось " + dl + " " + plural(dl, "день", "дня", "дней") }) : null) : null),
      u.is_pro ? null : h("ul", { class: "plan-perks" },
        h("li", { text: "3 стратегии параллельно" }), h("li", { text: "LONG + SHORT одновременно" }),
        h("li", { text: "Strategy Genome и автотрейд" })),
      h("button", { class: "btn btn-block " + (u.is_pro ? "btn-dark" : "btn-red"), type: "button", onclick: function () { openSub("plan"); } },
        u.is_pro ? "Продлить Pro" : "Оформить Pro", icon("bolt")));
    root.appendChild(plan);
    root.appendChild(h("div", { class: "card kv" },
      h("div", null, label("[Автотрейд]"), h("b", { class: S.me.auto_trade ? "up" : "muted", text: S.me.auto_trade ? "ВКЛ" : "ВЫКЛ" })),
      h("div", null, label("[Биржа]"), h("b", { text: S.me.exchange ? String(S.me.exchange).toUpperCase() : "—" }))));

    // Settings area (bot functions inside the app)
    root.appendChild(sectionTitle("Настройки", bracket("Все"), function () { openSub("settings"); }));
    root.appendChild(settingsTiles(["strategies", "autotrade", "risk", "exchanges", "positions", "stats"], true));

    // Strategies (parallel)
    var on = enabledKeys();
    root.appendChild(sectionTitle("Стратегии"));
    root.appendChild(h("div", { class: "card note" },
      h("b", { text: on.length ? "В работе: " + on.map(stratName).join(" + ") + ". " : "Все стратегии выключены. " }),
      PARALLEL_NOTE + " Основная — та, что открывается в меню и настройках бота."));
    STRAT_ORDER.forEach(function (k) { root.appendChild(strategyCard(k)); });

    // Notifications / format
    var prefs = S.me.prefs || {};
    root.appendChild(sectionTitle("Уведомления"));
    var pc = h("div", { class: "card prefs" });
    pc.appendChild(toggleRow([icon("bell"), "Отработка сигнала"], "Сообщение при TP1 → БУ / TP2 / TP3 / SL",
      switchEl(prefs.progress_notify_enabled, { aria: "Уведомления об отработке сигнала", onChange: function (v, inp) { setPref("progress_notify_enabled", v, inp, !v); } })));
    pc.appendChild(toggleRow([icon("chart"), "График к сигналу"], "Картинка с уровнями входа, стопа и целей",
      switchEl(prefs.send_chart_enabled, { aria: "График к сигналу", onChange: function (v, inp) { setPref("send_chart_enabled", v, inp, !v); } })));
    pc.appendChild(toggleRow([icon("bolt"), "Лайт-формат сигнала"], "Короткая карточка: монета, вход, стоп, цели",
      switchEl(prefs.signal_format === "lite", { aria: "Лайт-формат сигнала", onChange: function (v, inp) { setPref("signal_format", v ? "lite" : "full", inp, !v); } })));
    pc.appendChild(quietHoursRow(prefs));   // [QUIET-HOURS]
    root.appendChild(pc);

    var gb = genomeBlock();
    if (gb) root.appendChild(gb);

    // App preferences (local): sound + haptics
    root.appendChild(sectionTitle("Приложение"));
    var ac = h("div", { class: "card prefs" });
    ac.appendChild(toggleRow([icon("sound"), "Звук и вибрация"], "Приветственный сигнал и тактильный отклик",
      switchEl(FX ? FX.enabled() : false, { aria: "Звук и вибрация", disabled: !FX, onChange: function (v) {
        if (!FX) return;
        FX.setEnabled(v);
        if (v) { FX.chime(); }
        toast(v ? "Звук и вибрация включены" : "Звук и вибрация выключены");
      } })));
    ac.appendChild(h("button", { class: "tg-row dense", type: "button", style: "width:100%;text-align:left", onclick: function () { openSub("lang"); } },
      h("span", { class: "tg-text" }, h("span", { class: "tg-title" }, icon("globe"), "Язык бота"),
        h("span", { class: "tg-sub", text: (u.lang === "en" ? "English" : "Русский") + " · сообщения и меню бота" })),
      h("span", { class: "icon-btn", style: "border:0;background:transparent" }, icon("chev"))));
    // Site account (password, 2FA, sessions, Telegram link, push) lives on settings.html.
    ac.appendChild(h("a", { class: "tg-row dense", href: ACCOUNT_URL, style: "width:100%;text-decoration:none;color:inherit" },
      h("span", { class: "tg-text" }, h("span", { class: "tg-title" }, icon("shield"), "Аккаунт и безопасность"),
        h("span", { class: "tg-sub", text: (u.email ? String(u.email) + " · " : "") + "пароль, 2FA, сессии, Telegram, push" })),
      h("span", { class: "icon-btn", style: "border:0;background:transparent" }, icon("chev"))));
    root.appendChild(ac);

    root.appendChild(h("div", { class: "stack" },
      h("button", { class: "btn btn-red btn-block", type: "button", onclick: function () { openSub("settings"); } }, "Все настройки", icon("sliders")),
      h("button", { class: "btn btn-dark btn-block", type: "button", onclick: logout }, "Выйти", icon("x"))));
    return root;
  }

  // ---------------------------------------------------------------------------
  // SETTINGS AREA — the bot's functions inside the app (Profile tab sub-screens)
  //   S.sub = "settings" (root) | section id.  Coded against miniapp/API.md
  //   "Новое": any ok:false / 404 / network error renders a placeholder card.
  // ---------------------------------------------------------------------------
  var SECTIONS = [
    { id: "strategies", t: "Стратегии", sub: "Таймфреймы, направления, фильтры", ic: "sliders" },
    { id: "autotrade", t: "Авто-трейд", sub: "Режим, биржа, риск, плечо", ic: "bolt" },
    { id: "risk", t: "Risk Management", sub: "Серии стопов, дневной лимит", ic: "shield" },
    { id: "challenge", t: "Челлендж", sub: "Цель, план, дисциплина", ic: "star" },
    { id: "exchanges", t: "Биржи", sub: "API-ключи: Bybit, BingX, Binance, OKX", ic: "key" },
    { id: "positions", t: "Позиции", sub: "Открытые позиции и PnL", ic: "layers" },
    { id: "stats", t: "Статистика", sub: "EV, PF, сессии, дни недели", ic: "bars" },
    { id: "advanced", t: "Расширенные настройки", sub: "Параметры из меню бота", ic: "sliders" },
    { id: "plan", t: "Тариф", sub: "Pro и оплата", ic: "star" },
    { id: "help", t: "Помощь", sub: "Как работает бот", ic: "help" },
    { id: "feedback", t: "Обратная связь", sub: "Баг, идея, вопрос", ic: "msg" },
    { id: "lang", t: "Язык", sub: "Русский / English", ic: "globe" }
  ];
  var SECTION_IDS = ["settings"].concat(SECTIONS.map(function (x) { return x.id; }));
  var EXCHANGES = ["bybit", "bingx", "binance", "okx"];
  var EX_NAME = { bybit: "Bybit", bingx: "BingX", binance: "Binance", okx: "OKX" };
  function exName(e) { return EX_NAME[e] || String(e || "").toUpperCase(); }
  function sectionMeta(id) { return SECTIONS.filter(function (x) { return x.id === id; })[0] || null; }

  // `replace` = step back in place (deep link without a history entry of ours).
  function openSub(id, replace) {
    if (S.detail) closeDetail(true);
    hap("light");
    S.tab = "profile"; S.sub = id;
    syncTabs();
    window.scrollTo(0, 0);
    render();
    if (replace) navReplace(); else navPush();
  }
  function rerenderSub() { if (S.tab === "profile" && S.sub && !S.detail) rerender("profile"); }

  // Generic section loader with a 30 s cache. Any failure (ok:false, 404, timeout,
  // network) is kept as `err` and rendered as a graceful placeholder.
  function secLoad(key, path, force) {
    var c = S.sec[key];
    if (c && (c.loading || (!force && c.data && Date.now() - c.at < 30000))) return;
    S.sec[key] = { loading: true, data: c ? c.data : null, at: c ? c.at : 0 };
    api(path, { timeout: 15000 }).then(function (d) {
      if (!d || typeof d !== "object" || !d.ok) throw new ApiError((d && d.error) || "unavailable");
      S.sec[key] = { data: d, at: Date.now() };
    }).catch(function (e) {
      S.sec[key] = { err: (e && e.code) || "unavailable", at: Date.now(), data: null };
    }).then(function () { rerenderSub(); });
  }
  function secSkeleton() { return h("div", null, skeleton(110, "margin-top:8px"), skeleton(190, "margin-top:8px"), skeleton(120, "margin-top:8px")); }
  function unavailableCard(onRetry, text) {
    return h("div", { class: "card empty" }, icon("none"),
      h("div", { class: "cond", text: "Раздел недоступен" }),
      h("div", { text: text || "Сервер не ответил или функция ещё не подключена. Попробуйте позже." }),
      h("div", { class: "row center mt16" },
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: function () { hap("light"); onRetry(); } }, "Повторить", icon("refresh"))));
  }
  function hintCard(text, cls, btn) {
    return h("div", { class: "card hint-card" + (cls ? " " + cls : "") }, icon(cls === "ok" ? "check" : "warn"),
      h("div", { style: "min-width:0;flex:1" }, h("div", { text: text }), btn ? h("div", { class: "mt8" }, btn) : null));
  }
  function subHeader(title, right) {
    var wrap = h("div", null);
    wrap.appendChild(h("button", { class: "back", type: "button", onclick: goBack }, icon("back"), S.sub === "settings" ? "Профиль" : "Настройки"));
    wrap.appendChild(h("div", { class: "sub-head" }, h("div", { class: "h1", text: title }), right || null));
    return wrap;
  }
  function refreshBtn(fn, busy) {
    return h("button", { class: "icon-btn" + (busy ? " spin" : ""), type: "button", "aria-label": "Обновить", onclick: function () { hap("light"); fn(); } }, icon("refresh"));
  }

  // --- settings/all access, locks, saving --------------------------------------
  function settingsData() { var c = S.sec.settings; return c && c.data ? c.data : null; }
  function settingsGate(root, render) {
    var c = S.sec.settings;
    if (!c || (c.loading && !c.data)) { secLoad("settings", "settings/all"); root.appendChild(secSkeleton()); return; }
    if (!c.data) { root.appendChild(unavailableCard(function () { secLoad("settings", "settings/all", true); rerenderSub(); })); return; }
    render(c.data.settings || {}, c.data.options || {});
  }
  function lockedList() { var d = settingsData(); return (d && d.options && Array.isArray(d.options.locked)) ? d.options.locked : []; }
  // options.locked: exact "trading.auto_trade", wildcard "smc.*" / "smc", or "*".
  function isLocked(key) {
    var L = lockedList(), sec = key.split(".")[0];
    for (var i = 0; i < L.length; i++) {
      var k = String(L[i]);
      if (k === key || k === sec + ".*" || k === sec || k === "*") return true;
    }
    return false;
  }
  function lockBadge() { return h("span", { class: "tag locked" }, icon("lock"), "Pro"); }
  function lockedTap() { hap("warning"); toast(errText("pro_required"), true); }
  // Body of POST settings/all for one key: `sec` may be a dotted path into the D9
  // sections ("levels.shared", "levels.long", "smc.advanced", "risk.advanced").
  function settingsBody(sec, key, value) {
    var body = {}, b = body;
    (sec ? sec.split(".") : []).forEach(function (sg) { b = b[sg] = {}; });
    b[key] = value;
    return body;
  }
  // sec === "" → a top-level key of settings/all (lang, ui_mode, genome_auto_apply, …)
  function saveSetting(sec, key, value) {
    var d = settingsData();
    if (!d) return;
    var st = d.settings = d.settings || {};
    var segs = sec ? sec.split(".") : [];
    var tgt = st;
    segs.forEach(function (sg) { tgt = tgt[sg] = (tgt[sg] && typeof tgt[sg] === "object") ? tgt[sg] : {}; });
    // [AUDIT F-5] повторный тап по тому же контролу, пока запрос в полёте — игнорируем;
    // ответы применяем только от последнего запроса (иначе «поздний» откатывал значение)
    S.savingKeys = S.savingKeys || {};
    var slot = sec + "." + key;
    if (S.savingKeys[slot]) return;
    S.savingKeys[slot] = true;
    S.saveSeq = (S.saveSeq || 0) + 1;
    var seq = S.saveSeq;
    var prev = tgt[key];
    tgt[key] = value;   // optimistic
    var body = settingsBody(sec, key, value);
    S.saving++;
    rerenderSub();          // сразу показываем новое значение
    api("settings/all", { method: "POST", body: body, timeout: 15000 }).then(function (r) {
      okOrThrow(r);
      if (seq === S.saveSeq) {
        if (r.settings && typeof r.settings === "object") d.settings = r.settings;
        if (r.options && typeof r.options === "object") d.options = r.options;
      }
      if (segs[0] === "trading" && S.me) {
        var T = d.settings.trading || {};
        S.me.auto_trade = !!T.auto_trade;
        if (T.trade_exchange != null) S.me.exchange = T.trade_exchange;
      }
      hap("success");
      toast("Сохранено");
    }).catch(function (e) {
      tgt[key] = prev;
      hap("error");
      if (e.code === "pro_required") toast(errText("pro_required"), true);
      else if (e.code !== "unauthorized") toast(errText(e.code), true);
    }).then(function () { S.saving--; delete S.savingKeys[slot]; rerenderSub(); });
  }
  // Server-side actions carried by settings/all (`levels.long.reset`, `risk.advanced.reset_all_filters`):
  // no optimistic value, the response `settings` replaces the cache.
  function actionSetting(sec, key, value, doneText) {
    var d = settingsData();
    if (!d) return;
    var slot = "action:" + sec + "." + key;
    S.savingKeys = S.savingKeys || {};
    if (S.savingKeys[slot]) return;
    S.savingKeys[slot] = true;
    hap("medium");
    api("settings/all", { method: "POST", body: settingsBody(sec, key, value), timeout: 15000 }).then(function (r) {
      okOrThrow(r);
      if (r.settings && typeof r.settings === "object") d.settings = r.settings;
      if (sec === "risk.advanced" && S.me && d.settings.trading) S.me.auto_trade = !!d.settings.trading.auto_trade;
      hap("success");
      toast(doneText || "Сохранено");
    }).catch(function (e) {
      hap("error");
      if (e.code !== "unauthorized") toast(errText(e.code), true);
    }).then(function () { delete S.savingKeys[slot]; rerenderSub(); });
  }

  // --- controls -------------------------------------------------------------
  function ctlRow(title, sub, control, locked, inline) {
    return h("div", { class: "ctl" + (locked ? " is-locked" : "") + (inline ? " inline" : "") },
      h("div", { class: "ctl-head" }, h("div", { class: "ctl-text" },
        h("span", { class: "ctl-title" }, title, locked ? lockBadge() : null),
        sub ? h("span", { class: "ctl-sub", text: sub }) : null)),
      h("div", { class: "ctl-body" }, control));
  }
  // opts: [value] or [{v, l, dot}]
  function seg(opts, value, onPick, locked, fmt, grow) {
    var wrap = h("div", { class: "seg" + (grow ? " grow" : "") });
    opts.forEach(function (o) {
      var isObj = o && typeof o === "object";
      var v = isObj ? o.v : o;
      var l = isObj ? o.l : (fmt ? fmt(o) : String(o));
      var on = String(v) === String(value);
      wrap.appendChild(h("button", { class: "seg-b" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false",
        onclick: function () { if (locked) return lockedTap(); if (on) return; hap("select"); onPick(v); } },
        isObj && o.dot ? h("i", { class: "dot", "aria-hidden": "true" }) : null, l));
    });
    return wrap;
  }
  function stepper(value, min, max, step, onChange, locked, unit, fmt) {
    var v = num(value); if (v === null) v = min;
    var digits = (String(step).split(".")[1] || "").length;
    var show = function (x) { return (fmt ? fmt(x) : x.toFixed(digits)) + (unit || ""); };
    var val = h("b", { text: show(v) });
    var timer = null;
    function set(nv) {
      if (locked) return lockedTap();
      nv = Math.min(max, Math.max(min, Math.round(nv / step) * step));
      nv = +nv.toFixed(digits);
      if (nv === v) { hap("warning"); return; }
      v = nv; val.textContent = show(v); hap("select");
      clearTimeout(timer); timer = setTimeout(function () { onChange(v); }, 700);
    }
    return h("div", { class: "stepper" + (locked ? " is-locked" : "") },
      h("button", { class: "step-b", type: "button", "aria-label": "Меньше", onclick: function () { set(v - step); } }, "−"),
      val,
      h("button", { class: "step-b", type: "button", "aria-label": "Больше", onclick: function () { set(v + step); } }, "+"));
  }
  function segCtl(title, sub, sec, key, opts, fmt, grow) {
    var st = settingsData().settings || {};
    var locked = isLocked(sec + "." + key);
    return ctlRow(title, sub, seg(opts, (st[sec] || {})[key], function (v) { saveSetting(sec, key, v); }, locked, fmt, grow), locked);
  }
  function stepCtl(title, sub, sec, key, min, max, step, unit, fmt) {
    var st = settingsData().settings || {};
    var locked = isLocked(sec + "." + key);
    return ctlRow(title, sub, stepper((st[sec] || {})[key], min, max, step, function (v) { saveSetting(sec, key, v); }, locked, unit, fmt), locked, true);
  }
  function swCtl(title, sub, sec, key, cls) {
    var st = settingsData().settings || {};
    var cur = !!((st[sec] || {})[key]);
    var locked = isLocked(sec + "." + key);
    var sw = switchEl(cur, { aria: title, onChange: function (v, inp) {
      if (locked) { inp.checked = cur; lockedTap(); return; }
      saveSetting(sec, key, v);
    } });
    return toggleRow([title, locked ? lockBadge() : null], sub, sw, "dense" + (locked ? " is-locked" : "") + (cls ? " " + cls : ""));
  }
  function groupCard(title, sub, right, cls) {
    var card = h("div", { class: "card group" + (cls ? " " + cls : "") });
    card.appendChild(h("div", { class: "group-head" },
      h("div", { style: "min-width:0" }, h("div", { class: "cond", text: title }), sub ? h("div", { class: "desc", style: "margin:2px 0 0;font-size:10.5px", text: sub }) : null),
      right || null));
    return card;
  }
  function tfOpts(list, fallback) {
    var src = Array.isArray(list) && list.length ? list : fallback;
    return src.filter(function (t) { return String(t).toLowerCase() !== "5m"; });   // 5m is never offered
  }
  function tfLabel(v) { return String(v).toUpperCase(); }
  function volLabel(v) { var n = num(v) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : (n / 1e3).toFixed(0) + "K"; }
  function pctLabel(v) { return String(v) + "%"; }

  // --- root --------------------------------------------------------------
  function tileBadge(id) {
    var u = (S.me && S.me.user) || {};
    if (id === "autotrade") return !u.is_pro ? lockBadge() : (S.me && S.me.auto_trade ? tag("ВКЛ", "on") : tag("ВЫКЛ", "off"));
    if (id === "exchanges" && S.me && S.me.exchange) return tag(exName(S.me.exchange), "primary");
    if (id === "plan") return u.is_pro ? tag("PRO", "locked") : tag("FREE", "off");
    return null;
  }
  function settingsTiles(ids, wideAll) {
    var grid = h("div", { class: "tiles" });
    ids.forEach(function (id) {
      var m = sectionMeta(id);
      grid.appendChild(h("button", { class: "card tile", type: "button", "aria-label": m.t, onclick: function () { openSub(id); } },
        icon(m.ic), h("span", { class: "tile-t", text: m.t }), h("span", { class: "tile-s", text: m.sub }), tileBadge(id)));
    });
    if (wideAll) grid.appendChild(h("button", { class: "card tile wide", type: "button", onclick: function () { openSub("settings"); } },
      icon("gear"), h("span", { class: "tile-t", text: "Все настройки" }), h("span", { class: "tile-s", style: "margin-left:auto;display:inline-flex" }, icon("chev"))));
    return grid;
  }
  function applyProfile(name) {
    hap("medium");
    api("profile", { method: "POST", body: { name: name } }).then(function (d) {
      okOrThrow(d);
      if (d.settings && S.sec.settings) S.sec.settings = { data: { settings: d.settings, options: S.sec.settings.data && S.sec.settings.data.options }, at: Date.now(), loading: false };
      var sk = (d.skipped || []).filter(function (x) { return x.indexOf("strategy.") === 0 || x === "volume.min_quality"; });
      toast("Профиль применён" + (sk.length ? " (часть — только на Pro)" : ""));
      hap("success");
      api("me").then(function (m) { okOrThrow(m); S.me = m; setPlanBadge(); rerenderSub(); }).catch(function () { rerenderSub(); });
      secLoad("settings", "settings/all", true);
    }).catch(function (e) { toast(errText(e.code), true); });
  }
  function renderSettingsRoot(root) {
    root.appendChild(subHeader("Настройки"));
    var u = (S.me && S.me.user) || {};
    root.appendChild(h("div", { class: "card kv" },
      h("div", null, label("[Автотрейд]"), h("b", { class: S.me && S.me.auto_trade ? "up" : "muted", text: S.me && S.me.auto_trade ? "ВКЛ" : "ВЫКЛ" })),
      h("div", null, label("[Тариф]"), h("b", { class: u.is_pro ? "" : "muted", text: u.plan_label || (u.is_pro ? "Pro" : "Free") }))));
    // [PROFILES] пресеты в один тап
    var pc = groupCard("Профиль настроек", "Качество, риск, плечо, лимит сделок, контр-тренд, тихие часы и стратегии одним нажатием", null, "");
    pc.appendChild(h("div", { class: "row", style: "gap:8px;margin-top:10px" },
      h("button", { class: "btn btn-dark", style: "flex:1", type: "button", onclick: function () { applyProfile("conservative"); } }, "Консервативный"),
      h("button", { class: "btn btn-red", style: "flex:1", type: "button", onclick: function () { applyProfile("active"); } }, "Активный")));
    root.appendChild(pc);
    root.appendChild(h("div", { class: "eyebrow", text: "Торговля" }));
    root.appendChild(settingsTiles(["strategies", "autotrade", "risk", "challenge", "exchanges", "positions", "stats", "advanced"]));
    root.appendChild(h("div", { class: "eyebrow", text: "Аккаунт" }));
    root.appendChild(settingsTiles(["plan", "help", "feedback", "lang"]));
    secLoad("settings", "settings/all");   // prefetch for the sections
    return root;
  }
  function renderSub() {
    var root = h("div", { class: "screen" });
    if (S.sub === "settings") return renderSettingsRoot(root);
    var meta = sectionMeta(S.sub);
    if (!meta || !SECTION_RENDER[S.sub]) { S.sub = "settings"; return renderSettingsRoot(root); }
    root.appendChild(subHeader(meta.t, SECTION_RIGHT[S.sub] ? SECTION_RIGHT[S.sub]() : null));
    SECTION_RENDER[S.sub](root);
    return root;
  }

  // --- Стратегии --------------------------------------------------------------
  function stratGroup(k, cfg) {
    return groupCard(STRATS[k].full, STRATS[k].desc, h("div", { class: "tags-col" }, stratStatusTags(cfg)), cfg.enabled ? "glow-red" : "");
  }
  function secStrategies(root) {
    settingsGate(root, function (st, op) {
      root.appendChild(h("p", { class: "hint", style: "margin-top:0", text: "Направления LONG / SHORT включаются в профиле. Здесь — параметры движков каждой стратегии." }));
      var c = stratGroup("LEVELS", stratCfg("LEVELS"));
      c.appendChild(segCtl("Таймфрейм LONG", "Свечи для поиска лонгов", "levels", "long_tf", tfOpts(op.tf_levels, ["15m", "30m", "1h", "4h", "1d"]), tfLabel));
      c.appendChild(segCtl("Таймфрейм SHORT", "Свечи для поиска шортов", "levels", "short_tf", tfOpts(op.tf_levels, ["15m", "30m", "1h", "4h", "1d"]), tfLabel));
      c.appendChild(segCtl("Мин. объём за 24ч", "USDT — отсекает тонкие монеты", "levels", "min_volume_usdt", op.min_volume || [300000, 1000000, 5000000, 10000000, 25000000, 50000000], volLabel));
      c.appendChild(stepCtl("Мин. качество", "Сигналы ниже порога не отправляются", "levels", "min_quality", 1, 10, 1));
      c.appendChild(stepCtl("Мин. RR", "Цель к стопу, не меньше", "levels", "min_rr", 1, 5, 0.5, "R"));
      c.appendChild(stepCtl("Расстояние до уровня", "Макс. % от цены до уровня", "levels", "max_dist_pct", 0.5, 7, 0.5, "%"));
      c.appendChild(stepCtl("Ширина зоны", "% вокруг уровня", "levels", "zone_pct", 0.25, 3, 0.25, "%"));
      c.appendChild(stepCtl("Макс. риск на сделку", "% депозита при стопе", "levels", "max_risk_pct", 0.25, 5, 0.25, "%"));
      c.appendChild(swCtl("Фильтр RSI", "Не входить в перекупленность / перепроданность", "levels", "use_rsi"));
      c.appendChild(swCtl("Фильтр объёма", "Подтверждение объёмом на сигнальной свече", "levels", "use_volume"));
      c.appendChild(swCtl("Старший таймфрейм", "Сверять тренд на ТФ выше", "levels", "use_htf"));
      c.appendChild(swCtl("Только по тренду", "Без контртрендовых входов", "levels", "trend_only"));
      root.appendChild(c);

      var m = stratGroup("SMC", stratCfg("SMC"));
      m.appendChild(segCtl("Таймфрейм", "Рабочий ТФ для order blocks и FVG", "smc", "tf_key", tfOpts(op.tf_smc, ["15m", "1H", "4H"]), tfLabel));
      m.appendChild(segCtl("Направление", "Какие сетапы искать", "smc", "direction", [{ v: "BOTH", l: "Оба" }, { v: "LONG", l: "▲ Long" }, { v: "SHORT", l: "▼ Short" }], null, true));
      m.appendChild(segCtl("Мин. объём за 24ч", "USDT", "smc", "min_volume_usdt", op.min_volume || [300000, 1000000, 5000000, 10000000, 25000000, 50000000], volLabel));
      m.appendChild(stepCtl("Макс. стоп", "% от входа — шире не входим", "smc", "max_sl_pct", 0.5, 10, 0.5, "%"));
      m.appendChild(stepCtl("Интервал сканирования", "Секунд между проходами", "smc", "scan_interval", 60, 900, 60, " с"));
      root.appendChild(m);

      var v = stratGroup("VOLUME", stratCfg("VOLUME"));
      v.appendChild(segCtl("Таймфрейм", "Свечи для MA и объёма", "volume", "timeframe", tfOpts(op.tf_volume, ["15m", "1h", "4h"]), tfLabel));
      v.appendChild(segCtl("Тип скользящих", "SMA 10/20/50 или EMA 9/21", "volume", "ma_type", [{ v: "sma", l: "SMA" }, { v: "ema", l: "EMA" }], null, true));
      v.appendChild(stepCtl("Множитель объёма", "Объём свечи ≥ среднего × N", "volume", "vol_mult", 1, 5, 0.1, "×"));
      v.appendChild(stepCtl("Мин. качество", "Порог оценки сетапа (1–5)", "volume", "min_quality", 1, 5, 1));
      v.appendChild(swCtl("MA Cross", "Пересечение быстрой и медленной MA по тренду", "volume", "setup_cross"));
      v.appendChild(swCtl("MA Turn", "Разворот наклона MA20", "volume", "setup_turn"));
      v.appendChild(swCtl("EMA Bounce", "Отскок от EMA50 / EMA200 свечой отказа", "volume", "setup_bounce"));
      v.appendChild(swCtl("Golden / Death Cross", "EMA50 × EMA200", "volume", "setup_golden"));
      v.appendChild(swCtl("Откат к ленте", "Возврат над быстрой EMA после отката в ленту EMA 5–55", "volume", "setup_ribbon"));
      v.appendChild(swCtl("Старший таймфрейм", "Подтверждение тренда на ТФ выше", "volume", "use_htf"));
      root.appendChild(v);
      root.appendChild(h("div", { class: "stack" },
        h("button", { class: "btn btn-dark btn-block", type: "button", onclick: leaveSub }, "Направления L / S — в профиле", icon("arrow"))));
    });
  }

  // --- Авто-трейд --------------------------------------------------------------
  function secAutotrade(root) {
    settingsGate(root, function (st, op) {
      var T = st.trading || {}, ex = st.exchanges || {};
      var exList = Array.isArray(op.exchanges) && op.exchanges.length ? op.exchanges : EXCHANGES;
      var connected = exList.filter(function (e) { return ex[e] && ex[e].connected; });
      var c = groupCard("Авто-трейд", T.auto_trade ? "Сделки открываются автоматически" : "Сейчас только сигналы", T.auto_trade ? tag("ВКЛ", "on") : tag("ВЫКЛ", "off"), T.auto_trade ? "glow-red" : "");
      c.appendChild(swCtl("Включить авто-трейд", "Открывать позиции по сигналам на бирже", "trading", "auto_trade"));
      c.appendChild(segCtl("Режим", "Авто — сразу; Подтверждение — спросить в боте", "trading", "auto_trade_mode", [{ v: "auto", l: "Авто" }, { v: "confirm", l: "Подтверждение" }], null, true));
      c.appendChild(segCtl("Биржа", connected.length ? "Подключены: " + connected.map(exName).join(", ") : "Нет подключённых бирж", "trading", "trade_exchange",
        exList.map(function (e) { return { v: e, l: exName(e), dot: !!(ex[e] && ex[e].connected) }; })));
      root.appendChild(c);
      if (!connected.length) root.appendChild(hintCard("Без API-ключей автотрейд не сможет открыть позицию. Подключите биржу.", "warn",
        h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: function () { openSub("exchanges"); } }, "Биржи", icon("key"))));

      var r = groupCard("Размер позиции", "Сколько рискуем на сделку");
      r.appendChild(segCtl("Риск на сделку", "% депозита, который теряется при стопе", "trading", "trade_risk_pct", op.risk_pct || [0.25, 0.5, 1, 1.5, 2, 3], pctLabel));
      r.appendChild(segCtl("Плечо", "Кредитное плечо на бирже", "trading", "trade_leverage", op.leverage || [1, 2, 3, 5, 10, 20], function (x) { return x + "×"; }));
      r.appendChild(segCtl("Макс. сделок", "Одновременно открытых позиций", "trading", "max_trades_limit", op.max_trades || [1, 2, 3, 5, 10]));
      r.appendChild(segCtl("Расчёт размера", "Риск — от расстояния до стопа; Номинал — фикс. доля депозита", "trading", "risk_mode", [{ v: "risk", l: "По риску" }, { v: "notional", l: "По номиналу" }], null, true));
      root.appendChild(r);

      var m = groupCard("Исполнение", "Как ведётся открытая сделка");
      m.appendChild(swCtl("Частичный TP", "Часть позиции на TP1 / TP2, остаток до TP3", "trading", "partial_tp_enabled"));
      m.appendChild(swCtl("Авто-трейлинг", "Подтягивать стоп за ценой после TP1", "trading", "auto_trailing_enabled"));
      m.appendChild(swCtl("Вход по рынку", "Market-ордер вместо лимитного у входа", "trading", "prefer_market_entry"));
      m.appendChild(swCtl("Bybit Demo", "Торговать на демо-счёте Bybit", "trading", "bybit_demo"));
      root.appendChild(m);
    });
  }

  // --- Risk Management ----------------------------------------------------
  function secRisk(root) {
    settingsGate(root, function (st) {
      var R = st.risk || {};
      var g = groupCard("Защита депозита", "Не отключаются kill-switch'ем", icon("shield"));
      g.appendChild(swCtl("SL-streak guard", "Пауза автотрейда после серии стопов за 24 ч", "risk", "sl_streak_enabled"));
      g.appendChild(stepCtl("Порог серии", "Стопов подряд за 24 ч до паузы", "risk", "sl_streak_threshold", 2, 10, 1));
      g.appendChild(swCtl("Circuit Breaker", "Стоп торговли при дневном убытке в R", "risk", "circuit_breaker_enabled"));
      g.appendChild(stepCtl("Дневной лимит убытка", "0 — использовать глобальный лимит бота", "risk", "circuit_breaker_threshold_r", 0, 20, 0.5, "R"));
      root.appendChild(g);
      var f = groupCard("Фильтры входа", "Отсеивают слабые сигналы перед сделкой");
      f.appendChild(swCtl("Контртренд", "Разрешить входы против тренда старшего ТФ", "risk", "allow_counter_trend"));
      f.appendChild(swCtl("Только в тренде", "Торговать лишь в trending-режиме рынка", "risk", "trade_trending_only"));
      f.appendChild(swCtl("BTC-корреляция", "Блок, если BTC идёт против сигнала", "risk", "btc_correlation_block"));
      f.appendChild(swCtl("Проверка спреда", "Не входить при широком спреде", "risk", "spread_check_enabled"));
      f.appendChild(swCtl("Фильтр часов", "Пропускать исторически слабые часы", "risk", "hour_filter_enabled"));
      root.appendChild(f);
      var k = groupCard("Kill-switch", "Для опытных: выключает все фильтры входа", icon("warn"), R.filters_all_off ? "glow-red" : "");
      k.appendChild(swCtl("Все фильтры выкл", "Защита депозита (SL-streak, Circuit Breaker) остаётся", "risk", "filters_all_off", "danger"));
      root.appendChild(k);
      if (R.filters_all_off) root.appendChild(hintCard("Фильтры отключены: бот откроет сделку по любому сигналу стратегии.", "warn"));
    });
  }

  // --- Биржи -------------------------------------------------------------
  function inputEl(labelText, type, opts) {
    opts = opts || {};
    var inp = h("input", { class: "inp", type: type, placeholder: opts.placeholder || labelText, autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false", "aria-label": labelText, maxlength: "256" });
    var wrap = h("div", { class: "inp-wrap" }, inp);
    if (type === "password") {
      var eye = h("button", { class: "icon-btn", type: "button", "aria-label": "Показать", onclick: function () { hap("select"); inp.type = inp.type === "password" ? "text" : "password"; } }, icon("eye"));
      wrap.appendChild(eye);
    }
    return { wrap: h("div", null, h("span", { class: "label inp-label", text: bracket(labelText) }), wrap), input: inp };
  }
  function keyHint(k) { k = String(k || ""); return k.length > 6 ? k.slice(0, 4) + "…" + k.slice(-2) : "••••"; }
  function exchangeCard(e, info, isActive) {
    var open = S.exForm === e;
    var card = h("div", { class: "card ex-card" + (info.connected ? " is-on" : "") });
    card.appendChild(h("div", { class: "ex-head" },
      h("div", { class: "ex-name" },
        h("span", { class: "ex-logo", text: exName(e).slice(0, 2).toUpperCase() }),
        h("div", { style: "min-width:0" },
          h("div", { class: "ex-title", text: exName(e) }),
          h("div", { class: "ex-sub" }, info.connected ? ["Подключена · ключ ", h("b", { text: info.key_hint || "••••" })] : "Не подключена"))),
      h("div", { class: "tags-col" }, isActive ? tag("Активна", "primary") : null, info.connected ? tag("OK", "on") : null)));
    if (!open) {
      var act = h("div", { class: "btn-row mt12" });
      act.appendChild(h("button", { class: "btn btn-dark btn-sm", type: "button", onclick: function () { hap("light"); S.exForm = e; S.exRemoveArm = null; rerenderSub(); } },
        info.connected ? "Заменить ключи" : "Подключить", icon("key")));
      if (info.connected) {
        var armed = S.exRemoveArm === e;
        act.appendChild(h("button", { class: "btn btn-dark btn-sm" + (armed ? " danger" : ""), type: "button", disabled: S.exBusy, onclick: function () {
          if (!armed) { hap("warning"); S.exRemoveArm = e; rerenderSub(); setTimeout(function () { if (S.exRemoveArm === e) { S.exRemoveArm = null; rerenderSub(); } }, 4000); return; }
          removeKeys(e);
        } }, armed ? "Точно удалить?" : "Удалить", armed ? null : icon("x")));
      }
      card.appendChild(act);
      return card;
    }
    var key = inputEl("API Key", "text"), sec = inputEl("API Secret", "password"), pp = e === "okx" ? inputEl("Passphrase", "password") : null;
    var form = h("div", { class: "ex-form" }, key.wrap, sec.wrap, pp ? pp.wrap : null,
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-red", type: "button", disabled: S.exBusy, onclick: function () {
          var k = key.input.value.trim(), sc = sec.input.value.trim(), p = pp ? pp.input.value.trim() : "";
          if (!k || !sc || (pp && !p)) { hap("error"); toast("Заполните все поля", true); return; }
          submitKeys(e, k, sc, p);
        } }, S.exBusy ? "Проверяю…" : "Проверить и сохранить", icon("check")),
        h("button", { class: "btn btn-dark", type: "button", onclick: function () { hap("light"); S.exForm = null; rerenderSub(); } }, "Отмена")));
    card.appendChild(form);
    return card;
  }
  function submitKeys(e, k, sc, p) {
    if (S.exBusy) return;
    S.exBusy = true; hap("medium"); rerenderSub();
    var body = { exchange: e, api_key: k, api_secret: sc };
    if (p) body.passphrase = p;
    api("exchange/keys", { method: "POST", body: body, timeout: 30000 }).then(function (d) {
      if (!d || !d.ok) throw Object.assign(new ApiError((d && d.error) || "network"), { msg: d && d.message });
      var sd = settingsData();
      if (sd) {
        sd.settings = sd.settings || {}; sd.settings.exchanges = sd.settings.exchanges || {};
        sd.settings.exchanges[e] = { connected: true, key_hint: keyHint(k) };
        sd.settings.trading = sd.settings.trading || {}; sd.settings.trading.trade_exchange = e;
      }
      if (S.me) S.me.exchange = e;
      S.exForm = null;
      hap("success");
      var bal = num(d.balance_usdt);
      toast(exName(e) + " подключена" + (bal !== null ? " · баланс " + bal.toFixed(2) + " USDT" : ""));
    }).catch(function (e2) {
      hap("error");
      if (e2.code !== "unauthorized") toast(e2.msg ? String(e2.msg) : errText(e2.code), true);
    }).then(function () { S.exBusy = false; rerenderSub(); });
  }
  function removeKeys(e) {
    if (S.exBusy) return;
    S.exBusy = true; S.exRemoveArm = null; hap("medium"); rerenderSub();
    api("exchange/keys/remove", { method: "POST", body: { exchange: e }, timeout: 15000 }).then(function (d) {
      okOrThrow(d);
      var sd = settingsData();
      if (sd && sd.settings) {
        if (sd.settings.exchanges) sd.settings.exchanges[e] = { connected: false, key_hint: "" };
        if (sd.settings.trading && sd.settings.trading.trade_exchange === e) sd.settings.trading.trade_exchange = "";
      }
      if (S.me && S.me.exchange === e) S.me.exchange = "";
      hap("success"); toast("Ключи " + exName(e) + " удалены");
    }).catch(function (e2) {
      hap("error");
      if (e2.code !== "unauthorized") toast(errText(e2.code), true);
    }).then(function () { S.exBusy = false; rerenderSub(); });
  }
  function secExchanges(root) {
    settingsGate(root, function (st, op) {
      if (isLocked("trading.auto_trade")) {   // [UX-2 2026-10] паритет с ботом: ключи бирж — часть авто-трейда (Pro)
        root.appendChild(hintCard("Подключение бирж и авто-трейд доступны в тарифе Pro.", "ok"));
        root.appendChild(h("button", { class: "btn btn-red btn-block mt12", type: "button", onclick: function () { openSub("plan"); } }, "Оформить Pro", icon("bolt")));
        return;
      }
      var ex = st.exchanges || {}, cur = (st.trading || {}).trade_exchange || "";
      var exList = Array.isArray(op.exchanges) && op.exchanges.length ? op.exchanges : EXCHANGES;
      root.appendChild(hintCard("Ключи шифруются и хранятся на сервере бота. Нужны права на фьючерсы без вывода средств.", "ok"));
      exList.forEach(function (e) { root.appendChild(exchangeCard(e, ex[e] || {}, cur === e)); });
    });
  }

  // --- Позиции -------------------------------------------------------------
  function positionCard(p) {
    var pnl = num(p.pnl_usd), pct = num(p.pnl_pct);
    var long = String(p.side || "").toUpperCase() === "LONG" || String(p.side || "").toUpperCase() === "BUY";
    return h("div", { class: "card poscard" },
      h("div", { style: "min-width:0" },
        h("div", { class: "pos-sym" }, h("span", { text: String(p.symbol || "—").replace(/-USDT.*$|USDT$/i, "") }), h("span", { class: "dir " + (long ? "long" : "short"), text: long ? "▲ LONG" : "▼ SHORT" })),
        h("div", { class: "row", style: "gap:6px;margin-top:5px;flex-wrap:wrap" }, label(bracket(exName(p.exchange) + (num(p.leverage) ? " · " + num(p.leverage) + "×" : ""))))),
      h("div", { class: "pos-pnl" },
        h("b", { class: signCls(pnl), text: pnl === null ? "—" : sign(pnl) + "$" + Math.abs(pnl).toFixed(2) }),
        h("span", { class: "label " + signCls(pct), text: pct === null ? "" : fmtPct(pct) })),
      h("div", { class: "pos-kv" },
        h("span", null, label("Размер"), h("b", { text: num(p.size) !== null ? fmtPrice(p.size) : "—" })),
        h("span", null, label("Вход"), h("b", { text: fmtPrice(p.entry) })),
        h("span", null, label("Цена"), h("b", { class: signCls(pnl), text: fmtPrice(p.mark) }))));
  }
  function secPositions(root) {
    var c = S.sec.positions;
    if (!c || (c.loading && !c.data)) { secLoad("positions", "positions"); root.appendChild(secSkeleton()); return; }
    if (!c.data) { root.appendChild(unavailableCard(function () { secLoad("positions", "positions", true); rerenderSub(); },
      c.err === "unavailable" ? "Биржа не ответила за 8 секунд. Попробуйте ещё раз." : null)); return; }
    var list = Array.isArray(c.data.positions) ? c.data.positions : [];
    var sd = settingsData();
    var hasKeys = !!(S.me && S.me.exchange) || !!(sd && sd.settings && sd.settings.exchanges && Object.keys(sd.settings.exchanges).some(function (k) { return sd.settings.exchanges[k] && sd.settings.exchanges[k].connected; }));
    if (!list.length) {
      root.appendChild(emptyCard("Открытых позиций нет", hasKeys ? "Когда автотрейд откроет сделку — она появится здесь." : "Подключите биржу в разделе «Биржи» — позиции и PnL появятся здесь.",
        h("button", { class: "btn btn-dark btn-sm mt12", type: "button", onclick: function () { hasKeys ? openSub("autotrade") : openSub("exchanges"); } }, hasKeys ? "Авто-трейд" : "Биржи", icon("arrow"))));
      return;
    }
    var sum = 0, has = false;
    list.forEach(function (p) { var v = num(p.pnl_usd); if (v !== null) { sum += v; has = true; } });
    root.appendChild(h("div", { class: "card pos-sum" },
      h("div", null, label("Позиций"), h("b", { text: String(list.length) })),
      h("div", null, label("Σ PnL"), h("b", { class: signCls(sum), text: has ? sign(sum) + "$" + Math.abs(sum).toFixed(2) : "—" })),
      h("div", null, label("Ордеров"), h("b", { text: num(c.data.orders_count) !== null ? String(num(c.data.orders_count)) : "—" }))));
    list.forEach(function (p) { root.appendChild(positionCard(p)); });
    root.appendChild(h("p", { class: "desc", text: "Данные с биржи, обновляются при открытии раздела. PnL — нереализованный." }));
  }

  // --- Статистика -----------------------------------------------------------
  var WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  var SESSION = { asia: "Азия", europe: "Европа", us: "США" };
  function statsKey() { return "stats" + S.statsDays + (S.statsStrat || ""); }
  function loadStats(force) { secLoad(statsKey(), "stats?days=" + S.statsDays + (S.statsStrat ? "&strategy=" + S.statsStrat : ""), force); }
  function statBucketRow(name, x) {
    return h("div", { class: "srow2" }, h("span", { text: name }), h("span", { text: String(num(x.trades) || 0) }),
      h("span", { text: num(x.win_rate) === null ? "—" : num(x.win_rate).toFixed(0) + "%" }), h("span", { class: signCls(x.total_rr), text: fmtR(x.total_rr) }));
  }
  function statTable(rows) {
    var sc = h("div", { class: "card srows" });
    sc.appendChild(h("div", { class: "srow2 head" }, h("span", { text: "" }), h("span", { text: "Сделок" }), h("span", { text: "WR" }), h("span", { text: "Σ R" })));
    rows.forEach(function (r) { sc.appendChild(statBucketRow(r[0], r[1])); });
    return sc;
  }
  function secStats(root) {
    root.appendChild(seg([7, 30, 90], S.statsDays, function (v) { S.statsDays = v; rerenderSub(); loadStats(); }, false, function (d) { return d + " дн."; }, true));
    root.appendChild(seg([{ v: "", l: "Все" }].concat(STRAT_ORDER.map(function (k) { return { v: k, l: stratName(k) }; })), S.statsStrat,
      function (v) { S.statsStrat = v; rerenderSub(); loadStats(); }, false, null, true));
    var c = S.sec[statsKey()];
    if (!c || (c.loading && !c.data)) { loadStats(); root.appendChild(secSkeleton()); return; }
    if (!c.data) { root.appendChild(unavailableCard(function () { loadStats(true); rerenderSub(); })); return; }
    var d = c.data, sm = d.summary || {};
    var trades = num(sm.trades) || 0;
    if (!trades) { root.appendChild(emptyCard("Пока нет закрытых сделок", "Статистика появится после первых сигналов с итогом за выбранный период.")); return; }
    var pf = num(sm.profit_factor), ev = num(sm.ev), wr = num(sm.win_rate), pnl = num(sm.pnl_usd);
    root.appendChild(h("div", { class: "card sgrid" },
      h("div", null, label("Сделок"), h("b", { text: String(trades) })),
      h("div", null, label("Win rate"), h("b", { text: wr === null ? "—" : wr.toFixed(1) + "%" })),
      h("div", null, label("Σ R"), h("b", { class: signCls(sm.total_rr), text: fmtR(sm.total_rr) })),
      h("div", null, label("Avg R"), h("b", { class: signCls(sm.avg_rr), text: fmtR(sm.avg_rr, 2) })),
      h("div", null, label("PF"), h("b", { class: pf === null ? "" : pf >= 1 ? "up" : "down", text: pf === null ? "—" : pf.toFixed(2) })),
      h("div", null, label("EV"), h("b", { class: signCls(ev), text: ev === null ? "—" : fmtR(ev, 2) })),
      h("div", null, label("+ / − / БУ"), h("b", null, h("span", { class: "up", text: String(num(sm.wins) || 0) }), h("span", { class: "dim", text: "/" }), h("span", { class: "down", text: String(num(sm.losses) || 0) }), h("span", { class: "dim", text: "/" + (num(sm.be) || 0) }))),
      h("div", null, label("PnL $"), h("b", { class: signCls(pnl), text: pnl === null ? "—" : sign(pnl) + Math.abs(pnl).toFixed(0) }))));
    root.appendChild(h("p", { class: "hint", style: "margin-top:8px", text: "EV — ожидаемый результат одной сделки в R: WR × средний плюс − (1 − WR) × средний минус. PF — сумма плюсов к сумме минусов." }));

    var eq = Array.isArray(d.equity) ? d.equity : [];
    if (eq.length) {
      var last = num(eq[eq.length - 1].r);
      root.appendChild(h("div", { class: "card equity", style: "padding-bottom:10px" },
        h("div", { class: "eq-head" }, label("[Кривая R · " + S.statsDays + "д]"), last !== null ? rVal(last) : label("—")),
        equityPlot(eq)));
    }

    var bs = d.by_strategy || {};
    var bsKeys = STRAT_ORDER.filter(function (k) { return bs[k] && num(bs[k].trades); }).concat(Object.keys(bs).filter(function (k) { return STRAT_ORDER.indexOf(k) < 0 && num(bs[k].trades); }));
    if (bsKeys.length) {
      var sc = h("div", { class: "card srows" });
      sc.appendChild(h("div", { class: "srow2 head" }, h("span", { text: "Стратегия" }), h("span", { text: "Сделок" }), h("span", { text: "WR" }), h("span", { text: "Σ R" })));
      bsKeys.forEach(function (k) {
        var x = bs[k];
        sc.appendChild(h("div", { class: "srow2" }, h("span", { text: stratName(k) }), h("span", { text: String(num(x.trades) || 0) }),
          h("span", { text: num(x.win_rate) === null ? "—" : num(x.win_rate).toFixed(0) + "%" }), h("span", { class: signCls(x.total_rr), text: fmtR(x.total_rr) })));
      });
      root.appendChild(sectionTitle("По стратегиям"));
      root.appendChild(sc);
    }

    // [STATS-FILTERS] биржа vs сигналы, таймфреймы, лучшие/худшие монеты
    var src = d.by_source || {};
    if (num(src.exchange && src.exchange.trades) && num(src.signals && src.signals.trades)) {
      root.appendChild(sectionTitle("Биржа vs сигналы"));
      root.appendChild(statTable([["На бирже", src.exchange], ["Сигналы", src.signals]]));
      root.appendChild(h("p", { class: "hint", text: "«На бирже» — сделки, открытые автотрейдингом; «Сигналы» — итог по цене сигнала (TP/SL по трекеру)." }));
    }
    // [TREND-CTX] результат по контексту тренда BTC — проверка бонусов/штрафов цифрами
    var bc = d.by_context || {};
    var CTX = [["aligned", "Все ТФ"], ["with", "По тренду"], ["counter", "Против тренда"], ["strong_counter", "Против сильного"]];
    var ctxRows = CTX.filter(function (c) { return num(bc[c[0]] && bc[c[0]].trades); }).map(function (c) { return [c[1], bc[c[0]]]; });
    if (ctxRows.length) {
      root.appendChild(sectionTitle("По контексту тренда"));
      var ctxT = statTable(ctxRows); ctxT.classList.add("srows-wide");
      root.appendChild(ctxT);
      root.appendChild(h("p", { class: "hint", text: "Контекст фиксируется в момент сигнала по тренду BTC. Если «против тренда» стабильно в минусе, а «все ТФ» в плюсе — бонус и штраф к качеству работают; если нет, пороги стоит подвинуть." }));
    }
    var btf = d.by_timeframe || {};
    var tfKeys = Object.keys(btf).filter(function (k) { return num(btf[k].trades); });
    if (tfKeys.length > 1) {
      root.appendChild(sectionTitle("По таймфреймам"));
      root.appendChild(statTable(tfKeys.map(function (k) { return [k.toUpperCase(), btf[k]]; })));
    }
    var bsym = d.by_symbol || {};
    if ((bsym.best || []).length || (bsym.worst || []).length) {
      root.appendChild(sectionTitle("Монеты за период"));
      var symRows = (bsym.best || []).map(function (x) { return ["🟢 " + x.symbol, x]; })
        .concat((bsym.worst || []).map(function (x) { return ["🔴 " + x.symbol, x]; }));
      root.appendChild(statTable(symRows));
    }

    var ss = d.by_session || {};
    var sKeys = ["asia", "europe", "us"].filter(function (k) { return ss[k]; });
    if (sKeys.length) {
      root.appendChild(sectionTitle("По сессиям"));
      var sg = h("div", { class: "card sgrid", style: "grid-template-columns:repeat(3,minmax(0,1fr))" });
      sKeys.forEach(function (k, i) {
        var x = ss[k] || {};
        sg.appendChild(h("div", { style: i ? "" : "border-left:0" }, label(SESSION[k] || k),
          h("b", { class: signCls(x.total_rr), text: num(x.trades) ? fmtR(x.total_rr) : "—" }),
          h("span", { class: "label", text: num(x.trades) ? (num(x.trades) + " · WR " + (num(x.win_rate) || 0).toFixed(0) + "%") : "нет сделок" })));
      });
      root.appendChild(sg);
    }

    var bw = Array.isArray(d.by_weekday) ? d.by_weekday : [];
    if (bw.length) {
      root.appendChild(sectionTitle("По дням недели"));
      var mx = 0;
      bw.forEach(function (x) { mx = Math.max(mx, Math.abs(num(x && x.total_rr) || 0)); });
      var bars = h("div", { class: "card pad wbars" });
      for (var i = 0; i < 7; i++) {
        var x = bw[i] || {};
        var r = num(x.total_rr) || 0, t = num(x.trades) || 0;
        var hgt = mx ? Math.max(4, Math.abs(r) / mx * 100) : 4;
        bars.appendChild(h("div", { class: "wbar" + (!t ? " zero" : r < 0 ? " neg" : ""), title: WD[i] + ": " + t + " сделок, " + fmtR(r) },
          h("span", { class: "wv", text: t ? fmtR(r) : "—" }),
          h("div", { class: "wb" }, h("i", { style: "--h:" + hgt.toFixed(0) + "%" })),
          label(WD[i])));
      }
      root.appendChild(bars);
    }
  }

  // --- Тариф -----------------------------------------------------------------
  function secPlan(root) {
    var c = S.sec.plan;
    if (!c || (c.loading && !c.data)) { secLoad("plan", "plan"); root.appendChild(secSkeleton()); return; }
    if (!c.data) { root.appendChild(unavailableCard(function () { secLoad("plan", "plan", true); rerenderSub(); })); return; }
    var d = c.data, u = (S.me && S.me.user) || {};
    var pro = d.plan === "pro" || !!u.is_pro;
    var dl = num(d.days_left); if (dl === null) dl = daysLeft(d.sub_expires);
    var price = num(d.price_usd) || 69;
    var card = h("div", { class: "card plan" + (pro ? " is-pro" : "") });
    card.appendChild(h("div", { class: "plan-top" },
      h("div", null, label("[Тариф]"), h("div", { class: "plan-name", text: d.plan_label || (pro ? "Pro" : "Free") })),
      pro ? h("div", { class: "days-ring" }, h("div", { class: "ring", style: "--p:" + Math.max(0, Math.min(100, (dl || 0) / 30 * 100)).toFixed(0) + "%" }, h("b", { text: dl === null ? "—" : String(dl) })),
        h("div", null, label("[Осталось]"), h("div", { class: "label label-b", text: dl === null ? "—" : dl + " " + plural(dl, "день", "дня", "дней") }), h("div", { class: "label", text: "до " + fmtDate(d.sub_expires) })))
        : h("div", { class: "ta-r" }, h("div", { class: "price-big" }, "$" + price, h("small", { text: "/ мес" })))));
    var feats = Array.isArray(d.features) ? d.features : [];
    if (feats.length) {
      if (!pro) card.appendChild(label("[Pro включает]"));
      var ul = h("ul", { class: "feat" });
      feats.forEach(function (f) { ul.appendChild(h("li", null, icon("check"), h("span", { text: String(f) }))); });
      card.appendChild(ul);
    }
    root.appendChild(card);

    // Оплата — картой или USDT на странице тарифов сайта (TON-блок бота не переносится, D12).
    var pay = groupCard(pro ? "Продление" : "Оформить Pro", pro ? "Продлить ещё на 30 дней" : "Pro на 30 дней — $" + price, icon("bolt"), "glow-violet");
    // GET plan may carry `checkout_url` (same-origin path) — it wins over the CHECKOUT_URL constant.
    var checkout = typeof d.checkout_url === "string" && /^\/[^/\\]/.test(d.checkout_url) ? d.checkout_url : null;
    pay.appendChild(h("div", { class: "stack", style: "margin:12px 0 12px" },
      h("button", { class: "btn btn-red btn-block", type: "button", onclick: function () { if (!checkout) return openCheckout(); hap("medium"); location.href = checkout; } },
        pro ? "Продлить Pro" : "Оформить Pro", icon("arrow")),
      h("p", { class: "desc", style: "margin:0", text: "Оплата картой или USDT на странице тарифов. Подписка активируется автоматически после оплаты." })));
    root.appendChild(pay);
    if (d.admin_contact) {
      var handle = String(d.admin_contact).replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
      if (handle) root.appendChild(h("div", { class: "stack" }, h("button", { class: "btn btn-dark btn-block", type: "button", onclick: function () { openExternal("https://t.me/" + handle); } }, "Написать @" + handle, icon("tg"))));
    }
  }

  // --- Помощь -----------------------------------------------------------------
  var helpOpen = {};
  // [HELP-V2] «Заголовок» в начале абзаца (первая строка до точки/двоеточия, ≤ 40 символов,
  // заканчивается точкой) → подзаголовок; остальное — абзацы, строки с «•» и «/cmd —» — списки
  function helpBody(text) {
    var box = h("div", { class: "acc-b" });
    var paras = text.replace(/\r/g, "").split(/\n{2,}/);
    paras.forEach(function (p, idx) {
      p = p.trim(); if (!p) return;
      if (idx === 0 && p.length <= 48 && p.indexOf("\n") < 0) return;   // заголовок раздела дублирует строку аккордеона
      var m = /^((?:\d+\.\s+)?[^\n.]{3,48}\.)\s+([\s\S]*)$/.exec(p);
      var el = h("div", { class: "help-p" });
      if (m) { el.appendChild(h("b", { text: m[1] })); p = m[2]; }
      var lines = p.split("\n");
      var ul = null;
      lines.forEach(function (ln) {
        ln = ln.trim(); if (!ln) return;
        var li = /^[•\-]\s*(.*)$/.exec(ln) || /^(\/[a-z_]+(?:\s+и\s+\/[a-z_]+|\s+and\s+\/[a-z_]+)?\s+—\s+.*)$/.exec(ln);
        if (li) { if (!ul) { ul = h("ul", { class: "help-ul" }); el.appendChild(ul); } ul.appendChild(h("li", { text: li[1] })); }
        else { ul = null; el.appendChild(h("span", { class: "help-ln", text: ln })); }
      });
      box.appendChild(el);
    });
    return box;
  }
  function secHelp(root) {
    var c = S.sec.help;
    if (!c || (c.loading && !c.data)) { secLoad("help", "help"); root.appendChild(secSkeleton()); return; }
    if (!c.data) { root.appendChild(unavailableCard(function () { secLoad("help", "help", true); rerenderSub(); })); return; }
    var list = Array.isArray(c.data.sections) ? c.data.sections : [];
    if (!list.length) { root.appendChild(emptyCard("Справка пуста", "Тексты помощи ещё не загружены.")); return; }
    // [HELP-V2] справочник: нумерованные разделы, без эмодзи, текст с подзаголовками
    root.appendChild(h("p", { class: "desc help-intro", text: "Как работает CHM Breaker: стратегии, карточка сигнала, авто-трейд, риск, приложение, оплата." }));
    var acc = h("div", { class: "card acc group help-acc" });
    list.forEach(function (sct, i) {
      var id = String(sct.id || i);
      var open = helpOpen[id] != null ? helpOpen[id] : i === 0;
      var item = h("div", { class: "acc-i" + (open ? " open" : "") });
      item.appendChild(h("button", { class: "acc-h", type: "button", "aria-expanded": open ? "true" : "false", onclick: function () {
        hap("select"); helpOpen[id] = !item.classList.contains("open"); item.classList.toggle("open"); this.setAttribute("aria-expanded", item.classList.contains("open") ? "true" : "false");
      } }, h("span", { class: "acc-n", text: String(sct.number || (i < 9 ? "0" + (i + 1) : i + 1)) }), h("span", { class: "acc-t", text: String(sct.title || "—") }), icon("chev")));
      item.appendChild(helpBody(String(sct.text || "")));
      acc.appendChild(item);
    });
    root.appendChild(acc);
    root.appendChild(h("div", { class: "stack" }, h("button", { class: "btn btn-dark btn-block", type: "button", onclick: function () { openSub("feedback"); } }, "Не нашли ответ? Напишите нам", icon("msg"))));
  }

  // --- Обратная связь --------------------------------------------------------
  function secFeedback(root) {
    var fb = S.fb;
    if (fb.sent != null) {
      root.appendChild(h("div", { class: "card fb-ok" }, icon("check"),
        h("div", { class: "cond", style: "font-size:22px", text: "Отправлено" }),
        h("p", { class: "muted", style: "margin:6px 0 0", text: "Спасибо! Сообщение №" + fb.sent + " ушло команде. Ответим в боте." }),
        h("button", { class: "btn btn-dark btn-sm mt16", type: "button", onclick: function () { hap("light"); fb.sent = null; fb.text = ""; rerenderSub(); } }, "Написать ещё")));
      return;
    }
    var card = groupCard("Сообщение", "Баг, идея или вопрос — читаем всё");
    card.appendChild(ctlRow("Тип", null, seg([{ v: "bug", l: "Баг" }, { v: "idea", l: "Идея" }, { v: "other", l: "Другое" }], fb.type, function (v) { fb.type = v; rerenderSub(); }, false, null, true)));
    var ta = h("textarea", { class: "inp", maxlength: "2000", rows: "5", placeholder: fb.type === "bug" ? "Что произошло, на какой монете/стратегии, когда?" : fb.type === "idea" ? "Что улучшить или добавить?" : "Ваш вопрос", "aria-label": "Текст сообщения" });
    ta.value = fb.text;
    var cnt = h("div", { class: "label counter", text: fb.text.length + " / 2000" });
    ta.addEventListener("input", function () { fb.text = ta.value.slice(0, 2000); cnt.textContent = fb.text.length + " / 2000"; });
    card.appendChild(h("div", { class: "ctl" }, h("span", { class: "label inp-label", text: "[Текст]" }), ta, cnt));
    card.appendChild(h("div", { class: "stack", style: "margin:4px 0 12px" },
      h("button", { class: "btn btn-red btn-block", type: "button", disabled: fb.busy, onclick: function () {
        var text = String(fb.text || "").trim();
        if (text.length < 5) { hap("error"); toast("Напишите чуть подробнее", true); return; }
        fb.busy = true; hap("medium"); rerenderSub();
        api("feedback", { method: "POST", body: { type: fb.type, text: text }, timeout: 15000 }).then(function (d) {
          okOrThrow(d);
          fb.sent = d.id != null ? String(d.id) : "—";
          hap("success");
        }).catch(function (e) {
          hap("error");
          if (e.code === "rate_limited") toast("Лимит 5 сообщений в день. Напишите завтра или в бота.", true);
          else if (e.code !== "unauthorized") toast(errText(e.code), true);
        }).then(function () { fb.busy = false; rerenderSub(); });
      } }, fb.busy ? "Отправляю…" : "Отправить", icon("arrow"))));
    root.appendChild(card);
    root.appendChild(h("p", { class: "desc", text: "До 5 сообщений в день. Ответ приходит в чат бота." }));
  }

  // --- Язык -------------------------------------------------------------------
  function secLang(root) {
    var u = (S.me && S.me.user) || {};
    var sd = settingsData();
    var cur = (sd && sd.settings && sd.settings.lang) || u.lang || "ru";
    var card = groupCard("Язык бота", "Сообщения, сигналы и меню в Telegram");
    card.appendChild(ctlRow("Язык", null, seg([{ v: "ru", l: "Русский" }, { v: "en", l: "English" }], cur, function (v) {
      if (S.langBusy) return;
      S.langBusy = true;
      api("lang", { method: "POST", body: { lang: v }, timeout: 15000 }).then(function (d) {
        okOrThrow(d);
        var nl = d.lang === "en" ? "en" : "ru";
        if (S.me && S.me.user) S.me.user.lang = nl;
        if (sd && sd.settings) sd.settings.lang = nl;
        hap("success"); toast("Язык бота: " + (nl === "en" ? "English" : "Русский"));
      }).catch(function (e) {
        hap("error");
        if (e.code !== "unauthorized") toast(errText(e.code), true);
      }).then(function () { S.langBusy = false; rerenderSub(); });
    }, false, null, true)));
    root.appendChild(card);
    root.appendChild(h("p", { class: "desc", text: "Интерфейс приложения — на русском; настройка влияет на бота в Telegram." }));
  }

  // --- [CHALLENGE] Личный план: карточка на главной + раздел в настройках --------
  var CH_TERMS = [{ v: "2w", l: "2 недели" }, { v: "1m", l: "1 месяц" }, { v: "3m", l: "3 месяца" }, { v: "none", l: "Без срока" }];
  var CH_VERDICT = {
    ok: ["up", "По вашей статистике цель достижима"], tight: ["warn", "На грани: нужен темп вдвое выше обычного"],
    unrealistic: ["down", "По статистике за 30 дней в этот срок не достижима"], negative: ["warn", "За 30 дней итог в минусе — прогноза нет"],
    no_data: ["muted", "Мало данных — прогноз появится после 10 сделок"]
  };
  var CH_WARN = { risk_high: "риск ≥ 3 %: пять стопов подряд = −15 % депозита", liquidation_near: "при таком плече ликвидация ближе двух стопов",
    margin_over_deposit: "позиция не влезает в депозит при стопе 1,5 %", daily_limit_below_risk: "дневной лимит убытка меньше одного стопа" };
  var CH_BLOCK = { max_trades: "лимит сделок на сегодня исчерпан", daily_loss: "дневной лимит убытка достигнут" };
  var chForm = null;   // ответы анкеты (в памяти экрана)
  function usd0(x) { var n = num(x); return n === null ? "—" : "$" + Math.round(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " "); }
  function loadChallenge(force) {
    var c = S.sec.challenge;
    if (c && (c.loading || (!force && c.data && Date.now() - c.at < 30000))) return;
    S.sec.challenge = { loading: true, data: c ? c.data : null, at: c ? c.at : 0 };
    api("challenge", { timeout: 15000 }).then(function (d) {
      okOrThrow(d); S.sec.challenge = { data: d, at: Date.now() };
    }).catch(function (e) {
      S.sec.challenge = { err: (e && e.code) || "unavailable", at: Date.now(), data: null };
    }).then(function () { rerender(S.tab); });
  }
  function chData() { var c = S.sec.challenge; return c && c.data ? c.data : null; }
  function chBar(pct) {
    var p = Math.max(0, Math.min(100, num(pct) || 0));
    return h("i", { class: "mtile-bar ch-bar", "aria-hidden": "true" }, h("b", { style: "width:" + p + "%" }));
  }
  function challengeCard() {
    var d = chData();
    if (!d) { if (S.me && S.me.user && S.me.user.is_pro) loadChallenge(false); return null; }
    if (!d.available) return null;
    var card = h("div", { class: "card group ch-card", role: "button", tabindex: "0",
      onclick: function () { S.tab = "profile"; openSub("challenge"); } });
    if (!d.active || !d.progress) {
      card.appendChild(h("div", { class: "group-head" }, h("div", null, h("div", { class: "cond", text: "🎯 Челлендж" }),
        h("div", { class: "desc", style: "margin:2px 0 0;font-size:10.5px", text: "Поставьте цель — бот посчитает план в R и $ и будет вести прогресс" })),
        h("span", { class: "label", text: "[Начать]" })));
      return card;
    }
    var ch = d.challenge, pr = d.progress;
    card.appendChild(h("div", { class: "group-head" }, h("div", null, h("div", { class: "cond", text: "🎯 Челлендж · " + usd0(ch.deposit) + " → " + usd0(ch.goal_usd) }),
      h("div", { class: "desc", style: "margin:2px 0 0;font-size:10.5px", text: (pr.days_left != null ? "День " + (Math.floor(pr.days_elapsed) + 1) + " · осталось " + Math.max(0, Math.floor(pr.days_left)) + " дн." : "Без срока")
        + (pr.pace_r != null ? " · темп " + fmtR(pr.pace_r) : "") })),
      h("b", { class: "stat-val " + signCls(num(pr.r_total)), style: "font-size:20px", text: fmtR(pr.r_total) + " / " + ch.r_needed + "R" })));
    card.appendChild(chBar(pr.pct_goal));
    card.appendChild(h("div", { class: "desc", style: "margin-top:6px", text: fmtR(pr.r_total) + " · " + usd0(pr.pnl_usd) + " из " + usd0(ch.goal_profit_usd)
      + " · сегодня " + pr.today_signals + (ch.max_trades_day ? "/" + ch.max_trades_day : "") + " сделок" + (pr.blocked ? " · ⛔ стоп до завтра" : "") }));
    return card;
  }
  function chDefaults() {
    var u = (S.me && S.me.user) || {};
    return { deposit: 1000, goal_kind: "pct", goal_value: 25, term: "1m", risk_pct: 1, leverage: 5, max_trades_day: 3,
      daily_loss_pct: 3, topup_monthly: 0, strategies: enabledKeys().length ? enabledKeys().slice() : ["LEVELS"], mode: S.me && S.me.auto_trade ? "auto" : "signals", _preview: null };
  }
  function chNumRow(title, sub, key, opts, custom) {
    var wrap = h("div", { class: "ctl" });
    wrap.appendChild(h("div", { class: "ctl-head" }, h("div", null, h("div", { class: "cond", text: title }), sub ? h("div", { class: "desc", text: sub }) : null)));
    var segEl = seg(opts, chForm[key], function (v) { chForm[key] = v; chForm._preview = null; rerenderSub(); }, false, null, true);
    wrap.appendChild(segEl);
    if (custom) {
      var inp = h("input", { class: "inp", type: "number", inputmode: "decimal", placeholder: "свой вариант", value: opts.some(function (o) { return String(o.v) === String(chForm[key]); }) ? "" : chForm[key],
        onchange: function (ev) { var v = num(ev.target.value); if (v !== null) { chForm[key] = v; chForm._preview = null; rerenderSub(); } } });
      wrap.appendChild(h("div", { style: "margin-top:6px" }, inp));
    }
    return wrap;
  }
  function chPreview() {
    if (chForm._preview === "loading") return;
    chForm._preview = "loading"; rerenderSub();
    api("challenge", { body: Object.assign({}, chAnswers(), { preview: true }) }).then(function (d) {
      okOrThrow(d); chForm._preview = d;
    }).catch(function (e) { chForm._preview = null; toast(errText(e.code), true); }).then(rerenderSub);
  }
  function chAnswers() {
    var f = chForm;
    return { deposit: f.deposit, goal_kind: f.goal_kind, goal_value: f.goal_value, term: f.term, risk_pct: f.risk_pct, leverage: f.leverage,
      max_trades_day: f.max_trades_day, daily_loss_pct: f.daily_loss_pct, topup_monthly: f.topup_monthly, strategies: f.strategies, mode: f.mode };
  }
  function chStart() {
    hap("select");
    api("challenge", { body: chAnswers() }).then(function (d) {
      okOrThrow(d); S.sec.challenge = { data: d, at: Date.now() }; chForm = null;
      toast("Челлендж запущен" + (d.applied && d.applied.length ? " · настройки применены" : ""));
      secLoad("settings", "settings/all", true);
      api("me").then(function (m) { okOrThrow(m); S.me = m; }).catch(function () {}).then(rerenderSub);
    }).catch(function (e) { toast(errText(e.code), true); });
  }
  function chTopup() {
    var v = window.prompt("Сумма пополнения, $");
    var n = num(v); if (n === null || n <= 0) return;
    api("challenge/topup", { body: { amount: n } }).then(function (d) { okOrThrow(d); S.sec.challenge = { data: d, at: Date.now() }; toast("Пополнение учтено"); rerenderSub(); })
      .catch(function (e) { toast(errText(e.code), true); });
  }
  function chFinish() {
    if (!window.confirm("Завершить челлендж? Статистика сохранится, настройки не изменятся.")) return;
    api("challenge/finish", { body: {} }).then(function (d) { okOrThrow(d); S.sec.challenge = { data: d, at: Date.now() }; toast("Челлендж завершён"); rerenderSub(); })
      .catch(function (e) { toast(errText(e.code), true); });
  }
  function chPlanCard(ch, pl) {
    var g = groupCard("План", usd0(ch.deposit) + " → " + usd0(ch.goal_usd) + " · " + (ch.term === "none" ? "без срока" : CH_TERMS.filter(function (t) { return t.v === ch.term; })[0].l));
    var v = CH_VERDICT[pl.verdict] || CH_VERDICT.no_data;
    g.appendChild(h("div", { class: "kv" },
      h("div", null, label("[Заработать]"), h("b", { text: usd0(pl.profit_usd) + " = " + pl.r_needed + "R" })),
      h("div", null, label("[Риск на сделку]"), h("b", { text: ch.risk_pct + " % = " + usd0(pl.risk_usd) }))));
    g.appendChild(h("div", { class: "kv" },
      h("div", null, label("[Плечо · маржа]"), h("b", { text: ch.leverage + "× · " + (pl.margin_pct != null ? pl.margin_pct + " %" : "—") })),
      h("div", null, label("[Нужный темп]"), h("b", { text: pl.r_per_day_needed != null ? pl.r_per_day_needed + "R/день" : "—" }))));
    g.appendChild(h("div", { class: "desc " + v[0], style: "margin-top:8px", text: v[1] + (pl.days_forecast ? " (≈" + pl.days_forecast + " дн. при вашем темпе " + pl.hist_r_per_day + "R/день)" : "") }));
    (pl.warnings || []).forEach(function (w) { g.appendChild(h("div", { class: "desc warn", text: "⚠️ " + (CH_WARN[w] || w) })); });
    return g;
  }
  function secChallenge(root) {
    var d = chData(), c = S.sec.challenge;
    if (!d) { if (c && c.err) root.appendChild(unavailableCard(function () { loadChallenge(true); })); else { loadChallenge(false); root.appendChild(secSkeleton()); } return; }
    if (!d.available) { root.appendChild(hintCard("Челлендж доступен на тарифе Pro.", "warn", h("button", { class: "btn btn-red btn-sm", type: "button", onclick: function () { openSub("plan"); } }, "Тариф Pro"))); return; }
    if (d.active && d.progress) {
      var ch = d.challenge, pr = d.progress;
      var g = groupCard("🎯 " + usd0(ch.deposit) + " → " + usd0(ch.goal_usd), (pr.days_left != null ? "День " + (Math.floor(pr.days_elapsed) + 1) + " · осталось " + Math.max(0, Math.floor(pr.days_left)) + " дн." : "Без срока"), null, "glow-red");
      g.appendChild(h("div", { class: "stat-val " + signCls(num(pr.r_total)), style: "margin-top:8px", text: fmtR(pr.r_total) + " из " + ch.r_needed + "R" }));
      g.appendChild(chBar(pr.pct_goal));
      g.appendChild(h("div", { class: "kv" },
        h("div", null, label("[Прибыль]"), h("b", { class: signCls(num(pr.pnl_usd)), text: usd0(pr.pnl_usd) + " из " + usd0(ch.goal_profit_usd) })),
        h("div", null, label("[Темп к плану]"), h("b", { class: signCls(num(pr.pace_r)), text: pr.pace_r != null ? fmtR(pr.pace_r) : "—" }))));
      g.appendChild(h("div", { class: "kv" },
        h("div", null, label("[Сегодня]"), h("b", { text: pr.today_signals + (ch.max_trades_day ? "/" + ch.max_trades_day : "") + " сделок · " + fmtR(pr.today_r) })),
        h("div", null, label("[Депозит ≈]"), h("b", { text: usd0(pr.deposit_now) + (pr.topups_total ? " (+" + usd0(pr.topups_total) + " пополн.)" : "") }))));
      g.appendChild(h("div", { class: "desc", style: "margin-top:8px", text: "Win rate " + pr.win_rate + " % · сделок с итогом " + pr.trades + " · риск " + ch.risk_pct + " % · плечо " + ch.leverage + "× · " + (ch.mode === "auto" ? "автотрейд" : "сигналы") }));
      if (pr.blocked) g.appendChild(h("div", { class: "desc warn", style: "margin-top:6px", text: "⛔ " + (CH_BLOCK[pr.block_reason] || pr.block_reason) + " — новых входов до завтра (UTC) не будет" }));
      g.appendChild(h("div", { class: "row", style: "gap:8px;margin-top:10px" },
        h("button", { class: "btn btn-dark", style: "flex:1", type: "button", onclick: chTopup }, "➕ Пополнение"),
        h("button", { class: "btn btn-dark", style: "flex:1", type: "button", onclick: chFinish }, "🏁 Завершить")));
      root.appendChild(g);
      if (d.plan) root.appendChild(chPlanCard(ch, d.plan));
      return;
    }
    if (!chForm) chForm = chDefaults();
    root.appendChild(hintCard("10 ответов → план в R и $, честная проверка по вашей статистике, настройки применяются автоматически. Лимит сделок или убытка за день останавливает новые входы до завтра.", ""));
    var f = groupCard("Анкета", "Депозит, цель, риск, лимиты");
    f.appendChild(chNumRow("Депозит, $", null, "deposit", [{ v: 500, l: "$500" }, { v: 1000, l: "$1 000" }, { v: 3000, l: "$3 000" }, { v: 5000, l: "$5 000" }, { v: 10000, l: "$10 000" }], true));
    f.appendChild(chNumRow("Цель: прирост депозита", "или своя сумма в $ ниже", "goal_value", [{ v: 10, l: "+10 %" }, { v: 25, l: "+25 %" }, { v: 50, l: "+50 %" }, { v: 100, l: "+100 %" }], false));
    var goalUsd = h("input", { class: "inp", type: "number", inputmode: "decimal", placeholder: "цель в $ (например 5000)", value: chForm.goal_kind === "usd" ? chForm.goal_value : "",
      onchange: function (ev) { var v = num(ev.target.value); if (v !== null && v > 0) { chForm.goal_kind = "usd"; chForm.goal_value = v; } else { chForm.goal_kind = "pct"; chForm.goal_value = 25; } chForm._preview = null; rerenderSub(); } });
    f.appendChild(h("div", { style: "margin:-4px 0 8px" }, goalUsd));
    if (chForm.goal_kind === "usd") f.appendChild(h("div", { class: "desc", style: "margin:-4px 0 8px", text: "Цель: " + usd0(chForm.goal_value) }));
    var termRow = h("div", { class: "ctl" }, h("div", { class: "ctl-head" }, h("div", null, h("div", { class: "cond", text: "Срок" }))));
    termRow.appendChild(seg(CH_TERMS, chForm.term, function (v) { chForm.term = v; chForm._preview = null; rerenderSub(); }, false, null, true));
    f.appendChild(termRow);
    f.appendChild(chNumRow("Риск на сделку, %", null, "risk_pct", [{ v: 0.5, l: "0,5 %" }, { v: 1, l: "1 %" }, { v: 2, l: "2 %" }, { v: 3, l: "3 %" }], true));
    f.appendChild(chNumRow("Плечо", null, "leverage", [{ v: 3, l: "3×" }, { v: 5, l: "5×" }, { v: 10, l: "10×" }, { v: 20, l: "20×" }], true));
    f.appendChild(chNumRow("Сделок в день, максимум", null, "max_trades_day", [{ v: 2, l: "2" }, { v: 3, l: "3" }, { v: 5, l: "5" }, { v: 10, l: "10" }, { v: 0, l: "∞" }], true));
    f.appendChild(chNumRow("Дневной лимит убытка, %", "после него — стоп до завтра", "daily_loss_pct", [{ v: 2, l: "2 %" }, { v: 3, l: "3 %" }, { v: 5, l: "5 %" }, { v: 0, l: "∞" }], true));
    f.appendChild(chNumRow("Пополнения, $/мес", "отдельной строкой, в прибыль не идут", "topup_monthly", [{ v: 0, l: "0" }, { v: 100, l: "$100" }, { v: 300, l: "$300" }, { v: 1000, l: "$1 000" }], true));
    var stratRow = h("div", { class: "ctl" }, h("div", { class: "ctl-head" }, h("div", null, h("div", { class: "cond", text: "Стратегии" }), h("div", { class: "desc", text: "можно несколько" }))));
    var sw = h("div", { class: "seg grow" });
    STRAT_ORDER.forEach(function (k) {
      var on = chForm.strategies.indexOf(k) >= 0;
      sw.appendChild(h("button", { class: "seg-b" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false", onclick: function () {
        if (on) chForm.strategies = chForm.strategies.filter(function (x) { return x !== k; }); else chForm.strategies.push(k);
        chForm._preview = null; hap("select"); rerenderSub(); } }, stratName(k)));
    });
    stratRow.appendChild(sw); f.appendChild(stratRow);
    var modeRow = h("div", { class: "ctl" }, h("div", { class: "ctl-head" }, h("div", null, h("div", { class: "cond", text: "Режим" }))));
    modeRow.appendChild(seg([{ v: "signals", l: "📨 Сигналы" }, { v: "auto", l: "🤖 Автотрейд" }], chForm.mode, function (v) { chForm.mode = v; chForm._preview = null; rerenderSub(); }, false, null, true));
    f.appendChild(modeRow);
    root.appendChild(f);
    var pv = chForm._preview;
    if (pv && pv !== "loading" && pv.plan) root.appendChild(chPlanCard(pv.challenge, pv.plan));
    root.appendChild(h("div", { class: "row", style: "gap:8px;margin-top:10px" },
      h("button", { class: "btn btn-dark", style: "flex:1", type: "button", disabled: pv === "loading" ? "disabled" : null, onclick: chPreview }, pv === "loading" ? "Считаю…" : "📐 Посчитать план"),
      h("button", { class: "btn btn-red", style: "flex:1", type: "button", disabled: !chForm.strategies.length ? "disabled" : null, onclick: chStart }, "🚀 Стартовать")));
  }

  // --- Расширенные настройки (D9) ---------------------------------------------
  // Экран-заглушка-универсал: всё, что GET settings/all отдаёт сверх экранов выше
  // (параметры, которые в боте менялись только через Telegram-меню), рендерится
  // по типу значения, чтобы ни одна настройка не осталась скрытой. Для известных
  // ключей бота — подписи и наборы значений из его меню (ui-inventory §7.4–7.6),
  // для остальных — имя ключа; options.schema / options.choices / options.labels
  // сервера (если есть) уточняют контрол.
  var KNOWN_KEYS = {
    levels: ["long_tf", "short_tf", "min_volume_usdt", "min_quality", "min_rr", "max_dist_pct", "zone_pct", "max_risk_pct", "use_rsi", "use_volume", "use_htf", "trend_only"],
    smc: ["tf_key", "direction", "min_volume_usdt", "max_sl_pct", "scan_interval"],
    volume: ["timeframe", "ma_type", "vol_mult", "min_quality", "setup_cross", "setup_turn", "setup_bounce", "setup_golden", "setup_ribbon", "use_htf"],
    trading: ["auto_trade", "auto_trade_mode", "trade_exchange", "trade_risk_pct", "trade_leverage", "max_trades_limit", "risk_mode", "partial_tp_enabled", "auto_trailing_enabled", "prefer_market_entry", "bybit_demo"],
    risk: ["sl_streak_enabled", "sl_streak_threshold", "circuit_breaker_enabled", "circuit_breaker_threshold_r", "allow_counter_trend", "trade_trending_only", "btc_correlation_block", "spread_check_enabled", "hour_filter_enabled", "filters_all_off"],
    notifications: ["progress_notify_enabled", "send_chart_enabled", "signal_format", "quiet_start", "quiet_end"]
  };
  var ADV_SKIP_TOP = { lang: 1, genome_auto_apply: 1, exchanges: 1 };   // have their own screens
  var ADV_READONLY = { overrides: 1 };   // informational arrays the server returns (which keys override the shared config)
  var ADV_GROUP = {
    levels: ["Уровни — тонкие параметры", "Пивоты, EMA, фильтры, цели: как в /settings бота"],
    "levels.shared": ["Уровни — общие параметры", "Пивоты, EMA, фильтры, цели: как в /settings бота"],
    "levels.long": ["Уровни — LONG", "Переопределения для лонгов (меню «📈 ЛОНГ» бота)"],
    "levels.short": ["Уровни — SHORT", "Переопределения для шортов (меню «📉 ШОРТ» бота)"],
    smc: ["SMC — тонкие параметры", "Подтверждения, R:R, буфер SL, OB/FVG: как в меню SMC"],
    "smc.advanced": ["SMC — тонкие параметры", "Подтверждения, R:R, буфер SL, OB/FVG: как в меню SMC"],
    volume: ["Объём + MA — дополнительно", "Параметры сканера объёма"],
    trading: ["Авто-трейд — дополнительно", "Дни без торговли, фикс. риск, фильтр монет"],
    ptp: ["Partial TP", "Частичная фиксация: режим R / %, доли на TP1 и TP2"],
    risk: ["Risk Management — дополнительно", "Спред, corr-cap, adaptive sizing, tilt, hold-lock"],
    "risk.advanced": ["Risk Management — дополнительно", "Спред, corr-cap, adaptive sizing, tilt, hold-lock"],
    notifications: ["Уведомления — флаги", "Сигнал входа, ранний пробой"]
  };
  // Подписи и наборы значений Telegram-меню бота (ui-inventory §7.4–7.6). Ключ — полный
  // путь settings/all или "<раздел>.<ключ>" (подходит для вложенных levels.shared / levels.long /
  // levels.short / smc.advanced / risk.advanced); наборы значений сервера (options.choices) главнее.
  var ADV_PRESET = {
    "ui_mode": { t: "Режим меню", s: "Простой — короткое меню; Эксперт — все параметры", o: [{ v: "simple", l: "Простой" }, { v: "expert", l: "Эксперт" }] },
    // LEVELS — Mini App keys (appear again inside the per-direction blocks)
    "levels.timeframe": { t: "Таймфрейм", s: "Общий ТФ уровней", f: "tf" },
    "levels.min_quality": { t: "Мин. качество", s: "Сигналы ниже порога не отправляются", u: "⭐" },
    "levels.min_volume_usdt": { t: "Мин. объём за 24ч", s: "USDT — отсекает тонкие монеты", f: "vol" },
    "levels.min_rr": { t: "Мин. RR", s: "Цель к стопу, не меньше", u: "R" },
    "levels.max_dist_pct": { t: "Расстояние до уровня", s: "Макс. % от цены до уровня", u: "%" },
    "levels.zone_pct": { t: "Ширина зоны", s: "% вокруг уровня", u: "%" },
    "levels.max_risk_pct": { t: "Макс. риск на сделку", s: "% депозита при стопе", u: "%" },
    "levels.use_rsi": { t: "Фильтр RSI", s: "Не входить в перекупленность / перепроданность" },
    "levels.use_volume": { t: "Фильтр объёма", s: "Подтверждение объёмом на сигнальной свече" },
    "levels.use_htf": { t: "Старший таймфрейм", s: "HTF тренд (+⭐ качество)" },
    "levels.trend_only": { t: "Только по тренду", s: "Без контртрендовых входов" },
    // LEVELS — /settings menu (shared / long / short)
    "levels.pivot_strength": { t: "Пивоты: сила", s: "Баров слева/справа для уровня S/R", o: [3, 5, 7, 10, 15, 17, 20] },
    "levels.max_level_age": { t: "Возраст уровня", s: "Макс. баров с момента образования", o: [30, 50, 75, 100, 142, 150, 200, 250, 300] },
    "levels.max_retest_bars": { t: "Ретест", s: "Макс. баров до ретеста", o: [10, 20, 30, 50] },
    "levels.zone_buffer": { t: "Буфер зоны", s: "% запаса вокруг уровня", o: [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1], u: "%" },
    "levels.max_level_tests": { t: "Касаний уровня", s: "Макс. тестов уровня", o: [1, 2, 3, 4, 5, 6, 7, 8, 10, 99] },
    "levels.ema_fast": { t: "EMA быстрая", s: "Трендовые линии", o: [20, 50, 100] },
    "levels.ema_slow": { t: "EMA медленная", s: "Трендовые линии", o: [100, 200, 500] },
    "levels.htf_ema_period": { t: "EMA старшего ТФ", s: "Период EMA на ТФ выше", o: [20, 50, 100, 200] },
    "levels.use_pattern": { t: "Паттерны", s: "Фильтр свечных паттернов" },
    "levels.rsi_period": { t: "RSI: период", o: [7, 14, 21] },
    "levels.rsi_ob": { t: "RSI: перекупленность", o: [60, 65, 70, 75] },
    "levels.rsi_os": { t: "RSI: перепроданность", o: [25, 30, 35, 40] },
    "levels.vol_mult": { t: "Множитель объёма", s: "Объём свечи ≥ среднего × N", o: [1, 1.2, 1.5, 2], u: "×" },
    "levels.cooldown_bars": { t: "Cooldown между сигналами", s: "Баров паузы по монете", o: [0, 1, 2, 3, 5, 8, 10, 15, 20] },
    "levels.atr_period": { t: "ATR: период", s: "Стоп-лосс (ATR)", o: [7, 14, 21] },
    "levels.atr_mult": { t: "ATR: множитель", s: "Стоп-лосс (ATR)", o: [0.5, 1, 1.5, 2], u: "×" },
    "levels.tp1_rr": { t: "TP1", s: "Цели (Take Profit R:R)", n: { min: 0.1, max: 100, step: 0.1 }, u: "R" },
    "levels.tp2_rr": { t: "TP2", s: "Цели (Take Profit R:R)", n: { min: 0.1, max: 100, step: 0.1 }, u: "R" },
    "levels.tp3_rr": { t: "TP3", s: "Цели (Take Profit R:R)", n: { min: 0.1, max: 100, step: 0.1 }, u: "R" },
    "levels.scan_interval": { t: "Интервал сканирования", s: "Секунд между проходами", o: [60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400], u: " с" },
    "levels.interval": { t: "Интервал сканирования", s: "Секунд между проходами этого направления", o: [60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400], u: " с" },
    "levels.levels_counter_trend_min_quality": { t: "Мин. качество контр-тренда", s: "0 — любое", o: [0, 1, 2, 3, 4, 5], u: "⭐" },
    "levels.counter_trend_min_quality": { t: "Мин. качество контр-тренда", s: "0 — любое", o: [0, 1, 2, 3, 4, 5], u: "⭐" },
    "levels.high_wr_mode": { t: "High WR Mode", s: "Только сетапы 4⭐+" },
    "levels.vol_filter_mode": { t: "Фильтр монет по объёму", o: [{ v: "count", l: "Топ-N" }, { v: "usdt", l: "USDT" }, { v: "both", l: "Оба" }, { v: "off", l: "Выкл" }] },
    "levels.max_coins_count": { t: "Монет в сканере", s: "Топ-N по объёму", o: [20, 30, 50, 100, 200] },
    // SMC — kb_smc_main (smc.advanced on the server)
    "smc.min_confirmations": { t: "Мин. подтверждений", s: "из 5", o: [2, 3, 4, 5] },
    "smc.min_rr": { t: "Мин. R:R", o: [1.5, 2, 2.5, 3], u: "R" },
    "smc.sl_buffer_pct": { t: "Буфер SL", o: [0.1, 0.15, 0.25, 0.5], u: "%" },
    "smc.smc_use_volume_filter": { t: "Объём свечи", s: "Фильтр объёма ×1.2 (жёсткий / только confirmation)" },
    "smc.use_volume_filter": { t: "Объём свечи", s: "Фильтр объёма ×1.2 (жёсткий / только confirmation)" },
    "smc.smc_vol_mult": { t: "Множитель объёма", o: [1, 1.2, 1.5, 2, 3], u: "×", n: { min: 0.5, max: 5, step: 0.1 } },
    "smc.vol_mult": { t: "Множитель объёма", o: [1, 1.2, 1.5, 2, 3], u: "×" },
    "smc.fvg_enabled": { t: "FVG" },
    "smc.choch_enabled": { t: "CHoCH" },
    "smc.ob_use_breaker": { t: "Breaker blocks" },
    "smc.sweep_close_req": { t: "Закрытие sweep" },
    "smc.ob_max_age": { t: "Макс. возраст OB", o: [20, 30, 50, 100] },
    "smc.max_ob_age": { t: "Макс. возраст OB", o: [20, 30, 50, 100] },
    "smc.smc_conf_type": { t: "Подтверждение", o: [{ v: "BODY_CLOSE", l: "Тело свечи" }, { v: "WICK_TOUCH", l: "Тень/Тело" }] },
    "smc.conf_type": { t: "Подтверждение", o: [{ v: "body", l: "Тело свечи" }, { v: "wick", l: "Тень/Тело" }] },
    "smc.smc_pd_filter": { t: "P/D фильтр", s: "50/50 правило" },
    "smc.pd_filter": { t: "P/D фильтр", s: "50/50 правило" },
    "smc.smc_retrace_depth": { t: "Вход в OB", s: "Глубина входа в блок (0 — край, 1 — дальний край)", n: { min: 0, max: 1, step: 0.1 } },
    "smc.ob_entry_pct": { t: "Вход в OB", s: "% глубины блока", o: [0, 30, 50], u: "%" },
    "smc.smc_mtf_check": { t: "MTF конфлюэнс", s: "H1 → M15" },
    "smc.mtf_confluence": { t: "MTF конфлюэнс", s: "H1 → M15" },
    "smc.smc_counter_trend_min_quality": { t: "Контр-тренд: мин. качество", o: [0, 1, 2, 3, 4, 5], u: "⭐" },
    "smc.counter_trend_min_quality": { t: "Контр-тренд: мин. качество", o: [0, 1, 2, 3, 4, 5], u: "⭐" },
    // Auto-trade menu extras (kb_auto_trade)
    "trading.fixed_amount": { t: "Фикс. риск", s: "% депозита, 0 — выкл", o: [0, 0.5, 1, 1.5, 2, 2.5, 3], u: "%" },
    "trading.disabled_days": { t: "Дни без торговли", s: "В эти дни автотрейд не открывает сделки", kind: "days" },
    "trading.autotrade_disabled_days": { t: "Дни без торговли", s: "В эти дни автотрейд не открывает сделки", kind: "days" },
    "trading.vol_filter_mode": { t: "Фильтр монет по объёму", o: [{ v: "count", l: "Топ-N" }, { v: "usdt", l: "USDT" }, { v: "both", l: "Оба" }, { v: "off", l: "Выкл" }] },
    "trading.max_coins_count": { t: "Монет в сканере", s: "Топ-N по объёму", o: [20, 30, 50, 100, 200] },
    "trading.at_stats_period": { t: "Период статистики автотрейда", o: [{ v: 1, l: "24h" }, { v: 7, l: "7d" }, { v: 30, l: "30d" }] },
    "trading.partial_tp_mode": { t: "Partial TP: режим", o: [{ v: "r", l: "R" }, { v: "pct", l: "%" }] },
    "trading.optimizer_enabled": { t: "Оптимизатор", s: "Адаптивный подбор параметров" },
    // Partial TP (handlers/partial_tp.py)
    "ptp.ptp_mode": { t: "Partial TP: режим", s: "Цели в R или в % от входа", o: [{ v: "R", l: "R" }, { v: "PCT", l: "%" }] },
    "ptp.partial_tp1_r": { t: "TP1", s: "Цель первой частичной фиксации", u: "R" },
    "ptp.partial_tp2_r": { t: "TP2", s: "Цель второй частичной фиксации", u: "R" },
    "ptp.partial_tp1_pct": { t: "TP1", s: "Цель первой частичной фиксации", u: "%" },
    "ptp.partial_tp2_pct": { t: "TP2", s: "Цель второй частичной фиксации", u: "%" },
    "ptp.ptp_profit_pct1": { t: "Доля на TP1", s: "% позиции, закрываемый на TP1", u: "%" },
    "ptp.ptp_profit_pct2": { t: "Доля на TP2", s: "% позиции, закрываемый на TP2", u: "%" },
    // Risk Management extras (kb_risk_mgmt; risk.advanced on the server)
    "risk.spread_max_pct": { t: "Порог спреда", o: [0.1, 0.2, 0.3, 0.5, 1], u: "%" },
    "risk.allow_low_notional_boost": { t: "Boost объёма", s: "Добивать до минимального номинала" },
    "risk.show_risk_preview": { t: "Risk preview", s: "Показывать риск перед сделкой" },
    "risk.correlation_cap_enabled": { t: "Corr-cap", s: "Лимит коррелирующих позиций" },
    "risk.correlation_cap_threshold": { t: "Corr-cap: порог", o: [0.5, 0.6, 0.7, 0.8, 0.9], n: { min: 0.4, max: 0.95, step: 0.05 } },
    "risk.adaptive_sizing_enabled": { t: "Adaptive sizing", s: "Kelly / волатильность / просадка" },
    "risk.adaptive_sizing_mode": { t: "Adaptive sizing: режим", o: [{ v: "all", l: "Все" }, { v: "kelly", l: "Kelly" }, { v: "vol", l: "Vol" }, { v: "dd", l: "DD" }, { v: "off", l: "Выкл" }] },
    "risk.tilt_detector_enabled": { t: "Tilt detector", s: "Предупреждение о тильте" },
    "risk.hold_lock_enabled": { t: "Hold-lock", s: "Подтверждение закрытия ниже min R" },
    "risk.hold_lock_min_rr": { t: "Hold-lock: мин. R", n: { min: 0, max: 5, step: 0.1 }, u: "R" },
    "risk.min_signal_quality": { t: "Сигналы для автотрейда", s: "Все (B+A+A+) / только A и A+ / только A+", o: [{ v: 3, l: "Все" }, { v: 4, l: "A и A+" }, { v: 5, l: "Только A+" }] },
    "notifications.notify_signal": { t: "Сигнал входа" },
    "notifications.notify_breakout": { t: "Пробой уровня (ранний)" }
  };
  var ADV_FMT = { tf: function (v) { return String(v).toUpperCase(); }, vol: function (v) { return volLabel(v); } };
  function advPreset(full, key) {
    var top = full.split(".")[0];
    return ADV_PRESET[full] || ADV_PRESET[top + "." + key] || null;
  }
  function advTitle(full, key, op, p) {
    if (op.labels && op.labels[full]) return String(op.labels[full]);
    return p && p.t ? p.t : key.replace(/_/g, " ");
  }
  function advInput(type, value, onChange, locked) {
    var inp = h("input", { class: "inp", type: type, inputmode: type === "number" ? "decimal" : null, step: type === "number" ? "any" : null,
      maxlength: type === "number" ? null : "128", autocomplete: "off", spellcheck: "false", value: value == null ? "" : String(value) });
    inp.addEventListener("change", function () {
      if (locked) { inp.value = value == null ? "" : String(value); lockedTap(); return; }
      var v = type === "number" ? num(inp.value) : String(inp.value);
      if (v === null || v === value) return;
      onChange(v);
    });
    return inp;
  }
  // Option list for a key: the server's options.choices[full] wins (labels taken from the
  // preset when it names them), then the preset's own list, then options.schema.
  function advOptions(full, p, schema, op) {
    var preset = p && Array.isArray(p.o) ? p.o : null;
    var labelOf = function (v) {
      if (!preset) return null;
      for (var i = 0; i < preset.length; i++) if (preset[i] && typeof preset[i] === "object" && String(preset[i].v) === String(v)) return preset[i].l;
      return null;
    };
    var srv = op.choices && op.choices[full];
    if (Array.isArray(srv) && srv.length) return srv.map(function (v) { var l = labelOf(v); return l != null ? { v: v, l: l } : v; });
    if (preset) return preset;
    if (schema && Array.isArray(schema.values)) return schema.values;
    return null;
  }
  // «Дни без торговли»: multi-toggle Пн…Вс (0 = Monday, as the bot stores them).
  function daysCtl(title, sub, sec, key, val, locked) {
    var cur = (Array.isArray(val) ? val : String(val == null ? "" : val).split(",")).map(function (d) { return num(d); }).filter(function (d) { return d !== null; });
    var wrap = h("div", { class: "seg grow" });
    WD.forEach(function (name, i) {
      var on = cur.indexOf(i) >= 0;
      wrap.appendChild(h("button", { class: "seg-b" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false", onclick: function () {
        if (locked) return lockedTap();
        hap("select");
        var next = on ? cur.filter(function (d) { return d !== i; }) : cur.concat([i]).sort(function (a, b) { return a - b; });
        saveSetting(sec, key, next);
      } }, name));
    });
    return ctlRow(title, sub, wrap, locked);
  }
  function advControl(sec, key, val, op) {
    var full = sec ? sec + "." + key : key;
    var p = advPreset(full, key) || {};
    var schema = (op.schema && (op.schema[full] || (op.schema[sec] && op.schema[sec][key]))) || {};
    var locked = isLocked(full);
    var title = advTitle(full, key, op, p);
    var sub = p.s || schema.title || null;
    var unit = p.u || schema.unit || "";
    var fmt = p.f && ADV_FMT[p.f] ? ADV_FMT[p.f] : (unit ? function (x) { return String(x) + unit; } : null);
    var save = function (v) { if (isLocked(full + "." + v)) return lockedTap(); saveSetting(sec, key, v); };
    if (ADV_READONLY[key] || (Array.isArray(val) && p.kind !== "days" && key !== "disabled_days")) {
      var items = Array.isArray(val) ? val.map(String) : [];
      return ctlRow(key === "overrides" ? "Переопределено" : title, key === "overrides" ? "Ключи, заданные отдельно для этого направления" : sub,
        h("div", { class: "desc", style: "margin:0", text: items.length ? items.join(", ") : "— (как в общих параметрах)" }), false);
    }
    if (typeof val === "boolean") {
      var sw = switchEl(val, { aria: title, onChange: function (v, inp) { if (locked) { inp.checked = val; lockedTap(); return; } saveSetting(sec, key, v); } });
      return toggleRow([title, locked ? lockBadge() : null], sub, sw, "dense" + (locked ? " is-locked" : ""));
    }
    if (p.kind === "days" || key === "disabled_days" || key === "autotrade_disabled_days") return daysCtl(title, sub, sec, key, val, locked);
    var opts = advOptions(full, p, schema, op);
    if (Array.isArray(opts) && opts.length) {
      return ctlRow(title, sub, seg(opts, val, save, locked, fmt, true), locked);
    }
    if (typeof val === "number") {
      var n = p.n || (schema.min != null && schema.max != null ? schema : null);
      if (n) return ctlRow(title, sub, stepper(val, num(n.min), num(n.max), num(n.step) || 1, save, locked, unit), locked, true);
      return ctlRow(title, sub, advInput("number", val, save, locked), locked);
    }
    if (typeof val === "string") return ctlRow(title, sub, advInput("text", val, save, locked), locked);
    if (val === null || val === undefined) return ctlRow(title, sub, advInput("text", "", save, locked), locked);
    return ctlRow(title, sub, h("code", { class: "desc", style: "margin:0;word-break:break-all", text: JSON.stringify(val) }), locked);
  }
  // One settings/all object (a section or a nested D9 block) → group card(s). Nested
  // objects become their own cards after the parent's leaf controls.
  function advSection(root, path, obj, op, known, counter) {
    var leaf = [], nested = [];
    Object.keys(obj).forEach(function (k) {
      if (known.indexOf(k) >= 0) return;
      var v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) nested.push(k); else leaf.push(k);
    });
    if (leaf.length) {
      var meta = ADV_GROUP[path] || [path.replace(/[._]/g, " "), "Раздел settings/all: " + path];
      var g = groupCard(meta[0], meta[1]);
      leaf.forEach(function (k) { g.appendChild(advControl(path, k, obj[k], op)); counter.n++; });
      if (path === "levels.long" || path === "levels.short") {
        // the bot's «Сбросить» of the direction override (long_cfg / short_cfg = "{}")
        g.appendChild(h("div", { class: "btn-row mt12" },
          h("button", { class: "btn btn-dark btn-sm", type: "button", disabled: isLocked(path + ".reset") ? true : null,
            onclick: function () { actionSetting(path, "reset", true, "Переопределения сброшены"); } }, "Сбросить", icon("refresh"))));
      }
      if (path === "risk.advanced") {
        // kb_auto_trade «♻️ Сбросить все фильтры (ONE-CLICK)»
        g.appendChild(h("div", { class: "btn-row mt12" },
          h("button", { class: "btn btn-dark btn-sm danger", type: "button", disabled: isLocked(path + ".reset_all_filters") ? true : null,
            onclick: function () { actionSetting(path, "reset_all_filters", true, "Все фильтры сброшены"); } }, "♻️ Сбросить все фильтры")));
      }
      root.appendChild(g);
    }
    nested.forEach(function (k) { advSection(root, path + "." + k, obj[k], op, [], counter); });
  }
  function secAdvanced(root) {
    settingsGate(root, function (st, op) {
      root.appendChild(hintCard("Экран-заглушка: здесь показывается всё, что сервер отдаёт в settings/all сверх основных разделов — параметры, которые в боте менялись через Telegram-меню. Подписи и наборы значений — как в меню бота, остальное — по имени ключа.", ""));
      var counter = { n: 0 }, misc = [];
      if (st.ui_mode != null) {
        var g0 = groupCard("Интерфейс", "Режим меню бота: простой или эксперт");
        g0.appendChild(advControl("", "ui_mode", st.ui_mode, op));
        root.appendChild(g0); counter.n++;
      }
      Object.keys(st).forEach(function (sec) {
        if (sec === "ui_mode" || ADV_SKIP_TOP[sec]) return;
        var v = st[sec];
        if (v && typeof v === "object" && !Array.isArray(v)) advSection(root, sec, v, op, KNOWN_KEYS[sec] || [], counter);
        else if (v === null || typeof v !== "object") misc.push(sec);
      });
      if (misc.length) {
        var gm = groupCard("Прочее", "Параметры верхнего уровня settings/all");
        misc.forEach(function (k) { gm.appendChild(advControl("", k, st[k], op)); counter.n++; });
        root.appendChild(gm);
      }
      if (!counter.n) root.appendChild(emptyCard("Дополнительных параметров нет", "Сервер пока не отдаёт параметры сверх основных разделов. Как только они появятся в settings/all — покажутся здесь автоматически."));
    });
  }

  var SECTION_RENDER = {
    strategies: secStrategies, autotrade: secAutotrade, risk: secRisk, exchanges: secExchanges,
    positions: secPositions, stats: secStats, plan: secPlan, help: secHelp, feedback: secFeedback, lang: secLang,
    challenge: secChallenge, advanced: secAdvanced
  };
  var SECTION_RIGHT = {
    challenge: function () { var c = S.sec.challenge; return refreshBtn(function () { loadChallenge(true); }, !!(c && c.loading)); },
    positions: function () { var c = S.sec.positions; return refreshBtn(function () { secLoad("positions", "positions", true); rerenderSub(); }, !!(c && c.loading)); },
    stats: function () { var c = S.sec[statsKey()]; return refreshBtn(function () { loadStats(true); rerenderSub(); }, !!(c && c.loading)); },
    exchanges: function () { var c = S.sec.settings; return refreshBtn(function () { secLoad("settings", "settings/all", true); rerenderSub(); }, !!(c && c.loading)); }
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function loadCore() {
    return Promise.all([
      api("me").then(function (d) { okOrThrow(d); S.me = d; setPlanBadge(); }),
      api("dashboard").then(function (d) { okOrThrow(d); S.dash = d; S.dashAt = Date.now(); })
    ]).catch(function (e) {
      if (e && e.code === "unauthorized") return;
      toast(errText(e && e.code), true);
      if (!S.me) {
        clear(view);
        view.appendChild(h("div", { class: "fatal screen" },
          h("div", { class: "h1 center", text: "Нет связи" }),
          h("p", { class: "muted", text: errText(e && e.code) }),
          h("button", { class: "btn btn-red mt16", type: "button", onclick: function () { render(); loadCore(); } }, "Повторить", icon("refresh"))));
        return;
      }
      if (!S.dash) S.dash = { stats: {}, market: {}, recent: [], trend: {} };
    }).then(function () {
      if (S.me && !S.detail && view.querySelector(".fatal") === null) render();
      if (S.me) { Live.start(); refreshUnread(); }
    });
  }

  function refreshDash() {
    api("dashboard").then(function (d) {
      S.dashLoading = false;
      if (d && d.ok) { S.dash = d; S.dashAt = Date.now(); if (S.tab === "home") rerender("home"); }
    }).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // LIVE EVENTS — GET /api/app/events (SSE). Read with fetch() so the JWT travels in the
  // Authorization header (EventSource cannot send one). The Mini App polling stays the
  // baseline (decision D2: 30 s caches + visibilitychange): an event only drops those caches
  // and refreshes the screen on view, so a buffered or dropped stream never loses anything.
  // Reconnects after the server's `retry:` (10 s); a 401 refreshes the token once, then stops.
  // ---------------------------------------------------------------------------
  var Live = (function () {
    var ctrl = null, timer = null, gen = 0, retryMs = 10000, kick = null;
    var REFRESH_ON = { signal: 1, progress: 1, trade: 1 };
    function supported() {
      return typeof fetch === "function" && typeof AbortController !== "undefined" && typeof TextDecoder !== "undefined";
    }
    function stop() {
      gen++;
      if (timer) { clearTimeout(timer); timer = null; }
      if (kick) { clearTimeout(kick); kick = null; }
      if (ctrl) { try { ctrl.abort(); } catch (e) { /* gone */ } ctrl = null; }
    }
    function later(ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = null; start(); }, ms);
    }
    // several frames arrive together (card edit + notification + notice): one refresh for all
    function refreshSoon() {
      if (kick) return;
      kick = setTimeout(function () {
        kick = null;
        S.dashAt = 0;
        Object.keys(S.sigs).forEach(function (k) { if (S.sigs[k]) S.sigs[k].at = 0; });
        if (document.hidden || S.detail || !S.me) return;   // visibilitychange / closing the detail reloads
        if (S.tab === "home") refreshDash();
        else if (S.tab === "signals") loadSignals(false);
      }, 1200);
    }
    function onBlock(block) {
      var name = "message", data = [];
      block.split(/\r\n|\r|\n/).forEach(function (line) {
        if (!line || line.charAt(0) === ":") return;           // heartbeat comment
        var i = line.indexOf(":");
        var field = i < 0 ? line : line.slice(0, i);
        var val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "event") name = val;
        else if (field === "data") data.push(val);
        else if (field === "retry" && /^\d+$/.test(val)) retryMs = Math.max(1000, Number(val));
      });
      if (data.length && REFRESH_ON[name]) refreshSoon();
      if (data.length && name === "notification") { if (IB.open) loadInbox(false); else refreshUnread(); }
    }
    function start() {
      if (DEMO || ctrl || !supported() || !Auth.access()) return;
      var my = ++gen;
      ctrl = new AbortController();
      var wait = retryMs;
      fetch(API_BASE + "events", {
        headers: { "Accept": "text/event-stream", "Authorization": "Bearer " + Auth.access() },
        signal: ctrl.signal, credentials: "same-origin", cache: "no-store"
      }).then(function (res) {
        if (res.status === 401) {
          wait = -1;
          return tryRefresh().then(function (ok) { if (ok) wait = 0; });
        }
        var type = (res.headers && res.headers.get("Content-Type")) || "";
        if (!res.ok || !res.body || !res.body.getReader || type.indexOf("text/event-stream") !== 0) { wait = 60000; return; }
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (my !== gen) { try { reader.cancel(); } catch (e) { /* gone */ } return; }
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            var m;
            while ((m = /\r\n\r\n|\n\n|\r\r/.exec(buf))) {
              onBlock(buf.slice(0, m.index));
              buf = buf.slice(m.index + m[0].length);
            }
            return pump();
          });
        }
        return pump();
      }).catch(function () { /* dropped / aborted: reconnect below */ })
        .then(function () {
          if (my !== gen) return;
          ctrl = null;
          if (wait >= 0) later(wait);
        });
    }
    return { start: start, stop: stop };
  })();

  // ---------------------------------------------------------------------------
  // INBOX (M12b) — the bot's chat for a site user: every engine message (reports, challenge,
  // advice, reminders, drip, upgrade prompts, trend, trades) with its buttons. GET
  // /api/notifications (newest first, 30 a page); opening the inbox marks everything read. A
  // button is a site path / https link or a callback the server stored with its route
  // (services/notificationsService.normalizeActions: engagement/optout, entry-advice/on|keep);
  // the answer is the bot's alert text. Bodies are the bot's HTML, shown as text (textContent).
  // ---------------------------------------------------------------------------
  var INBOX_PAGE = 30;
  var INBOX_ROUTES = [/^engagement\/optout$/, /^entry-advice\/(?:on|keep)$/];
  var IB = { open: false, list: [], loading: false, err: null, more: false, unread: 0, answers: {}, busy: false };
  var inboxEl = $("#inbox");
  var siteApi = function (path, opts) { opts = opts || {}; opts.base = "/api/"; return api(path, opts); };

  function setUnread(n) {
    IB.unread = Math.max(0, num(n) || 0);
    var b = $("#inbox-count"), btn = $("#inbox-btn");
    if (!b || !btn) return;
    btn.hidden = !S.me;
    b.hidden = IB.unread === 0;
    b.textContent = IB.unread > 99 ? "99+" : String(IB.unread);
    btn.setAttribute("aria-label", IB.unread ? "Уведомления: " + IB.unread + " новых" : "Уведомления");
  }
  function refreshUnread() {
    if (!S.me) return;
    siteApi("notifications/unread-count", { timeout: 15000 }).then(function (d) {
      setUnread(d && d.count);
    }).catch(function () { /* the badge waits for the next event */ });
  }
  function noteTime(n) {
    var raw = String((n && n.createdAt) || "");
    var t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(" ", "T") + "Z");
    return isFinite(t) ? t / 1000 : null;
  }
  function loadInbox(append) {
    if (IB.loading) return;
    IB.loading = true; IB.err = null;
    if (!append) drawInbox();
    var offset = append ? IB.list.length : 0;
    siteApi("notifications?limit=" + INBOX_PAGE + "&offset=" + offset, { timeout: 15000 }).then(function (d) {
      var rows = d && Array.isArray(d.notifications) ? d.notifications : [];
      IB.list = append ? IB.list.concat(rows) : rows;
      IB.more = rows.length === INBOX_PAGE;
      if (!append && IB.list.some(function (n) { return !n.readAt; })) {
        siteApi("notifications/read-all", { method: "POST", body: {} }).then(function () { setUnread(0); }).catch(function () { /* stays unread */ });
      } else if (!append) setUnread(0);
    }).catch(function (e) {
      IB.err = (e && e.code) || "network";
    }).then(function () {
      IB.loading = false;
      drawInbox();
    });
  }
  function openInbox(fromNav) {
    if (IB.open) return;
    if (S.detail) closeDetail(true);
    IB.open = true; IB.answers = {};
    S.savedScroll = window.scrollY || 0;
    view.hidden = true;
    $("#tabbar").hidden = true;
    inboxEl.hidden = false;
    window.scrollTo(0, 0);
    hap("light");
    if (!fromNav) navPush();
    loadInbox(false);
  }
  function closeInbox(silent) {
    if (!IB.open) return;
    IB.open = false;
    inboxEl.hidden = true;
    clear(inboxEl);
    view.hidden = false;
    $("#tabbar").hidden = false;
    if (!silent) { hap("light"); render(); window.scrollTo(0, S.savedScroll); }
  }
  // a site path or https link of a notification (its link or a url button)
  function openNoteLink(url) {
    if (typeof url !== "string" || !url) return;
    if (/^https:\/\//i.test(url)) { openExternal(url); return; }
    if (url.charAt(0) !== "/" || url.charAt(1) === "/" || url.charAt(1) === "\\" || /^\/api(?:\/|$)/i.test(url)) return;
    var m = /^\/app\/?(?:\?(.*))?$/.exec(url.split("#")[0]);
    if (!m) { location.href = url; return; }
    var q = new URLSearchParams(m[1] || "");
    var tab = q.get("tab") || "home", sec = q.get("sec"), id = q.get("id");
    if (!sec && tab !== "settings" && SECTION_IDS.indexOf(tab) >= 0) sec = tab;   // ?tab=stats → the Statistics section
    closeInbox(true);
    if (tab === "settings" || (sec && SECTION_IDS.indexOf(sec) >= 0)) {
      S.tab = "profile"; syncTabs();
      openSub(sec && SECTION_IDS.indexOf(sec) >= 0 ? sec : "settings", true);
      return;
    }
    setTab(/^(home|signals|analyze|profile)$/.test(tab) ? tab : "home");
    if (id && S.sigById[id]) openDetail(S.sigById[id]);
  }
  function pressNoteButton(n, b) {
    if (IB.busy) return;
    if (b.kind === "url") { openNoteLink(b.url); return; }
    var route = b.api && typeof b.api.path === "string" ? b.api.path : "";
    if (!INBOX_ROUTES.some(function (re) { return re.test(route); })) return;
    IB.busy = true; hap("light");
    drawInbox();
    api(route, { method: "POST", body: { action: String(b.action || "") }, timeout: 20000 }).then(function (d) {
      var text = d && (d.message || d.text || (d.alert && d.alert.text));
      IB.answers[n.id] = { text: text ? htmlText(text) : (d && d.ok ? "Готово" : errText(d && d.error)), err: !(d && d.ok) };
      if (d && d.ok && d.remove_keyboard) {
        n.actions = null;
        siteApi("notifications/" + encodeURIComponent(n.id) + "/actions", { method: "DELETE" }).catch(function () { /* shown again next time */ });
      }
      hap(d && d.ok ? "success" : "error");
    }).catch(function (e) {
      IB.answers[n.id] = { text: errText(e && e.code), err: true };
    }).then(function () {
      IB.busy = false;
      drawInbox();
    });
  }
  function noteBody(n) {
    var title = String(n.title || "");
    var text = htmlText(n.body || "").replace(/\s+$/, "");
    var lines = text.split("\n");
    if (lines.length && htmlText(lines[0]).trim() === title.trim()) lines.shift();
    return lines.join("\n").replace(/^\s*\n/, "");
  }
  function noteCard(n) {
    var t = noteTime(n);
    var card = h("div", { class: "card pad inbox-item" + (n.readAt ? "" : " is-new") },
      h("div", { class: "inbox-meta" },
        h("span", { class: "inbox-time", text: t ? fmtDateTime(t) + " · " + ago(t) : "" }),
        n.readAt ? null : h("span", { class: "inbox-dot", "aria-label": "новое" })),
      h("div", { class: "inbox-title", text: n.title || "" }));
    var body = noteBody(n);
    if (body) card.appendChild(h("p", { class: "inbox-body", text: body }));
    var btns = [];
    (Array.isArray(n.actions) ? n.actions : []).forEach(function (row) {
      (Array.isArray(row) ? row : []).forEach(function (b) {
        if (!b || !b.label) return;
        if (b.kind === "url" || (b.kind === "callback" && b.api)) btns.push(b);
      });
    });
    if (!btns.length && n.link) btns.push({ label: "Открыть", kind: "url", url: n.link });
    if (btns.length) {
      var wrap = h("div", { class: "stack inbox-actions" });
      btns.forEach(function (b) {
        wrap.appendChild(h("button", { class: "btn btn-dark btn-block", type: "button", disabled: IB.busy ? "disabled" : null,
          onclick: function () { pressNoteButton(n, b); } }, b.label));
      });
      card.appendChild(wrap);
    }
    var ans = IB.answers[n.id];
    if (ans) card.appendChild(h("p", { class: "trade-answer" + (ans.err ? " err" : ""), text: ans.text }));
    return card;
  }
  function drawInbox() {
    if (!IB.open) return;
    clear(inboxEl);
    var inner = h("div", { class: "detail-inner" },
      h("button", { class: "back", type: "button", onclick: goBack }, icon("back"), "Назад"),
      h("div", { class: "detail-title" }, h("div", { class: "h1", text: "Уведомления" })));
    if (IB.loading && !IB.list.length) inner.appendChild(h("p", { class: "muted mt16", text: "Загрузка…" }));
    else if (IB.err && !IB.list.length) {
      inner.appendChild(h("p", { class: "muted mt16", text: errText(IB.err) }));
      inner.appendChild(h("button", { class: "btn btn-dark mt16", type: "button", onclick: function () { loadInbox(false); } }, "Повторить", icon("refresh")));
    } else if (!IB.list.length) {
      inner.appendChild(h("p", { class: "muted mt16", text: "Здесь появятся отчёты, челлендж, советы и сообщения о сделках — всё, что бот присылает в чат." }));
    } else {
      var list = h("div", { class: "stack mt16" });
      IB.list.forEach(function (n) { list.appendChild(noteCard(n)); });
      inner.appendChild(list);
      if (IB.more) {
        inner.appendChild(h("button", { class: "btn btn-dark btn-block mt16", type: "button", disabled: IB.loading ? "disabled" : null,
          onclick: function () { loadInbox(true); } }, IB.loading ? "Загрузка…" : "Показать ещё"));
      }
    }
    inboxEl.appendChild(inner);
  }

  function boot() {
    setPlanBadge();
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function (e) { setTab(e.currentTarget.getAttribute("data-tab")); });
    }
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && (S.detail || IB.open)) goBack(); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && S.me && Date.now() - S.dashAt > 60000) refreshDash();
      if (!document.hidden && S.me && !IB.open) refreshUnread();
    });
    var ib = $("#inbox-btn");
    if (ib) ib.addEventListener("click", function () { openInbox(false); });
    window.addEventListener("popstate", function (e) { applyNav(e.state); });
    window.addEventListener("message", onTgMessage);
    var start = QS.get("tab");
    if (start && /^(home|signals|analyze|profile)$/.test(start)) S.tab = start;
    if (start === "settings") { S.tab = "profile"; S.sub = "settings"; }
    else if (start && SECTION_IDS.indexOf(start) >= 0) { S.tab = "profile"; S.sub = start; }   // the engine's ?tab=stats
    var sec = QS.get("sec");
    if (sec && SECTION_IDS.indexOf(sec) >= 0) { S.tab = "profile"; S.sub = sec; }
    syncTabs();
    navReplace();   // the entry we start on is the deep-linked screen itself
    var tgRes = DEMO ? null : tgAuthFromHash();
    if (tgRes) { showLogin(); finishTelegram(tgRes); return; }
    if (!DEMO && !Auth.access() && !Auth.refresh()) { showLogin(); return; }
    // ?next= with a session whose access token ran out (why the legacy page sent the visitor here):
    // one refresh, then straight back; a dead refresh token → the sign-in. A live access token
    // means the page sent us here for another reason: the app opens as usual (no redirect loop).
    if (NEXT && !tokenLive(Auth.access()) && Auth.refresh()) {
      tryRefresh().then(function (ok) {
        if (ok) { location.replace(NEXT); return; }
        Auth.clear();
        showLogin();
      });
      return;
    }
    render();
    loadCore();
  }
  function tokenLive(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return typeof p.exp === "number" && p.exp * 1000 > Date.now() + 5000;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------------------
  // DEMO mock backend (design preview, no backend: ?demo=1|pro|empty)
  //   ?demo=1      Free user with LEVELS LONG only
  //   ?demo=pro    Pro user, 3 strategies (2 running in parallel), genome
  //   ?demo=empty  fresh Free user with no signals (empty states)
  //   ?genome=off  /genome endpoint missing (block must hide)
  //   ?api=off     the "new" endpoints 404 (placeholders must render)
  // ---------------------------------------------------------------------------
  var Mock = (function () {
    var now = Math.floor(Date.now() / 1000);
    var demoMode = QS.get("demo") || "";
    var demoPro = demoMode === "pro";
    var demoEmpty = demoMode === "empty";
    var flags = {
      LEVELS: { long: true, short: false },
      SMC: { long: demoPro, short: demoPro },
      VOLUME: { long: demoPro, short: false }
    };
    var locked = { LEVELS: false, SMC: !demoPro, VOLUME: !demoPro };
    var me = {
      ok: true,
      user: { id: 7107654772, username: "alex_trader", first_name: "Alex", lang: "ru",
        plan: demoPro ? "pro" : "free", plan_label: demoPro ? "Pro" : "Free", sub_expires: demoPro ? now + 86400 * 41 : 0, is_pro: demoPro },
      strategy: demoPro ? "SMC" : "LEVELS",
      extra_strategies: demoPro ? "VOLUME" : "",
      strategies: {},
      prefs: { progress_notify_enabled: true, send_chart_enabled: true, genome_auto_apply: demoPro, signal_format: "full" },
      auto_trade: demoPro,
      exchange: demoPro ? "bingx" : "",
      bot_username: "CHM_signalS_bot"
    };
    function extras() { return me.extra_strategies ? me.extra_strategies.split(",") : []; }
    function syncStrategies() {
      var ex = extras();
      STRAT_ORDER.forEach(function (k) {
        var f = flags[k];
        var running = (k === me.strategy || ex.indexOf(k) >= 0) && !locked[k];
        me.strategies[k] = { long: f.long, short: f.short, locked: locked[k], primary: k === me.strategy, enabled: running && (f.long || f.short) };
      });
    }
    function applyMulti(k, on) {   // mirrors miniapp_api._apply_multi
      var ex = extras().filter(function (x) { return x !== me.strategy; });
      if (on) {
        if (k !== me.strategy) {
          var pf = flags[me.strategy];
          if (pf && (pf.long || pf.short)) { if (ex.indexOf(k) < 0) ex.push(k); }
          else { me.strategy = k; ex = ex.filter(function (x) { return x !== k; }); }
        }
      } else if (ex.indexOf(k) >= 0) ex.splice(ex.indexOf(k), 1);
      else if (k === me.strategy && ex.length) me.strategy = ex.shift();
      me.extra_strategies = STRAT_ORDER.filter(function (x) { return ex.indexOf(x) >= 0; }).join(",");
    }
    syncStrategies();

    function sig(id, sym, dir, strat, tf, entry, slPct, q, minsAgo, status, rNow) {
      var long = dir === "LONG";
      var risk = entry * slPct;
      var sl = long ? entry - risk : entry + risk;
      var tp = function (k) { return long ? entry + risk * k : entry - risk * k; };
      var rr = { tp3: 3.5, sl: -1, be: 0, closed: 0.6 }[status];
      var o = { id: "7107654772_" + (1791314326939 + id) + "_" + id, symbol: sym, pair: sym + "/USDT", direction: dir, strategy: strat,
        timeframe: tf, entry: entry, sl: sl, tp1: tp(1.5), tp2: tp(2.5), tp3: tp(3.5), quality: q,
        created_at: now - minsAgo * 60, status: status, rr: rr == null ? null : rr };
      if (rNow != null) { o.r_now = rNow; o.price = long ? entry + risk * rNow : entry - risk * rNow; }
      return o;
    }
    var signals = demoEmpty ? [] : [
      sig(1, "ETH", "SHORT", "SMC", "1h", 2698.79, 0.01094, 4, 38, "open", 0.84),
      sig(2, "SOL", "LONG", "SMC", "15m", 142.356, 0.0085, 5, 95, "tp2", 2.71),
      sig(3, "PEPE", "LONG", "VOLUME", "1h", 0.00001234, 0.021, 3, 160, "tp1", 1.22),
      sig(4, "BTC", "LONG", "LEVELS", "4h", 85400.1, 0.0072, 4, 300, "open", -0.37),
      sig(5, "DOGE", "SHORT", "SMC", "1h", 0.17123, 0.0124, 3, 520, "sl"),
      sig(6, "XRP", "LONG", "LEVELS", "1h", 2.1834, 0.0098, 4, 780, "tp3"),
      sig(7, "LINK", "SHORT", "VOLUME", "4h", 15.428, 0.0151, 2, 1300, "be"),
      sig(8, "TON", "LONG", "LEVELS", "15m", 3.2157, 0.0088, 3, 2100, "closed"),
      sig(9, "AVAX", "SHORT", "LEVELS", "1h", 24.37, 0.0132, 3, 2600, "open")
    ];
    var CLOSED = { sl: 1, be: 1, closed: 1, tp3: 1, skip: 1, expired: 1, missed: 1 };

    function blank() { return { signals: 0, trades: 0, wins: 0, losses: 0, win_rate: 0, total_rr: 0, rr_7d: 0 }; }
    function round2(x) { return Math.round(x * 100) / 100; }
    function buildStats() {
      var rnd = seeded(demoPro ? "eq-pro" : "eq-free");
      var keys = demoPro ? STRAT_ORDER : ["LEVELS"];
      var n = demoEmpty ? 0 : demoPro ? 42 : 14;
      var tot = blank(), per = {};
      STRAT_ORDER.forEach(function (k) { per[k] = blank(); });
      var equity = [], cum = 0, best = null, t0 = now - 30 * 86400;
      for (var i = 0; i < n; i++) {
        var k = keys[Math.floor(rnd() * keys.length)];
        var x = rnd();
        var r = x < 0.46 ? -1 : x < 0.53 ? 0 : x < 0.78 ? 1.5 : x < 0.93 ? 2.5 : 3.5;
        if (r === 1.5 && rnd() < 0.3) r = 0.6;
        var t = t0 + Math.floor((i + 1) / (n + 1) * 29.5 * 86400);
        [tot, per[k]].forEach(function (b) {
          b.signals++; b.trades++;
          if (r > 0) b.wins++;
          if (r < 0) b.losses++;
          b.total_rr += r;
          if (t > now - 7 * 86400) b.rr_7d += r;
        });
        cum += r;
        equity.push({ t: t, r: round2(cum) });
        if (best === null || r > best) best = r;
      }
      var extra = demoEmpty ? 0 : signals.filter(function (s) { return !CLOSED[s.status]; });
      (extra || []).forEach(function (s) { tot.signals++; if (per[s.strategy]) per[s.strategy].signals++; });
      [tot].concat(STRAT_ORDER.map(function (k) { return per[k]; })).forEach(function (b) {
        if (b.trades) b.win_rate = Math.round(b.wins / b.trades * 1000) / 10;
        b.total_rr = round2(b.total_rr); b.rr_7d = round2(b.rr_7d);
      });
      tot.days = 30;
      tot.open = (extra || []).length;
      tot.best_rr = best;
      tot.equity = equity;
      tot.per_strategy = per;
      return tot;
    }
    var dashboard = {
      ok: true,
      stats: buildStats(),
      market: { BTC: { price: 85400.1, change_pct: -0.31 }, ETH: { price: 2689.5, change_pct: 0.42 } },
      recent: signals.slice(0, 6),
      trend: { BTC: { H1: "up", H4: "up", D1: "down", W1: "up" }, ETH: { H1: "down", H4: "flat", D1: "up", W1: "unknown" } }
    };
    var genome = demoPro ? {
      ok: true, available: true, auto_apply: me.prefs.genome_auto_apply,
      strategies: {
        LEVELS: { timeframe: "1h", generation: 14, fitness: 0.62, win_rate: 54.2, profit_factor: 1.62, updated_at: now - 86400 * 1.3, applied: true },
        SMC: { timeframe: "15m", generation: 9, fitness: 0.48, win_rate: 48.7, profit_factor: 1.21, updated_at: now - 3600 * 5, applied: false },
        VOLUME: { timeframe: "1h", generation: null, fitness: null, win_rate: null, profit_factor: null, updated_at: null, applied: false }
      }
    } : { ok: true, available: false, auto_apply: false, strategies: {} };
    var PRICES = { BTC: 85400.1, ETH: 2689.5, SOL: 142.36, TON: 3.2157, XRP: 2.1834, DOGE: 0.17123, PEPE: 0.00001234, LINK: 15.428, BNB: 598.4, ADA: 0.6621, AVAX: 24.37, SUI: 3.412 };

    // ----- "Новое" endpoints (settings/all, exchange/keys, positions, feedback, plan, stats, help, lang)
    var settingsAll = {
      lang: "ru", ui_mode: demoPro ? "expert" : "simple",
      levels: { long_tf: "1h", short_tf: "4h", min_quality: 6, min_volume_usdt: 1000000, min_rr: 2, max_dist_pct: 2, zone_pct: 1,
        use_rsi: true, use_volume: true, use_htf: true, trend_only: false, max_risk_pct: 2 },
      smc: { tf_key: "1H", direction: "BOTH", min_volume_usdt: 5000000, max_sl_pct: 3, scan_interval: 300 },
      volume: { timeframe: "1h", setup_cross: true, setup_turn: false, setup_bounce: true, setup_golden: true, setup_ribbon: true, ma_type: "sma", vol_mult: 1.8, use_htf: true, min_quality: 3 },
      trading: { auto_trade: demoPro, auto_trade_mode: "auto", trade_exchange: demoPro ? "bingx" : "", trade_risk_pct: 1, trade_leverage: 5, max_trades_limit: 3,
        risk_mode: "risk", partial_tp_enabled: true, auto_trailing_enabled: true, prefer_market_entry: false, bybit_demo: false },
      risk: { sl_streak_enabled: true, sl_streak_threshold: 3, circuit_breaker_enabled: demoPro, circuit_breaker_threshold_r: 5, allow_counter_trend: false,
        filters_all_off: false, btc_correlation_block: true, spread_check_enabled: true, trade_trending_only: false, hour_filter_enabled: false },
      exchanges: {
        bybit: { connected: false, key_hint: "" },
        bingx: { connected: demoPro, key_hint: demoPro ? "Kx7q…fA" : "" },
        binance: { connected: false, key_hint: "" },
        okx: { connected: demoPro, key_hint: demoPro ? "9c1e…b2" : "" }
      },
      notifications: { progress_notify_enabled: true, send_chart_enabled: true, signal_format: "full" },
      genome_auto_apply: demoPro
    };
    var settingsOptions = {
      tf_levels: ["15m", "30m", "1h", "4h", "1d"], tf_smc: ["15m", "1H", "4H"], tf_volume: ["15m", "1h", "4h"],
      exchanges: ["bybit", "bingx", "binance", "okx"], leverage: [1, 2, 3, 5, 10, 20], risk_pct: [0.25, 0.5, 1, 1.5, 2, 3],
      max_trades: [1, 2, 3, 5, 10], min_volume: [300000, 1000000, 5000000, 10000000, 25000000, 50000000],
      locked: demoPro ? [] : ["trading.*", "smc.*", "volume.*", "risk.circuit_breaker_enabled", "risk.circuit_breaker_threshold_r", "risk.hour_filter_enabled", "levels.max_risk_pct"]
    };
    function mockLocked(key) {
      var L = settingsOptions.locked, sec = key.split(".")[0];
      return L.some(function (k) { return k === key || k === sec + ".*" || k === sec; });
    }
    var positions = demoPro && !demoEmpty ? [
      { exchange: "bingx", symbol: "ETH-USDT", side: "SHORT", size: 0.42, entry: 2698.79, mark: 2674.1, pnl_usd: 10.37, pnl_pct: 4.57, leverage: 5 },
      { exchange: "bingx", symbol: "BTC-USDT", side: "LONG", size: 0.012, entry: 85400.1, mark: 85172.5, pnl_usd: -2.73, pnl_pct: -1.33, leverage: 5 },
      { exchange: "okx", symbol: "SOL-USDT-SWAP", side: "LONG", size: 6, entry: 142.356, mark: 145.9, pnl_usd: 21.26, pnl_pct: 12.4, leverage: 5 }
    ] : [];
    var plan = {
      ok: true, plan: me.user.plan, plan_label: me.user.plan_label, sub_expires: me.user.sub_expires, days_left: demoPro ? 41 : 0, price_usd: 69,
      features: ["3 стратегии параллельно: Уровни, SMC, Объём + MA", "LONG и SHORT одновременно", "Авто-трейд на Bybit, BingX, Binance, OKX",
        "Strategy Genome — авто-подбор параметров", "Частичные TP, трейлинг, risk management", "Приоритетная поддержка"],
      ton: { address: "UQB5xJm3v9Kq2wLrT8dN4cPzYh1sVeF0aGbRkXoWuJ6tCzMl", amount_ton: 24.5, comment: "chm-7107654772",
        deeplink: "ton://transfer/UQB5xJm3v9Kq2wLrT8dN4cPzYh1sVeF0aGbRkXoWuJ6tCzMl?amount=24500000000&text=chm-7107654772" },
      admin_contact: "@chm_support"
    };
    var help = { ok: true, sections: [
      { id: "start", title: "Как начать", text: "Выберите стратегию в профиле и включите направление LONG или SHORT. Бот сканирует рынок и присылает сигналы с входом, стопом и целями.\n\nPro открывает все три стратегии параллельно и автотрейд." },
      { id: "signals", title: "Как читать сигнал", text: "Вход — цена входа. SL — стоп, 1R — расстояние от входа до стопа. TP1/TP2/TP3 — цели в R. Качество — оценка сетапа по фильтрам стратегии." },
      { id: "auto", title: "Авто-трейд", text: "Подключите API-ключи биржи в разделе «Биржи», затем включите авто-трейд. Риск на сделку — процент депозита, который теряется при стопе. Плечо влияет только на залог." },
      { id: "risk", title: "Risk Management", text: "SL-streak останавливает торговлю после серии стопов. Circuit Breaker — при дневном убытке в R. Эти защиты не отключаются kill-switch'ем." },
      { id: "genome", title: "Strategy Genome", text: "Генетический алгоритм подбирает параметры стратегий под текущий рынок. При включённом авто-применении лучший набор включается сам." }
    ] };
    function blankStat() { return { trades: 0, wins: 0, losses: 0, be: 0, total_rr: 0, win_rate: 0, winR: 0, lossR: 0 }; }
    function finStat(b) {
      if (b.trades) b.win_rate = Math.round(b.wins / b.trades * 1000) / 10;
      b.total_rr = round2(b.total_rr);
      return b;
    }
    function buildFullStats(days) {
      var rnd = seeded("stats" + days + (demoPro ? "p" : "f"));
      var n = demoEmpty ? 0 : Math.round((demoPro ? 42 : 14) * days / 30);
      var keys = demoPro ? STRAT_ORDER : ["LEVELS"];
      var sum = blankStat(), byS = {}, byH = { asia: blankStat(), europe: blankStat(), us: blankStat() }, byW = [], eq = [], cum = 0, pnl = 0;
      for (var w = 0; w < 7; w++) byW.push(blankStat());
      keys.forEach(function (k) { byS[k] = blankStat(); });
      for (var i = 0; i < n; i++) {
        var k = keys[Math.floor(rnd() * keys.length)];
        var x = rnd();
        var r = x < 0.46 ? -1 : x < 0.53 ? 0 : x < 0.78 ? 1.5 : x < 0.93 ? 2.5 : 3.5;
        if (r === 1.5 && rnd() < 0.3) r = 0.6;
        var sess = x < 0.3 ? "asia" : x < 0.62 ? "europe" : "us";
        var wd = Math.floor(rnd() * 7);
        [sum, byS[k], byH[sess], byW[wd]].forEach(function (b) {
          b.trades++; b.total_rr += r;
          if (r > 0) { b.wins++; b.winR += r; } else if (r < 0) { b.losses++; b.lossR += -r; } else b.be++;
        });
        cum += r; pnl += r * 18.4;
        eq.push({ t: now - days * 86400 + Math.floor((i + 1) / (n + 1) * days * 86400), r: round2(cum) });
      }
      finStat(sum); Object.keys(byS).forEach(function (k) { finStat(byS[k]); }); Object.keys(byH).forEach(function (k) { finStat(byH[k]); }); byW.forEach(finStat);
      var nonBe = sum.wins + sum.losses;
      var wr = nonBe ? sum.wins / nonBe : 0;
      var avgW = sum.wins ? sum.winR / sum.wins : 0, avgL = sum.losses ? sum.lossR / sum.losses : 0;
      return { ok: true,
        summary: { trades: sum.trades, wins: sum.wins, losses: sum.losses, be: sum.be, win_rate: sum.win_rate,
          avg_rr: sum.trades ? round2(sum.total_rr / sum.trades) : 0, total_rr: sum.total_rr,
          profit_factor: sum.lossR ? round2(sum.winR / sum.lossR) : (sum.winR ? 99 : 0), ev: round2(wr * avgW - (1 - wr) * avgL), pnl_usd: round2(pnl) },
        by_strategy: byS, by_session: byH, by_weekday: byW, equity: eq };
    }
    var NEW_PATHS = /^(settings\/all|exchange\/keys|exchange\/keys\/remove|positions|feedback|plan|stats|help|lang)$/;

    function delay(v, ms) { return new Promise(function (res) { setTimeout(function () { res(v); }, ms); }); }
    function clone(x) { return JSON.parse(JSON.stringify(x)); }

    // Canvas-drawn candlestick chart → base64 PNG (stands in for the server chart).
    function drawChart(sg, title) {
      var W = 720, H = 440, padR = 132, padT = 40, padB = 26;
      var c = document.createElement("canvas");
      c.width = W; c.height = H;
      var g = c.getContext("2d");
      var bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#1a0710"); bg.addColorStop(1, "#0b0306");
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      var entry = sg.entry, long = isLong(sg);
      var n = 64;
      var cs = genCandles(String(sg.id || title) + "chart", n, entry, 0.0045, long ? -1 : 1);
      var lo = Infinity, hi = -Infinity;
      cs.forEach(function (k) { lo = Math.min(lo, k.l); hi = Math.max(hi, k.h); });
      [sg.sl, sg.tp1, sg.tp2, sg.tp3].forEach(function (v) { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      var pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
      var y = function (v) { return padT + (hi - v) / (hi - lo) * (H - padT - padB); };
      // grid
      g.strokeStyle = "rgba(255,255,255,0.05)"; g.lineWidth = 1;
      for (var i = 0; i <= 6; i++) { var gy = padT + i * (H - padT - padB) / 6; g.beginPath(); g.moveTo(0, gy); g.lineTo(W - padR, gy); g.stroke(); }
      for (var j = 0; j <= 8; j++) { var gx = j * (W - padR) / 8; g.beginPath(); g.moveTo(gx, padT); g.lineTo(gx, H - padB); g.stroke(); }
      // zones
      var x0 = (W - padR) * 0.62;
      g.fillStyle = "rgba(61,242,160,0.07)"; g.fillRect(x0, Math.min(y(entry), y(sg.tp3)), W - padR - x0, Math.abs(y(sg.tp3) - y(entry)));
      g.fillStyle = "rgba(255,42,77,0.09)"; g.fillRect(x0, Math.min(y(entry), y(sg.sl)), W - padR - x0, Math.abs(y(sg.sl) - y(entry)));
      // candles
      var cw = (W - padR - 16) / n;
      cs.forEach(function (k, idx) {
        var x = 8 + idx * cw + cw / 2;
        var up = k.c >= k.o;
        g.strokeStyle = up ? "#3df2a0" : "#ff2a4d";
        g.fillStyle = up ? "#3df2a0" : "#ff2a4d";
        g.beginPath(); g.moveTo(x, y(k.h)); g.lineTo(x, y(k.l)); g.stroke();
        var top = Math.min(y(k.o), y(k.c)), bh = Math.max(1.5, Math.abs(y(k.o) - y(k.c)));
        g.fillRect(x - cw * 0.34, top, cw * 0.68, bh);
      });
      // levels
      g.font = "600 11.5px 'JetBrains Mono', monospace";
      var lv = [["TP3", sg.tp3, "#3df2a0"], ["TP2", sg.tp2, "#3df2a0"], ["TP1", sg.tp1, "#3df2a0"], ["ENTRY", entry, "#ffffff"], ["SL", sg.sl, "#ff2a4d"]];
      lv.forEach(function (l) {
        if (l[1] == null) return;
        var ly = y(l[1]);
        g.strokeStyle = l[2]; g.globalAlpha = l[0] === "ENTRY" ? 0.9 : 0.7; g.setLineDash(l[0] === "ENTRY" ? [] : [6, 5]);
        g.beginPath(); g.moveTo(0, ly); g.lineTo(W - padR, ly); g.stroke();
        g.setLineDash([]); g.globalAlpha = 1;
        g.fillStyle = l[0] === "SL" ? "#ff2a4d" : l[0] === "ENTRY" ? "#ffffff" : "#123a2a";
        g.fillRect(W - padR + 2, ly - 11, padR - 4, 22);
        g.fillStyle = l[0] === "ENTRY" ? "#14070b" : l[0] === "SL" ? "#ffffff" : "#3df2a0";
        g.fillText(l[0] + " " + fmtPrice(l[1]), W - padR + 6, ly + 4.5);
      });
      // title
      g.fillStyle = "#f6eef0"; g.font = "700 18px 'Oswald', 'Arial Narrow', sans-serif";
      g.fillText(String(title).toUpperCase() + "  ·  " + String(sg.timeframe || "1h").toUpperCase(), 14, 26);
      g.fillStyle = "rgba(246,238,240,0.35)"; g.font = "500 11px 'JetBrains Mono', monospace";
      g.fillText("CHM BREAKER · DEMO CHART", W - padR - 190, 26);
      return c.toDataURL("image/png").split(",")[1];
    }

    function analyze(body) {
      var sym = String(body.symbol || "").toUpperCase();
      if (!/^[A-Z0-9]{2,15}$/.test(sym)) return { ok: false, error: "bad_symbol" };
      var base = PRICES[sym];
      if (!base) {
        var r = seeded(sym)();
        if (r < 0.3) return { ok: false, error: "bad_symbol" };
        base = +(r * 40).toFixed(4);
      }
      var tried = body.strategy === "AUTO" ? ["LEVELS", "SMC", "VOLUME"] : [body.strategy];
      var rnd = seeded(sym + body.strategy);
      var price = { price: base, change_pct: +((rnd() - 0.5) * 6).toFixed(2) };
      if (sym === "DOGE" || sym === "ADA" || (rnd() < 0.2 && sym !== "BTC" && sym !== "ETH")) {
        return { ok: true, symbol: sym, price: price, signal: null, tried: tried, png: null };
      }
      var strat = body.strategy === "AUTO" ? ["SMC", "LEVELS", "VOLUME"][Math.floor(rnd() * 3)] : body.strategy;
      var long = rnd() > 0.4;
      var risk = base * (0.008 + rnd() * 0.01);
      var entry = base * (long ? 0.998 : 1.002);
      var setups = { LEVELS: ["Отскок от поддержки", "Пробой сопротивления"], SMC: ["Order Block + FVG", "Sweep ликвидности"], VOLUME: ["EMA200 Bounce", "MA Cross 10/20"] };
      var signal = {
        strategy: strat, direction: long ? "LONG" : "SHORT", entry: entry,
        sl: long ? entry - risk : entry + risk,
        tp1: long ? entry + risk : entry - risk,
        tp2: long ? entry + risk * 2 : entry - risk * 2,
        tp3: long ? entry + risk * 3 : entry - risk * 3,
        quality: 3 + Math.floor(rnd() * 3),
        setup: setups[strat][Math.floor(rnd() * 2)],
        reasons: [
          long ? "Цена выше EMA200 — тренд восходящий" : "Цена ниже EMA200 — тренд нисходящий",
          "Объём на сигнальной свече в 1.8× выше среднего",
          long ? "Свеча отказа (пин-бар) от зоны спроса" : "Свеча поглощения от зоны предложения",
          "RSI 14 = " + (long ? "41" : "63") + " — без перекупленности/перепроданности"
        ],
        bars_ago: Math.floor(rnd() * 3)
      };
      return { ok: true, symbol: sym, price: price, signal: signal, tried: tried, png: drawChart(signal, sym + "/USDT") };
    }

    var mockCh = null;   // [CHALLENGE] демо-состояние
    // [INBOX] демо-лента: отчёт, совет по входу, напоминание с отпиской, drip
    function sqlTime(sec) { return new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19); }
    var notes = demoEmpty ? [] : [
      { id: 4, type: "advice", title: "🎯 Тип входа: Уровни", body: "🎯 <b>Тип входа: Уровни</b>\n\nЗа 14 дней <b>6 из 15</b> сигналов Уровни (40%) ушли к цели без отката к входу — лимитный ордер не исполнился бы. Рыночный вход берёт такие движения по чуть худшей цене.\n\nВключить вход по рынку? Действует для автотрейда; выключить можно в Настройки → Риск-менеджмент.", link: "/app/?tab=settings&sec=risk",
        actions: [[{ label: "Включить вход по рынку", kind: "callback", action: "entry_market_on", api: { method: "POST", path: "entry-advice/on" } }], [{ label: "Оставить лимитный", kind: "callback", action: "entry_market_keep", api: { method: "POST", path: "entry-advice/keep" } }]],
        readAt: null, createdAt: sqlTime(now - 1500) },
      { id: 3, type: "report", title: "📊 Итоги недели · 29.09 – 05.10", body: "📊 <b>Итоги недели · 29.09 – 05.10</b>\n\nСигналов: <b>12</b> · закрыто 9\nTP: 6 · SL: 3 · винрейт 66.7%\nИтог: <b>+7.4R</b>", link: "/app/?tab=stats",
        actions: [[{ label: "📊 Подробнее в приложении", kind: "url", url: "/app/?tab=stats" }]], readAt: null, createdAt: sqlTime(now - 7200) },
      { id: 2, type: "reminder", title: "⏰ Через 3 дня закончится твой доступ", body: "⏰ <b>Через 3 дня закончится твой доступ</b>\n\nТы пользуешься CHM BREAKER уже несколько недель. Чтобы не потерять сигналы и автотрейд — оформи подписку.\n\n🆔 <code>7107654772</code>", link: "/app/?tab=settings&sec=plan",
        actions: [[{ label: "✍️ Оплатить — Написать админу", kind: "url", url: "https://t.me/crypto_chm" }], [{ label: "🔕 Не присылать напоминания", kind: "callback", action: "engagement_optout:7107654772", api: { method: "POST", path: "engagement/optout" } }]],
        readAt: sqlTime(now - 80000), createdAt: sqlTime(now - 86400) },
      { id: 1, type: "promo", title: "👋 Прошёл первый день в CHM Breaker.", body: "👋 <b>Прошёл первый день в CHM Breaker.</b>\n\nЗа эти сутки бот:\n  • Просканировал 150+ монет\n  • Применил стратегии LEVELS / SMC", link: "/app/?tab=stats",
        actions: [[{ label: "📊 Мои результаты", kind: "url", url: "/app/?tab=stats" }]], readAt: sqlTime(now - 170000), createdAt: sqlTime(now - 3 * 86400) }
    ];
    function handle(path, opts) {
      var body = opts.body || {};
      var p = path.split("?")[0];
      var q = new URLSearchParams(path.split("?")[1] || "");
      if (p === "me") return delay(clone(me), 250);
      if (p === "notifications") {
        var off = +q.get("offset") || 0, lim = +q.get("limit") || 30;
        return delay({ notifications: clone(notes.slice(off, off + lim)), unreadCount: notes.filter(function (n) { return !n.readAt; }).length }, 300);
      }
      if (p === "notifications/unread-count") return delay({ count: notes.filter(function (n) { return !n.readAt; }).length }, 150);
      if (p === "notifications/read-all") { notes.forEach(function (n) { if (!n.readAt) n.readAt = sqlTime(Math.floor(Date.now() / 1000)); }); return delay({ updated: 1 }, 150); }
      var nm = /^notifications\/(\d+)\/actions$/.exec(p);
      if (nm) { notes.forEach(function (n) { if (String(n.id) === nm[1]) n.actions = null; }); return delay({ updated: 1 }, 150); }
      if (p === "engagement/optout") return delay({ ok: true, show_alert: true, message: "🔕 Напоминания отключены. Если передумаешь — напиши админу." }, 300);
      if (p === "entry-advice/on") return delay({ ok: true, prefer_market_entry: true, show_alert: true, remove_keyboard: true, message: "🎯 Вход по рынку включён" }, 300);
      if (p === "entry-advice/keep") return delay({ ok: true, show_alert: false, remove_keyboard: true, message: "Оставляем лимитный вход" }, 300);
      if (p === "challenge") {                                   // [CHALLENGE] демо
        if (opts.body && !opts.body.preview) { mockCh = { ok: true, available: demoPro, active: true, challenge: { deposit: opts.body.deposit, goal_usd: opts.body.deposit * (1 + (opts.body.goal_kind === "pct" ? opts.body.goal_value / 100 : 0)), goal_profit_usd: opts.body.deposit * 0.25, r_needed: 25, risk_pct: opts.body.risk_pct, leverage: opts.body.leverage, max_trades_day: opts.body.max_trades_day, mode: opts.body.mode, term: opts.body.term, topups_total: 0 },
          plan: { profit_usd: opts.body.deposit * 0.25, r_needed: 25, risk_usd: opts.body.deposit / 100, margin_pct: 13.3, verdict: "ok", warnings: [], days_forecast: 20, hist_r_per_day: 1.2, r_per_day_needed: 0.8 },
          progress: { r_total: 3.5, pnl_usd: 35, pct_goal: 14, days_elapsed: 4, days_left: 26, pace_r: 0.2, today_signals: 1, today_r: 1.0, blocked: false, win_rate: 60, trades: 5, deposit_now: opts.body.deposit + 35, topups_total: 0 }, applied: ["trade_risk_pct"], skipped: [] }; return delay(clone(mockCh), 300); }
        if (opts.body && opts.body.preview) return delay({ ok: true, preview: true, challenge: { deposit: opts.body.deposit, goal_usd: opts.body.deposit * 1.25, term: opts.body.term, risk_pct: opts.body.risk_pct, leverage: opts.body.leverage }, plan: { profit_usd: opts.body.deposit * 0.25, r_needed: 25, risk_usd: opts.body.deposit / 100, margin_pct: 13.3, verdict: demoPro ? "ok" : "no_data", warnings: [], days_forecast: 20, hist_r_per_day: 1.2, r_per_day_needed: 0.8 } }, 300);
        return delay(clone(mockCh || { ok: true, available: demoPro, active: false, challenge: null, plan: null, progress: null }), 250);
      }
      if (p === "challenge/topup" || p === "challenge/finish") { if (p === "challenge/finish") mockCh = null; return delay(clone(mockCh || { ok: true, available: demoPro, active: false, challenge: null }), 200); }
      if (p === "dashboard") return delay(clone(dashboard), 350);
      if (p === "signals") {
        var st = q.get("status") || "all";
        var list = signals.filter(function (x) {
          if (st === "open") return !CLOSED[x.status];
          if (st === "closed") return !!CLOSED[x.status];
          return true;
        });
        return delay({ ok: true, signals: clone(list) }, 300);
      }
      var m = /^signals\/(.+)\/chart$/.exec(p);
      if (m) {
        var id = decodeURIComponent(m[1]);
        var sg = signals.filter(function (x) { return x.id === id; })[0];
        if (!sg) return delay({ ok: false, error: "no_data" }, 200);
        return delay({ ok: true, png: drawChart(sg, sg.pair) }, 600);
      }
      if (p === "strategy") {
        var k = String(body.strategy || "").toUpperCase();
        var f = flags[k];
        if (!f) return delay({ ok: false, error: "bad_strategy" }, 200);
        var wantL = !!body.long, wantS = !!body.short;
        if ((wantL || wantS) && locked[k]) return delay({ ok: false, error: "pro_required" }, 250);
        if (wantL && wantS && !demoPro) return delay({ ok: false, error: "pro_required" }, 250);
        f.long = wantL; f.short = wantS;
        applyMulti(k, wantL || wantS);
        syncStrategies();
        return delay({ ok: true, strategy: me.strategy, strategies: clone(me.strategies) }, 300);
      }
      if (p === "settings") {
        var changed = false;
        ["progress_notify_enabled", "send_chart_enabled", "genome_auto_apply"].forEach(function (key) {
          if (!(key in body)) return;
          if (key === "genome_auto_apply" && body[key] && !demoPro) { changed = "pro"; return; }
          me.prefs[key] = !!body[key]; changed = changed || true;
        });
        if ("signal_format" in body) { me.prefs.signal_format = body.signal_format === "lite" ? "lite" : "full"; changed = true; }
        if (changed === "pro") return delay({ ok: false, error: "pro_required" }, 250);
        if (!changed) return delay({ ok: false, error: "nothing_to_change" }, 200);
        genome.auto_apply = me.prefs.genome_auto_apply;
        return delay({ ok: true, prefs: clone(me.prefs) }, 280);
      }
      if (p === "genome") {
        if (QS.get("genome") === "off") return new Promise(function (res, rej) { setTimeout(function () { rej(new ApiError("not_found")); }, 200); });
        return delay(clone(genome), 400);
      }
      if (p === "genome/apply") {
        if (!demoPro) return delay({ ok: false, error: "pro_required" }, 250);
        var gk = String(body.strategy || "").toUpperCase(), gx = genome.strategies[gk];
        if (!gx) return delay({ ok: false, error: "bad_strategy" }, 200);
        if (gx.generation == null) return delay({ ok: false, error: "genome_not_ready" }, 400);
        gx.applied = true;
        return delay({ ok: true }, 600);
      }
      if (p === "analyze") return delay(analyze(body), 2200 + Math.random() * 1200);
      if (p === "share") return delay(demoEmpty ? { ok: false, error: "no_data" } : { ok: true, sent: false, days: 30, stats: clone(dashboard.stats) }, 400);

      // ?api=off → the new endpoints 404 (backend not deployed yet): placeholders must render.
      if (NEW_PATHS.test(p) && QS.get("api") === "off") return delay({ ok: false, error: "not_found" }, 150);
      if (p === "settings/all") {
        if (opts.method !== "POST") return delay({ ok: true, settings: clone(settingsAll), options: clone(settingsOptions) }, 350);
        var pro = false, bad = false, pending = [];
        ["levels", "smc", "volume", "trading", "risk"].forEach(function (sec) {
          var part = body[sec];
          if (!part || typeof part !== "object") return;
          Object.keys(part).forEach(function (k) {
            if (!(k in settingsAll[sec])) return;                   // whitelist
            if (mockLocked(sec + "." + k)) { pro = true; return; }
            if (/tf|timeframe/.test(k) && String(part[k]).toLowerCase() === "5m") { bad = true; return; }
            pending.push([sec, k, part[k]]);
          });
        });
        if (pro) return delay({ ok: false, error: "pro_required" }, 250);
        if (bad) return delay({ ok: false, error: "bad_request" }, 250);
        pending.forEach(function (x) { settingsAll[x[0]][x[1]] = x[2]; });
        if ("lang" in body) settingsAll.lang = body.lang === "en" ? "en" : "ru";
        me.auto_trade = !!settingsAll.trading.auto_trade; me.exchange = settingsAll.trading.trade_exchange;
        return delay({ ok: true, settings: clone(settingsAll), options: clone(settingsOptions) }, 320);
      }
      if (p === "exchange/keys") {
        var ex = String(body.exchange || "").toLowerCase();
        if (!settingsAll.exchanges[ex]) return delay({ ok: false, error: "bad_request" }, 200);
        var ak = String(body.api_key || ""), as = String(body.api_secret || "");
        if (ak.length < 8 || as.length < 8 || (ex === "okx" && !body.passphrase)) {
          return delay({ ok: false, error: "invalid_keys", message: "Биржа отклонила ключи: проверьте права API и IP-ограничения." }, 900);
        }
        settingsAll.exchanges[ex] = { connected: true, key_hint: ak.slice(0, 4) + "…" + ak.slice(-2) };
        settingsAll.trading.trade_exchange = ex; me.exchange = ex;
        return delay({ ok: true, exchange: ex, balance_usdt: 1532.18 }, 1300);
      }
      if (p === "exchange/keys/remove") {
        var rx = String(body.exchange || "").toLowerCase();
        if (!settingsAll.exchanges[rx]) return delay({ ok: false, error: "bad_request" }, 200);
        settingsAll.exchanges[rx] = { connected: false, key_hint: "" };
        if (settingsAll.trading.trade_exchange === rx) { settingsAll.trading.trade_exchange = ""; me.exchange = ""; }
        return delay({ ok: true }, 400);
      }
      if (p === "positions") return delay({ ok: true, positions: clone(positions), orders_count: positions.length ? 4 : 0 }, 550);
      if (p === "feedback") {
        if (!body.text || String(body.text).trim().length < 5) return delay({ ok: false, error: "bad_request" }, 200);
        return delay({ ok: true, id: 1042 }, 700);
      }
      if (p === "plan") return delay(clone(plan), 350);
      if (p === "stats") return delay(buildFullStats(Math.max(1, Math.min(365, +q.get("days") || 30))), 450);
      if (p === "help") return delay(clone(help), 300);
      if (p === "lang") {
        settingsAll.lang = body.lang === "en" ? "en" : "ru"; me.user.lang = settingsAll.lang;
        return delay({ ok: true, lang: settingsAll.lang }, 250);
      }
      return delay({ ok: false, error: "not_found" }, 100);
    }
    return { handle: handle };
  })();

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
