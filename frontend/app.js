/**
 * CHM Finance — Frontend Application Logic
 * Main API client, auth, and shared utilities
 */

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : '/api';

// ═══════════════════════════════════════════════════════════════════
// Auth Manager
// ═══════════════════════════════════════════════════════════════════
const Auth = {
  TOKEN_KEY: 'chm_token',
  USER_KEY: 'chm_user',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  setToken(token) {
    localStorage.setItem(this.TOKEN_KEY, token);
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.USER_KEY));
    } catch { return null; }
  },

  setUser(user) {
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  },

  isLoggedIn() {
    const token = this.getToken();
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 > Date.now();
    } catch { return false; }
  },

  logout() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    window.location.href = '/';
  },

  requireAuth() {
    if (!this.isLoggedIn()) {
      window.location.href = '/?login=1';
      return false;
    }
    return true;
  }
};

// ═══════════════════════════════════════════════════════════════════
// API Client
// ═══════════════════════════════════════════════════════════════════
const API = {
  async request(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = Auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json();

    if (res.status === 401) {
      Auth.logout();
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  delete(path) { return this.request('DELETE', path); },

  // Auth
  async register(email, password, captchaToken) {
    const data = await this.post('/auth/register', { email, password, captchaToken });
    if (data.token) {
      Auth.setToken(data.token);
      Auth.setUser(data.user);
    }
    return data;
  },

  async login(email, password, captchaToken) {
    const data = await this.post('/auth/login', { email, password, captchaToken });
    if (data.token) {
      Auth.setToken(data.token);
      Auth.setUser(data.user);
    }
    return data;
  },

  async getProfile() {
    return this.get('/auth/me');
  },

  // Bots
  async getBots() { return this.get('/bots'); },
  async getBot(id) { return this.get(`/bots/${id}`); },
  async createBot(data) { return this.post('/bots', data); },
  async updateBot(id, data) { return this.put(`/bots/${id}`, data); },
  async toggleBot(id, isActive) { return this.patch(`/bots/${id}/toggle`, { isActive }); },
  async deleteBot(id) { return this.delete(`/bots/${id}`); },
  async getBotTrades(id) { return this.get(`/bots/${id}/trades`); },
  async getBotStats() { return this.get('/bots/stats'); },

  // Signals
  async getSignals(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/signals${qs ? '?' + qs : ''}`);
  },
  async getSignalStats() { return this.get('/signals/stats'); },
  async updateSignalSettings(settings) { return this.post('/signals/settings', settings); },

  // Backtests
  async getBacktests() { return this.get('/backtests'); },
  async createBacktest(data) { return this.post('/backtests', data); },
  async getBacktest(id) { return this.get(`/backtests/${id}`); },
  async deleteBacktest(id) { return this.delete(`/backtests/${id}`); },

  // Exchanges
  async getExchanges() { return this.get('/exchanges/exchanges'); },
  async getBalance(exchange) { return this.get(`/exchanges/balance/${exchange}`); },
  async getPrice(exchange, symbol) { return this.get(`/exchanges/${exchange}/price?symbol=${symbol}`); },
  async getPairs(exchange) { return this.get(`/exchanges/${exchange}/pairs`); },

  // Subscriptions
  async getPlans() { return this.get('/subscriptions/plans'); },
  async getSubStatus() { return this.get('/subscriptions/status'); },
  async activateSub(data) { return this.post('/subscriptions/activate', data); },
  async applyPromo(code) { return this.post('/subscriptions/promo', { code }); },

  // Market (V4)
  async getMarketRegime() { return this.get('/market/regime'); },
  async getMarketConfig() { return this.get('/market/config'); },
  async filterSignal(signal) { return this.post('/market/filter', signal); },
  async getFundingRate(symbol) { return this.get(`/market/funding/${symbol}`); },
  async getBTCTrend() { return this.get('/market/btc-trend'); },
  async getMomentumStatus() { return this.get('/market/momentum'); },
  async calculateTrailingSL(pos) { return this.post('/market/trailing', pos); },
  async calculatePartialTP(trade) { return this.post('/market/partial-tp', trade); },
  async getOptimized(strategy) { return this.get(`/market/optimize/${strategy}`); },
  async getDefaults(strategy) { return this.get(`/market/defaults/${strategy}`); },

  // Wallet
  async createWallet() { return this.post('/wallet/create'); },
  async getWalletBalance() { return this.get('/wallet/balance'); },
  async withdraw(data) { return this.post('/wallet/withdraw', data); },
  async getTransactions() { return this.get('/wallet/transactions'); },
};

// ═══════════════════════════════════════════════════════════════════
// i18n (Internationalization)
// ═══════════════════════════════════════════════════════════════════
const I18n = {
  LANG_KEY: 'chm_lang',
  currentLang: 'ru',

  translations: {
    // Navigation
    'nav.features': { ru: 'Возможности', en: 'Features' },
    'nav.pricing': { ru: 'Тарифы', en: 'Pricing' },
    'nav.academy': { ru: 'Академия', en: 'Academy' },
    'nav.dashboard': { ru: 'Дашборд', en: 'Dashboard' },
    'nav.login': { ru: 'Войти', en: 'Login' },
    'nav.register': { ru: 'Регистрация', en: 'Sign Up' },

    // Hero
    'hero.badge': { ru: 'AI-Powered Крипто Платформа', en: 'AI-Powered Crypto Platform' },
    'hero.title': { ru: 'Торгуй умнее.', en: 'Trade Smarter.' },
    'hero.title2': { ru: 'Зарабатывай больше.', en: 'Earn More.' },
    'hero.subtitle': { ru: 'Автоматические торговые сигналы и боты для Bybit, Binance и BingX. Используй стратегии SMC, Герчика и скальпинг с AI-аналитикой.', en: 'Automated trading signals and bots for Bybit, Binance and BingX. Use SMC, Gerchik and scalping strategies with AI analytics.' },
    'hero.cta.start': { ru: 'Начать бесплатно', en: 'Start Free' },
    'hero.cta.demo': { ru: 'Смотреть демо', en: 'Watch Demo' },

    // Stats
    'stats.signals': { ru: 'Сигналов', en: 'Signals' },
    'stats.accuracy': { ru: 'Точность', en: 'Accuracy' },
    'stats.exchanges': { ru: 'Биржи', en: 'Exchanges' },
    'stats.volume': { ru: 'Объём', en: 'Volume' },

    // Features
    'features.title': { ru: 'Всё для прибыльной торговли', en: 'Everything for Profitable Trading' },
    'features.scanner.title': { ru: 'AI Сканер Сигналов', en: 'AI Signal Scanner' },
    'features.scanner.desc': { ru: '3 стратегии: SMC, Герчик, Скальпинг. Анализ в реальном времени.', en: '3 strategies: SMC, Gerchik, Scalping. Real-time analysis.' },
    'features.autotrade.title': { ru: 'Авто-Торговля', en: 'Auto-Trading' },
    'features.autotrade.desc': { ru: 'Автоматическое исполнение сделок с управлением рисками.', en: 'Automated trade execution with risk management.' },
    'features.risk.title': { ru: 'Риск-Менеджмент', en: 'Risk Management' },
    'features.risk.desc': { ru: 'Circuit breaker, trailing stops, контроль просадки.', en: 'Circuit breaker, trailing stops, drawdown control.' },
    'features.backtest.title': { ru: 'Бэктестинг', en: 'Backtesting' },
    'features.backtest.desc': { ru: 'Тестируй стратегии на исторических данных перед запуском.', en: 'Test strategies on historical data before going live.' },
    'features.poly.title': { ru: 'Polymarket', en: 'Polymarket' },
    'features.poly.desc': { ru: 'Предиктивные рынки с AI-аналитикой и автоставками.', en: 'Prediction markets with AI analytics and auto-betting.' },
    'features.multi.title': { ru: 'Мульти-Биржа', en: 'Multi-Exchange' },
    'features.multi.desc': { ru: 'Bybit, Binance, BingX — торгуй на всех площадках.', en: 'Bybit, Binance, BingX — trade on all platforms.' },

    // How it works
    'how.title': { ru: 'Как это работает', en: 'How It Works' },
    'how.step1.title': { ru: 'Подключите биржу', en: 'Connect Exchange' },
    'how.step1.desc': { ru: 'Привяжите API ключи вашей биржи за 2 минуты.', en: 'Link your exchange API keys in 2 minutes.' },
    'how.step2.title': { ru: 'Выберите стратегию', en: 'Choose Strategy' },
    'how.step2.desc': { ru: 'SMC, Герчик или Скальпинг — подберите под свой стиль.', en: 'SMC, Gerchik or Scalping — pick your style.' },
    'how.step3.title': { ru: 'Получайте прибыль', en: 'Start Earning' },
    'how.step3.desc': { ru: 'Бот торгует 24/7, вы следите за результатами.', en: 'Bot trades 24/7, you monitor results.' },

    // Pricing
    'pricing.title': { ru: 'Тарифные планы', en: 'Pricing Plans' },
    'pricing.free': { ru: 'Бесплатно', en: 'Free' },
    'pricing.starter': { ru: 'Стартер', en: 'Starter' },
    'pricing.pro': { ru: 'Про', en: 'Pro' },
    'pricing.elite': { ru: 'Элит', en: 'Elite' },
    'pricing.popular': { ru: 'Популярный', en: 'Popular' },
    'pricing.cta': { ru: 'Выбрать план', en: 'Choose Plan' },
    'pricing.month': { ru: '/мес', en: '/mo' },

    // Sidebar
    'sidebar.dashboard': { ru: 'Дашборд', en: 'Dashboard' },
    'sidebar.bots': { ru: 'Боты', en: 'Bots' },
    'sidebar.signals': { ru: 'Сигналы', en: 'Signals' },
    'sidebar.backtests': { ru: 'Бэктесты', en: 'Backtests' },
    'sidebar.exchanges': { ru: 'Биржи', en: 'Exchanges' },
    'sidebar.wallet': { ru: 'Кошелёк', en: 'Wallet' },
    'sidebar.settings': { ru: 'Настройки', en: 'Settings' },
    'sidebar.logout': { ru: 'Выйти', en: 'Logout' },

    // Dashboard
    'dash.balance': { ru: 'Баланс портфеля', en: 'Portfolio Balance' },
    'dash.active_bots': { ru: 'Активные боты', en: 'Active Bots' },
    'dash.signals_today': { ru: 'Сигналов сегодня', en: 'Signals Today' },
    'dash.win_rate': { ru: 'Win Rate', en: 'Win Rate' },
    'dash.recent_signals': { ru: 'Последние сигналы', en: 'Recent Signals' },
    'dash.active_bots_grid': { ru: 'Активные боты', en: 'Active Bots' },
    'dash.recent_trades': { ru: 'Последние сделки', en: 'Recent Trades' },

    // Common
    'common.save': { ru: 'Сохранить', en: 'Save' },
    'common.cancel': { ru: 'Отмена', en: 'Cancel' },
    'common.delete': { ru: 'Удалить', en: 'Delete' },
    'common.edit': { ru: 'Изменить', en: 'Edit' },
    'common.create': { ru: 'Создать', en: 'Create' },
    'common.loading': { ru: 'Загрузка...', en: 'Loading...' },
    'common.error': { ru: 'Ошибка', en: 'Error' },
    'common.success': { ru: 'Успешно', en: 'Success' },
    'common.view_all': { ru: 'Смотреть все', en: 'View All' },
    'common.long': { ru: 'ЛОНГ', en: 'LONG' },
    'common.short': { ru: 'ШОРТ', en: 'SHORT' },
  },

  init() {
    this.currentLang = localStorage.getItem(this.LANG_KEY) || 'ru';
    this.apply();
  },

  setLang(lang) {
    this.currentLang = lang;
    localStorage.setItem(this.LANG_KEY, lang);
    this.apply();
  },

  t(key) {
    const entry = this.translations[key];
    if (!entry) return key;
    return entry[this.currentLang] || entry['ru'] || key;
  },

  apply() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const text = this.t(key);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = text;
      } else {
        el.textContent = text;
      }
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = this.t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === this.currentLang);
    });
  }
};

// ═══════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════
const Toast = {
  container: null,

  init() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  },

  show(message, type = 'success', duration = 4000) {
    if (!this.container) this.init();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconColor = type === 'success' ? 'green' : type === 'error' ? 'red' : 'yellow';
    const iconPath = type === 'success'
      ? '<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/>'
      : '<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>';
    toast.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink:0;color:var(--accent-${iconColor})">${iconPath}</svg>
      <span style="flex:1">${message}</span>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px;font-size:18px">&times;</button>
    `;
    this.container.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
  },

  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },
  warning(msg) { this.show(msg, 'warning'); }
};

// ═══════════════════════════════════════════════════════════════════
// WebSocket Client (for live signals)
// ═══════════════════════════════════════════════════════════════════
const WS = {
  socket: null,
  listeners: {},
  reconnectAttempts: 0,
  maxReconnectAttempts: 5,

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname === 'localhost' ? 'localhost:3000' : window.location.host;
    const token = Auth.getToken();
    if (!token) return;

    try {
      this.socket = new WebSocket(`${protocol}//${host}/ws?token=${token}`);
      this.socket.onopen = () => { this.reconnectAttempts = 0; };
      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const handlers = this.listeners[data.type] || [];
          handlers.forEach(fn => fn(data.payload));
        } catch (e) { /* ignore */ }
      };
      this.socket.onclose = () => {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
        }
      };
    } catch (e) { /* WebSocket not available */ }
  },

  on(type, callback) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(callback);
  },

  off(type, callback) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter(fn => fn !== callback);
  },

  send(type, payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, payload }));
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════
const Utils = {
  formatCurrency(value, decimals = 2) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD',
      minimumFractionDigits: decimals, maximumFractionDigits: decimals
    }).format(value);
  },

  formatPercent(value, decimals = 1) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}%`;
  },

  formatNumber(value) {
    if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M';
    if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K';
    return value.toString();
  },

  timeAgo(date) {
    const seconds = Math.floor((Date.now() - new Date(date)) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  },

  debounce(fn, delay = 300) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
  },

  copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(
      () => Toast.success('Copied!'),
      () => Toast.error('Failed to copy')
    );
  },

  generateEquityData(days = 30, startBalance = 10000) {
    const data = [];
    let balance = startBalance;
    const now = new Date();
    for (let i = days; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      balance += (Math.random() - 0.4) * balance * 0.02;
      data.push({ date: date.toISOString().split('T')[0], value: Math.round(balance * 100) / 100 });
    }
    return data;
  }
};

// ═══════════════════════════════════════════════════════════════════
// Sidebar Component (shared across dashboard pages)
// ═══════════════════════════════════════════════════════════════════
const Sidebar = {
  init(activePage) {
    document.querySelectorAll('.sidebar-link').forEach(link => {
      if (link.dataset.page === activePage) link.classList.add('active');
    });
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.querySelector('.sidebar');
    if (toggle && sidebar) {
      toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 1024 && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
          sidebar.classList.remove('open');
        }
      });
    }
    const user = Auth.getUser();
    if (user) {
      const avatarEl = document.querySelector('.topbar-avatar');
      const nameEl = document.querySelector('.topbar-username');
      if (avatarEl) avatarEl.textContent = (user.email || 'U')[0].toUpperCase();
      if (nameEl) nameEl.textContent = user.email || 'User';
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
// Initialize on page load
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  I18n.init();
  Toast.init();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => I18n.setLang(btn.dataset.lang));
  });
});
