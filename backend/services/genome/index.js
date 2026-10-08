'use strict';
/**
 * services/genome — the Strategy Genome, one-to-one with the bot's genome.py, genome_ui.py,
 * genome_maintenance.py, handlers/genome.py and the genome path of backtest.py
 * (spec genome-challenge-profiles.md Part 1, PLAN M16).
 *
 *   config        constants + per-strategy / TF / regime lookups, CPU share
 *   rng           seeded generator (mulberry32) with the Python random API subset
 *   geneSpace     GENE_SPACE, random_gene_value (truncation quirk), (de)serialisation
 *   constraints   _fix_constraints
 *   operators     random_genome, crossover, mutate, tournament, bayesian_mutate, cross hint, decay
 *   backtester    Backtester.run_in_thread over the JS engines (_simulate_trade, _build_result)
 *   fitness       compute_fitness, Wilson CI, Monte Carlo, the evaluate_genome multipliers
 *   evaluate      evaluate_genome (cache, CPU pacing, coin-champion kv)
 *   coinBasket    _get_context_aware_coins (ATR scoring, tier mix, CoinGecko tier 2)
 *   evolve        evolve_generation, meta_adapt, trigger_evolution_now, the 6 h loop
 *   drift / paperValidation / apply   live validation gates and the genome → settings paths
 *   texts         dashboard / help / reply texts (verbatim)
 *   maintenance   coin-champion GC + live-baseline refresh loop
 *   store         genome_population / genome_history / optimizer_params / engine_kv I/O
 *   runner        the main-thread host of workers/genomeWorker.js
 *   regime        the cached market-regime provider hook
 *   optimizerParams  params_for_regime + the LEVELS / SMC scanner consumers of optimizer_params
 */

module.exports = {
  config: require('./config'),
  rng: require('./rng'),
  geneSpace: require('./geneSpace'),
  constraints: require('./constraints'),
  operators: require('./operators'),
  backtester: require('./backtester'),
  fitness: require('./fitness'),
  evaluate: require('./evaluate'),
  coinBasket: require('./coinBasket'),
  evolve: require('./evolve'),
  drift: require('./drift'),
  paperValidation: require('./paperValidation'),
  apply: require('./apply'),
  texts: require('./texts'),
  maintenance: require('./maintenance'),
  store: require('./store'),
  runner: require('./runner'),
  regime: require('./regime'),
  optimizerParams: require('./optimizerParams'),
};
