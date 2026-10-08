/* App shell — shared across the authed pages (settings / subscriptions /
 * admin). Port plan M0: sidebar trimmed to App · Account · Plan · Support
 * (+ Admin). Handles:
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
    'sb-app':        { ru: 'Приложение', en: 'App',      es: 'App',      tr: 'Uygulama', id: 'Aplikasi' },
    'sb-account':    { ru: 'Аккаунт',    en: 'Account',  es: 'Cuenta',   tr: 'Hesap',    id: 'Akun' },
    'sb-plan':       { ru: 'Тариф',      en: 'Plan',     es: 'Plan',     tr: 'Plan',     id: 'Paket' },
    'sb-support':    { ru: 'Поддержка',  en: 'Support',  es: 'Soporte',  tr: 'Destek',   id: 'Dukungan' },
    'sb-admin':      { ru: 'Админ',      en: 'Admin',    es: 'Admin',    tr: 'Yönetici', id: 'Admin' },
    'sb-settings':   { ru: 'Настройки',   en: 'Settings',    es: 'Ajustes',      tr: 'Ayarlar',        id: 'Pengaturan' },
    'sb-logout':     { ru: 'Выйти',       en: 'Sign out',    es: 'Salir',        tr: 'Çıkış',          id: 'Keluar' },

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
  // Two plans like the bot (config/planFeatures.js). Retired ids still map
  // to a label so a not-yet-migrated row never renders as "undefined".
  const PLAN_LABEL = {
    free:    { label: 'Free',    class: 'plan-free' },
    pro:     { label: 'Pro',     class: 'plan-pro' },
    starter: { label: 'Free',    class: 'plan-free' },
    elite:   { label: 'Pro',     class: 'plan-pro' },
  };
  // Runs injectors that should appear on EVERY authed page (sidebar nav,
  // footer extras, plan pill, avatar menu). Separated from wirePlanBadge
  // so pages without a .sidebar-sub-badge anchor still get the chrome.
  function applyChrome(plan, user) {
    plan = plan || 'free';
    buildSidebarNav(user);
    injectSidebarFooterExtras();
    injectPlanPill(plan);
    injectAvatarMenu(user);
  }

  // ── Sidebar navigation ─────────────────────────────────────────────────
  // Pages ship the same static list for no-JS parity; this rebuilds it so
  // every authed page stays in sync, marks the current page active and adds
  // the Admin entry for admins once /auth/me resolves. `/app/` is the web
  // app that replaces the Telegram Mini App (port plan M11).
  const NAV_ICON = {
    app:      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>',
    account:  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg>',
    plan:     '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
    support:  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    admin:    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l7 4v6c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-4z"/></svg>',
  };
  const NAV_ITEMS = [
    { page: 'app',           href: '/app/',                 t: 'sb-app',     icon: NAV_ICON.app },
    { page: 'settings',      href: 'settings.html',         t: 'sb-account', icon: NAV_ICON.account },
    { page: 'subscriptions', href: 'subscriptions.html',    t: 'sb-plan',    icon: NAV_ICON.plan },
    { page: 'support',       href: 'settings.html#support', t: 'sb-support', icon: NAV_ICON.support },
  ];
  function buildSidebarNav(user) {
    const nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    const file = (location.pathname || '').split('/').pop() || 'index.html';
    const onSupport = file === 'settings.html' && location.hash === '#support';
    const items = NAV_ITEMS.slice();
    if (user && user.isAdmin) items.push({ page: 'admin', href: 'ops.html', t: 'sb-admin', icon: NAV_ICON.admin });
    const isActive = (it) => {
      if (it.page === 'support') return onSupport;
      if (it.page === 'settings') return file === 'settings.html' && !onSupport;
      if (it.page === 'subscriptions') return file === 'subscriptions.html';
      if (it.page === 'admin') return file === 'ops.html' || file === 'admin.html';
      return false;
    };
    nav.innerHTML = items.map((it) =>
      '<a href="' + it.href + '" class="sidebar-link' + (isActive(it) ? ' active' : '') + '" data-page="' + it.page + '">'
      + it.icon + '<span data-t="' + it.t + '">' + escapeHtml(tr(it.t)) + '</span></a>').join('');
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
    buildSidebarNav(user);
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
      +    '<a href="https://x.com/CHMBreaker" target="_blank" rel="noopener" aria-label="X (Twitter) — @CHMBreaker" title="X · @CHMBreaker"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2h3.4l-7.4 8.5L23.7 22h-6.8l-5.3-7L5.5 22H2l7.9-9L1.4 2h7l4.8 6.4L18.9 2zm-1.2 17.9h1.9L6.3 4H4.3l13.4 15.9z"/></svg></a>'
      +  '</div>'
      + '</div>'
      // Mobile-app section intentionally removed — the apps aren't yet
      // published and the placeholder badges felt like noise. Add back
      // once App Store / Google Play links are real.
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
      pro:     { label: 'Pro',     bg: 'rgba(255,140,90,.18)',  fg: '#FF8C5A', ring: 'rgba(255,140,90,.35)',  dot: '#FF5A1F' },
    };
    const planId = (window.PlanGate && PlanGate.normalizePlan) ? PlanGate.normalizePlan(plan) : plan;
    const meta = PLAN_META[planId] || PLAN_META.free;
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
    const PLAN_ORDER = ['free', 'pro'];
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
        bar('API-ключи бирж', ICON.key, data.usage.keys.used, data.usage.keys.limit) +
      '</div>' +
      nextHtml
    );
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
      +     '<a class="topbar-search-link" href="/app/">' + NAV_ICON.app + 'Приложение</a>'
      +     '<a class="topbar-search-link" href="settings.html">' + NAV_ICON.account + 'Аккаунт</a>'
      +     '<a class="topbar-search-link" href="subscriptions.html">' + NAV_ICON.plan + 'Тариф</a>'
      +     '<a class="topbar-search-link" href="settings.html#support">' + NAV_ICON.support + 'Поддержка</a>'
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
          if (!a.querySelector('.lock')) {
            const ic = (window.PlanGate && PlanGate.LOCK_SVG_SM) || '';
            a.insertAdjacentHTML('beforeend', '<span class="lock">' + ic + ' Pro</span>');
          }
        }
      });
    };
    if (window.PlanGate && PlanGate.init) PlanGate.init().then(decorate);
    else decorate();
  }

  // Sidebar lock chip removed — the page itself shows the upgrade hero,
  // which is the source of truth. Doubling it in the menu felt visually
  // noisy. Function kept as no-op so boot() doesn't have to change.
  function wireSidebarPlanLocks() { /* intentionally empty */ }

  function boot() {
    applyTheme(); // apply <html class="light"> first so no flash
    wireLogo();
    wireTopbar();      // creates #shellLang + #shellTheme
    applyTheme();      // now safely sets the theme-btn icon
    applyLang();       // translates all data-t + refreshes lang button
    wireSearchPopup();

    // Inject chrome SYNCHRONOUSLY with pessimistic defaults ('free', no
    // user). This paints the full sidebar/topbar immediately instead of
    // waiting on /auth/me (which added ~200ms of "old UI" flash).
    //   After DOM is populated we flip data-chrome-ready=1 which the
    //   CSS uses to fade in the sidebar/topbar-actions as one piece,
    //   killing any visible reshuffle.
    applyChrome('free', null);
    document.documentElement.setAttribute('data-chrome-ready', '1');

    // Async refinement: pulls real plan + user (adds the Admin nav entry
    // for admins).
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
