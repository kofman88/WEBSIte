/* CHM BREAKER — site shell (index / pricing). No build step.
 * One identity: Telegram. The Login Widget payload goes to the backend, which
 * lets the bot verify it and passes the bot's Mini App cookie through, so one
 * click signs you in here (JWT in localStorage, same keys as app.js) and in /app.
 * All API strings are inserted with textContent — never innerHTML. */
(function () {
  "use strict";
  var API = "/api";   // the backend serves these pages itself (public_html), so the API is always same-origin
  var CFG = { botShell: true, loginBot: "", appPath: "/app/", priceUsd: 69, yearlyDiscount: 0.2, payments: { stripe: false, cryptoBep20: false, cryptoTrc20: false } };
  var pending = null;   // action to resume after login

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k) || props[k] == null || props[k] === false) continue;
      if (k === "class") el.className = props[k];
      else if (k === "text") el.textContent = String(props[k]);
      else if (k.slice(0, 2) === "on" && typeof props[k] === "function") el.addEventListener(k.slice(2), props[k]);
      else el.setAttribute(k, props[k] === true ? "" : String(props[k]));
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  // ── session ────────────────────────────────────────────────────────────
  function token() { try { return localStorage.getItem("chm_access") || sessionStorage.getItem("chm_access"); } catch (e) { return null; } }
  function user() { try { return JSON.parse(localStorage.getItem("chm_user") || "null"); } catch (e) { return null; } }
  function setSession(s) {
    try {
      if (s.accessToken) localStorage.setItem("chm_access", s.accessToken);
      if (s.refreshToken) localStorage.setItem("chm_refresh", s.refreshToken);
      if (s.user) localStorage.setItem("chm_user", JSON.stringify(Object.assign({}, s.user, s.telegram ? { tg: s.telegram } : {})));
    } catch (e) { /* private mode */ }
    document.dispatchEvent(new CustomEvent("chm:login"));
    renderUser();
  }
  function clearSession() {
    try { ["chm_access", "chm_refresh", "chm_user"].forEach(function (k) { localStorage.removeItem(k); sessionStorage.removeItem(k); }); } catch (e) {}
    renderUser();
  }

  function api(method, path, body, opts) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    var t = token();
    if (t && !opts.noAuth) headers.Authorization = "Bearer " + t;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" })
      .then(function (res) { return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; }); })
      .catch(function () { return { status: 0, data: null }; });
  }

  // Try to reuse a Mini App cookie session (user signed in inside /app).
  function adoptBotSession() {
    return api("POST", "/auth/oauth/bot-session", {}, { noAuth: true }).then(function (r) {
      if (r.status === 200 && r.data && r.data.accessToken) { setSession(r.data); return true; }
      return false;
    });
  }
  function ensureSession() {
    if (token()) return Promise.resolve(true);
    return adoptBotSession();
  }

  // ── Telegram Login Widget ─────────────────────────────────────────────
  function mountWidget(host) {
    clear(host);
    if (!CFG.loginBot) { host.appendChild(h("div", { class: "tg-fallback", text: "Вход через Telegram не настроен на сервере." })); return; }
    var sc = document.createElement("script");
    sc.async = true;
    sc.src = "https://telegram.org/js/telegram-widget.js?22";
    sc.setAttribute("data-telegram-login", CFG.loginBot);
    sc.setAttribute("data-size", "large");
    sc.setAttribute("data-radius", "14");
    sc.setAttribute("data-userpic", "false");
    sc.setAttribute("data-request-access", "write");
    sc.setAttribute("data-onauth", "CHMTelegramAuth(user)");
    host.appendChild(sc);
  }
  window.CHMTelegramAuth = function (u) {
    if (!u || typeof u !== "object") return;
    toast("Проверяем вход…");
    api("POST", "/auth/oauth/telegram", u, { noAuth: true }).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.accessToken) {
        toast((r.data && r.data.error) || "Telegram не подтвердил вход — попробуйте ещё раз", true);
        return;
      }
      setSession(r.data);
      closeModal();
      toast("Вы вошли как " + displayName(user()));
      var p = pending; pending = null;
      if (typeof p === "function") p();
    });
  };
  function displayName(u) {
    if (!u) return "трейдер";
    var tg = u.tg || {};
    var email = String(u.email || "");
    return tg.firstName || tg.username || u.givenName || u.given_name || u.displayName || u.display_name || u.telegram_username
      || (email && !/@chm\.local$/.test(email) ? email : "") || "трейдер";
  }

  function openLogin(after) {
    pending = after || null;
    var m = $("#login-modal");
    if (!m) return;
    m.classList.add("open");
    mountWidget($("#tg-login-host", m));
  }
  function closeModal() { $$(".modal.open").forEach(function (m) { m.classList.remove("open"); }); }

  function renderUser() {
    var slot = $("#user-slot");
    if (!slot) return;
    clear(slot);
    var u = token() ? user() : null;
    if (u) {
      var name = displayName(u);
      slot.appendChild(h("span", { class: "pill user-chip" }, h("span", { class: "av", text: String(name).trim().charAt(0).toUpperCase() || "?" }), h("b", { text: name }),
        h("button", { class: "copy", type: "button", onclick: function () { clearSession(); toast("Вы вышли"); }, text: "Выйти" })));
    } else {
      slot.appendChild(h("button", { class: "btn sm", type: "button", onclick: function () { openLogin(); } }, icon("tg"), "Войти"));
    }
  }

  // ── checkout ───────────────────────────────────────────────────────────
  function withSession(fn) {
    ensureSession().then(function (ok) { if (ok) fn(); else openLogin(fn); });
  }
  function busy(btn, on) { if (btn) { btn.disabled = !!on; } }
  function stripeCheckout(cycle, btn) {
    withSession(function () {
      busy(btn, true);
      api("POST", "/payments/stripe/checkout", { plan: "pro", billingCycle: cycle || "monthly" }).then(function (r) {
        busy(btn, false);
        if (r.status === 401) { clearSession(); openLogin(function () { stripeCheckout(cycle, btn); }); return; }
        if (r.status === 503 || (r.data && r.data.code === "STRIPE_DISABLED")) { toast("Оплата картой временно недоступна — оплатите USDT или в Telegram", true); return; }
        if (r.status !== 200 || !r.data || !r.data.url) { toast((r.data && r.data.error) || "Не удалось создать оплату", true); return; }
        location.href = r.data.url;
      });
    });
  }
  function cryptoCheckout(network, btn) {
    withSession(function () {
      busy(btn, true);
      api("POST", "/payments/crypto/create", { plan: "pro", network: network }).then(function (r) {
        busy(btn, false);
        if (r.status === 401) { clearSession(); openLogin(function () { cryptoCheckout(network, btn); }); return; }
        if (r.status !== 200 || !r.data || !r.data.address) { toast((r.data && r.data.error) || "USDT-оплата временно недоступна", true); return; }
        showCrypto(r.data);
      });
    });
  }
  function showCrypto(d) {
    var m = $("#crypto-modal"); if (!m) return;
    var box = $(".kv", m); clear(box);
    [["Сеть", d.network === "trc20" ? "USDT · TRC20 (Tron)" : "USDT · BEP20 (BNB Chain)"], ["Сумма", String(d.amountUsdt) + " USDT"], ["Адрес", String(d.address)]].forEach(function (row) {
      box.appendChild(h("span", { class: "muted", text: row[0] }));
      box.appendChild(h("span", { class: "v" }, row[1], " ", h("button", { class: "copy", type: "button", onclick: function () { copyText(row[1].split(" USDT")[0]); } }, "копировать")));
    });
    $(".exp", m).textContent = "Переведите ровно эту сумму в течение часа — копейки в сумме нужны, чтобы бот нашёл ваш платёж. Pro включится автоматически через несколько минут после подтверждения сети.";
    m.classList.add("open");
  }
  function copyText(t) {
    try { navigator.clipboard.writeText(String(t)).then(function () { toast("Скопировано"); }); } catch (e) { toast("Скопируйте вручную", true); }
  }

  // ── public stats ───────────────────────────────────────────────────────
  var STRAT = { LEVELS: "Уровни", SMC: "Smart Money", VOLUME: "Объём + MA" };
  function pct(v) { return v == null ? "—" : (Math.round(Number(v) * 10) / 10).toFixed(1) + "%"; }
  function rr(v) { if (v == null) return "—"; var n = Number(v); return (n > 0 ? "+" : "") + n.toFixed(1) + "R"; }
  function loadStats() {
    var rating = $("#rating"), recent = $("#recent");
    if (!rating && !recent) return;
    api("GET", "/public/bot-stats", null, { noAuth: true }).then(function (r) {
      var d = r.data;
      if (r.status !== 200 || !d || !d.ok) {
        [rating, recent].forEach(function (el) { if (el) { clear(el); el.appendChild(h("p", { class: "muted", text: "Статистика бота сейчас недоступна — откройте приложение, там всё живое." })); } });
        return;
      }
      if (rating) {
        clear(rating);
        var by = (d.rating && d.rating.by_strategy) || {};
        var keys = Object.keys(by);
        if (!keys.length) rating.appendChild(h("p", { class: "muted", text: "За последние 30 дней сигналов ещё не накопилось." }));
        keys.sort(function (a, b) { return (Number(by[b].total_rr) || 0) - (Number(by[a].total_rr) || 0); }).forEach(function (k) {
          var s = by[k] || {};
          rating.appendChild(h("div", { class: "rating-row" },
            h("div", { class: "nm" }, STRAT[k] || k, d.rating.best === k ? h("span", { class: "badge best", text: "ЛУЧШАЯ" }) : null),
            h("div", null, h("div", { class: "v", text: String(s.signals != null ? s.signals : s.trades || 0) }), h("div", { class: "l", text: "сигналов" })),
            h("div", null, h("div", { class: "v", text: pct(s.win_rate) }), h("div", { class: "l", text: "winrate" })),
            h("div", null, h("div", { class: "v " + ((Number(s.total_rr) || 0) >= 0 ? "up" : "dn"), text: rr(s.total_rr) }), h("div", { class: "l", text: "итог" }))));
        });
        var g = $("#stats-generated");
        if (g && d.generated_at) g.textContent = "обновлено " + new Date(d.generated_at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      }
      if (recent) {
        clear(recent);
        var list = Array.isArray(d.recent) ? d.recent.slice(0, 8) : [];
        if (!list.length) recent.appendChild(h("p", { class: "muted", text: "Свежих сигналов за неделю пока нет." }));
        list.forEach(function (s) {
          var st = String(s.status || "").toLowerCase();
          var lbl = { open: "в работе", tp1: "TP1", tp2: "TP2", tp3: "TP3", sl: "SL", be: "БУ", expired: "по времени", skip: "пропуск", missed: "без входа" }[st] || st;
          recent.appendChild(h("div", { class: "sig" },
            h("span", { class: "sym", text: String(s.symbol || "") }),
            h("span", { class: "dir " + (String(s.direction).toUpperCase() === "LONG" ? "long" : "short"), text: String(s.direction || "").toUpperCase() }),
            h("span", { class: "muted", text: (STRAT[s.strategy] || s.strategy || "") + (s.timeframe ? " · " + String(s.timeframe).toUpperCase() : "") }),
            h("span", { class: "st " + (s.rr != null ? (Number(s.rr) >= 0 ? "up" : "dn") : "muted"), text: lbl + (s.rr != null ? " " + rr(s.rr) : "") })));
        });
      }
    });
  }

  // ── misc ───────────────────────────────────────────────────────────────
  var toastT = null;
  function toast(msg, err) {
    var t = $("#toast"); if (!t) return;
    t.textContent = msg; t.className = "toast glass show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, err ? 3600 : 2400);
  }
  var ICONS = {
    tg: '<svg viewBox="0 0 24 24"><path d="M21.5 4.5L3 11.3c-1 .4-1 1 0 1.3l4.6 1.4 1.8 5.5c.2.6.6.7 1.1.3l2.6-2.2 4.9 3.6c.9.5 1.5.2 1.7-.8L22.9 6c.3-1.2-.4-1.8-1.4-1.5z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    bolt: '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    card: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
    coin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9h6M9 15h6M12 7v10"/></svg>'
  };
  function icon(n) { var s = h("span", { class: "ico-w" }); s.innerHTML = ICONS[n] || ""; return s.firstChild || s; }

  function botLink(start) {
    var u = String(CFG.loginBot || "CHM_signalS_bot").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
    return "https://t.me/" + u + (start ? "?start=" + encodeURIComponent(start) : "");
  }
  function applyConfig() {
    $$("[data-bot-link]").forEach(function (a) { a.href = botLink(a.getAttribute("data-bot-link") || ""); });
    $$("[data-app-link]").forEach(function (a) { a.href = CFG.appPath + (a.getAttribute("data-app-link") || ""); });
    $$("[data-price]").forEach(function (el) { el.textContent = "$" + CFG.priceUsd; });
    $$("[data-price-year]").forEach(function (el) { el.textContent = "$" + Math.round(CFG.priceUsd * 12 * (1 - CFG.yearlyDiscount)); });
    $$("[data-pay=stripe]").forEach(function (b) { b.hidden = !CFG.payments.stripe; });
    $$("[data-pay=trc20]").forEach(function (b) { b.hidden = !CFG.payments.cryptoTrc20; });
    $$("[data-pay=bep20]").forEach(function (b) { b.hidden = !CFG.payments.cryptoBep20; });
    var none = !CFG.payments.stripe && !CFG.payments.cryptoTrc20 && !CFG.payments.cryptoBep20;
    $$("[data-pay=none]").forEach(function (b) { b.hidden = !none; });
  }

  function boot() {
    document.body.classList.add("js");
    var cycle = "monthly";
    $$(".cycle button").forEach(function (b) {
      b.addEventListener("click", function () {
        $$(".cycle button").forEach(function (x) { x.classList.toggle("on", x === b); });
        cycle = b.getAttribute("data-cycle") || "monthly";
        $$("[data-price-live]").forEach(function (el) { el.textContent = cycle === "yearly" ? "$" + Math.round(CFG.priceUsd * (1 - CFG.yearlyDiscount)) : "$" + CFG.priceUsd; });
      });
    });
    $$("[data-pay=stripe]").forEach(function (b) { b.addEventListener("click", function () { stripeCheckout(cycle, b); }); });
    $$("[data-pay=trc20]").forEach(function (b) { b.addEventListener("click", function () { cryptoCheckout("trc20", b); }); });
    $$("[data-pay=bep20]").forEach(function (b) { b.addEventListener("click", function () { cryptoCheckout("bep20", b); }); });
    $$("[data-login]").forEach(function (b) { b.addEventListener("click", function () { openLogin(); }); });
    $$(".modal .x, .modal [data-close]").forEach(function (b) { b.addEventListener("click", closeModal); });
    $$(".modal").forEach(function (m) { m.addEventListener("click", function (e) { if (e.target === m) closeModal(); }); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });
    var hostInline = $("#tg-login-inline");
    api("GET", "/public/site-config", null, { noAuth: true }).then(function (r) {
      if (r.status === 200 && r.data) {
        CFG.botShell = !!r.data.botShell; CFG.loginBot = r.data.loginBot || ""; CFG.appPath = r.data.appPath || "/app/";
        if (r.data.priceUsd) CFG.priceUsd = Number(r.data.priceUsd); if (r.data.payments) CFG.payments = r.data.payments;
      }
      applyConfig();
      renderUser();
      if (hostInline && !token()) mountWidget(hostInline);
      if (!token()) adoptBotSession();
      var q = new URLSearchParams(location.search);
      if (q.get("paid") === "1") toast("Оплата получена — Pro активирован в боте и в приложении");
      if (q.get("checkout") === "cancel") toast("Оплата отменена", true);
    });
    loadStats();
  }
  window.CHM = { api: api, openLogin: openLogin, token: token, stripeCheckout: stripeCheckout, cryptoCheckout: cryptoCheckout, botLink: botLink, cfg: CFG };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
