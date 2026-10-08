/**
 * evolve_generation / trigger_evolution_now / the genome worker on a temp site DB.
 * The flow is pinned to genome.py (genome-challenge-profiles.md §1.8): INIT / RESET / PAUSED,
 * elitism (n_elite = int(10 × 0.25) = 2), births, stagnation injection, fitness decay, the
 * per-genome and 1800 s generation deadlines, batch save + history, progress logs, the
 * drift → paper → auto-apply chain; offspring are reproducible for a fixed seed.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-genome-evolve.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const { memLog } = require('./helpers');

let db; let store; let evolve; let E; let rngMod; let runner; let gs; let loadFrame;
const NOW = 1_790_000_000;
const COINS = ['BTC-USDT-SWAP', 'SYNDN01-USDT-SWAP', 'SYNLV01-USDT-SWAP'];

beforeAll(() => {
  db = require('../../models/database');
  store = require('../../services/genome/store');
  evolve = require('../../services/genome/evolve');
  E = require('../../services/genome/evaluate');
  rngMod = require('../../services/genome/rng');
  runner = require('../../services/genome/runner');
  gs = require('../../services/genome/geneSpace');
  ({ loadFrame } = require('../golden/load'));
});

beforeEach(() => {
  for (const t of ['genome_population', 'genome_history', 'optimizer_params', 'engine_kv']) db.prepare(`DELETE FROM ${t}`).run();
  evolve._resetState();
  E.EVAL_CACHE.clear();
});

function preloaded() {
  return new Map(COINS.map((c) => [c, loadFrame(c, '15m')]));
}

/** deps for a deterministic in-process generation (real VOLUME backtests on golden candles). */
function deps(extra = {}) {
  let mono = 0;
  return {
    rng: rngMod.createRng(extra.seed ?? 2026),
    now: () => NOW,
    mono: () => (mono += 1),
    sleep: async () => {},
    cpuShare: 0.15,
    log: extra.log || memLog(),
    getCoins: async () => COINS.slice(),
    preloaded: preloaded(),
    cache: new Map(),
    getRegime: () => null,
    ...extra,
  };
}

const rows = (S, tf, gen) => db.prepare('SELECT id, genome_json, birth_type, parent_a, parent_b, fitness, trades FROM genome_population WHERE strategy=? AND timeframe=? AND generation=? ORDER BY id').all(S, tf, gen);

describe('evolve_generation', () => {
  it('INIT: 10 random genomes evaluated, saved (one batch) + history row; log markers', async () => {
    const log = memLog();
    const r = await evolve.evolveGeneration('VOLUME', '1h', deps({ log }));
    expect(r).toMatchObject({ strategy: 'VOLUME', tf: '1h', generation: 1, pop_size: 10 });
    const pop = rows('VOLUME', '1h', 1);
    expect(pop).toHaveLength(10);
    expect(new Set(pop.map((p) => p.birth_type))).toEqual(new Set(['random']));
    const hist = store.getHistory('VOLUME', '1h');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ generation: 1, pop_size: 10, created_at: NOW });
    expect(hist[0].best_fitness).toBe(Math.max(...pop.map((p) => p.fitness)));
    expect(r.best_fitness).toBe(hist[0].best_fitness);
    const msgs = log.lines.map((l) => l[1]);
    for (const m of ['[VOLUME/1h] INIT generation 1: random pop of 10', '[VOLUME/1h] coins: BTC(2000b), SYNDN01(2000b), SYNLV01(2000b)',
      '[VOLUME/1h] evaluating 10 genomes on 3 coins (prefetched 3)', '[VOLUME/1h] progress 3/10', '[VOLUME/1h] progress 10/10', '[VOLUME/1h] gen 1 done in']) {
      expect(msgs.some((x) => x.includes(m)), m).toBe(true);
    }
    expect(pop.some((p) => p.trades > 0)).toBe(true);
  }, 60_000);

  it('generation 2: 2 elites (ids of gen 1) + 8 offspring with the bot birth types; reproducible for a seed', async () => {
    const run = async (seed) => {
      for (const t of ['genome_population', 'genome_history']) db.prepare(`DELETE FROM ${t}`).run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name='genome_population'").run();
      evolve._resetState();
      const rng = rngMod.createRng(seed);
      await evolve.evolveGeneration('VOLUME', '1h', deps({ rng }));
      await evolve.evolveGeneration('VOLUME', '1h', deps({ rng }));
      return { g1: rows('VOLUME', '1h', 1), g2: rows('VOLUME', '1h', 2) };
    };
    const a = await run(77);
    const elites = a.g2.filter((p) => p.birth_type === 'elite');
    expect(elites).toHaveLength(2);
    const g1ById = new Map(a.g1.map((p) => [p.id, p]));
    const top2 = a.g1.slice().sort((x, y) => y.fitness - x.fitness).slice(0, 2).map((p) => p.genome_json);
    expect(elites.map((e) => g1ById.get(e.parent_a).genome_json).sort()).toEqual(top2.sort());
    for (const p of a.g2) {
      expect(['elite', 'crossover', 'mutation', 'bayesian_mut', 'cross_strategy', 'random_inject']).toContain(p.birth_type);
      if (p.birth_type !== 'elite') { expect(g1ById.has(p.parent_a)).toBe(true); expect(g1ById.has(p.parent_b)).toBe(true); }
    }
    const b = await run(77);
    expect(b.g2.map((p) => [p.genome_json, p.birth_type, p.fitness])).toEqual(a.g2.map((p) => [p.genome_json, p.birth_type, p.fitness]));
    const c = await run(78);
    expect(c.g2.map((p) => p.genome_json)).not.toEqual(a.g2.map((p) => p.genome_json));
  }, 120_000);

  it('stale reset after 2 zero-fitness generations, PAUSED after more than 3 consecutive resets', async () => {
    const zeroEval = async () => ({ winrate: 0, profit_factor: 0, trades: 0, drawdown: 0, fitness: 0 });
    const log = memLog();
    const d = () => deps({ log, evaluate: zeroEval });
    let r = await evolve.evolveGeneration('SMC', '1h', d());      // gen 1 (INIT)
    r = await evolve.evolveGeneration('SMC', '1h', d());          // gen 2 (evolved)
    expect(r.generation).toBe(2);
    for (let k = 1; k <= 3; k++) {
      r = await evolve.evolveGeneration('SMC', '1h', d());
      expect(r.generation).toBe(2 + k);
      expect(rows('SMC', '1h', 2 + k).every((p) => p.birth_type === 'random')).toBe(true);
      expect(log.lines.some(([, m]) => m.includes(`STALE DETECTED — last 2 gens all fitness=0, force reset с новой случайной популяции (reset ${k}/3)`))).toBe(true);
    }
    r = await evolve.evolveGeneration('SMC', '1h', d());
    expect(r).toEqual({ generation: 5, best_fitness: 0, best_wr: 0, best_pf: 0, elapsed: 0 });
    expect(log.lines.some(([, m]) => m.includes('PAUSED — 4 consecutive stale resets, skipping until next bot restart'))).toBe(true);
  }, 60_000);

  it('stagnation → min(0.6, mut_rate × 2.5) and int(8 × 0.3) = 2 random_inject offspring', async () => {
    const log = memLog();
    let k = 0;
    const evalStub = async () => ({ winrate: 50, profit_factor: 1.5, trades: 20, drawdown: 1, fitness: 1.0 + ((k++) % 10) * 0.001 });
    await evolve.evolveGeneration('LEVELS', '4h', deps({ log, evaluate: evalStub }));
    await evolve.evolveGeneration('LEVELS', '4h', deps({ log, evaluate: evalStub }));
    await evolve.evolveGeneration('LEVELS', '4h', deps({ log, evaluate: evalStub }));
    await evolve.evolveGeneration('LEVELS', '4h', deps({ log, evaluate: evalStub }));
    const g4 = rows('LEVELS', '4h', 4);
    expect(g4.filter((p) => p.birth_type === 'random_inject')).toHaveLength(2);
    expect(log.lines.map((l) => l[1]).filter((m) => m.includes('STAGNATION')), 'stagnation log').toEqual([expect.stringContaining('(best=1.009). Injecting diversity: mut_rate 0.30 → 0.60 for offspring.')]);
    expect(log.lines.some(([, m]) => m.includes('DIVERSITY-INJECTION: 2 random offspring + mut_rate=0.60 for remaining 6 slots'))).toBe(true);
  }, 60_000);

  it('per-genome TIMEOUT → zero metrics; the 1800 s generation deadline aborts without saving', async () => {
    const log = memLog();
    let n = 0;
    const evalTimeout = async () => { n++; if (n === 2) throw new E.DeadlineError('genome'); return { winrate: 40, profit_factor: 1, trades: 5, drawdown: 1, fitness: 0.2 }; };
    await evolve.evolveGeneration('SMC', '15m', deps({ log, evaluate: evalTimeout }));
    expect(log.lines.some(([, m]) => m.includes('[SMC/15m] genome eval TIMEOUT (1600s) — skipping'))).toBe(true);
    expect(rows('SMC', '15m', 1).filter((p) => p.trades === 0)).toHaveLength(1);

    let t = 0;
    const slowEval = async () => { t += 400_000; return { fitness: 0.1, trades: 3 }; };
    const r = await evolve.evolveGeneration('SMC', '4h', deps({ log, evaluate: slowEval, mono: () => t }));
    expect(r).toMatchObject({ generation: 1, best_fitness: 0, best_wr: 0, best_pf: 0 });
    expect(rows('SMC', '4h', 1)).toHaveLength(0);
    expect(log.lines.some(([, m]) => m.includes('[SMC/4h] FULL generation eval TIMEOUT (1800s) — aborting'))).toBe(true);
  }, 60_000);

  it('no coins / no candles → the zero dict with the generation number', async () => {
    const log = memLog();
    let r = await evolve.evolveGeneration('VOLUME', '4h', deps({ log, getCoins: async () => [] }));
    expect(r).toMatchObject({ generation: 1, best_fitness: 0 });
    expect(log.lines.some(([, m]) => m.includes('no coins from context-aware — skipping evaluation'))).toBe(true);
    r = await evolve.evolveGeneration('VOLUME', '4h', deps({ log, preloaded: undefined, loader: { loadCached: async () => null } }));
    expect(r).toMatchObject({ generation: 1, best_fitness: 0 });
    expect(log.lines.some(([, m]) => m.includes('[VOLUME/4h] coins: NONE'))).toBe(true);
    expect(log.lines.some(([, m]) => m.includes('no candle data loaded — skipping'))).toBe(true);
  });

  it('live baseline kv (< 7 d) is passed to every evaluation; drift false + paper OK → auto-apply with the best', async () => {
    store.kvSet('genome_live_baseline_LEVELS_1h', JSON.stringify({ live_wr: 52.5, live_pf: 1.4, n: 40, regime: 'ranging', ts: NOW - 3600 }));
    const seen = [];
    const applied = [];
    const log = memLog();
    await evolve.evolveGeneration('LEVELS', '1h', deps({
      log,
      evaluate: async (S, g, tf, o) => { seen.push(o.liveWrBaseline); return { winrate: 60, profit_factor: 2, trades: 30, drawdown: 1, fitness: 0.9 }; },
      drift: () => ({ drift: false, delta: 9.5, threshold: 25, regime: 'ranging', live_wr: 40, predicted_live_wr: 49.5 }),
      paper: () => ({ status: 'OK' }),
      autoApply: (S, tf, best) => applied.push([S, tf, best.fitness]),
    }));
    expect(seen).toEqual(Array(10).fill(52.5));
    expect(log.lines.some(([, m]) => m.includes('live calibration baseline: WR=52.5% (N=40, regime=ranging) — applying to evaluations'))).toBe(true);
    expect(log.lines.some(([, m]) => m.includes('drift approaching: delta=9.5% (threshold 25.0% regime=ranging) — live 40.0 vs predicted 49.5'))).toBe(true);
    expect(applied).toEqual([['LEVELS', '1h', 0.9]]);
  });

  it('paper INSUFFICIENT / FAILED / ERROR or drift → no auto-apply', async () => {
    for (const [pv, dr] of [[{ status: 'INSUFFICIENT_DATA', n: 3 }, false], [{ status: 'FAILED', paper_wr: 40, paper_pf: 0.8, wr_threshold: 45, pf_threshold: 1, regime: 'x', paper_trades: 31 }, false], [{ status: 'ERROR', skip_reason: 'error: TypeError' }, false], [{ status: 'OK' }, true]]) {
      for (const t of ['genome_population', 'genome_history']) db.prepare(`DELETE FROM ${t}`).run();
      const log = memLog();
      const applied = [];
      await evolve.evolveGeneration('SMC', '1h', deps({
        log, evaluate: async () => ({ winrate: 60, profit_factor: 2, trades: 30, drawdown: 1, fitness: 0.9 }),
        drift: () => (dr ? { drift: true, delta: 30, threshold: 15, regime: 'trending_up', backtest_wr: 80, predicted_live_wr: 56, live_wr: 26, live_trades: 40, breakdown: { tp: 9, be_half: 1.0, manual_win: 0, manual_half: 0, sl: 29 } } : { drift: false }),
        paper: () => pv, autoApply: () => applied.push(1),
      }));
      expect(applied).toEqual([]);
      const msgs = log.lines.map((l) => l[1]).join('\n');
      if (pv.status === 'INSUFFICIENT_DATA') expect(msgs).toContain('PAPER VALIDATION: insufficient sample (N=3 < 30) — skip auto-apply, wait for more live trades');
      if (pv.status === 'FAILED') expect(msgs).toContain('PAPER VALIDATION FAILED: WR=40.0% ✗ (need ≥45, -5.0pp) PF=0.80 ✗ (need ≥1.00, -0.20 regime=x) N=31 — skip auto-apply');
      if (pv.status === 'ERROR') expect(msgs).toContain('PAPER VALIDATION ERROR: error: TypeError — skip auto-apply to be safe');
      if (dr) expect(msgs).toContain('DRIFT DETECTED: backtest WR=80.0% → predicted 56.0% vs live WR=26.0% (delta=30.0% > 15.0% regime=trending_up) [N=40: TP=9 BE/2=1 MANUAL_win=0 MANUAL/2=0 SL=29]');
      if (dr) expect(msgs).toContain('auto-apply SKIPPED: drift detected');
    }
  });

  it('[GENOME-STALE-FITNESS] after 5 generations with best_fit < 0.1', async () => {
    const log = memLog();
    const lowEval = async () => ({ winrate: 30, profit_factor: 0.5, trades: 3, drawdown: 1, fitness: 0.05 });
    for (let k = 0; k < 5; k++) await evolve.evolveGeneration('VOLUME', '15m', deps({ log, evaluate: lowEval }));
    expect(log.lines.some(([, m]) => m.includes('[GENOME-STALE-FITNESS] VOLUME/15m: 5 поколений подряд best_fit=0.050 < 0.10'))).toBe(true);
  });
});

describe('trigger_evolution_now', () => {
  it('lock held → "Эволюция уже идёт", manual 700 s deadline → "Таймаут 10 мин …", success → ok + result', async () => {
    evolve.STATE.lock.held = true;
    expect(await evolve.triggerEvolutionNow('SMC', '1h', deps())).toEqual({ ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' });
    evolve.STATE.lock.held = false;
    let t = 0;
    const r1 = await evolve.triggerEvolutionNow('SMC', '1h', deps({ mono: () => t, evaluate: async () => { t += 800_000; return { fitness: 1 }; } }));
    expect(r1).toEqual({ ok: false, error: 'Таймаут 10 мин — OKX недоступен или данных нет' });
    expect(evolve.STATE.lock.held).toBe(false);
    const r2 = await evolve.triggerEvolutionNow('SMC', '1h', deps({ evaluate: async () => ({ winrate: 55, profit_factor: 1.4, trades: 12, drawdown: 2, fitness: 0.7 }) }));
    expect(r2).toMatchObject({ ok: true, strategy: 'SMC', tf: '1h', generation: 1, pop_size: 10, best_fitness: 0.7, best_wr: 55, best_pf: 1.4 });
  });

  it('runner.triggerEvolution: one run at a time, injectable runner', async () => {
    let release;
    runner.setRunner(() => new Promise((r) => { release = r; }));
    const p = runner.triggerEvolution('LEVELS', '1h');
    expect(runner.isRunning()).toBe(true);
    expect(await runner.triggerEvolution('SMC', '1h')).toEqual({ ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' });
    release({ ok: true, generation: 3 });
    expect(await p).toEqual({ ok: true, generation: 3 });
    expect(runner.isRunning()).toBe(false);
    runner.setRunner(null);
  });
});

describe('the 6 h loop and its kv resume mark', () => {
  it('seconds until the next cycle from genome_evolution_last_ts_v1; mark = str(now)', () => {
    expect(evolve.secondsUntilNextEvolution(store, NOW)).toBe(0);
    evolve.markEvolutionDone(store, NOW - 3600);
    expect(store.kvGet('genome_evolution_last_ts_v1')).toBe('1789996400.0');
    expect(evolve.secondsUntilNextEvolution(store, NOW)).toBe(5 * 3600);
    expect(evolve.secondsUntilNextEvolution(store, NOW + 6 * 3600)).toBe(0);
  });

  it('loop: initial delay, resume wait, one cycle under the lock, mark, interval sleep', async () => {
    const sleeps = [];
    let cycles = 0;
    let stopAfter = 1;
    evolve.markEvolutionDone(store, NOW - 2 * 3600);
    await evolve.genomeEvolutionLoop({
      now: () => NOW, log: memLog(), sleep: async (ms) => { sleeps.push(ms); },
      runCycle: async () => { cycles++; stopAfter--; },
      stop: () => stopAfter <= 0,
    });
    expect(sleeps[0]).toBe(300_000);
    expect(sleeps[1]).toBe(4 * 3600 * 1000);
    expect(cycles).toBe(1);
    expect(store.kvGet('genome_evolution_last_ts_v1')).toBe('1790000000.0');
  });
});

describe('genomeWorker (worker_threads)', () => {
  it('runs ONE generation per message with progress messages and writes the history row', async () => {
    const candles = {};
    for (const c of COINS) {
      const f = loadFrame(c, '15m');
      candles[c] = { t: Array.from(f.t), o: Array.from(f.o), h: Array.from(f.h), l: Array.from(f.l), c: Array.from(f.c), v: Array.from(f.v) };
    }
    const progress = [];
    const res = await runner.runGenerationInWorker({
      strategy: 'VOLUME', tf: '15m', mode: 'cycle', candles, coins: COINS, cpuShare: 1.0, seed: 5, timeoutS: 600,
      onProgress: (m) => progress.push(m),
    });
    expect(res).toMatchObject({ ok: true, strategy: 'VOLUME', tf: '15m', generation: 1, pop_size: 10 });
    expect(progress.length).toBe(10);
    expect(progress[9]).toMatchObject({ type: 'progress', done: 10, total: 10, generation: 1 });
    const h = store.getHistory('VOLUME', '15m');
    expect(h).toHaveLength(1);
    expect(h[0].best_fitness).toBe(res.best_fitness);
  }, 120_000);

  it('handleMessage ignores non-evolve messages', async () => {
    const { handleMessage } = require('../../workers/genomeWorker');
    expect(await handleMessage({ type: 'ping' }, () => {})).toBeNull();
  });
});
