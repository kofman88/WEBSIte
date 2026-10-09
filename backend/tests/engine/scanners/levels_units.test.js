/**
 * LEVELS scanner unit-level differential (py/levels_units.py → levels_fixtures/units.json.gz):
 * the bot's real _build_jobs, _cfg_to_ind, _notify_expired, _sub_check_loop, _on_ws_bar_close,
 * _scan_loop (ok / slow / error / timeout), _fetch with CACHE_FIRST_MODE off / shadow / enforce,
 * _warmup_cache (the candle_store set_candles quirk), telegram_safe.safe_send_message and
 * _split_for_telegram, analyze_on_demand(_lang) — replayed on the JS MidScanner with the same
 * clock, sleeps and fakes.
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/py/levels_units.py
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9b-lvunits-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'levels-units.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const FIX = H.loadFixture(path.join(__dirname, 'levels_fixtures', 'units.json.gz'));
const E = FIX.out;
const USER_STATE_COLS = [
  'user_id', 'active', 'long_active', 'short_active', 'smc_long_active', 'smc_short_active',
  'vol_long_active', 'vol_short_active', 'sub_status', 'sub_plan', 'expired_notified', 'signals_received',
  'free_signals_date', 'free_signals_morning', 'free_signals_evening', 'free_signals_night',
  'free_signals_today', 'free_missed_today', 'free_smc_preview_today', 'free_smc_preview_date',
];
const PY_KW = { parseMode: 'parse_mode', replyMarkup: 'reply_markup', protectContent: 'protect_content',
  disableWebPagePreview: 'disable_web_page_preview', disableNotification: 'disable_notification' };

class ValueError extends Error {}
const J = {};

async function run() {
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const tradeCfg = req('../../../services/engine/tradeCfg.js');
  const candleCache = req('../../../services/marketData/candleCache.js');
  const keyboards = req('../../../services/engine/cards/keyboards.js');
  const { createFreshness } = req('../../../services/engine/signalFreshness.js');
  const { createMomentumDetector } = req('../../../services/engine/momentumDetector.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createMomentumVeto } = req('../../../services/engine/momentumVeto.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const LS = req('../../../services/engine/levelsScanner.js');

  const clock = new H.Clock(FIX.t0);
  const cap = H.logCapture();
  const quiet = { debug() {}, info() {}, warning() {}, error() {} };
  const cols = new Set(ts.COLUMNS);
  const writeRow = (row, insert) => {
    const keys = Object.keys(row).filter((k) => k === 'user_id' || cols.has(k));
    if (insert) {
      db.prepare('INSERT INTO users (id, email, password_hash, referral_code) VALUES (?, ?, ?, ?)')
        .run(row.user_id, `u${row.user_id}@x.test`, 'x', `R${row.user_id}`);
      db.prepare(`INSERT INTO trader_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    } else {
      const set = keys.filter((k) => k !== 'user_id');
      db.prepare(`UPDATE trader_settings SET ${set.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`).run(...set.map((k) => row[k]), row.user_id);
    }
  };
  for (const row of FIX.users) writeRow(row, true);
  ts.invalidateCache();
  const usersSnap = () => db.prepare('SELECT * FROM trader_settings ORDER BY user_id').all().map((r) => Object.fromEntries(USER_STATE_COLS.map((c) => [c, r[c]])));
  const um = {
    getActiveUsers: () => ts.getActiveUsers({ now: clock.now() }),
    allUsers: () => ts.allUsers({ now: clock.now() }),
    save: (u) => ts.save(u, { now: clock.now() }),
    get: (uid) => ts.get(uid),
  };
  candleCache._resetForTests();
  candleCache.initCache(4000, { now: () => clock.now(), log: quiet });
  const fetcher = new H.FakeFetcher(clock, FIX.volumes, {});
  const bot = new H.FakeBot();
  for (const u of FIX.bot_fail) bot.fail.add(u);
  const metricCalls = [];
  const heartbeats = [];
  const env = {};
  let sleepHook = async () => {};
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  const freshness = createFreshness({ env: {}, getCandles: (s, tf) => candleCache.getCandles(s, tf), log: cap.make('CHM.SignalFreshness') });
  const rand = new H.Rand();
  let regimeNow = null;
  const atCalls = [];
  const charts = [];
  LS._resetModuleStateForTests();
  const scanner = new LS.MidScanner({ SCAN_WORKERS: 1, PAYMENT_ADDRESS: FIX.cfg.PAYMENT_ADDRESS }, bot, um, null, {
    clock, sleep: (ms) => sleepHook(ms), timers, random: rand, env,
    log: cap.make('CHM.Scanner'), indicatorLog: cap.make('CHM.Indicator'), tgLog: cap.make('CHM.TgSafe'),
    fetcher, cache: candleCache, freshness,
    momentum: createMomentumDetector({ now: () => clock.now(), log: quiet }),
    trend: createTrendMonitor({ env: {}, kv: null, now: () => clock.now(), log: quiet }),
    regime: { getCachedRegime: () => regimeNow },
    veto: createMomentumVeto({}),
    repo: createSignalTradesRepo({ db, now: () => clock.now(), log: quiet }),
    executeAutoTrade: async (kw) => { const k = { ...kw }; delete k.bot; atCalls.push(k); return { executed: false, show_trade_btn: true, limit_msg: null }; },
    getApiKeys: (user, exchange) => {
      const k = FIX.api_keys[String(user.user_id)];
      return k && k[0] === exchange ? { apiKey: k[1], apiSecret: k[2] } : null;
    },
    getBalance: async () => null,
    sendChart: (_b, user) => { charts.push(user.user_id); },
    kv: H.memKv(),
    metrics: { record: async (name, value, tags) => { metricCalls.push([name, value, { ...(tags || {}) }]); } },
    health: { heartbeat: (n) => heartbeats.push(n) },
    isAdmin: () => false,
  });
  scanner.fetcher = fetcher;
  const since = (n) => cap.lines.slice(n);

  // build_jobs / cfg_to_ind
  J.build_jobs = E.build_jobs.map((c) => {
    const jobs = LS.MidScanner._buildJobs(ts.get(c.uid), c.now, new Map(Object.entries(c.last)));
    return { uid: c.uid, now: c.now, last: c.last, jobs: jobs.map((j) => [j.direction, j.tf, j.interval, j.jobKey, j.cfg]) };
  });
  J.cfg_to_ind = E.cfg_to_ind.map((c) => ({ uid: c.uid, high_wr: c.high_wr, ind: LS.cfgToInd(tradeCfg.getLongCfg(ts.get(c.uid)), c.high_wr) }));

  // notify
  let n0 = cap.lines.length;
  let s0 = bot.sent.length;
  for (const uid of [3101, 3102, 3103, 3106]) for (const d of ['LONG', 'SHORT', 'BOTH']) scanner._lastScan.set(`${uid}_${d}`, FIX.t0 - 50);
  for (const uid of [3101, 3102, 3103, 3106]) await scanner._notifyExpired(ts.get(uid));
  J.notify = { sent: bot.sent.slice(s0), logs: since(n0), last_scan: Object.fromEntries(scanner._lastScan), users: usersSnap() };
  scanner._lastScan.clear();

  // sub_check
  for (const row of FIX.users) if (row.user_id >= 3100) writeRow(row, false);
  ts.invalidateCache();
  const subSleeps = [];
  let allCalls = 0;
  const realAll = um.allUsers;
  um.allUsers = async () => { allCalls += 1; if (allCalls === 2) throw new Error('database is locked'); return realAll(); };
  sleepHook = async (ms) => {
    subSleeps.push(ms / 1000);
    clock.t += ms / 1000;
    if (subSleeps.length >= 5) throw new LS.CancelledError();
  };
  n0 = cap.lines.length;
  s0 = bot.sent.length;
  clock.t = FIX.t0 - 60;
  await expect(scanner._subCheckLoop()).rejects.toThrow(LS.CancelledError);
  um.allUsers = realAll;
  J.sub_check = { start: FIX.t0 - 60, sleeps: subSleeps, sent: bot.sent.slice(s0), logs: since(n0), users: usersSnap() };

  // ws_trigger
  ts.invalidateCache();
  const steps = [];
  for (const st of E.ws_trigger.steps) {
    clock.t = st.t;
    scanner._lastScan = new Map(Object.entries(E.ws_trigger.keys));
    n0 = cap.lines.length;
    await scanner._onWsBarClose(st.inst, st.tf);
    steps.push({ t: st.t, inst: st.inst, tf: st.tf, last_scan: Object.fromEntries(scanner._lastScan), logs: since(n0),
      trig: Object.fromEntries(scanner._wsTrigLast) });
  }
  J.ws_trigger = { keys: E.ws_trigger.keys, steps };
  scanner._lastScan.clear();

  // scan_loop
  const plan = E.scan_loop.plan;
  let pi = 0;
  const slSleeps = [];
  let armed = null;
  timers.setTimeout = (fn) => { if (armed) { const f = fn; armed = null; Promise.resolve().then(f); } return 1; };
  scanner._cycle = async (token) => {
    const step = plan[pi++];
    if (step === 'ok') clock.t += 3.0;
    else if (step === 'slow') clock.t += 130.5;
    else if (step === 'raise') { clock.t += 1.0; throw new Error('database is locked'); } else if (step === 'timeout') {
      clock.t += 2.0;
      armed = true;
      return new Promise((_r, rej) => token.on(() => rej(new LS.CancelledError())));
    }
    return undefined;
  };
  sleepHook = async (ms) => {
    slSleeps.push(ms / 1000);
    clock.t += ms / 1000;
    if (slSleeps.length >= plan.length) throw new LS.CancelledError();
  };
  scanner._perf.users = 7;
  scanner._perf.api_calls = 21;
  n0 = cap.lines.length;
  const m0 = metricCalls.length;
  clock.t = E.scan_loop.start;
  await expect(scanner._scanLoop()).rejects.toThrow(LS.CancelledError);
  delete scanner._cycle;
  const ema = freshness.getCycleEma('LEVELS');
  J.scan_loop = { start: E.scan_loop.start, plan, sleeps: slSleeps, heartbeats, metrics: metricCalls.slice(m0), logs: since(n0),
    freshness_ema: ema ? { LEVELS: ema } : {} };
  timers.setTimeout = () => 0;

  // fetch (CACHE_FIRST_MODE)
  sleepHook = async () => {};
  candleCache._resetForTests();
  clock.t = FIX.t0 + 10000;
  candleCache.initCache(4000, { now: () => clock.now(), log: quiet });
  candleCache.setCandles('BTC-USDT-SWAP', '15m', H.frameAt('BTC-USDT-SWAP', '15m', clock.t, 300), LS.CACHE_TTL);
  LS._shadow.misses = 0;
  LS._shadow.lastLog = 0.0;
  J.fetch = [];
  for (const f of E.fetch) {
    clock.t = f.t;
    env.CACHE_FIRST_MODE = f.mode;
    const keys = Object.keys(f.perf0);
    const perf0 = Object.fromEntries(keys.map((k) => [k, scanner._perf[k] || 0]));
    n0 = cap.lines.length;
    const r0 = fetcher.calls.length;
    const res = await scanner._loadTfCandles(f.tf, FIX.symbols.slice(0, 4).concat(['NOPE-USDT-SWAP']));
    J.fetch.push({ mode: f.mode, t: f.t, tf: f.tf, got: Array.from(res.keys()).sort(), rest: fetcher.calls.slice(r0), logs: since(n0),
      perf0, perf: Object.fromEntries(keys.map((k) => [k, scanner._perf[k] || 0])), shadow: [LS._shadow.misses, LS._shadow.lastLog] });
  }
  delete env.CACHE_FIRST_MODE;

  // warmup
  candleCache._resetForTests();
  clock.t = E.warmup.t;
  candleCache.initCache(4000, { now: () => clock.now(), log: quiet });
  const storeCalls = [];
  let closed = 0;
  scanner.deps.candleStore = {
    ensureCandles: async (sym, tf, days) => { storeCalls.push([sym, tf, days]); return (storeCalls.length % 3) ? H.frameAt(sym, tf, clock.t, 300) : null; },
    HistoryLoader: class { async close() { closed += 1; } },
  };
  const wuSleeps = [];
  sleepHook = async (ms) => { wuSleeps.push(ms / 1000); };
  n0 = cap.lines.length;
  const r0 = fetcher.calls.length;
  await scanner._warmupCache();
  J.warmup = { t: E.warmup.t, sleeps: wuSleeps, store_calls: storeCalls, closed, rest: fetcher.calls.slice(r0), logs: since(n0),
    cache_keys: candleCache.cacheKeys() };

  // safe_send
  const errs = E.safe_send.err_text;
  const mk = (kind) => {
    const names = { retry: 'TelegramRetryAfter', net: 'TelegramNetworkError', bad: 'TelegramBadRequest', forbidden: 'TelegramForbiddenError' };
    if (kind === 'value') return new ValueError(errs.value);
    if (!names[kind]) return null;
    const e = new Error(errs[kind]);
    e.name = names[kind];
    if (kind === 'retry') e.retry_after = 7;
    return e;
  };
  class ScriptBot {
    constructor(script) { this.script = script.slice(); this.calls = []; this.nextId = 7000; }
    async sendMessage(uid, text, kw = {}) {
      this.calls.push({ uid, text, kw: Object.keys(kw).map((k) => PY_KW[k]).sort(), kb: kw.replyMarkup ? keyboards.toTelegram(kw.replyMarkup) : null });
      const e = mk(this.script.length ? this.script.shift() : 'ok');
      if (e) throw e;
      this.nextId += 1;
      return { message_id: this.nextId };
    }
  }
  const tg = cap.make('CHM.TgSafe');
  const contactKb = [[{ id: 'contact_admin', label: '✍️ Написать администратору ' + FIX.cfg.ADMIN_CONTACT, action: 'https://t.me/crypto_chm', kind: 'url' }]];
  J.safe_send = { cases: [] };
  for (const c of E.safe_send.cases) {
    const sbot = new ScriptBot(c.script);
    const sl = [];
    const sentIds = [];
    n0 = cap.lines.length;
    const isLong = Object.prototype.hasOwnProperty.call(c, 'text');
    const ok = isLong
      ? await LS.safeSendMessage(sbot, 43, c.text, { replyMarkup: contactKb, onSent: (m) => sentIds.push(m.message_id) }, { log: tg, sleep: async (ms) => { sl.push(ms / 1000); } })
      : await LS.safeSendMessage(sbot, 42, '<b>hi</b>', { parseMode: 'HTML', protectContent: true, onSent: (m) => sentIds.push(m.message_id), disableNotification: c.script[0] === 'net' },
        { log: tg, sleep: async (ms) => { sl.push(ms / 1000); } });
    const rec = { script: c.script, ok, calls: sbot.calls, sleeps: sl, logs: since(n0), on_sent: sentIds };
    if (isLong) rec.text = c.text;
    J.safe_send.cases.push(rec);
  }
  J.safe_send.none_bot = await LS.safeSendMessage(null, 42, 'x', {}, { log: tg });
  J.safe_send.zero_uid = await LS.safeSendMessage(new ScriptBot([]), 0, 'x', {}, { log: tg });
  J.safe_send.err_text = errs;

  // split
  J.split = E.split.map((c) => ({ text: c.text, parts: LS.splitForTelegram(c.text) }));

  // on demand
  clock.t = FIX.t0;
  sleepHook = async () => {};
  const cfgs = Object.fromEntries(Object.entries(E.on_demand.cfgs).map(([k, v]) => [k, tradeCfg.tradeCfg(v)]));
  J.on_demand = { cfgs: E.on_demand.cfgs, cases: [] };
  for (const c of E.on_demand.cases) {
    const r0b = fetcher.calls.length;
    n0 = cap.lines.length;
    const res = c.lang === null ? await scanner.analyzeOnDemand(c.symbol, cfgs[c.cfg]) : await scanner.analyzeOnDemandLang(c.symbol, cfgs[c.cfg], c.lang);
    const rec = { symbol: c.symbol, cfg: c.cfg, lang: c.lang, rest: fetcher.calls.slice(r0b), logs: since(n0) };
    if (res === null) rec.result = null;
    else {
      const [sig, text] = res;
      rec.result = { text, symbol: sig.symbol, direction: sig.direction, entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2,
        tp3: sig.tp3, quality: sig.quality, btc_corr: sig.btc_corr === undefined ? null : sig.btc_corr, eth_corr: sig.eth_corr === undefined ? null : sig.eth_corr };
    }
    J.on_demand.cases.push(rec);
  }

  // _send: the scanner-level counter-trend gate
  candleCache._resetForTests();
  candleCache.initCache(4000, { now: () => clock.now(), log: quiet });
  clock.t = FIX.t0;
  regimeNow = E.ct_gate.regime;
  const [baseSig] = await scanner.analyzeOnDemand('SYNLV07', cfgs.default15);
  rand.k = E.ct_gate.rand_k0;
  J.ct_gate = { cases: [] };
  for (const c of E.ct_gate.cases) {
    const user = ts.get(c.uid);
    const sig = globalThis.structuredClone(baseSig);
    sig.quality = c.quality;
    n0 = cap.lines.length;
    const sb = bot.sent.length;
    const a0 = atCalls.length;
    const ok = await scanner._send(user, sig, tradeCfg.getLongCfg(user));
    J.ct_gate.cases.push({ uid: c.uid, quality: c.quality, ok, sent: bot.sent.slice(sb), at_calls: atCalls.slice(a0), logs: since(n0) });
  }
  J.ct_gate.charts = charts;
  const SITE_COLS = Object.keys(E.ct_gate.trades[0]);
  J.ct_gate.trades = db.prepare('SELECT * FROM signal_trades ORDER BY rowid').all().map((r) => Object.fromEntries(SITE_COLS.map((k) => [k, r[k] === undefined ? null : r[k]])));
  J.ct_gate.trade_events = db.prepare('SELECT trade_id, ts, event_type, payload_json FROM trade_events ORDER BY id').all();
  J.ct_gate.users = usersSnap();

  // hint throttle restore / persist
  const hkv = H.memKv();
  const hlog = cap.make('CHM.Scanner');
  clock.t = E.hint_throttle.t0;
  LS._userHintLastTs.clear();
  J.hint_throttle = { t0: E.hint_throttle.t0, cases: [] };
  for (const c of E.hint_throttle.cases) {
    hkv.set(LS.KV_HINT_LAST_TS, c.raw);
    n0 = cap.lines.length;
    await LS.restoreHintThrottle({ kv: hkv, now: () => clock.now(), log: hlog });
    J.hint_throttle.cases.push({ raw: c.raw, state: Array.from(LS._userHintLastTs), logs: since(n0) });
  }
  clock.t = E.hint_throttle.persist_t;
  await LS.persistHintThrottle({ kv: hkv, now: () => clock.now(), log: hlog });
  J.hint_throttle.persist_t = clock.t;
  J.hint_throttle.persisted = hkv.get(LS.KV_HINT_LAST_TS);
  J.hint_throttle.after_persist = Array.from(LS._userHintLastTs);
  return { candleCache, keyboards };
}

/** pick the Python dict's keys from a JS object (the dataclass ↔ plain-object field set). */
function pick(pyObj, jsObj) {
  return Object.fromEntries(Object.keys(pyObj).map((k) => [k, jsObj[k] === undefined ? null : jsObj[k]]));
}

let ctx = null;
describe('MidScanner units vs the bot (levels_units.py)', () => {
  beforeAll(async () => { ctx = await run(); }, 120_000);
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ } });

  it('_build_jobs: LONG / SHORT / legacy BOTH jobs whose interval passed, effective cfgs', () => {
    expect(J.build_jobs.length).toBe(E.build_jobs.length);
    J.build_jobs.forEach((c, i) => {
      const e = E.build_jobs[i];
      expect(c.jobs.map((j) => j.slice(0, 4))).toEqual(e.jobs.map((j) => j.slice(0, 4)));
      c.jobs.forEach((j, k) => expect(H.norm(pick(e.jobs[k][4], j[4]))).toEqual(e.jobs[k][4]));
    });
  });

  it('_cfg_to_ind (+ HIGH-WR) for sparse / extra-strategy / free users', () => {
    J.cfg_to_ind.forEach((c, i) => {
      const e = E.cfg_to_ind[i];
      expect(Object.keys(c.ind).sort()).toEqual(Object.keys(e.ind).sort());
      expect(H.norm(pick(e.ind, c.ind))).toEqual(e.ind);
    });
  });

  it('_notify_expired: paid → expired + notice + _last_scan cleared; notified / free untouched; blocked bot', () => {
    expect(H.norm(J.notify.sent)).toEqual(E.notify.sent);
    expect(J.notify.logs).toEqual(E.notify.logs);
    expect(J.notify.last_scan).toEqual(E.notify.last_scan);
    expect(J.notify.users).toEqual(E.notify.users);
  });

  it('_sub_check_loop: 60 s warm-up, 300 s period, expiry crossing, all_users() error logged', () => {
    expect(J.sub_check.sleeps).toEqual(E.sub_check.sleeps);
    expect(H.norm(J.sub_check.sent)).toEqual(E.sub_check.sent);
    expect(J.sub_check.logs).toEqual(E.sub_check.logs);
    expect(J.sub_check.users).toEqual(E.sub_check.users);
  });

  it('_on_ws_bar_close: TF match per direction, existing keys only, INFO throttled 1/5 min per TF', () => {
    expect(J.ws_trigger.steps).toEqual(E.ws_trigger.steps);
  });

  it('_scan_loop: SCAN_LOOP_SLEEP − elapsed, heartbeat, cycle_duration, freshness EMA, SLOW / error / TIMEOUT logs', () => {
    expect(J.scan_loop.sleeps).toEqual(E.scan_loop.sleeps);
    expect(J.scan_loop.heartbeats).toEqual(E.scan_loop.heartbeats);
    expect(H.norm(J.scan_loop.metrics)).toEqual(E.scan_loop.metrics);
    expect(J.scan_loop.logs).toEqual(E.scan_loop.logs);
    expect(J.scan_loop.freshness_ema).toEqual(E.scan_loop.freshness_ema);
  });

  it('_fetch: CACHE_FIRST_MODE off / shadow (aggregate log every 60 s) / enforce (no REST)', () => {
    expect(H.norm(J.fetch)).toEqual(E.fetch);
  });

  it('_warmup_cache: candle_store frames are never counted (set_candles without ttl_map) → REST fallback', () => {
    const w = J.warmup;
    const e = E.warmup;
    expect(w.sleeps).toEqual(e.sleeps);
    expect(w.store_calls).toEqual(e.store_calls);
    expect(w.closed).toEqual(e.closed);
    expect(H.norm(w.rest)).toEqual(e.rest);
    expect(w.logs).toEqual(e.logs);
    // PORT_DECISIONS D6: the site normalises candle-cache TF keys (bot `SYM_1h` → site `SYM_1H`)
    const { candleCache } = ctx;
    const norm = e.cache_keys.map((k) => { const i = k.lastIndexOf('_'); return candleCache.candleKey(k.slice(0, i), k.slice(i + 1)); });
    expect(w.cache_keys.slice().sort()).toEqual(norm.slice().sort());
    expect(e.cache_keys.some((k) => k.endsWith('_1h'))).toBe(true);
    expect(w.cache_keys.some((k) => k.endsWith('_1H'))).toBe(true);
  });

  it('safe_send_message: RetryAfter / network backoff / Forbidden / BadRequest / other, split > 4096, on_sent', () => {
    expect(J.safe_send.cases.length).toBe(E.safe_send.cases.length);
    J.safe_send.cases.forEach((c, i) => expect(H.norm(c)).toEqual(E.safe_send.cases[i]));
    expect(J.safe_send.none_bot).toBe(E.safe_send.none_bot);
    expect(J.safe_send.zero_uid).toBe(E.safe_send.zero_uid);
  });

  it('_split_for_telegram: line boundaries, hard cut of an over-long line, lengths in code points', () => {
    expect(J.split).toEqual(E.split);
  });

  it('_send counter-trend gate: `levels_counter_trend_min_quality or 4` (0 → 4), allow off, filters_all_off bypass', () => {
    const cardOf = (json, site) => {
      if (!json) return null;
      const d = JSON.parse(json);
      return { html: d.html, kb: site ? (d.actions ? ctx.keyboards.toTelegram(d.actions) : null) : d.kb };
    };
    expect(J.ct_gate.cases.length).toBe(E.ct_gate.cases.length);
    J.ct_gate.cases.forEach((c, i) => expect(H.norm(c)).toEqual(E.ct_gate.cases[i]));
    // the quirk itself: min 0 behaves like 4 (3⭐ blocked), min 3 lets the 3⭐ signal through
    const blocked = (uid, q) => E.ct_gate.cases.find((c) => c.uid === uid && c.quality === q).at_calls.length === 0;
    expect(blocked(3201, 4)).toBe(true);
    expect(blocked(3202, 4)).toBe(false);
    expect(J.ct_gate.charts).toEqual(E.ct_gate.charts);
    expect(H.norm(J.ct_gate.trades).map((r) => ({ ...r, signal_card_json: cardOf(r.signal_card_json, true) })))
      .toEqual(E.ct_gate.trades.map((r) => ({ ...r, signal_card_json: cardOf(r.signal_card_json, false) })));
    expect(H.norm(J.ct_gate.trade_events)).toEqual(E.ct_gate.trade_events);
    expect(J.ct_gate.users).toEqual(E.ct_gate.users);
  });

  it('hint throttle kv: int(k) / float(v) coercions, 2 × 4 h window, NaN / inf kept, dict order, json.dumps on persist', () => {
    expect(H.norm(J.hint_throttle)).toEqual(E.hint_throttle);
  });

  it('analyze_on_demand / analyze_on_demand_lang: symbol normalisation, HTF 1D, BTC/ETH correlation, no data', () => {
    expect(J.on_demand.cases.length).toBe(E.on_demand.cases.length);
    expect(E.on_demand.cases.some((c) => c.result !== null)).toBe(true);
    J.on_demand.cases.forEach((c, i) => expect(H.norm(c)).toEqual(E.on_demand.cases[i]));
  });
});
