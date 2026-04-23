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
    if (plan === 'elite') injectMarketScannerLink();
    injectSidebarPromo(plan);
    injectSidebarFooterExtras();
    injectTopbarQuickActions(plan);
    injectAccountPill(user);
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
            const hasLive = Number(s.activeBots) > 0 && Number(s.livePnl) !== 0;
            const mode = hasLive ? 'LIVE' : 'PAPER';
            modeEl.textContent = mode; modeEl.setAttribute('data-mode', mode.toLowerCase());
          }
        }).catch(() => {});
      }
    }
  }

  // AI-assistant sidebar item (BETA) — sits at the top above Dashboard.
  // Clicking opens the support chat widget (the AI backend is not wired
  // yet; we reuse existing infra so the entry point is already useful).
  function injectAIAssistantLink() {
    if (document.querySelector('.sidebar-link[data-page="ai"]')) return;
    const nav = document.querySelector('.sidebar-nav');
    const dash = document.querySelector('.sidebar-link[data-page="dashboard"]');
    if (!nav || !dash) return;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'sidebar-link sidebar-link-ai';
    link.setAttribute('data-page', 'ai');
    link.setAttribute('aria-label', 'AI-ассистент (бета)');
    link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '<path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z"/>'
      + '<path d="M19 14l.75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75L19 14z"/>'
      + '</svg>'
      + '<span>AI-ассистент</span>'
      + '<span class="sidebar-beta">BETA</span>';
    link.addEventListener('click', () => {
      // Opens the support widget directly on the AI tab. If the widget
      // hasn't loaded yet (defer script still running), click the floating
      // bubble as a fallback — user gets the widget, just on Home tab.
      if (window.ChmSupport && typeof window.ChmSupport.open === 'function') {
        window.ChmSupport.open('ai');
      } else {
        const btn = document.querySelector('.chm-sup-btn');
        if (btn) btn.click();
      }
    });
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
      +    '<a href="https://t.me/chmfinance" target="_blank" rel="noopener" aria-label="Telegram" title="Telegram"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.3 2.7 2.4 10.8c-1.4.6-1.4 1.4-.2 1.8l5.3 1.7 2.1 6.3c.3.7.1 1 .9 1 .6 0 .9-.3 1.2-.6l2.6-2.5 5.3 4c1 .5 1.7.2 2-.9L22.9 4c.3-1.5-.5-2-1.6-1.3zM8.3 15.2 17 9.6c.4-.3.8-.1.5.2l-7 6.3-.3 3.6-1.9-4.5z"/></svg></a>'
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
      '<span class="shell-acct-mode" id="shellAcctMode">PAPER</span>'
      + '<span class="shell-acct-val" id="shellAcctVal">—</span>'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
    // Insert before the ticker if present, else before the lang button
    if (ticker && ticker.parentElement) {
      ticker.parentElement.insertBefore(pill, ticker);
    } else {
      actions.insertBefore(pill, actions.firstChild);
    }

    // Best-effort equity fetch — uses bot summary + paper starting balance.
    // Failures silent (the pill still renders with "—").
    (async () => {
      try {
        const s = await (window.API && API.botSummary ? API.botSummary() : Promise.resolve(null));
        if (!s) return;
        const hasLive = Number(s.activeBots) > 0 && Number(s.livePnl) !== 0;
        const mode = hasLive ? 'LIVE' : 'PAPER';
        const total = Number(s.totalPnl || 0);
        const paperBase = Number((user && user.paperStartingBalance) || 10000);
        const equity = paperBase + total;
        const modeEl = document.getElementById('shellAcctMode');
        const valEl = document.getElementById('shellAcctVal');
        if (modeEl) { modeEl.textContent = mode; modeEl.setAttribute('data-mode', mode.toLowerCase()); }
        if (valEl) valEl.textContent = '$' + equity.toLocaleString('en-US', { maximumFractionDigits: 0 });
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
      html += '<a href="settings.html?upgrade=elite" class="shell-pill-upgrade" title="Перейти на Elite">'
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
    promo.href = isElite ? 'academy/index.html' : 'settings.html?upgrade=elite';
    promo.innerHTML = isElite
      ? '<div class="sidebar-promo-ic">📚</div>'
        + '<div class="sidebar-promo-body">'
        +   '<div class="sidebar-promo-title">Академия CHM</div>'
        +   '<div class="sidebar-promo-sub">Разборы стратегий SMC, Gerchik, DCA — бесплатно.</div>'
        + '</div>'
        + '<div class="sidebar-promo-arrow">→</div>'
      : '<div class="sidebar-promo-ic">★</div>'
        + '<div class="sidebar-promo-body">'
        +   '<div class="sidebar-promo-title">Elite · Market Scanner</div>'
        +   '<div class="sidebar-promo-sub">Сканирует весь рынок × мульти-стратегии. 7 дней бесплатно.</div>'
        + '</div>'
        + '<div class="sidebar-promo-arrow">→</div>';
    if (footer) sidebar.insertBefore(promo, footer);
    else sidebar.appendChild(promo);
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
  }

  // ── Market tickers + Fear & Greed (topbar, public data) ───────────────
  async function wireMarketTickers() {
    const top = document.querySelector('.topbar > div:first-child') || document.querySelector('.topbar');
    if (!top || !window.API || !API.marketContext) return;
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
      tickerSkel('tickBtc', 'BTC', 'linear-gradient(135deg,#F7931A,#E07D10)') +
      tickerSkel('tickEth', 'ETH', 'linear-gradient(135deg,#627EEA,#3C58B8)') +
      `<div id="fngBadge" class="shell-fng" title="Crypto Fear & Greed — 0=extreme fear, 100=extreme greed">
         <span class="shell-fng-label">F&amp;G</span>
         <span class="shell-fng-value mono">—</span>
         <span class="shell-fng-dot"></span>
       </div>`;
    top.appendChild(wrap);

    const paintTick = (id, t) => {
      const el = document.getElementById(id); if (!el) return;
      if (!t) { el.dataset.state = 'empty'; return; }
      const up = t.change24h > 0, down = t.change24h < 0;
      const trend = up ? 'up' : down ? 'down' : 'flat';
      el.dataset.state = 'ready';
      el.dataset.trend = trend;
      el.querySelector('.shell-tick-price').textContent =
        '$' + Math.round(t.price).toLocaleString('en-US');
      const d = el.querySelector('.shell-tick-delta');
      const arrow = up ? '▲' : down ? '▼' : '·';
      d.textContent = `${arrow} ${Math.abs(t.change24h).toFixed(1)}%`;
    };

    const refresh = async () => {
      try {
        const r = await API.marketContext(); if (!r) return;
        if (r.tickers) { paintTick('tickBtc', r.tickers.btc); paintTick('tickEth', r.tickers.eth); }
        if (r.fearGreed) {
          const fng = r.fearGreed, v = Number(fng.value);
          const level = v < 25 ? 'extreme-fear' : v < 45 ? 'fear' : v < 55 ? 'neutral' : v < 75 ? 'greed' : 'extreme-greed';
          const el = document.getElementById('fngBadge');
          if (el) {
            el.dataset.level = level;
            el.querySelector('.shell-fng-value').textContent = v;
            el.title = `Crypto Fear & Greed: ${v} — ${fng.classification || ''}`;
          }
        }
      } catch (_e) {}
    };
    refresh();
    setInterval(refresh, 60_000);
  }

  // A11y: mark the current sidebar link with aria-current="page" for SR users
  // and set a proper aria-label on the sidebar nav so assistive tech can
  // announce it.
  function wireA11y() {
    const nav = document.querySelector('.sidebar-nav');
    if (nav && !nav.getAttribute('aria-label')) nav.setAttribute('aria-label', 'Main navigation');
    const active = document.querySelector('.sidebar-link.active');
    if (active) active.setAttribute('aria-current', 'page');
    // Main content region for screen readers
    const main = document.querySelector('main.main-content');
    if (main && !main.getAttribute('role')) main.setAttribute('role', 'main');
  }

  function boot() {
    applyTheme(); // apply <html class="light"> first so no flash
    wireLogo();
    wireTopbar();      // creates #shellLang + #shellTheme
    applyTheme();      // now safely sets the theme-btn icon
    applyLang();       // translates all data-t + refreshes lang button
    wireMarketTickers();

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
