'use strict';
/**
 * targets.js — the LEVELS take-profit block of indicator._do_analyze, one-to-one (spec §11):
 *
 *   findTpLevels      `_find_tp_levels`: up to three opposite zones pulled 0.05 % toward entry
 *                     (candidates ≥ 0.2 % away), nearest first
 *   findTp1Level      `_find_tp1_level` (unused by the bot, kept for parity)
 *   tpScale           volatility scale by ATR %: > 3 % → 1.2, < 1 % → 0.85, else 1.0
 *   assembleTargets   structural TP or mechanical fallback (TP1 multiplier floored at MIN_RR),
 *                     ordering repair (unscaled TP2_RR, +1.5 R), strict order check → "rr"
 *   rrActual          sign·(tp1 − entry)/risk
 *   effectiveMinRr    momentum_detector.relax_min_rr: max(1.5, MIN_RR − 0.5) in relaxed mode
 *   calculateRrScore  `_calculate_rr_score`: 0.5·rr1 + 0.3·rr2 + 0.2·rr3
 *
 * Pure. Operand order of every expression is the bot's.
 */

const { REJECT } = require('./config');

/** FIX-WR-4: 0.05 % pull toward entry. */
const TP_MARGIN = 0.0005;

/**
 * `_find_tp_levels(direction, entry, sup_zones, res_zones)` → [tp1, tp2, tp3] (null when
 * missing). LONG: sorted(price·(1 − margin) for res zones with price > entry·1.002);
 * SHORT: sorted(price·(1 + margin) for sup zones with price < entry·0.998, reverse).
 */
function findTpLevels(direction, entry, supZones, resZones) {
  const cands = [];
  if (direction === 'LONG') {
    for (const z of resZones) if (z.price > entry * 1.002) cands.push(z.price * (1 - TP_MARGIN));
    cands.sort((a, b) => a - b);
  } else {
    for (const z of supZones) if (z.price < entry * 0.998) cands.push(z.price * (1 + TP_MARGIN));
    cands.sort((a, b) => b - a);
  }
  return [
    cands.length >= 1 ? cands[0] : null,
    cands.length >= 2 ? cands[1] : null,
    cands.length >= 3 ? cands[2] : null,
  ];
}

/** `_find_tp1_level`: nearest opposite zone price (no margin); unused by the bot. */
function findTp1Level(direction, entry, supZones, resZones) {
  let best = null;
  if (direction === 'LONG') {
    for (const z of resZones) if (z.price > entry * 1.002 && (best === null || z.price < best)) best = z.price;
  } else {
    for (const z of supZones) if (z.price < entry * 0.998 && (best === null || z.price > best)) best = z.price;
  }
  return best;
}

/** Dynamic TP scaling by ATR % of price (`_atr_pct = atr_now / c_now`, 0.02 when c_now ≤ 0). */
function tpScale(atrNow, cNow) {
  const atrPct = cNow > 0 ? atrNow / cNow : 0.02;
  if (atrPct > 0.03) return 1.2;      // >3% = высокая волатильность
  if (atrPct < 0.01) return 0.85;     // <1% = низкая волатильность
  return 1.0;
}

/**
 * TP assembly + ordering repair (spec §11.3). `stp` = [stp1, stp2, stp3] from findTpLevels.
 *   tp1 = stp1 ?? entry + sign·risk·max(TP1_RR·scale, MIN_RR)
 *   tp2 = stp2 ?? entry + sign·risk·TP2_RR·scale ;  tp3 = stp3 ?? entry + sign·risk·TP3_RR·scale
 *   LONG: tp1 ≥ tp2 → tp2 = entry + risk·TP2_RR (QUIRK(spec §25.4): unscaled); tp2 ≥ tp3 → tp3 = tp2 + risk·1.5;
 *         require entry < tp1 < tp2 < tp3 else "rr". SHORT mirrors.
 * Returns { reject, tp1, tp2, tp3, tp1MechRr, scale }.
 */
function assembleTargets(signal, entry, risk, stp, cfg, scale) {
  const sign = signal === 'LONG' ? 1 : -1;
  const [stp1, stp2, stp3] = stp;
  // [LEVELS-FIX 2026-10] пол = MIN_RR для механического TP1
  const tp1MechRr = Math.max(cfg.TP1_RR * scale, Number(cfg.MIN_RR));
  let tp1 = stp1 !== null && stp1 !== undefined ? stp1 : entry + sign * risk * tp1MechRr;
  let tp2 = stp2 !== null && stp2 !== undefined ? stp2 : entry + sign * risk * cfg.TP2_RR * scale;
  let tp3 = stp3 !== null && stp3 !== undefined ? stp3 : entry + sign * risk * cfg.TP3_RR * scale;

  // Исправление порядка TP (предотвращаем инверсию)
  if (signal === 'LONG') {
    if (tp1 >= tp2) tp2 = entry + risk * cfg.TP2_RR;
    if (tp2 >= tp3) tp3 = tp2 + risk * 1.5;
    if (!(entry < tp1 && tp1 < tp2 && tp2 < tp3)) return { reject: REJECT.RR, reason: 'tp_order', tp1, tp2, tp3, tp1MechRr, scale };
  } else {
    if (tp1 <= tp2) tp2 = entry - risk * cfg.TP2_RR;
    if (tp2 <= tp3) tp3 = tp2 - risk * 1.5;
    if (!(entry > tp1 && tp1 > tp2 && tp2 > tp3)) return { reject: REJECT.RR, reason: 'tp_order', tp1, tp2, tp3, tp1MechRr, scale };
  }
  return { reject: null, tp1, tp2, tp3, tp1MechRr, scale };
}

/** rr_actual = (tp1 − entry)/risk for LONG, (entry − tp1)/risk for SHORT. */
function rrActual(signal, entry, tp1, risk) {
  return signal === 'LONG' ? (tp1 - entry) / risk : (entry - tp1) / risk;
}

/** momentum_detector.relax_min_rr(original): max(1.5, original − 0.5) when relaxed mode is on. */
function effectiveMinRr(minRr, relaxed = false) {
  return relaxed ? Math.max(1.5, minRr - 0.5) : minRr;
}

/** `_calculate_rr_score(direction, entry, sl, tp1, tp2, tp3)`: risk ≤ 0 → 0.0. */
function calculateRrScore(direction, entry, sl, tp1, tp2, tp3) {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return 0.0;
  let rr1; let rr2; let rr3;
  if (direction === 'LONG') {
    rr1 = (tp1 - entry) / risk;
    rr2 = (tp2 - entry) / risk;
    rr3 = (tp3 - entry) / risk;
  } else {
    rr1 = (entry - tp1) / risk;
    rr2 = (entry - tp2) / risk;
    rr3 = (entry - tp3) / risk;
  }
  return rr1 * 0.5 + rr2 * 0.3 + rr3 * 0.2;
}

module.exports = {
  TP_MARGIN, findTpLevels, findTp1Level, tpScale, assembleTargets, rrActual, effectiveMinRr, calculateRrScore,
};
