/**
 * Engine soak (soakHarness.js): the worker with every offline-capable loop over hours of fake time,
 * golden candles for 42 symbols delivered at every 15-minute boundary (15m / 1H / 4H / 1D closes),
 * 6 Pro users (LEVELS / SMC / VOLUME on 1h and 4h) + 2 free users (LEVELS quota, SMC preview).
 *
 *   cpu      process CPU (user + system) over one simulated hour that holds 1h closes and a 4h
 *            close, divided by 3600 s: the whole engine (all loops, the delivery RPCs, the
 *            main-side notifier, SQLite) runs in this process, so this is an upper bound of the
 *            worker's share of one core. Budget: < 10 % (PLAN M9).
 *   memory   every cache / registry / buffer the engine keeps stays bounded (the bot's caps and
 *            TTLs): sampled every simulated hour, the second half of the run adds nothing that
 *            should have plateaued, the TTL'd ones respect their TTL, and the heap after a full GC
 *            does not drift.
 *
 * The suite runs ENGINE_SOAK_HOURS (default 6 h: ≈ 4300 LEVELS cycles, 360 VOLUME cycles, 70 SMC
 * cycles, 24 bar-close events). ENGINE_SOAK_HOURS=17 gives the 1000-VOLUME-cycle run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9-engine-soak.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const { runSoak } = req('./soakHarness.js');

const HOURS = Math.max(6, Number(process.env.ENGINE_SOAK_HOURS || 6));
const VERBOSE = process.env.ENGINE_SOAK_VERBOSE === '1';
const { CROSS_TTL, CLEANUP_INTERVAL } = req('../../../services/engine/signalRegistry.js');
const { TASKS } = req('./soakHarness.js');
let R = null;

describe(`engine soak — ${HOURS} simulated hours, 42 symbols, every worker loop`, () => {
  beforeAll(async () => {
    // the CPU hour: 03:59:30 → 04:59:30 UTC holds the 04:00 1h + 4h close and the 15m closes after it
    R = await runSoak({
      vi, hours: HOURS, cpuHour: 4, onSample: VERBOSE ? (s) => console.log(JSON.stringify(s)) : null,
      // ENGINE_SOAK_SNAPSHOTS="6,16" + ENGINE_SOAK_SNAPSHOT_DIR: heap snapshots for a diff (investigations)
      snapshotHours: String(process.env.ENGINE_SOAK_SNAPSHOTS || '').split(',').filter(Boolean).map(Number),
      snapshotDir: process.env.ENGINE_SOAK_SNAPSHOT_DIR || null,
    });
    if (VERBOSE) {
      const byLevel = {};
      for (const [k, n] of R.counts) { const l = k.split(':')[0]; byLevel[l] = (byLevel[l] || 0) + n; }
      console.log(JSON.stringify({ cpu: R.cpu, cycles: R.cycles, rpcs: R.rpcs, restCalls: R.restCalls, barCloses: R.barCloses, logLines: byLevel }));
    }
  }, 900_000);
  afterAll(() => { vi.useRealTimers(); });

  it('every loop ran: LEVELS / VOLUME heartbeats, SMC passes, bar closes, signals written', () => {
    expect(R.cycles.levels).toBeGreaterThan(HOURS * 600);      // the 5 s scan loop
    expect(R.cycles.volume).toBeGreaterThanOrEqual(HOURS * 55);  // the 60 s floor
    expect(R.cycles.smc).toBeGreaterThanOrEqual(HOURS * 10);     // every 300 s
    expect(R.cycles.closes).toBeGreaterThanOrEqual(HOURS * 4);
    expect(R.samples[R.samples.length - 1].rows).toBeGreaterThan(0);
    const errors = [...R.counts].filter(([k]) => k.startsWith('ERROR:'));
    expect(errors).toEqual([]);
  });

  it('CPU: < 10 % of one core over the simulated hour of 1h / 4h closes, WS ingest included', async () => {
    expect(R.cpu).not.toBeNull();
    // the fake feed hands frames to the cache directly; the live one decodes a gzip kline push per
    // subscription update. Measure that path (BingxWsFeed.handleMessage: gunzip, JSON, bar state,
    // forming-bar throttle) on 42 symbols × 4 TFs and price it at 2 pushes / s per subscription.
    const WSF = req('../../../services/marketData/bingxWsFeed.js');
    const CC = req('../../../services/marketData/candleCache.js');
    const G = req('../../golden/load.js');
    const zlibM = req('zlib');
    const syms = JSON.parse(zlibM.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'scanners', 'levels_fixtures', 'scan.json.gz'))).toString('utf8')).symbols;
    const T = Date.parse('2025-12-29T12:00:00Z');
    let nowMs = T + 60_000;
    CC._resetForTests();
    CC.initCache(4000, { now: () => nowMs / 1000, log: { debug() {}, info() {}, warning() {}, error() {} } });
    const TFS = [['15m', '15m'], ['1H', '1h'], ['4H', '4h'], ['1D', '1d']];
    const feed = new WSF.BingxWsFeed({ now: () => nowMs, log: { debug() {}, info() {}, warning() {}, warn() {}, error() {} }, env: {} });
    feed._ws = { readyState: 1, send() {} };
    const frames = [];
    for (const s of syms) {
      for (const [tf, file] of TFS) {
        const f = G.loadFrame(s, file).closedPrefix(file, T, 300);
        CC.setCandles(s, tf, f, { [tf]: 3600 });
        feed._subscriptions.set(WSF.keyOf(s, tf), [s, tf]);
        const last = f.length - 1;
        const step = f.t[last] - f.t[last - 1];
        frames.push(WSF.encodeFrame({ code: 0, dataType: WSF.channelName(s, tf), s: 'x', data: [{ o: String(f.c[last]), h: String(f.c[last] * 1.001), l: String(f.c[last] * 0.999), c: String(f.c[last]), v: '12.5', T: f.t[last] + step }] }));
      }
    }
    const SUBS = frames.length;
    const PER_SUB_PER_S = 2;
    const SECONDS = 30;
    const c0 = process.cpuUsage();
    for (let sec = 0; sec < SECONDS; sec++) {
      for (let k = 0; k < PER_SUB_PER_S; k++) {
        for (const fr of frames) await feed.handleMessage(fr);
        nowMs += 1000 / PER_SUB_PER_S;
      }
    }
    const d = process.cpuUsage(c0);
    const wsRatio = ((d.user + d.system) / 1e6) / SECONDS;
    const msgUs = ((d.user + d.system) / (SUBS * PER_SUB_PER_S * SECONDS));
    CC._resetForTests();
    if (VERBOSE) console.log(JSON.stringify({ engineHourRatio: R.cpu.ratio, ws: { subs: SUBS, msgPerS: SUBS * PER_SUB_PER_S, usPerMsg: msgUs, ratio: wsRatio } }));
    expect(R.cpu.ratio + wsRatio).toBeLessThan(0.10);
  });

  it('memory: every engine cache / registry / buffer is bounded (second half adds nothing that should plateau)', () => {
    const half = Math.floor(R.samples.length / 2);
    const firstHalfMax = (k) => Math.max(...R.samples.slice(0, half + 1).map((s) => s.sizes[k]));
    const end = R.samples[R.samples.length - 1].sizes;
    // per-symbol / per-user / per-key structures: no growth once every symbol, user and TF was seen
    const PLATEAU = [
      'levels._indicators', 'levels._indConfigs', 'levels._lastScan', 'levels._tradeLocks', 'levels._wsTrigLast',
      'levels.indicator.htfZoneCache(sum)', 'smc._analyzers', 'smc._lastScan',
      'smc._tfCache', 'candleCache.size', 'barClose.callbacks', 'health._heartbeats',
      'health._errorCounts', 'freeReport.previewSent',
    ];
    for (const k of PLATEAU) expect([k, end[k] <= firstHalfMax(k)]).toEqual([k, true]);
    // in-flight things: bounded by the task count, nothing pending between cycles
    for (const s of R.samples) expect(s.sizes['scheduler.abortListeners']).toBeLessThanOrEqual(2 * TASKS.length);
    expect(end['remote.pending']).toBeLessThanOrEqual(1);
    expect(end['smc._pending']).toBeLessThanOrEqual(8);
    expect(end['levels._queue']).toBe(0);
    // caps / TTLs of the bot
    expect(end['candleCache.size']).toBeLessThanOrEqual(4000);
    expect(end['smc._analyzers']).toBeLessThanOrEqual(64);
    expect(end['levels.indicator.cooldown(sum)']).toBeLessThanOrEqual(500 * Math.max(1, end['levels._indicators']));
    // per symbol seen: they grow while new symbols reach the zone / HTF stage, capped like the bot
    expect(end['levels.indicator.zoneCache(sum)']).toBeLessThanOrEqual(350 * Math.max(1, end['levels._indicators']));
    expect(end['volume._htfCache']).toBeLessThanOrEqual(42 * 3);
    expect(end['confluence.entries']).toBeLessThanOrEqual(42 * 2 * 3);        // (symbol, direction) × one per strategy
    expect(end['barClose.callbacks']).toBe(3);
    // signal registry: a key outlives its 4 h TTL by at most the 30 min cleanup period (+ the time to the next commit)
    const last = R.samples[R.samples.length - 1];
    expect(last.registryOldestAgeS).toBeLessThanOrEqual(CROSS_TTL + CLEANUP_INTERVAL + 3600);
    expect(last.sentBarsOldestAgeS).toBeLessThanOrEqual(86400 + 3600);    // _sent_bars: 24 h, swept hourly by cache_gc
  });

  it('memory: the data heap after a full GC does not drift over the second half', () => {
    const half = R.samples.slice(Math.floor(R.samples.length / 2));
    const first = half[0].heapData;
    const last = half[half.length - 1].heapData;
    // 2 MB of slack (statement caches, the rows / notifications the run writes, the registry and
    // _sent_bars inside their TTL); a per-cycle leak of 1 KB would be ≈ 2 MB over 2000 LEVELS cycles
    expect(last - first).toBeLessThan(2 * 1024 * 1024);
  });

  it('stop: the worker stops cleanly, no abort listener is left behind', () => {
    expect(R.stopRes).toMatchObject({ pending: 0 });
    expect(R.listenersAfterStop).toBe(0);
  });
});
