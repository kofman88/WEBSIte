'use strict';
/**
 * signalBuilder.js — one-to-one port of `smc/signal_builder.build_smc_signal` and its
 * scoring helpers (`score_bullish` / `score_bearish` c1..c8 with the Russian labels,
 * `_check_retrace_with_depth`, `_compute_mode_tag`, GRADES, memcoin / 5 caps,
 * LONG-wins-ties). Spec strategy-smc.md §5.1–§5.3, §5.5; quirks §11.9–§11.12.
 *
 * Pure: `analysis` is the analyzer dict (+ `squeeze_score` injected by the scanner),
 * `cfg` the builder SMCConfig object (MIN_CONFIRMATIONS, MIN_RR, SL_BUFFER_PCT,
 * VOL_MULT, USE_VOLUME_FILTER), the options mirror the Python keyword arguments
 * (`build_kwargs` of the golden fixtures can be passed through unchanged).
 */

const { fmtFixed, pyRepr } = require('../common/pyfmt');
const { pyInt } = require('../common/pyround');
const { pyTruthy, pyOr, pyGet, pyFloat, pyMax2 } = require('../common/pyval');
const { calculateLevels, isMemcoin } = require('./levels');
const { generateNarrative } = require('./narrative');

const GRADES = Object.freeze({ 5: '🔥 A+', 4: '✅ A', 3: '⚡ B' });
const MODE_CONSERVATIVE = '🎯 Conservative';
const MODE_AGGRESSIVE = '⚡ Aggressive';
const ALL_DIRS = Object.freeze(['LONG', 'SHORT']);

const LABELS = Object.freeze({
  LONG: {
    c1: 'HTF структура: бычья / CHoCH вверх',
    c2: 'Liquidity Sweep: ликвидность снята снизу',
    c3: 'Order Block: бычий OB митигирован',
    c4: 'FVG/IFVG: дисбаланс в зоне входа',
    c5: 'Discount Zone: цена в нижних 50%',
    c7: 'Retrace: возврат к OB50% или FVG',
    c8: 'BB Squeeze: компрессия волатильности',
  },
  SHORT: {
    c1: 'HTF структура: медвежья / CHoCH вниз',
    c2: 'Liquidity Sweep: ликвидность снята сверху',
    c3: 'Order Block: медвежий OB митигирован',
    c4: 'FVG/IFVG: дисбаланс в зоне входа',
    c5: 'Premium Zone: цена в верхних 50%',
    c7: 'Retrace: возврат к OB50% или FVG',
    c8: 'BB Squeeze: компрессия волатильности',
  },
});

/** c6 label: f"Объём: {vol_ratio:.2f}× ≥ {vol_mult}× среднего" (vol_mult is a Python float → repr). */
function volumeLabel(volRatio, volMult) {
  return `Объём: ${fmtFixed(volRatio, 2)}× ≥ ${pyRepr(volMult)}× среднего`;
}

/**
 * _check_retrace_with_depth(analysis, direction, depth=0.5): price returned to the POI.
 *   depth <= 0.0 → any touch of the OB (ob.mitigated); depth == 0.5 (EXACT float compare,
 *   QUIRK spec §11.11) → ob_50_reached; other depth → target level inside the OB vs
 *   current_low / current_high. FVG touch and impulse-FVG touch are alternatives.
 */
function checkRetraceWithDepth(analysis, direction, depth = 0.5) {
  const obKey = direction === 'LONG' ? 'bull_ob' : 'bear_ob';
  const fvgKey = direction === 'LONG' ? 'bull_fvg' : 'bear_fvg';

  const ob = pyGet(pyGet(analysis, 'ob', {}), obKey, {});
  const fvgObj = pyGet(pyGet(analysis, 'fvg', {}), fvgKey, undefined);
  const cp = pyGet(analysis, 'current_price', 0.0);

  // ── OB retrace (depth-driven) ──
  if (pyTruthy(pyGet(ob, 'found', undefined))) {
    if (depth <= 0.0) {
      if (pyTruthy(pyGet(ob, 'mitigated', false))) return true;
    } else if (depth === 0.5) {
      if (pyTruthy(pyGet(ob, 'ob_50_reached', false))) return true;
    } else {
      const obLow = pyGet(ob, 'ob_low', 0.0);
      const obHigh = pyGet(ob, 'ob_high', 0.0);
      const obType = pyGet(ob, 'type', '');
      if (obLow > 0 && obHigh > obLow) {
        if (obType === 'bullish' || obType === 'bullish_breaker') {
          // price comes down: target = ob_high - depth*(range)
          const target = obHigh - depth * (obHigh - obLow);
          const cRef = pyGet(analysis, 'current_low', cp);
          if (cRef <= target) return true;
        } else {
          // price goes up: target = ob_low + depth*(range)
          const target = obLow + depth * (obHigh - obLow);
          const cRef = pyGet(analysis, 'current_high', cp);
          if (cRef >= target) return true;
        }
      }
    }
  }

  // ── FVG touch (alternative entry regardless of depth) ──
  if (pyTruthy(fvgObj) && cp > 0) {
    const fvgLow = pyGet(fvgObj, 'fvg_low', 0.0);
    const fvgHigh = pyGet(fvgObj, 'fvg_high', 0.0);
    if (fvgLow < fvgHigh && fvgLow <= cp && cp <= fvgHigh) return true;
  }

  // ── impulse FVG inside the OB ──
  const impFvg = pyGet(ob, 'impulse_fvg', undefined);
  if (pyTruthy(impFvg) && cp > 0) {
    const fvgLow = pyGet(impFvg, 'fvg_low', 0.0);
    const fvgHigh = pyGet(impFvg, 'fvg_high', 0.0);
    if (fvgLow < fvgHigh && fvgLow <= cp && cp <= fvgHigh) return true;
  }

  return false;
}

/** _check_retrace: the c7 predicate — always depth 0.5 (QUIRK spec §11.11). */
function checkRetrace(analysis, direction) {
  return checkRetraceWithDepth(analysis, direction, 0.5);
}

/** Python sum() of a truth value: bools count 1/0, numbers add themselves. */
function pyTruthCount(x) {
  return typeof x === 'number' ? x : (pyTruthy(x) ? 1 : 0);
}

/**
 * _compute_mode_tag(conf_type, pd_filter, retrace_depth, mtf_check):
 * "🎯 Conservative" when ≥ 2 strict filters are active, else "⚡ Aggressive".
 */
function computeModeTag(confType, pdFilter, retraceDepth, mtfCheck) {
  const strict = (confType === 'BODY_CLOSE' ? 1 : 0)
    + pyTruthCount(pdFilter)
    + (retraceDepth >= 0.5 ? 1 : 0)
    + pyTruthCount(mtfCheck);
  return strict >= 2 ? MODE_CONSERVATIVE : MODE_AGGRESSIVE;
}

function scoreOf(confirmations) {
  let n = 0;
  for (const [, v] of confirmations) if (v) n++;
  return n;
}

/** score_bullish(analysis, vol_mult=1.2) → { score, confirmations: [[label, bool] × 8] } */
function scoreBullish(analysis, volMult = 1.2) {
  const s = pyGet(analysis, 'structure', {});
  const liq = pyGet(analysis, 'liquidity', {});
  const ob = pyGet(pyGet(analysis, 'ob', {}), 'bull_ob', {});
  const fvg = pyGet(analysis, 'fvg', {});
  const pd = pyGet(analysis, 'pd_zone', {});
  const choch = pyGet(s, 'choch', {});

  const c1 = pyGet(s, 'trend', undefined) === 'BULLISH'
    || (pyTruthy(pyGet(choch, 'detected', undefined)) && choch.direction === 'UP');
  const c2 = pyTruthy(pyGet(pyGet(liq, 'sweep_up', {}), 'swept', false));
  const c3 = pyTruthy(pyGet(ob, 'found', undefined)) && pyTruthy(pyGet(ob, 'mitigated', undefined));
  const c4 = pyTruthy(pyGet(fvg, 'bull_found', false));
  const c5 = pyGet(pd, 'zone', undefined) === 'DISCOUNT';
  const volRatio = pyFloat(pyOr(pyGet(analysis, 'vol_ratio', 0.0), 0.0));
  const c6 = volRatio >= pyFloat(volMult);
  const c7 = checkRetrace(analysis, 'LONG');
  const c8 = pyInt(pyOr(pyGet(analysis, 'squeeze_score', 0), 0)) >= 1;

  const L = LABELS.LONG;
  const confirmations = [
    [L.c1, Boolean(c1)],
    [L.c2, Boolean(c2)],
    [L.c3, Boolean(c3)],
    [L.c4, Boolean(c4)],
    [L.c5, Boolean(c5)],
    [volumeLabel(volRatio, volMult), Boolean(c6)],
    [L.c7, Boolean(c7)],
    [L.c8, Boolean(c8)],
  ];
  return { score: scoreOf(confirmations), confirmations };
}

/** score_bearish(analysis, vol_mult=1.2) → { score, confirmations } */
function scoreBearish(analysis, volMult = 1.2) {
  const s = pyGet(analysis, 'structure', {});
  const liq = pyGet(analysis, 'liquidity', {});
  const ob = pyGet(pyGet(analysis, 'ob', {}), 'bear_ob', {});
  const fvg = pyGet(analysis, 'fvg', {});
  const pd = pyGet(analysis, 'pd_zone', {});
  const choch = pyGet(s, 'choch', {});

  const c1 = pyGet(s, 'trend', undefined) === 'BEARISH'
    || (pyTruthy(pyGet(choch, 'detected', undefined)) && choch.direction === 'DOWN');
  const c2 = pyTruthy(pyGet(pyGet(liq, 'sweep_down', {}), 'swept', false));
  const c3 = pyTruthy(pyGet(ob, 'found', undefined)) && pyTruthy(pyGet(ob, 'mitigated', undefined));
  const c4 = pyTruthy(pyGet(fvg, 'bear_found', false));
  const c5 = pyGet(pd, 'zone', undefined) === 'PREMIUM';
  const volRatio = pyFloat(pyOr(pyGet(analysis, 'vol_ratio', 0.0), 0.0));
  const c6 = volRatio >= pyFloat(volMult);
  const c7 = checkRetrace(analysis, 'SHORT');
  const c8 = pyInt(pyOr(pyGet(analysis, 'squeeze_score', 0), 0)) >= 1;

  const L = LABELS.SHORT;
  const confirmations = [
    [L.c1, Boolean(c1)],
    [L.c2, Boolean(c2)],
    [L.c3, Boolean(c3)],
    [L.c4, Boolean(c4)],
    [L.c5, Boolean(c5)],
    [volumeLabel(volRatio, volMult), Boolean(c6)],
    [L.c7, Boolean(c7)],
    [L.c8, Boolean(c8)],
  ];
  return { score: scoreOf(confirmations), confirmations };
}

/** GRADES.get(score, f"⚡ {score}/5") */
function gradeOf(score) {
  return Object.prototype.hasOwnProperty.call(GRADES, score) ? GRADES[score] : `⚡ ${score}/5`;
}

/**
 * build_smc_signal(symbol, analysis, cfg, tf_htf="4H", tf_mtf="1H", tf_ltf="15m",
 *                  conf_type="WICK_TOUCH", pd_filter=False, retrace_depth=0.0,
 *                  mtf_check=False, allowed_dirs=("LONG","SHORT")) → SMCSignalResult | None
 *
 * Tries LONG then SHORT (allowed_dirs filter first), keeps the higher score — ties go
 * to LONG (QUIRK spec §11.10). Result object = the SMCSignalResult dataclass fields:
 * { symbol, direction, score, grade, entry_low, entry_high, entry, sl, tp1, tp2, tp3, rr,
 *   risk_pct, confirmations: [[label, bool] × 8], narrative, session: "", tf_htf, tf_mtf,
 *   tf_ltf, mode_tag }.
 */
function buildSmcSignal(symbol, analysis, cfg, {
  tf_htf = '4H', tf_mtf = '1H', tf_ltf = '15m',
  conf_type = 'WICK_TOUCH', pd_filter = false, retrace_depth = 0.0, mtf_check = false,
  allowed_dirs = ALL_DIRS,
} = {}) {
  if (pyTruthy(pyGet(analysis, 'error', undefined))) return null;

  const structure = pyGet(analysis, 'structure', {});
  const htfTrend = pyGet(structure, 'trend', 'RANGING');
  const htfChoch = pyGet(structure, 'choch', {});
  const pdZone = pyGet(analysis, 'pd_zone', {});
  const posPct = pyGet(pdZone, 'position_pct', 50.0);   // rounded to 1 dp by the analyzer (QUIRK spec §11.12)
  const modeTag = computeModeTag(conf_type, pd_filter, retrace_depth, mtf_check);

  // ── [F1] wick-sweep guard (BODY_CLOSE mode only, both directions) ──
  if (conf_type === 'BODY_CLOSE') {
    const bosWs = pyGet(structure, 'bos_wick_sweep', false);
    const chochWs = pyGet(structure, 'choch_wick_sweep', false);
    if (pyTruthy(bosWs) || pyTruthy(chochWs)) return null;
  }

  let best = null;
  for (const direction of ALL_DIRS) {
    if (!allowed_dirs.includes(direction)) continue;

    // ── [F2] multi-TF confluence (mtf_check only) ──
    if (pyTruthy(mtf_check)) {
      if (direction === 'LONG') {
        const htfBlocks = htfTrend === 'BEARISH'
          && !(pyTruthy(pyGet(htfChoch, 'detected', undefined)) && pyGet(htfChoch, 'direction', undefined) === 'UP');
        if (htfBlocks) continue;
      } else {
        const htfBlocks = htfTrend === 'BULLISH'
          && !(pyTruthy(pyGet(htfChoch, 'detected', undefined)) && pyGet(htfChoch, 'direction', undefined) === 'DOWN');
        if (htfBlocks) continue;
      }
    }

    // ── [F3] premium / discount (pd_filter only) ──
    if (pyTruthy(pd_filter)) {
      if (direction === 'LONG' && posPct >= 50.0) continue;
      if (direction === 'SHORT' && posPct < 50.0) continue;
    }

    // ── [F4] retrace to the POI (retrace_depth > 0 only) ──
    if (retrace_depth > 0.0) {
      if (!checkRetraceWithDepth(analysis, direction, retrace_depth)) continue;
    }

    // ── scoring ──
    const volMult = pyFloat(pyOr(pyGet(cfg, 'VOL_MULT', 1.2), 1.2));
    const { score, confirmations } = direction === 'LONG'
      ? scoreBullish(analysis, volMult)
      : scoreBearish(analysis, volMult);

    // ── [F5] hard volume filter ──
    if (pyTruthy(pyGet(cfg, 'USE_VOLUME_FILTER', false))) {
      const volRatio = pyFloat(pyOr(pyGet(analysis, 'vol_ratio', 0.0), 0.0));
      if (volRatio < volMult) continue;
    }

    // raw 0..8 score against MIN_CONFIRMATIONS (QUIRK spec §11.9: caps apply after)
    if (score < cfg.MIN_CONFIRMATIONS) continue;

    const levels = calculateLevels(analysis, direction, cfg);
    if (levels === null) continue;

    const narrative = generateNarrative(analysis, levels, direction, { tf_htf, tf_mtf, tf_ltf, show_invalidation: true, cfg });

    // ── R:R filter (on the 2-dp rounded rr, like the bot) ──
    const rrVal = levels.rr;
    const minRr = pyGet(cfg, 'MIN_RR', 0.8);
    if (rrVal < minRr) continue;
    // [SMC-LADDER] the fallback ladder may not rescue a setup whose structural TP2 is below MIN_RR
    if (pyTruthy(pyGet(levels, 'ladder_fallback', undefined)) && pyFloat(pyGet(levels, 'rr_structural', 0.0)) < minRr) continue;
    let adjustedScore = score;
    if (rrVal < pyMax2(minRr, 1.2)) adjustedScore = Math.max(0, score - 1);   // low R:R lowers the grade

    // ── memcoin: at most 3 confirmations ──
    if (isMemcoin(symbol)) adjustedScore = Math.min(adjustedScore, 3);

    // [SQUEEZE] clamp to 5 (A+ ceiling) — 8 confirmations, c8 is a "topper"
    adjustedScore = Math.min(adjustedScore, 5);

    const sig = {
      symbol,
      direction,
      score: adjustedScore,
      grade: gradeOf(adjustedScore),
      entry_low: levels.entry_low,
      entry_high: levels.entry_high,
      entry: levels.entry_mid,
      sl: levels.sl,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      rr: levels.rr,
      risk_pct: levels.risk_pct,
      confirmations,
      narrative,
      session: '',
      tf_htf,
      tf_mtf,
      tf_ltf,
      mode_tag: modeTag,
    };
    if (best === null || sig.score > best.score) best = sig;
  }

  return best;
}

module.exports = {
  GRADES, MODE_CONSERVATIVE, MODE_AGGRESSIVE, LABELS, ALL_DIRS,
  volumeLabel, checkRetraceWithDepth, checkRetrace, computeModeTag,
  scoreBullish, scoreBearish, gradeOf, buildSmcSignal,
};
