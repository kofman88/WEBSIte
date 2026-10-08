/**
 * compute_fitness, Wilson CI, Monte Carlo and evaluate_genome's scoring.
 *
 * Python vectors (make_genome_vectors.py "fitness" / "evaluate"):
 *   genome.compute_fitness(wr, pf, n, dd)                         325 cases incl. the DD quirk
 *   math.log1p(n) for n in 0..400                                  (JS Math.log1p must be bit-identical)
 *   the verbatim Wilson block of evaluate_genome (z = 1.96)        ~200 (n, wins) pairs
 *   await genome.evaluate_genome(S, g, tf, _preloaded=fake results, _live_wr_baseline=b)
 *       50 synthetic trade lists + 1 empty; random.Random(42) recorded → `mc_p95_raw`
 * The Monte-Carlo term uses the JS seeded RNG by design (PLAN M16): the parity tests inject the
 * bot's p95 drawdown (opts.mcP95Dd); the JS MC itself is pinned by formula below.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFixture, pyEqual, memLog } = require('./helpers');
const F = require('../../services/genome/fitness');
const E = require('../../services/genome/evaluate');
const { createRng } = require('../../services/genome/rng');

const FIT = loadFixture('fitness');
const EVS = loadFixture('evaluate_synthetic');

describe('compute_fitness', () => {
  it('325 Python vectors (WR % or fraction, PF < 1.2 penalty, no PF cap, N < 8 / > 50, DD ≤ 1 quirk)', () => {
    for (const c of FIT.compute_fitness) {
      expect(F.computeFitness(c.winrate, c.profit_factor, c.trades, c.drawdown), JSON.stringify(c)).toBe(c.out);
    }
  });

  it('the DD quirk: 0.9 R costs 0.9, 1.1 R costs 0.011', () => {
    const base = F.computeFitness(60, 2.0, 20, 0);
    expect(F.computeFitness(60, 2.0, 20, 0.9)).toBeCloseTo(base - 0.9, 3);
    expect(F.computeFitness(60, 2.0, 20, 1.1)).toBeCloseTo(base - 0.011, 3);
  });

  it('pyLog1p is bit-identical to CPython math.log1p for every trade count 0..2000 (V8 differs at 175, 184)', () => {
    for (const [n, v] of Object.entries(FIT.log1p)) expect(F.pyLog1p(Number(n)), n).toBe(v);
    expect(Math.log1p(175)).not.toBe(FIT.log1p['175']);
  });
});

describe('Wilson 95 % CI', () => {
  it('matches the verbatim evaluate_genome block', () => {
    for (const c of FIT.wilson) expect(F.wilsonCi(c.winrate, c.n), JSON.stringify(c)).toEqual(c.ci);
  });
});

describe('Monte Carlo (JS seeded RNG — formula pinned, values differ from Python by design)', () => {
  it('200 shuffles of the list, sorted drawdowns, index int(200 × 0.95) = 190', () => {
    const rr = [1.2, -1.1, 0.4, -1.1, -1.1, 2.3, 0, -0.2, 1.1, -1.1, 0.7, -1.1];
    const rng = createRng(42);
    const dds = [];
    for (let k = 0; k < 200; k++) {
      const sh = rr.slice();
      for (let i = sh.length - 1; i >= 1; i--) { const j = Math.floor(rng.random() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      dds.push(F.maxDrawdown(sh));
    }
    dds.sort((a, b) => a - b);
    expect(F.monteCarloP95Dd(rr, createRng(42))).toBe(dds[190]);
    expect(F.monteCarloP95Dd(rr)).toBe(F.monteCarloP95Dd(rr));       // default = mulberry32(42), reproducible
  });

  it('mc_mult thresholds 15 / 10 / 5 R', () => {
    expect(F.mcMultiplier(15.01)).toBe(0.5);
    expect(F.mcMultiplier(15)).toBe(0.7);
    expect(F.mcMultiplier(10)).toBe(0.9);
    expect(F.mcMultiplier(5)).toBe(1.0);
  });
});

function fakeFactory() {
  return () => ({
    runInThread(coin, df) {
      if (df && df.raise) throw new Error(`boom ${coin}`);
      return df === null || df === undefined ? null : df;
    },
  });
}

function fakeStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, kvGet: (k) => (m.has(k) ? m.get(k) : null), kvSet: (k, v) => { m.set(k, String(v)); } };
}

describe('evaluate_genome — 51 synthetic trade lists vs the bot (MC injected)', () => {
  it('metrics dict, per-coin quirk (wr 0.0), LOW-TRADES / EMPTY-RESULTS, coin-champion kv', async () => {
    let n = 0;
    for (const [i, c] of EVS.cases.entries()) {
      const store = fakeStore(c.kv_before);
      const before = new Map(store.m);
      const out = await E.evaluateGenome(c.strategy, c.genome, c.tf, {
        preloaded: c.preloaded,
        liveWrBaseline: c.baseline,
        deps: {
          backtesterFactory: fakeFactory(), cache: new Map(), now: () => EVS.now, mono: () => 0, sleep: async () => {},
          cpuShare: 0.15, log: memLog(), store, mcP95Dd: c.mc_p95_raw === null ? undefined : c.mc_p95_raw,
        },
      });
      expect(pyEqual({ ...out }, c.out), `case ${i}: js ${JSON.stringify(out)}\npy ${JSON.stringify(c.out)}`).toBe(true);
      const writes = {};
      for (const [k, v] of store.m) if (before.get(k) !== v) writes[k] = v;
      expect(writes, `case ${i} kv`).toEqual(c.kv_writes);
      if (out.trades > 0) n++;
    }
    expect(n).toBeGreaterThan(30);
  });

  it('LOW-TRADES returns _ZERO and caches it; EMPTY-RESULTS returns _ZERO and does not cache', async () => {
    const cache = new Map();
    const log = memLog();
    const deps = { backtesterFactory: fakeFactory(), cache, now: () => 1000, mono: () => 0, sleep: async () => {}, log, store: fakeStore() };
    const low = { A: { total_trades: 2, profit_factor: 1, trades: [{ exit_time: '2026-01-01 00:00:00', rr_realized: 1 }, { exit_time: '2026-01-02 00:00:00', rr_realized: -1 }] } };
    expect(await E.evaluateGenome('LEVELS', { min_rr: 2 }, '1h', { preloaded: low, deps })).toEqual(E.ZERO);
    expect(cache.size).toBe(1);
    expect(log.lines.some(([, m]) => m.includes('genome LOW-TRADES'))).toBe(true);
    const empty = { A: { total_trades: 0, profit_factor: 0, trades: [] } };
    expect(await E.evaluateGenome('LEVELS', { min_rr: 3 }, '1h', { preloaded: empty, deps })).toEqual(E.ZERO);
    expect(cache.size).toBe(1);
    expect(log.lines.some(([, m]) => m.includes('genome ZERO') && m.includes('A=0'))).toBe(true);
    expect(log.lines.some(([, m]) => m.includes('genome EMPTY-RESULTS'))).toBe(true);
    // cache hit < 3 h returns a copy
    const hit = await E.evaluateGenome('LEVELS', { min_rr: 2 }, '1h', { preloaded: low, deps: { ...deps, backtesterFactory: () => { throw new Error('not called'); } } });
    expect(hit).toEqual(E.ZERO);
  });

  it('CPU-share pacing: sleep elapsed × (1/share − 1) after every coin (> 10 ms only)', async () => {
    let t = 0;
    const sleeps = [];
    const res = { total_trades: 1, profit_factor: 1, trades: [] };
    await E.evaluateGenome('SMC', { min_rr: 1.5 }, '1h', {
      preloaded: { A: res, B: res },
      deps: {
        backtesterFactory: () => ({ runInThread: () => { t += 1000; return res; } }),
        cache: new Map(), now: () => 0, mono: () => t, sleep: async (ms) => { sleeps.push(ms); }, cpuShare: 0.15, log: memLog(), store: fakeStore(),
      },
    });
    const paced = sleeps.filter((ms) => ms > 0);
    expect(paced).toHaveLength(2);
    for (const ms of paced) expect(ms / 1000).toBeCloseTo(1 / 0.15 - 1, 9);
  });

  it('cache key = sha1("S|tf|days|compact json")[:16]; cleanup drops > 3 h then the oldest above 500', () => {
    expect(E.cacheKey('LEVELS', { b: 1, a: 2.0 }, '1h', 60)).toMatch(/^[0-9a-f]{16}$/);
    expect(E.cacheKey('LEVELS', { a: 2.0, b: 1 }, '1h', 60)).toBe(E.cacheKey('LEVELS', { b: 1, a: 2.0 }, '1h', 60));
    const cache = new Map();
    for (let k = 0; k < 600; k++) cache.set(`k${k}`, { ts: k < 50 ? 0 : 20000 + k, data: {} });
    E.cleanupEvalCache(cache, 20000 + 3 * 3600 - 1);
    expect(cache.size).toBe(500);
    expect(cache.has('k49')).toBe(false);
    expect(cache.has('k50')).toBe(false);
    expect(cache.has('k599')).toBe(true);
  });

  it('a genome deadline aborts the evaluation between coins (DeadlineError)', async () => {
    let t = 0;
    const res = { total_trades: 1, profit_factor: 1, trades: [] };
    await expect(E.evaluateGenome('SMC', { min_rr: 1.6 }, '1h', {
      preloaded: { A: res, B: res, C: res },
      deps: {
        backtesterFactory: () => ({ runInThread: () => { t += 5000; return res; } }),
        cache: new Map(), now: () => 0, mono: () => t, sleep: async () => {}, cpuShare: 1, log: memLog(), store: fakeStore(),
        deadlines: [{ at: 7000, kind: 'genome' }],
      },
    })).rejects.toMatchObject({ kind: 'genome' });
  });
});
