'use strict';
/**
 * drift.js — genome.check_drift(strategy, tf) (genome-challenge-profiles.md §1.9): the best
 * individual's backtest WR × 0.70 against the live WR of the last 7 days of signal_trades
 * (bot `trades`, ALL users, no TF filter), asymmetric (live better than predicted is never
 * drift), regime-aware threshold. Any exception → {drift: false}.
 *
 * The market regime comes from `regime.getCachedRegime()` (the scanner's cached BTC regime;
 * the engine worker installs the provider — null until then, i.e. "unknown" → base 15 pp).
 */

const { pyRound, pyMax } = require('../../strategies/common/pyround');
const C = require('./config');
const regime = require('./regime');

const fitOf = (g) => (g && g.fitness !== undefined && g.fitness !== null ? g.fitness : 0);

/**
 * check_drift(strategy, tf) → {drift, backtest_wr, predicted_live_wr, live_wr, delta, threshold,
 * regime, live_trades, breakdown{tp, be_half, manual_win, manual_half, sl}} | {drift:false, reason…}
 */
function checkDrift(strategy, tf, { store = null, db = null, now = Date.now() / 1000, getRegime = null } = {}) {
  try {
    const st = store || require('./store');
    const conn = db || st.getDb();
    const gen = st.getLastGeneration(strategy, tf);
    if (gen === 0) return { drift: false };
    const pop = st.getCurrentPopulation(strategy, tf, gen);
    if (!pop.length) return { drift: false };
    let best = pop[0];
    for (let i = 1; i < pop.length; i++) if (fitOf(pop[i]) > fitOf(best)) best = pop[i];
    const backtestWr = best.winrate === undefined || best.winrate === null ? 0 : best.winrate;
    const btTrades = Math.trunc(Number(best.trades || 0));
    if (btTrades < 5) return { drift: false, reason: 'backtest_low_trades', backtest_trades: btTrades };

    const cutoff = now - 7 * 86400;
    const rows = conn.prepare(
      'SELECT result, COALESCE(result_rr, 0) AS rr FROM signal_trades WHERE strategy=? AND created_at>? '
      + "AND result IN ('TP1','TP2','TP3','SL','BE','MANUAL')",
    ).all(strategy, cutoff);
    if (rows.length < C.DRIFT_MIN_TRADES) return { drift: false, reason: 'insufficient_trades', live_trades: rows.length };

    const rr = (r) => Number(r.rr || 0);
    const winsTp = rows.filter((r) => ['TP1', 'TP2', 'TP3'].includes(r.result)).length;
    const winsBe = rows.filter((r) => r.result === 'BE').length * 0.5;
    const winsManual = rows.filter((r) => r.result === 'MANUAL' && rr(r) > 0.1).length;
    const halfManual = rows.filter((r) => r.result === 'MANUAL' && rr(r) > -0.1 && rr(r) <= 0.1).length * 0.5;
    const liveWins = winsTp + winsBe + winsManual + halfManual;
    const liveWr = liveWins / rows.length * 100;

    const predicted = backtestWr * C.LIVE_WR_DISCOUNT;
    const delta = pyMax(0.0, predicted - liveWr);
    let reg = null;
    try { reg = (getRegime || regime.getCachedRegime)(); } catch (_e) { reg = null; }
    const threshold = C.driftThresholdForRegime(reg);
    return {
      drift: delta > threshold,
      backtest_wr: pyRound(backtestWr, 1),
      predicted_live_wr: pyRound(predicted, 1),
      live_wr: pyRound(liveWr, 1),
      delta: pyRound(delta, 1),
      threshold: pyRound(threshold, 1),
      regime: reg || 'unknown',
      live_trades: rows.length,
      breakdown: {
        tp: winsTp,
        be_half: pyRound(winsBe, 1),
        manual_win: winsManual,
        manual_half: pyRound(halfManual, 1),
        sl: rows.filter((r) => r.result === 'SL').length,
      },
    };
  } catch (_e) {
    return { drift: false };
  }
}

module.exports = { checkDrift };
