/**
 * Gene space, random_gene_value ranges (incl. the truncation quirk), the config lookups and
 * _fix_constraints on 200 raw genomes per strategy — all against make_genome_vectors.py output
 * (bot genome.py). Python one-liners of the vectors:
 *   n_steps  = max(1, int((max - min) / step)); values = {round(min + k*step, 4) for k in 0..n_steps}
 *   fixed    = genome._fix_constraints(dict(raw), strategy); fixed_json = genome.serialize_genome(fixed)
 *   days     = genome._eval_days_for_tf(tf, s); top = genome._eval_top_n(s); …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFixture, pyEqual } = require('./helpers');
const gs = require('../../services/genome/geneSpace');
const C = require('../../services/genome/config');
const { fixConstraints } = require('../../services/genome/constraints');
const { createRng } = require('../../services/genome/rng');

const GS = loadFixture('gene_space');
const CONS = loadFixture('constraints');

describe('GENE_SPACE', () => {
  it('is the bot GENE_SPACE (17 / 12 / 22 genes, declaration order)', () => {
    expect(JSON.parse(JSON.stringify(gs.GENE_SPACE))).toEqual(GS.space);
    for (const s of Object.keys(GS.space)) expect(Object.keys(gs.GENE_SPACE[s])).toEqual(Object.keys(GS.space[s]));
    expect(Object.keys(gs.GENE_SPACE.LEVELS)).toHaveLength(17);
    expect(Object.keys(gs.GENE_SPACE.SMC)).toHaveLength(12);
    expect(Object.keys(gs.GENE_SPACE.VOLUME)).toHaveLength(22);
  });

  it('module constants equal genome.py', () => {
    for (const [k, v] of Object.entries(GS.constants)) {
      if (k === 'STRATEGY_TFS' || k === 'DEFAULT_TF') expect(JSON.parse(JSON.stringify(C[k]))).toEqual(v);
      else expect(C[k], k).toBe(v);
    }
  });
});

describe('random_gene_value', () => {
  it('float genes: n_steps truncation (vol_mult max 1.4 etc.) and every draw on the Python grid', () => {
    const rng = createRng(12345);
    for (const [key, info] of Object.entries(GS.floats)) {
      const [s, name] = key.split('.');
      const def = gs.GENE_SPACE[s][name];
      expect(gs.floatSteps(def), key).toBe(info.n_steps);
      const seen = new Set();
      for (let k = 0; k < 3000; k++) {
        const v = gs.randomGeneValue(def, rng);
        expect(info.values, `${key} drew ${v}`).toContain(v);
        seen.add(v);
      }
      expect(Math.max(...seen), key).toBe(info.reachable_max);
      expect(seen.size, key).toBe(info.values.length);
    }
    // the quirk: nominal max unreachable for LEVELS vol_mult / zone_pct / max_dist_pct, VOLUME bounce_vol_mult
    expect(GS.floats['LEVELS.vol_mult'].reachable_max).toBe(1.4);
    expect(GS.floats['LEVELS.zone_pct'].reachable_max).toBe(1.1);
    expect(GS.floats['LEVELS.max_dist_pct'].reachable_max).toBe(1.9);
    expect(GS.floats['VOLUME.bounce_vol_mult'].reachable_max).toBe(1.4);
  });

  it('int / choice / bool genes stay inside their definitions', () => {
    const rng = createRng(7);
    for (const space of Object.values(gs.GENE_SPACE)) {
      for (const def of Object.values(space)) {
        for (let k = 0; k < 400; k++) {
          const v = gs.randomGeneValue(def, rng);
          if (def.type === 'int') { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(def.min); expect(v).toBeLessThanOrEqual(def.max); }
          if (def.type === 'choice') expect(def.values).toContain(v);
          if (def.type === 'bool') expect(typeof v).toBe('boolean');
        }
      }
    }
    expect(gs.randomGeneValue({ type: 'weird' }, rng)).toBeNull();
  });
});

describe('config lookups', () => {
  it('_eval_top_n / _eval_min_trades / _oos_split / _eval_days_for_tf', () => {
    for (const row of GS.lookups) {
      expect(C.evalTopN(row.strategy), row.strategy).toBe(row.eval_top_n);
      expect(C.evalMinTrades(row.strategy), row.strategy).toBe(row.eval_min_trades);
      expect(C.oosSplit(row.strategy), row.strategy).toBe(row.oos_split);
      for (const [tf, d] of Object.entries(row.days)) expect(C.evalDaysForTf(tf, row.strategy), `${row.strategy} ${tf}`).toBe(d);
    }
  });

  it('_eval_timeout_for_tf, regime tables, get_tfs / get_default_tf', () => {
    for (const [tf, v] of Object.entries(GS.timeouts)) expect(C.evalTimeoutForTf(tf), tf).toBe(v);
    for (const [r, v] of Object.entries(GS.regime)) {
      const reg = r === 'None' ? null : r;
      expect(C.driftThresholdForRegime(reg), r).toBe(v.drift);
      expect(C.pfThresholdForRegime(reg), r).toBe(v.pf);
      expect(C.ageWindowDaysForRegime(reg), r).toBe(v.age);
    }
    for (const [s, [tfs, dflt]] of Object.entries(GS.tfs)) {
      expect(C.getTfs(s)).toEqual(tfs);
      expect(C.getDefaultTf(s)).toBe(dflt);
    }
  });

  it('GENOME_CPU_SHARE: env, defaults by CPU count, clamp', () => {
    expect(C.defaultCpuShare(1)).toBe(0.15);
    expect(C.defaultCpuShare(2)).toBe(0.35);
    expect(C.genomeCpuShare({}, 1)).toBe(0.15);
    expect(C.genomeCpuShare({}, 4)).toBe(0.35);
    expect(C.genomeCpuShare({ GENOME_CPU_SHARE: '0.5' }, 1)).toBe(0.5);
    expect(C.genomeCpuShare({ GENOME_CPU_SHARE: '0.01' }, 1)).toBe(0.05);
    expect(C.genomeCpuShare({ GENOME_CPU_SHARE: '3' }, 1)).toBe(1.0);
    expect(C.genomeCpuShare({ GENOME_CPU_SHARE: '' }, 1)).toBe(0.15);
    // pause = min(20, elapsed × (1/share − 1)): 1 s of backtest at 15 % → 5.67 s idle
    expect(C.cpuPauseS(1.0, 0.15)).toBeCloseTo(1 / 0.15 - 1, 12);
    expect(C.cpuPauseS(100, 0.15)).toBe(20);
    expect(C.genomeAutoApplyEnabled({})).toBe(true);
    expect(C.genomeAutoApplyEnabled({ GENOME_AUTO_APPLY_ENABLED: '1' })).toBe(true);
    expect(C.genomeAutoApplyEnabled({ GENOME_AUTO_APPLY_ENABLED: 'true' })).toBe(false);
    expect(C.genomeAutoApplyEnabled({ GENOME_AUTO_APPLY_ENABLED: '0' })).toBe(false);
  });
});

describe('_fix_constraints — 200 raw genomes per strategy vs the bot', () => {
  for (const strategy of ['LEVELS', 'SMC', 'VOLUME']) {
    it(`${strategy}: same fixed genome and the same serialize_genome JSON`, () => {
      const cases = CONS[strategy];
      expect(cases.length).toBe(200);
      let changedCount = 0;
      for (const [i, c] of cases.entries()) {
        const out = fixConstraints(c.in, strategy, createRng(1));
        expect(pyEqual(out, c.out), `${strategy} #${i}: ${JSON.stringify(c.in)} → js ${JSON.stringify(out)} py ${JSON.stringify(c.out)}`).toBe(true);
        expect(gs.serializeGenome(out), `${strategy} #${i}`).toBe(c.out_json);
        expect(gs.serializeGenome(c.in), `${strategy} #${i} in`).toBe(c.in_json);
        if (!pyEqual(c.in, c.out)) changedCount++;
      }
      expect(changedCount).toBeGreaterThan(20);     // the table really exercises the repair rules
    });
  }

  it('does not mutate its input; unknown strategy → a plain copy', () => {
    const g = { tp1_rr: 1.0, min_rr: 2.0 };
    const out = fixConstraints(g, 'LEVELS');
    expect(g).toEqual({ tp1_rr: 1.0, min_rr: 2.0 });
    expect(out.tp1_rr).toBe(2.0);
    expect(fixConstraints(g, 'OTHER')).toEqual(g);
  });

  it('VOLUME fills missing genes from the injected rng (deterministic per seed)', () => {
    const a = fixConstraints({ ma_type: 'sma' }, 'VOLUME', createRng(3));
    const b = fixConstraints({ ma_type: 'sma' }, 'VOLUME', createRng(3));
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(expect.arrayContaining([...Object.keys(gs.GENE_SPACE.VOLUME), 'tp3_rr']));
  });
});

describe('serialize / deserialize', () => {
  it('json.dumps(sort_keys=True) float formatting, ensure_ascii; invalid → {}', () => {
    expect(gs.serializeGenome({ min_rr: 2, min_quality: 3, use_rsi: true, ma_type: 'ema', smc_retrace_depth: 0 }))
      .toBe('{"ma_type": "ema", "min_quality": 3, "min_rr": 2.0, "smc_retrace_depth": 0.0, "use_rsi": true}');
    expect(gs.compactGenomeJson({ b: 1, a: 0.5 })).toBe('{"a":0.5,"b":1}');
    expect(gs.deserializeGenome('')).toEqual({});
    expect(gs.deserializeGenome('{bad')).toEqual({});
    expect(gs.deserializeGenome('{"x": 1.0}')).toEqual({ x: 1 });
    expect(gs.pyJsonStr('тест')).toBe('"\\u0442\\u0435\\u0441\\u0442"');
  });
});
