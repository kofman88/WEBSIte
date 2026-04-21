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
  async function wirePlanBadge() {
    const badge = document.querySelector('.sidebar-sub-badge');
    if (!badge) return;
    // Remove any hardcoded "Pro Plan" text leaving only the star icon; we'll
    // append a new text node with the real plan.
    const svg = badge.querySelector('svg');
    badge.innerHTML = '';
    if (svg) badge.appendChild(svg);
    const text = document.createElement('span');
    text.textContent = '…';
    text.style.marginLeft = '8px';
    badge.appendChild(text);
    try {
      const r = await (window.API && API.me ? API.me() : null);
      const u = r && (r.user || r);
      const plan = (u && u.subscription && u.subscription.plan) || 'free';
      const meta = PLAN_LABEL[plan] || PLAN_LABEL.free;
      text.textContent = meta.label + ' Plan';
      badge.classList.add(meta.class);
      // Update avatar + username in topbar
      if (u) {
        const av = document.querySelector('.topbar-avatar');
        if (av && u.email) av.textContent = u.email[0].toUpperCase();
        const un = document.querySelector('.topbar-username');
        if (un && u.email) un.textContent = u.email.split('@')[0];
      }
    } catch (_e) { text.textContent = 'Free Plan'; }
  }

  // ── 3 & 4. Topbar toggles ──────────────────────────────────────────────
  function wireTopbar() {
    const actions = document.querySelector('.topbar-actions');
    if (!actions) return;
    if (document.getElementById('shellLang')) return; // already wired

    const btnStyle = 'background:none;border:1px solid rgba(255,255,255,.08);border-radius:9999px;padding:6px 12px;color:rgba(255,255,255,.75);cursor:pointer;font-size:12px;display:inline-flex;align-items:center;gap:6px;transition:all .15s';

    const lang = document.createElement('button');
    lang.id = 'shellLang';
    lang.type = 'button';
    lang.title = 'Language';
    lang.style.cssText = btnStyle;
    lang.textContent = LANG_LABEL[_nextLang(getLang())];
    lang.addEventListener('click', () => { setLang(_nextLang(getLang())); applyLang(); });

    const theme = document.createElement('button');
    theme.id = 'shellTheme';
    theme.type = 'button';
    theme.title = 'Theme';
    theme.style.cssText = btnStyle;
    theme.addEventListener('click', () => { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); applyTheme(); });

    // Place before notification/avatar
    actions.insertBefore(theme, actions.firstChild);
    actions.insertBefore(lang,  actions.firstChild);
  }

  // ── Market tickers + Fear & Greed (topbar, public data) ───────────────
  async function wireMarketTickers() {
    const top = document.querySelector('.topbar > div:first-child') || document.querySelector('.topbar');
    if (!top || !window.API || !API.marketContext) return;
    if (document.getElementById('shellMarket')) return;
    const wrap = document.createElement('div');
    wrap.id = 'shellMarket';
    wrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin-left:16px;font-size:12px;flex-wrap:wrap';
    wrap.innerHTML = `
      <span id="tickBtc"  class="flex items-center gap-1.5 text-slate-400">BTC <span class="mono">—</span></span>
      <span id="tickEth"  class="flex items-center gap-1.5 text-slate-400">ETH <span class="mono">—</span></span>
      <span id="fngBadge" class="flex items-center gap-1.5 text-slate-500 border-l border-slate-700 pl-3 ml-1" title="Crypto Fear & Greed">F&amp;G: <span class="mono">—</span></span>
    `;
    top.appendChild(wrap);
    const refresh = async () => {
      try {
        const r = await API.marketContext();
        if (r && r.tickers) {
          const fmt = (t) => {
            if (!t) return '—';
            const col = t.change24h > 0 ? '#4ade80' : t.change24h < 0 ? '#f87171' : '#94a3b8';
            const arrow = t.change24h > 0 ? '▲' : t.change24h < 0 ? '▼' : '–';
            return `<span class="mono" style="color:${col}">$${Math.round(t.price).toLocaleString()} ${arrow}${Math.abs(t.change24h).toFixed(1)}%</span>`;
          };
          const btcEl = document.getElementById('tickBtc');
          const ethEl = document.getElementById('tickEth');
          if (btcEl) btcEl.innerHTML = 'BTC ' + fmt(r.tickers.btc);
          if (ethEl) ethEl.innerHTML = 'ETH ' + fmt(r.tickers.eth);
        }
        if (r && r.fearGreed) {
          const fng = r.fearGreed;
          const v = Number(fng.value);
          const col = v < 25 ? '#f87171' : v < 45 ? '#f59e0b' : v < 55 ? '#94a3b8' : v < 75 ? '#4ade80' : '#10b981';
          const el = document.getElementById('fngBadge');
          if (el) el.innerHTML = 'F&G: <span class="mono" style="color:' + col + '">' + v + ' · ' + (fng.classification || '').slice(0, 10) + '</span>';
        }
      } catch (_e) {}
    };
    refresh();
    setInterval(refresh, 60_000);
  }

  function boot() {
    applyTheme(); // before anything paints so no flash
    wireLogo();
    wireTopbar();
    wireMarketTickers();
    applyLang();
    wirePlanBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
