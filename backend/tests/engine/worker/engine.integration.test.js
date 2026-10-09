/**
 * Engine integration: fake WS feed + golden candles → the engine worker (workers/engineWorker.js
 * runWorker over a real MessageChannel) → signal_trades rows for a Pro test user over one 1h close.
 *
 * The worker half runs the 'worker' side of the scheduler restricted to ws_feed + smc_scanner, with
 * every default module instance (signal registry, free report, trend monitor, confluence,
 * freshness, momentum veto, coin-quality blacklist, regime, signalTradesRepo on the test DB, the
 * SMC engine, cards, watermark, position line). The main half answers its delivery RPCs with
 * signalDelivery.createSignalDelivery() → the real notifier (notifications table + SSE registry;
 * no e-mail / Telegram: the user is unverified and not linked) → signal_msg_id + card snapshot.
 *
 * Timeline (fake clock, setImmediate left real so MessagePort messages flow):
 *   close − 60 s   worker starts; the feed is connecting: empty cache, REST returns nothing →
 *                  the first SMC cycle scans the user (interval gate stamped) and finds no data
 *   close          the feed's first bars land in the candle cache (golden frames closed ≤ close)
 *                  and it fires the 15m bar close → the SMC bar-close hook clears the user's gate
 *                  and wakes the loop → cycle → rows + delivered cards
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-engine-integration.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const SMC_FIX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'scanners', 'fixtures', 'smc_scanner.json.gz'))).toString('utf8'));
const S = SMC_FIX.scenario;
const CLOSE = S.cycles[0].t;            // a 1h bar close of the golden set
const START = CLOSE - 60;
const UID = 501;
const TF_FILE = { '15m': '15m', '1H': '1h', '4H': '4h', '1D': '1d' };

let R = null;

async function run() {
  vi.useFakeTimers({ now: START * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const { MessageChannel } = req('worker_threads');
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const G = req('../../golden/load.js');
  const candleCache = req('../../../services/marketData/candleCache.js');
  const wsPoolReal = req('../../../services/marketData/wsPool.js');
  const { fireBarClose } = req('../../../services/marketData/bingxWsFeed.js');
  const { runWorker } = req('../../../workers/engineWorker.js');
  const { createSignalDelivery } = req('../../../services/engine/signalDelivery.js');
  const smc = req('../../../services/engine/smcScanner.js');
  const mdLog = req('../../../services/marketData/mdLog.js');
  const LOGS = [];
  mdLog.setLogger({ debug() {}, info: (m) => LOGS.push(['INFO', String(m)]), warn: (m) => LOGS.push(['WARNING', String(m)]), error: (m) => LOGS.push(['ERROR', String(m)]) });

  // ── the Pro test user ──
  db.prepare("INSERT INTO users (id, email, password_hash, referral_code, locale, is_active, email_verified) VALUES (?, 'pro501@x.test', 'x', 'R501', 'ru', 1, 0)").run(UID);
  ts.save({ ...ts.defaults(UID), ...S.users[0][1], sub_expires: CLOSE + 30 * 86400 }, { now: START - 3600 });
  ts.invalidateCache();

  // ── fake feed + golden candles ──
  const VOL = Object.fromEntries(S.symbols);
  const COINS = S.symbols.map((x) => x[0]);
  candleCache.initCache(4000);
  let marketOpen = false;
  const frameAt = (s, tf) => G.loadFrame(s, TF_FILE[tf]).closedPrefix(TF_FILE[tf], Math.round(CLOSE * 1000), 300);
  const fetcher = {
    volBySym: { ...VOL },
    async getAllUsdtPairs(min) { return marketOpen ? COINS.filter((s) => VOL[s] >= min) : []; },
    async getCandles(symbol, tf, limit = 300) { return marketOpen ? frameAt(symbol, tf).tail(limit) : null; },
  };
  const feeds = [];
  let barCloses = 0;
  const wsPool = {
    DEFAULT_TIMEFRAMES: wsPoolReal.DEFAULT_TIMEFRAMES,
    resolveMaxSymbols: wsPoolReal.resolveMaxSymbols,
    selectUniverse: async () => COINS.slice(),
    getActiveFeeds: () => feeds.slice(),
    async runWsPool({ symbols, timeframes }) {
      const feed = { symbols, timeframes };
      feeds.push(feed);
      // the 1h close: the closed bars land in the cache, then the bar-close bus fires
      setTimeout(async () => {
        marketOpen = true;
        candleCache.setCoins(symbols);
        for (const s of symbols) for (const tf of timeframes) candleCache.setCandles(s, tf, frameAt(s, tf));
        for (const s of symbols) { await fireBarClose(s, '15m'); barCloses += 1; }
      }, CLOSE * 1000 - Date.now());
      return { feeds, async stop() {} };
    },
  };

  // ── the two halves over a real MessageChannel ──
  const ch = new MessageChannel();
  const delivery = createSignalDelivery({});
  const fromWorker = [];
  ch.port2.on('message', (msg) => {
    fromWorker.push(msg.type);
    delivery.handleWorkerMessage(msg, (m) => ch.port2.postMessage(m));
  });
  smc._resetDefault();
  const worker = runWorker(ch.port1, {
    logs: false,
    deps: { fetcher, wsPool, cache: candleCache, env: { ...process.env, CACHE_WARMER_ENABLED: '1' }, regimeProvider: false },
  });
  ch.port2.postMessage({ type: 'start', options: { only: ['ws_feed', 'smc_scanner'] } });

  const turn = () => new Promise((r) => setImmediate(r));
  // real turns for the MessagePort + 50 ms of fake time per turn (the scanner's 0.1 s pause per
  // symbol); far below the 60 s RPC timeout, so a delivery always gets its answer
  const settle = async (cond, max = 4000, stepMs = 50) => {
    for (let i = 0; i < max; i++) {
      await turn();
      await vi.advanceTimersByTimeAsync(stepMs);
      if (cond()) return i;
    }
    return -1;
  };
  const pending = () => {
    const sc = smc.currentScanner();
    return (sc ? sc._pending.size : 0) + worker.remote.pendingCount;
  };
  const rowsOf = () => db.prepare("SELECT * FROM signal_trades WHERE user_id = ? ORDER BY trade_id").all(UID);
  const cyclesDone = () => LOGS.filter(([, m]) => m.startsWith('[SMC-VOL-GATE-SUMMARY]')).length;

  await settle(() => worker.scheduler() !== null && fromWorker.includes('ready'), 100, 0);
  await vi.advanceTimersByTimeAsync(1000);             // first SMC cycle: no market data yet
  await settle(() => pending() === 0, 200);
  const rowsBefore = rowsOf().length;
  const lastScanBefore = smc.currentScanner()._lastScan.get(UID);
  const cyclesBefore = cyclesDone();
  await vi.advanceTimersByTimeAsync(CLOSE * 1000 - Date.now());   // → the 1h close
  await settle(() => barCloses === COINS.length && cyclesDone() > cyclesBefore && pending() === 0);
  const out = {
    cyclesBefore, cyclesAfter: cyclesDone(),
    rowsBefore, lastScanBefore,
    rows: rowsOf(),
    notes: db.prepare("SELECT id, type, title, body, link FROM notifications WHERE user_id = ? ORDER BY id").all(UID),
    fromWorker: fromWorker.slice(),
    logs: LOGS.slice(),
    now: Date.now() / 1000,
  };
  const stopping = worker.stop();
  for (let i = 0; i < 100 && !fromWorker.includes('stopped'); i++) {
    await turn();
    await vi.advanceTimersByTimeAsync(100);
  }
  const stopRes = await stopping;
  out.stopRes = stopRes;
  out.fromWorker = fromWorker.slice();
  ch.port1.close();
  ch.port2.close();
  mdLog.setLogger(null);
  vi.useRealTimers();
  return out;
}

describe('engine worker integration — fake feed + golden candles → signal_trades for a Pro user over one 1h close', () => {
  beforeAll(async () => { R = await run(); }, 120_000);
  afterAll(() => { vi.useRealTimers(); });

  it('before the close the feed has no data: the first cycle scans the user and writes nothing', () => {
    expect(R.rowsBefore).toBe(0);
    expect(R.lastScanBefore).toBeGreaterThanOrEqual(START);
    expect(R.lastScanBefore).toBeLessThan(START + 2);
  });

  it('the bar close wakes the SMC loop and the worker writes SMC rows for the Pro user at the close', () => {
    expect(R.rows.length).toBeGreaterThan(0);
    for (const r of R.rows) {
      expect(r.strategy).toBe('SMC');
      expect(r.user_id).toBe(UID);
      expect(r.created_at).toBeGreaterThanOrEqual(CLOSE);
      expect(r.created_at).toBeLessThan(CLOSE + 30);
      expect(r.trade_id).toMatch(new RegExp(`^${UID}_\\d{13}_\\d{3}$`));
      expect(r.result).toBe('');
      expect(['LONG', 'SHORT']).toContain(r.direction);
    }
    expect(R.logs.some(([, m]) => /^\[WS-TRIGGER\] SMC bar_close .+\/15m → reset 1 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
    expect(R.cyclesAfter).toBe(R.cyclesBefore + 1);
  });

  it('every row was delivered through the main thread: a feed notification, signal_msg_id, the card snapshot', () => {
    const notes = new Map(R.notes.map((n) => [n.id, n]));
    expect(R.notes.length).toBe(R.rows.length);
    for (const r of R.rows) {
      expect(r.signal_msg_id).toBeGreaterThan(0);
      const n = notes.get(r.signal_msg_id);
      expect(n.type).toBe('signal');
      expect(n.link).toBe(`/app/?tab=signals&id=${encodeURIComponent(r.trade_id)}`);
      const card = JSON.parse(r.signal_card_json);
      expect(card.html).toBe(n.body);
      expect(card.lang).toBe('ru');
      expect(Array.isArray(card.actions)).toBe(true);
    }
    expect(R.fromWorker).toContain('rpc');
    expect(R.fromWorker).toContain('heartbeat');
  });

  it('the worker answered the shutdown with stopped; every loop ended inside the stop window', () => {
    expect(R.fromWorker).toContain('ready');
    expect(R.fromWorker).toContain('stopped');
    expect(R.stopRes.pending).toBe(0);
  });
});
