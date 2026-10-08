'use strict';
/**
 * filters.js — levels_filters.py (the [LEVELS-FILTERS] entry gates, spec §17), pure and
 * fail-open like the bot:
 *
 *   regimeTriggersSkip(df, tf)                   market_regime.detect_regime(df, tf) ∈ {trending_up, trending_down}
 *   volTriggersSkip(atrNow, price, maxAtrPct)    atr/price·100 > cap
 *   confirmTriggersSkip(df, direction, level)    last closed bar must confirm the bounce
 *   evaluate(df, direction, level, entry, atrNow, { regimeMode, volMode, volMaxAtrPct, confirmMode, tf })
 *     → [enforceReason | null, shadowReasons[]]  (checks in order regime, vol, confirm; "off" not evaluated)
 *   gatesActive(env)                             the `_lf_r != "off" or …` pre-check of _do_analyze
 *
 * Modes: "off" | "shadow" | "enforce" (config.Config LEVELS_REGIME_GATE / LEVELS_VOL_GATE /
 * LEVELS_ENTRY_CONFIRM; production defaults enforce / off / off).
 */

const { detectRegime } = require('../common/marketRegime');

const MODES = Object.freeze(['off', 'shadow', 'enforce']);

/** True when the regime is trending (mean reversion disfavoured); errors → false. */
function regimeTriggersSkip(df, tf = null) {
  try {
    const regime = detectRegime(df, { tf });
    return regime === 'trending_up' || regime === 'trending_down';
  } catch (_e) {
    return false;
  }
}

/** True when ATR as a % of price exceeds the cap; non-positive inputs → false. */
function volTriggersSkip(atrNow, price, maxAtrPct) {
  try {
    const a = Number(atrNow);
    const p = Number(price);
    const m = Number(maxAtrPct);
    if (Number.isNaN(a) || Number.isNaN(p) || Number.isNaN(m)) return false;
    if (p <= 0 || a <= 0 || m <= 0) return false;
    return (a / p * 100.0) > m;
  } catch (_e) {
    return false;
  }
}

/**
 * True when the last CLOSED bar does NOT confirm the bounce:
 *   LONG  confirmed = low ≤ level and close > level;  SHORT confirmed = high ≥ level and close < level.
 * Fewer than 3 bars, level ≤ 0 or an unknown direction → false (fail-open).
 */
function confirmTriggersSkip(df, direction, level) {
  try {
    if (!df || df.length < 3 || Number(level) <= 0) return false;
    const n = df.length;
    const low = df.l[n - 1];
    const high = df.h[n - 1];
    const close = df.c[n - 1];
    let confirmed;
    if (direction === 'LONG') confirmed = low <= level && close > level;
    else if (direction === 'SHORT') confirmed = high >= level && close < level;
    else return false;
    return !confirmed;
  } catch (_e) {
    return false;
  }
}

/**
 * levels_filters.evaluate → [enforce_skip_reason, shadow_reasons]. A filter whose mode is
 * neither "shadow" nor "enforce" is not evaluated; a throwing check counts as not triggered.
 */
function evaluate(df, direction, level, entry, atrNow, {
  regimeMode = 'off', volMode = 'off', volMaxAtrPct = 2.5, confirmMode = 'off', tf = null,
} = {}) {
  const checks = [
    ['regime', regimeMode, () => regimeTriggersSkip(df, tf)],
    ['vol', volMode, () => volTriggersSkip(atrNow, entry, volMaxAtrPct)],
    ['confirm', confirmMode, () => confirmTriggersSkip(df, direction, level)],
  ];
  let enforceReason = null;
  const shadow = [];
  for (const [name, mode, fn] of checks) {
    if (mode !== 'shadow' && mode !== 'enforce') continue;
    let triggered;
    try { triggered = Boolean(fn()); } catch (_e) { triggered = false; }
    if (!triggered) continue;
    if (mode === 'enforce') { if (enforceReason === null) enforceReason = name; }
    else shadow.push(name);
  }
  return [enforceReason, shadow];
}

/** `_lf_r != "off" or _lf_v != "off" or _lf_c != "off"` of _do_analyze. */
function gatesActive(env) {
  const r = env.LEVELS_REGIME_GATE === undefined ? 'off' : env.LEVELS_REGIME_GATE;
  const v = env.LEVELS_VOL_GATE === undefined ? 'off' : env.LEVELS_VOL_GATE;
  const c = env.LEVELS_ENTRY_CONFIRM === undefined ? 'off' : env.LEVELS_ENTRY_CONFIRM;
  return r !== 'off' || v !== 'off' || c !== 'off';
}

module.exports = { MODES, regimeTriggersSkip, volTriggersSkip, confirmTriggersSkip, evaluate, gatesActive };
