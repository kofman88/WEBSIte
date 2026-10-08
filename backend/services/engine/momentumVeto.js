/**
 * momentumVeto — the bot's momentum_veto.py one-to-one (signal-pipeline.md §5).
 *
 * Pre-emit guard against trading INTO a momentum spike: the signed close
 * velocity over the last `lookback` (3) bars of the 15m frame against
 * 0.8 × ATR(14)% plus a 1.5× volume spike (or a 1.2 × ATR extreme move
 * alone) in the anti-signal direction vetoes the signal. Used by LEVELS and
 * SMC, not by VOLUME. Env is read once per instance:
 * MOMENTUM_VETO_ENABLED / _ATR_MULT / _VOL_MULT / _LOOKBACK.
 *
 * Marker (logged by the callers): [MOMENTUM-VETO].
 */

'use strict';

const { fmtFixed } = require('../../strategies/common/pyfmt');

function envRaw(env, key) {
  const v = env[key];
  return v === undefined || v === null ? '' : String(v).trim();
}
/** float(os.environ.get(key, "").strip() or default), ValueError → default */
function envFloat(env, key, dflt) {
  const s = envRaw(env, key);
  if (!s) return dflt;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/i.test(s) && !/^[+-]?(inf|infinity|nan)$/i.test(s)) return dflt;
  const n = Number(s.toLowerCase().replace('infinity', 'Infinity').replace('inf', 'Infinity').replace('nan', 'NaN'));
  return Number.isNaN(n) && !/nan/i.test(s) ? dflt : n;
}
/** int(...) — "0.8" raises in Python → default */
function envInt(env, key, dflt) {
  const s = envRaw(env, key);
  if (!s) return dflt;
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : dflt;
}
function envBool(env, key, dflt) {
  const raw = envRaw(env, key).toLowerCase();
  if (!raw) return dflt;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/**
 * _compute_atr_pct(df, period=14): mean true range of the last `period` bars
 * (from the last period+1 rows) as % of the last close; 0 on insufficient data.
 */
function computeAtrPct(frame, period = 14) {
  try {
    if (!frame || frame.length < period + 2) return 0.0;
    const n = frame.length;
    const start = n - (period + 1);
    const trs = [];
    for (let i = start + 1; i < n; i++) {
      const tr = Math.max(
        frame.h[i] - frame.l[i],
        Math.abs(frame.h[i] - frame.c[i - 1]),
        Math.abs(frame.l[i] - frame.c[i - 1]),
      );
      trs.push(tr);
    }
    if (!trs.length) return 0.0;
    let sum = 0.0;
    for (const x of trs) sum += x;          // Python sum(): sequential
    const atr = sum / trs.length;
    const lastClose = frame.c[n - 1];
    if (lastClose <= 0) return 0.0;
    return (atr / lastClose) * 100.0;
  } catch (_e) {
    return 0.0;
  }
}

/** createMomentumVeto(env) — the module-level config of momentum_veto.py. */
function createMomentumVeto(env = process.env) {
  const ENABLED = envBool(env, 'MOMENTUM_VETO_ENABLED', true);
  const DEFAULT_ATR_MULT = envFloat(env, 'MOMENTUM_VETO_ATR_MULT', 0.8);
  const DEFAULT_VOL_MULT = envFloat(env, 'MOMENTUM_VETO_VOL_MULT', 1.5);
  const DEFAULT_LOOKBACK = envInt(env, 'MOMENTUM_VETO_LOOKBACK', 3);

  /**
   * is_momentum_veto(df, direction, velocity_atr_mult, volume_mult, lookback_candles, atr_period)
   * → [veto, reason]. `frame` = { h, l, c, v: Float64Array, length }.
   */
  function isMomentumVeto(frame, direction, opts = {}) {
    const velocityAtrMult = opts.velocityAtrMult === undefined ? DEFAULT_ATR_MULT : opts.velocityAtrMult;
    const volumeMult = opts.volumeMult === undefined ? DEFAULT_VOL_MULT : opts.volumeMult;
    const lookback = opts.lookbackCandles === undefined ? DEFAULT_LOOKBACK : opts.lookbackCandles;
    const atrPeriod = opts.atrPeriod === undefined ? 14 : opts.atrPeriod;

    if (!ENABLED) return [false, ''];
    if (direction !== 'LONG' && direction !== 'SHORT') return [false, 'invalid_direction'];
    if (frame === null || frame === undefined) return [false, 'no_data'];

    let n;
    try { n = frame.length; } catch (_e) { return [false, 'no_data']; }
    if (typeof n !== 'number') return [false, 'no_data'];

    const minRequired = lookback + atrPeriod + 2;
    if (n < minRequired) return [false, 'insufficient_data'];

    const closes = frame.c;
    const volumes = frame.v;
    if (!closes || !volumes) return [false, 'no_data'];

    try {
      const priceNow = Number(closes[n - 1]);
      const priceThen = Number(closes[n - 1 - lookback]);
      if (priceThen <= 0) return [false, 'invalid_price'];
      const velocityPct = (priceNow - priceThen) / priceThen * 100.0;   // signed

      const atrPct = computeAtrPct(frame, atrPeriod);
      if (atrPct <= 0) return [false, 'flat_market'];
      const thresholdPct = velocityAtrMult * atrPct;

      const baselineWindow = 20;
      const baselineStart = Math.max(0, n - lookback - baselineWindow);
      const baselineEnd = n - lookback;
      const recentLen = lookback;
      const baselineLen = baselineEnd - baselineStart;
      if (baselineLen < 5) return [false, 'insufficient_data'];
      let sumRecent = 0.0;
      for (let i = n - lookback; i < n; i++) sumRecent += Number(volumes[i]);
      let sumBase = 0.0;
      for (let i = baselineStart; i < baselineEnd; i++) sumBase += Number(volumes[i]);
      const avgRecent = sumRecent / recentLen;
      const avgBaseline = sumBase / baselineLen;
      if (avgBaseline <= 0) return [false, 'no_volume_baseline'];
      const volRatio = avgRecent / avgBaseline;

      const antiDirectionMove = (direction === 'LONG' && velocityPct < -thresholdPct)
        || (direction === 'SHORT' && velocityPct > thresholdPct);
      const volumeSpike = volRatio >= volumeMult;

      if (antiDirectionMove && volumeSpike) {
        const sign = velocityPct > 0 ? '+' : '';
        return [true, `velocity${sign}${fmtFixed(velocityPct, 2)}%/${fmtFixed(velocityAtrMult, 1)}atr(${fmtFixed(atrPct, 2)}%) vol=${fmtFixed(volRatio, 2)}x`];
      }
      if (antiDirectionMove && Math.abs(velocityPct) >= thresholdPct * 1.5) {
        const sign = velocityPct > 0 ? '+' : '';
        return [true, `velocity_extreme${sign}${fmtFixed(velocityPct, 2)}%/${fmtFixed(velocityAtrMult * 1.5, 1)}atr(${fmtFixed(atrPct, 2)}%)`];
      }
      return [false, ''];
    } catch (_e) {
      return [false, 'compute_error'];
    }
  }

  return {
    ENABLED, DEFAULT_ATR_MULT, DEFAULT_VOL_MULT, DEFAULT_LOOKBACK,
    isMomentumVeto, computeAtrPct,
    isEnabled: () => ENABLED,
  };
}

const defaultVeto = createMomentumVeto();

module.exports = {
  createMomentumVeto, computeAtrPct, defaultVeto,
  isMomentumVeto: (...a) => defaultVeto.isMomentumVeto(...a),
  isEnabled: () => defaultVeto.ENABLED,
};
