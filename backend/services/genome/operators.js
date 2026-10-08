'use strict';
/**
 * operators.js — the genetic operators of genome.py (genome-challenge-profiles.md §1.5):
 *
 *   randomGenome(strategy, rng)                 random_genome: every gene random → _fix_constraints
 *   crossover(a, b, strategy, rng)              uniform crossover (p = 0.5 per shared key) → fix
 *   mutate(genome, strategy, rate, rng)         per-gene redraw with p = rate, ≥ 1 forced redraw → fix
 *   tournamentSelect(population, size, rng)     random.sample(pop, min(3, n)) → max fitness (first max)
 *   bayesianMutate(genome, strategy, pop, rng)  importance-weighted mutation (top vs bottom third)
 *   geneValueValid(def, v) / applyCrossHint(child, hint, strategy, rng)
 *   getCrossStrategyHint(target, rng, store)    best genome of another strategy's last generation
 *   applyFitnessDecay(fitness, createdAt, now)  fitness × max(0.1, 1 − 0.02 × age_days), round 4
 *
 * Every random draw goes through the injected `rng` (rng.js), so a fixed seed reproduces the
 * same offspring run-to-run. Key iteration: Python's crossover walks `set(a) | set(b)` (hash
 * order, randomised per process); here the order is "keys of a, then keys only in b" — the
 * result is the same per-key distribution, deterministic under a seed.
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyFloat } = require('../../strategies/common/pyval');
const { pySum } = require('../../strategies/common/series');
const { GENE_SPACE, spaceOf, randomGeneValue } = require('./geneSpace');
const { fixConstraints } = require('./constraints');
const { defaultRng } = require('./rng');
const C = require('./config');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fitOf = (g) => (g && own(g, 'fitness') && g.fitness !== null && g.fitness !== undefined ? g.fitness : 0);

/** random_genome(strategy) */
function randomGenome(strategy, rng = defaultRng()) {
  const space = spaceOf(strategy);
  const g = {};
  for (const [name, def] of Object.entries(space)) g[name] = randomGeneValue(def, rng);
  return fixConstraints(g, strategy, rng);
}

/** crossover(parent_a, parent_b, strategy="") — fix only when `strategy` is non-empty. */
function crossover(parentA, parentB, strategy = '', rng = defaultRng()) {
  const a = parentA || {};
  const bb = parentB || {};
  const keys = Object.keys(a).concat(Object.keys(bb).filter((k) => !own(a, k)));
  const child = {};
  for (const key of keys) {
    if (own(a, key) && own(bb, key)) child[key] = rng.random() < 0.5 ? a[key] : bb[key];
    else if (own(a, key)) child[key] = a[key];
    else child[key] = bb[key];
  }
  return strategy ? fixConstraints(child, strategy, rng) : child;
}

/** Python `!=` on two genome scalars (True == 1, 1 == 1.0). */
function pyNe(x, y) {
  const n = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
  if ((typeof x === 'boolean' || typeof x === 'number') && (typeof y === 'boolean' || typeof y === 'number')) return n(x) !== n(y);
  if (x === undefined) x = null;
  if (y === undefined) y = null;
  return x !== y;
}

/** mutate(genome, strategy, rate=MUTATION_RATE) */
function mutate(genome, strategy, rate = C.MUTATION_RATE, rng = defaultRng()) {
  const space = spaceOf(strategy);
  const mutated = { ...(genome || {}) };
  let changed = false;
  for (const [name, def] of Object.entries(space)) {
    if (rng.random() < rate) {
      const nv = randomGeneValue(def, rng);
      if (pyNe(nv, own(mutated, name) ? mutated[name] : null)) {
        mutated[name] = nv;
        changed = true;
      }
    }
  }
  const names = Object.keys(space);
  if (!changed && names.length) {
    const name = rng.choice(names);
    mutated[name] = randomGeneValue(space[name], rng);
  }
  return fixConstraints(mutated, strategy, rng);
}

/** tournament_select(population, size=3): empty → {} ; max() keeps the FIRST maximal contender. */
function tournamentSelect(population, size = C.TOURNAMENT_SIZE, rng = defaultRng()) {
  if (!population || !population.length) return {};
  const contenders = rng.sample(population, Math.min(size, population.length));
  let best = contenders[0];
  for (let i = 1; i < contenders.length; i++) if (fitOf(contenders[i]) > fitOf(best)) best = contenders[i];
  return best;
}

/** sorted(pop, key=fitness, reverse=True) — stable (ties keep the original order). */
function sortByFitnessDesc(pop) {
  return pop.map((g, i) => [g, i]).sort((x, y) => (fitOf(y[0]) - fitOf(x[0])) || (x[1] - y[1])).map((x) => x[0]);
}

/**
 * bayesian_mutate(genome, strategy, population): with < 6 individuals (or no space) → plain
 * mutate. Importance per gene = |mean(top third) − mean(bottom third)| / (max − min) of the
 * gene definition (choice / bool genes → range 1); a non-numeric value (ma_type) or an
 * empty side → 1.0. mut_rate = min(0.8, MUTATION_RATE + importance/Σ × 2); nothing changed →
 * redraw the most important gene (first max).
 */
function bayesianMutate(genome, strategy, population, rng = defaultRng()) {
  const space = spaceOf(strategy);
  const pop = population || [];
  if (!Object.keys(space).length || pop.length < 6) return mutate(genome, strategy, C.MUTATION_RATE, rng);

  const sorted = sortByFitnessDesc(pop);
  const third = Math.floor(sorted.length / 3);
  const top = sorted.slice(0, third);
  const bot = third === 0 ? sorted.slice() : sorted.slice(sorted.length - third);

  const genomeOf = (g) => (g && own(g, 'genome') && g.genome ? g.genome : {});
  const importance = {};
  for (const name of Object.keys(space)) {
    const topVals = top.filter((g) => own(genomeOf(g), name)).map((g) => genomeOf(g)[name]);
    const botVals = bot.filter((g) => own(genomeOf(g), name)).map((g) => genomeOf(g)[name]);
    if (!topVals.length || !botVals.length) { importance[name] = 1.0; continue; }
    try {
      const topMean = pySum(topVals.map(pyFloat)) / topVals.length;
      const botMean = pySum(botVals.map(pyFloat)) / botVals.length;
      const diff = Math.abs(topMean - botMean);
      const def = space[name];
      const range = pyFloat(own(def, 'max') ? def.max : 1) - pyFloat(own(def, 'min') ? def.min : 0);
      importance[name] = range > 0 ? diff / range : 1.0;
    } catch (_e) {
      importance[name] = 1.0;       // TypeError / ValueError (e.g. float("sma"))
    }
  }

  const total = pySum(Object.values(importance)) || 1;
  const mutated = { ...(genome || {}) };
  let changed = false;
  for (const [name, def] of Object.entries(space)) {
    const imp = (own(importance, name) ? importance[name] : 1.0) / total;
    const mutRate = Math.min(0.8, C.MUTATION_RATE + imp * 2);
    if (rng.random() < mutRate) {
      const nv = randomGeneValue(def, rng);
      if (pyNe(nv, own(mutated, name) ? mutated[name] : null)) {
        mutated[name] = nv;
        changed = true;
      }
    }
  }
  if (!changed) {
    let most = null;
    for (const [k, v] of Object.entries(importance)) if (most === null || v > importance[most]) most = k;
    mutated[most] = randomGeneValue(space[most], rng);
  }
  return fixConstraints(mutated, strategy, rng);
}

/** _gene_value_valid(gene_def, value) */
function geneValueValid(def, value) {
  const t = def && def.type !== undefined ? def.type : 'float';
  try {
    if (t === 'bool') return typeof value === 'boolean';
    if (t === 'choice') {
      const vals = def.values || [];
      return vals.some((v) => !pyNe(v, value));          // `value in values` (== semantics: True == 1)
    }
    if (typeof value === 'boolean') return false;
    const v = pyFloat(value);
    if (def.min === undefined || def.max === undefined) return false;   // KeyError
    return pyFloat(def.min) - 1e-9 <= v && v <= pyFloat(def.max) + 1e-9;
  } catch (_e) {
    return false;
  }
}

/** _apply_cross_hint(child, hint, strategy): valid shared genes overwrite, then fix. */
function applyCrossHint(child, hint, strategy, rng = defaultRng()) {
  const space = spaceOf(strategy);
  const out = { ...(child || {}) };
  for (const [k, v] of Object.entries(hint || {})) {
    if (own(out, k) && own(space, k) && geneValueValid(space[k], v)) out[k] = v;
  }
  return fixConstraints(out, strategy, rng);
}

/**
 * get_cross_strategy_hint(target): a random OTHER strategy (GENE_SPACE order), its last
 * generation on its default TF, the max-fitness individual, the genes that exist in the
 * target space. Any failure / no data → {}.
 */
function getCrossStrategyHint(target, rng = defaultRng(), store = null) {
  const others = Object.keys(GENE_SPACE).filter((s) => s !== target);
  if (!others.length) return {};
  const source = rng.choice(others);
  try {
    const st = store || require('./store');
    const tf = C.getDefaultTf(source);
    const gen = st.getLastGeneration(source, tf);
    if (gen === 0) return {};
    const pop = st.getCurrentPopulation(source, tf, gen);
    if (!pop.length) return {};
    let best = pop[0];
    for (let i = 1; i < pop.length; i++) if (fitOf(pop[i]) > fitOf(best)) best = pop[i];
    const targetGenes = spaceOf(target);
    const shared = {};
    for (const [k, v] of Object.entries(best.genome || {})) if (own(targetGenes, k)) shared[k] = v;
    return shared;
  } catch (_e) {
    return {};
  }
}

/** apply_fitness_decay(fitness, created_at): round(fitness × max(0.1, 1 − 0.02 × age_days), 4) */
function applyFitnessDecay(fitness, createdAt, now = Date.now() / 1000) {
  const ageDays = (now - createdAt) / 86400;
  const decay = Math.max(0.1, 1.0 - C.FITNESS_DECAY_PER_DAY * ageDays);
  return pyRound(fitness * decay, 4);
}

module.exports = {
  randomGenome, crossover, mutate, tournamentSelect, bayesianMutate, sortByFitnessDesc,
  geneValueValid, applyCrossHint, getCrossStrategyHint, applyFitnessDecay, pyNe,
};
