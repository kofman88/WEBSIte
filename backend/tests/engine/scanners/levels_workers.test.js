/**
 * MidScanner worker pool (scanner_mid._cycle / _worker): N queue workers, a failing job is
 * isolated ([WORKER-FAILED], task_done in finally), the 120 s join timeout cancels the workers
 * ([WORKER-CANCELLED]) and drains the stale jobs left in the queue ([QUEUE-DRAIN], audit ST-6).
 * The Python differentials run with SCAN_WORKERS=1 (thread timing makes N > 1 nondeterministic
 * in the bot); this pins the JS pool mechanics against the bot's code paths.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9b-workers-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'workers.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const LS = req('../../../services/engine/levelsScanner.js');
const candleCache = req('../../../services/marketData/candleCache.js');
const ts = req('../../../services/traderSettingsService.js');

const T0 = 1767189620;   // 2025-12-31T14:00:20Z
const SYMS = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SYNLV07-USDT-SWAP'];

function setup({ workers, nUsers, runJob }) {
  const clock = new H.Clock(T0);
  const cap = H.logCapture();
  const quiet = { debug() {}, info() {}, warning() {}, error() {} };
  candleCache._resetForTests();
  candleCache.initCache(4000, { now: () => clock.now(), log: quiet });
  const users = [];
  for (let i = 0; i < nUsers; i++) {
    const u = ts.defaults(9000 + i);
    Object.assign(u, { strategy: 'LEVELS', long_active: true, long_tf: '15m', long_interval: 900, sub_plan: 'pro', sub_status: 'active', sub_expires: T0 + 86400 });
    users.push(u);
  }
  let joinFire = null;
  const timers = {
    setTimeout: (fn, ms) => { if (ms === LS.QUEUE_JOIN_TIMEOUT_S * 1000) joinFire = fn; return {}; },
    clearTimeout: () => {},
  };
  const fetcher = new H.FakeFetcher(clock, Object.fromEntries(SYMS.map((s, i) => [s, 1e9 / (1 + i)])), {});
  const scanner = new LS.MidScanner({ SCAN_WORKERS: workers }, new H.FakeBot(), {
    getActiveUsers: async () => users, allUsers: async () => users, save: async () => {}, get: async () => null,
  }, null, {
    clock, timers, sleep: async () => {}, log: cap.make('CHM.Scanner'), fetcher, cache: candleCache,
    checkAccess: () => [true, ''], strategyEnabled: () => true, isAdmin: () => false,
    trend: { getTrend: () => null, applyMtfBonus: () => {}, trendContext: () => '', cardLine: () => '' },
    freshness: { reportCycleTime: () => {}, getCycleEma: () => null },
    regime: { getCachedRegime: () => null },
    fundamental: null,
    kv: H.memKv(),
  });
  scanner.fetcher = fetcher;
  const ran = [];
  scanner._runJob = (job, candles, token) => runJob(job, token, ran, () => joinFire && joinFire());
  return { scanner, cap, ran };
}

describe('MidScanner worker pool', () => {
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ } });
  it('N workers drain every job; a failing job logs [WORKER-FAILED] and the others still run', async () => {
    const { scanner, cap, ran } = setup({
      workers: 3, nUsers: 6,
      runJob: async (job, _t, done) => {
        await Promise.resolve();
        if (job.user.user_id === 9001) throw new Error('boom');
        done.push(job.jobKey);
      },
    });
    await scanner._cycle();
    expect(ran.sort()).toEqual(['9000_LONG', '9002_LONG', '9003_LONG', '9004_LONG', '9005_LONG']);
    const failed = cap.lines.filter((l) => l[2].includes('[WORKER-FAILED]'));
    expect(failed).toEqual([['ERROR', 'CHM.Scanner', '[WORKER-FAILED] wid=1 uid=9001 tf=15m: boom — сигналы для этого (user,tf) пропущены в текущем цикле']]);
    expect(cap.lines.some((l) => l[2].includes('TIMEOUT') || l[2].includes('[QUEUE-DRAIN]'))).toBe(false);
    expect(scanner._queue.qsize()).toBe(0);
    expect(scanner._queue.unfinished).toBe(0);
  });

  it('120 s join timeout: workers cancelled ([WORKER-CANCELLED]), stale queued jobs dropped ([QUEUE-DRAIN])', async () => {
    const { scanner, cap, ran } = setup({
      workers: 1, nUsers: 4,
      runJob: (job, token, done, fireJoinTimeout) => {
        if (job.user.user_id === 9001) {
          Promise.resolve().then(fireJoinTimeout);   // the hung job: the join wait times out
          return new Promise((_r, rej) => token.on(() => rej(new LS.CancelledError())));
        }
        done.push(job.jobKey);
        return Promise.resolve();
      },
    });
    await scanner._cycle();
    for (let i = 0; i < 5; i++) await Promise.resolve();   // let the cancelled worker finish
    expect(ran).toEqual(['9000_LONG']);
    const msgs = cap.lines.map((l) => l[2]);
    const iTimeout = msgs.indexOf('Scanner workers TIMEOUT (>120s) — cancelling remaining tasks');
    const iDrain = msgs.indexOf('[QUEUE-DRAIN] dropped 2 stale scan jobs after worker timeout');
    expect(iTimeout).toBeGreaterThanOrEqual(0);
    expect(iDrain).toBeGreaterThan(iTimeout);
    expect(msgs).toContain('[WORKER-CANCELLED] wid=0 uid=9001 tf=15m — task_done OK');
    expect(scanner._queue.qsize()).toBe(0);
    expect(scanner._queue.unfinished).toBe(0);
  });

  it('no jobs → no workers (n = min(SCAN_WORKERS, qsize) = 0)', async () => {
    const { scanner, cap } = setup({ workers: 4, nUsers: 2, runJob: async () => {} });
    for (const k of ['9000_LONG', '9001_LONG']) scanner._lastScan.set(k, T0);   // interval not passed
    await scanner._cycle();
    expect(cap.lines.some((l) => l[2].startsWith('🔍 Цикл'))).toBe(false);
  });
});
