'use strict';
/**
 * Contract stub of the web app's backend — `/api/app/*` (the Mini App routes
 * one-to-one, miniapp/API.md + ui-inventory.md §6) and the slice of
 * `/api/auth/*` the app's login screen uses. In-memory, deterministic, no DB.
 *
 * Used by the E2E suite (backend/tests/e2e) to drive frontend/app against the
 * documented contract while the real routes land in backend/routes/app.js
 * (M7–M10). The response shapes here are the contract the SPA is coded to;
 * keep them in sync with miniapp/API.md when the real routes evolve.
 *
 *   const { createStubServer } = require('./utils/app-stub');
 *   createStubServer({ staticDir: '/path/to/frontend' }).listen(3999);
 *
 * Credentials: demo@chm.local / demo1234 (Free), pro@chm.local / demo1234 (Pro),
 * 2fa@chm.local / demo1234 (asks for a TOTP code, 000000 passes).
 */
const path = require('path');
const express = require('express');

const STRATS = ['LEVELS', 'SMC', 'VOLUME'];
const EXCHANGES = ['bybit', 'bingx', 'binance', 'okx'];
const CLOSED = { sl: 1, be: 1, closed: 1, tp3: 1, skip: 1, expired: 1, missed: 1 };
const PLAN_FEATURES_RU = [
  'Стратегии LEVELS + SMC + Объём/MA — можно все сразу', 'Авто-трейд без лимита позиций',
  'LONG + SHORT, все таймфреймы и все монеты', 'Безлимит сигналов и анализа монет',
  'Strategy Genome (автоподбор параметров)', 'Mini App — сигналы, графики, статистика',
  'AI-фильтры сигналов', 'Bybit + BingX + Binance + OKX',
];
const HELP_SECTIONS = [
  ['quick_start', 'Быстрый старт'], ['strategies', 'Стратегии'], ['signals', 'Карточка сигнала'],
  ['scanners', 'Настройки сканера'], ['auto_trade', 'Авто-трейд и биржи'], ['risk_mgmt', 'Риск-менеджмент'],
  ['miniapp', 'Приложение и уведомления'], ['subscription', 'Тариф и оплата'], ['why_no_signal', 'Почему нет сигнала'],
  ['commands', 'Команды'], ['contacts', 'Поддержка'],
];

function seeded(str) {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619) >>> 0;
  return () => {
    x = (x + 0x6D2B79F5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round2 = (x) => Math.round(x * 100) / 100;
const clone = (x) => JSON.parse(JSON.stringify(x));
const now = () => Math.floor(Date.now() / 1000);

function candles(seed, n, end, vol, trendSign, tfSec, t0) {
  const r = seeded(seed);
  let p = end * (1 - trendSign * vol * (6 + r() * 6));
  const out = [];
  for (let i = 0; i < n; i++) {
    const left = n - i;
    const drift = (end - p) / left * 0.85;
    const o = p;
    const c = o + drift + (r() - 0.5) * vol * end * 1.6;
    const h = Math.max(o, c) + r() * vol * end * 0.8;
    const l = Math.min(o, c) - r() * vol * end * 0.8;
    out.push({ t: (t0 - (n - i) * tfSec) * 1000, o, h, l, c, v: Math.round(1e5 + r() * 9e5) });
    p = c;
  }
  return out;
}
const TF_SEC = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

function mkSignal(id, uid, sym, dir, strat, tf, entry, slPct, q, minsAgo, status, rNow, extra) {
  const long = dir === 'LONG';
  const risk = entry * slPct;
  const sl = long ? entry - risk : entry + risk;
  const tp = (k) => (long ? entry + risk * k : entry - risk * k);
  const rr = { tp3: 3.5, sl: -1, be: 0, closed: 0.6, tp1: 1.5, tp2: 2.5 }[status];
  const o = {
    id: `${uid}_${1791314326939 + id}_${id}`, symbol: sym, pair: `${sym}/USDT`, direction: dir, strategy: strat,
    timeframe: tf, entry, sl, sl0: sl, tp1: tp(1.5), tp2: tp(2.5), tp3: tp(3.5), quality: q,
    counter_trend: false, mtf_aligned: false, trend_ctx: '', note: '', on_exchange: false, manual: false,
    created_at: now() - minsAgo * 60, status, rr: rr == null ? null : rr,
  };
  if (rNow != null) { o.r_now = rNow; o.price = long ? entry + risk * rNow : entry - risk * rNow; }
  return Object.assign(o, extra || {});
}

function buildUserState(user) {
  const uid = user.id;
  const pro = user.plan === 'pro';
  const flags = { LEVELS: { long: true, short: false }, SMC: { long: pro, short: pro }, VOLUME: { long: pro, short: false } };
  const locked = { LEVELS: false, SMC: !pro, VOLUME: !pro };
  const me = {
    user: { id: uid, username: user.username, first_name: user.firstName, email: user.email, lang: 'ru', plan: user.plan,
      plan_label: pro ? 'Pro' : 'Free', sub_expires: pro ? now() + 86400 * 41 : 0, is_pro: pro },
    strategy: pro ? 'SMC' : 'LEVELS', extra_strategies: pro ? 'VOLUME' : '', strategies: {},
    prefs: { progress_notify_enabled: true, send_chart_enabled: true, genome_auto_apply: pro, signal_format: 'full', quiet_start: -1, quiet_end: -1 },
    auto_trade: pro, exchange: pro ? 'bingx' : '',
  };
  const extras = () => (me.extra_strategies ? me.extra_strategies.split(',') : []);
  function syncStrategies() {
    const ex = extras();
    for (const k of STRATS) {
      const f = flags[k];
      const running = (k === me.strategy || ex.includes(k)) && !locked[k];
      me.strategies[k] = { long: f.long, short: f.short, locked: locked[k], primary: k === me.strategy, enabled: running && (f.long || f.short) };
    }
  }
  function applyMulti(k, on) {   // mirrors miniapp_api._apply_multi
    let ex = extras().filter((x) => x !== me.strategy);
    if (on) {
      if (k !== me.strategy) {
        const pf = flags[me.strategy];
        if (pf && (pf.long || pf.short)) { if (!ex.includes(k)) ex.push(k); } else { me.strategy = k; ex = ex.filter((x) => x !== k); }
      }
    } else if (ex.includes(k)) ex.splice(ex.indexOf(k), 1);
    else if (k === me.strategy && ex.length) me.strategy = ex.shift();
    me.extra_strategies = STRATS.filter((x) => ex.includes(x)).join(',');
  }
  syncStrategies();

  const signals = user.empty ? [] : [
    mkSignal(1, uid, 'ETH', 'SHORT', 'SMC', '1h', 2698.79, 0.01094, 4, 38, 'open', 0.84, { mtf_aligned: true, trend_ctx: 'aligned' }),
    mkSignal(2, uid, 'SOL', 'LONG', 'SMC', '15m', 142.356, 0.0085, 5, 95, 'tp2', 2.71),
    mkSignal(3, uid, 'PEPE', 'LONG', 'VOLUME', '1h', 0.00001234, 0.021, 3, 160, 'tp1', 1.22),
    mkSignal(4, uid, 'BTC', 'LONG', 'LEVELS', '4h', 85400.1, 0.0072, 4, 300, 'open', -0.37, { counter_trend: true, trend_ctx: 'counter' }),
    mkSignal(5, uid, 'DOGE', 'SHORT', 'SMC', '1h', 0.17123, 0.0124, 3, 520, 'sl'),
    mkSignal(6, uid, 'XRP', 'LONG', 'LEVELS', '1h', 2.1834, 0.0098, 4, 780, 'tp3'),
    mkSignal(7, uid, 'LINK', 'SHORT', 'VOLUME', '4h', 15.428, 0.0151, 2, 1300, 'be'),
    mkSignal(8, uid, 'TON', 'LONG', 'LEVELS', '15m', 3.2157, 0.0088, 3, 2100, 'closed'),
    mkSignal(9, uid, 'AVAX', 'SHORT', 'LEVELS', '1h', 24.37, 0.0132, 3, 2600, 'open'),
  ].filter((s) => pro || s.strategy === 'LEVELS');

  function blank() { return { signals: 0, trades: 0, wins: 0, losses: 0, be: 0, win_rate: 0, total_rr: 0, rr_7d: 0 }; }
  function stats30() {
    const rnd = seeded(pro ? 'eq-pro' : 'eq-free');
    const keys = pro ? STRATS : ['LEVELS'];
    const n = user.empty ? 0 : pro ? 42 : 14;
    const tot = blank(), per = {};
    for (const k of STRATS) per[k] = blank();
    const equity = []; let cum = 0, best = null;
    const t0 = now() - 30 * 86400;
    for (let i = 0; i < n; i++) {
      const k = keys[Math.floor(rnd() * keys.length)];
      const x = rnd();
      let r = x < 0.46 ? -1 : x < 0.53 ? 0 : x < 0.78 ? 1.5 : x < 0.93 ? 2.5 : 3.5;
      if (r === 1.5 && rnd() < 0.3) r = 0.6;
      const t = t0 + Math.floor((i + 1) / (n + 1) * 29.5 * 86400);
      for (const b of [tot, per[k]]) {
        b.signals++; b.trades++;
        if (r > 0) b.wins++; else if (r < 0) b.losses++; else b.be++;
        b.total_rr += r;
        if (t > now() - 7 * 86400) b.rr_7d += r;
      }
      cum += r; equity.push({ t, r: round2(cum) });
      if (best === null || r > best) best = r;
    }
    const open = signals.filter((s) => !CLOSED[s.status]);
    for (const s of open) { tot.signals++; if (per[s.strategy]) per[s.strategy].signals++; }
    for (const b of [tot, ...STRATS.map((k) => per[k])]) {
      if (b.trades) b.win_rate = Math.round(b.wins / b.trades * 1000) / 10;
      b.total_rr = round2(b.total_rr); b.rr_7d = round2(b.rr_7d);
    }
    return Object.assign(tot, { days: 30, open: open.length, expired: 0, missed: 0, best_rr: best, best_symbol: 'XRP', best_direction: 'LONG', best_strategy: 'LEVELS', equity, per_strategy: per });
  }
  const t = now();
  const marketTrend = {
    '15m': { trend: 'LONG', since: t - 3 * 3600, price: 85400.1, ema: '50/200', strength: 86 },
    '1H': { trend: 'LONG', since: t - 9 * 3600, price: 85400.1, ema: '50/200', strength: 72 },
    '4H': { trend: 'LONG', since: t - 30 * 3600, price: 85400.1, ema: '50/200', strength: 61 },
    '1D': { trend: 'RANGE', since: t - 5 * 86400, price: 85400.1, ema: '50/200' },
    '1W': { trend: 'SHORT', since: t - 20 * 86400, price: 85400.1, ema: '20/50', strength: 55 },
    '1M': { trend: 'LONG', since: t - 90 * 86400, price: 85400.1, ema: '10/20' },
  };
  const settings = {
    lang: 'ru', ui_mode: pro ? 'expert' : 'simple',
    levels: { long_tf: '1h', short_tf: '4h', min_quality: 6, min_volume_usdt: 1000000, min_rr: 2, max_dist_pct: 2, zone_pct: 1,
      use_rsi: true, use_volume: true, use_htf: true, trend_only: false, max_risk_pct: 2,
      // D9 extension (Telegram-menu-only parameters): rendered by the «Расширенные настройки» screen
      pivot_strength: 7, cooldown_bars: 3, use_pattern: true, tp1_rr: 1.5 },
    smc: { tf_key: '1H', direction: 'BOTH', min_volume_usdt: 5000000, max_sl_pct: 3, scan_interval: 300, min_confirmations: 3, fvg_enabled: true },
    volume: { timeframe: '1h', setup_cross: true, setup_turn: false, setup_bounce: true, setup_golden: true, setup_ribbon: true, ma_type: 'sma', vol_mult: 1.8, use_htf: true, min_quality: 3 },
    trading: { auto_trade: pro, auto_trade_mode: 'auto', trade_exchange: pro ? 'bingx' : '', trade_risk_pct: 1, trade_leverage: 5, max_trades_limit: 3,
      risk_mode: 'risk', partial_tp_enabled: true, auto_trailing_enabled: true, prefer_market_entry: false, bybit_demo: false, fixed_amount: 0 },
    risk: { sl_streak_enabled: true, sl_streak_threshold: 3, circuit_breaker_enabled: pro, circuit_breaker_threshold_r: 5, allow_counter_trend: false,
      filters_all_off: false, btc_correlation_block: true, spread_check_enabled: true, trade_trending_only: false, hour_filter_enabled: false, spread_max_pct: 0.3 },
    exchanges: { bybit: { connected: false, key_hint: '' }, bingx: { connected: pro, key_hint: pro ? 'Kx7q…fA' : '' }, binance: { connected: false, key_hint: '' }, okx: { connected: false, key_hint: '' } },
    notifications: { progress_notify_enabled: true, send_chart_enabled: true, signal_format: 'full', quiet_start: -1, quiet_end: -1, notify_signal: true, notify_breakout: false },
    genome_auto_apply: pro,
  };
  const options = {
    tf_levels: ['15m', '30m', '1h', '4h', '1d'], tf_smc: ['15m', '1H', '4H'], tf_volume: ['15m', '1h', '4h'],
    exchanges: EXCHANGES, leverage: [1, 2, 3, 5, 10, 20], risk_pct: [0.25, 0.5, 1, 1.5, 2, 3], max_trades: [1, 2, 3, 5, 10],
    min_volume: [300000, 1000000, 5000000, 10000000, 25000000, 50000000],
    // the real server's _locked_keys (ui-inventory §3)
    locked: pro ? [] : ['smc.*', 'volume.*', 'trading.*', 'genome_auto_apply', 'ui_mode.expert', 'levels.long_tf', 'levels.short_tf'],
  };
  const positions = pro && !user.empty ? [
    { exchange: 'bingx', symbol: 'ETH-USDT', side: 'SHORT', size: 0.42, entry: 2698.79, mark: 2674.1, pnl_usd: 10.37, pnl_pct: 4.57, leverage: 5 },
    { exchange: 'bingx', symbol: 'BTC-USDT', side: 'LONG', size: 0.012, entry: 85400.1, mark: 85172.5, pnl_usd: -2.73, pnl_pct: -1.33, leverage: 5 },
  ] : [];
  const genome = pro ? {
    available: true, auto_apply: me.prefs.genome_auto_apply,
    strategies: {
      LEVELS: { timeframe: '1h', generation: 14, fitness: 0.62, win_rate: 54.2, profit_factor: 1.62, updated_at: now() - 86400 * 1.3, applied: true },
      SMC: { timeframe: '15m', generation: 9, fitness: 0.48, win_rate: 48.7, profit_factor: 1.21, updated_at: now() - 3600 * 5, applied: false },
      VOLUME: { timeframe: '1h', generation: null, fitness: null, win_rate: null, profit_factor: null, updated_at: null, applied: false },
    },
  } : { available: false, auto_apply: false, strategies: {} };
  return { user, me, flags, locked, signals, stats30, marketTrend, settings, options, positions, genome, syncStrategies, applyMulti,
    feedbackToday: 0, shareTimes: [], challenge: null, analyzeToday: 0 };
}

// ----------------------------------------------------------------------------- auth stub
function createAuthStub(opts = {}) {
  const router = express.Router();
  const users = new Map();   // email → user
  const sessions = { access: new Map(), refresh: new Map() };   // token → userId
  let seq = 0;
  const addUser = (u) => { users.set(u.email, u); return u; };
  addUser({ id: 7107654772, email: 'demo@chm.local', password: 'demo1234', username: 'alex_trader', firstName: 'Alex', plan: 'free', twoFactor: false });
  addUser({ id: 7107654773, email: 'pro@chm.local', password: 'demo1234', username: 'pro_trader', firstName: 'Pro', plan: 'pro', twoFactor: false });
  addUser({ id: 7107654774, email: '2fa@chm.local', password: 'demo1234', username: 'safe_trader', firstName: 'Safe', plan: 'free', twoFactor: true });
  addUser({ id: 7107654775, email: 'empty@chm.local', password: 'demo1234', username: 'newbie', firstName: 'New', plan: 'free', twoFactor: false, empty: true });

  const publicUser = (u) => ({ id: u.id, email: u.email, displayName: u.firstName, emailVerified: true, plan: u.plan, isAdmin: false });
  function issue(u) {
    seq++;
    const accessToken = `acc.${u.id}.${seq}`, refreshToken = `ref.${u.id}.${seq}`;
    sessions.access.set(accessToken, u.id);
    sessions.refresh.set(refreshToken, u.id);
    return { user: publicUser(u), accessToken, refreshToken, refreshExpiresAt: new Date(Date.now() + 30 * 86400e3).toISOString() };
  }
  const fail = (res, status, error, code) => res.status(status).json({ error, code });
  const validEmail = (e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128 && /[a-zA-Z]/.test(p) && /\d/.test(p);

  router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== 'string' || !password) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR');
    const u = users.get(String(email).toLowerCase());
    if (!u || u.password !== password) return fail(res, 401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    if (u.twoFactor) return res.json({ twoFactorRequired: true, pendingToken: `pend.${u.id}.${++seq}` });
    res.json(issue(u));
  });
  router.post('/2fa/verify-login', (req, res) => {
    const { pendingToken, code } = req.body || {};
    const m = /^pend\.(\d+)\./.exec(String(pendingToken || ''));
    if (!m) return fail(res, 401, 'Invalid pending token', 'INVALID_TOKEN');
    if (String(code) !== '000000') return fail(res, 400, 'Invalid 2FA code', 'INVALID_2FA');
    const u = [...users.values()].find((x) => String(x.id) === m[1]);
    res.json(issue(u));
  });
  router.post('/register', (req, res) => {
    const { email, password } = req.body || {};
    if (!validEmail(email) || !validPassword(password)) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR');
    const key = String(email).toLowerCase();
    if (users.has(key)) return fail(res, 409, 'Email already registered', 'EMAIL_EXISTS');
    const u = addUser({ id: 7200000000 + users.size, email: key, password, username: key.split('@')[0], firstName: key.split('@')[0], plan: 'free', twoFactor: false, empty: true });
    res.status(201).json(issue(u));
  });
  router.post('/refresh', (req, res) => {
    const rt = String((req.body || {}).refreshToken || '');
    const uid = sessions.refresh.get(rt);
    if (!uid) return fail(res, 401, 'Invalid refresh token', 'INVALID_REFRESH');
    sessions.refresh.delete(rt);   // rotation
    res.json(issue([...users.values()].find((x) => x.id === uid)));
  });
  router.post('/logout', (req, res) => {
    const rt = String((req.body || {}).refreshToken || '');
    const uid = sessions.refresh.get(rt);
    sessions.refresh.delete(rt);
    for (const [k, v] of sessions.access) if (v === uid) sessions.access.delete(k);
    res.json({ success: true });
  });
  router.get('/oauth/providers', (_req, res) => {
    res.json({ google: { enabled: false }, telegram: { enabled: opts.telegram !== false, username: opts.telegramUsername || 'CHMUP_bot' } });
  });
  router.post('/oauth/telegram', (req, res) => {
    const b = req.body || {};
    if (b.id == null || !b.auth_date || typeof b.hash !== 'string' || b.hash.length < 32) return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR');
    if (/^bad/.test(b.hash)) return fail(res, 401, 'Telegram signature invalid', 'INVALID_SIGNATURE');
    const email = `tg_${b.id}@chm.local`;
    const u = users.get(email) || addUser({ id: Number(b.id), email, password: '', username: b.username || '', firstName: b.first_name || 'Трейдер', plan: 'free', twoFactor: false, empty: true });
    res.json(issue(u));
  });
  // Test hook: drop every access token (keeps refresh tokens) → the app must refresh once.
  router.post('/__stub/expire-access', (_req, res) => { sessions.access.clear(); res.json({ ok: true }); });

  function userForToken(token) {
    const uid = sessions.access.get(token);
    return uid ? [...users.values()].find((x) => x.id === uid) : null;
  }
  return { router, userForToken, users, issue };
}

// ----------------------------------------------------------------------------- app stub
function createAppStub({ userForToken }) {
  const router = express.Router();
  const states = new Map();
  const stateFor = (u) => { if (!states.has(u.id)) states.set(u.id, buildUserState(u)); return states.get(u.id); };
  const bad = (res, key) => res.json({ ok: false, error: 'bad_request', message: key });

  router.use((req, res, next) => {
    const h = String(req.headers.authorization || '');
    const u = h.startsWith('Bearer ') ? userForToken(h.slice(7).trim()) : null;
    if (!u) return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.st = stateFor(u);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/me', (req, res) => { const st = req.st; st.syncStrategies(); res.json({ ok: true, ...clone(st.me) }); });
  router.get('/dashboard', (req, res) => {
    const st = req.st;
    const pro = st.user.plan === 'pro';
    res.json({ ok: true, stats: st.stats30(),
      market: { BTC: { price: 85400.1, change_pct: -0.31 }, ETH: { price: 2689.5, change_pct: 0.42 } },
      recent: st.signals.slice(0, 6),
      trend: { BTC: { H1: 'up', H4: 'up', D1: 'down', W1: 'up' }, ETH: { H1: 'down', H4: 'flat', D1: 'up', W1: 'unknown' } },
      rating: pro ? { days: 30, best: 'SMC', by_strategy: { LEVELS: { signals: 120, trades: 90, wins: 48, losses: 40, be: 2, win_rate: 53.3, total_rr: 21.5 }, SMC: { signals: 80, trades: 60, wins: 31, losses: 27, be: 2, win_rate: 51.7, total_rr: 24.1 } } } : null,
      market_trend: st.marketTrend });
  });
  router.get('/signals', (req, res) => {
    const st = req.st;
    const status = ['all', 'open', 'closed'].includes(req.query.status) ? req.query.status : 'all';
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const strat = STRATS.includes(String(req.query.strategy || '').toUpperCase()) ? String(req.query.strategy).toUpperCase() : '';
    let list = st.signals.filter((x) => !strat || x.strategy === strat);
    if (status === 'open') list = list.filter((x) => !CLOSED[x.status]);
    if (status === 'closed') list = list.filter((x) => !!CLOSED[x.status]);
    res.json({ ok: true, signals: clone(list.slice(0, limit)), strategy: strat || 'ALL' });
  });
  router.get('/signals/:id/chart', (req, res) => {
    const st = req.st;
    const sg = st.signals.find((x) => x.id === req.params.id);
    if (!sg) return res.status(404).json({ ok: false, error: 'not_found' });
    const tf = TF_SEC[sg.timeframe] || 3600;
    const cs = candles(sg.id + 'chart', 120, sg.entry, 0.0045, sg.direction === 'LONG' ? -1 : 1, tf, now());
    const ema = (n) => { const out = []; let e = null; const k = 2 / (n + 1); for (const c of cs) { e = e === null ? c.c : c.c * k + e * (1 - k); out.push(round2(e * 1e6) / 1e6); } return out; };
    res.json({ ok: true, candles: cs,
      overlays: { entry: sg.entry, sl: sg.sl, tps: [sg.tp1, sg.tp2, sg.tp3], be: /^(tp[123]|be)$/.test(sg.status) ? sg.entry : null,
        ob: sg.strategy === 'SMC' ? [{ from: 70, to: 119, top: sg.entry * 1.004, bottom: sg.entry * 0.998, side: sg.direction }] : [],
        fvg: [], pivots: [{ price: sg.entry * 1.02, kind: 'R' }, { price: sg.entry * 0.98, kind: 'S' }], hvn: [], lvn: [],
        emas: { 50: ema(50), 200: ema(200) } },
      event: CLOSED[sg.status] || /^tp/.test(sg.status) ? sg.status.toUpperCase() : null,
      hit_levels: sg.status === 'tp1' ? ['TP1'] : sg.status === 'tp2' ? ['TP1', 'TP2'] : sg.status === 'tp3' ? ['TP1', 'TP2', 'TP3'] : sg.status === 'sl' ? ['SL'] : [] });
  });
  router.post('/signals/:id/result', (req, res) => {
    const st = req.st;
    const sg = st.signals.find((x) => x.id === req.params.id);
    if (!sg) return res.status(404).json({ ok: false, error: 'not_found' });
    const b = req.body || {};
    const result = b.result != null ? String(b.result).trim().toUpperCase() : '';
    const note = b.note;
    if (!result && note == null) return bad(res, 'result');
    if (result) {
      if (!['TP1', 'TP2', 'TP3', 'SL', 'BE', 'SKIP'].includes(result)) return bad(res, 'result');
      if (sg.on_exchange) return res.json({ ok: false, error: 'exchange_trade' });
      if (sg.result && sg.result !== 'SKIP') return res.json({ ok: false, error: 'already_set', result: sg.result });
      const risk = Math.abs(sg.entry - sg.sl0);
      const rrMap = { TP1: round2(Math.abs(sg.tp1 - sg.entry) / risk), TP2: round2(Math.abs(sg.tp2 - sg.entry) / risk), TP3: round2(Math.abs(sg.tp3 - sg.entry) / risk), SL: -1, BE: 0, SKIP: 0 };
      sg.result = result; sg.status = result.toLowerCase(); sg.rr = rrMap[result]; sg.manual = true; delete sg.price; delete sg.r_now;
    }
    if (note != null) { if (typeof note !== 'string' || note.length > 500) return bad(res, 'note'); sg.note = note.trim(); }
    res.json({ ok: true, signal: clone(sg) });
  });
  router.post('/strategy', (req, res) => {
    const st = req.st, b = req.body || {};
    const k = String(b.strategy || '').toUpperCase();
    if (!STRATS.includes(k)) return res.status(400).json({ ok: false, error: 'bad_strategy' });
    const wantL = !!b.long, wantS = !!b.short;
    if ((wantL || wantS) && st.locked[k]) return res.json({ ok: false, error: 'pro_required' });
    if (wantL && wantS && st.user.plan !== 'pro') return res.json({ ok: false, error: 'pro_required' });
    st.flags[k].long = wantL; st.flags[k].short = wantS;
    st.applyMulti(k, wantL || wantS); st.syncStrategies();
    res.json({ ok: true, strategy: st.me.strategy, strategies: clone(st.me.strategies) });
  });
  router.post('/settings', (req, res) => {
    const st = req.st, b = req.body || {};
    let changed = false;
    for (const key of ['progress_notify_enabled', 'send_chart_enabled', 'genome_auto_apply']) {
      if (!(key in b)) continue;
      if (key === 'genome_auto_apply' && b[key] && st.user.plan !== 'pro') return res.json({ ok: false, error: 'pro_required' });
      st.me.prefs[key] = !!b[key]; changed = true;
    }
    if ('signal_format' in b) { st.me.prefs.signal_format = b.signal_format === 'lite' ? 'lite' : 'full'; changed = true; }
    if ('quiet_start' in b || 'quiet_end' in b) {
      let s = Number.isInteger(b.quiet_start) ? b.quiet_start : -1, e = Number.isInteger(b.quiet_end) ? b.quiet_end : -1;
      if (s < 0 || s > 23) { s = -1; e = -1; } else if (e < 0 || e > 23 || e === s) e = (s + 9) % 24;
      st.me.prefs.quiet_start = s; st.me.prefs.quiet_end = e; changed = true;
    }
    if (!changed) return res.status(400).json({ ok: false, error: 'nothing_to_change' });
    st.settings.notifications = Object.assign({}, st.settings.notifications, st.me.prefs);
    res.json({ ok: true, prefs: clone(st.me.prefs) });
  });
  router.get('/genome', (req, res) => res.json({ ok: true, ...clone(req.st.genome) }));
  router.post('/genome/apply', (req, res) => {
    const st = req.st, k = String((req.body || {}).strategy || '').toUpperCase();
    if (st.user.plan !== 'pro') return res.json({ ok: false, error: 'pro_required' });
    if (!STRATS.includes(k)) return res.status(400).json({ ok: false, error: 'bad_strategy' });
    const g = st.genome.strategies[k];
    if (!g || g.generation == null) return res.json({ ok: false, error: 'genome_not_ready', message: 'no generation' });
    g.applied = true;
    res.json({ ok: true });
  });
  router.post('/analyze', (req, res) => {
    const st = req.st, b = req.body || {};
    const sym = String(b.symbol || '').toUpperCase().trim().replace('/USDT', '').replace('USDT', '');
    if (!/^[A-Z0-9]{2,15}$/.test(sym)) return res.status(400).json({ ok: false, error: 'bad_symbol' });
    if (st.user.plan !== 'pro' && st.analyzeToday >= 1) return res.json({ ok: false, error: 'rate_limited' });
    st.analyzeToday++;
    const strategy = ['LEVELS', 'SMC', 'VOLUME', 'AUTO'].includes(b.strategy) ? b.strategy : 'AUTO';
    const tried = strategy === 'AUTO' ? STRATS : [strategy];
    const rnd = seeded(sym + strategy);
    const base = { BTC: 85400.1, ETH: 2689.5, SOL: 142.36, TON: 3.2157, XRP: 2.1834, DOGE: 0.17123 }[sym] || +(rnd() * 40).toFixed(4);
    const price = { price: base, change_pct: +((rnd() - 0.5) * 6).toFixed(2) };
    if (sym === 'DOGE') return res.json({ ok: true, symbol: sym, price, signal: null, tried, png: null });
    const strat = strategy === 'AUTO' ? 'SMC' : strategy;
    const long = rnd() > 0.4, risk = base * 0.012, entry = base * (long ? 0.998 : 1.002);
    const signal = { strategy: strat, direction: long ? 'LONG' : 'SHORT', entry, sl: long ? entry - risk : entry + risk,
      tp1: long ? entry + risk : entry - risk, tp2: long ? entry + risk * 2 : entry - risk * 2, tp3: long ? entry + risk * 3 : entry - risk * 3,
      quality: 4, setup: strat === 'SMC' ? 'Order Block + FVG' : 'Отскок от поддержки', bars_ago: 1,
      reasons: ['Цена выше EMA200 — тренд восходящий', 'Объём на сигнальной свече в 1.8× выше среднего'] };
    res.json({ ok: true, symbol: sym, price, signal, tried, png: null,
      candles: candles(sym + 'an', 90, entry, 0.004, long ? -1 : 1, 3600, now()), overlays: { entry, sl: signal.sl, tps: [signal.tp1, signal.tp2, signal.tp3] } });
  });
  router.get('/settings/all', (req, res) => res.json({ ok: true, settings: clone(req.st.settings), options: clone(req.st.options) }));
  router.post('/settings/all', (req, res) => {
    const st = req.st, b = req.body || {};
    const locked = (full) => st.options.locked.some((k) => k === full || k === full.split('.')[0] + '.*' || k === full.split('.')[0]);
    const pending = []; let any = false;
    for (const sec of ['levels', 'smc', 'volume', 'trading', 'risk', 'notifications']) {
      if (!(sec in b)) continue;
      if (!b[sec] || typeof b[sec] !== 'object') return bad(res, sec);
      for (const k of Object.keys(b[sec])) {
        if (!(k in st.settings[sec])) continue;
        any = true;
        const v = b[sec][k], cur = st.settings[sec][k];
        if (typeof cur === 'boolean' && typeof v !== 'boolean') return bad(res, `${sec}.${k}`);
        if (typeof cur === 'number' && (typeof v !== 'number' || !isFinite(v))) return bad(res, `${sec}.${k}`);
        if (/tf|timeframe/.test(k) && String(v).toLowerCase() === '5m') return bad(res, `${sec}.${k}`);
        pending.push([sec, k, v]);
      }
    }
    for (const k of ['lang', 'ui_mode', 'genome_auto_apply']) if (k in b) { any = true; pending.push(['', k, b[k]]); }
    if (!any) return bad(res, 'empty');
    for (const [sec, k, v] of pending) {
      const full = sec ? `${sec}.${k}` : k;
      if (locked(full) || (full === 'ui_mode' && v === 'expert' && locked('ui_mode.expert')) || (full === 'genome_auto_apply' && v && locked(full))) return res.json({ ok: false, error: 'pro_required' });
      if (full === 'trading.auto_trade' && v && !Object.values(st.settings.exchanges).some((x) => x.connected)) return res.json({ ok: false, error: 'bad_request', message: 'trading.auto_trade: no API keys for bybit' });
    }
    for (const [sec, k, v] of pending) { if (sec) st.settings[sec][k] = v; else st.settings[k] = v; }
    if (!['setup_cross', 'setup_turn', 'setup_bounce', 'setup_golden', 'setup_ribbon'].some((k) => st.settings.volume[k])) return bad(res, 'volume.setup_*');
    st.me.auto_trade = !!st.settings.trading.auto_trade; st.me.exchange = st.settings.trading.trade_exchange;
    res.json({ ok: true, settings: clone(st.settings) });
  });
  router.post('/profile', (req, res) => {
    const st = req.st, name = String((req.body || {}).name || '').toLowerCase();
    if (!['conservative', 'active'].includes(name)) return bad(res, 'name');
    const c = name === 'conservative';
    const pro = st.user.plan === 'pro';
    st.settings.levels.min_quality = c ? 7 : 5;
    Object.assign(st.settings.trading, { trade_risk_pct: c ? 0.5 : 1.5, trade_leverage: c ? 5 : 10, max_trades_limit: c ? 3 : 5 });
    if (c) st.settings.trading.auto_trade_mode = 'confirm';
    st.settings.risk.allow_counter_trend = !c;
    st.me.prefs.quiet_start = c ? 23 : -1; st.me.prefs.quiet_end = c ? 7 : -1;
    const applied = ['levels.min_quality', 'trade_risk_pct', 'trade_leverage', 'max_trades_limit', 'allow_counter_trend', 'levels_counter_trend_min_quality', 'quiet_hours', 'strategy.LEVELS'];
    const skipped = [];
    if (pro) { st.settings.volume.min_quality = c ? 4 : 3; applied.push('volume.min_quality', 'strategy.SMC'); if (!c) applied.push('strategy.VOLUME'); } else skipped.push('volume.min_quality', 'strategy.SMC', 'strategy.VOLUME');
    if (c) applied.push('auto_trade_mode');
    res.json({ ok: true, profile: name, applied, skipped, settings: clone(st.settings) });
  });
  router.post('/exchange/keys', (req, res) => {
    const st = req.st, b = req.body || {};
    if (st.user.plan !== 'pro') return res.json({ ok: false, error: 'pro_required' });
    const ex = String(b.exchange || '').toLowerCase();
    if (!EXCHANGES.includes(ex)) return bad(res, 'exchange');
    if (String(b.api_key || '').length < 10) return bad(res, 'api_key');
    if (String(b.api_secret || '').length < 10) return bad(res, 'api_secret');
    if (ex === 'okx' && String(b.passphrase || '').length < 4) return bad(res, 'passphrase');
    if (/invalid/i.test(b.api_key)) return res.json({ ok: false, error: 'invalid_keys', message: 'Биржа отклонила ключи: проверьте права API и IP-ограничения.' });
    const k = String(b.api_key);
    st.settings.exchanges[ex] = { connected: true, key_hint: `${k.slice(0, 4)}…${k.slice(-2)}` };
    st.settings.trading.trade_exchange = ex; st.me.exchange = ex;
    res.json({ ok: true, exchange: ex, key_hint: st.settings.exchanges[ex].key_hint, balance_usdt: 1532.18 });
  });
  router.post('/exchange/keys/remove', (req, res) => {
    const st = req.st, ex = String((req.body || {}).exchange || '').toLowerCase();
    if (!EXCHANGES.includes(ex)) return bad(res, 'exchange');
    st.settings.exchanges[ex] = { connected: false, key_hint: '' };
    if (st.settings.trading.trade_exchange === ex) { st.settings.trading.auto_trade = false; st.me.auto_trade = false; }
    res.json({ ok: true });
  });
  router.get('/positions', (req, res) => {
    const st = req.st;
    res.json({ ok: true, exchange: st.settings.trading.trade_exchange || 'bybit', positions: clone(st.positions), orders_count: st.positions.length ? 4 : 0 });
  });
  router.post('/feedback', (req, res) => {
    const st = req.st, b = req.body || {};
    const map = { bug: 'bug', idea: 'feature', other: 'question' };
    if (!map[String(b.type || '').toLowerCase()]) return bad(res, 'type');
    const text = String(b.text || '').trim();
    if (text.length < 10 || text.length > 2000) return bad(res, 'text');
    if (++st.feedbackToday > 5) return res.json({ ok: false, error: 'rate_limited' });
    res.json({ ok: true, id: 1041 + st.feedbackToday });
  });
  router.get('/plan', (req, res) => {
    const st = req.st, u = st.me.user;
    res.json({ ok: true, plan: u.plan, plan_label: u.plan_label, sub_expires: u.sub_expires,
      days_left: u.is_pro ? Math.max(0, Math.floor((u.sub_expires - now()) / 86400)) : 0, price_usd: 69, features: PLAN_FEATURES_RU, admin_contact: '@crypto_chm' });
  });
  router.get('/stats', (req, res) => {
    const st = req.st;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const strat = STRATS.includes(String(req.query.strategy || '').toUpperCase()) ? String(req.query.strategy).toUpperCase() : '';
    const pro = st.user.plan === 'pro';
    const rnd = seeded(`stats${days}${pro ? 'p' : 'f'}`);
    const n = st.user.empty ? 0 : Math.round((pro ? 42 : 14) * days / 30);
    const keys = pro ? STRATS : ['LEVELS'];
    const blankStat = () => ({ trades: 0, wins: 0, losses: 0, be: 0, total_rr: 0, win_rate: 0, winR: 0, lossR: 0 });
    const sum = blankStat(), byS = {}, byH = { asia: blankStat(), europe: blankStat(), us: blankStat() }, byW = [], eq = [];
    const byTf = {}, bySrc = { exchange: blankStat(), signals: blankStat() }, byCtx = { aligned: blankStat(), with: blankStat(), counter: blankStat(), strong_counter: blankStat() }, bySym = {};
    let cum = 0, pnl = 0;
    for (let w = 0; w < 7; w++) byW.push(blankStat());
    for (const k of keys) byS[k] = blankStat();
    const SYMS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LINK'];
    for (let i = 0; i < n; i++) {
      const k = keys[Math.floor(rnd() * keys.length)];
      const x = rnd();
      let r = x < 0.46 ? -1 : x < 0.53 ? 0 : x < 0.78 ? 1.5 : x < 0.93 ? 2.5 : 3.5;
      if (r === 1.5 && rnd() < 0.3) r = 0.6;
      const sess = x < 0.3 ? 'asia' : x < 0.62 ? 'europe' : 'us';
      const wd = Math.floor(rnd() * 7), tf = ['15m', '1h', '4h'][Math.floor(rnd() * 3)], sym = SYMS[Math.floor(rnd() * SYMS.length)];
      const src = pro && rnd() < 0.5 ? 'exchange' : 'signals', ctx = ['aligned', 'with', 'counter', 'strong_counter'][Math.floor(rnd() * 4)];
      if (strat && k !== strat) { byS[k].trades++; continue; }
      byTf[tf] = byTf[tf] || blankStat(); bySym[sym] = bySym[sym] || Object.assign(blankStat(), { symbol: sym });
      for (const b of [sum, byS[k], byH[sess], byW[wd], byTf[tf], bySrc[src], byCtx[ctx], bySym[sym]]) {
        b.trades++; b.total_rr += r;
        if (r > 0) { b.wins++; b.winR += r; } else if (r < 0) { b.losses++; b.lossR += -r; } else b.be++;
      }
      cum += r; pnl += r * 18.4;
      eq.push({ t: now() - days * 86400 + Math.floor((i + 1) / (n + 1) * days * 86400), r: round2(cum) });
    }
    const fin = (b) => { if (b.trades) b.win_rate = Math.round(b.wins / b.trades * 1000) / 10; b.total_rr = round2(b.total_rr); b.avg_rr = b.trades ? round2(b.total_rr / b.trades) : 0; b.profit_factor = b.lossR ? round2(b.winR / b.lossR) : (b.winR ? 99 : 0); const nb = b.wins + b.losses; b.ev = nb >= 5 ? round2((b.wins / nb) * (b.wins ? b.winR / b.wins : 0) - (1 - b.wins / nb) * (b.losses ? b.lossR / b.losses : 0)) : null; b.pnl_usd = round2(b.total_rr * 18.4); delete b.winR; delete b.lossR; return b; };
    for (const g of [sum, ...Object.values(byS), ...Object.values(byH), ...byW, ...Object.values(byTf), ...Object.values(bySrc), ...Object.values(byCtx), ...Object.values(bySym)]) fin(g);
    const syms = Object.values(bySym);
    res.json({ ok: true, days, summary: Object.assign(sum, { pnl_usd: round2(pnl) }), filters: { strategy: strat, tf: '', timeframes: Object.keys(byTf) },
      by_strategy: byS, by_session: byH, by_weekday: byW, equity: eq,
      by_symbol: { best: syms.filter((s) => s.total_rr > 0).sort((a, b) => b.total_rr - a.total_rr).slice(0, 5), worst: syms.filter((s) => s.total_rr < 0).sort((a, b) => a.total_rr - b.total_rr).slice(0, 5) },
      by_timeframe: byTf, by_source: bySrc, by_context: byCtx });
  });
  router.post('/share', (req, res) => {
    const st = req.st;
    const t = Date.now();
    st.shareTimes = st.shareTimes.filter((x) => t - x < 600e3);
    if (st.shareTimes.length >= 3) return res.json({ ok: false, error: 'rate_limited' });
    const stats = st.stats30();
    if (!stats.signals) return res.json({ ok: false, error: 'no_data' });
    st.shareTimes.push(t);
    const days = Math.max(7, Math.min(365, parseInt((req.body || {}).days, 10) || 30));
    res.json({ ok: true, sent: false, days, stats });
  });
  router.get('/help', (req, res) => {
    res.json({ ok: true, lang: req.st.settings.lang, sections: HELP_SECTIONS.map(([id, title], i) => ({ id, number: String(i + 1).padStart(2, '0'), title,
      text: `${title}\n\n1. Коротко. CHM Breaker сканирует рынок и присылает сигналы с входом, стопом и целями.\n• Вход — цена входа\n• SL — стоп, 1R — расстояние от входа до стопа\n\n/start — открыть меню\n/stats — статистика` })) });
  });
  router.post('/lang', (req, res) => {
    const st = req.st, lang = String((req.body || {}).lang || '');
    if (!['ru', 'en'].includes(lang)) return bad(res, 'lang');
    st.settings.lang = lang; st.me.user.lang = lang;
    res.json({ ok: true, lang });
  });
  // [CHALLENGE]
  const chState = (st) => ({ ok: true, available: st.user.plan === 'pro', active: !!st.challenge && st.challenge.status === 'active',
    challenge: st.challenge, plan: st.challenge ? st.challenge._plan : null, progress: st.challenge ? st.challenge._progress : null,
    options: { terms: ['2w', '1m', '3m', 'none'], strategies: STRATS, modes: ['signals', 'auto'] } });
  function buildCh(st, a) {
    const bad = (k) => { const e = new Error(k); e.field = k; return e; };
    const f = (k, lo, hi) => { const v = Number(a[k]); if (!isFinite(v) || v < lo || v > hi) throw bad(k); return v; };
    const deposit = f('deposit', 10, 1e7);
    const goal_kind = ['usd', 'pct'].includes(a.goal_kind) ? a.goal_kind : (() => { throw bad('goal_kind'); })();
    const goal_value = goal_kind === 'pct' ? f('goal_value', 1, 1000) : f('goal_value', deposit + 1e-9, deposit * 100);
    const term = ['2w', '1m', '3m', 'none'].includes(a.term) ? a.term : (() => { throw bad('term'); })();
    const risk_pct = f('risk_pct', 0.1, 10), leverage = f('leverage', 1, 125), max_trades_day = f('max_trades_day', 0, 100);
    const daily_loss_pct = f('daily_loss_pct', 0, 50), topup_monthly = f('topup_monthly', 0, 1e7);
    const strategies = Array.isArray(a.strategies) ? a.strategies.filter((s) => STRATS.includes(s)) : [];
    if (!strategies.length) throw bad('strategies');
    const mode = ['signals', 'auto'].includes(a.mode) ? a.mode : (() => { throw bad('mode'); })();
    const goal_usd = goal_kind === 'pct' ? deposit * (1 + goal_value / 100) : goal_value;
    const goal_profit_usd = Math.max(0, goal_usd - deposit), risk_usd = deposit * risk_pct / 100;
    const r_needed = Math.round(goal_profit_usd / risk_usd * 10) / 10;
    const days = { '2w': 14, '1m': 30, '3m': 90, none: null }[term];
    const ch = { user_id: st.user.id, started_at: now(), deposit, goal_kind, goal_value, deadline_ts: days ? now() + days * 86400 : null, risk_pct, leverage,
      max_trades_day, daily_loss_pct, topup_monthly, strategies, mode, status: 'active', finished_at: null, topups: [], daily_stop: null, term,
      goal_usd, goal_profit_usd, risk_usd, r_needed, topups_total: 0, daily_loss_r: daily_loss_pct / risk_pct };
    const margin_pct = (risk_pct / 100 / 0.015) / leverage * 100;
    const warnings = [];
    if (risk_pct >= 3) warnings.push('risk_high');
    if (100 / leverage < 3) warnings.push('liquidation_near');
    if (margin_pct > 100) warnings.push('margin_over_deposit');
    if (daily_loss_pct > 0 && daily_loss_pct < risk_pct) warnings.push('daily_limit_below_risk');
    const stats = st.stats30();
    const r_per_day = stats.total_rr / 30;
    const verdict = stats.trades >= 10 && r_per_day > 0 ? (days === null || r_needed / r_per_day <= days ? 'ok' : r_needed / r_per_day <= 2 * days ? 'tight' : 'unrealistic') : stats.trades >= 10 ? 'negative' : 'no_data';
    ch._plan = { profit_usd: goal_profit_usd, r_needed, risk_usd, margin_pct: round2(margin_pct), verdict, warnings,
      days_forecast: r_per_day > 0 ? Math.round(r_needed / r_per_day) : null, hist_r_per_day: round2(r_per_day), r_per_day_needed: days ? round2(r_needed / Math.max(days, 1)) : null, days_left: days };
    ch._progress = { r_total: 0, pnl_usd: 0, pct_goal: 0, deposit_now: deposit, topups_total: 0, days_elapsed: 0, days_left: days, expected_r: 0, pace_r: 0,
      today_signals: 0, today_r: 0, today_left: max_trades_day || null, blocked: false, block_reason: null, win_rate: stats.win_rate, trades: 0, best_rr: null, day: 1, equity: [] };
    return ch;
  }
  router.get('/challenge', (req, res) => res.json(chState(req.st)));
  router.post('/challenge', (req, res) => {
    const st = req.st, b = req.body || {};
    if (st.user.plan !== 'pro') return res.json({ ok: false, error: 'pro_required' });
    let ch;
    try { ch = buildCh(st, b); } catch (e) { return res.json({ ok: false, error: 'bad_request', field: String(e.field || e.message) }); }
    if (b.preview) return res.json({ ok: true, preview: true, challenge: ch, plan: ch._plan });
    if (st.challenge && st.challenge.status === 'active' && !b.replace) return res.json({ ok: false, error: 'already_active' });
    st.challenge = ch;
    st.settings.trading.trade_risk_pct = ch.risk_pct; st.settings.trading.trade_leverage = ch.leverage;
    res.json(Object.assign(chState(st), { applied: ['trade_risk_pct', 'trade_leverage', ...ch.strategies.map((s) => `strategy.${s}`)], skipped: ch.mode === 'auto' && !st.me.exchange ? ['auto_trade'] : [] }));
  });
  router.post('/challenge/topup', (req, res) => {
    const st = req.st, amount = Number((req.body || {}).amount);
    if (!st.challenge || st.challenge.status !== 'active') return res.status(404).json({ ok: false, error: 'not_found' });
    if (!isFinite(amount) || amount < 1 || amount > 1e7) return bad(res, 'amount');
    st.challenge.topups.push({ ts: now(), amount }); st.challenge.topups_total += amount; st.challenge._progress.topups_total += amount; st.challenge._progress.deposit_now += amount;
    res.json(chState(st));
  });
  router.post('/challenge/finish', (req, res) => {
    const st = req.st;
    if (!st.challenge || st.challenge.status !== 'active') return res.status(404).json({ ok: false, error: 'not_found' });
    st.challenge.status = 'cancelled'; st.challenge.finished_at = now();
    res.json(chState(st));
  });
  router.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  return router;
}

// ----------------------------------------------------------------------------- server
function createStubServer({ staticDir, telegram = true, telegramUsername } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const auth = createAuthStub({ telegram, telegramUsername });
  app.use('/api/auth', auth.router);
  app.use('/api/app', createAppStub({ userForToken: auth.userForToken }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', stub: true }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route not found', code: 'NOT_FOUND' }));
  const root = staticDir || path.join(__dirname, '..', '..', 'frontend');
  // Same contract as server.js: express.static serves ~/public_html (= frontend/), so
  // /app/ resolves to frontend/app/index.html; other paths fall back to index.html.
  app.use(express.static(root));
  app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
  app.locals.auth = auth;
  return app;
}

module.exports = { createAppStub, createAuthStub, createStubServer, buildUserState, STRATS, EXCHANGES };
