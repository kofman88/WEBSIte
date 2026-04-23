/**
 * CHM Support Widget — floating bubble + slide-up panel.
 *
 * Self-contained: injects its own CSS and markup, no dependencies.
 * Works on every page that includes this script; no need to touch HTML.
 *
 *   <script src="support-widget.js" defer></script>
 *
 * Identity: if window.Auth and Auth.isLoggedIn() returns true, the widget
 * posts to the authenticated /api/support/tickets endpoints and shows the
 * user their past threads. Otherwise it falls back to /api/support/contact
 * (guest endpoint) which only accepts a single message + email.
 */
(function () {
  'use strict';

  if (window.__chmSupportLoaded) return;
  window.__chmSupportLoaded = true;

  var API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3000/api'
    : '/api';

  function loggedIn() {
    try { return typeof Auth !== 'undefined' && Auth.isLoggedIn && Auth.isLoggedIn(); }
    catch (e) { return false; }
  }
  function currentUserEmail() {
    try { return (Auth && Auth.user && Auth.user.email) || ''; } catch (e) { return ''; }
  }
  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    try {
      var tok = Auth && Auth.getAccessToken && Auth.getAccessToken();
      if (tok) h.Authorization = 'Bearer ' + tok;
    } catch (e) {}
    return h;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  }); }
  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    });
  }
  function relTime(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diff = Math.max(0, Date.now() - then);
    if (diff < 60_000) return 'сейчас';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' мин назад';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' ч назад';
    return Math.floor(diff / 86_400_000) + ' дн назад';
  }

  // ── STYLES ──────────────────────────────────────────────────────────
  var css = `
  .chm-sup-btn{
    position:fixed;right:22px;bottom:22px;z-index:9998;
    width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;
    background:linear-gradient(180deg,#FF7840 0%,#FF5A1F 55%,#C44610 100%);
    color:#fff;display:flex;align-items:center;justify-content:center;
    box-shadow:
      inset 0 1px 1px rgba(255,255,255,.3),
      inset 0 -2px 4px rgba(0,0,0,.25),
      0 8px 24px -6px rgba(255,90,31,.5),
      0 4px 12px rgba(0,0,0,.3);
    transition:transform .2s cubic-bezier(.16,1,.3,1),filter .2s;
  }
  .chm-sup-btn:hover{transform:translateY(-2px) scale(1.04);filter:brightness(1.08)}
  .chm-sup-btn:active{transform:translateY(0) scale(.98)}
  .chm-sup-btn svg{width:26px;height:26px}
  .chm-sup-btn .chm-sup-badge{
    position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;
    padding:0 6px;border-radius:10px;background:#fff;color:#FF5A1F;
    font-family:'Inter',sans-serif;font-weight:700;font-size:11px;
    display:none;align-items:center;justify-content:center;
    box-shadow:0 2px 6px rgba(0,0,0,.3);
  }
  .chm-sup-btn .chm-sup-badge.show{display:flex}

  .chm-sup-panel{
    position:fixed;right:22px;bottom:90px;z-index:9998;
    width:380px;height:min(640px,calc(100vh - 120px));
    display:none;flex-direction:column;
    border-radius:20px;overflow:hidden;
    background:rgba(16,20,32,.96);
    border:1px solid rgba(255,255,255,.1);
    box-shadow:0 32px 80px -12px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.05);
    backdrop-filter:blur(24px) saturate(1.4);
    -webkit-backdrop-filter:blur(24px) saturate(1.4);
    opacity:0;transform:translateY(12px) scale(.98);
    transition:opacity .24s cubic-bezier(.16,1,.3,1),transform .24s cubic-bezier(.16,1,.3,1);
    font-family:'Inter',sans-serif;color:#fff;
  }
  .chm-sup-panel.open{display:flex;opacity:1;transform:none}
  @media (max-width:480px){
    .chm-sup-panel{right:10px;left:10px;width:auto;bottom:80px;height:min(70vh,560px)}
    .chm-sup-btn{right:14px;bottom:14px}
  }

  .chm-sup-hdr{
    padding:22px 20px 18px;
    background:linear-gradient(180deg,#FF7840 0%,#FF5A1F 65%,#C44610 100%);
    color:#fff;position:relative;
  }
  .chm-sup-hdr h3{
    font-family:'Inter',sans-serif;font-weight:600;font-size:22px;line-height:1.15;
    letter-spacing:-.02em;margin:0 0 4px;color:#fff
  }
  .chm-sup-hdr p{font-size:13px;opacity:.9;margin:0;line-height:1.4}
  .chm-sup-hdr .chm-sup-close{
    position:absolute;top:14px;right:14px;
    width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;
    background:rgba(255,255,255,.15);color:#fff;
    display:flex;align-items:center;justify-content:center;
    transition:background .2s
  }
  .chm-sup-hdr .chm-sup-close:hover{background:rgba(255,255,255,.25)}
  .chm-sup-hdr .chm-sup-close svg{width:16px;height:16px}

  .chm-sup-body{flex:1;overflow-y:auto;padding:8px 16px}
  .chm-sup-body::-webkit-scrollbar{width:6px}
  .chm-sup-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}

  /* Tabs (bottom nav, 3Commas-style) */
  .chm-sup-tabs{
    display:grid;grid-template-columns:repeat(3,1fr);gap:0;
    border-top:1px solid rgba(255,255,255,.08);
    background:rgba(10,13,22,.4);
  }
  .chm-sup-tab{
    padding:12px 6px;background:transparent;border:0;cursor:pointer;
    display:flex;flex-direction:column;align-items:center;gap:3px;
    color:rgba(255,255,255,.55);font-family:'Inter',sans-serif;
    font-size:11px;font-weight:500;transition:color .15s
  }
  .chm-sup-tab.active{color:#FF5A1F}
  .chm-sup-tab svg{width:20px;height:20px}
  .chm-sup-tab:hover{color:#fff}
  .chm-sup-tab.active:hover{color:#FF8C5A}

  /* Home tab content */
  .chm-sup-home-card{
    margin:10px 0;padding:14px;border-radius:14px;
    background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
    display:flex;align-items:center;gap:12px;cursor:pointer;
    transition:background .18s,border-color .18s;
    text-decoration:none;color:inherit;
  }
  .chm-sup-home-card:hover{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14)}
  .chm-sup-home-card .chm-sup-icn{
    width:36px;height:36px;border-radius:50%;flex-shrink:0;
    background:rgba(255,90,31,.15);color:#FF8C5A;
    display:flex;align-items:center;justify-content:center
  }
  .chm-sup-home-card .chm-sup-icn svg{width:18px;height:18px}
  .chm-sup-home-card .chm-sup-meta{flex:1;min-width:0}
  .chm-sup-home-card .chm-sup-meta .t{font-size:13px;font-weight:600;color:#fff;line-height:1.2;margin-bottom:2px}
  .chm-sup-home-card .chm-sup-meta .s{font-size:11px;color:rgba(255,255,255,.55);line-height:1.3}
  .chm-sup-home-card .chm-sup-chev{color:rgba(255,255,255,.35);flex-shrink:0}

  .chm-sup-status-dot{
    width:8px;height:8px;border-radius:50%;background:#66876E;
    box-shadow:0 0 8px rgba(102,135,110,.6);flex-shrink:0;
    animation:chmSupPulse 2.5s ease-in-out infinite
  }
  @keyframes chmSupPulse{0%,100%{opacity:1}50%{opacity:.55}}

  /* Chat tab */
  .chm-sup-msgs{display:flex;flex-direction:column;gap:10px;padding:12px 4px}
  .chm-sup-msg{
    max-width:82%;padding:10px 14px;border-radius:14px;
    font-size:13px;line-height:1.45;word-wrap:break-word
  }
  .chm-sup-msg.me{
    align-self:flex-end;
    background:linear-gradient(180deg,#FF7840 0%,#FF5A1F 100%);
    color:#fff;border-bottom-right-radius:4px
  }
  .chm-sup-msg.them{
    align-self:flex-start;
    background:rgba(255,255,255,.08);color:#fff;
    border-bottom-left-radius:4px
  }
  .chm-sup-msg .chm-sup-ts{font-size:10px;opacity:.6;margin-top:4px}
  .chm-sup-msg.me .chm-sup-ts{text-align:right}

  .chm-sup-empty{
    padding:40px 20px;text-align:center;color:rgba(255,255,255,.55);font-size:13px
  }

  .chm-sup-compose{
    padding:10px 14px 14px;border-top:1px solid rgba(255,255,255,.08);
    display:flex;flex-direction:column;gap:8px;background:rgba(10,13,22,.5)
  }
  .chm-sup-compose input,
  .chm-sup-compose textarea{
    width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);
    border-radius:10px;padding:10px 12px;color:#fff;font-family:'Inter',sans-serif;
    font-weight:500;font-size:13px;outline:none;resize:none;
    transition:border-color .15s,background .15s
  }
  .chm-sup-compose input:focus,
  .chm-sup-compose textarea:focus{border-color:#FF5A1F;background:rgba(255,255,255,.07)}
  .chm-sup-compose textarea{min-height:60px;max-height:120px}
  .chm-sup-compose-row{display:flex;gap:8px;align-items:flex-end}
  .chm-sup-send{
    flex-shrink:0;width:40px;height:40px;border-radius:50%;border:0;cursor:pointer;
    background:linear-gradient(180deg,#FF7840 0%,#FF5A1F 60%,#C44610 100%);
    color:#fff;display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 1px 1px rgba(255,255,255,.3),inset 0 -1px 2px rgba(0,0,0,.2),0 4px 10px -2px rgba(255,90,31,.45);
    transition:transform .18s,filter .18s
  }
  .chm-sup-send:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.08)}
  .chm-sup-send:disabled{opacity:.45;cursor:not-allowed}
  .chm-sup-send svg{width:18px;height:18px}

  .chm-sup-hint{font-size:11px;color:rgba(255,255,255,.45);line-height:1.4}

  /* AI tab extras — note block above the thread + pulsing "typing" bubble */
  .chm-ai-note{
    padding:10px 14px;margin:8px 0 4px;border-radius:10px;
    background:linear-gradient(135deg,rgba(255,90,31,.14),rgba(255,140,90,.05));
    border:1px solid rgba(255,90,31,.25);
    font-size:11px;color:rgba(255,255,255,.82);line-height:1.5
  }
  .chm-ai-note #chmAiUsage{
    font-family:'JetBrains Mono',monospace;color:#FF8C5A;font-weight:600
  }
  html.light .chm-ai-note{background:linear-gradient(135deg,rgba(255,90,31,.08),rgba(255,140,90,.03));color:#0A0A0A;border-color:rgba(255,90,31,.25)}
  .chm-ai-thread{min-height:180px;max-height:calc(100% - 180px)}
  .chm-sup-msg.chm-ai-typing{opacity:.6;animation:chmAiPulse 1.2s ease-in-out infinite}
  @keyframes chmAiPulse{0%,100%{opacity:.45}50%{opacity:.9}}
  .chm-sup-btn-primary{
    display:inline-block;padding:10px 18px;border-radius:9999px;
    background:linear-gradient(180deg,#FF7840 0%,#FF5A1F 60%,#C44610 100%);
    color:#fff !important;font-weight:600;font-size:13px;
    box-shadow:inset 0 1px 1px rgba(255,255,255,.25),0 4px 12px -2px rgba(255,90,31,.45)
  }
  .chm-sup-btn-primary:hover{filter:brightness(1.08)}

  /* Light theme */
  html.light .chm-sup-panel{background:rgba(255,255,255,.98);color:#0A0A0A;border-color:rgba(0,0,0,.1)}
  html.light .chm-sup-home-card{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.08)}
  html.light .chm-sup-home-card:hover{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.14)}
  html.light .chm-sup-home-card .chm-sup-meta .t{color:#0A0A0A}
  html.light .chm-sup-home-card .chm-sup-meta .s{color:rgba(0,0,0,.55)}
  html.light .chm-sup-tabs{background:rgba(0,0,0,.03);border-top-color:rgba(0,0,0,.08)}
  html.light .chm-sup-tab{color:rgba(0,0,0,.5)}
  html.light .chm-sup-tab:hover{color:#0A0A0A}
  html.light .chm-sup-msg.them{background:rgba(0,0,0,.06);color:#0A0A0A}
  html.light .chm-sup-compose{background:rgba(0,0,0,.02);border-top-color:rgba(0,0,0,.08)}
  html.light .chm-sup-compose input,
  html.light .chm-sup-compose textarea{background:rgba(0,0,0,.04);border-color:rgba(0,0,0,.12);color:#0A0A0A}
  html.light .chm-sup-compose input:focus,
  html.light .chm-sup-compose textarea:focus{background:rgba(0,0,0,.06);border-color:#FF5A1F}
  html.light .chm-sup-empty{color:rgba(0,0,0,.5)}
  html.light .chm-sup-hint{color:rgba(0,0,0,.5)}
  `;

  // ── MARKUP ──────────────────────────────────────────────────────────
  var SVG = {
    chat:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
    home:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>',
    help:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>',
    chev:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    status: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
    community:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    ai:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/><path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z"/></svg>',
  };

  var root = document.createElement('div');
  root.innerHTML =
    '<style>' + css + '</style>' +
    '<button class="chm-sup-btn" id="chmSupBtn" aria-label="Поддержка">' +
      SVG.chat +
      '<span class="chm-sup-badge" id="chmSupBadge">0</span>' +
    '</button>' +
    '<div class="chm-sup-panel" id="chmSupPanel" role="dialog" aria-label="Поддержка CHM Finance">' +
      '<div class="chm-sup-hdr">' +
        '<h3>Привет 👋</h3>' +
        '<p>Обычно отвечаем в течение 2–4 часов</p>' +
        '<button class="chm-sup-close" id="chmSupClose" aria-label="Закрыть">' + SVG.close + '</button>' +
      '</div>' +
      '<div class="chm-sup-body" id="chmSupBody"></div>' +
      '<div class="chm-sup-tabs">' +
        '<button class="chm-sup-tab active" data-tab="home">' + SVG.home + '<span>Главная</span></button>' +
        '<button class="chm-sup-tab" data-tab="chat">' + SVG.chat + '<span>Чат</span></button>' +
        '<button class="chm-sup-tab" data-tab="ai">'   + SVG.ai   + '<span>AI</span></button>' +
        '<button class="chm-sup-tab" data-tab="help">' + SVG.help + '<span>Помощь</span></button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  var btn = document.getElementById('chmSupBtn');
  var panel = document.getElementById('chmSupPanel');
  var closeBtn = document.getElementById('chmSupClose');
  var body = document.getElementById('chmSupBody');
  var tabs = root.querySelectorAll('.chm-sup-tab');

  btn.addEventListener('click', function () { panel.classList.add('open'); renderTab(currentTab); });
  closeBtn.addEventListener('click', function () { panel.classList.remove('open'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') panel.classList.remove('open'); });

  var currentTab = 'home';

  // Public helper — lets any code (sidebar AI entry, URL handler, etc.) open
  // the widget directly on a specific tab. MUST be registered at init time,
  // not inside a per-tab render fn, otherwise external callers see it as
  // undefined until the tab has been visited at least once.
  window.ChmSupport = {
    open: function (tab) {
      panel.classList.add('open');
      var t = tab || 'home';
      tabs.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-tab') === t); });
      currentTab = t;
      renderTab(t);
    },
    close: function () { panel.classList.remove('open'); },
  };

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      currentTab = t.getAttribute('data-tab');
      renderTab(currentTab);
    });
  });

  function renderTab(tab) {
    if (tab === 'home')     renderHome();
    else if (tab === 'chat') renderChat();
    else if (tab === 'ai')   renderAI();
    else if (tab === 'help') renderHelp();
  }

  function renderHome() {
    body.innerHTML =
      '<div style="padding:4px 0">' +
        '<a class="chm-sup-home-card" id="chmSupGoChat">' +
          '<span class="chm-sup-icn">' + SVG.chat + '</span>' +
          '<span class="chm-sup-meta"><span class="t">Отправить сообщение</span>' +
            '<span class="s">Наша команда ответит в ближайшее время</span></span>' +
          '<span class="chm-sup-chev">' + SVG.chev + '</span>' +
        '</a>' +
        '<div class="chm-sup-home-card" style="cursor:default">' +
          '<span class="chm-sup-icn" style="background:rgba(102,135,110,.15);color:#8FBF95">' +
            '<span class="chm-sup-status-dot" style="margin:auto"></span></span>' +
          '<span class="chm-sup-meta"><span class="t">Статус: все системы работают</span>' +
            '<span class="s">Обновлено ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + '</span></span>' +
        '</div>' +
        '<a class="chm-sup-home-card" href="academy/" target="_blank">' +
          '<span class="chm-sup-icn">' + SVG.community + '</span>' +
          '<span class="chm-sup-meta"><span class="t">Академия CHM</span>' +
            '<span class="s">База знаний, гайды по стратегиям</span></span>' +
          '<span class="chm-sup-chev">' + SVG.chev + '</span>' +
        '</a>' +
        '<a class="chm-sup-home-card" href="https://t.me/chmup_support" target="_blank" rel="noopener">' +
          '<span class="chm-sup-icn">' +
            '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.3 2.7 2.4 10.8c-1.4.6-1.4 1.4-.2 1.8l5.3 1.7 2.1 6.3c.3.7.1 1 .9 1 .6 0 .9-.3 1.2-.6l2.6-2.5 5.3 4c1 .5 1.7.2 2-.9L22.9 4c.3-1.5-.5-2-1.6-1.3zM8.3 15.2 17 9.6c.4-.3.8-.1.5.2l-7 6.3-.3 3.6-1.9-4.5z"/></svg>' +
          '</span>' +
          '<span class="chm-sup-meta"><span class="t">Telegram-сообщество</span>' +
            '<span class="s">Общение с трейдерами в реальном времени</span></span>' +
          '<span class="chm-sup-chev">' + SVG.chev + '</span>' +
        '</a>' +
      '</div>';
    var go = document.getElementById('chmSupGoChat');
    if (go) go.addEventListener('click', function () {
      tabs.forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-tab') === 'chat'); });
      currentTab = 'chat'; renderChat();
    });
  }

  // ── CHAT TAB ────────────────────────────────────────────────────────
  var activeTicketId = null;

  function renderChat() {
    body.innerHTML = '<div class="chm-sup-empty">Загрузка…</div>';
    if (loggedIn()) {
      fetchJson(API_BASE + '/support/tickets?limit=5&status=open', { headers: authHeaders() })
        .then(function (r) {
          var list = (r.ok && r.body && r.body.tickets) ? r.body.tickets : [];
          if (list.length === 0) {
            renderNewMessageForm();
          } else {
            activeTicketId = list[0].id;
            return loadThread(activeTicketId);
          }
        })
        .catch(function () { renderNewMessageForm(); });
    } else {
      renderGuestContactForm();
    }
  }

  function loadThread(ticketId) {
    return fetchJson(API_BASE + '/support/tickets/' + ticketId, { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) return renderNewMessageForm();
        var t = r.body;
        var msgs = (t.messages || []);
        // Open-ticket body becomes the first user message
        var firstMsg = '<div class="chm-sup-msg me">' + esc(t.body) +
          '<div class="chm-sup-ts">' + relTime(t.created_at || t.createdAt) + '</div></div>';
        var rest = msgs.map(function (m) {
          var mine = !m.is_admin && !m.isAdmin;
          return '<div class="chm-sup-msg ' + (mine ? 'me' : 'them') + '">' +
            esc(m.body) +
            '<div class="chm-sup-ts">' + relTime(m.created_at || m.createdAt) + '</div></div>';
        }).join('');
        body.innerHTML =
          '<div class="chm-sup-msgs">' +
            '<div class="chm-sup-empty" style="padding:8px 0;font-size:11px">Тикет #' + t.id +
              ' · ' + (t.subject ? esc(t.subject) : 'Без темы') + '</div>' +
            firstMsg + rest +
          '</div>' +
          '<div class="chm-sup-compose">' +
            '<div class="chm-sup-compose-row">' +
              '<textarea id="chmSupInput" placeholder="Ответить…" rows="2"></textarea>' +
              '<button class="chm-sup-send" id="chmSupSend" aria-label="Отправить">' + SVG.send + '</button>' +
            '</div>' +
          '</div>';
        wireSend(function (txt) {
          return fetchJson(API_BASE + '/support/tickets/' + ticketId + '/reply', {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ body: txt }),
          });
        });
      });
  }

  function renderNewMessageForm() {
    body.innerHTML =
      '<div class="chm-sup-empty">Опишите вопрос — мы ответим в этом окне</div>' +
      '<div class="chm-sup-compose">' +
        '<div class="chm-sup-compose-row">' +
          '<textarea id="chmSupInput" placeholder="Ваше сообщение…" rows="3"></textarea>' +
          '<button class="chm-sup-send" id="chmSupSend" aria-label="Отправить">' + SVG.send + '</button>' +
        '</div>' +
        '<div class="chm-sup-hint">Первое сообщение создаст тикет. Ответы придут сюда и на email.</div>' +
      '</div>';
    wireSend(function (txt) {
      return fetchJson(API_BASE + '/support/tickets', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ subject: txt.slice(0, 60), body: txt }),
      }).then(function (r) {
        if (r.ok && r.body && r.body.id) activeTicketId = r.body.id;
        return r;
      });
    }, { reloadThreadAfter: true });
  }

  function renderGuestContactForm() {
    body.innerHTML =
      '<div class="chm-sup-empty">Залогиньтесь, чтобы получить ответ в этом окне,<br/>или оставьте email — ответим туда</div>' +
      '<div class="chm-sup-compose">' +
        '<input type="email" id="chmSupGuestEmail" placeholder="your@email.com" autocomplete="email"/>' +
        '<div class="chm-sup-compose-row">' +
          '<textarea id="chmSupInput" placeholder="Ваше сообщение…" rows="3"></textarea>' +
          '<button class="chm-sup-send" id="chmSupSend" aria-label="Отправить">' + SVG.send + '</button>' +
        '</div>' +
        '<div class="chm-sup-hint">Мы не пришлём спам. Ответ на email в течение 4–24 часов.</div>' +
      '</div>';
    var input = document.getElementById('chmSupInput');
    var email = document.getElementById('chmSupGuestEmail');
    var sendBtn = document.getElementById('chmSupSend');
    function validate() {
      var okE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email.value || '').trim());
      var okM = (input.value || '').trim().length >= 5;
      sendBtn.disabled = !(okE && okM);
    }
    validate();
    email.addEventListener('input', validate);
    input.addEventListener('input', validate);
    sendBtn.addEventListener('click', function () {
      var e = (email.value || '').trim();
      var m = (input.value || '').trim();
      sendBtn.disabled = true;
      fetchJson(API_BASE + '/support/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: e, body: m }),
      }).then(function (r) {
        if (r.ok) {
          body.innerHTML = '<div class="chm-sup-empty" style="padding:60px 20px">Получили! Ответ придёт на <b>' + esc(e) + '</b>.</div>';
        } else {
          sendBtn.disabled = false;
          alert((r.body && r.body.error) || 'Не удалось отправить. Попробуйте позже.');
        }
      }).catch(function () {
        sendBtn.disabled = false;
        alert('Сеть недоступна. Попробуйте позже.');
      });
    });
  }

  function wireSend(submitFn, opts) {
    opts = opts || {};
    var input = document.getElementById('chmSupInput');
    var sendBtn = document.getElementById('chmSupSend');
    function validate() { sendBtn.disabled = (input.value || '').trim().length < 2; }
    validate();
    input.addEventListener('input', validate);
    input.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !sendBtn.disabled) sendBtn.click();
    });
    sendBtn.addEventListener('click', function () {
      var txt = (input.value || '').trim();
      if (txt.length < 2) return;
      sendBtn.disabled = true;
      submitFn(txt).then(function (r) {
        if (r && r.ok) {
          input.value = '';
          if (opts.reloadThreadAfter && activeTicketId) loadThread(activeTicketId);
          else if (activeTicketId) loadThread(activeTicketId);
          else renderChat();
        } else {
          sendBtn.disabled = false;
          alert((r && r.body && r.body.error) || 'Не отправилось. Попробуйте ещё раз.');
        }
      }).catch(function () {
        sendBtn.disabled = false;
        alert('Сеть недоступна.');
      });
    });
  }

  // ── HELP TAB (FAQ search placeholder) ───────────────────────────────
  var FAQ = [
    { q: 'Как создать первого бота?',   a: 'Перейдите во вкладку «Боты» → «Создать бот». Выберите биржу, стратегию и пару. Paper-режим по умолчанию — можно попробовать без риска.' },
    { q: 'Что такое Market Scanner?',    a: 'Elite-фича: сканирует все USDT-пары на всех выбранных биржах по вашим стратегиям. Автоторговля по любому сильному сигналу.' },
    { q: 'Как подключить биржу?',         a: 'Кошелёк → Добавить ключ. Нужны права на торговлю (НЕ withdraw). Ключ шифруется и хранится только на нашем сервере.' },
    { q: 'Как работает реферальная программа?', a: '20% от всех платежей приглашённого юзера на весь срок его подписки. Ссылка в Настройках → Рефералка.' },
    { q: 'Почему я не получаю сигналы?',  a: 'Проверьте: (1) бот активен, (2) стратегия подходит под ваш план, (3) таймфрейм достаточно короткий, (4) в настройках сигналов не завышен min-confidence.' },
  ];

  function renderHelp() {
    var items = FAQ.map(function (f, i) {
      return '<div class="chm-sup-home-card" data-faq="' + i + '" style="cursor:pointer">' +
        '<span class="chm-sup-icn">' + SVG.help + '</span>' +
        '<span class="chm-sup-meta"><span class="t">' + esc(f.q) + '</span>' +
          '<span class="s" id="chmFaqA' + i + '" style="display:none">' + esc(f.a) + '</span></span>' +
        '<span class="chm-sup-chev">' + SVG.chev + '</span>' +
      '</div>';
    }).join('');
    body.innerHTML = '<div style="padding:4px 0">' + items + '</div>';
    body.querySelectorAll('[data-faq]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = el.getAttribute('data-faq');
        var ans = document.getElementById('chmFaqA' + i);
        if (ans) ans.style.display = (ans.style.display === 'none') ? 'block' : 'none';
      });
    });
  }

  // ── AI chat tab (Gemini-backed, free tier). Guest users see a prompt
  // to log in — Gemini traffic requires an authed user so we can
  // rate-limit per plan.
  var _aiHistory = [];   // [{role:'user'|'assistant', content}]
  function renderAI() {
    if (!isLoggedIn()) {
      body.innerHTML =
        '<div class="chm-sup-home-card" style="flex-direction:column;align-items:flex-start;gap:10px">' +
          '<span class="chm-sup-icn">' + SVG.ai + '</span>' +
          '<div><strong style="display:block;margin-bottom:4px;color:#fff">AI-ассистент</strong>' +
            '<span style="font-size:12px;color:rgba(255,255,255,.6)">Доступен залогиненным пользователям. Задавай вопросы про стратегии, термины, интерфейс — отвечает Gemini 2.0 Flash.</span></div>' +
          '<a class="chm-sup-btn-primary" href="index.html?login=1" style="text-decoration:none;text-align:center">Войти →</a>' +
        '</div>';
      return;
    }
    body.innerHTML =
      '<div class="chm-ai-note">' +
        'AI ассистент (beta) · Gemini · <span id="chmAiUsage">— / —</span>' +
        '<br><span style="opacity:.65">Стратегии, термины, интерфейс — на русском. Не даёт financial advice. Не пересылай приватные данные в beta.</span>' +
      '</div>' +
      '<div class="chm-sup-msgs chm-ai-thread" id="chmAiThread"></div>' +
      '<div class="chm-sup-compose">' +
        '<div class="chm-sup-compose-row">' +
          '<textarea id="chmAiText" placeholder="Что такое trailing stop?"></textarea>' +
          '<button id="chmAiSend" class="chm-sup-send" aria-label="Отправить">' + SVG.send + '</button>' +
        '</div>' +
        '<div class="chm-sup-hint">⌘/Ctrl + Enter — отправить · ответ 2–5 сек</div>' +
      '</div>';
    var thread = document.getElementById('chmAiThread');
    var textarea = document.getElementById('chmAiText');
    var sendBtn = document.getElementById('chmAiSend');
    var usageEl = document.getElementById('chmAiUsage');

    // Render any existing in-memory history (persists within the session)
    _aiHistory.forEach(function (m) { appendMsg(m.role, m.content); });
    if (!_aiHistory.length) appendMsg('assistant',
      'Привет! Я помогу разобраться с CHM Finance — стратегиями, сигналами, настройкой ботов. Что интересует?');

    // Fetch usage once to show X / Y
    fetch(API_BASE + '/ai/usage', { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (!d.enabled) {
          usageEl.textContent = 'ключ не настроен';
          sendBtn.disabled = true;
          textarea.disabled = true;
          textarea.placeholder = 'AI-ассистент не подключён. Свяжись с админом.';
        } else {
          usageEl.textContent = d.requestsToday + ' / ' + d.requestsLimit;
        }
      })
      .catch(function () { usageEl.textContent = ''; });

    function appendMsg(role, text) {
      var el = document.createElement('div');
      // Reuse existing .chm-sup-msg styles (me = orange bubble right,
      // default = grey bubble left), just flip the semantics for AI:
      // "me" = the user's message, "them" (no class) = AI reply.
      el.className = 'chm-sup-msg' + (role === 'user' ? ' me' : '');
      el.textContent = text;
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return el;
    }

    function send() {
      var msg = (textarea.value || '').trim();
      if (msg.length < 2) return;
      textarea.value = '';
      sendBtn.disabled = true;
      appendMsg('user', msg);
      _aiHistory.push({ role: 'user', content: msg });
      var typingEl = appendMsg('assistant', '…');
      typingEl.classList.add('chm-ai-typing');

      fetch(API_BASE + '/ai/chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ message: msg, history: _aiHistory.slice(-10) }),
      }).then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data && data.error || 'HTTP ' + r.status);
          return data;
        });
      }).then(function (data) {
        typingEl.classList.remove('chm-ai-typing');
        typingEl.textContent = data.reply || '—';
        _aiHistory.push({ role: 'assistant', content: data.reply });
        if (data.usage) usageEl.textContent = data.usage.requestsToday + ' / ' + data.usage.requestsLimit;
      }).catch(function (err) {
        typingEl.classList.remove('chm-ai-typing');
        typingEl.textContent = '⚠ ' + (err.message || 'Ошибка AI');
        typingEl.style.color = '#C8A0A0';
      }).finally(function () {
        sendBtn.disabled = false;
        textarea.focus();
      });
    }

    sendBtn.addEventListener('click', send);
    textarea.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
    });
    textarea.focus();
  }

})();
