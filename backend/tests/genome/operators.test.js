/**
 * Genetic operators. Exact parity with the bot: make_genome_vectors.py replaces
 * `genome.random` by a mulberry32 shim with the same random()/randint()/choice()/sample()
 * algorithms as services/genome/rng.js, so for the same seed the bot's
 *   genome.random_gene_value(d) / random_genome(S) / mutate(g, S, rate) / tournament_select(pop)
 *   bayesian_mutate(g, S, pop) / _apply_cross_hint(child, hint, S) / _gene_value_valid(d, v)
 *   apply_fitness_decay(f, created_at) / meta_adapt(S, tf, history)
 * must equal the JS results. crossover is pinned by determinism + properties (Python walks a
 * hash-ordered set, so its draw order is process-dependent).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFixture, pyEqual } = require('./helpers');
const ops = require('../../services/genome/operators');
const gs = require('../../services/genome/geneSpace');
const { createRng, mulberry32Uint } = require('../../services/genome/rng');
const { metaAdapt } = require('../../services/genome/evolve');

const OPS = loadFixture('operators');

describe('rng (mulberry32 + Python random API subset)', () => {
  it('is deterministic per seed and in range', () => {
    const a = createRng(42); const b = createRng(42);
    const xs = Array.from({ length: 1000 }, () => a.random());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b.random()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    // mulberry32 reference values, cross-checked with the generator's independent Python shim:
    //   m = Mulberry(1); [m.u32() for _ in range(3)] → [2693262067, 11749833, 2265367787]
    const u = mulberry32Uint(1);
    expect([u(), u(), u()]).toEqual([2693262067, 11749833, 2265367787]);
    const v = mulberry32Uint(0xdeadbeef);
    expect([v(), v()]).toEqual([4043151706, 1147597007]);
  });

  it('randint inclusive, choice, sample distinct, shuffle permutation', () => {
    const r = createRng(9);
    const seen = new Set();
    for (let k = 0; k < 2000; k++) seen.add(r.randint(2, 4));
    expect([...seen].sort()).toEqual([2, 3, 4]);
    const s = r.sample([1, 2, 3, 4, 5, 6], 3);
    expect(new Set(s).size).toBe(3);
    const arr = [1, 2, 3, 4, 5, 6, 7];
    r.shuffle(arr);
    expect([...arr].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(() => r.choice([])).toThrow();
    expect(() => r.randint(5, 4)).toThrow();
  });
});

describe('scripted-RNG parity with the bot', () => {
  it('random_gene_value — every gene, 4 seeds × 25 draws', () => {
    for (const c of OPS.random_gene_value) {
      const rng = createRng(c.seed);
      const def = gs.GENE_SPACE[c.strategy][c.gene];
      const vals = Array.from({ length: 25 }, () => gs.randomGeneValue(def, rng));
      expect(pyEqual(vals, c.values), `${c.strategy}.${c.gene} seed ${c.seed}`).toBe(true);
    }
  });

  it('random_genome — 20 seeds per strategy', () => {
    for (const c of OPS.random_genome) {
      const g = ops.randomGenome(c.strategy, createRng(c.seed));
      expect(pyEqual(g, c.genome), `${c.strategy} seed ${c.seed}`).toBe(true);
      expect(gs.serializeGenome(g)).toBe(gs.serializeGenome(c.genome));
    }
  });

  it('mutate — rates 0 / 0.3 / 0.9 (rate 0 → the forced single-gene redraw)', () => {
    for (const c of OPS.mutate) {
      const out = ops.mutate(c.in, c.strategy, c.rate, createRng(c.seed));
      expect(pyEqual(out, c.out), `${c.strategy} seed ${c.seed} rate ${c.rate}`).toBe(true);
    }
  });

  it('tournament_select — sample(min(3, n)) → first max fitness', () => {
    for (const c of OPS.tournament) {
      const w = ops.tournamentSelect(c.population, 3, createRng(c.seed));
      expect(w.id, `${c.strategy} seed ${c.seed}`).toBe(c.winner_id);
    }
    expect(ops.tournamentSelect([], 3, createRng(1))).toEqual({});
  });

  it('bayesian_mutate — importance-weighted rates (pop < 6 → plain mutate)', () => {
    for (const c of OPS.bayesian) {
      const out = ops.bayesianMutate(c.in, c.strategy, c.population, createRng(c.seed));
      expect(pyEqual(out, c.out), `${c.strategy} seed ${c.seed} pop ${c.population.length}`).toBe(true);
    }
  });

  it('_apply_cross_hint and _gene_value_valid', () => {
    for (const c of OPS.cross_hint) {
      const out = ops.applyCrossHint(c.in, c.hint, c.strategy, createRng(4));
      expect(pyEqual(out, c.out), `${c.strategy} hint ${JSON.stringify(c.hint)}`).toBe(true);
    }
    for (const c of OPS.gene_value_valid) {
      expect(ops.geneValueValid(gs.GENE_SPACE[c.strategy][c.gene], c.value), `${c.strategy}.${c.gene} ${JSON.stringify(c.value)}`).toBe(c.valid);
    }
  });

  it('apply_fitness_decay', () => {
    for (const c of OPS.decay) expect(ops.applyFitnessDecay(c.fitness, c.created_at, c.now), JSON.stringify(c)).toBe(c.out);
  });

  it('meta_adapt — trend → mutation_rate / elite_fraction, state accumulates per (S, tf)', () => {
    for (const c of OPS.meta) {
      const state = new Map();
      for (let k = 0; k < c.runs; k++) {
        const out = metaAdapt('LEVELS', '1h', c.history, state);
        expect(pyEqual({ ...out }, c.outs[k]), `history ${JSON.stringify(c.history)} run ${k}`).toBe(true);
      }
    }
  });
});

describe('determinism with a fixed seed', () => {
  it('the same seed reproduces the same offspring chain run-to-run', () => {
    const chain = (seed) => {
      const rng = createRng(seed);
      const pop = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, genome: ops.randomGenome('SMC', rng), fitness: rng.random() * 3 }));
      const kids = [];
      for (let k = 0; k < 20; k++) {
        const a = ops.tournamentSelect(pop, 3, rng);
        const b = ops.tournamentSelect(pop, 3, rng);
        let child = ops.crossover(a.genome, b.genome, 'SMC', rng);
        child = k % 2 ? ops.mutate(child, 'SMC', 0.3, rng) : ops.bayesianMutate(child, 'SMC', pop, rng);
        kids.push(gs.serializeGenome(child));
      }
      return kids;
    };
    expect(chain(2026)).toEqual(chain(2026));
    expect(chain(2026)).not.toEqual(chain(2027));
  });
});

describe('crossover (properties)', () => {
  it('every key from a or b, keys of both parents, _fix_constraints applied only with a strategy', () => {
    const rng = createRng(11);
    for (let k = 0; k < 200; k++) {
      const a = ops.randomGenome('LEVELS', rng);
      const b = { ...ops.randomGenome('LEVELS', rng), extra_b: 1 };
      const raw = ops.crossover(a, b, '', rng);
      expect(Object.keys(raw).sort()).toEqual([...new Set([...Object.keys(a), ...Object.keys(b)])].sort());
      for (const key of Object.keys(raw)) expect([a[key], b[key]]).toContain(raw[key]);
      const fixed = ops.crossover(a, b, 'LEVELS', rng);
      expect(fixed.tp1_rr).toBeGreaterThanOrEqual(fixed.min_rr);
    }
  });

  it('shared keys pick a / b with p ≈ 0.5', () => {
    const rng = createRng(5);
    let fromA = 0;
    for (let k = 0; k < 4000; k++) if (ops.crossover({ x: 'a' }, { x: 'b' }, '', rng).x === 'a') fromA++;
    expect(fromA / 4000).toBeGreaterThan(0.46);
    expect(fromA / 4000).toBeLessThan(0.54);
  });
});
