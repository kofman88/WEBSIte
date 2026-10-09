/**
 * Engine integration: fake WS feed + golden candles → the engine worker (workers/engineWorker.js
 * runWorker over a real MessageChannel) running the three REAL scanners — LEVELS (MidScanner,
 * levelsScanner.js), SMC (smcScanner.js) and VOLUME (volumeScanner.js) — with the scheduler's
 * wiring (scheduler.scannerDeps / siteSafeSend / siteSendChart) → signal_trades rows + delivered
 * cards over one 1h close and one 4h close.
 *
 * The worker half runs the 'worker' side of the scheduler restricted to ws_feed + scanner +
 * smc_scanner + volume_scanner, with every default module instance (signal registry, free report,
 * trend monitor, confluence, freshness, momentum veto, coin-quality blacklist, regime,
 * signalTradesRepo on the test DB, the strategy engines, cards, watermark, position line). The
 * main half answers its delivery RPCs with signalDelivery.createSignalDelivery() → the real
 * notifier (notifications table + SSE registry; no e-mail / Telegram: the users are unverified
 * and not linked) → signal_msg_id + card snapshot. Nothing touches the network: the REST client
 * and the candle store are fakes, the WS pool is a fake that feeds the candle cache and fires the
 * real bar-close bus (marketData/bingxWsFeed.fireBarClose).
 *
 * Users (Pro): LEVELS 1h and 4h (LONG + SHORT jobs; the 4h jobs on a 4 h interval, so only the
 * 4H bar close re-arms them), SMC tf_key 1H and 4H, VOLUME 1h and 4h.
 *
 * Timeline (fake clock; setImmediate left real so MessagePort messages flow):
 *   T1 − 60 s   worker starts; the feed is connecting: empty cache, REST answers nothing → the first
 *               cycle of every scanner scans its users (LEVELS jobs / SMC interval gates stamped)
 *               and writes nothing
 *   T1 (1h)     the feed's bars closed ≤ T1 land in the candle cache, then the bar-close bus fires
 *               15m + 1H for every coin → LEVELS resets its 1h jobs, SMC its users, VOLUME wakes →
 *               rows + delivered cards for the 1h users of the three strategies
 *   T4 (4h)     the same with 15m + 1H + 4H → the 4h users' rows
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
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
const { runEngine, USERS, T1, T4, START } = req('./engineHarness.js');

let R = null;
const run = () => runEngine({ vi });

const byUser = (rows, uid) => rows.filter((r) => r.user_id === uid);
const STRAT_OF = Object.fromEntries(USERS.map(([uid, s, tf]) => [uid, [s, tf]]));

describe('engine worker integration — the three real scanners over one 1h close and one 4h close (fake feed + golden candles)', () => {
  beforeAll(async () => { R = await run(); }, 600_000);
  afterAll(() => { vi.useRealTimers(); });

  it('the worker starts the real LEVELS / SMC / VOLUME scanners from the registry (no fakes)', () => {
    expect(R.tasks).toEqual(['scanner', 'ws_feed', 'smc_scanner', 'volume_scanner']);
    for (const name of ['MidScanner', 'SmcScanner', 'VolumeScanner']) expect(R.scanners[name]).toMatchObject({ available: true, error: null });
    const starts = R.logs.map(([, , m]) => m);
    expect(starts).toContain('🚀 MidScanner v4 | Воркеров: 4 | API: 12');
    expect(starts).toContain('[WS-TRIGGER] registered bar-close callback for LEVELS scanner');
    expect(starts).toContain('[WS-TRIGGER] registered bar-close callback for SMC scanner');
    expect(starts).toContain('[VOLUME-START] Volume scanner started, interval=60s');
    expect(starts).toContain('SMC Scanner started, interval=300s');
  });

  it('before the first close the feed has no data: every scanner ran its first cycle and wrote nothing', () => {
    expect(R.before.rows).toBe(0);
    expect(R.before.passes.levels).toBeGreaterThanOrEqual(1);
    expect(R.before.passes.smc).toBeGreaterThanOrEqual(1);
    for (const uid of [621, 622]) expect(R.before.lastScanSmc[uid]).toBeGreaterThanOrEqual(START);
    expect(Object.keys(R.levelsJobsBefore).sort()).toEqual(['611_LONG', '611_SHORT', '612_LONG', '612_SHORT']);
  });

  it('the 1h close: rows for the 1h users of all three strategies, written within seconds of the close; none for the 4h LEVELS / VOLUME users', () => {
    const rows = R.atT1.rows;
    for (const uid of [611, 621, 631]) {
      const mine = byUser(rows, uid);
      expect(mine.length, `user ${uid} ${STRAT_OF[uid]}`).toBeGreaterThan(0);
      for (const r of mine) {
        expect(r.strategy).toBe(STRAT_OF[uid][0]);
        expect(r.created_at).toBeGreaterThanOrEqual(T1);
        expect(r.created_at).toBeLessThan(T1 + 30);
      }
    }
    expect(byUser(rows, 612)).toEqual([]);
    expect(byUser(rows, 632)).toEqual([]);
    expect(byUser(rows, 611).every((r) => r.timeframe === '1h')).toBe(true);
    expect(byUser(rows, 631).every((r) => r.timeframe === '1h')).toBe(true);
    const lines = R.logs.filter(([t]) => t >= T1 && t < T4).map(([, , m]) => m);
    expect(lines.some((m) => /^\[WS-TRIGGER\] bar_close .+\/1H → reset 2 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
    expect(lines.some((m) => /^\[WS-TRIGGER\] SMC bar_close .+\/15m → reset 1 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
    expect(lines.some((m) => /^✅ LEVELS .+ → @611$/.test(m))).toBe(true);
    expect(lines.some((m) => /^SMC ✅ .+ → @621$/.test(m))).toBe(true);
    expect(lines.some((m) => /^\[VOLUME-SIGNAL\] uid=631 /.test(m))).toBe(true);
  });

  it('between the closes nothing new is written (same bars → dedup)', () => {
    expect(R.beforeT4.rows.map((r) => r.trade_id)).toEqual(R.atT1.rows.map((r) => r.trade_id));
  });

  it('the 4h close: rows for the 4h users of all three strategies, written within seconds of the close', () => {
    const fresh = R.atT4.rows.filter((r) => r.created_at >= T4);
    for (const uid of [612, 622, 632]) {
      const mine = byUser(fresh, uid);
      expect(mine.length, `user ${uid} ${STRAT_OF[uid]}`).toBeGreaterThan(0);
      for (const r of mine) {
        expect(r.strategy).toBe(STRAT_OF[uid][0]);
        expect(r.created_at).toBeLessThan(T4 + 30);
      }
    }
    expect(byUser(fresh, 612).every((r) => r.timeframe === '4h')).toBe(true);
    expect(byUser(fresh, 632).every((r) => r.timeframe === '4h')).toBe(true);
    const lines = R.logs.filter(([t]) => t >= T4).map(([, , m]) => m);
    expect(lines.some((m) => /^\[WS-TRIGGER\] bar_close .+\/4H → reset 2 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
  });

  it('every delivered row went through the main thread: a signal notification, signal_msg_id, the card snapshot (all three strategies)', () => {
    const notes = new Map(R.notes.map((n) => [n.id, n]));
    const delivered = R.atT4.rows.filter((r) => r.result === '');
    expect(new Set(delivered.map((r) => r.strategy))).toEqual(new Set(['LEVELS', 'SMC', 'VOLUME']));
    for (const r of delivered) {
      expect(r.signal_msg_id, r.trade_id).toBeGreaterThan(0);
      const n = notes.get(r.signal_msg_id);
      expect(n.user_id).toBe(r.user_id);
      expect(n.type).toBe('signal');
      expect(n.link).toBe(`/app/?tab=signals&id=${encodeURIComponent(r.trade_id)}`);
      const card = JSON.parse(r.signal_card_json);
      expect(card.html).toBe(n.body);
      expect(card.lang).toBe('ru');
      expect(Array.isArray(card.actions)).toBe(true);
    }
    // no undelivered card: every row of the run is a delivered one
    expect(R.atT4.rows.filter((r) => r.skip_reason === 'not_delivered')).toEqual([]);
    expect(R.notes.filter((n) => n.type === 'signal').length).toBe(delivered.length);
    expect(new Set(R.rpcMethods)).toEqual(new Set(['deliver', 'sendMessage', 'deliverChart']));
    expect(R.fromWorker).toContain('heartbeat');
  });

  it('LEVELS bumps signals_received of its users like the bot (the card counter)', () => {
    expect(R.users[611].signals_received).toBe(byUser(R.atT4.rows, 611).length);
    expect(R.users[612].signals_received).toBe(byUser(R.atT4.rows, 612).length);
  });

  it('the worker answered the shutdown with stopped; every loop ended inside the stop window and nothing runs afterwards', () => {
    expect(R.fromWorker).toContain('ready');
    expect(R.fromWorker).toContain('stopped');
    expect(R.stopRes.pending).toBe(0);
    expect(R.logsAfterStop.map(([, m]) => m)).toEqual([
      '🛑 Завершение — отменяем фоновые задачи...',
      `🛑 signal_registry persisted: ${R.stopRes.saved} записей`,
    ]);
    expect(R.stopRes.saved).toBeGreaterThan(0);
    expect(R.after.rows).toBe(0);
    expect(R.after.passes).toEqual(R.after.passesAtStop);
    expect(R.logs.filter(([, l]) => l === 'ERROR')).toEqual([]);
  });
});
