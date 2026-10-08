'use strict';
/**
 * paperValidation.js — genome.validate_via_paper(genome, strategy, tf) (genome-challenge-
 * profiles.md §1.10): the recent closed live trades of the strategy (signal_trades, ALL users,
 * no TF filter, regime-aware age window), filtered by the genome's min_rr against the R:R of
 * the trade (SMC → TP2, else TP1), → OK / FAILED / INSUFFICIENT_DATA (< 30) / ERROR.
 * Side effect on OK/FAILED: kv `genome_live_baseline_{S}_{tf}` (read back by evolve as the
 * live-calibration baseline). In-memory `_last_paper_regime[strategy]` drives the
 * `[DRIFT-REGIME-SHIFT]` observability warning (lost on restart, like the bot).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyFloat, pyTruthy } = require('../../strategies/common/pyval');
const { pySum } = require('../../strategies/common/series');
const { GENE_SPACE, pyDumps } = require('./geneSpace');
const C = require('./config');
const regime = require('./regime');
const { pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

/** strategy → regime at the last validation (genome._last_paper_regime). */
const LAST_PAPER_REGIME = new Map();

const defaultLog = () => require('../../utils/logger');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
/** float(x or 0) */
const f0 = (x) => (pyTruthy(x) ? pyFloat(x) : 0);

function validateViaPaper(genome, strategy, tf, {
  store = null, db = null, now = Date.now() / 1000, getRegime = null, lastRegime = LAST_PAPER_REGIME, log = null,
} = {}) {
  const lg = log || defaultLog();
  try {
    const st = store || require('./store');
    const conn = db || st.getDb();
    let reg = null;
    try { reg = (getRegime || regime.getCachedRegime)(); } catch (_e) { reg = null; }
    const ageDays = C.ageWindowDaysForRegime(reg);
    const cutoff = now - ageDays * 86400;
    const trades = conn.prepare(
      'SELECT symbol, direction, entry, sl, tp1, tp2, result, result_rr FROM signal_trades WHERE strategy=? AND created_at>? '
      + "AND result IN ('TP1','TP2','TP3','SL') ORDER BY created_at DESC LIMIT 200",
    ).all(strategy, cutoff);

    // [GENOME-PAPER-VOLUME-FIX] no min_rr gene (VOLUME) → no R:R filter
    let minRr;
    if (own(genome, 'min_rr')) minRr = pyTruthy(genome.min_rr) ? pyFloat(genome.min_rr) : 0.0;
    else if (own(GENE_SPACE[strategy], 'min_rr')) minRr = 2.0;
    else minRr = 0.0;
    // [GENOME-PAPER-SMC-FIX] SMC's MIN_RR is measured to TP2, LEVELS to TP1
    const rrKey = pyUpper(String(strategy)) === 'SMC' ? 'tp2' : 'tp1';
    const passed = [];
    for (const t of trades) {
      const entry = f0(t.entry);
      const sl = f0(t.sl);
      const tpRef = f0(t[rrKey]) || f0(t.tp1);
      if (entry <= 0 || sl <= 0) continue;
      const risk = Math.abs(entry - sl);
      const rr = risk > 0 ? Math.abs(tpRef - entry) / risk : 0;
      if (rr >= minRr) passed.push(t);
    }

    if (passed.length < C.MIN_PAPER_VALIDATION_N) {
      return {
        status: 'INSUFFICIENT_DATA', wr: null, pf: null, n: passed.length,
        skip_reason: 'insufficient_sample_size', valid: null,
        paper_wr: 0.0, paper_pf: 0.0, paper_trades: passed.length,
        regime: reg || 'unknown', age_window_days: ageDays,
      };
    }

    const wins = passed.filter((t) => ['TP1', 'TP2', 'TP3'].includes(t.result)).length;
    const paperWr = wins / passed.length * 100;
    const rrOf = (t) => pyFloat(t.result_rr);        // float(None) → TypeError → ERROR (as the bot)
    const num = pySum(passed.filter((t) => rrOf(t) > 0).map(rrOf));
    const den = Math.abs(pySum(passed.filter((t) => rrOf(t) <= 0).map(rrOf)));
    const paperPf = den > 0 ? num / den : 10.0;

    const pfThresh = C.pfThresholdForRegime(reg);
    const regimeKey = reg || 'unknown';
    const prevRegime = lastRegime.get(strategy) || '';
    if (prevRegime && prevRegime !== regimeKey) {
      const prevThresh = C.pfThresholdForRegime(prevRegime);
      lg.warn(`🧬 [${strategy}] [DRIFT-REGIME-SHIFT] regime ${prevRegime}→${regimeKey} (pf_threshold ${prevThresh.toFixed(2)}→${pfThresh.toFixed(2)}) — paper sample (${passed.length} trades) may reflect stale regime`);
    }
    lastRegime.set(strategy, regimeKey);

    const isOk = paperWr >= C.PAPER_WR_THRESHOLD && paperPf >= pfThresh;

    try {
      st.kvSet(`genome_live_baseline_${strategy}_${tf}`, pyDumps({
        live_wr: pyRound(paperWr, 1), live_pf: pyRound(paperPf, 2), n: passed.length, regime: regimeKey, ts: now,
      }, { floatKeys: new Set(['live_wr', 'live_pf', 'ts']) }));
    } catch (e) {
      lg.debug(`save live baseline ${strategy}/${tf}: ${e.message}`);
    }

    return {
      status: isOk ? 'OK' : 'FAILED',
      wr: pyRound(paperWr, 1), pf: pyRound(paperPf, 2), n: passed.length,
      valid: isOk,
      paper_wr: pyRound(paperWr, 1),
      paper_pf: pyRound(paperPf, 2),
      regime: regimeKey,
      prev_regime: prevRegime,
      regime_shifted: Boolean(prevRegime && prevRegime !== regimeKey),
      pf_threshold: pyRound(pfThresh, 2),
      wr_threshold: pyRound(C.PAPER_WR_THRESHOLD, 1),
      paper_trades: passed.length,
      age_window_days: ageDays,
    };
  } catch (e) {
    lg.debug(`validate_via_paper: ${e && e.message}`);
    return {
      status: 'ERROR', wr: null, pf: null, n: 0,
      skip_reason: `error: ${(e && e.name) || 'Exception'}`,
      valid: null, paper_wr: 0.0, paper_pf: 0.0, paper_trades: 0,
    };
  }
}

module.exports = { validateViaPaper, LAST_PAPER_REGIME };
