'use strict';
/**
 * stops.js — the LEVELS stop-loss block of indicator._do_analyze, one-to-one (spec §10):
 *
 *   structuralStop        zone edge ∓ 1.5·ATR, distance measured from entry, clamped to
 *                         [0.5·ATR, entry·MAX_RISK_PCT/100]; SL-V2 regime multiplier path kept
 *                         (legacy distance used unless the env flag is on, exactly like the bot)
 *   adjustSlForMagnets    liquidity_sl_adjuster.adjust_sl_for_magnets (push beyond nearby
 *                         pivots inside a 0.5 % danger zone, +0.10 % buffer, cap 0.6 %, only widens)
 *   isMemcoin / isMajor   coin classes (substring match on the upper-cased symbol)
 *   checkStopValidity     sl on the wrong side / risk ≤ 0 / coin-class minimum stop
 *                         (major 0.4 %, memcoin 1.5 %, alt 0.8 %) / risk < 0.3·ATR → "sl_risk"
 *   computeStop           the whole block: stop → magnets → validity
 *
 * Pure. Every arithmetic expression keeps the bot's operand order (float64 identical).
 */

const { REJECT } = require('./config');
const { pyMax, pyMin } = require('../common/pyround');
const { pyUpper } = require('../common/pyUnicode');   // CPython 3.11 str case / whitespace methods

/** _MEMCOIN_KW (indicator.py) */
const MEMCOIN_KW = Object.freeze(['FLOKI', 'PEPE', 'SHIB', 'DOGE', 'WIF', 'BONK', 'NEIRO',
  'MEME', 'SATS', 'TURBO', 'CATS', 'ACT', 'BOME', 'BOOK']);

/** `any(k in symbol.upper() for k in _MEMCOIN_KW)` */
function isMemcoin(symbol) {
  const s = pyUpper(String(symbol));
  for (const k of MEMCOIN_KW) if (s.includes(k)) return true;
  return false;
}

/** `"BTC" in sym.upper() or "ETH" in sym.upper()` — substring (QUIRK(spec §10.4): ETHFI, BTCDOM … count). */
function isMajor(symbol) {
  const s = pyUpper(String(symbol));
  return s.includes('BTC') || s.includes('ETH');
}

/** Minimum stop in % of entry per coin class (spec §10.4 item 3). */
const MIN_STOP_PCT = Object.freeze({ major: 0.4, memcoin: 1.5, alt: 0.8 });

/**
 * The structural stop (spec §10.1 / §10.2). LONG:
 *   zone_bottom = s_level − zone_buf; raw_sl = zone_bottom − atr·1.5
 *   sl_dist = max(min(|entry − raw_sl|, entry·MAX_RISK_PCT/100), atr·0.5); sl = entry − sl_dist
 * SHORT mirrors. With `slV2Enabled` the MAX_RISK_PCT is multiplied by the regime multiplier
 * (`_new_sl_dist`), otherwise the legacy distance is used (shadow mode: computed, not used).
 * Returns { sl, slDist, rawSl, legacyDist, newDist, effectiveMaxRiskPct }.
 */
function structuralStop(signal, entry, sLevel, zoneBuf, atrNow, cfg, { regimeMult = 1.0, slV2Enabled = false } = {}) {
  const effectiveMaxRiskPct = cfg.MAX_RISK_PCT * regimeMult;
  let rawSl;
  if (signal === 'LONG') {
    const zoneBottom = sLevel - zoneBuf;
    rawSl = zoneBottom - atrNow * 1.5;
  } else {
    const zoneTop = sLevel + zoneBuf;
    rawSl = zoneTop + atrNow * 1.5;
  }
  const slDistFromEntry = Math.abs(entry - rawSl);
  const minSlDist = atrNow * 0.5;
  // Python max(min(a, b), c): first operand wins on ties / NaN (common/pyround.pyMax)
  const legacyDist = pyMax(pyMin(slDistFromEntry, entry * cfg.MAX_RISK_PCT / 100), minSlDist);
  const newDist = pyMax(pyMin(slDistFromEntry, entry * effectiveMaxRiskPct / 100), minSlDist);
  const slDist = slV2Enabled ? newDist : legacyDist;
  const sl = signal === 'LONG' ? entry - slDist : entry + slDist;
  return { sl, slDist, rawSl, legacyDist, newDist, effectiveMaxRiskPct };
}

/**
 * liquidity_sl_adjuster.adjust_sl_for_magnets(sl, direction, magnet_prices, *, danger_zone_pct=0.5,
 * extension_buf_pct=0.10, max_extension_pct=0.6) → [sl, info].
 * LONG: magnets p with sl·(1−0.005)·(1−1e-9) ≤ p ≤ sl·(1+1e-9); target = min; new = target·(1−0.001),
 * floored at sl·(1−0.006) (capped). SHORT mirrors with max / ceiling. Only ever widens.
 */
function adjustSlForMagnets(sl, direction, magnetPrices, { dangerZonePct = 0.5, extensionBufPct = 0.10, maxExtensionPct = 0.6 } = {}) {
  const info = { adjusted: false, reason: 'no_magnets', target: null, capped: false, n_in_zone: 0 };
  if (sl <= 0) { info.reason = 'invalid_sl'; return [sl, info]; }
  const prices = [];
  for (const p of (magnetPrices || [])) {
    const f = typeof p === 'number' ? p : Number(p);
    if (Number.isNaN(f) && !(typeof p === 'number')) { info.reason = 'invalid_magnets'; return [sl, info]; } // float(p) raised
    if (f > 0) prices.push(f);
  }
  if (!prices.length) return [sl, info];

  const EPS = 1e-9;
  if (direction === 'LONG') {
    const thresholdLo = sl * (1.0 - dangerZonePct / 100.0) * (1.0 - EPS);
    const hi = sl * (1.0 + EPS);
    const candidates = prices.filter((p) => thresholdLo <= p && p <= hi);
    info.n_in_zone = candidates.length;
    if (!candidates.length) { info.reason = 'no_candidates_in_zone'; return [sl, info]; }
    let target = candidates[0];
    for (let i = 1; i < candidates.length; i++) if (candidates[i] < target) target = candidates[i];
    let newSl = target * (1.0 - extensionBufPct / 100.0);
    const slFloor = sl * (1.0 - maxExtensionPct / 100.0);
    if (newSl < slFloor) { newSl = slFloor; info.capped = true; }
    info.adjusted = true; info.reason = 'magnet_in_zone_long'; info.target = target;
    return [newSl, info];
  }
  // SHORT
  const thresholdHi = sl * (1.0 + dangerZonePct / 100.0) * (1.0 + EPS);
  const lo = sl * (1.0 - EPS);
  const candidates = prices.filter((p) => lo <= p && p <= thresholdHi);
  info.n_in_zone = candidates.length;
  if (!candidates.length) { info.reason = 'no_candidates_in_zone'; return [sl, info]; }
  let target = candidates[0];
  for (let i = 1; i < candidates.length; i++) if (candidates[i] > target) target = candidates[i];
  let newSl = target * (1.0 + extensionBufPct / 100.0);
  const slCeil = sl * (1.0 + maxExtensionPct / 100.0);
  if (newSl > slCeil) { newSl = slCeil; info.capped = true; }
  info.adjusted = true; info.reason = 'magnet_in_zone_short'; info.target = target;
  return [newSl, info];
}

/**
 * Validity + minimum-stop filters (spec §10.4), each → { reject: "sl_risk", reason }:
 *   1. LONG sl ≥ entry / SHORT sl ≤ entry   2. risk = |entry − sl| ≤ 0
 *   3. coin class: major < 0.4 %, memcoin < 1.5 %, other < 0.8 % (risk/entry·100)
 *   4. atr > 0 and risk < 0.3·atr
 * Returns { reject: null, risk, riskPctRaw, memcoin, major } when valid.
 */
function checkStopValidity(symbol, signal, entry, sl, atrNow) {
  const memcoin = isMemcoin(symbol);
  const major = isMajor(symbol);
  const bad = (reason, extra) => ({ reject: REJECT.SL_RISK, reason, memcoin, major, ...(extra || {}) });
  if (signal === 'LONG' && sl >= entry) return bad('sl_above_entry');
  if (signal !== 'LONG' && sl <= entry) return bad('sl_below_entry');
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return bad('risk_zero', { risk });
  const riskPctRaw = risk / entry * 100;
  if (major && riskPctRaw < MIN_STOP_PCT.major) return bad('min_stop_major', { risk, riskPctRaw });
  if (memcoin && riskPctRaw < MIN_STOP_PCT.memcoin) return bad('min_stop_memcoin', { risk, riskPctRaw });
  if (!major && !memcoin && riskPctRaw < MIN_STOP_PCT.alt) return bad('min_stop_alt', { risk, riskPctRaw });
  // ATR-проверка: стоп должен быть хотя бы 0.3×ATR (базовый шум). QUIRK(spec §10.4): the
  // structural distance is already floored at 0.5·ATR and magnets only widen, so this gate
  // cannot fire on the normal path — kept for parity.
  if (atrNow > 0 && risk < atrNow * 0.3) return bad('min_stop_atr', { risk, riskPctRaw });
  return { reject: null, risk, riskPctRaw, memcoin, major };
}

/**
 * The whole stop block: structural stop → liquidity magnets (sup zones for LONG, res zones
 * for SHORT, prices > 0) → validity. `regime` is the cached BTC regime (null when unknown).
 * Returns { reject, reason, sl, risk, riskPctRaw, memcoin, major, slBeforeMagnets, magnetInfo, stop }.
 */
function computeStop(symbol, signal, entry, sLevel, zoneBuf, atrNow, cfg, supZones, resZones, { regimeMult = 1.0, slV2Enabled = false } = {}) {
  const stop = structuralStop(signal, entry, sLevel, zoneBuf, atrNow, cfg, { regimeMult, slV2Enabled });
  const zonesForMagnets = signal === 'LONG' ? supZones : resZones;
  const magnets = [];
  for (const z of zonesForMagnets) { const p = z.price === undefined ? 0 : z.price; if (p > 0) magnets.push(p); }
  const [sl, magnetInfo] = adjustSlForMagnets(stop.sl, signal, magnets);
  const v = checkStopValidity(symbol, signal, entry, sl, atrNow);
  return { ...v, sl, slBeforeMagnets: stop.sl, magnetInfo, stop };
}

module.exports = {
  MEMCOIN_KW, MIN_STOP_PCT, isMemcoin, isMajor,
  structuralStop, adjustSlForMagnets, checkStopValidity, computeStop,
};
