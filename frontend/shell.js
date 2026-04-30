/* Dashboard shell — shared across dashboard/bots/signals/analytics/backtests/
 * wallet/leaderboard/settings. Handles:
 *   1. Clickable CHM logo → /
 *   2. Plan badge auto-pulled from /api/auth/me
 *   3. Topbar theme + language toggles (persisted in localStorage)
 *   4. I18n translation of all data-t keys on the page
 *   5. User initials in topbar avatar, real email
 *
 * Loaded after app.js on every authed page.
 */

(function shellBoot() {
  // ── Translation dictionary (RU/EN/ES/TR/ID) ─────────────────────────────
  const TR = {
    // Sidebar
    'sb-dashboard':  { ru: 'Дашборд',     en: 'Dashboard',   es: 'Panel',        tr: 'Panel',          id: 'Dasbor' },
    'sb-bots':       { ru: 'Боты',        en: 'Bots',        es: 'Bots',         tr: 'Botlar',         id: 'Bot' },
    'sb-signals':    { ru: 'Сигналы',     en: 'Signals',     es: 'Señales',      tr: 'Sinyaller',      id: 'Sinyal' },
    'sb-analytics':  { ru: 'Аналитика',   en: 'Analytics',   es: 'Análisis',     tr: 'Analitik',       id: 'Analitik' },
    'sb-backtests':  { ru: 'Бэктесты',    en: 'Backtests',   es: 'Backtests',    tr: 'Geri testler',   id: 'Backtest' },
    'sb-wallet':     { ru: 'Кошелёк',     en: 'Wallet',      es: 'Billetera',    tr: 'Cüzdan',         id: 'Dompet' },
    'sb-leaderboard':{ ru: 'Leaderboard', en: 'Leaderboard', es: 'Tabla',        tr: 'Sıralama',       id: 'Peringkat' },
    'sb-settings':   { ru: 'Настройки',   en: 'Settings',    es: 'Ajustes',      tr: 'Ayarlar',        id: 'Pengaturan' },
    'sb-logout':     { ru: 'Выйти',       en: 'Sign out',    es: 'Salir',        tr: 'Çıkış',          id: 'Keluar' },

    // Dashboard
    'd-title':       { ru: 'Дашборд',                    en: 'Dashboard',             es: 'Panel de control',      tr: 'Gösterge paneli',        id: 'Dasbor' },
    'd-total-pnl':   { ru: 'Total PnL',                  en: 'Total PnL',             es: 'PnL total',             tr: 'Toplam PnL',             id: 'Total PnL' },
    'd-active-bots': { ru: 'Активные боты',              en: 'Active bots',           es: 'Bots activos',          tr: 'Aktif botlar',           id: 'Bot aktif' },
    'd-signals-total':{ru: 'Сигналов всего',             en: 'Signals total',         es: 'Señales totales',       tr: 'Toplam sinyal',          id: 'Total sinyal' },
    'd-win-rate':    { ru: 'Win Rate',                   en: 'Win rate',              es: 'Ratio ganador',         tr: 'Kazanma oranı',          id: 'Win rate' },
    'd-equity':      { ru: 'Кривая капитала',            en: 'Equity curve',          es: 'Curva de capital',      tr: 'Sermaye eğrisi',         id: 'Kurva ekuitas' },
    'd-latest-signals':{ru: 'Последние сигналы',         en: 'Latest signals',        es: 'Últimas señales',       tr: 'Son sinyaller',          id: 'Sinyal terbaru' },
    'd-latest-trades':{ru: 'Последние сделки',           en: 'Recent trades',         es: 'Últimas operaciones',   tr: 'Son işlemler',           id: 'Transaksi terbaru' },
    'd-all':         { ru: 'Все',                        en: 'All',                   es: 'Todo',                  tr: 'Tümü',                   id: 'Semua' },
    'd-no-trades':   { ru: 'Сделок пока нет — создай бота, чтобы начать', en: 'No trades yet — create a bot to begin', es: 'Sin operaciones — crea un bot', tr: 'Henüz işlem yok — bot oluştur', id: 'Belum ada transaksi — buat bot' },
    'd-loading':     { ru: 'Загрузка…',                  en: 'Loading…',              es: 'Cargando…',             tr: 'Yükleniyor…',            id: 'Memuat…' },

    // Common table headers
    't-date':  { ru: 'Дата',       en: 'Date',      es: 'Fecha',     tr: 'Tarih',    id: 'Tanggal' },
    't-pair':  { ru: 'Пара',       en: 'Pair',      es: 'Par',       tr: 'Çift',     id: 'Pasangan' },
    't-side':  { ru: 'Направление',en: 'Direction', es: 'Dirección', tr: 'Yön',      id: 'Arah' },
    't-entry': { ru: 'Вход',       en: 'Entry',     es: 'Entrada',   tr: 'Giriş',    id: 'Masuk' },
    't-exit':  { ru: 'Выход',      en: 'Exit',      es: 'Salida',    tr: 'Çıkış',    id: 'Keluar' },
    't-pnl':   { ru: 'PnL',        en: 'PnL',       es: 'PnL',       tr: 'PnL',      id: 'PnL' },
    't-rr':    { ru: 'R:R',        en: 'R:R',       es: 'R:R',       tr: 'R:R',      id: 'R:R' },

    // Topbar
    'tb-search':   { ru: 'Поиск…',  en: 'Search…',   es: 'Buscar…',   tr: 'Ara…',      id: 'Cari…' },
    'tb-theme':    { ru: 'Тема',    en: 'Theme',     es: 'Tema',      tr: 'Tema',      id: 'Tema' },
    'tb-lang':     { ru: 'Язык',    en: 'Language',  es: 'Idioma',    tr: 'Dil',       id: 'Bahasa' },
  };

  const LANGS = ['ru', 'en', 'es', 'tr', 'id'];
  const LANG_LABEL = { ru: 'RU', en: 'EN', es: 'ES', tr: 'TR', id: 'ID' };

  function getLang() { try { return localStorage.getItem('chm_lang') || 'ru'; } catch { return 'ru'; } }
  function setLang(v) { try { localStorage.setItem('chm_lang', v); } catch (_e) {} }
  function getTheme() { try { return localStorage.getItem('chm_theme') || 'dark'; } catch { return 'dark'; } }
  function setTheme(v) { try { localStorage.setItem('chm_theme', v); } catch (_e) {} }
  function tr(key) {
    const e = TR[key]; if (!e) return '';
    return e[getLang()] !== undefined ? e[getLang()] : (e.en || e.ru || '');
  }
  function applyLang() {
    document.documentElement.lang = getLang();
    document.querySelectorAll('[data-t]').forEach((el) => {
      const k = el.getAttribute('data-t');
      const v = tr(k);
      if (v) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = v;
        else el.textContent = v;
      }
    });
    const lb = document.getElementById('shellLang');
    if (lb) lb.textContent = LANG_LABEL[_nextLang(getLang())];
  }
  function _nextLang(cur) { const i = LANGS.indexOf(cur); return LANGS[(i + 1) % LANGS.length]; }

  function applyTheme() {
    const t = getTheme();
    document.documentElement.classList.toggle('light', t === 'light');
    const tb = document.getElementById('shellTheme');
    if (tb) tb.innerHTML = t === 'light' ? _sunIcon() : _moonIcon();
  }
  function _moonIcon() { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>'; }
  function _sunIcon()  { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'; }

  // ── 1. Clickable logo ──────────────────────────────────────────────────
  function wireLogo() {
    const logo = document.querySelector('.sidebar-logo');
    if (!logo || logo.tagName === 'A') return;
    const a = document.createElement('a');
    a.href = '/';
    a.className = logo.className;
    a.style.cssText = (logo.getAttribute('style') || '') + ';text-decoration:none;display:block;cursor:pointer';
    a.innerHTML = logo.innerHTML;
    a.title = 'На главную';
    logo.replaceWith(a);
  }

  // ── 2. Plan badge from /auth/me ────────────────────────────────────────
  const PLAN_LABEL = {
    free:    { label: 'Free',    class: 'plan-free' },
    starter: { label: 'Starter', class: 'plan-starter' },
    pro:     { label: 'Pro',     class: 'plan-pro' },
    elite:   { label: 'Elite',   class: 'plan-elite' },
  };
  // Runs injectors that should appear on EVERY authed page (sidebar items,
  // promo card, footer extras, topbar pills). Separated from wirePlanBadge
  // so pages without a .sidebar-sub-badge anchor still get the chrome.
  // `plan` defaults to 'free' when user lookup fails or feature-gating
  // isn't needed; `user` is passed through to injectAccountPill so it can
  // display the real paperStartingBalance if available.
  function applyChrome(plan, user) {
    plan = plan || 'free';
    injectAIAssistantLink();
    injectTerminalLink();
    injectCopyLink();
    injectSubscriptionsLink();
    if (plan === 'elite') injectMarketScannerLink();
    injectSidebarPromo(plan);
    injectSidebarFooterExtras();
    injectTopbarQuickActions(plan);
    injectAccountPill(user);
    injectPlanPill(plan);
    injectAvatarMenu(user);
  }

  // ── Avatar dropdown menu ─────────────────────────────────────────────
  // Consolidates lang / theme / notifications / settings / logout into
  // one click-target — the avatar circle. Reduces the right-side rail
  // from a 4-chip strip to a single chip + popup, matching how 3Commas /
  // Bybit handle their account dropdowns.
  function injectAvatarMenu(user) {
    const avatar = document.querySelector('.topbar-avatar');
    if (!avatar || avatar.dataset.menuWired === '1') return;
    avatar.dataset.menuWired = '1';
    avatar.style.cursor = 'pointer';
    avatar.setAttribute('role', 'button');
    avatar.setAttribute('aria-haspopup', 'menu');
    avatar.setAttribute('aria-expanded', 'false');
    avatar.setAttribute('tabindex', '0');
    document.body.classList.add('shell-avatar-menu');

    const email = (user && user.email) || '';
    const name = email.split('@')[0] || 'User';

    const menu = document.createElement('div');
    menu.className = 'avatar-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-hidden', 'true');
    menu.innerHTML =
      '<div class="avatar-menu-head">'
      +   '<div class="avatar-menu-avatar">' + (name[0] || 'U').toUpperCase() + '</div>'
      +   '<div class="avatar-menu-id">'
      +     '<div class="avatar-menu-name">' + escapeHtml(name) + '</div>'
      +     '<div class="avatar-menu-email">' + escapeHtml(email) + '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="avatar-menu-row" data-action="lang">'
      +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>'
      +   '<span class="avatar-menu-label">' + (getLang() === 'ru' ? 'Язык' : 'Language') + '</span>'
      +   '<span class="avatar-menu-value" id="avMenuLang">' + (LANG_LABEL[getLang()] || 'RU') + '</span>'
      + '</div>'
      + '<div class="avatar-menu-row" data-action="theme">'
      +   '<svg id="avMenuThemeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (getTheme() === 'light' ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' : '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>') + '</svg>'
      +   '<span class="avatar-menu-label">' + (getLang() === 'ru' ? 'Тема' : 'Theme') + '</span>'
      +   '<span class="avatar-menu-value" id="avMenuTheme">' + (getTheme() === 'light' ? '☀️' : '🌙') + '</span>'
      + '</div>'
      + '<a class="avatar-menu-row" href="settings.html" data-action="notifications">'
      +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>'
      +   '<span class="avatar-menu-label">' + (getLang() === 'ru' ? 'Уведомления' : 'Notifications') + '</span>'
      +   '<span class="avatar-menu-badge" id="avMenuNotifyBadge"></span>'
      + '</a>'
      + '<a class="avatar-menu-row" href="settings.html">'
      +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>'
      +   '<span class="avatar-menu-label">' + (getLang() === 'ru' ? 'Настройки' : 'Settings') + '</span>'
      + '</a>'
      + '<div class="avatar-menu-divider"></div>'
      + '<button type="button" class="avatar-menu-row avatar-menu-logout" data-action="logout">'
      +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
      +   '<span class="avatar-menu-label">' + (getLang() === 'ru' ? 'Выйти' : 'Sign out') + '</span>'
      + '</button>';
    document.body.appendChild(menu);

    let open = false;
    function position() {
      const r = avatar.getBoundingClientRect();
      const mr = menu.getBoundingClientRect();
      menu.style.top = (r.bottom + window.scrollY + 8) + 'px';
      menu.style.left = Math.max(8, r.right + window.scrollX - mr.width) + 'px';
    }
    function show() {
      open = true;
      menu.classList.add('show');
      menu.setAttribute('aria-hidden', 'false');
      avatar.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(position);
    }
    function hide() {
      open = false;
      menu.classList.remove('show');
      menu.setAttribute('aria-hidden', 'true');
      avatar.setAttribute('aria-expanded', 'false');
    }
    function toggle() { open ? hide() : show(); }

    avatar.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
    avatar.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    document.addEventListener('click', (e) => { if (open && !menu.contains(e.target) && e.target !== avatar) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) hide(); });
    window.addEventListener('resize', () => { if (open) position(); });
    window.addEventListener('scroll', () => { if (open) hide(); }, { passive: true });

    // Action handlers
    menu.addEventListener('click', (e) => {
      const row = e.target.closest('[data-action]');
      if (!row) return;
      const a = row.getAttribute('data-action');
      if (a === 'lang') {
        e.preventDefault();
        setLang(_nextLang(getLang()));
        applyLang();
        const lv = document.getElementById('avMenuLang');
        if (lv) lv.textContent = LANG_LABEL[getLang()] || 'RU';
      } else if (a === 'theme') {
        e.preventDefault();
        setTheme(getTheme() === 'light' ? 'dark' : 'light');
        applyTheme();
        const tv = document.getElementById('avMenuTheme');
        if (tv) tv.textContent = getTheme() === 'light' ? '☀️' : '🌙';
        const ti = document.getElementById('avMenuThemeIcon');
        if (ti) ti.innerHTML = getTheme() === 'light' ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' : '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>';
      } else if (a === 'logout') {
        e.preventDefault();
        try { window.Auth && Auth.logout(); } catch (_) { location.href = '/'; }
      }
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }

  // Updates the plan-dependent pieces: the sidebar sub-badge text (if the
  // page has one, e.g. dashboard) and the avatar/username in topbar. Runs
  // the shared injectors via applyChrome either way.
  async function wirePlanBadge() {
    const badge = document.querySelector('.sidebar-sub-badge');
    let text = null;
    if (badge) {
      const svg = badge.querySelector('svg');
      badge.innerHTML = '';
      if (svg) badge.appendChild(svg);
      text = document.createElement('span');
      text.textContent = '…';
      text.style.marginLeft = '8px';
      badge.appendChild(text);
    }

    let plan = 'free';
    let user = null;
    try {
      const r = await (window.API && API.me ? API.me() : null);
      const u = r && (r.user || r);
      user = u;
      plan = (u && u.subscription && u.subscription.plan) || 'free';
      if (badge && text) {
        const meta = PLAN_LABEL[plan] || PLAN_LABEL.free;
        text.textContent = meta.label + ' Plan';
        badge.classList.add(meta.class);
      }
      if (u) {
        const av = document.querySelector('.topbar-avatar');
        if (av && u.email) av.textContent = u.email[0].toUpperCase();
        const un = document.querySelector('.topbar-username');
        if (un && u.email) un.textContent = u.email.split('@')[0];
      }
    } catch (_e) {
      if (text) text.textContent = 'Free Plan';
    }
    // Refine plan-dependent items. Chrome was already injected synchronously
    // in boot() with 'free' defaults; here we add Elite-only pieces and
    // strip items that shouldn't be there on Elite.
    if (plan === 'elite') {
      injectMarketScannerLink();
      // Elite users don't need the "Upgrade" pill
      const up = document.querySelector('.shell-pill-upgrade');
      if (up) up.remove();
      // Swap the promo to "Academy" (was "Elite upsell" on default)
      const promo = document.querySelector('.sidebar-promo');
      if (promo && !promo.getAttribute('href').includes('academy')) {
        promo.remove();
        injectSidebarPromo('elite');
      }
    }
    // Account pill equity — re-fetched now that we have the real user
    if (user) {
      const modeEl = document.getElementById('shellAcctMode');
      const valEl = document.getElementById('shellAcctVal');
      if (valEl && (window.API && API.botSummary)) {
        API.botSummary().then((s) => {
          if (!s) return;
          const total = Number(s.totalPnl || 0);
          const base = Number(user.paperStartingBalance || 10000);
          valEl.textContent = '$' + (base + total).toLocaleString('en-US', { maximumFractionDigits: 0 });
          if (modeEl) {
            // LIVE only when the user has at least one active bot in
            // live trading_mode. DEMO covers Free plan, paper-only bots,
            // and users without any active live bot.
            const hasLive = Number(s.liveBots) > 0;
            const mode = hasLive ? 'LIVE' : 'DEMO';
            modeEl.textContent = mode; modeEl.setAttribute('data-mode', mode.toLowerCase());
          }
        }).catch(() => {});
      }
    }
  }

  // AI-assistant sidebar item (BETA) — sits at the top above Dashboard.
  // Now navigates to the dedicated /ai.html page (full-screen chat).
  // The widget in the corner still has its AI tab as a quick-access
  // fallback, so users get two ways in: big page + corner bubble.
  function injectAIAssistantLink() {
    if (document.querySelector('.sidebar-link[data-page="ai"]')) return;
    const nav = document.querySelector('.sidebar-nav');
    const dash = document.querySelector('.sidebar-link[data-page="dashboard"]');
    if (!nav || !dash) return;
    const link = document.createElement('a');
    link.href = 'ai.html';
    link.className = 'sidebar-link sidebar-link-ai';
    link.setAttribute('data-page', 'ai');
    link.setAttribute('aria-label', 'AI-ассистент (бета)');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/>'
      + '<path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z"/>'
      + '</svg>'
      + '<span>AI-ассистент</span>'
      + '<span class="sidebar-beta">BETA</span>';
    nav.insertBefore(link, dash);
  }

  // Extended sidebar footer — community icons + Chat/Email/Request links
  // + mobile-app badges. Injected once above the logout button on every
  // authed page. All links open new tabs for external resources.
  function injectSidebarFooterExtras() {
    const footer = document.querySelector('.sidebar-footer');
    if (!footer || footer.querySelector('.sidebar-footer-extras')) return;
    const wrap = document.createElement('div');
    wrap.className = 'sidebar-footer-extras';
    wrap.innerHTML =
      // Chat / Email / Request row
      '<div class="sbf-row">'
      +  '<button type="button" class="sbf-link" data-sbf="chat">Чат</button>'
      +  '<a class="sbf-link" href="mailto:support@chmup.top">Email</a>'
      +  '<a class="sbf-link" href="https://t.me/CHMUP_bot" target="_blank" rel="noopener">Идеи</a>'
      + '</div>'
      // Community icons
      + '<div class="sbf-community">'
      +  '<span class="sbf-community-label">Комьюнити</span>'
      +  '<div class="sbf-community-icons">'
      +    '<a href="https://t.me/crypto_chm" target="_blank" rel="noopener" aria-label="Telegram" title="Telegram"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.3 2.7 2.4 10.8c-1.4.6-1.4 1.4-.2 1.8l5.3 1.7 2.1 6.3c.3.7.1 1 .9 1 .6 0 .9-.3 1.2-.6l2.6-2.5 5.3 4c1 .5 1.7.2 2-.9L22.9 4c.3-1.5-.5-2-1.6-1.3zM8.3 15.2 17 9.6c.4-.3.8-.1.5.2l-7 6.3-.3 3.6-1.9-4.5z"/></svg></a>'
      +    '<a href="https://discord.gg/chmfinance" target="_blank" rel="noopener" aria-label="Discord" title="Discord"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.3 4.4a17 17 0 00-4.2-1.3.1.1 0 00-.1 0 11 11 0 00-.6 1.2 16 16 0 00-4.8 0A9 9 0 008 3.1h-.1a17 17 0 00-4.2 1.3h-.1A17.8 17.8 0 00.6 16.5a.1.1 0 00.1.1 17 17 0 005.2 2.6h.1c.4-.5.7-1 1-1.6v-.1a11 11 0 01-1.7-.8v-.1l.3-.3c3.3 1.5 6.8 1.5 10 0l.3.3v.1l-1.7.8v.1c.3.6.6 1.1 1 1.6h.1a17 17 0 005.2-2.6.1.1 0 00.1-.1 17.6 17.6 0 00-3-12.1zM8 14.3c-1 0-1.9-.9-1.9-2.1 0-1.1.9-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.9 2.1-1.9 2.1zm8 0c-1 0-1.9-.9-1.9-2.1 0-1.1.9-2.1 1.9-2.1s1.9 1 1.9 2.1c0 1.2-.9 2.1-1.9 2.1z"/></svg></a>'
      +    '<a href="https://x.com/chmfinance" target="_blank" rel="noopener" aria-label="X (Twitter)" title="X"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2h3.4l-7.4 8.5L23.7 22h-6.8l-5.3-7L5.5 22H2l7.9-9L1.4 2h7l4.8 6.4L18.9 2zm-1.2 17.9h1.9L6.3 4H4.3l13.4 15.9z"/></svg></a>'
      +  '</div>'
      + '</div>'
      // Mobile apps (actual links updated when we publish)
      + '<div class="sbf-apps">'
      +  '<span class="sbf-apps-label">Приложение</span>'
      +  '<div class="sbf-apps-badges">'
      +    '<a href="#coming-soon" class="sbf-app-badge sbf-app-ios"   aria-label="App Store"><svg width="12" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.6 12.6c0-2.7 2.2-4 2.3-4-1.2-1.8-3.2-2-3.9-2-1.6-.2-3.2 1-4 1s-2.1-1-3.5-1c-1.8 0-3.5 1-4.4 2.7-1.9 3.3-.5 8.1 1.4 10.8.9 1.3 2 2.8 3.4 2.7 1.4-.1 1.9-.9 3.5-.9s2.1.9 3.5.9c1.5 0 2.4-1.3 3.3-2.6 1-1.4 1.5-2.9 1.5-3 0 0-2.9-1.1-3-4.4zM15 4.5c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3.1 1.5-.7.8-1.2 2-1.1 3.2 1.1.1 2.3-.6 3.1-1.4z"/></svg><span>App Store</span></a>'
      +    '<a href="#coming-soon" class="sbf-app-badge sbf-app-android" aria-label="Google Play"><svg width="12" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 20.7V3.3c0-.5.2-.9.6-1.2l10.2 10.1L3.6 22.3c-.4-.3-.6-.9-.6-1.6zm13.2-7.5 3.3 1.9c.9.5.9 1.8 0 2.3l-3.6 2.1-3.6-3.6 3.9-2.7zm-2.6-2.4L5 2.2l11.2 6.4-2.6 2.2zm0 2.4 2.6 2.2-11.2 6.5 8.6-8.7z"/></svg><span>Google Play</span></a>'
      +  '</div>'
      + '</div>'
      + '<div class="sbf-legal">'
      +  '<a href="terms.html">Условия</a>'
      +  '<span>·</span>'
      +  '<a href="privacy.html">Политика</a>'
      + '</div>';

    // Hook up "Чат" button to the support widget
    const chatBtn = wrap.querySelector('[data-sbf="chat"]');
    if (chatBtn) chatBtn.addEventListener('click', () => {
      const btn = document.querySelector('.chm-sup-btn');
      if (btn) btn.click();
    });

    // Intercept "coming soon" app badges so they don't navigate
    wrap.querySelectorAll('.sbf-app-badge[href="#coming-soon"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (window.Toast && Toast.info) Toast.info('Мобильное приложение в beta — скоро в сторах');
      });
    });

    footer.insertBefore(wrap, footer.firstChild);
  }

  // Topbar account pill — 3Commas "РЕАЛЬНЫЙ АККАУНТ ▾" equivalent.
  // Shows mode (Live / Paper) + aggregated equity. Clicking drills into
  // /wallet (which holds the real account switcher + balance detail).
  function injectAccountPill(user) {
    const ticker = document.getElementById('shellMarket');
    const actions = document.querySelector('.topbar-actions');
    if (!actions || document.getElementById('shellAcct')) return;
    const pill = document.createElement('a');
    pill.id = 'shellAcct';
    pill.className = 'shell-acct';
    pill.href = 'wallet.html';
    pill.title = 'Твой аккаунт — перейти в Кошелёк';
    pill.innerHTML =
      '<span class="shell-acct-mode" id="shellAcctMode" data-help="demo">DEMO</span>'
      + '<span class="shell-acct-val" id="shellAcctVal" data-help="equity">—</span>'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    // Place in topbar-actions (RIGHT side), before the "+ Создать бота"
    // / Upgrade pills so the order reads: ACCOUNT · [+ BOT] · [UPGRADE] ·
    // LANG · THEME · 🔔 · AVATAR. Previously lived between collapse-btn
    // and BTC/ETH tickers on the left, which made the left group wrap
    // when ticker labels grew to "BTC/USDT" / "ETH/USDT".
    const quick = document.getElementById('shellQuick');
    if (quick) actions.insertBefore(pill, quick);
    else actions.insertBefore(pill, actions.firstChild);

    // Paint from cache immediately (survives page nav), then refresh.
    // v2: bumped cache key after the LIVE/DEMO heuristic was fixed —
    // forces a one-time refresh so users still showing a stale "LIVE"
    // pill from the broken NaN-check don't keep seeing it for 10 min.
    const ACCT_CACHE = 'chm_acct_cache_v2';
    try { localStorage.removeItem('chm_acct_cache'); } catch (_) {}
    const modeEl = document.getElementById('shellAcctMode');
    const valEl = document.getElementById('shellAcctVal');
    try {
      const cached = JSON.parse(localStorage.getItem(ACCT_CACHE) || 'null');
      if (cached && (Date.now() - (cached.at || 0) < 10 * 60 * 1000)) {
        if (modeEl) { modeEl.textContent = cached.mode; modeEl.setAttribute('data-mode', cached.mode.toLowerCase()); }
        if (valEl) valEl.textContent = '$' + cached.equity.toLocaleString('en-US', { maximumFractionDigits: 0 });
      }
    } catch (_) {}

    (async () => {
      try {
        const s = await (window.API && API.botSummary ? API.botSummary() : Promise.resolve(null));
        if (!s) return;
        const hasLive = Number(s.liveBots) > 0;
        const mode = hasLive ? 'LIVE' : 'DEMO';
        const total = Number(s.totalPnl || 0);
        const paperBase = Number((user && user.paperStartingBalance) || 10000);
        const equity = paperBase + total;
        if (modeEl) { modeEl.textContent = mode; modeEl.setAttribute('data-mode', mode.toLowerCase()); }
        if (valEl) valEl.textContent = '$' + equity.toLocaleString('en-US', { maximumFractionDigits: 0 });
        try { localStorage.setItem(ACCT_CACHE, JSON.stringify({ mode, equity, at: Date.now() })); } catch (_) {}
      } catch (_) {}
    })();
  }

  // Topbar quick actions — 3Commas-style pills. Inserts BEFORE the existing
  // lang/theme/avatar stack. Skipped on the bots / terminal pages where the
  // action is primary content already.
  function injectTopbarQuickActions(plan) {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || document.getElementById('shellQuick')) return;
    const path = (location.pathname || '').split('/').pop();
    const suppressCreateOn = new Set(['bots.html', 'terminal.html']);
    const wrap = document.createElement('div');
    wrap.id = 'shellQuick';
    wrap.className = 'shell-quick';
    let html = '';
    if (!suppressCreateOn.has(path)) {
      html += '<a href="bots.html" class="shell-pill-create" title="Создать нового бота">'
        +   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>'
        +   '<span>Создать бота</span>'
        + '</a>';
    }
    if (plan !== 'elite') {
      html += '<a href="subscriptions.html?plan=elite" class="shell-pill-upgrade" title="Перейти на Elite">'
        +   '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
        +   '<span>Upgrade</span>'
        + '</a>';
    }
    if (!html) return;
    wrap.innerHTML = html;
    actions.insertBefore(wrap, actions.firstChild);
  }

  // Sidebar promo card at the bottom (3Commas-style "Лист ожидания" block).
  // For non-Elite: upsell Market Scanner + multi-strategy combo.
  // For Elite:     promote Academy to drive engagement.
  function injectSidebarPromo(plan) {
    if (document.querySelector('.sidebar-promo')) return;
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar) return;
    const footer = sidebar.querySelector('.sidebar-footer');
    const isElite = plan === 'elite';
    const promo = document.createElement('a');
    promo.className = 'sidebar-promo';
    promo.href = isElite ? 'academy/index.html' : 'subscriptions.html?plan=elite';
    // Clean line SVG icons — no emoji
    const eliteIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    const academyIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
    promo.innerHTML = isElite
      ? '<div class="sidebar-promo-ic">' + academyIcon + '</div>'
        + '<div class="sidebar-promo-body">'
        +   '<div class="sidebar-promo-title">Академия CHM</div>'
        +   '<div class="sidebar-promo-sub">Разборы стратегий SMC, Gerchik, DCA — бесплатно.</div>'
        + '</div>'
        + '<div class="sidebar-promo-arrow">→</div>'
      : '<div class="sidebar-promo-ic">' + eliteIcon + '</div>'
        + '<div class="sidebar-promo-body">'
        +   '<div class="sidebar-promo-title">Elite · Market Scanner</div>'
        +   '<div class="sidebar-promo-sub">Сканирует весь рынок × мульти-стратегии. 7 дней бесплатно.</div>'
        + '</div>'
        + '<div class="sidebar-promo-arrow">→</div>';
    if (footer) sidebar.insertBefore(promo, footer);
    else sidebar.appendChild(promo);
  }

  // Topbar plan pill + dropdown — our take on 3Commas "Free тариф ▾" but
  // designed around progress bars, plan-ladder visualisation, and an
  // inline "what unlocks next" teaser rather than a plain counter list.
  // Single /api/subscriptions/usage fetch powers everything.
  function injectPlanPill(plan) {
    const actions = document.querySelector('.topbar-actions');
    if (!actions || document.getElementById('shellPlanPill')) return;
    // Visual language per plan — Free gets a subtle muted look (not
    // emphasised, it's the default); Starter/Pro/Elite get progressively
    // more saturated accents. Pill always shows a small dot-icon so the
    // chip looks finished even with a short label like "Free".
    const PLAN_META = {
      free:    { label: 'Free',    bg: 'rgba(148,163,184,.12)', fg: '#CBD5E1', ring: 'rgba(148,163,184,.22)', dot: '#94A3B8' },
      starter: { label: 'Starter', bg: 'rgba(59,130,246,.15)',  fg: '#93C5FD', ring: 'rgba(59,130,246,.3)',   dot: '#60A5FA' },
      pro:     { label: 'Pro',     bg: 'rgba(255,140,90,.18)',  fg: '#FF8C5A', ring: 'rgba(255,140,90,.35)',  dot: '#FF5A1F' },
      elite:   { label: 'Elite',   bg: 'rgba(250,204,21,.15)',  fg: '#FDE047', ring: 'rgba(250,204,21,.32)',  dot: '#FDE047' },
    };
    const meta = PLAN_META[plan] || PLAN_META.free;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'shellPlanPill';
    btn.className = 'shell-plan-pill shell-plan-pill-' + plan;
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('title', 'Подписка · ' + meta.label);
    btn.setAttribute('data-help', 'plan');
    btn.style.setProperty('--plan-bg', meta.bg);
    btn.style.setProperty('--plan-fg', meta.fg);
    btn.style.setProperty('--plan-ring', meta.ring);
    btn.style.setProperty('--plan-dot', meta.dot);
    btn.innerHTML =
      '<span class="shell-plan-pill-dot" aria-hidden="true"></span>'
      + '<span class="shell-plan-pill-name">' + meta.label + '</span>'
      + '<svg class="shell-plan-pill-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

    // Insert AFTER shell-acct but BEFORE shell-quick (so reading order
    // stays logical: tickers → account → plan → actions → avatar).
    const quick = document.getElementById('shellQuick');
    const acct = document.getElementById('shellAcct');
    if (quick) actions.insertBefore(btn, quick);
    else if (acct && acct.nextSibling) actions.insertBefore(btn, acct.nextSibling);
    else actions.insertBefore(btn, actions.firstChild);

    // Dropdown element — appended to body so it escapes topbar overflow
    const dd = document.createElement('div');
    dd.id = 'shellPlanDropdown';
    dd.className = 'shell-plan-dd';
    dd.setAttribute('role', 'menu');
    document.body.appendChild(dd);

    let loaded = false;
    let outsideHandler = null;

    function close() {
      dd.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (outsideHandler) {
        document.removeEventListener('click', outsideHandler, true);
        outsideHandler = null;
      }
    }
    function positionDd() {
      const r = btn.getBoundingClientRect();
      // Align right edge of dropdown with right edge of button; 8px below
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    }
    function open() {
      positionDd();
      dd.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      outsideHandler = (e) => {
        if (dd.contains(e.target) || btn.contains(e.target)) return;
        close();
      };
      setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);
      window.addEventListener('resize', positionDd);
      if (!loaded) {
        loaded = true;
        renderDropdown(dd, '<div style="padding:24px;text-align:center;color:rgba(255,255,255,.5);font-size:12px">Загрузка…</div>');
        fetchAndRender(dd);
      }
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dd.classList.contains('open')) close();
      else open();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  function renderDropdown(dd, html) { dd.innerHTML = html; }

  async function fetchAndRender(dd) {
    let data = null;
    try { data = await (window.API && API.planUsage ? API.planUsage() : null); }
    catch { data = null; }
    if (!data) {
      renderDropdown(dd, '<div style="padding:24px;text-align:center;color:#C8A0A0;font-size:12px">Не удалось загрузить</div>');
      return;
    }
    // Premium inline SVG icons — no emoji. 16×16, 1.8 stroke, Aura orange.
    const ICON = (() => {
      const mk = (path) => '<svg class="shell-plan-metric-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
      return {
        // Bot head with antenna
        bot:       mk('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M9 17h6"/>'),
        // Lightning bolt
        signal:    mk('<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>'),
        // Key
        key:       mk('<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 9.4-9.4"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/>'),
        // Chart / backtest (bars + trend line)
        chart:     mk('<path d="M3 3v18h18"/><rect x="7"  y="13" width="3" height="5"/><rect x="12" y="9"  width="3" height="9"/><rect x="17" y="6"  width="3" height="12"/>'),
        // Rocket for "what unlocks next"
        rocket:    mk('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>'),
        // Crown for max-plan state
        crown:     mk('<path d="M2 10 5 4l5 5 2-5 2 5 5-5 3 6-3 9H5L2 10z"/><path d="M5 19h14"/>'),
        // Check for unlock bullets
        check:     mk('<polyline points="20 6 9 17 4 12"/>'),
      };
    })();

    const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const PLAN_ORDER = ['free', 'starter', 'pro', 'elite'];
    const curIdx = PLAN_ORDER.indexOf(data.plan.id);

    // Ladder — horizontal pills with current highlighted
    const ladder = PLAN_ORDER.map((id, i) => {
      const active = i === curIdx;
      const done = i < curIdx;
      const cls = active ? 'shell-plan-ladder-pill active' : (done ? 'shell-plan-ladder-pill done' : 'shell-plan-ladder-pill');
      return '<span class="' + cls + '">' + id.charAt(0).toUpperCase() + id.slice(1) + '</span>';
    }).join('<span class="shell-plan-ladder-sep">›</span>');

    // Progress bars with SVG icons in a rounded chip
    const bar = (label, iconSvg, used, limit) => {
      const unlim = limit === null || limit === undefined;
      const pct = unlim ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
      const pctColor = pct >= 90 ? '#ef4444' : pct >= 70 ? '#FF8C5A' : '#4ade80';
      const valueText = unlim ? used + ' <span style="opacity:.45">/ ∞</span>' : used + ' <span style="opacity:.45">/ ' + limit + '</span>';
      return '<div class="shell-plan-metric">' +
        '<div class="shell-plan-metric-head">' +
          '<span class="shell-plan-metric-label"><span class="shell-plan-metric-ic-wrap">' + iconSvg + '</span>' + escHtml(label) + '</span>' +
          '<span class="shell-plan-metric-value mono">' + valueText + '</span>' +
        '</div>' +
        '<div class="shell-plan-metric-bar">' +
          (unlim
            ? '<div class="shell-plan-metric-bar-unlim"></div>'
            : '<div class="shell-plan-metric-bar-fill" style="width:' + pct + '%;background:' + pctColor + '"></div>') +
        '</div>' +
      '</div>';
    };

    const expiry = data.expiresAt
      ? ' · до <span class="mono">' + new Date(data.expiresAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }) + '</span>'
      : (data.plan.id === 'free' ? ' · навсегда бесплатно' : '');

    const nextHtml = data.next ? (
      '<div class="shell-plan-next">' +
        '<div class="shell-plan-next-head">' +
          '<span class="shell-plan-next-ic-wrap">' + ICON.rocket + '</span>' +
          'На ' + escHtml(data.next.name) + ' откроется' +
        '</div>' +
        '<ul class="shell-plan-next-list">' +
          data.next.unlocks.map((u) => '<li>' + ICON.check + '<span>' + escHtml(u) + '</span></li>').join('') +
        '</ul>' +
        '<a href="subscriptions.html?plan=' + escHtml(data.next.id) + '" class="shell-plan-cta">' +
          'Апгрейд на ' + escHtml(data.next.name) + ' · <span class="mono">$' + data.next.priceUsd + '/мес</span>' +
        '</a>' +
      '</div>'
    ) : (
      '<div class="shell-plan-max">' +
        '<div class="shell-plan-max-ic-wrap">' + ICON.crown + '</div>' +
        '<div style="text-align:center;font-size:12.5px;font-weight:600;color:#FDE047;margin-top:6px">Ты на максимальном плане</div>' +
        '<div style="text-align:center;font-size:11px;color:rgba(255,255,255,.5);margin-top:2px">Все фичи CHM Finance доступны</div>' +
      '</div>'
    );

    renderDropdown(dd,
      '<div class="shell-plan-dd-head">' +
        '<div class="shell-plan-dd-title">Подписка' + expiry + '</div>' +
      '</div>' +
      '<div class="shell-plan-ladder">' + ladder + '</div>' +
      '<div class="shell-plan-metrics">' +
        bar('Активные боты',     ICON.bot,    data.usage.bots.used,      data.usage.bots.limit) +
        bar('Сигналов сегодня',  ICON.signal, data.usage.signals.used,   data.usage.signals.limit) +
        bar('API-ключи бирж',    ICON.key,    data.usage.keys.used,      data.usage.keys.limit) +
        bar('Бэктесты в месяце', ICON.chart,  data.usage.backtests.used, data.usage.backtests.limit) +
      '</div>' +
      nextHtml
    );
  }

  // Market Scanner sidebar link — shown only to Elite. Idempotent.
  function injectMarketScannerLink() {
    if (document.querySelector('.sidebar-link[data-page="market-scanner"]')) return;
    const signals = document.querySelector('.sidebar-link[data-page="signals"]');
    if (!signals) return;
    const link = document.createElement('a');
    link.href = 'market-scanner.html';
    link.className = 'sidebar-link';
    link.setAttribute('data-page', 'market-scanner');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>Market Scanner';
    signals.parentNode.insertBefore(link, signals.nextSibling);
  }

  // SmartTrade Terminal sidebar link — shown to every authed user. Idempotent.
  function injectTerminalLink() {
    if (document.querySelector('.sidebar-link[data-page="terminal"]')) return;
    const bots = document.querySelector('.sidebar-link[data-page="bots"]');
    if (!bots) return;
    const link = document.createElement('a');
    link.href = 'terminal.html';
    link.className = 'sidebar-link';
    link.setAttribute('data-page', 'terminal');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><path d="M7 8l3 3-3 3M12 15h5"/></svg>Terminal';
    bots.parentNode.insertBefore(link, bots.nextSibling);
  }

  // Copy Trading sidebar link — shown to every authed user. Idempotent.
  // Sits right after Terminal (if present), else after Bots.
  function injectCopyLink() {
    if (document.querySelector('.sidebar-link[data-page="copy"]')) return;
    const anchor = document.querySelector('.sidebar-link[data-page="terminal"]')
      || document.querySelector('.sidebar-link[data-page="bots"]');
    if (!anchor) return;
    const link = document.createElement('a');
    link.href = 'copy.html';
    link.className = 'sidebar-link';
    link.setAttribute('data-page', 'copy');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.66V20a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h5.34"/><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"/></svg>Copy';
    anchor.parentNode.insertBefore(link, anchor.nextSibling);
  }

  // Subscriptions sidebar link — always present for authed users.
  // Inserted between Leaderboard and Настройки (or before Настройки if
  // Leaderboard is missing). Idempotent.
  function injectSubscriptionsLink() {
    if (document.querySelector('.sidebar-link[data-page="subscriptions"]')) return;
    const settings = document.querySelector('.sidebar-link[data-page="settings"]');
    if (!settings) return;
    const link = document.createElement('a');
    link.href = 'subscriptions.html';
    link.className = 'sidebar-link';
    link.setAttribute('data-page', 'subscriptions');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>Подписки';
    settings.parentNode.insertBefore(link, settings);
  }

  // ── 3 & 4. Topbar toggles ──────────────────────────────────────────────
  // Strategy: buttons are HARDCODED in each page's HTML (tag #shellLang /
  // #shellTheme). Shell.js only wires click handlers + keeps labels fresh.
  // Fallback: if a page hasn't been updated yet, inject them dynamically so
  // the UI never breaks.
  function wireTopbar() {
    let lang = document.getElementById('shellLang');
    let theme = document.getElementById('shellTheme');

    if (!lang || !theme) {
      const actions = document.querySelector('.topbar-actions');
      if (!actions) return;
      if (!lang) {
        lang = document.createElement('button');
        lang.id = 'shellLang'; lang.type = 'button';
        lang.className = 'shell-topbar-btn'; lang.title = 'Language';
        actions.insertBefore(lang, actions.firstChild);
      }
      if (!theme) {
        theme = document.createElement('button');
        theme.id = 'shellTheme'; theme.type = 'button';
        theme.className = 'shell-topbar-btn'; theme.title = 'Toggle theme';
        if (lang.nextSibling) actions.insertBefore(theme, lang.nextSibling);
        else actions.appendChild(theme);
      }
    }

    if (!lang.dataset.shellWired) {
      lang.textContent = LANG_LABEL[_nextLang(getLang())];
      lang.addEventListener('click', () => { setLang(_nextLang(getLang())); applyLang(); });
      lang.dataset.shellWired = '1';
    }
    if (!theme.dataset.shellWired) {
      theme.innerHTML = getTheme() === 'light' ? _sunIcon() : _moonIcon();
      theme.addEventListener('click', () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); applyTheme(); });
      theme.dataset.shellWired = '1';
    }

    injectSidebarCollapseBtn();
  }

  // Desktop sidebar collapse — slim-icon mode (64px) toggled via a panel
  // icon in the topbar-left. Persists in localStorage. On mobile the
  // existing #sidebar-toggle hamburger handles open/close independently.
  function injectSidebarCollapseBtn() {
    if (document.getElementById('shellSideToggle')) return;
    const leftGroup = document.querySelector('.topbar > div:first-child') || document.querySelector('.topbar');
    if (!leftGroup) return;
    const btn = document.createElement('button');
    btn.id = 'shellSideToggle';
    btn.type = 'button';
    btn.className = 'shell-side-toggle';
    btn.setAttribute('aria-label', 'Скрыть / показать боковую панель');
    btn.setAttribute('title', 'Скрыть / показать боковую панель');
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<rect x="3" y="4" width="18" height="16" rx="2"/>'
      + '<line x1="9" y1="4" x2="9" y2="20"/>'
      + '</svg>';
    // Insert as the FIRST child of the left group so it sits before the
    // mobile hamburger and any search pill.
    leftGroup.insertBefore(btn, leftGroup.firstChild);

    // Restore persisted state
    try {
      if (localStorage.getItem('chm_sidebar_collapsed') === '1') {
        document.body.classList.add('sidebar-collapsed');
      }
    } catch (_) {}

    btn.addEventListener('click', () => {
      const next = !document.body.classList.contains('sidebar-collapsed');
      document.body.classList.toggle('sidebar-collapsed', next);
      try { localStorage.setItem('chm_sidebar_collapsed', next ? '1' : '0'); } catch (_) {}
    });
  }

  // ── Market tickers + Fear & Greed (topbar, public data) ───────────────
  async function wireMarketTickers() {
    // Place on the RIGHT side of the topbar (inside .topbar-actions) so
    // the layout is identical on every page regardless of whether the
    // left group has a search pill, sidebar-toggle, or page title. Goes
    // before the account pill so the reading order is always:
    // [tickers] [ACCOUNT] [+ BOT] [Upgrade] [EN] [🌙] [🔔] [avatar].
    const actions = document.querySelector('.topbar-actions');
    if (!actions || !window.API || !API.marketContext) return;
    if (document.getElementById('shellMarket')) return;
    const wrap = document.createElement('div');
    wrap.id = 'shellMarket';
    wrap.className = 'shell-market';
    // Build pill per ticker: glyph + code + price + delta chip. Skeleton
    // state uses "—" placeholders until the fetch resolves.
    const tickerSkel = (id, code, color) => `
      <div id="${id}" class="shell-tick" data-state="loading">
        <span class="shell-tick-glyph" style="background:${color}"><span>${code[0]}</span></span>
        <span class="shell-tick-body">
          <span class="shell-tick-code">${code}</span>
          <span class="shell-tick-price mono">—</span>
        </span>
        <span class="shell-tick-delta mono">—</span>
      </div>`;
    wrap.innerHTML =
      tickerSkel('tickBtc', 'BTC/USDT', 'linear-gradient(135deg,#F7931A,#E07D10)') +
      tickerSkel('tickEth', 'ETH/USDT', 'linear-gradient(135deg,#627EEA,#3C58B8)') +
      `<div id="fngBadge" class="shell-fng" title="Crypto Fear & Greed — 0=extreme fear, 100=extreme greed">
         <span class="shell-fng-label">F&amp;G</span>
         <span class="shell-fng-value mono">—</span>
         <span class="shell-fng-dot"></span>
       </div>`;
    // Insert BEFORE the account pill if already present, else at the start
    const acctEl = document.getElementById('shellAcct');
    if (acctEl) actions.insertBefore(wrap, acctEl);
    else actions.insertBefore(wrap, actions.firstChild);

    // Ticker cache — survives page navigations so the bars never flash "—"
    // on a fresh load. Every update writes to localStorage; on boot we
    // paint the cached value immediately, and WS/REST deliver the fresh
    // data on top. Makes the shell feel persistent across SPA-less nav.
    const CACHE_KEY = 'chm_ticker_cache';
    const loadCache = () => {
      try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
      catch { return {}; }
    };
    const saveCache = (id, t) => {
      try {
        const c = loadCache();
        c[id] = { price: t.price, change24h: t.change24h, at: Date.now() };
        localStorage.setItem(CACHE_KEY, JSON.stringify(c));
      } catch (_) {}
    };

    const paintTick = (id, t, opts) => {
      const el = document.getElementById(id); if (!el) return;
      if (!t) { el.dataset.state = 'empty'; return; }
      const up = t.change24h > 0, down = t.change24h < 0;
      const trend = up ? 'up' : down ? 'down' : 'flat';
      el.dataset.state = 'ready';
      el.dataset.trend = trend;
      // Show 2 decimals on prices < $100, round on > $1000
      const price = t.price < 100 ? t.price.toFixed(2)
                  : t.price < 1000 ? t.price.toFixed(1)
                  : Math.round(t.price).toLocaleString('en-US');
      el.querySelector('.shell-tick-price').textContent = '$' + price;
      const d = el.querySelector('.shell-tick-delta');
      const arrow = up ? '▲' : down ? '▼' : '·';
      d.textContent = `${arrow} ${Math.abs(t.change24h).toFixed(2)}%`;
      if (!opts || opts.cache !== false) saveCache(id, t);
    };

    // Paint from cache INSTANTLY so the bar never renders empty on a
    // fresh page load. Stale data is OK — WS/REST below overwrite it
    // within 100–300ms. Ignore entries older than 10 minutes to avoid
    // showing 2-day-old BTC price if user's been offline.
    const cache = loadCache();
    const STALE_MS = 10 * 60 * 1000;
    ['tickBtc', 'tickEth'].forEach((id) => {
      const hit = cache[id];
      if (hit && (Date.now() - (hit.at || 0) < STALE_MS)) {
        paintTick(id, hit, { cache: false });
      }
    });

    const refresh = async () => {
      try {
        const r = await API.marketContext(); if (!r) return;
        if (r.tickers) { paintTick('tickBtc', r.tickers.btc); paintTick('tickEth', r.tickers.eth); }
        if (r.fearGreed) {
          const fng = r.fearGreed, v = Number(fng.value);
          paintFng(v, fng.classification);
          try { localStorage.setItem('chm_fng_cache', JSON.stringify({ v, c: fng.classification, at: Date.now() })); } catch (_) {}
        }
      } catch (_e) {}
    };
    function paintFng(v, classification) {
      const level = v < 25 ? 'extreme-fear' : v < 45 ? 'fear' : v < 55 ? 'neutral' : v < 75 ? 'greed' : 'extreme-greed';
      const el = document.getElementById('fngBadge');
      if (!el) return;
      el.dataset.level = level;
      el.querySelector('.shell-fng-value').textContent = v;
      el.title = `Crypto Fear & Greed: ${v} — ${classification || ''}`;
    }
    // Paint cached F&G instantly
    try {
      const cached = JSON.parse(localStorage.getItem('chm_fng_cache') || 'null');
      if (cached && (Date.now() - (cached.at || 0) < 60 * 60 * 1000)) paintFng(cached.v, cached.c);
    } catch (_) {}
    refresh();
    setInterval(refresh, 60_000);

    // Real-time stream: Binance public WebSocket pushes ticker updates ~1/s.
    // Runs entirely client-side (browser → Binance), no server load, no
    // auth, no rate limits. On drop we reconnect with exponential backoff.
    // If WS is unavailable (old browser / blocked), the 60s REST refresh
    // above keeps prices updating anyway — graceful degradation.
    (function openBinanceWS() {
      if (typeof WebSocket === 'undefined') return;
      let ws = null;
      let delay = 1000;
      let reconnectTimer = null;
      let closedByUs = false;
      function connect() {
        try {
          ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@ticker');
        } catch (e) { scheduleReconnect(); return; }
        ws.onopen = () => { delay = 1000; };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            const d = msg && msg.data;
            if (!d || d.e !== '24hrTicker') return;
            const t = { price: Number(d.c), change24h: Number(d.P) };
            if (d.s === 'BTCUSDT') paintTick('tickBtc', t);
            else if (d.s === 'ETHUSDT') paintTick('tickEth', t);
          } catch (_) {}
        };
        ws.onerror = () => { try { ws && ws.close(); } catch (_) {} };
        ws.onclose = () => { if (!closedByUs) scheduleReconnect(); };
      }
      function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          delay = Math.min(30_000, delay * 2);
          connect();
        }, delay);
      }
      // Pause when tab hidden to save Binance's resources and our bandwidth
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          closedByUs = true;
          try { ws && ws.close(); } catch (_) {}
          clearTimeout(reconnectTimer);
        } else {
          closedByUs = false;
          connect();
        }
      });
      connect();
    })();
  }

  // A11y: mark the current sidebar link with aria-current="page" for SR users
  // and set a proper aria-label on the sidebar nav so assistive tech can
  // announce it. Also populates `title=` on every sidebar-link so that
  // when the sidebar is collapsed (labels hidden) the browser's native
  // tooltip shows the destination on hover.
  function wireA11y() {
    const nav = document.querySelector('.sidebar-nav');
    if (nav && !nav.getAttribute('aria-label')) nav.setAttribute('aria-label', 'Main navigation');
    const active = document.querySelector('.sidebar-link.active');
    if (active) active.setAttribute('aria-current', 'page');
    // Tooltip for collapsed state
    document.querySelectorAll('.sidebar-link').forEach((link) => {
      if (link.getAttribute('title')) return;
      const span = link.querySelector('span');
      const label = span && span.textContent.trim();
      if (label) link.setAttribute('title', label);
    });
    // Main content region for screen readers
    const main = document.querySelector('main.main-content');
    if (main && !main.getAttribute('role')) main.setAttribute('role', 'main');
  }

  // ── Search dropdown — icon-only trigger that pops a panel below with
  //     quick links + future search input. Replaces the always-visible
  //     280px search pill that ate too much topbar room and pushed the
  //     right-side action cluster around. Plan-aware: locked links show
  //     a 🔒 marker that resolves once PlanGate.init() is ready.
  function wireSearchPopup() {
    const wrap = document.querySelector('.topbar-search');
    if (!wrap || wrap.dataset.popupReady === '1') return;
    wrap.dataset.popupReady = '1';
    // Replace any legacy markup (older templates had <svg><input/>).
    // Keep a fresh icon + the popup panel.
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      +   '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>'
      + '</svg>'
      + '<div class="topbar-search-panel" role="dialog" aria-label="Поиск и навигация">'
      +   '<input type="search" placeholder="Поиск по платформе…" autocomplete="off"/>'
      +   '<div class="topbar-search-section">'
      +     '<div class="topbar-search-section-title">Быстрый переход</div>'
      +     '<a class="topbar-search-link" href="dashboard.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>Дашборд</a>'
      +     '<a class="topbar-search-link" href="bots.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/></svg>Боты</a>'
      +     '<a class="topbar-search-link" href="signals.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>Сигналы</a>'
      +     '<a class="topbar-search-link" href="analytics.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>Аналитика</a>'
      +     '<a class="topbar-search-link" data-needs="backtest" href="backtests.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Бэктесты</a>'
      +     '<a class="topbar-search-link" href="wallet.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 14h2"/></svg>Кошелёк</a>'
      +     '<a class="topbar-search-link" href="settings.html"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>Настройки</a>'
      +   '</div>'
      + '</div>';

    const panel = wrap.querySelector('.topbar-search-panel');
    const input = wrap.querySelector('.topbar-search-panel input');

    const open = () => {
      wrap.classList.add('open');
      // micro-defer focus so the click doesn't immediately blur it
      setTimeout(() => input && input.focus(), 30);
    };
    const close = () => wrap.classList.remove('open');

    wrap.addEventListener('click', (e) => {
      // Click on the trigger itself (icon area) toggles, click inside
      // the panel passes through.
      if (panel.contains(e.target)) return;
      if (wrap.classList.contains('open')) close(); else open();
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && wrap.classList.contains('open')) close();
      // ⌘K / Ctrl-K opens the search anywhere on the page
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (wrap.classList.contains('open')) close(); else open();
      }
    });
    // Live filter — hides links that don't match the input value
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      panel.querySelectorAll('.topbar-search-link').forEach((a) => {
        a.style.display = !q || a.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Plan-aware decoration: stamp 🔒 onto links the current plan can't
    // use. Backtests is the only Free-locked sidebar entry today.
    const decorate = () => {
      if (!window.PlanGate) return;
      const plan = PlanGate.getPlan();
      panel.querySelectorAll('[data-needs="backtest"]').forEach((a) => {
        if (plan === 'free') {
          if (!a.querySelector('.lock')) a.insertAdjacentHTML('beforeend', '<span class="lock">🔒 Starter</span>');
        }
      });
    };
    if (window.PlanGate && PlanGate.init) PlanGate.init().then(decorate);
    else decorate();
  }

  // ── Sidebar plan locks — adds a 🔒 chip to sidebar links the current
  //     plan can't open productively. Today: Backtests for Free.
  function wireSidebarPlanLocks() {
    const apply = () => {
      if (!window.PlanGate) return;
      const plan = PlanGate.getPlan();
      const btLink = document.querySelector('.sidebar-link[data-page="backtests"]');
      if (btLink && plan === 'free' && !btLink.querySelector('.sidebar-link-lock')) {
        const chip = document.createElement('span');
        chip.className = 'sidebar-link-lock';
        chip.textContent = '🔒';
        chip.title = 'Бэктесты доступны на тарифе Starter и выше';
        chip.style.cssText = 'margin-left:auto;font-size:11px;opacity:.7';
        btLink.appendChild(chip);
      }
    };
    if (window.PlanGate && PlanGate.init) PlanGate.init().then(apply);
    else apply();
  }

  function boot() {
    applyTheme(); // apply <html class="light"> first so no flash
    wireLogo();
    wireTopbar();      // creates #shellLang + #shellTheme
    applyTheme();      // now safely sets the theme-btn icon
    applyLang();       // translates all data-t + refreshes lang button
    wireMarketTickers();
    wireSearchPopup();

    // Inject chrome SYNCHRONOUSLY with pessimistic defaults ('free', no
    // user). This paints the full sidebar/topbar immediately instead of
    // waiting on /auth/me (which added ~200ms of "old UI" flash).
    //   After DOM is populated we flip data-chrome-ready=1 which the
    //   CSS uses to fade in the sidebar/topbar-actions as one piece,
    //   killing any visible reshuffle.
    applyChrome('free', null);
    document.documentElement.setAttribute('data-chrome-ready', '1');

    // Async refinement: pulls real plan + user, updates plan-dependent
    // bits (Market Scanner link for Elite, promo card variant, Upgrade
    // pill removal for Elite, account pill equity).
    wirePlanBadge();
    wireA11y();
    wireSidebarPlanLocks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
