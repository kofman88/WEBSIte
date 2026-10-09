/**
 * adv_replay — the JS side of the adversarial three-scanner differential (py/adv_drive.py).
 *
 * Rebuilds the driver's world from the fixture (mutated golden market, users as the bot stored
 * them, kv, optimizer_params, exchange listings, per-tick seeds) and runs the site's modules
 * the way the engine worker wires them: ONE registry / freeReport / confluence / freshness /
 * momentum / trend monitor / coin blacklist / candle cache / REST fetcher shared by the three
 * scanners; delivery through signalDelivery.createSignalDelivery + localFacade (LEVELS / VOLUME
 * via scheduler.siteSafeSend + siteRememberSignalMessage, SMC via deliver, trend broadcasts via
 * sendText); engine_kv through engineKvService; optimizer_params through genome/store.
 *
 * Only the bot's network / exchange edges are faked (the same rules as the driver): the clock,
 * MINSTD randint, the notifier (= Telegram: message_id = FNV-1a(uid|text|kb), BOT_FAIL users are
 * not deliverable), REST candles / pairs, auto-trade results, balances, charts, metrics, smart
 * prompts, the fundamental block and the cached market regime.
 *
 * replay(FIX) → the same observation shapes as the driver's `expected`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const BACKEND = path.join(__dirname, '..', '..', '..', '..');
const GOLDEN = path.join(BACKEND, 'tests', 'golden', 'candles');
const req = (p) => require(path.join(BACKEND, p));

const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const TF_FILE = { '15m': '15m', '1h': '1h', '1H': '1h', '4h': '4h', '4H': '4h', '1d': '1d', '1D': '1d' };

function loadFixture(file) {
  const raw = fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
}

/** FNV-1a 32 over the UTF-8 bytes (the driver's fnv). */
function fnv(s) {
  let h = 0x811C9DC5;
  for (const b of Buffer.from(s, 'utf8')) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":")) */
function canon(x) {
  if (x === null || x === undefined) return 'null';
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** The driver's market: golden bars + MUTATIONS in order; sha1 of the float64 LE bytes per series. */
function buildMarket(FIX) {
  const raw = new Map();
  for (const s of FIX.symbols) {
    for (const tf of ['15m', '1h', '4h', '1d']) {
      const fx = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${s}_${tf}.json`), 'utf8'));
      raw.set(`${s}|${tf}`, fx.bars.map((b) => b.map(Number)));
    }
  }
  for (const m of FIX.mutations) {
    const [op, sym, tf] = m;
    const key = `${sym}|${tf}`;
    const bars = raw.get(key);
    if (op === 'gap') raw.set(key, bars.filter((b) => !(m[3] <= b[0] && b[0] < m[4])));
    else if (op === 'flat') {
      bars.forEach((b, i) => {
        if (m[3] <= b[0] && b[0] < m[4]) {
          const pc = bars[i - 1][4];
          b[1] = pc; b[2] = pc; b[3] = pc; b[4] = pc; b[5] = 0.0;
        }
      });
    } else if (op === 'spike') {
      for (const b of bars) if (b[0] === m[3]) { b[2] *= m[4]; b[3] *= m[5]; b[5] *= m[6]; }
    } else if (op === 'closemul') {
      for (const b of bars) {
        if (m[3] <= b[0] && b[0] < m[4]) {
          b[4] *= m[5];
          b[2] = Math.max(b[2], b[4]);
          b[3] = Math.min(b[3], b[4]);
        }
      }
    } else if (op === 'jump') {
      for (const b of bars) if (b[0] >= m[3]) { b[1] *= m[4]; b[2] *= m[4]; b[3] *= m[4]; b[4] *= m[4]; }
    } else if (op === 'listing') raw.set(key, bars.filter((b) => b[0] >= m[3]));
    else if (op === 'volzero') {
      for (const b of bars) if (m[3] <= b[0] && b[0] < m[4]) b[5] = 0.0;
    } else throw new Error(`unknown mutation ${op}`);
  }
  const digest = {};
  for (const key of [...raw.keys()].sort()) {
    const flat = Float64Array.from(raw.get(key).flat());
    digest[key] = crypto.createHash('sha1').update(Buffer.from(flat.buffer)).digest('hex');
  }
  return { raw, digest };
}

function makeFrameAt(market) {
  const { Frame } = req('strategies/common/frame');
  return function frameAt(sym, tf, nowS, limit = 300) {
    const t = TF_FILE[tf];
    if (t === undefined) return null;
    const bars = market.raw.get(`${sym}|${t}`);
    if (!bars || !bars.length) return null;
    const nowMs = Math.trunc(nowS * 1000);
    let n = 0;
    while (n < bars.length && bars[n][0] + TF_MS[t] <= nowMs) n += 1;
    const sub = limit ? bars.slice(Math.max(0, n - limit), n) : bars.slice(0, n);
    if (!sub.length) return null;
    const f = Frame.fromBars(sub);
    f.symbol = sym; f.tf = t;
    return f;
  };
}

/** The driver's Seq: MINSTD, draws listed in `stuck` repeat the previous value. */
class Seq {
  constructor(seed, stuck = []) { this.s = seed; this.k = 0; this.last = null; this.stuck = new Set(stuck); }
  randint(a, b) {
    let v;
    if (this.stuck.has(this.k) && this.last !== null) v = this.last;
    else {
      this.s = (this.s * 48271) % 2147483647;
      v = a + (this.s % (b - a + 1));
    }
    this.k += 1;
    this.last = v;
    return v;
  }
}

function logCapture() {
  const lines = [];
  const make = (name) => ({
    debug() {},
    info(m) { lines.push([name, 'INFO', String(m)]); },
    warning(m) { lines.push([name, 'WARNING', String(m)]); },
    warn(m) { lines.push([name, 'WARNING', String(m)]); },
    error(m) { lines.push([name, 'ERROR', String(m)]); },
    exception(m) { lines.push([name, 'ERROR', String(m)]); },
  });
  return { lines, make };
}

/** JSON-normalise a value (non-finite floats like the driver's encoder, Maps → objects). */
function norm(x) {
  return JSON.parse(JSON.stringify(x, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $f: Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf') };
    if (v instanceof Map) return Object.fromEntries(v);
    if (v instanceof Set) return [...v].sort();
    return v;
  }));
}

async function replay(FIX, { onTick = null } = {}) {
  const db = req('models/database.js');
  const ts = req('services/traderSettingsService.js');
  const kvSvc = req('services/engineKvService.js');
  const candleCache = req('services/marketData/candleCache.js');
  const exSym = req('services/exchanges/exchangeSymbols.js');
  const store = req('services/genome/store.js');
  const OP = req('services/genome/optimizerParams.js');
  const { createSignalRegistry } = req('services/engine/signalRegistry.js');
  const { createFreshness } = req('services/engine/signalFreshness.js');
  const { createMomentumVeto } = req('services/engine/momentumVeto.js');
  const { createMomentumDetector } = req('services/engine/momentumDetector.js');
  const { createTrendMonitor } = req('services/engine/trendMonitor.js');
  const { createSignalConfluence } = req('services/engine/signalConfluence.js');
  const { createCoinQualityLearner } = req('services/engine/coinQualityLearner.js');
  const { createFreeReport } = req('services/engine/freeReport.js');
  const { createSignalTradesRepo } = req('services/engine/signalTradesRepo.js');
  const { createSignalDelivery, localFacade } = req('services/engine/signalDelivery.js');
  const scheduler = req('services/engine/scheduler.js');
  const quietHours = req('services/engine/quietHours.js');
  const { regimeAllowsDirection } = req('services/engine/regimeLoop.js');
  const LS = req('services/engine/levelsScanner.js');
  const { createSmcScanner } = req('services/engine/smcScanner.js');
  const VS = req('services/engine/volumeScanner.js');
  const { toTelegram } = req('services/engine/cards/keyboards.js');

  const market = buildMarket(FIX);
  const frameAt = makeFrameAt(market);
  const clock = { t: FIX.start_t, now() { return this.t; }, monotonic() { return this.t; } };
  const now = () => clock.t;
  const cap = logCapture();
  req('services/engine/tradeCfg.js').setLog(cap.make('CHM.Users'));     // user_manager's logger
  req('services/engine/smcUserCfg.js').setLog(cap.make('CHM.Users'));
  const quiet = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };
  const seq = new Seq(FIX.seq.seed, FIX.seq.stuck);
  const SLEEPS = [];
  const fakeSleep = async (ms) => { SLEEPS.push(Math.round((ms / 1000) * 1e6) / 1e6); await new Promise((r) => setImmediate(r)); };

  // ── DB: users / trader_settings exactly as the bot stored them, kv, optimizer_params ──
  for (const t of ['signal_trades', 'trade_events', 'engine_kv', 'optimizer_params', 'notifications', 'trader_settings', 'users']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_e) { /* table may not exist */ }
  }
  const cols = new Set(ts.COLUMNS);
  for (const row of FIX.users) {
    db.prepare('INSERT INTO users (id, email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(row.user_id, `u${row.user_id}@adv.test`, 'x', `ADV${row.user_id}`, row.user_id === 123 ? 1 : 0);
    const keys = Object.keys(row).filter((k) => k === 'user_id' || cols.has(k));
    db.prepare(`INSERT INTO trader_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => (typeof row[k] === 'boolean' ? Number(row[k]) : row[k])));
  }
  ts.invalidateCache();
  for (const [k, v] of Object.entries(FIX.kv_init)) kvSvc.set(k, v, { now: clock.t });
  for (const [uid, strat, p] of FIX.opt_init) {
    db.prepare('INSERT OR REPLACE INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (?, ?, ?, ?)').run(uid, strat, p, clock.t);
  }
  if (typeof store._clearParamsCache === 'function') store._clearParamsCache();
  const kvBase = new Map(db.prepare('SELECT key, value FROM engine_kv').all().map((r) => [r.key, r.value]));
  for (const k of Object.keys(FIX.kv_init)) kvBase.delete(k);
  const um = {
    getActiveUsers: () => ts.getActiveUsers({ now: clock.t }),
    allUsers: () => ts.allUsers({ now: clock.t }),
    save: (u) => ts.save(u, { now: clock.t }),
    get: (uid) => ts.get(uid),
  };

  // ── market data ──
  candleCache._resetForTests();
  candleCache.initCache(FIX.meta.cache_max, { now, log: quiet });
  exSym._resetForTests();
  for (const [ex, natives] of Object.entries(FIX.exchange_symbols)) exSym._setSymbols(ex, natives, { updatedAt: FIX.start_t });
  const REST_MODE = new Map(FIX.rest_mode.map(([s, tf, m]) => [`${s}|${tf}`, m]));
  const CACHE_MODE = new Map(FIX.cache_mode.map(([s, tf, m]) => [`${s}|${tf}`, m]));
  const fetcher = {
    volBySym: {},
    calls: [],
    _pairs: new Map(),
    async getCandles(symbol, tf, limit = 300) {
      this.calls.push(['candles', symbol, tf, Math.trunc(limit)]);
      const mode = REST_MODE.get(`${symbol}|${tf}`);
      if (mode === 'raise') throw new Error('rest down');
      if (mode === 'none') return null;
      return frameAt(symbol, tf, clock.t, Math.trunc(limit));
    },
    async getAllUsdtPairs(minVolumeUsdt = 1_000_000, blacklist = null, maxCoins = 0) {
      const bl = Array.from(blacklist || []);
      const key = `pairs_${pyNum(minVolumeUsdt)}_${maxCoins}_${bl.slice().sort().join(',').slice(0, 200)}`;
      const hit = this._pairs.get(key);
      if (hit && clock.t - hit.ts < 120) {
        this.calls.push(['pairs_cached', Number(minVolumeUsdt), Math.trunc(maxCoins)]);
        return hit.coins.slice();
      }
      this.calls.push(['pairs', Number(minVolumeUsdt), Math.trunc(maxCoins)]);
      const items = Object.entries(FIX.volumes).filter(([s, v]) => v >= minVolumeUsdt && !bl.includes(s));
      items.sort((a, b) => b[1] - a[1]);
      this.volBySym = Object.fromEntries(items);
      let coins = items.map(([s]) => s);
      if (maxCoins && maxCoins > 0) coins = coins.slice(0, maxCoins);
      this._pairs.set(key, { ts: clock.t, coins: coins.slice() });
      return coins;
    },
    async getGlobalTrend() {
      this.calls.push(['global_trend']);
      return { BTC: { trend_text: 'H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓' }, ETH: { trend_text: 'H1: ⚪' } };
    },
  };
  function pyNum(v) {   // str(float) of the pairs-cache key (the driver passes ints / floats)
    return Number.isInteger(v) ? String(v) : String(v);
  }

  // ── shared pipeline state (the bot's module globals) ──
  const repo = createSignalTradesRepo({ db, now, log: cap.make('CHM.DB') });
  const registry = createSignalRegistry({ kv: kvSvc, now, log: cap.make('CHM.SignalRegistry') });
  const freshness = createFreshness({ env: {}, getCandles: (s, tf) => candleCache.getCandles(s, tf), log: cap.make('CHM.SignalFreshness') });
  const veto = createMomentumVeto({});
  const momentum = createMomentumDetector({ now, log: cap.make('CHM.Momentum') });
  const confluence = createSignalConfluence({ now });
  const coinQuality = createCoinQualityLearner({ now, kv: kvSvc, log: cap.make('CHM.CoinQuality') });
  const freeReport = createFreeReport({ kv: kvSvc, now, log: cap.make('CHM.FreeReport') });
  let regimeNow = null;
  let regimeAt = 0;
  const regime = {
    getCachedRegime: () => (regimeNow === null ? null : (clock.t - regimeAt > 4 * 3600 ? null : regimeNow)),
    regimeAllowsDirection,
  };
  const clockStore = { loadOptimizerParams: (uid, s) => store.loadOptimizerParams(uid, s, { now }) };

  // ── delivery (the main-thread side) over a fake notifier = Telegram ──
  const FAIL = new Set(FIX.bot_fail);
  const sent = [];
  let pendingKb = null;
  const notifier = {
    async dispatch(uid, opts) {
      if (FAIL.has(Number(uid))) return { dispatched: false, error: 'user_not_found' };
      const kb = pendingKb;
      const id = 10000 + (fnv(`${Number(uid)}|${opts.body}|${canon(kb)}`) % 90000000);
      return { dispatched: true, notificationId: id };
    },
  };
  const delivery = createSignalDelivery({ notifier, sse: null, repo, db, log: cap.make('CHM.Delivery'), tgLog: cap.make('CHM.TgSafe') });
  const facade0 = localFacade(delivery);
  const charts = [];
  const bot = {
    ...facade0,
    async sendMessage(uid, text, kw = {}) {
      const kb = kw.replyMarkup ? toTelegram(kw.replyMarkup) : null;
      const rec = { uid: Number(uid), text, parse_mode: kw.parseMode === undefined ? null : kw.parseMode, kb,
        protect: Boolean(kw.protectContent), silent: Boolean(kw.disableNotification) };
      sent.push(rec);
      pendingKb = kb;
      try {
        const m = await facade0.sendMessage(uid, text, kw);
        rec.ok = true;
        rec.message_id = m.message_id;
        return m;
      } catch (e) {
        rec.ok = false;
        throw e;
      }
    },
    async deliver(msg) {
      const kb = msg.keyboard ? toTelegram(msg.keyboard) : null;
      const rec = { uid: Number(msg.userId), text: msg.text, parse_mode: 'HTML', kb, protect: Boolean(msg.protect), silent: Boolean(msg.silent) };
      sent.push(rec);
      pendingKb = kb;
      const ok = await facade0.deliver(msg);
      rec.ok = Boolean(ok);
      if (ok) rec.message_id = 10000 + (fnv(`${Number(msg.userId)}|${msg.text}|${canon(kb)}`) % 90000000);
      return ok;
    },
    async sendText(uid, text, opts = {}) {
      const kb = opts.keyboard ? toTelegram(opts.keyboard) : null;
      const rec = { uid: Number(uid), text, parse_mode: 'HTML', kb, protect: false, silent: Boolean(opts.silent) };
      sent.push(rec);
      pendingKb = kb;
      const ok = await facade0.sendText(uid, text, opts);
      rec.ok = Boolean(ok);
      if (ok) rec.message_id = 10000 + (fnv(`${Number(uid)}|${text}|${canon(kb)}`) % 90000000);
      return ok;
    },
    deliverChart(msg) {
      charts.push({ uid: Number(msg.userId), strategy: msg.strategy, lang: msg.lang, symbol: msg.symbol, bars: msg.bars,
        last: msg.lastTs === undefined ? null : msg.lastTs, pivots: [], hvn: [], lvn: [], extra: msg.extra === undefined ? null : msg.extra });
      return true;
    },
  };

  // ── the bot's exchange / UI edges ──
  const atCalls = [];
  const metricCalls = [];
  const prompts = [];
  const symRule = (uid, symbol) => {
    const rules = FIX.at_rules[String(uid)] || ['none'];
    let s = 0;
    for (const ch of String(symbol)) s += ch.codePointAt(0);
    return rules[s % rules.length];
  };
  async function executeAutoTrade(kw) {
    const rec = { ...kw };
    delete rec.bot;
    delete rec.user;   // the site hands its auto-trade port the user row as well (no bot kwarg)
    atCalls.push(rec);
    const mode = symRule(kw.user_id, kw.symbol || '');
    if (mode === 'raise') throw new Error('exchange down');
    if (mode === 'exec') return { executed: true, show_trade_btn: false, limit_msg: null };
    if (mode === 'btn') return { executed: false, show_trade_btn: true, limit_msg: null };
    if (mode === 'limit') return { executed: false, show_trade_btn: false, limit_msg: FIX.limit_msg[Number(kw.user_id) % 2 ? 'en' : 'ru'] };
    return { executed: false, show_trade_btn: false, limit_msg: null };
  }
  const keyOf = (user, exchange) => {
    const k = FIX.api_keys[String(user.user_id)];
    if (!k) return null;
    const pre = ({ bingx: 'bingx', binance: 'binance', okx: 'okx' })[k[0]] || 'bybit';
    const want = ({ bingx: 'bingx', binance: 'binance', okx: 'okx' })[exchange] || 'bybit';
    return pre === want ? { apiKey: k[1], apiSecret: k[2] } : null;
  };
  const getBalance = async (user) => {
    const v = FIX.balances[String(user.user_id)];
    if (v === 'raise') throw new Error('balance api down');
    return v === undefined ? null : v;
  };
  const recordChart = (_bot, user, sig, df, o = {}) => {
    charts.push({ uid: Number(user.user_id), strategy: o.strategy, lang: o.lang, symbol: sig.symbol,
      bars: df ? df.length : 0, last: df && df.length ? df.t[df.length - 1] : null,
      pivots: (o.pivotLevels || []).map(Number), hvn: (o.hvnLevels || []).map(Number), lvn: (o.lvnLevels || []).map(Number),
      extra: o.extraSignalData === undefined ? null : o.extraSignalData });
  };
  const metrics = { record: async (name, value, tags) => { metricCalls.push([name, Number(value === undefined ? 1.0 : value), { ...(tags || {}) }]); } };
  const FUND = { block: '' };
  const siteSafeSend = scheduler.siteSafeSend({ log: cap.make('CHM.TgSafe'), sleep: fakeSleep });

  const trend = createTrendMonitor({
    env: {}, kv: kvSvc, now, log: cap.make('CHM.TrendMonitor'), cache: candleCache, fetcher,
    sleep: fakeSleep,
    getUsers: () => ts.getActiveUsers({ now: clock.t }),
    isQuiet: (user, t) => quietHours.isQuiet(user, t),
    send: (uid, text, o = {}) => bot.sendText(uid, text, { ...o, type: 'trend', safe: true }),   // as scheduler.installTrendMonitor
  });

  LS._resetModuleStateForTests();
  const levels = new LS.MidScanner({ SCAN_WORKERS: FIX.meta.scan_workers, PAYMENT_ADDRESS: '' }, bot, um, null, {
    clock, sleep: fakeSleep, random: seq, env: {},
    log: cap.make('CHM.Scanner'), indicatorLog: cap.make('CHM.Indicator'), tgLog: cap.make('CHM.TgSafe'),
    fetcher, cache: candleCache, registry, freshness, veto, momentum, regime, trend, confluence, coinQuality, freeReport,
    exchangeSymbols: exSym, repo, kv: kvSvc, optimizerStore: clockStore,
    safeSendMessage: siteSafeSend, rememberSignalMessage: scheduler.siteRememberSignalMessage,
    executeAutoTrade, getApiKeys: keyOf, getBalance, sendChart: recordChart, metrics,
    fundamental: { getMarketContextBlock: async () => FUND.block },
  });
  levels.fetcher = fetcher;

  const smc = createSmcScanner({
    um, fetcher, cache: candleCache, registry, freeReport, trend, confluence, freshness, momentumVeto: veto,
    coinQuality, regime, momentum, repo,
    optimizer: { smcOptimizerFilters: (u, d) => OP.smcOptimizerFilters(u, { ...(d || {}), store: clockStore, getRegime: () => regime.getCachedRegime() }) },
    exchangeSymbols: exSym,
    deliver: (msg) => bot.deliver(msg),
    deliverChart: (msg) => bot.deliverChart(msg),
    executeAutoTrade,
    userApiKeys: (u, ex) => keyOf(u, ex) || { apiKey: '', apiSecret: '' },
    getBalance,
    fundBlock: async () => FUND.block,
    smartPromptQuota: (uid) => { prompts.push(Number(uid)); },
    metrics,
    randint: (a, b) => seq.randint(a, b),
    sleep: fakeSleep,
    now, mono: () => clock.t * 1000, env: {},
    log: cap.make('CHM.SMC.Scanner'), builderLog: cap.make('CHM.SMC.SignalBuilder'), volFilterLog: cap.make('CHM.VolumeFilter'),
  });

  const vol = VS.createVolumeScanner({
    clock, sleep: fakeSleep, random: seq, env: {},
    log: cap.make('CHM.VolumeScanner'), filterLog: cap.make('CHM.VolumeFilter'), strategyLog: cap.make('CHM.VolumeStrategy'),
    tgLog: cap.make('CHM.TgSafe'),
    cache: candleCache, trend, registry, freshness, confluence, coinQuality, exchangeSymbols: exSym, repo, kv: kvSvc,
    metrics, executeAutoTrade, getApiKeys: keyOf, getBalance, sendChart: recordChart,
    safeSendMessage: siteSafeSend, rememberSignalMessage: scheduler.siteRememberSignalMessage,
  });

  coinQuality.restoreFromKv();
  freeReport.loadPersistentBuffers();
  trend.loadState();
  const kvAfterSetup = {};
  for (const r of db.prepare('SELECT key, value FROM engine_kv').all()) if (kvBase.get(r.key) !== r.value) kvAfterSetup[r.key] = r.value;
  cap.lines.length = 0;
  SLEEPS.length = 0;

  const tradeCols = db.prepare('SELECT * FROM signal_trades LIMIT 0').columns().map((c) => c.name);
  const userCols = db.prepare('SELECT * FROM trader_settings LIMIT 0').columns().map((c) => c.name);
  const tradeIds = () => db.prepare('SELECT trade_id FROM signal_trades ORDER BY rowid').all().map((r) => r.trade_id);
  const regFile = () => kvSvc.get('signal_registry');

  const out = [];
  for (const tk of FIX.ticks) {
    clock.t = tk.t;
    const steps = [];
    let mark = { sent: sent.length, logs: cap.lines.length, rest: fetcher.calls.length, charts: charts.length, at: atCalls.length,
      metrics: metricCalls.length, prompts: prompts.length, sleeps: SLEEPS.length, trades: tradeIds().length };
    const step = (name) => {
      const tids = tradeIds();
      steps.push(norm({                 // deep copy now: records and module lists keep changing
        step: name, sent: sent.slice(mark.sent), logs: cap.lines.slice(mark.logs), rest: fetcher.calls.slice(mark.rest),
        charts: charts.slice(mark.charts), at: atCalls.slice(mark.at), metrics: metricCalls.slice(mark.metrics),
        prompts: prompts.slice(mark.prompts), sleeps: SLEEPS.slice(mark.sleeps), new_trades: tids.slice(mark.trades),
        registry_file: regFile(),
        registry_state: registry.snapshot(),
      }));
      mark = { sent: sent.length, logs: cap.lines.length, rest: fetcher.calls.length, charts: charts.length, at: atCalls.length,
        metrics: metricCalls.length, prompts: prompts.length, sleeps: SLEEPS.length, trades: tids.length };
    };

    regimeNow = tk.regime;
    regimeAt = tk.t - tk.regime_age;
    FUND.block = tk.fund;
    if (tk.momentum) momentum.activateRelaxed(tk.momentum.symbol, tk.momentum.reason, tk.momentum.btc, tk.momentum.eth);
    for (const [uid, field, value] of tk.mutate) {
      const u = ts.get(uid);
      u[field] = value;
      ts.save(u, { now: clock.t });
    }
    for (const [uid, strat, p] of tk.opt_update) {
      db.prepare('INSERT OR REPLACE INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (?, ?, ?, ?)')
        .run(uid, strat, p, clock.t);                       // the driver's json.dumps text
    }
    for (const [sym, d, rr] of tk.closed) freeReport.recordClosedProfitable(sym, d, rr);
    for (const sym of FIX.symbols) {
      for (const tf of FIX.cache_tfs) {
        const mode = CACHE_MODE.get(`${sym}|${tf}`);
        if (mode === 'none') continue;
        let at = clock.t;
        let lim = 300;
        if (Array.isArray(mode) && mode[0] === 'lag') at = clock.t - mode[1];
        else if (Array.isArray(mode) && mode[0] === 'short') lim = mode[1];
        const f = frameAt(sym, tf, at, lim);
        if (f) candleCache.setCandles(sym, tf, f, FIX.ttl_map);
      }
    }
    for (const [inst, tf] of tk.ws) {
      await levels._onWsBarClose(inst, tf);
      await smc.onWsBarClose(inst, tf);
      if (typeof vol.onWsBarClose === 'function') await vol.onWsBarClose(inst, tf);
    }
    step('prep');
    if (tk.trend_seed) {
      for (const [tf, tr] of Object.entries(tk.trend_seed)) trend._state[tf] = { trend: tr, since: tk.t - 7200.0, price: 1.5 };
    }
    await trend.refresh(clock.t);
    step('trend');
    for (const name of tk.order) {
      if (name === 'LEVELS') {
        try { await levels._cycle(); } catch (e) { cap.lines.push(['driver', 'ERROR', `LEVELS cycle raised ${e.name}: ${e.message}`]); }
      } else if (name === 'SMC') {
        smc._state.scanStartTs = clock.t;
        try { await smc.scanCycle(); } catch (e) { cap.lines.push(['driver', 'ERROR', `SMC cycle raised ${e.name}: ${e.message}`]); }
        await smc.drainPending();
      } else {
        try { await vol._scanCycle(bot, um, fetcher); } catch (e) { cap.lines.push(['driver', 'ERROR', `VOLUME cycle raised ${e.name}: ${e.message}`]); }
      }
      await new Promise((r) => setImmediate(r));
      step(name);
    }
    if (tk.evening) {
      await freeReport.sendEveningReport(ts.allUsers({ now: clock.t }), async (uid, text) => {
        if (!(await bot.sendText(uid, text, { type: 'report', kind: 'evening_report' }))) throw new Error('not delivered');
      }, { sleep: fakeSleep });
      step('evening');
    }
    const trades = db.prepare('SELECT * FROM signal_trades ORDER BY rowid').all();
    const events = db.prepare('SELECT trade_id, ts, event_type, payload_json FROM trade_events').all()
      .sort((a, b) => (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : a.event_type < b.event_type ? -1 : a.event_type > b.event_type ? 1 : a.payload_json < b.payload_json ? -1 : a.payload_json > b.payload_json ? 1 : 0));
    const kvNow = new Map(db.prepare('SELECT key, value FROM engine_kv').all().map((r) => [r.key, r.value]));
    const kvDiff = {};
    for (const [k, v] of kvNow) if (kvBase.get(k) !== v) kvDiff[k] = v;
    const opt = db.prepare('SELECT user_id, strategy, params, updated_at FROM optimizer_params ORDER BY user_id, strategy').all();
    const ftEma = {};
    for (const s of ['LEVELS', 'SMC', 'VOLUME']) ftEma[s] = freshness.getCycleEma(s);
    const indic = {};
    for (const [jk, ind] of levels._indicators) indic[jk] = Object.fromEntries(ind.cooldown.map);
    const state = {
      levels_last_scan: Object.fromEntries(levels._lastScan),
      levels_perf: { ...levels._perf },
      levels_cooldowns: indic,
      levels_hint: Object.fromEntries([...LS._userHintLastTs].map(([k, v]) => [String(k), v])),
      smc_last_scan: Object.fromEntries([...smc._lastScan].map(([k, v]) => [String(k), v])),
      vol_sent_bars: Object.fromEntries(vol._sentBars),
      vol_htf: Object.fromEntries([...vol._htfCache].map(([k, v]) => [k, [v[0], v[1].length, v[1].t[v[1].length - 1]]])),
      missed: Object.fromEntries([...freeReport.missedBuffer].map(([k, v]) => [String(k), v])),
      closed: freeReport.closedProfitable.slice(),
      preview_sent: Object.fromEntries([...freeReport.previewSent].map(([k, v]) => [String(k), Object.fromEntries(v)])),
      confluence: confluence.getStats(),
      momentum: { relaxed: Boolean(momentum._state.relaxed), until: Number(momentum._state.relaxed_until) },
      breakout: Object.fromEntries(momentum.levelsOpts().breakoutState),
      trend: Object.fromEntries(Object.entries(trend._state).map(([k, v]) => [k, { ...v }])),
      strength: { ...trend._strength },
      aligned: { ...trend._aligned },
      freshness_ema: ftEma,
      skips: [exSym._getState().skipCounter, { ...exSym._getState().skipSamples }],
      blacklist: coinQuality.getBlacklistSnapshot(),
      cache: candleCache.cacheStats(),
      registry: registry.snapshot(),
      registry_stats: registry.getStats(),
      rand_k: seq.k,
    };
    out.push(norm({ steps, trades, events, kv: kvDiff, users: db.prepare('SELECT * FROM trader_settings ORDER BY user_id').all(), state, opt, tradeCols, userCols }));
    if (onTick) onTick(tk, out[out.length - 1]);
  }
  return { out, digest: market.digest, kvAfterSetup };
}

module.exports = { loadFixture, replay, buildMarket, fnv, canon, norm, Seq };
