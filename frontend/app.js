/**
 * CHM Finance — frontend application core.
 *
 * Exports (global):
 *   Auth    — token storage + refresh rotation
 *   API     — fetch-based client (auto-refresh on 401)
 *   Toast   — transient notifications
 *   WS      — WebSocket client (auto-reconnect, auth, subscriptions)
 *   Fmt     — formatting helpers (currency, percent, time)
 *   I18n    — translations (RU/EN)
 */

(() => {

const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api' : '/api';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// ── Auth — token storage + refresh rotation ────────────────────────────
const Auth = {
  get accessToken() { try { return localStorage.getItem('chm_access'); } catch { return null; } },
  get refreshToken() { try { return localStorage.getItem('chm_refresh'); } catch { return null; } },
  setTokens({ accessToken, refreshToken }) {
    try {
      if (accessToken) localStorage.setItem('chm_access', accessToken);
      if (refreshToken) localStorage.setItem('chm_refresh', refreshToken);
    } catch (_e) {}
  },
  clear() {
    try {
      localStorage.removeItem('chm_access');
      localStorage.removeItem('chm_refresh');
      localStorage.removeItem('chm_user');
    } catch (_e) {}
  },
  isLoggedIn() {
    const t = this.accessToken;
    if (!t) return false;
    try {
      const payload = JSON.parse(atob(t.split('.')[1]));
      return payload.exp * 1000 > Date.now();
    } catch { return false; }
  },
  logout() {
    this.clear();
    location.href = '/';
  },
  get user() {
    try { return JSON.parse(localStorage.getItem('chm_user') || 'null'); }
    catch { return null; }
  },
  setUser(u) {
    try { localStorage.setItem('chm_user', JSON.stringify(u)); } catch (_e) {}
  },
  requireAuth() {
    if (!this.isLoggedIn()) {
      location.href = '/?login=1';
      return false;
    }
    return true;
  },
};

// ── API client — fetch with auto-retry on 401 after refresh ────────────
async function apiRequest(method, path, body, { retried = false, skipAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!skipAuth && Auth.accessToken) headers['Authorization'] = 'Bearer ' + Auth.accessToken;
  const opts = { method, headers };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

  let res;
  try { res = await fetch(API_BASE + path, opts); }
  catch (netErr) {
    throw Object.assign(new Error('Network error: ' + netErr.message), { code: 'NETWORK' });
  }

  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};

  if (res.status === 401 && !skipAuth && !retried && Auth.refreshToken) {
    const ok = await tryRefresh();
    if (ok) return apiRequest(method, path, body, { retried: true });
    Auth.clear();
    const err = new Error('Session expired');
    err.status = 401; err.code = 'UNAUTHORIZED';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data.error || data.message || ('HTTP ' + res.status));
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

async function tryRefresh() {
  try {
    const res = await fetch(API_BASE + '/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: Auth.refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    Auth.setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    if (data.user) Auth.setUser(data.user);
    return true;
  } catch { return false; }
}

const API = {
  // Auth
  register: (email, password, referralCode) =>
    apiRequest('POST', '/auth/register', { email, password, referralCode }, { skipAuth: true })
      .then(saveAuthResp),
  login: (email, password) =>
    apiRequest('POST', '/auth/login', { email, password }, { skipAuth: true }).then(saveAuthResp),
  logout: () => apiRequest('POST', '/auth/logout', { refreshToken: Auth.refreshToken }).catch(() => {})
    .then(() => { Auth.clear(); return true; }),
  me: () => apiRequest('GET', '/auth/me'),

  // Exchanges
  listExchanges: () => apiRequest('GET', '/exchanges', null, { skipAuth: true }),
  listSymbols: (exchange) => apiRequest('GET', '/exchanges/' + exchange + '/symbols', null, { skipAuth: true }),
  ticker: (exchange, symbol) => apiRequest('GET', '/exchanges/' + exchange + '/ticker/' + encodeURIComponent(symbol), null, { skipAuth: true }),
  candles: (exchange, symbol, tf = '1h', limit = 500) =>
    apiRequest('GET', '/exchanges/' + exchange + '/candles/' + encodeURIComponent(symbol) + '?timeframe=' + tf + '&limit=' + limit, null, { skipAuth: true }),
  listKeys: () => apiRequest('GET', '/exchanges/keys'),
  addKey: (payload) => apiRequest('POST', '/exchanges/keys', payload),
  verifyKey: (id) => apiRequest('POST', '/exchanges/keys/' + id + '/verify'),
  deleteKey: (id) => apiRequest('DELETE', '/exchanges/keys/' + id),
  getBalance: (id) => apiRequest('GET', '/exchanges/keys/' + id + '/balance'),

  // Bots
  listBots: () => apiRequest('GET', '/bots'),
  botSummary: () => apiRequest('GET', '/bots/summary'),
  createBot: (payload) => apiRequest('POST', '/bots', payload),
  getBot: (id) => apiRequest('GET', '/bots/' + id),
  updateBot: (id, patch) => apiRequest('PATCH', '/bots/' + id, patch),
  toggleBot: (id) => apiRequest('POST', '/bots/' + id + '/toggle'),
  deleteBot: (id) => apiRequest('DELETE', '/bots/' + id),
  botTrades: (id, opts = {}) => apiRequest('GET', '/bots/' + id + '/trades?' + qs(opts)),
  botStats: (id) => apiRequest('GET', '/bots/' + id + '/stats'),

  // Signals
  listSignals: (opts = {}) => apiRequest('GET', '/signals?' + qs(opts)),
  publicSignals: (opts = {}) => apiRequest('GET', '/signals/public?' + qs(opts), null, { skipAuth: true }),
  getSignal: (id) => apiRequest('GET', '/signals/' + id),
  mySignalStats: () => apiRequest('GET', '/signals/stats/me'),
  globalSignalStats: () => apiRequest('GET', '/signals/stats/global', null, { skipAuth: true }),
  getPrefs: () => apiRequest('GET', '/signals/prefs/me'),
  updatePrefs: (patch) => apiRequest('PATCH', '/signals/prefs/me', patch),

  // Backtests
  listBacktests: (opts = {}) => apiRequest('GET', '/backtests?' + qs(opts)),
  createBacktest: (payload) => apiRequest('POST', '/backtests', payload),
  getBacktest: (id) => apiRequest('GET', '/backtests/' + id),
  getBacktestTrades: (id, opts = {}) => apiRequest('GET', '/backtests/' + id + '/trades?' + qs(opts)),
  deleteBacktest: (id) => apiRequest('DELETE', '/backtests/' + id),
  backtestStats: () => apiRequest('GET', '/backtests/stats'),

  // Subscriptions / promo
  listPlans: () => apiRequest('GET', '/subscriptions/plans', null, { skipAuth: true }),
  mySubscription: () => apiRequest('GET', '/subscriptions/status'),
  redeemPromo: (code) => apiRequest('POST', '/subscriptions/promo', { code }),

  // Optimizations
  listOptimizations: () => apiRequest('GET', '/optimizations'),
  createOptimization: (payload) => apiRequest('POST', '/optimizations', payload),
  getOptimization: (id) => apiRequest('GET', '/optimizations/' + id),

  // Payments / referrals
  listPayments: (opts = {}) => apiRequest('GET', '/payments?' + qs(opts)),
  createCryptoPayment: (payload) => apiRequest('POST', '/payments/crypto/create', payload),
  stripeCheckout: (payload) => apiRequest('POST', '/payments/stripe/checkout', payload),
  refSummary: () => apiRequest('GET', '/payments/ref/summary'),
  refRewards: (opts = {}) => apiRequest('GET', '/payments/ref/rewards?' + qs(opts)),
};

function saveAuthResp(data) {
  if (data.accessToken) Auth.setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
  if (data.user) Auth.setUser(data.user);
  return data;
}
function qs(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

// ── Toast notifications ────────────────────────────────────────────────
const Toast = {
  _container: null,
  _ensure() {
    if (this._container) return this._container;
    const el = document.createElement('div');
    el.id = 'toast-container';
    el.style.cssText = 'position:fixed;top:80px;right:24px;z-index:200;display:flex;flex-direction:column;gap:10px;pointer-events:none';
    document.body.appendChild(el);
    return this._container = el;
  },
  _show(kind, msg, ttl = 4000) {
    const host = this._ensure();
    const el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.textContent = msg;
    el.style.cssText = [
      'pointer-events:auto',
      'min-width:260px;max-width:420px',
      'padding:14px 18px;border-radius:12px',
      'font-family:Inter,sans-serif;font-weight:500;font-size:13px',
      'background:rgba(10,10,10,.88);color:#fff',
      'backdrop-filter:blur(18px);box-shadow:0 20px 40px -12px rgba(0,0,0,.6),inset 0 1px 1px rgba(255,255,255,.08)',
      'border:1px solid ' + (kind === 'error' ? 'rgba(130,98,98,.45)' : kind === 'success' ? 'rgba(102,135,110,.45)' : 'rgba(92,128,227,.35)'),
      'animation:toastIn .3s cubic-bezier(.16,1,.3,1)',
    ].join(';');
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(120%)'; el.style.transition = 'all .3s ease'; }, ttl - 300);
    setTimeout(() => { try { host.removeChild(el); } catch (_e) {} }, ttl);
  },
  success(m) { this._show('success', m); },
  error(m)   { this._show('error',   m, 6000); },
  info(m)    { this._show('info',    m); },
  warn(m)    { this._show('warning', m, 5000); },
};

// ── WebSocket client (auto-auth, reconnect, subscriptions) ─────────────
const WS = {
  _ws: null,
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _listeners: new Map(), // type → Set<fn>
  _connectedResolvers: [],
  connect() {
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return;
    try {
      this._ws = new WebSocket(WS_URL);
    } catch (err) { this._scheduleReconnect(); return; }
    this._ws.addEventListener('open', () => {
      this._reconnectAttempts = 0;
      if (Auth.accessToken) this._send({ type: 'auth', token: 'Bearer ' + Auth.accessToken });
      this._connectedResolvers.forEach((r) => r(true));
      this._connectedResolvers = [];
    });
    this._ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this._dispatch(msg.type, msg);
      } catch (_e) { /* */ }
    });
    this._ws.addEventListener('close', () => { this._scheduleReconnect(); });
    this._ws.addEventListener('error', () => { /* close handler will schedule */ });
  },
  _send(payload) {
    try { this._ws.send(JSON.stringify(payload)); } catch (_e) {}
  },
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const backoff = Math.min(30_000, 1000 * Math.pow(2, this._reconnectAttempts++));
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, backoff);
  },
  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type).delete(fn);
  },
  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  },
  _dispatch(type, msg) {
    const set = this._listeners.get(type);
    if (set) for (const fn of set) { try { fn(msg); } catch (_e) {} }
    const allSet = this._listeners.get('*');
    if (allSet) for (const fn of allSet) { try { fn(msg); } catch (_e) {} }
  },
};

// ── Formatting helpers ─────────────────────────────────────────────────
const Fmt = {
  currency(n, { decimals = 2, symbol = '$' } = {}) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return symbol + '—';
    const v = Number(n);
    const abs = Math.abs(v);
    const fixed = v.toFixed(decimals);
    const parts = fixed.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-' : '') + symbol + parts.join('.');
  },
  percent(n, { decimals = 2, sign = false } = {}) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    const signStr = sign && v > 0 ? '+' : '';
    return signStr + v.toFixed(decimals) + '%';
  },
  number(n, { decimals = 2 } = {}) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(decimals);
  },
  timeAgo(ts) {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
    return Math.floor(ms / 86_400_000) + 'd ago';
  },
  date(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
  price(n, decimals) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (decimals === undefined) {
      decimals = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
    }
    return v.toFixed(decimals);
  },
};

// ── i18n stub (used by index.html for landing page; dashboard uses static RU) ──
const I18n = {
  setLang(lang) {
    try { localStorage.setItem('chm_lang', lang); } catch (_e) {}
  },
  lang() {
    try { return localStorage.getItem('chm_lang') || 'ru'; } catch { return 'ru'; }
  },
};

// Expose globals
window.Auth = Auth;
window.API = API;
window.Toast = Toast;
window.WS = WS;
window.Fmt = Fmt;
window.I18n = I18n;

// Auto-connect WS on auth'd pages
if (Auth.isLoggedIn()) {
  WS.connect();
}

// Inject toast-in keyframes once
if (!document.getElementById('chm-toast-keyframes')) {
  const s = document.createElement('style');
  s.id = 'chm-toast-keyframes';
  s.textContent = '@keyframes toastIn { from { opacity:0; transform:translateX(120%);} to { opacity:1; transform:translateX(0);} }';
  document.head.appendChild(s);
}

})();
