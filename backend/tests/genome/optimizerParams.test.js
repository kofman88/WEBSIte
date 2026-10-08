/**
 * The read side of optimizer_params (what genome auto-apply writes), against
 * make_genome_vectors.py section "optimizer":
 *   normalize  optimizer._normalize_regime(v)
 *   regime     optimizer.params_for_regime(params, regime) — 20 shapes × 9 regimes, key order too
 *   levels     scanner_mid._run_job ШАГ 9 (verbatim copy): json.loads(row) → params_for_regime →
 *              cfg.min_rr / cfg.min_quality, flags × regime (incl. a raising regime cache) × cfg
 *   smc        smc/scanner per-user hoist → min_rr_filter / min_q_filter
 *   smc_pass   the per-signal gate on the hoisted filters
 * The JS side reads the row through the real store (in-memory SQLite, Python json.loads grammar).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { loadFixture, pyEqual, memLog } = require('./helpers');
const OP = require('../../services/genome/optimizerParams');
const store = require('../../services/genome/store');
const gs = require('../../services/genome/geneSpace');
const C = require('../../services/genome/config');

const F = loadFixture('optimizer');
let mem;

beforeAll(() => {
  mem = new Database(':memory:');
  mem.exec(`CREATE TABLE optimizer_params (user_id INTEGER NOT NULL, strategy TEXT NOT NULL DEFAULT 'LEVELS',
    params TEXT DEFAULT '{}', updated_at REAL DEFAULT 0, PRIMARY KEY (user_id, strategy))`);
  store.setDb(mem);
});
beforeEach(() => {
  mem.exec('DELETE FROM optimizer_params');
  store._clearParamsCache();
});

const seed = (strategy, stored) => {
  if (stored === null) return;
  mem.prepare('INSERT INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (7, ?, ?, 0)').run(strategy, stored);
};
const regimeFn = (r) => () => { if (r === '__RAISE__') throw new Error('regime cache broken'); return r; };

describe('optimizer._normalize_regime', () => {
  it('canonical names, aliases, case / whitespace, non-strings → ""', () => {
    for (const [v, out] of F.normalize) expect(OP.normalizeRegime(v), JSON.stringify(v)).toBe(out);
    // str.strip() strips \x1c-\x1f (JS trim does not) and keeps U+FEFF (JS trim strips it)
    expect(OP.normalizeRegime('\x1cranging\x1f')).toBe('ranging');
    expect(OP.normalizeRegime('﻿ranging')).toBe('');
  });
});

describe('optimizer.params_for_regime', () => {
  it('global ← _bayesian.params ← _regime[canon] with the diagnostic keys, in Python key order', () => {
    for (const c of F.regime) {
      const res = OP.paramsForRegime(c.params === null || c.params === undefined ? c.params : JSON.parse(JSON.stringify(c.params)), c.regime);
      expect(pyEqual(res, c.out), `${JSON.stringify(c.params)} @ ${c.regime}`).toBe(true);
      if (c.keys) expect(Object.keys(res)).toEqual(c.keys);
    }
  });

  it('no overlay → the very same object (legacy passthrough)', () => {
    const flat = { min_rr: 2, _meta: 1 };
    expect(OP.paramsForRegime(flat, 'ranging')).toBe(flat);
    const empty = {};
    expect(OP.paramsForRegime(empty, 'ranging')).toBe(empty);
    expect(OP.paramsForRegime(null, 'x')).toBeNull();
  });
});

describe('scanner_mid ШАГ 9 — LEVELS cfg from optimizer_params', () => {
  it('960 cases: flags × stored row × regime × user cfg — min_rr / min_quality and the error path', () => {
    let errs = 0;
    for (const c of F.levels) {
      mem.exec('DELETE FROM optimizer_params');
      store._clearParamsCache();
      seed('LEVELS', c.stored);
      const cfg = { min_rr: c.cfg[0], min_quality: c.cfg[1] };
      const user = { user_id: 7, ...c.flags };
      const { error } = OP.applyLevelsOptimizerParams(cfg, user, { store, getRegime: regimeFn(c.regime), log: memLog() });
      const tag = `${JSON.stringify(c.flags)} ${c.stored} @${c.regime} cfg=${c.cfg}`;
      expect(pyEqual(cfg.min_rr, c.out.min_rr), `${tag} min_rr ${cfg.min_rr}`).toBe(true);
      expect(pyEqual(cfg.min_quality, c.out.min_quality), `${tag} min_quality ${cfg.min_quality}`).toBe(true);
      expect(error !== null, `${tag} error ${error && error.message}`).toBe(c.out.err !== null);
      if (error) errs++;
    }
    expect(errs).toBeGreaterThan(100);
  });
});

describe('smc/scanner hoist — SMC min_rr_filter / min_q_filter', () => {
  it('480 cases: float(min_rr or 0) / int(min_quality or 0), a failing int() keeps the rr filter', () => {
    for (const c of F.smc) {
      mem.exec('DELETE FROM optimizer_params');
      store._clearParamsCache();
      seed('SMC', c.stored);
      const out = OP.smcOptimizerFilters({ user_id: 7, ...c.flags }, { store, getRegime: regimeFn(c.regime), log: memLog() });
      const tag = `${JSON.stringify(c.flags)} ${c.stored} @${c.regime}`;
      expect(pyEqual(out.min_rr_filter, c.out.min_rr_filter), `${tag} rr ${out.min_rr_filter}`).toBe(true);
      expect(pyEqual(out.min_q_filter, c.out.min_q_filter), `${tag} q ${out.min_q_filter}`).toBe(true);
      expect(out.error !== null, `${tag} error`).toBe(c.out.err !== null);
    }
  });

  it('per-signal gate (rr < filter / score < filter → skip, filters ≤ 0 or NaN are off)', () => {
    for (const c of F.smc_pass) {
      expect(OP.smcPassesOptimizerFilters(c.uc, { rr: c.rr, score: c.score }), JSON.stringify(c)).toBe(c.out);
    }
  });
});

describe('optimizer_params store (optimizer._save_params / load_params / optimizer_cache)', () => {
  it('json.loads grammar: NaN / Infinity read like Python; a non-dict value comes back as-is', () => {
    expect(gs.pyJsonLoads('{"a": NaN, "b": [-Infinity, "NaN"]}')).toEqual({ a: NaN, b: [-Infinity, 'NaN'] });
    expect(() => gs.pyJsonLoads('{"a": nan}')).toThrow(SyntaxError);
    seed('SMC', '[1, 2]');
    expect(store.loadOptimizerParams(7, 'SMC')).toEqual([1, 2]);
    seed('LEVELS', '');
    expect(store.loadOptimizerParams(7, 'LEVELS')).toBeNull();
  });

  it('4 h cache TTL; save never raises (the bot logs a warning and counts the user as applied)', () => {
    let t = 1000;
    const now = () => t;
    store.saveOptimizerParams(7, 'LEVELS', { min_rr: 2.5 }, { now });
    mem.prepare("UPDATE optimizer_params SET params='{\"min_rr\": 3.0}'").run();
    expect(store.loadOptimizerParams(7, 'LEVELS', { now })).toEqual({ min_rr: 2.5 });
    t += 4 * 3600;
    expect(store.loadOptimizerParams(7, 'LEVELS', { now })).toEqual({ min_rr: 2.5 });
    t += 1;
    expect(store.loadOptimizerParams(7, 'LEVELS', { now })).toEqual({ min_rr: 3 });
    const broken = new Database(':memory:');
    store.setDb(broken);
    const log = memLog();
    expect(() => store.saveOptimizerParams(8, 'SMC', { min_rr: 1 }, { log })).not.toThrow();
    expect(log.lines.some(([lv, l]) => lv === 'warn' && l.includes('_save_params uid=8 strat=SMC'))).toBe(true);
    store.setDb(mem);
  });
});

describe('genome.get_dynamic_eval_days', () => {
  // python -c "import genome, market_regime as m; m._cached_regime='trending_down'; import time; m._cached_at=time.time(); print(genome.get_dynamic_eval_days('SMC'))"  → 45 (ranging / None → 30)
  it('45 in a trending regime, EVAL_DAYS otherwise or when the regime lookup throws', () => {
    expect(C.getDynamicEvalDays('SMC', () => 'trending_up')).toBe(45);
    expect(C.getDynamicEvalDays('SMC', () => 'trending_down')).toBe(45);
    expect(C.getDynamicEvalDays('LEVELS', () => 'ranging')).toBe(30);
    expect(C.getDynamicEvalDays('LEVELS', () => null)).toBe(30);
    expect(C.getDynamicEvalDays('LEVELS', () => { throw new Error('x'); })).toBe(30);
    expect(C.getDynamicEvalDays('VOLUME')).toBe(30);
  });
});
