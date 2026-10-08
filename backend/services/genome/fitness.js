'use strict';
/**
 * fitness.js — the pure scoring half of genome.evaluate_genome (genome-challenge-profiles.md
 * §1.6.6–§1.6.10): out-of-sample split, test metrics, Wilson CI, Monte-Carlo drawdown,
 * sample / diversity / regime / walk-forward / live-calibration multipliers and
 * compute_fitness.
 *
 *   computeFitness(winrate, pf, trades, drawdown)   compute_fitness (no PF cap; DD quirk)
 *   wilsonCi(winratePct, n)                          95 % Wilson interval → [low, high] (1 dp, %)
 *   maxDrawdown(rrList)                              running-equity peak-to-trough in R
 *   monteCarloP95Dd(rrList, rng)                     200 shuffles → sorted DDs[190]
 *   scoreTrades(allTrades, coinTradeCounts, strategy, opts)   the whole metrics dict
 *   coinFitness(wr, pf, trades, dd)                  _coin_fitness of the coin-champion kv
 *
 * QUIRKS kept: the drawdown penalty is `dd/100` when dd > 1 but the RAW dd when dd ≤ 1
 * (a 0.9 R drawdown costs 0.9, a 1.1 R drawdown 0.011); BE trades (rr == 0) count in the
 * total but neither as wins nor losses; PF is capped at 10 only here, not in compute_fitness.
 *
 * Monte Carlo (DESIGN, PLAN M16): the bot shuffles with `random.Random(42)` (Mersenne
 * Twister); the port shuffles with the seeded JS generator (`mcRng`, default mulberry32(42)),
 * so `mc_p95_dd` — and through `mc_mult` possibly the fitness — differs from Python by
 * design. Only the formula (200 shuffles of the test R list, index int(200 × 0.95), the
 * 15 / 10 / 5 R thresholds) is pinned; `opts.mcP95Dd` injects the value for parity tests.
 *
 * Sums use the bot's CPython 3.11 builtin sum() (series.pySum: plain left-to-right addition).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyMax2, pyMin2 } = require('../../strategies/common/pyval');
const { pySum } = require('../../strategies/common/series');
const { createRng } = require('./rng');
const C = require('./config');

/**
 * CPython math.log1p (glibc) for the integer trade counts compute_fitness sees. V8's fdlibm
 * log1p is bit-identical except at n = 175 and n = 184 (1 ulp; checked for every n in
 * 0..20000 with `[math.log1p(n) for n in range(20001)]`), so those two are pinned.
 */
const LOG1P_GLIBC = Object.freeze({ 175: 5.170483995038151, 184: 5.220355825078325 });
function pyLog1p(x) {
  if (Number.isInteger(x) && Object.prototype.hasOwnProperty.call(LOG1P_GLIBC, x)) return LOG1P_GLIBC[x];
  return Math.log1p(x);
}

/** compute_fitness(winrate, profit_factor, trades, drawdown) */
function computeFitness(winrate, profitFactor, trades, drawdown) {
  if (trades <= 0) return 0.0;
  let wr = pyMax2(0.0, pyMin2(1.0, winrate > 1.0 ? winrate / 100.0 : winrate));
  if (wr < 0.35) wr = wr * 0.5;
  let pf = pyMax2(0.0, profitFactor);           // [PHASE3-FIX 3D-7] no PF cap
  if (pf < 1.2) pf = pf * 0.7;
  let size = pyLog1p(trades);
  if (trades < 8) size = size * (trades / 8.0);   // [GENOME-LOW-N-FIX]
  if (trades > 50) size = size * 0.8;
  const ddPenalty = drawdown > 1 ? pyMax2(0.0, drawdown) / 100.0 : pyMax2(0.0, drawdown);
  const raw = wr * pf * size - ddPenalty;
  return pyRound(pyMax2(0.0, raw), 4);
}

/** The Wilson 95 % interval of evaluate_genome: winrate in %, n trades → [low%, high%] (1 dp). */
function wilsonCi(winratePct, n) {
  if (!(n > 0)) return [0.0, 0.0];
  const z = 1.96;
  const p = winratePct / 100;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom;
  return [pyRound(pyMax2(0, center - margin) * 100, 1), pyRound(pyMin2(1, center + margin) * 100, 1)];
}

/** Running-equity max drawdown (R) of a list of R multiples. */
function maxDrawdown(rrList) {
  let eq = 0.0;
  let peak = 0.0;
  let dd = 0.0;
  for (const r of rrList) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}

/** Monte-Carlo p95 drawdown: 200 shuffled copies of the list (one rng stream), sorted, [190]. */
function monteCarloP95Dd(rrList, rng = createRng(42), runs = 200) {
  const dds = [];
  for (let k = 0; k < runs; k++) {
    const sh = rrList.slice();
    rng.shuffle(sh);
    dds.push(maxDrawdown(sh));
  }
  dds.sort((a, b) => a - b);
  return dds[Math.trunc(dds.length * 0.95)];
}

/** mc_mult from the p95 drawdown. */
function mcMultiplier(p95) {
  if (p95 > 15) return 0.5;
  if (p95 > 10) return 0.7;
  if (p95 > 5) return 0.9;
  return 1.0;
}

/**
 * The OOS split of evaluate_genome: split_idx = int(len × oos(strategy)); fewer than 3 test
 * trades → the whole list.
 */
function oosTestTrades(allTrades, strategy) {
  const splitIdx = Math.trunc(allTrades.length * C.oosSplit(strategy));
  const test = allTrades.slice(splitIdx);
  return test.length < 3 ? allTrades.slice() : test;
}

/**
 * Metrics + fitness of a sorted trade list (evaluate_genome after the LOW-TRADES floor).
 * @param {Array<[string, number]>} allTrades  [(ts, rr)] sorted by ts (stable)
 * @param {number[]} coinTradeCounts           total_trades of every kept backtest result
 * @param {string} strategy
 * @param {object} [opts]  { liveWrBaseline = null, mcRng, mcP95Dd (override), perCoin = {} }
 * @returns {object} the evaluate_genome output dict + `_raw` diagnostics (fitness_raw, mc_mult)
 */
function scoreTrades(allTrades, coinTradeCounts, strategy, opts = {}) {
  const test = oosTestTrades(allTrades, strategy);
  const rrs = test.map((t) => t[1]);
  const total = test.length;
  let wins = 0;
  for (const r of rrs) if (r > 0) wins++;
  const testWr = total > 0 ? wins / total * 100 : 0;

  const profit = pySum(rrs.filter((r) => r > 0));
  const loss = Math.abs(pySum(rrs.filter((r) => r <= 0)));
  let pf = loss > 0 ? profit / loss : (profit > 0 ? 10.0 : 0);
  if (!Number.isFinite(pf) || pf > 10) pf = 10.0;

  const ddMax = maxDrawdown(rrs);

  // ── multi-regime: halves of the test set ──
  let regimeMult = 1.0;
  if (total >= 10) {
    const mid = Math.floor(total / 2);
    const p1 = rrs.slice(0, mid);
    const p2 = rrs.slice(mid);
    const w1 = p1.filter((r) => r > 0).length;
    const w2 = p2.filter((r) => r > 0).length;
    const wr1 = p1.length ? w1 / p1.length * 100 : 0;
    const wr2 = p2.length ? w2 / p2.length * 100 : 0;
    const pnl1 = pySum(p1);
    const pnl2 = pySum(p2);
    if (pnl1 < 0 || pnl2 < 0) regimeMult = 0.4;
    else if (Math.abs(wr1 - wr2) > 20) regimeMult = 0.6;
    else if (Math.abs(wr1 - wr2) > 10) regimeMult = 0.85;
  }

  const [ciLow, ciHigh] = wilsonCi(testWr, total);
  const livePf = pyRound(pf * C.LIVE_PF_DISCOUNT, 2);

  // ── Monte Carlo (JS seeded RNG by design — see the header) ──
  let mcMult = 1.0;
  let mcP95 = 0.0;
  if (total >= 10) {
    if (opts.mcP95Dd !== undefined && opts.mcP95Dd !== null) mcP95 = Number(opts.mcP95Dd);
    else mcP95 = monteCarloP95Dd(rrs, opts.mcRng || createRng(42));
    mcMult = mcMultiplier(mcP95);
  }

  // ── sample size ──
  let sampleMult = 1.0;
  if (total < 10) sampleMult = 0.4;
  else if (total < 20) sampleMult = 0.7;
  else if (total < 40) sampleMult = 0.9;

  // ── coin diversity (+ unrealistic PF) ──
  const coinsWithTrades = (coinTradeCounts || []).filter((n) => (n || 0) >= 2).length;
  let divMult = 1.0;
  if (coinsWithTrades <= 1) divMult = 0.4;
  else if (coinsWithTrades <= 3) divMult = 0.7;
  else if (coinsWithTrades <= 5) divMult = 0.9;
  if (pf > 5 && total < 40) divMult *= 0.6;

  // ── walk-forward (4 folds over ALL trades, PnL-weighted) ──
  let wfMult = 1.0;
  let wfProfitable = 0;
  let wfTotal = 0;
  const K = 4;
  if (allTrades.length >= 16) {
    const foldSize = Math.floor(allTrades.length / K);
    wfTotal = K;
    const pnls = [];
    for (let f = 0; f < K; f++) {
      const start = f * foldSize;
      const end = f < K - 1 ? start + foldSize : allTrades.length;
      const pnl = pySum(allTrades.slice(start, end).map((t) => t[1]));
      pnls.push(pnl);
      if (pnl > 0) wfProfitable += 1;
    }
    let absMax = Math.abs(pnls[0]);
    for (let k = 1; k < pnls.length; k++) if (Math.abs(pnls[k]) > absMax) absMax = Math.abs(pnls[k]);
    const avg = pySum(pnls) / pnls.length;
    const norm = absMax > 1e-9 ? avg / absMax : 0.0;
    if (norm >= 0.75) wfMult = 1.10;
    else if (norm >= 0.30) wfMult = 1.00;
    else if (norm >= -0.10) wfMult = 0.85;
    else if (norm >= -0.50) wfMult = 0.65;
    else if (norm >= -0.80) wfMult = 0.45;
    else wfMult = 0.30;
  }

  // ── live calibration ──
  let liveCalMult = 1.0;
  const base = opts.liveWrBaseline;
  if (base !== undefined && base !== null && base > 0 && testWr > 0) {
    const ratio = testWr / base;
    if (ratio > 1.5) liveCalMult = 0.70;
    else if (ratio > 1.3) liveCalMult = 0.85;
    else if (ratio < 0.7) liveCalMult = 1.10;
  }

  const fitnessRaw = computeFitness(testWr, pf, total, ddMax);
  const fitness = pyRound(fitnessRaw * sampleMult * divMult * regimeMult * mcMult * wfMult * liveCalMult, 4);

  const out = {
    winrate: pyRound(testWr, 2),
    profit_factor: pyRound(pf, 2),
    trades: total,
    drawdown: pyRound(ddMax, 2),
    fitness,
    live_pf: livePf,
    wr_ci_low: ciLow,
    wr_ci_high: ciHigh,
    mc_p95_dd: pyRound(mcP95, 2),
    regime_mult: regimeMult,
    sample_mult: sampleMult,
    div_mult: pyRound(divMult, 2),
    wf_mult: pyRound(wfMult, 2),
    wf_profitable_folds: wfProfitable,
    wf_total_folds: wfTotal,
    live_cal_mult: pyRound(liveCalMult, 2),
    per_coin: opts.perCoin || {},
  };
  Object.defineProperty(out, '_raw', {
    value: { fitnessRaw, mcMult, mcP95, testWins: wins, testTotal: total }, enumerable: false,
  });
  return out;
}

/**
 * _coin_fitness(wr, pf, trades, dd) of the coin-champion kv: (WR, PF) normalised to 0..1,
 * × sample × DD penalty, round 3. With the per-coin WR quirk (always 0) the result is 0.0.
 */
function coinFitness(wr, pf, trades, dd) {
  const wrNorm = (wr / 100.0) * 2.0 - 1.0;
  const pfNorm = Math.tanh((pf - 1.0) / 2.0);
  let sMult;
  if (trades < 5) sMult = 0.4;
  else if (trades < 10) sMult = 0.7;
  else if (trades < 20) sMult = 0.9;
  else sMult = 1.0;
  let ddPen;
  if (dd < 3) ddPen = 1.0;
  else if (dd < 5) ddPen = 0.7;
  else ddPen = 0.4;
  const b = pyMax2(0.0, (wrNorm + 1.0) / 2.0) * pyMax2(0.0, (pfNorm + 1.0) / 2.0);
  return pyRound(b * sMult * ddPen, 3);
}

module.exports = {
  pyLog1p, computeFitness, wilsonCi, maxDrawdown, monteCarloP95Dd, mcMultiplier, oosTestTrades, scoreTrades, coinFitness,
};
