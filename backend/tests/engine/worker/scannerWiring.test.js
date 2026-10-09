/**
 * The scheduler's wiring of the REAL scanners (scheduler.scannerDeps, siteSafeSend,
 * siteRememberSignalMessage, siteSendChart, withGlobalTrend) and the shutdown semantics of the
 * three scanners under it — what bot.py hands MidScanner / run_volume_scanner / run_smc_scanner
 * and what its task cancellation does:
 *   • MidScanner(config, bot, um, stop_event): the scheduler's StopEvent (is_set()), its abortable
 *     sleep / clock / log, the WS bar-close bus, `scanner.fetcher` (+ get_global_trend) shared by
 *     every loop, no auto-trade until M13b;
 *   • a stop during a cycle = CancelledError at the cycle's next checkpoint (the bot's
 *     task.cancel()), not "Ошибка цикла"; nothing runs after the stop;
 *   • register_on_bar_close(self._on_ws_bar_close) dedups the bound method across a restart;
 *   • run_volume_scanner on the module instance, configured by the scheduler; its cancellation
 *     ("Volume scanner stopped.") and the wake wait ending at once;
 *   • the card / notice / chart adapters over the delivery facade;
 *   • cache_gc over the real volume module (_sent_bars);
 *   • the genome: `async with _evolution_lock` waits for a manual run, the regime reaches the
 *     genome thread.
 * Fake timers only; no network (fake REST client, fake candle store).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-scanner-wiring.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const SCH = req('../../../services/engine/scheduler.js');
const LS = req('../../../services/engine/levelsScanner.js');
const VS = req('../../../services/engine/volumeScanner.js');
const ws = req('../../../services/marketData/bingxWsFeed.js');
const ts = req('../../../services/traderSettingsService.js');
const { localFacade, createSignalDelivery } = req('../../../services/engine/signalDelivery.js');

const T0 = 1767006000;

function capture() {
  const lines = [];
  const rec = (lvl) => (msg) => lines.push([lvl, String(msg)]);
  return { lines, log: { debug() {}, info: rec('INFO'), warning: rec('WARNING'), warn: rec('WARNING'), error: rec('ERROR'), critical: rec('CRITICAL') } };
}
const msgs = (lines) => lines.map(([, m]) => m);

function memKv() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, delete: (k) => { m.delete(k); } };
}

function levelsUser(uid) {
  return { ...ts.defaults(uid), strategy: 'LEVELS', long_active: true, short_active: false, long_tf: '1h', long_interval: 3600, sub_plan: 'pro', sub_status: 'active', sub_expires: T0 + 86400 };
}

/** A worker-side scheduler with the real MidScanner and fakes for every outside dependency. */
function levelsScheduler({ log, fetcher, user = levelsUser(7), extra = {} }) {
  const um = { getActiveUsers: async () => [user], allUsers: async () => [], save: async () => {}, get: () => user };
  const cache = { getCandles: () => null, setCandles() {}, getCoins: () => null, setCoins() {}, cacheStats: () => ({}) };
  const candleStore = { ensureCandles: async () => null, HistoryLoader: class { async close() {} }, cleanup: async () => {} };
  const bot = { alertAdmins: async () => 0, sendMessage: async () => ({ message_id: 1 }), deliverChart: () => true };
  return SCH.createScheduler({
    side: 'worker',
    deps: {
      bot, um, fetcher, cache, candleStore, log, only: ['scanner'], registry: { forceSave: () => 0 },
      scannerDeps: {
        LEVELS: {
          kv: memKv(), checkAccess: () => [true, ''], strategyEnabled: () => true, isAdmin: () => false,
          freshness: { reportCycleTime() {}, isSignalFresh: () => [true, ''] },
          ...extra,
        },
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  ws._resetBarCloseCallbacks();
});
afterEach(() => {
  ws._resetBarCloseCallbacks();
  vi.useRealTimers();
});

describe('scheduler → the real MidScanner (scanner_mid wiring of bot.py)', () => {
  it('MidScanner(config, bot, um, stop_event): StopEvent.is_set(), the scheduler sleep / clock / log, the WS bar-close bus, scanner.fetcher + get_global_trend', async () => {
    const { log, lines } = capture();
    const fetcher = { volBySym: {}, getAllUsdtPairs: async () => [], getCandles: async () => null };
    const s = levelsScheduler({ log, fetcher });
    expect(s.start()).toEqual(['scanner']);
    const sc = s.ctx.levels;
    expect(sc).toBeInstanceOf(LS.MidScanner);
    expect(sc._stopEvent).toBe(s.ctx.stopEvent);
    expect(sc._stopped()).toBe(false);
    expect(sc.deps.sleep).toBe(s.ctx.sleep);
    expect(sc.deps.clock.now()).toBe(T0);
    expect(sc.log).toBe(log);
    expect(sc._health).toBe(s.ctx.health);
    expect(sc.bot).toBe(s.ctx.bot);
    // the bot's MidScanner owns the fetcher every other loop uses (scanner.fetcher)
    expect(sc.fetcher).toBe(fetcher);
    expect(s.ctx.fetcher()).toBe(fetcher);
    expect(typeof fetcher.getGlobalTrend).toBe('function');
    expect(sc.deps.executeAutoTrade).toBe(null);
    expect(sc.deps.getApiKeys(levelsUser(7), 'bybit')).toBe(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(msgs(lines)).toContain('[WS-TRIGGER] registered bar-close callback for LEVELS scanner');
    // the first cycle scanned the 1h LONG job → a 1H bar close re-arms it through the bus
    expect(sc._lastScan.get('7_LONG')).toBe(T0);
    await ws.fireBarClose('BTC-USDT-SWAP', '1H');
    expect(sc._lastScan.get('7_LONG')).toBe(0);
    expect(msgs(lines)).toContain('[WS-TRIGGER] bar_close BTC-USDT-SWAP/1H → reset 1 last_scan keys (throttled 1/5min)');
    const stopP = s.stop();
    expect(sc._stopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await stopP).toEqual({ pending: 0, saved: 0 });
  });

  it('a stop during a cycle cancels it at the next checkpoint (CancelledError, the bot\'s task.cancel()), not "Ошибка цикла"; no restart, no later cycle', async () => {
    const { log, lines } = capture();
    let release = null;
    let pairsCalls = 0;
    const fetcher = {
      volBySym: {},
      getAllUsdtPairs: () => { pairsCalls += 1; return new Promise((r) => { release = r; }); },
      getCandles: async () => null,
      getGlobalTrend: async () => ({}),
    };
    const s = levelsScheduler({ log, fetcher });
    s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(release).not.toBe(null);                      // the cycle waits in _load_coins
    const stopP = s.stop();
    await vi.advanceTimersByTimeAsync(10);
    release(['BTC-USDT-SWAP']);                          // the call returns after the stop …
    await vi.advanceTimersByTimeAsync(4000);
    expect(await stopP).toEqual({ pending: 0, saved: 0 });
    const m = msgs(lines);
    expect(m.some((x) => x.startsWith('  📥 TF='))).toBe(false);   // … and the cycle went no further
    expect(m.some((x) => x.startsWith('Ошибка цикла'))).toBe(false);
    expect(lines.filter(([l]) => l === 'CRITICAL')).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pairsCalls).toBe(1);
  });

  it('register_on_bar_close(self._on_ws_bar_close): the same bound callback after a restart — one callback on the bus', async () => {
    const { log } = capture();
    const sc = new LS.MidScanner({}, null, { getActiveUsers: async () => [] }, null, { log, wsFeed: { registerOnBarClose: ws.registerOnBarClose } });
    let calls = 0;
    sc._onWsBarClose = async () => { calls += 1; };
    sc.deps.wsFeed.registerOnBarClose(sc._onWsBarCloseCb);
    sc.deps.wsFeed.registerOnBarClose(sc._onWsBarCloseCb);
    await ws.fireBarClose('BTC-USDT-SWAP', '1H');
    expect(calls).toBe(1);
  });
});

describe('run_volume_scanner on the module instance, configured by the scheduler', () => {
  it('opts.deps configure the module instance (the one cache_gc and the settings API use); the abort ends the wake wait at once', async () => {
    const { log, lines } = capture();
    const ac = new AbortController();
    const reg = [];
    const p = VS.runVolumeScanner(null, { getActiveUsers: async () => [] }, {}, {
      signal: ac.signal, deps: { log, wsFeed: { registerOnBarClose: (cb) => reg.push(cb) } },
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(VS.defaultScanner.deps.log).toBe(log);
    expect(VS.defaultScanner.deps.tgLog).toBe(log);
    expect(msgs(lines)).toEqual(['[VOLUME-START] Volume scanner started, interval=60s']);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await p;                                            // no 60 s wait
    expect(Date.now() / 1000 - T0).toBeLessThan(1);
    // a restart registers the same module callback (register_on_bar_close dedups it)
    const ac2 = new AbortController();
    const p2 = VS.runVolumeScanner(null, { getActiveUsers: async () => [] }, {}, { signal: ac2.signal, deps: { wsFeed: { registerOnBarClose: (cb) => reg.push(cb) } } });
    await vi.advanceTimersByTimeAsync(5);
    ac2.abort();
    await p2;
    expect(reg.length).toBe(2);
    expect(reg[0]).toBe(reg[1]);
  });

  it('cancelled inside a cycle → CancelledError at the next checkpoint → "Volume scanner stopped." (the bot\'s except CancelledError)', async () => {
    const { log, lines } = capture();
    const s = VS.createVolumeScanner({ log, kv: memKv(), checkAccess: () => [true, ''], can: () => true, strategyEnabled: () => true });
    const ac = new AbortController();
    const user = { ...ts.defaults(9), strategy: 'VOLUME', vol_long_active: true, vol_timeframe: '1h', sub_plan: 'pro', sub_status: 'active', sub_expires: T0 + 86400 };
    let loads = 0;
    s._loadDf = async () => { loads += 1; if (loads === 3) ac.abort(); return null; };
    const fetcher = { volBySym: { A: 1e9, B: 1e9, C: 1e9, D: 1e9, E: 1e9 }, getAllUsdtPairs: async () => ['A', 'B', 'C', 'D', 'E'] };
    await s.runVolumeScanner(null, { getActiveUsers: async () => [user] }, fetcher, { signal: ac.signal });
    expect(loads).toBe(3);
    expect(msgs(lines)).toEqual(['[VOLUME-START] Volume scanner started, interval=60s', 'Volume scanner stopped.']);
  });
});

describe('the site side of telegram_safe / chart_sender (siteSafeSend, siteRememberSignalMessage, siteSendChart)', () => {
  it('a card (on_sent = remember_signal_message(trade_id)) → bot.sendMessage(…, {site: {tradeId}}); notices → site.type; the bot\'s safe_send_message semantics on top', async () => {
    const sent = [];
    const bot = { sendMessage: async (uid, text, kw) => { sent.push([uid, text, kw]); if (uid === 5) { const e = new Error('Forbidden'); e.name = 'TelegramForbiddenError'; throw e; } return { message_id: 77 }; } };
    const { log, lines } = capture();
    const send = SCH.siteSafeSend({ log, sleep: async () => {} });
    const onSent = SCH.siteRememberSignalMessage('7_1767006000000_123');
    expect(onSent.siteCard).toEqual({ tradeId: '7_1767006000000_123' });
    const kb = [[{ id: 'x', label: 'x', action: 'x', kind: 'callback' }]];
    expect(await send(bot, 7, 'card', { parseMode: 'HTML', replyMarkup: kb, protectContent: true, onSent, disableNotification: true })).toBe(true);
    expect(await send(bot, 7, '🚫 notice', { parseMode: 'HTML', siteType: 'trade' })).toBe(true);
    expect(await send(bot, 7, '💡 hint', { parseMode: 'HTML' })).toBe(true);
    expect(await send(bot, 5, 'x', {})).toBe(false);
    expect(await send(null, 7, 'x', {})).toBe(false);
    expect(sent).toEqual([
      [7, 'card', { parseMode: 'HTML', replyMarkup: kb, protectContent: true, disableNotification: true, site: { tradeId: '7_1767006000000_123' } }],
      [7, '🚫 notice', { parseMode: 'HTML', site: { type: 'trade' } }],
      [7, '💡 hint', { parseMode: 'HTML', site: { type: 'report' } }],
      [5, 'x', { parseMode: 'HTML', site: { type: 'report' } }],
    ]);
    expect(msgs(lines)).toEqual(['[TG-SAFE] uid=5 blocked bot — notification lost']);
  });

  it('end to end on the main-thread delivery: the card becomes the trade\'s feed row (signal_msg_id + snapshot), the notice a trade notification', async () => {
    const Database = req('better-sqlite3');
    const { signalTradesDDL, TRADE_EVENTS_DDL } = req('../../../models/engineSchema.js');
    const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
    const tdb = new Database(':memory:');
    tdb.pragma('foreign_keys = OFF');
    tdb.exec(signalTradesDDL());
    tdb.exec(TRADE_EVENTS_DDL);
    const repo = createSignalTradesRepo({ db: tdb, now: () => T0 });
    repo.addTrade({ trade_id: '7_1767006000000_123', user_id: 7, symbol: 'SYNUP01-USDT-SWAP', direction: 'LONG', entry: 1, sl: 0.9, tp1: 1.1, tp2: 1.2, tp3: 1.3, strategy: 'LEVELS', timeframe: '1h' });
    const calls = [];
    let id = 900;
    const notifier = { dispatch: async (uid, opts) => { calls.push([uid, opts]); return { dispatched: true, notificationId: ++id, silent: Boolean(opts.silent) }; } };
    const bot = localFacade(createSignalDelivery({ notifier, sse: null, repo, db: tdb, log: capture().log }));
    const send = SCH.siteSafeSend({ log: capture().log, sleep: async () => {} });
    expect(await send(bot, 7, '🟢 <b>SYNUP01</b> LONG', { parseMode: 'HTML', replyMarkup: [], onSent: SCH.siteRememberSignalMessage('7_1767006000000_123') })).toBe(true);
    expect(await send(bot, 7, 'limit', { siteType: 'trade' })).toBe(true);
    expect(calls.map(([u, o]) => [u, o.type, o.data.kind, o.data.trade_id === undefined ? null : o.data.trade_id, o.data.strategy, o.data.symbol === undefined ? null : o.data.symbol])).toEqual([
      [7, 'signal', 'card', '7_1767006000000_123', 'LEVELS', 'SYNUP01-USDT-SWAP'],
      [7, 'trade', 'notice', null, null, null],
    ]);
    expect(repo.getTrade('7_1767006000000_123').signal_msg_id).toBe(901);
  });

  it('chart: the descriptor with the trade id of the signal\'s row; a frame < 10 bars is skipped like send_signal_chart_bg', () => {
    const charts = [];
    const bot = { deliverChart: (m) => charts.push(m) };
    const db = () => ({ prepare: () => ({ get: (uid, sym, dir, strat) => (sym === 'A' ? { trade_id: `${uid}_t_${strat}_${dir}`, timeframe: '4h' } : undefined) }) });
    const chart = SCH.siteSendChart('LEVELS', { db, log: capture().log });
    const df = { length: 30, t: Array.from({ length: 30 }, (_, i) => i * 1000) };
    chart(bot, { user_id: 7 }, { symbol: 'A', direction: 'LONG', timeframe: '1h' }, df, { strategy: 'LEVELS', lang: 'en', pivotLevels: [1, 2], hvnLevels: [], lvnLevels: [3] });
    chart(bot, { user_id: 7 }, { symbol: 'B', direction: 'SHORT' }, { ...df, tf: '1H' }, { strategy: 'VOLUME', lang: 'ru' });
    chart(bot, { user_id: 7 }, { symbol: 'A', direction: 'LONG' }, { length: 9, t: [] }, { strategy: 'LEVELS' });
    expect(charts).toEqual([
      { userId: 7, tradeId: '7_t_LEVELS_LONG', strategy: 'LEVELS', lang: 'en', symbol: 'A', timeframe: '4h', bars: 30, lastTs: 29000, extra: { pivot_levels: [1, 2], hvn_levels: [], lvn_levels: [3] } },
      { userId: 7, tradeId: null, strategy: 'VOLUME', lang: 'ru', symbol: 'B', timeframe: '1H', bars: 30, lastTs: 29000, extra: null },
    ]);
  });

  it('get_global_trend on the REST client: BTC from the confirmed trend-monitor state, else the frame rule; attached once', async () => {
    const tm = req('../../../services/engine/trendMonitor.js');
    const before = { ...tm.defaultMonitor };
    try {
      const inst = tm.createTrendMonitor({ log: capture().log, env: {} });
      SCH.installDefault(tm.defaultMonitor, inst);
      inst._seed({ '1H': 'LONG', '4H': 'SHORT', '1D': 'RANGE' });
      const rest = { getCandles: async () => null };
      SCH.withGlobalTrend(rest, { now: () => T0, env: {}, log: capture().log });
      const first = rest.getGlobalTrend;
      SCH.withGlobalTrend(rest, { now: () => T0, env: {}, log: capture().log });
      expect(rest.getGlobalTrend).toBe(first);
      expect(await rest.getGlobalTrend()).toEqual({
        BTC: { trend_text: 'H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓' },
        ETH: { trend_text: 'H1: ❓ | H4: ❓ | D1: ❓ | W1: ❓' },
      });
    } finally {
      Object.assign(tm.defaultMonitor, before);
    }
  });

  it('auto-trade hooks (M13b) reach all three scanners from deps.autoTrade; none by default', () => {
    const at = { executeAutoTrade: async () => ({ executed: true }), getApiKeys: (u, ex) => (u.user_id === 1 ? { apiKey: 'k', apiSecret: 's', ex } : null), getBalance: async () => 100 };
    const s = SCH.createScheduler({ side: 'worker', deps: { bot: {}, autoTrade: at, cache: {}, candleStore: {}, fetcher: {}, only: [] } });
    const lv = s.ctx.scannerDeps('LEVELS');
    const vol = s.ctx.scannerDeps('VOLUME');
    expect(lv.executeAutoTrade).toBe(at.executeAutoTrade);
    expect(vol.getApiKeys).toBe(at.getApiKeys);
    expect(vol.getBalance).toBe(at.getBalance);
    expect(vol.fetcher).toBe(undefined);
    expect(vol.candleStore).toBe(undefined);
    expect(s.ctx.smcDeps.executeAutoTrade).toBe(at.executeAutoTrade);
    expect(s.ctx.smcDeps.userApiKeys({ user_id: 1 }, 'bingx')).toEqual({ apiKey: 'k', apiSecret: 's', ex: 'bingx' });
    expect(s.ctx.smcDeps.userApiKeys({ user_id: 2 }, 'bybit')).toEqual({ apiKey: '', apiSecret: '' });
    const plain = SCH.createScheduler({ side: 'worker', deps: { bot: {}, cache: {}, candleStore: {}, fetcher: {}, only: [] } });
    expect(Object.keys(plain.ctx.smcDeps)).toEqual(['smartPromptQuota']);      // M17b, below
    expect(plain.ctx.scannerDeps('VOLUME').executeAutoTrade).toBe(null);
  });

  it('smc/scanner\'s smart_prompts.trigger_after_quota_hit → services/retention/smartPrompts through the thread\'s facade', async () => {
    const sp = req('../../../services/retention/smartPrompts.js');
    const calls = [];
    const orig = sp.triggerAfterQuotaHit;
    sp.triggerAfterQuotaHit = async (bot, uid) => { calls.push([bot, uid]); };
    try {
      const bot = { notifier: { dispatch: async () => ({ dispatched: true }) } };
      const s = SCH.createScheduler({ side: 'worker', deps: { bot, cache: {}, candleStore: {}, fetcher: {}, only: [] } });
      await s.ctx.smcDeps.smartPromptQuota(42);
      expect(calls).toEqual([[bot, 42]]);
      const own = () => 'own';
      const o = SCH.createScheduler({ side: 'worker', deps: { bot, smcDeps: { smartPromptQuota: own }, cache: {}, candleStore: {}, fetcher: {}, only: [] } });
      expect(o.ctx.smcDeps.smartPromptQuota).toBe(own);                         // deps.smcDeps wins
    } finally {
      sp.triggerAfterQuotaHit = orig;
    }
  });
});

describe('the worker boot (bot.py main() before the gather)', () => {
  it('start {boot: true}: the candle cache and the exchange symbol lists before the loops; startEngine asks for it', async () => {
    vi.useRealTimers();
    const EW = req('../../../workers/engineWorker.js');
    const { MessageChannel } = req('worker_threads');
    const { log, lines } = capture();
    const order = [];
    let made = null;
    const cache = { getCache: () => made, initCache: (n) => { order.push(['init_cache', n]); made = {}; }, getCandles: () => null, getCoins: () => null };
    const exchangeSymbols = {
      startBackgroundRefresh: async () => { order.push(['exchange_symbols']); return { stop() { order.push(['refresh_stopped']); } }; },
      getStats: () => ({ bybit: 1 }),
    };
    const ch = new MessageChannel();
    const seen = [];
    ch.port2.on('message', (m) => { seen.push(m); if (m.type === 'ready') order.push(['ready', m.tasks]); });
    const w = EW.runWorker(ch.port1, { logs: false, deps: { log, cache, exchangeSymbols, fetcher: {}, registry: { forceSave: () => 0 } } });
    ch.port2.postMessage({ type: 'start', options: { boot: true, only: [] } });
    for (let i = 0; i < 50 && !seen.some((m) => m.type === 'ready'); i++) await new Promise((r) => setImmediate(r));
    expect(order).toEqual([['init_cache', 4000], ['exchange_symbols'], ['ready', []]]);
    expect(msgs(lines)).toEqual(['⏳ Инициализация кэша...', "📋 Exchange symbols loaded: {'bybit': 1}"]);
    await w.stop();
    expect(order.slice(-1)).toEqual([['refresh_stopped']]);
    ch.port1.close();
    ch.port2.close();
    // the production entry asks the worker to boot
    const posted = [];
    const { EventEmitter } = req('events');
    class FakeWorker extends EventEmitter { postMessage(m) { posted.push(m); if (m.type === 'shutdown') Promise.resolve().then(() => { this.emit('message', { type: 'stopped' }); this.emit('exit', 0); }); } terminate() { return Promise.resolve(); } }
    const silent = { debug() {}, info() {}, warn() {}, warning() {}, error() {} };
    const eng = EW.startEngine({ log: silent, delivery: { alertAdmins: async () => 0, handleWorkerMessage: () => false }, spawn: () => new FakeWorker(), mainDeps: { only: [], log: silent } });
    try {
      expect(posted[0]).toEqual({ type: 'start', options: { boot: true } });
      await eng.stop();
    } finally {
      req('../../../services/genome/regime.js').setRegimeProvider(null);
    }
  });
});

describe('cache_gc over the real volume module', () => {
  it('volume_scanner.gc_sent(): _sent_bars older than 24 h are freed and counted', () => {
    const d = VS.defaultScanner;
    d.configure({ clock: { now: () => T0, monotonic: () => 0 } });
    d._sentBars.clear();
    d._sentBars.set('1|A|LONG|x', T0 - 86401);
    d._sentBars.set('1|B|LONG|x', T0 - 86400);       // exactly 24 h: kept (strict cutoff)
    const ctx = {
      now: () => T0, log: capture().log, scanners: req('../../../services/engine/scanners/index.js'), smcInstance: () => null,
      confluence: () => ({ gcRecent: () => 0 }), balanceCache: () => ({ gcCache: () => 0 }), freeReport: () => ({ previewSent: new Map() }),
    };
    expect(SCH.cacheGcOnce(ctx)).toEqual({ 'volume_scanner._sent_bars': 1 });
    expect(Array.from(d._sentBars.keys())).toEqual(['1|B|LONG|x']);
  });
});

describe('genome under the scheduler', () => {
  it('genome_evolution_loop: `async with _evolution_lock` waits for a running manual evolution instead of skipping the cycle', async () => {
    const lock = req('../../../services/genome/lock.js');
    const evolve = req('../../../services/genome/evolve.js');
    const runner = req('../../../services/genome/runner.js');
    let releaseManual = null;
    runner.setRunner(() => new Promise((r) => { releaseManual = r; }));
    const manual = runner.triggerEvolution('LEVELS', '1h');
    expect(runner.isRunning()).toBe(true);
    const events = [];
    const store = { kvGet: () => null, kvSet: () => {} };
    let stopNow = false;
    const loop = evolve.genomeEvolutionLoop({
      now: () => Date.now() / 1000, log: { info() {}, warn() {}, warning() {}, debug() {} }, store,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), state: { lock: runner.LOCK }, stop: () => stopNow,
      waitForLowLoad: async () => true,
      runCycle: async () => { events.push(['cycle', Date.now() - T0 * 1000]); stopNow = true; },
    });
    await vi.advanceTimersByTimeAsync(300_000 + 10);   // INITIAL_DELAY: the manual run still holds the lock
    expect(events).toEqual([]);
    expect(lock.waiting(runner.LOCK)).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);        // two minutes later the manual run ends …
    releaseManual({ ok: true });
    expect(await manual).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual([['cycle', 420_010]]);      // … and the waiting cycle starts at once (no 60 s re-poll)
    await loop;
    expect(runner.LOCK.held).toBe(false);
    runner.setRunner(null);
  });

  it('the cached BTC regime of the thread goes with the genome job and is re-sent when it changes (drift / paper validation in the genome thread)', async () => {
    vi.useRealTimers();
    const { handleMessage, regimeState } = req('../../../workers/genomeWorker.js');
    const regime = req('../../../services/genome/regime.js');
    await handleMessage({ type: 'regime', regime: 'trending_up' }, () => {});
    expect(regimeState.value).toBe('trending_up');
    expect(regime.getCachedRegime()).toBe('trending_up');
    await handleMessage({ type: 'regime', regime: null }, () => {});
    expect(regime.getCachedRegime()).toBe(null);
    // the runner side: a fake worker records what the main thread posts
    const posted = [];
    const handlers = {};
    class FakeWorker {
      constructor() { this.listeners = handlers; }
      on(ev, fn) { handlers[ev] = fn; }
      postMessage(m) { posted.push(m); }
      terminate() { return Promise.resolve(); }
    }
    const wt = req('worker_threads');
    const RealWorker = wt.Worker;
    wt.Worker = FakeWorker;
    try {
      const runner = req('../../../services/genome/runner.js');
      let current = 'ranging';
      const p = runner.runGenerationInWorker({ strategy: 'SMC', tf: '1h', mode: 'cycle', regimeOf: () => current });
      expect(posted[0]).toMatchObject({ type: 'evolve', strategy: 'SMC', tf: '1h', regime: 'ranging' });
      handlers.message({ type: 'progress', done: 1, total: 10 });
      current = 'trending_down';
      handlers.message({ type: 'progress', done: 2, total: 10 });
      handlers.message({ type: 'progress', done: 3, total: 10 });
      handlers.message({ type: 'result', result: { ok: true } });
      expect(await p).toEqual({ ok: true });
      expect(posted.slice(1)).toEqual([{ type: 'regime', regime: 'trending_down' }]);
    } finally {
      wt.Worker = RealWorker;
    }
  });
});
