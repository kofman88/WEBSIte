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
// Impersonation mode: if the URL has #imp=<token>, we're a fresh tab opened
// by an admin via ops. Store the token in sessionStorage only (this tab),
// strip the hash, show a warning banner, and make Auth.accessToken prefer
// sessionStorage over localStorage for this tab. Admin's own localStorage
// session stays untouched in other tabs.
(function bootImpersonation() {
  try {
    const m = /[#&]imp=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    const token = decodeURIComponent(m[1]);
    const em = /[#&]email=([^&]+)/.exec(location.hash || '');
    const email = em ? decodeURIComponent(em[1]) : '';
    sessionStorage.setItem('chm_imp_access', token);
    if (email) sessionStorage.setItem('chm_imp_email', email);
    history.replaceState({}, '', location.pathname + location.search);
    // Inject a persistent banner. Fires as early as possible so the UI
    // never renders without the warning.
    document.addEventListener('DOMContentLoaded', () => {
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(90deg,#7f1d1d,#991b1b,#7f1d1d);color:#fee2e2;padding:8px 16px;font-size:12px;font-weight:600;text-align:center;letter-spacing:.05em;text-transform:uppercase;box-shadow:0 2px 12px rgba(0,0,0,.4)';
      bar.textContent = '⚠️ IMPERSONATING ' + (email || 'user') + ' · end in 30m · all actions are audited';
      document.body.prepend(bar);
      document.body.style.paddingTop = '32px';
    });
  } catch (_e) {}
})();

const Auth = {
  // "Remember me" picks the storage: localStorage (default, persists across
  // browser restarts) vs sessionStorage (clears when the tab closes).
  _store() {
    try {
      if (sessionStorage.getItem('chm_session_only') === '1') return sessionStorage;
    } catch (_e) {}
    return localStorage;
  },
  setRemember(persist) {
    try {
      if (persist) sessionStorage.removeItem('chm_session_only');
      else sessionStorage.setItem('chm_session_only', '1');
    } catch (_e) {}
  },
  get accessToken() {
    try {
      return sessionStorage.getItem('chm_imp_access')
        || localStorage.getItem('chm_access')
        || sessionStorage.getItem('chm_access');
    } catch { return null; }
  },
  get refreshToken() {
    // Impersonation tokens don't get a refresh — once they expire (30m)
    // the tab just falls out of auth, which is what we want.
    if (sessionStorage.getItem('chm_imp_access')) return null;
    try { return localStorage.getItem('chm_refresh') || sessionStorage.getItem('chm_refresh'); }
    catch { return null; }
  },
  get isImpersonating() {
    try { return Boolean(sessionStorage.getItem('chm_imp_access')); } catch { return false; }
  },
  setTokens({ accessToken, refreshToken }) {
    const store = this._store();
    const other = store === localStorage ? sessionStorage : localStorage;
    try {
      other.removeItem('chm_access');
      other.removeItem('chm_refresh');
    } catch (_e) {}
    try {
      if (accessToken) store.setItem('chm_access', accessToken);
      if (refreshToken) store.setItem('chm_refresh', refreshToken);
    } catch (_e) {}
  },
  clear() {
    try {
      localStorage.removeItem('chm_access');
      localStorage.removeItem('chm_refresh');
      localStorage.removeItem('chm_user');
      sessionStorage.removeItem('chm_access');
      sessionStorage.removeItem('chm_refresh');
      sessionStorage.removeItem('chm_session_only');
      sessionStorage.removeItem('chm_user');
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
    try {
      const raw = localStorage.getItem('chm_user') || sessionStorage.getItem('chm_user');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  setUser(u) {
    const store = this._store();
    const other = store === localStorage ? sessionStorage : localStorage;
    try { other.removeItem('chm_user'); } catch (_e) {}
    try { store.setItem('chm_user', JSON.stringify(u)); } catch (_e) {}
  },
  requireAuth() {
    if (!this.isLoggedIn()) {
      location.href = '/?login=1';
      return false;
    }
    // Email verification gate — block dashboard until confirmed. BUT the
    // emailVerified flag in localStorage can go stale (user confirms via
    // email link in another tab → DB is updated, cache here isn't).
    // Fix: optimistically allow the page to render, then verify with the
    // server in the background; redirect only if the server ALSO says
    // unverified. Admin / impersonated sessions bypass entirely.
    const u = this.user;
    if (u && u.emailVerified === false && !this.isImpersonating) {
      this.refreshUserAndMaybeRedirect();
      return true; // optimistic — page renders while we check the server
    }
    return true;
  },
  // Background refresh — pulls fresh /auth/me, patches localStorage, and
  // redirects to /?verify_email=1 only if the server ALSO confirms the
  // email is not verified. Prevents stale-cache redirect loops.
  refreshUserAndMaybeRedirect() {
    if (this._refreshingUser) return; this._refreshingUser = true;
    const tok = this.accessToken;
    if (!tok) { this._refreshingUser = false; return; }
    fetch(API_BASE + '/auth/me', { headers: { Authorization: 'Bearer ' + tok } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const fresh = data && (data.user || data);
        if (!fresh) return;
        this.setUser(fresh);
        if (fresh.emailVerified === false && !this.isImpersonating) {
          location.href = '/?verify_email=1';
        }
      })
      .catch(() => { /* network hiccup — don't log out, try again next page */ })
      .finally(() => { this._refreshingUser = false; });
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
    // Hard gate — if backend says email not verified, kick user to the
    // verification modal on the homepage instead of letting the error
    // bubble as a generic 403 toast.
    if (res.status === 403 && data && data.code === 'EMAIL_NOT_VERIFIED') {
      if (location.pathname !== '/' && location.pathname !== '/index.html') {
        location.href = '/?verify_email=1';
      }
    }
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
  botEquity: (id) => apiRequest('GET', '/bots/' + id + '/equity'),
  quickBacktest: (cfg) => apiRequest('POST', '/bots/quick-backtest', cfg),
  getBacktest: (id) => apiRequest('GET', '/backtests/' + id),

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

  // Security / account
  requestEmailVerify: () => apiRequest('POST', '/auth/verify-email/request'),
  confirmEmailVerify: (token) => apiRequest('POST', '/auth/verify-email/confirm', { token }, { skipAuth: true }),
  requestPasswordReset: (email) => apiRequest('POST', '/auth/password-reset/request', { email }, { skipAuth: true }),
  confirmPasswordReset: (token, newPassword) => apiRequest('POST', '/auth/password-reset/confirm', { token, newPassword }, { skipAuth: true }),
  twoFAStatus: () => apiRequest('GET', '/auth/2fa/status'),
  twoFASetup: () => apiRequest('POST', '/auth/2fa/setup'),
  twoFAConfirm: (code) => apiRequest('POST', '/auth/2fa/confirm', { code }),
  twoFADisable: (password) => apiRequest('POST', '/auth/2fa/disable', { password }),
  twoFAVerifyLogin: (pendingToken, code) => apiRequest('POST', '/auth/2fa/verify-login', { pendingToken, code }, { skipAuth: true }),
  listSessions: () => apiRequest('GET', '/auth/sessions'),
  revokeSession: (id) => apiRequest('DELETE', '/auth/sessions/' + id),
  loginHistory: (limit = 20) => apiRequest('GET', '/auth/login-history?limit=' + limit),

  // Notifications
  listNotifications: (opts = {}) => apiRequest('GET', '/notifications?' + qs(opts)),
  unreadNotifications: () => apiRequest('GET', '/notifications/unread-count'),
  markNotificationRead: (id) => apiRequest('POST', '/notifications/' + id + '/read'),
  markAllNotificationsRead: () => apiRequest('POST', '/notifications/read-all'),
  removeNotification: (id) => apiRequest('DELETE', '/notifications/' + id),

  // Analytics / portfolio / trade journal
  portfolio: (fresh = false) => apiRequest('GET', '/analytics/portfolio' + (fresh ? '?fresh=1' : '')),
  analyticsSummary: (opts = {}) => apiRequest('GET', '/analytics/summary?' + qs(opts)),
  analyticsBySymbol: (opts = {}) => apiRequest('GET', '/analytics/by-symbol?' + qs(opts)),
  analyticsByStrategy: (opts = {}) => apiRequest('GET', '/analytics/by-strategy?' + qs(opts)),
  analyticsByMonth: (opts = {}) => apiRequest('GET', '/analytics/by-month?' + qs(opts)),
  equityCurve: (days = 90) => apiRequest('GET', '/analytics/equity-curve?days=' + days),
  listTrades: (opts = {}) => apiRequest('GET', '/analytics/trades?' + qs(opts)),
  setTradeNote: (id, note) => apiRequest('PATCH', '/analytics/trades/' + id + '/note', { note }),
  // Manual (Smart) Trade + TV webhook management
  manualTrade: (payload) => apiRequest('POST', '/bots/manual-trade', payload),
  getTvWebhook: (botId) => apiRequest('GET', '/bots/' + botId + '/tv-webhook'),
  rotateTvWebhook: (botId) => apiRequest('POST', '/bots/' + botId + '/tv-webhook/rotate'),
  // Risk Manager
  getRiskLimits: () => apiRequest('GET', '/risk/limits'),
  setRiskLimits: (patch) => apiRequest('PATCH', '/risk/limits', patch),
  // Copy Trading
  copyListFollowing: () => apiRequest('GET', '/copy/following'),
  copySubscribe: (payload) => apiRequest('POST', '/copy/subscribe', payload),
  copyUnsubscribe: (leaderId) => apiRequest('POST', '/copy/unsubscribe', { leaderId }),

  // Community / public
  leaderboard: (opts = {}) => apiRequest('GET', '/public/leaderboard?' + qs(opts), null, { skipAuth: true }),
  publicProfile: (code) => apiRequest('GET', '/public/u/' + code, null, { skipAuth: true }),
  setPublicProfile: (enabled) => apiRequest('PUT', '/support/profile/public', { enabled }),
  setPaperBalance: (amount) => apiRequest('PUT', '/support/profile/paper-balance', { amount }),

  // Copy trading
  copySubscribe: (leaderCode, opts = {}) => apiRequest('POST', '/copy/subscribe', { leaderCode, ...opts }),
  copyUnsubscribe: (leaderId) => apiRequest('POST', '/copy/unsubscribe', { leaderId }),
  copyListFollowing: () => apiRequest('GET', '/copy/following'),

  // Strategy marketplace
  marketList: (opts = {}) => apiRequest('GET', '/strategies?' + qs(opts), null, { skipAuth: true }),
  marketGet: (slug) => apiRequest('GET', '/strategies/' + encodeURIComponent(slug), null, { skipAuth: true }),
  marketPublish: (body) => apiRequest('POST', '/strategies', body),
  marketInstall: (slug, body = {}) => apiRequest('POST', '/strategies/' + encodeURIComponent(slug) + '/install', body),
  marketRate: (slug, stars) => apiRequest('POST', '/strategies/' + encodeURIComponent(slug) + '/rate', { stars }),
  marketUnpublish: (slug) => apiRequest('DELETE', '/strategies/' + encodeURIComponent(slug)),

  // Dashboard v2 — advanced analytics
  dashboardV2:        () => apiRequest('GET', '/analytics/dashboard-v2'),
  openPositions:      () => apiRequest('GET', '/analytics/open-positions'),
  calendarPnl:        (days = 180) => apiRequest('GET', '/analytics/calendar-pnl?days=' + days),
  hourlyPnl:          (days = 90) => apiRequest('GET', '/analytics/hourly-pnl?days=' + days),
  botLeaderboard:     (days = 30) => apiRequest('GET', '/analytics/bot-leaderboard?days=' + days),
  btcBenchmark:       (days = 90) => apiRequest('GET', '/analytics/btc-benchmark?days=' + days),
  myPercentile:       (period = '30d') => apiRequest('GET', '/analytics/percentile?period=' + period),
  marketContext:      () => apiRequest('GET', '/public/market-context', null, { skipAuth: true }),
  analyticsByStrategy:() => apiRequest('GET', '/analytics/by-strategy'),
  analyticsBySymbol:  () => apiRequest('GET', '/analytics/by-symbol'),
  toggleBot:          (id) => apiRequest('POST', '/bots/' + id + '/toggle'),

  // Bot wizard — strategy schemas + inline backtest preview
  strategySchemas:    () => apiRequest('GET', '/bots/strategy-schemas'),
  strategySchema:     (key) => apiRequest('GET', '/bots/strategy-schema/' + encodeURIComponent(key)),
  quickBacktest:      (body) => apiRequest('POST', '/bots/quick-backtest', body),
  getBacktest:        (id) => apiRequest('GET', '/backtests/' + id),

  // Support tickets
  listTickets: (opts = {}) => apiRequest('GET', '/support/tickets?' + qs(opts)),
  createTicket: (subject, body) => apiRequest('POST', '/support/tickets', { subject, body }),
  getTicket: (id) => apiRequest('GET', '/support/tickets/' + id),
  replyTicket: (id, body) => apiRequest('POST', '/support/tickets/' + id + '/reply', { body }),
  closeTicket: (id) => apiRequest('POST', '/support/tickets/' + id + '/close'),
  listAllTickets: (opts = {}) => apiRequest('GET', '/support/admin/tickets?' + qs(opts)),
  adminTicketGet: (id) => apiRequest('GET', '/support/admin/tickets/' + id),
  // adminTicketReply accepts either a plain string (legacy) or an object
  // with { body, isInternal, attachments } for Phase B features.
  adminTicketReply: (id, payload) =>
    apiRequest('POST', '/support/admin/tickets/' + id + '/reply',
      typeof payload === 'string' ? { body: payload } : payload),
  adminTicketMarkRead: (id) => apiRequest('POST', '/support/admin/tickets/' + id + '/mark-read', {}),
  adminTicketClose: (id) => apiRequest('POST', '/support/tickets/' + id + '/close', {}),
  adminTicketAssign: (id, targetAdminId) => apiRequest('POST', '/support/admin/tickets/' + id + '/assign', targetAdminId ? { targetAdminId } : {}),
  adminTicketUnassign: (id) => apiRequest('POST', '/support/admin/tickets/' + id + '/unassign', {}),
  adminTemplatesList: () => apiRequest('GET', '/support/admin/templates'),
  adminTemplateCreate: (payload) => apiRequest('POST', '/support/admin/templates', payload),
  adminTemplateUpdate: (id, patch) => apiRequest('PATCH', '/support/admin/templates/' + id, patch),
  adminTemplateRemove: (id) => apiRequest('DELETE', '/support/admin/templates/' + id),
  adminTemplateUse: (id) => apiRequest('POST', '/support/admin/templates/' + id + '/use', {}),
  planUsage: () => apiRequest('GET', '/subscriptions/usage'),
  listPlans: () => apiRequest('GET', '/subscriptions/plans'),
  adminPresencePing: () => apiRequest('POST', '/support/admin/presence/ping', {}),
  adminPresenceOnline: () => apiRequest('GET', '/support/admin/presence/online'),
  // User-side support helpers
  supportMarkRead: (id) => apiRequest('POST', '/support/tickets/' + id + '/mark-read', {}),
  supportReply: (id, payload) =>
    apiRequest('POST', '/support/tickets/' + id + '/reply',
      typeof payload === 'string' ? { body: payload } : payload),

  // Ops / back-office ------------------------------------------------------
  opsDashboard: () => apiRequest('GET', '/admin/dashboard'),
  adminListUsers: (opts = {}) => apiRequest('GET', '/admin/users?' + qs(opts)),
  adminUserDetail: (id) => apiRequest('GET', '/admin/users/' + id + '/detail'),
  adminSetUserActive: (id, isActive) => apiRequest('PATCH', '/admin/users/' + id + '/active', { isActive }),
  adminSetUserPlan: (id, plan, durationDays = 30) => apiRequest('PATCH', '/admin/users/' + id + '/plan', { plan, durationDays }),
  adminSetUserAdmin: (id, isAdmin) => apiRequest('PATCH', '/admin/users/' + id + '/admin', { isAdmin }),
  adminNotifyUser: (id, payload) => apiRequest('POST', '/admin/users/' + id + '/notify', payload),
  adminListBots: (opts = {}) => apiRequest('GET', '/admin/bots?' + qs(opts)),
  adminListTrades: (opts = {}) => apiRequest('GET', '/admin/trades?' + qs(opts)),
  adminListSignals: (opts = {}) => apiRequest('GET', '/admin/signals?' + qs(opts)),
  adminSystem: () => apiRequest('GET', '/admin/system'),
  adminListPayments: (opts = {}) => apiRequest('GET', '/admin/payments?' + qs(opts)),
  adminConfirmPayment: (id, note) => apiRequest('POST', '/admin/payments/' + id + '/confirm', { note }),
  adminRefundPayment: (id, reason) => apiRequest('POST', '/admin/payments/' + id + '/refund', { reason }),
  adminListPromoCodes: () => apiRequest('GET', '/admin/promo-codes'),
  adminCreatePromoCode: (body) => apiRequest('POST', '/admin/promo-codes', body),
  adminTogglePromoCode: (id, isActive) => apiRequest('PATCH', '/admin/promo-codes/' + id + '/active', { isActive }),
  adminDeletePromoCode: (id) => apiRequest('DELETE', '/admin/promo-codes/' + id),
  adminListRewards: (opts = {}) => apiRequest('GET', '/admin/ref-rewards?' + qs(opts)),
  adminPayReward: (id) => apiRequest('POST', '/admin/ref-rewards/' + id + '/pay'),
  adminCancelReward: (id, reason) => apiRequest('POST', '/admin/ref-rewards/' + id + '/cancel', { reason }),
  adminAuditLog: (opts = {}) => apiRequest('GET', '/admin/audit?' + qs(opts)),
  adminListFlags: () => apiRequest('GET', '/admin/flags'),
  adminSetFlag: (key, value) => apiRequest('PATCH', '/admin/flags/' + encodeURIComponent(key), { value }),
  adminRevenueSeries: (days = 30) => apiRequest('GET', '/admin/revenue-timeseries?days=' + days),
  adminBillingAnalytics: () => apiRequest('GET', '/admin/billing-analytics'),
  adminAuditAnalytics: (days = 14) => apiRequest('GET', '/admin/audit-analytics?days=' + days),
  adminImpersonate: (id, reason) => apiRequest('POST', '/admin/users/' + id + '/impersonate', { reason }),
  adminMarketplace: (opts = {}) => apiRequest('GET', '/admin/marketplace?' + qs(opts)),
  adminSetStrategyPublic: (id, isPublic) => apiRequest('PATCH', '/admin/marketplace/' + id + '/public', { isPublic }),
  adminCopyList: (opts = {}) => apiRequest('GET', '/admin/copy?' + qs(opts)),
  adminCopyDisable: (leaderId, followerId) => apiRequest('POST', '/admin/copy/disable', { leaderId, followerId }),
  adminCopyBanLeader: (leaderId) => apiRequest('POST', '/admin/copy/leader/' + leaderId + '/ban', {}),
  adminAIUsage: () => apiRequest('GET', '/admin/ai/usage'),
  adminListRoles: () => apiRequest('GET', '/admin/roles'),
  adminSetUserRole: (id, role) => apiRequest('PATCH', '/admin/users/' + id + '/admin-role', { role }),

  pushVapidKey: () => apiRequest('GET', '/push/vapid-key', null, { skipAuth: true }),
  pushSubscribe: (subscription) => apiRequest('POST', '/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint) => apiRequest('POST', '/push/unsubscribe', { endpoint }),
  pushTest: () => apiRequest('POST', '/push/test'),
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

// ── Notifications bell widget (auto-initializes on any page with .topbar-notification) ──
const Notifications = (function () {
  let host = null, panel = null, unread = 0, open = false;

  function init() {
    if (typeof document === 'undefined') return;
    host = document.querySelector('.topbar-notification');
    if (!host) return;
    host.style.cursor = 'pointer';
    host.addEventListener('click', togglePanel);
    document.addEventListener('click', (e) => {
      if (open && panel && !panel.contains(e.target) && !host.contains(e.target)) closePanel();
    });
    refreshCount();
    setInterval(refreshCount, 45000);
    try {
      if (typeof WS !== 'undefined' && WS.on) {
        WS.on('notification', (msg) => { unread += 1; render(); if (open) buildPanel(); });
      }
    } catch (_e) {}
  }

  async function refreshCount() {
    try { const r = await API.unreadNotifications(); unread = r.count || 0; render(); }
    catch (_e) {}
  }

  function render() {
    if (!host) return;
    let dot = host.querySelector('.dot');
    if (unread > 0 && !dot) {
      dot = document.createElement('div'); dot.className = 'dot';
      dot.style.cssText = 'position:absolute;top:8px;right:8px;min-width:16px;height:16px;padding:0 4px;border-radius:9999px;background:#ef4444;color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;line-height:1';
      host.style.position = 'relative';
      host.appendChild(dot);
    }
    if (dot) dot.textContent = unread > 99 ? '99+' : unread > 0 ? String(unread) : '';
    if (dot && unread === 0) dot.remove();
  }

  function togglePanel() { open ? closePanel() : openPanel(); }
  async function openPanel() {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notif-panel';
      panel.style.cssText = 'position:absolute;top:calc(100% + 8px);right:0;width:360px;max-height:480px;overflow-y:auto;background:#121626;border:1px solid #1f2937;border-radius:14px;box-shadow:0 24px 60px -12px rgba(0,0,0,.6);z-index:200';
      host.appendChild(panel);
    }
    open = true; panel.style.display = 'block';
    await buildPanel();
  }
  function closePanel() { open = false; if (panel) panel.style.display = 'none'; }

  async function buildPanel() {
    try {
      const r = await API.listNotifications({ limit: 30 });
      unread = r.unreadCount || 0; render();
      const head = `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #1f2937">
        <div style="font-weight:600;font-size:14px">Уведомления</div>
        ${r.notifications.length ? '<button id="notif-read-all" style="background:none;border:none;color:#93AAEC;font-size:12px;cursor:pointer">Отметить все</button>' : ''}
      </div>`;
      const body = r.notifications.length
        ? r.notifications.map(renderItem).join('')
        : '<div style="padding:32px 16px;text-align:center;color:rgba(255,255,255,.4);font-size:13px">Нет уведомлений</div>';
      panel.innerHTML = head + body;
      panel.querySelector('#notif-read-all')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await API.markAllNotificationsRead().catch(() => {});
        await buildPanel();
      });
      panel.querySelectorAll('[data-notif-id]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = +el.getAttribute('data-notif-id');
          const link = el.getAttribute('data-link');
          await API.markNotificationRead(id).catch(() => {});
          if (link) location.href = link;
        });
      });
    } catch (err) {
      panel.innerHTML = '<div style="padding:24px;color:#f87171;font-size:13px">' + err.message + '</div>';
    }
  }

  function renderItem(n) {
    const unreadDot = n.readAt ? '' : '<span style="width:8px;height:8px;border-radius:50%;background:#5C80E3;display:inline-block;margin-right:8px;flex-shrink:0"></span>';
    return `<div data-notif-id="${n.id}" data-link="${n.link || ''}" style="padding:12px 16px;border-bottom:1px solid rgba(31,41,55,.5);cursor:pointer;font-size:13px;${n.readAt ? 'opacity:.6' : ''}" onmouseover="this.style.background='rgba(255,255,255,.02)'" onmouseout="this.style.background='transparent'">
      <div style="display:flex;align-items:start">${unreadDot}<div style="flex:1"><div style="font-weight:500;color:#e5e5e5;margin-bottom:2px">${escHtml(n.title)}</div>
      ${n.body ? `<div style="color:rgba(255,255,255,.6);font-size:12px">${escHtml(n.body)}</div>` : ''}
      <div style="color:rgba(255,255,255,.4);font-size:11px;margin-top:4px">${Fmt.timeAgo(n.createdAt)}</div></div></div>
    </div>`;
  }
  function escHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  if (typeof document !== 'undefined' && document.readyState !== 'loading') init();
  else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  return { refreshCount, init };
})();
window.Notifications = Notifications;
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
