'use strict';
/**
 * analyzer.js — one-to-one port of `smc/analyzer.py` (SMCAnalyzer.analyze over the
 * three-timeframe map): Structure (HTF) → Liquidity (HTF) → Order Blocks (MTF) →
 * FVG/IFVG (LTF, or MTF when LTF is null) → ATR (MTF) → volume ratio (MTF) →
 * Premium/Discount (MTF close vs HTF swings). Spec strategy-smc.md §4.
 *
 * Pure: frames are {t, o, h, l, c, v} Float64Array structs (common/frame.js), the
 * config is a plain object from ./config.js. Any exception is captured in
 * `analysis.error` (the signal builder then returns null), exactly like the bot.
 *
 * The scanner injects `analysis.squeeze_score = int(compute_squeeze_score(df_mtf) or 0)`
 * after analyze() — see common/squeeze.js; it is not part of this function.
 */

const S = require('../common/series');
const { smcConfig } = require('./config');
const { getMarketStructure } = require('./structure');
const { findLiquiditySweeps } = require('./liquidity');
const { getOrderBlocks } = require('./orderBlock');
const { getFvgAnalysis } = require('./fvg');
const { getPremiumDiscount } = require('./premiumDiscount');

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/** Python `x or default` for numbers/None. */
function pyOr(x, dflt) {
  return (x === undefined || x === null || x === 0 || x === false || x === '' || x !== x) ? dflt : x;
}

/** pandas `df[col].iloc[-1]` on an empty frame raises IndexError (captured as analysis.error). */
function last(arr, n) {
  if (n === 0) throw new Error('single positional indexer is out-of-bounds');
  return arr[n - 1];
}

/**
 * SMCAnalyzer(config).analyze(symbol, df_htf, df_mtf, df_ltf=None) → analysis dict:
 * {symbol, structure, liquidity, ob, fvg, pd_zone, error, atr, current_price,
 *  current_high, current_low, volume_ok, vol_ratio, vol_last, vol_avg}.
 */
function analyze(symbol, dfHtf, dfMtf, dfLtf = null, cfg = smcConfig()) {
  const result = {
    symbol,
    structure: {},
    liquidity: {},
    ob: {},
    fvg: {},
    pd_zone: {},
    error: null,
    atr: 0.0,
    current_price: 0.0,
    current_high: 0.0,
    current_low: 0.0,
    volume_ok: false,
  };
  try {
    // ── Step 1: Market Structure (HTF) ──
    const structure = getMarketStructure(dfHtf, cfg.SWING_LOOKBACK, cfg.BOS_CONFIRMATION, cfg.CHOCH_ENABLED);
    result.structure = structure;

    // ── Step 2: Liquidity Sweeps (HTF) ──
    const liquidity = findLiquiditySweeps(
      dfHtf, structure.swing_highs || [], structure.swing_lows || [],
      cfg.EQUAL_THRESHOLD_PCT, cfg.SWEEP_CLOSE_REQUIRED, cfg.SWEEP_WICK_RATIO,
    );
    result.liquidity = liquidity;

    // ── Step 3: Order Blocks (MTF) ──
    const bosSafe = structure.bos || { detected: false, direction: '', price: 0.0 };
    result.ob = getOrderBlocks(dfMtf, bosSafe, cfg.OB_MIN_IMPULSE_PCT, cfg.OB_MAX_AGE_CANDLES, cfg.OB_MITIGATED_INVALID, cfg.OB_USE_BREAKER);

    // ── Step 4: FVG / IFVG (LTF, or MTF when LTF is None) ──
    const dfFvg = dfLtf !== null && dfLtf !== undefined ? dfLtf : dfMtf;
    if (cfg.FVG_ENABLED) {
      result.fvg = getFvgAnalysis(dfFvg, cfg.FVG_MIN_GAP_PCT, cfg.FVG_INVERSED, cfg.FVG_PARTIAL_INVALID);
    } else {
      result.fvg = { bull_fvg: null, bear_fvg: null, bull_found: false, bear_found: false };
    }

    // ── ATR (MTF): ewm(span=14, adjust=False) of the true range ──
    try {
      const atr = S.atrEmaSpan(dfMtf.h, dfMtf.l, dfMtf.c, 14);
      result.atr = atr.length > 0 ? atr[atr.length - 1] : 0.0;
    } catch {
      result.atr = 0.0;
    }

    // ── FIX-B9: volume ratio (MTF) = last closed bar / mean of the VOL_LEN bars before it ──
    result.vol_ratio = 0.0;
    result.vol_last = 0.0;
    result.vol_avg = 0.0;
    try {
      const volLen = Math.max(5, Math.trunc(Number(pyOr(cfg.VOL_LEN === undefined ? 20 : cfg.VOL_LEN, 20))));
      const n = nBars(dfMtf);
      if (dfMtf.v && n >= volLen + 2) {
        const volAvg = S.seriesMean(dfMtf.v.subarray(n - (volLen + 1), n - 1));   // iloc[-(L+1):-1].mean()
        const volLast = dfMtf.v[n - 1];
        const ratio = volAvg > 0 ? volLast / volAvg : 0.0;
        result.vol_avg = volAvg;
        result.vol_last = volLast;
        result.vol_ratio = ratio;
        // legacy field: volume_ok against the analyzer's own VOL_MULT (class default 1.2)
        const volMultDefault = Number(pyOr(cfg.VOL_MULT === undefined ? 1.2 : cfg.VOL_MULT, 1.2));
        result.volume_ok = ratio >= volMultDefault;
      }
    } catch {
      result.volume_ok = false;
    }

    // ── Step 5: Premium / Discount ──
    const lastSh = structure.last_swing_high;
    const lastSl = structure.last_swing_low;
    let pdZone;
    const n = nBars(dfMtf);
    if (lastSh && lastSl && cfg.PD_ENABLED) {
      const currentPrice = last(dfMtf.c, n);
      result.current_price = currentPrice;
      result.current_high = last(dfMtf.h, n);
      result.current_low = last(dfMtf.l, n);
      pdZone = getPremiumDiscount(lastSh.price, lastSl.price, currentPrice, cfg.PD_BUFFER_PCT);
    } else {
      // QUIRK(spec §4.7): the else-branch requires ≥ 2 bars for the current price/high/low
      result.current_price = n >= 2 ? dfMtf.c[n - 1] : 0.0;
      result.current_high = n >= 2 ? dfMtf.h[n - 1] : 0.0;
      result.current_low = n >= 2 ? dfMtf.l[n - 1] : 0.0;
      pdZone = { zone: 'NEUTRAL', position_pct: 50.0 };
    }
    result.pd_zone = pdZone;
  } catch (e) {
    result.error = e && e.message !== undefined ? String(e.message) : String(e);
  }
  return result;
}

/** Class form of the bot (`SMCAnalyzer(SMCConfig(...)).analyze(...)`). */
class SMCAnalyzer {
  constructor(config = null) {
    this.cfg = config || smcConfig();
  }

  analyze(symbol, dfHtf, dfMtf, dfLtf = null) {
    return analyze(symbol, dfHtf, dfMtf, dfLtf, this.cfg);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Digest — the per-bar record of expected/smc_analysis.json (make_golden._smc_digest)
// ─────────────────────────────────────────────────────────────────────────────

function isEmptyish(x) {
  return x === null || x === undefined || (typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0);
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) r[k] = o[k] === undefined ? null : o[k];
  return r;
}

/**
 * make_golden._smc_digest(analysis) without the r10 rounding: trend, bos, choch,
 * swing counts, last swing prices, equal-level prices, sweeps, both OBs (with the
 * impulse FVG), FVG counts, nearest FVGs, pd_zone, atr, vol_ratio, vol_avg,
 * current price/high/low, squeeze_score, error.
 */
function smcDigest(a) {
  const s = a.structure || {}, liq = a.liquidity || {}, ob = a.ob || {}, fvg = a.fvg || {};
  const obDigest = (o) => {
    if (isEmptyish(o)) return null;
    const d = pick(o, ['found', 'ob_low', 'ob_high', 'ob_mid', 'ob_50_reached', 'type', 'mitigated', 'bar_ago', 'is_breaker']);
    d.impulse_fvg = isEmptyish(o.impulse_fvg) ? null : pick(o.impulse_fvg, ['fvg_low', 'fvg_high', 'idx']);
    return d;
  };
  const fvgDigest = (f) => (isEmptyish(f) ? null : pick(f, ['type', 'fvg_low', 'fvg_high', 'idx', 'inversed']));
  const swDigest = (x) => (isEmptyish(x) ? null : pick(x, ['swept', 'level', 'wick_ratio']));
  const priceOf = (sw) => (sw && sw.price !== undefined ? sw.price : null);
  const nz = (v) => (v === undefined ? null : v);
  return {
    trend: nz(s.trend),
    bos: nz(s.bos),
    choch: nz(s.choch),
    n_swing_highs: (s.swing_highs || []).length,
    n_swing_lows: (s.swing_lows || []).length,
    last_swing_high: priceOf(s.last_swing_high),
    last_swing_low: priceOf(s.last_swing_low),
    equal_highs: (liq.equal_highs || []).map((e) => e.price),
    equal_lows: (liq.equal_lows || []).map((e) => e.price),
    sweep_up: swDigest(liq.sweep_up),
    sweep_down: swDigest(liq.sweep_down),
    bull_ob: obDigest(ob.bull_ob),
    bear_ob: obDigest(ob.bear_ob),
    n_fvgs: (fvg.all_fvgs || []).length,
    n_ifvgs: (fvg.ifvgs || []).length,
    bull_fvg: fvgDigest(fvg.bull_fvg),
    bear_fvg: fvgDigest(fvg.bear_fvg),
    pd_zone: nz(a.pd_zone),
    atr: nz(a.atr),
    vol_ratio: nz(a.vol_ratio),
    vol_avg: nz(a.vol_avg),
    current_price: nz(a.current_price),
    current_high: nz(a.current_high),
    current_low: nz(a.current_low),
    squeeze_score: nz(a.squeeze_score),
    error: nz(a.error),
  };
}

module.exports = { analyze, SMCAnalyzer, smcDigest };
