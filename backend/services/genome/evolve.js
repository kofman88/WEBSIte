'use strict';
/**
 * evolve.js — one evolution step and the background loop (genome-challenge-profiles.md
 * §1.8, §1.11):
 *
 *   evolveGeneration(strategy, tf, deps)   evolve_generation: stale reset / pause, meta-genome,
 *       stagnation diversity injection, fitness decay, elitism, tournament + crossover, cross-
 *       strategy hint, bayesian / plain mutation; coin basket, candle preload, live baseline,
 *       sequential evaluation with the per-genome and 1800 s generation deadlines, batch save,
 *       history row, stale-fitness streak, drift, paper validation, auto-apply.
 *   metaAdapt(strategy, tf, history, metaState)   meta_adapt (in-memory, lost on restart)
 *   triggerEvolutionNow(strategy, tf, deps) the manual run under the evolution lock (700 s)
 *   runEvolutionCycle(deps)                 one full cycle LEVELS → SMC → VOLUME × 15m/1h/4h
 *   genomeEvolutionLoop(deps)               the 6 h loop with the kv resume mark (not started here)
 *   STATE                                   process-wide in-memory state (stale counters, streaks,
 *                                           meta state, the evolution lock)
 *
 * deps (all optional): { rng, store, log, now() s, mono() ms, sleep(ms), cpuShare, loader,
 *   getCoins(tf, S, limit), evaluate(S, genome, tf, opts), getRegime, env, onProgress(evt),
 *   generationTimeoutS = 1800, deadlines (extra, e.g. the manual 700 s), drift / paper / autoApply overrides }
 */

const { performance } = require('perf_hooks');
const { pyMax2, pyMin2 } = require('../../strategies/common/pyval');
const { pySum } = require('../../strategies/common/series');
const { fmtFixed } = require('../../strategies/common/pyfmt');
const C = require('./config');
const { defaultRng } = require('./rng');
const ops = require('./operators');
const evaluate = require('./evaluate');
const coinBasket = require('./coinBasket');
const { checkDrift } = require('./drift');
const { validateViaPaper } = require('./paperValidation');
const { autoApplyBestGenome } = require('./apply');
const { pyMax, pyMin } = require('../../strategies/common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored

const STATE = {
  staleResetCounts: new Map(),     // "S|tf" → consecutive stale resets
  staleFitnessStreak: new Map(),   // "S_tf" → generations with best_fit < 0.1
  metaState: new Map(),            // "S_tf" → {mutation_rate, elite_fraction}
  lock: { held: false },           // _evolution_lock
};

function _resetState() {
  STATE.staleResetCounts.clear();
  STATE.staleFitnessStreak.clear();
  STATE.metaState.clear();
  STATE.lock.held = false;
}

const defaultLog = () => require('../../utils/logger');
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (x) => fmtFixed(x, 2);
const f1 = (x) => fmtFixed(x, 1);
const f3 = (x) => fmtFixed(x, 3);
const fitOf = (g) => (g && g.fitness !== undefined && g.fitness !== null ? g.fitness : 0);
const num0 = (x) => (x === undefined || x === null || x === false || x === '' ? 0 : Number(x) || 0);

function resolve(deps = {}) {
  const store = deps.store || require('./store');
  return {
    ...deps,
    rng: deps.rng || defaultRng(),
    store,
    log: deps.log || defaultLog(),
    now: deps.now || (() => Date.now() / 1000),
    mono: deps.mono || (() => performance.now()),
    sleep: deps.sleep || realSleep,
    cpuShare: deps.cpuShare || C.genomeCpuShare(),
    env: deps.env || process.env,
    getCoins: deps.getCoins || ((tf, S, limit) => coinBasket.getContextAwareCoins(tf, S, limit, deps)),
    evaluate: deps.evaluate || evaluate.evaluateGenome,
    drift: deps.drift || checkDrift,
    paper: deps.paper || validateViaPaper,
    autoApply: deps.autoApply || autoApplyBestGenome,
    onProgress: deps.onProgress || null,
    generationTimeoutS: deps.generationTimeoutS || C.GENERATION_TIMEOUT_S,
    deadlines: deps.deadlines || [],
    state: deps.state || STATE,
  };
}

/** meta_adapt(strategy, tf, history): {} below 5 history rows; else the adapted hyper-params. */
function metaAdapt(strategy, tf, history, metaState = STATE.metaState) {
  const key = `${strategy}_${tf}`;
  if (history.length < C.META_INTERVAL_GENS) return {};
  const recent = history.slice(-C.META_INTERVAL_GENS);
  const fits = recent.map((h) => (h.best_fitness === undefined || h.best_fitness === null ? 0 : h.best_fitness));
  let trend = 0;
  if (fits.length >= 3) {
    const half = Math.floor(fits.length / 2);
    const first = pySum(fits.slice(0, half)) / Math.max(1, half);
    const second = pySum(fits.slice(half)) / Math.max(1, fits.length - half);
    trend = second - first;
  }
  const current = metaState.get(key) || { mutation_rate: C.MUTATION_RATE, elite_fraction: C.ELITE_FRACTION };
  if (trend > 0.5) {
    current.mutation_rate = pyMax2(0.1, current.mutation_rate - 0.02);
  } else if (trend < -0.5) {
    current.mutation_rate = pyMin2(0.5, current.mutation_rate + 0.05);
    current.elite_fraction = pyMin2(0.4, (current.elite_fraction === undefined ? C.ELITE_FRACTION : current.elite_fraction) + 0.05);
  } else {
    current.mutation_rate = pyMin2(0.4, current.mutation_rate + 0.03);
  }
  metaState.set(key, current);
  return current;
}

function zeroResult(generation, elapsed) {
  return { generation, best_fitness: 0, best_wr: 0, best_pf: 0, elapsed };
}

/** Build the next population: [[genome, birth_type, parent_a, parent_b], …] + generation. */
function buildPopulation(strategy, tf, lastGen, forceReset, d) {
  const { rng, store, log } = d;
  if (lastGen === 0 || forceReset) {
    const generation = forceReset ? lastGen + 1 : 1;
    log.info(`🧬 [${strategy}/${tf}] ${forceReset ? 'RESET' : 'INIT'} generation ${generation}: random pop of ${C.POP_SIZE}`);
    return { generation, items: Array.from({ length: C.POP_SIZE }, () => [ops.randomGenome(strategy, rng), 'random', 0, 0]) };
  }
  const prevPop = store.getCurrentPopulation(strategy, tf, lastGen);
  if (!prevPop.length) {
    return { generation: 1, items: Array.from({ length: C.POP_SIZE }, () => [ops.randomGenome(strategy, rng), 'random', 0, 0]) };
  }
  const generation = lastGen + 1;
  const nowS = d.now();

  // Lv5 META
  const histMeta = store.getHistory(strategy, tf, C.META_INTERVAL_GENS + 2);
  const meta = C.META_ENABLED ? metaAdapt(strategy, tf, histMeta, d.state.metaState) : {};
  let mutRate = meta.mutation_rate === undefined ? C.MUTATION_RATE : meta.mutation_rate;
  const eliteFrac = meta.elite_fraction === undefined ? C.ELITE_FRACTION : meta.elite_fraction;

  // [GENOME-DIVERSITY-INJECT] stagnation over the last 3 generations
  const stagHist = store.getHistory(strategy, tf, 3);
  let stagnation = false;
  if (stagHist.length >= 3) {
    const fits = stagHist.map((h) => num0(h.best_fitness));
    const mx = Math.max(...fits);
    const mn = Math.min(...fits);
    if (mx - mn < 0.1 && mx > 0) {
      stagnation = true;
      const orig = mutRate;
      mutRate = pyMin(0.6, mutRate * 2.5);
      log.warn(`🧬 [${strategy}/${tf}] STAGNATION DETECTED — last 3 gens fitness variance < 0.1 (best=${f3(fits[fits.length - 1])}). Injecting diversity: mut_rate ${f2(orig)} → ${f2(mutRate)} for offspring.`);
    }
  }

  // Lv2 fitness decay
  for (const p of prevPop) {
    const ca = p.created_at === undefined ? nowS : p.created_at;
    p.fitness = ops.applyFitnessDecay(fitOf(p), ca, nowS);
  }

  const nElite = Math.max(1, Math.trunc(C.POP_SIZE * eliteFrac));
  const elites = prevPop.map((g, i) => [g, i]).sort((a, b) => (fitOf(b[0]) - fitOf(a[0])) || (a[1] - b[1])).slice(0, nElite).map((x) => x[0]);
  const items = elites.map((e) => [e.genome, 'elite', e.id, 0]);

  // Lv3 cross-strategy hint
  let crossHint = {};
  if (rng.random() < C.CROSS_STRATEGY_RATE) {
    try { crossHint = ops.getCrossStrategyHint(strategy, rng, store); } catch (_e) { crossHint = {}; }
  }

  let randomOffspring = 0;
  if (stagnation) {
    randomOffspring = Math.max(1, Math.trunc((C.POP_SIZE - nElite) * 0.30));
    log.info(`🧬 [${strategy}/${tf}] DIVERSITY-INJECTION: ${randomOffspring} random offspring + mut_rate=${f2(mutRate)} for remaining ${(C.POP_SIZE - nElite) - randomOffspring} slots`);
  }

  for (let idx = 0; idx < C.POP_SIZE - nElite; idx++) {
    if (stagnation && idx < randomOffspring) {
      items.push([ops.randomGenome(strategy, rng), 'random_inject', 0, 0]);
      continue;
    }
    const a = ops.tournamentSelect(prevPop, C.TOURNAMENT_SIZE, rng);
    const b = ops.tournamentSelect(prevPop, C.TOURNAMENT_SIZE, rng);
    let child = ops.crossover(a.genome || {}, b.genome || {}, strategy, rng);
    let birth = 'crossover';
    if (Object.keys(crossHint).length && idx === 0) {
      child = ops.applyCrossHint(child, crossHint, strategy, rng);
      birth = 'cross_strategy';
    } else if (rng.random() < mutRate) {
      if (idx % 3 === 0 && prevPop.length >= 6) {
        child = ops.bayesianMutate(child, strategy, prevPop, rng);
        birth = 'bayesian_mut';
      } else {
        child = ops.mutate(child, strategy, mutRate, rng);
        birth = 'mutation';
      }
    }
    items.push([child, birth, a.id === undefined ? 0 : a.id, b.id === undefined ? 0 : b.id]);
  }
  const metaInfo = Object.keys(meta).length ? ` meta:mut=${f2(mutRate)}/elite=${f2(eliteFrac)}` : '';
  log.info(`🧬 [${strategy}/${tf}] gen ${generation}: ${nElite} elite + ${items.length - nElite} offspring from gen ${lastGen}${metaInfo}`);
  return { generation, items };
}

/** Preload the basket's candles (5 in parallel, 30 s each, ≥ 150 bars), coin order kept. */
async function preloadCandles(coins, tf, days, d) {
  const loader = d.loader || (() => { const { HistoryLoader } = require('../marketData/candleStore'); return new HistoryLoader(); })();
  const loaded = await coinBasket.mapBounded(coins, 5, async (coin) => {
    try {
      const df = await coinBasket.withTimeout(Promise.resolve(loader.loadCached(coin, tf, days)), d.preloadTimeoutMs || 30_000);
      if (df && df.length >= 150) return [coin, df];
    } catch (e) {
      d.log.debug(`genome preload ${coin}: ${e && e.message}`);
    }
    return null;
  });
  const out = new Map();
  for (const r of loaded) if (r) out.set(r[0], r[1]);
  return out;
}

/**
 * evolve_generation(strategy, tf) → {strategy, tf, generation, pop_size, best_fitness, best_wr,
 * best_pf, elapsed} (or the short zero dict on the early exits).
 */
async function evolveGeneration(strategy, tf = null, deps = {}) {
  const d = resolve(deps);
  const { store, log } = d;
  evaluate.cleanupEvalCache(deps.cache || evaluate.EVAL_CACHE, d.now());
  const T = tf || C.getDefaultTf(strategy);
  const t0 = d.now();
  const lastGen = store.getLastGeneration(strategy, T);

  // ── stale reset / pause ──
  let forceReset = false;
  const staleKey = `${strategy}|${T}`;
  if (lastGen >= C.STALE_RESET_AFTER_GENS) {
    const recent = store.getHistory(strategy, T, C.STALE_RESET_AFTER_GENS);
    if (recent.length && recent.every((h) => h.best_fitness === 0)) {
      const n = (d.state.staleResetCounts.get(staleKey) || 0) + 1;
      d.state.staleResetCounts.set(staleKey, n);
      if (n > C.MAX_STALE_RESETS) {
        log.info(`🧬 [${strategy}/${T}] PAUSED — ${n} consecutive stale resets, skipping until next bot restart`);
        return zeroResult(lastGen, 0);
      }
      log.warn(`🧬 [${strategy}/${T}] STALE DETECTED — last ${C.STALE_RESET_AFTER_GENS} gens all fitness=0, force reset с новой случайной популяции (reset ${n}/${C.MAX_STALE_RESETS})`);
      forceReset = true;
    } else {
      d.state.staleResetCounts.delete(staleKey);
    }
  }

  const { generation, items } = buildPopulation(strategy, T, lastGen, forceReset, d);

  // ── coin basket + candle preload ──
  const sharedCoins = await d.getCoins(T, strategy, C.evalTopN(strategy));
  if (!sharedCoins || !sharedCoins.length) {
    log.warn(`🧬 [${strategy}/${T}] no coins from context-aware — skipping evaluation`);
    return zeroResult(generation, d.now() - t0);
  }
  const evalDaysRun = C.evalDaysForTf(T, strategy);
  const preloaded = deps.preloaded || await preloadCandles(sharedCoins, T, evalDaysRun, d);
  const summary = Array.from(preloaded.entries()).map(([c, df]) => `${c.split('-USDT-SWAP').join('')}(${df.length}b)`).join(', ');
  log.info(`🧬 [${strategy}/${T}] coins: ${summary || 'NONE'}`);
  if (!preloaded.size) {
    log.warn(`🧬 [${strategy}/${T}] no candle data loaded — skipping. Проверьте OKX доступность (history endpoint). Попробовано ${sharedCoins.length} монет, все failed/timeout.`);
    return zeroResult(generation, d.now() - t0);
  }
  if (preloaded.size < Math.floor(sharedCoins.length / 2)) {
    log.warn(`🧬 [${strategy}/${T}] only ${preloaded.size}/${sharedCoins.length} coins loaded — OKX history flaky, статистика может быть ненадёжной`);
  }

  // ── live calibration baseline (written by validate_via_paper) ──
  let liveWrBaseline = null;
  try {
    const raw = store.kvGet(`genome_live_baseline_${strategy}_${T}`);
    if (raw) {
      const data = JSON.parse(raw);
      if (d.now() - num0(data.ts) < 7 * 86400) {
        liveWrBaseline = num0(data.live_wr);
        log.info(`🧬 [${strategy}/${T}] live calibration baseline: WR=${f1(liveWrBaseline)}% (N=${Math.trunc(num0(data.n))}, regime=${data.regime === undefined ? '?' : data.regime}) — applying to evaluations`);
      }
    }
  } catch (e) {
    log.debug(`read live baseline ${strategy}/${T}: ${e.message}`);
  }

  log.info(`🧬 [${strategy}/${T}] evaluating ${items.length} genomes on ${sharedCoins.length} coins (prefetched ${preloaded.size})`);

  // ── sequential evaluation (per-genome timeout = TF timeout / CPU share; generation 1800 s) ──
  const genomeTimeoutS = C.evalTimeoutForTf(T) / d.cpuShare;
  const genDeadline = { at: d.mono() + d.generationTimeoutS * 1000, kind: 'generation' };
  const progress = { done: 0, best_fit: 0.0, best_wr: 0.0, zero_trades: 0 };
  const evalResults = [];
  try {
    for (const [genome, birth, pa, pb] of items) {
      let metrics;
      try {
        // asyncio cancels at any await: the manual 700 s / generation 1800 s deadlines are
        // checked before every genome as well as between the coins inside evaluate
        for (const dl of [...d.deadlines, genDeadline]) if (d.mono() >= dl.at) throw new evaluate.DeadlineError(dl.kind);
        const deadlines = [{ at: d.mono() + genomeTimeoutS * 1000, kind: 'genome' }, ...d.deadlines, genDeadline];
        metrics = await d.evaluate(strategy, genome, T, {
          coins: sharedCoins, preloaded, liveWrBaseline,
          deps: { ...deps, now: d.now, mono: d.mono, sleep: d.sleep, cpuShare: d.cpuShare, log, store, deadlines },
        });
      } catch (e) {
        if (e instanceof evaluate.DeadlineError && e.kind === 'genome') {
          log.warn(`🧬 [${strategy}/${T}] genome eval TIMEOUT (${fmtFixed(genomeTimeoutS, 0)}s) — skipping`);
        } else if (e instanceof evaluate.DeadlineError) {
          throw e;
        } else {
          log.debug(`eval error: ${e && e.message}`);
        }
        metrics = { winrate: 0, profit_factor: 0, trades: 0, drawdown: 0, fitness: 0 };
      }
      progress.done += 1;
      const fv = num0(metrics.fitness);
      const wv = num0(metrics.winrate);
      if (fv > progress.best_fit) { progress.best_fit = fv; progress.best_wr = wv; }
      if (Math.trunc(num0(metrics.trades)) === 0) progress.zero_trades += 1;
      if (progress.done % 3 === 0 || progress.done === items.length) {
        log.info(`🧬 [${strategy}/${T}] progress ${progress.done}/${items.length} · best_fit=${f2(progress.best_fit)} wr=${fmtFixed(progress.best_wr, 0)}% · zero_trades=${progress.zero_trades}/${progress.done}`);
      }
      if (d.onProgress) {
        try { d.onProgress({ strategy, tf: T, generation, ...progress, total: items.length }); } catch (_e) { /* */ }
      }
      evalResults.push({ genome, metrics, birth_type: birth, parent_a: pa, parent_b: pb });
      await d.sleep(500);
    }
  } catch (e) {
    if (e instanceof evaluate.DeadlineError && e.kind === 'generation') {
      log.warn(`🧬 [${strategy}/${T}] FULL generation eval TIMEOUT (${fmtFixed(d.generationTimeoutS, 0)}s) — aborting`);
      return zeroResult(generation, d.now() - t0);
    }
    throw e;
  }

  // ── batch save + history ──
  let ids = [];
  try {
    ids = store.savePopulationBatch(strategy, T, generation, evalResults, { now: d.now, log });
  } catch (e) {
    log.warn(`save_population_batch: ${e.message}`);
    ids = [];
  }
  const evaluated = evalResults.map((res, i) => ({
    id: i < ids.length ? ids[i] : 0,
    genome: res.genome,
    ...res.metrics,
    birth_type: res.birth_type,
    parent_a: res.parent_a,
    parent_b: res.parent_b,
  }));
  store.saveGenerationHistory(strategy, T, generation, evaluated, { now: d.now, log });

  const elapsed = d.now() - t0;
  let best = {};
  if (evaluated.length) {
    best = evaluated[0];
    for (let i = 1; i < evaluated.length; i++) if (fitOf(evaluated[i]) > fitOf(best)) best = evaluated[i];
  }
  const zeroTrades = evaluated.filter((g) => num0(g.trades) === 0).length;
  const withTrades = evaluated.length - zeroTrades;
  log.info(`🧬 [${strategy}/${T}] gen ${generation} done in ${f1(elapsed)}s: best fitness=${f3(num0(best.fitness))} WR=${f1(num0(best.winrate))}% PF=${f2(num0(best.profit_factor))} N=${Math.trunc(num0(best.trades))} | ${withTrades}/${evaluated.length} genomes produced trades (zero=${zeroTrades})`);
  if (zeroTrades === evaluated.length && evaluated.length) {
    log.warn(`🧬 [${strategy}/${T}] ALL ${evaluated.length} genomes got 0 trades! Возможные причины: (1) OKX history timeout → нет данных, (2) gene space даёт слишком жёсткие фильтры, (3) backtest strategy module сломан. Проверьте логи выше.`);
  }

  // [GENOME-PACK-A] stale fitness streak
  const streakKey = `${strategy}_${T}`;
  const bestFit = num0(best.fitness);
  if (bestFit < C.STALE_FITNESS_THRESHOLD) {
    const s = (d.state.staleFitnessStreak.get(streakKey) || 0) + 1;
    d.state.staleFitnessStreak.set(streakKey, s);
    if (s >= C.STALE_FITNESS_STREAK_ALERT) {
      log.warn(`[GENOME-STALE-FITNESS] ${strategy}/${T}: ${s} поколений подряд best_fit=${f3(bestFit)} < ${f2(C.STALE_FITNESS_THRESHOLD)}. Возможно эволюция застряла (local minimum / gene space мёртв). Reset через STALE_RESET_AFTER_GENS должен помочь.`);
    }
  } else {
    d.state.staleFitnessStreak.set(streakKey, 0);
  }

  // Lv4 drift
  let driftInfo = {};
  try {
    driftInfo = d.drift(strategy, T, { store, now: d.now(), getRegime: d.getRegime || null });
    const delta = num0(driftInfo.delta);
    const reg = String(driftInfo.regime === undefined ? 'unknown' : driftInfo.regime);
    const threshold = num0(driftInfo.threshold) || C.DRIFT_THRESHOLD_WR;
    if (driftInfo.drift) {
      const bd = driftInfo.breakdown || {};
      log.warn(`🧬 [${strategy}/${T}] DRIFT DETECTED: backtest WR=${f1(num0(driftInfo.backtest_wr))}% → predicted ${f1(num0(driftInfo.predicted_live_wr))}% vs live WR=${f1(num0(driftInfo.live_wr))}% (delta=${f1(delta)}% > ${f1(threshold)}% regime=${reg}) [N=${Math.trunc(num0(driftInfo.live_trades))}: TP=${Math.trunc(num0(bd.tp))} BE/2=${bd.be_half === undefined ? 0 : bd.be_half} MANUAL_win=${Math.trunc(num0(bd.manual_win))} MANUAL/2=${bd.manual_half === undefined ? 0 : bd.manual_half} SL=${Math.trunc(num0(bd.sl))}]`);
    } else if (delta > 8.0) {
      log.info(`🧬 [${strategy}/${T}] drift approaching: delta=${f1(delta)}% (threshold ${f1(threshold)}% regime=${reg}) — live ${f1(num0(driftInfo.live_wr))} vs predicted ${f1(num0(driftInfo.predicted_live_wr))}`);
    }
  } catch (e) {
    log.warn(`genome._eval_one() unhandled exception: ${e && e.message}`);
  }

  // Lv4 paper validation (tri-state gate)
  let paperAllow = true;
  try {
    if (best.genome && Object.keys(best.genome).length) {
      const pv = d.paper(best.genome, strategy, T, { store, now: d.now(), getRegime: d.getRegime || null, log });
      const status = pv.status === undefined ? 'OK' : pv.status;
      if (status === 'INSUFFICIENT_DATA') {
        paperAllow = false;
        log.warn(`🧬 [${strategy}/${T}] PAPER VALIDATION: insufficient sample (N=${pv.n || 0} < ${C.MIN_PAPER_VALIDATION_N}) — skip auto-apply, wait for more live trades`);
      } else if (status === 'FAILED') {
        paperAllow = false;
        const pwr = num0(pv.paper_wr);
        const ppf = num0(pv.paper_pf);
        const wrThr = num0(pv.wr_threshold) || 45.0;
        const pfThr = num0(pv.pf_threshold) || 1.0;
        const wrM = pwr - wrThr;
        const pfM = ppf - pfThr;
        const sg = (x, k) => `${x >= 0 ? '+' : ''}${fmtFixed(x, k)}`;
        log.warn(`🧬 [${strategy}/${T}] PAPER VALIDATION FAILED: WR=${f1(pwr)}% ${wrM < 0 ? '✗' : '✓'} (need ≥${fmtFixed(wrThr, 0)}, ${sg(wrM, 1)}pp) PF=${f2(ppf)} ${pfM < 0 ? '✗' : '✓'} (need ≥${f2(pfThr)}, ${sg(pfM, 2)} regime=${pv.regime === undefined ? 'unknown' : pv.regime}) N=${pv.paper_trades || 0} — skip auto-apply`);
      } else if (status === 'ERROR') {
        paperAllow = false;
        log.warn(`🧬 [${strategy}/${T}] PAPER VALIDATION ERROR: ${pv.skip_reason || 'unknown'} — skip auto-apply to be safe`);
      }
    }
  } catch (e) {
    log.warn(`genome._eval_one() unhandled exception: ${e && e.message}`);
    paperAllow = false;
  }

  if (!driftInfo.drift && paperAllow) {
    try {
      d.autoApply(strategy, T, best, { store, log, env: d.env, now: d.now });
    } catch (e) {
      log.debug(`auto_apply_best_genome ${strategy}/${T}: ${e.message}`);
    }
  } else if (driftInfo.drift) {
    log.info(`🧬 [${strategy}/${T}] auto-apply SKIPPED: drift detected`);
  }

  return {
    strategy,
    tf: T,
    generation,
    pop_size: evaluated.length,
    best_fitness: best.fitness === undefined ? 0 : best.fitness,
    best_wr: best.winrate === undefined ? 0 : best.winrate,
    best_pf: best.profit_factor === undefined ? 0 : best.profit_factor,
    elapsed,
  };
}

/**
 * trigger_evolution_now(strategy, tf): the lock is held → the "already running" error; else
 * one generation with a 700 s deadline → {ok: true, …result} | {ok: false, error}.
 */
async function triggerEvolutionNow(strategy, tf = null, deps = {}) {
  const d = resolve(deps);
  const T = tf || C.getDefaultTf(strategy);
  const lock = d.state.lock;
  if (lock.held) return { ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' };
  lock.held = true;
  try {
    const manual = { at: d.mono() + (deps.manualTimeoutS || C.MANUAL_EVOLUTION_TIMEOUT_S) * 1000, kind: 'manual' };
    const result = await evolveGeneration(strategy, T, { ...deps, deadlines: [...(deps.deadlines || []), manual] });
    return { ok: true, ...result };
  } catch (e) {
    if (e instanceof evaluate.DeadlineError && e.kind === 'manual') return { ok: false, error: 'Таймаут 10 мин — OKX недоступен или данных нет' };
    d.log.warn(`genome.trigger_evolution_now() unhandled exception: ${e && e.message}`);
    return { ok: false, error: String(e && e.message !== undefined ? e.message : e) };
  } finally {
    lock.held = false;
  }
}

/** One full cycle under the lock: LEVELS → SMC → VOLUME, each over its TFs, 10 s between TFs. */
async function runEvolutionCycle(deps = {}) {
  const d = resolve(deps);
  const out = [];
  for (const S of C.STRATEGIES) {
    for (const tf of C.getTfs(S)) {
      try {
        const r = await evolveGeneration(S, tf, deps);
        d.log.info(`🧬 ${S}/${tf} evolution: gen=${r.generation} fitness=${f3(num0(r.best_fitness))} WR=${f1(num0(r.best_wr))}% PF=${f2(num0(r.best_pf))} (${fmtFixed(num0(r.elapsed), 0)}s)`);
        out.push({ strategy: S, tf, ...r });
      } catch (e) {
        d.log.warn(`🧬 ${S}/${tf} evolution failed: ${e && e.message}`);
      }
      await d.sleep(deps.betweenTfsMs === undefined ? 10_000 : deps.betweenTfsMs);
    }
  }
  return out;
}

/** _seconds_until_next_evolution(now): 0 without a mark or once the interval passed. */
function secondsUntilNextEvolution(store, now) {
  try {
    const raw = store.kvGet(C.EVOLUTION_LAST_KV);
    const last = raw ? Number(raw) : 0;
    if (!(last > 0)) return 0.0;
    return pyMax(0.0, C.EVOLUTION_INTERVAL - (now - last));
  } catch (_e) {
    return 0.0;
  }
}

/** _mark_evolution_done(now): kv genome_evolution_last_ts_v1 = str(now) */
function markEvolutionDone(store, now) {
  const { pyRepr } = require('../../strategies/common/pyfmt');
  try { store.kvSet(C.EVOLUTION_LAST_KV, pyRepr(now)); } catch (_e) { /* */ }
}

/**
 * genome_evolution_loop(): NOT started by this module (the scheduler wires it). `deps.stop()`
 * → true ends the loop; `deps.waitForLowLoad()` → false skips a cycle (default: always true).
 */
async function genomeEvolutionLoop(deps = {}) {
  const d = resolve(deps);
  const stop = deps.stop || (() => false);
  d.log.info(`🧬 Genome evolution loop started (interval=${C.EVOLUTION_INTERVAL}s, initial_delay=${C.INITIAL_DELAY}s)`);
  await d.sleep(C.INITIAL_DELAY * 1000);
  const wait = secondsUntilNextEvolution(d.store, d.now());
  if (wait > 0) {
    d.log.info(`🧬 last evolution cycle ${fmtFixed((C.EVOLUTION_INTERVAL - wait) / 60, 0)} min ago — next in ${fmtFixed(wait / 60, 0)} min`);
    await d.sleep(wait * 1000);
  }
  d.log.info('🧬 Genome initial delay finished — starting first cycle');
  while (!stop()) {
    try {
      const ok = deps.waitForLowLoad ? await deps.waitForLowLoad() : true;
      if (!ok) {
        d.log.warn('🧬 skip this cycle — system load too high for 10+ минут');
        await d.sleep(C.EVOLUTION_INTERVAL * 1000);
        continue;
      }
      if (d.state.lock.held) {
        await d.sleep(60_000);
        continue;
      }
      d.state.lock.held = true;
      try {
        await (deps.runCycle || runEvolutionCycle)(deps);
        markEvolutionDone(d.store, d.now());
      } finally {
        d.state.lock.held = false;
      }
    } catch (e) {
      d.log.warn(`🧬 genome_evolution_loop: ${e && e.message}`);
    }
    if (stop()) break;
    await d.sleep(C.EVOLUTION_INTERVAL * 1000);
  }
}

module.exports = {
  STATE, _resetState, metaAdapt, buildPopulation, preloadCandles, evolveGeneration, triggerEvolutionNow,
  runEvolutionCycle, secondsUntilNextEvolution, markEvolutionDone, genomeEvolutionLoop,
};
