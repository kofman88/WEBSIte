'use strict';
/**
 * tpLadderFit.js — one-to-one port of `tp_ladder_fit.py` ([TP-LADDER-FIT]).
 *
 * Adaptive partial-TP split that respects the per-order MIN_NOTIONAL ($5 on all four
 * exchanges unless overridden). Greedy fallback chain:
 *   Try 1  desired pcts (tp1/tp2, remainder → main TP); all chunks must pass
 *   Try 2  60 % / 40 %                       reason "tp3_too_small_redistributed_60_40"
 *   Try 3  100 % on TP1                      reason "tp2_tp3_too_small_single_tp"
 *   Try 4  nothing fits → main TP takes all  reason "position_below_min_notional"
 * `_check(q) = q >= qty_step and q × price × pmult >= min_notional`;
 * `_round_down_to_step(q) = float(int(q / step) * step)`.
 * Returns the bot's dict shape (snake_case keys kept verbatim).
 */

const { pyMax } = require('../../strategies/common/pyround');
const { pyLower } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const EXCHANGE_MIN_NOTIONAL = Object.freeze({ bybit: 5.0, bingx: 5.0, binance: 5.0, okx: 5.0 });

function getMinNotional(exchange) {
  const k = pyLower(String(exchange || ''));
  return Object.prototype.hasOwnProperty.call(EXCHANGE_MIN_NOTIONAL, k) ? EXCHANGE_MIN_NOTIONAL[k] : 5.0;
}

function roundDownToStep(qty, qtyStep) {
  if (qtyStep <= 0) return Number(qty);
  const t = Math.trunc(qty / qtyStep); // int() truncates toward zero
  return Number(t * qtyStep);
}

/**
 * @param {object} p  { total_qty|totalQty, price, qty_step|qtyStep, pmult=1, exchange='bybit',
 *                      min_notional_override=0, desired_tp1_pct=40, desired_tp2_pct=30 }
 */
function fitPartialSplit(p) {
  const totalQty = Number(p.total_qty ?? p.totalQty);
  const price = Number(p.price);
  const qtyStep = Number(p.qty_step ?? p.qtyStep);
  const pmult = p.pmult === undefined ? 1.0 : p.pmult;
  const exchange = p.exchange === undefined ? 'bybit' : p.exchange;
  const override = Number(p.min_notional_override ?? p.minNotionalOverride ?? 0.0);
  const d1 = Number(p.desired_tp1_pct ?? p.desiredTp1Pct ?? 40.0);
  const d2 = Number(p.desired_tp2_pct ?? p.desiredTp2Pct ?? 30.0);

  const minNotional = override > 0 ? override : getMinNotional(exchange);
  const effPrice = (pmult && pmult !== 1.0) ? price * Number(pmult) : price;

  if (totalQty <= 0 || effPrice <= 0) {
    return {
      tp1_qty: 0.0, tp2_qty: 0.0, tp1_pct: 0.0, tp2_pct: 0.0,
      main_tp_qty: totalQty, downgrade_reason: 'invalid_input',
      min_notional: minNotional, n_levels_fit: 0,
    };
  }
  const check = (q) => q >= qtyStep && (q * effPrice) >= minNotional;

  // Try 1
  const desiredMainPct = pyMax(0.0, 100.0 - d1 - d2);
  const q1 = roundDownToStep(totalQty * d1 / 100.0, qtyStep);
  const q2 = roundDownToStep(totalQty * d2 / 100.0, qtyStep);
  const qMain = desiredMainPct > 0 ? roundDownToStep(totalQty * desiredMainPct / 100.0, qtyStep) : 0.0;
  const fitMain = (desiredMainPct === 0) || check(qMain);
  if (check(q1) && check(q2) && fitMain) {
    const actualMain = pyMax(0.0, totalQty - q1 - q2);
    return {
      tp1_qty: q1, tp2_qty: q2, tp1_pct: d1, tp2_pct: d2,
      main_tp_qty: actualMain, downgrade_reason: '',
      min_notional: minNotional,
      n_levels_fit: (desiredMainPct > 0 && check(actualMain)) ? 3 : 2,
    };
  }
  // Try 2: 60/40
  const q160 = roundDownToStep(totalQty * 0.60, qtyStep);
  const q240 = roundDownToStep(totalQty * 0.40, qtyStep);
  if (check(q160) && check(q240)) {
    return {
      tp1_qty: q160, tp2_qty: q240, tp1_pct: 60.0, tp2_pct: 40.0,
      main_tp_qty: pyMax(0.0, totalQty - q160 - q240),
      downgrade_reason: 'tp3_too_small_redistributed_60_40',
      min_notional: minNotional, n_levels_fit: 2,
    };
  }
  // Try 3: single TP
  const qFull = roundDownToStep(totalQty, qtyStep);
  if (check(qFull)) {
    return {
      tp1_qty: qFull, tp2_qty: 0.0, tp1_pct: 100.0, tp2_pct: 0.0,
      main_tp_qty: pyMax(0.0, totalQty - qFull),
      downgrade_reason: 'tp2_tp3_too_small_single_tp',
      min_notional: minNotional, n_levels_fit: 1,
    };
  }
  // Try 4
  return {
    tp1_qty: 0.0, tp2_qty: 0.0, tp1_pct: 0.0, tp2_pct: 0.0,
    main_tp_qty: totalQty, downgrade_reason: 'position_below_min_notional',
    min_notional: minNotional, n_levels_fit: 0,
  };
}

module.exports = { EXCHANGE_MIN_NOTIONAL, getMinNotional, fitPartialSplit, _roundDownToStep: roundDownToStep };
