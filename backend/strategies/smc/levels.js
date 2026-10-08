'use strict';
/**
 * levels.js — one-to-one port of `smc/signal_builder.calculate_levels(analysis,
 * direction, cfg)`: entry zone = OB, SL = OB extreme ± SL_BUFFER_PCT (legacy fixed
 * buffer, sl_v2 shadow mode — spec §5.4 step 2 / §11.20) pushed beyond equal-level
 * liquidity magnets, minimum stop by coin class, 1.0×ATR floor, TP1/TP2/TP3 from
 * FVG / swing / equal levels with the fallback ladder 1.2 / 2.5 / 4.0 R, and
 * `rr_structural` captured BEFORE the ladder validity check. Spec strategy-smc.md §5.4.
 *
 * Pure: `analysis` is the analyzer dict, `cfg` the builder SMCConfig object
 * (SL_BUFFER_PCT is the only field read here).
 */

const { pyRound } = require('../common/pyround');
const { pyTruthy, pyOr, pyGet, pyMax2, pyMin2, pyMinList, pyMaxList } = require('../common/pyval');
const { adjustSlForLiquidity } = require('../common/liquiditySl');

const MEMCOIN_KW = Object.freeze(['FLOKI', 'PEPE', 'SHIB', 'DOGE', 'WIF', 'BONK', 'NEIRO',
  'MEME', 'SATS', 'TURBO', 'CATS', 'ACT', 'BOME', 'BOOK']);

/** `any(k in symbol.upper() for k in _MEMCOIN_KW)` */
function isMemcoin(symbol) {
  const s = String(symbol === null || symbol === undefined ? '' : symbol).toUpperCase();
  return MEMCOIN_KW.some((k) => s.includes(k));
}

/** `"BTC" in sym or "ETH" in sym` (so e.g. ETHFI counts as a major). */
function isMajor(symbol) {
  const s = String(symbol === null || symbol === undefined ? '' : symbol).toUpperCase();
  return s.includes('BTC') || s.includes('ETH');
}

const MIN_TP1_RR = 1.0;   // _MIN_TP1_RR: TP1 at least 1.0R from entry_mid
const ATR_FLOOR_MULT = 1.0;   // [SL-WIDER 2026-05-10] risk must be ≥ 1.0×ATR

/**
 * calculate_levels(analysis, direction, cfg) → levels dict or null.
 * Keys: ladder_fallback, rr_structural (2 dp), entry_low, entry_high, entry_mid, sl,
 * tp1, tp2, tp3, rr (2 dp), risk_pct (3 dp). Returns null when the OB is missing,
 * the stop is degenerate / too tight for the coin class / below the ATR floor.
 */
function calculateLevels(analysis, direction, cfg) {
  const obKey = direction === 'LONG' ? 'bull_ob' : 'bear_ob';
  const ob = pyGet(pyGet(analysis, 'ob', {}), obKey, {});
  const fvg = pyGet(analysis, 'fvg', {});
  const liq = pyGet(analysis, 'liquidity', {});
  const s = pyGet(analysis, 'structure', {});

  if (!pyTruthy(pyGet(ob, 'found', undefined))) return null;

  const entryLow = ob.ob_low;
  const entryHigh = ob.ob_high;
  const entryMid = (entryLow + entryHigh) / 2;
  const baseBufPct = cfg.SL_BUFFER_PCT;

  // sl_v2 shadow mode (SL_V2_SMC_ENABLED off): the adaptive multiplier is only logged,
  // the legacy fixed buffer is used. QUIRK(spec §11.20)
  const buf = baseBufPct / 100;

  let sl = direction === 'LONG' ? entryLow * (1.0 - buf) : entryHigh * (1.0 + buf);

  // [SMC-LIQUIDITY-AWARE-SL] push the SL beyond equal-level clusters (pure widening)
  const liqForAdjust = pyOr(pyGet(analysis, 'liquidity', {}), {});
  const [slAdj, liqInfo] = adjustSlForLiquidity(sl, direction, liqForAdjust);
  sl = slAdj;

  const risk = Math.abs(entryMid - sl);
  if (risk <= 0) return null;

  // ── minimum stop by coin class (ATR + per-type floor) ──
  const symUp = String(pyGet(analysis, 'symbol', '')).toUpperCase();
  const memcoin = isMemcoin(symUp);
  const major = isMajor(symUp);

  const cp = pyOr(pyGet(analysis, 'current_price', 0.0), entryMid);
  const riskPctRaw = cp > 0 ? risk / cp * 100 : 0.0;

  if (major && riskPctRaw < 0.25) return null;
  if (memcoin && riskPctRaw < 0.8) return null;
  if (!major && !memcoin && riskPctRaw < 0.4) return null;

  const atr = pyGet(analysis, 'atr', 0.0);
  if (atr > 0 && risk < atr * ATR_FLOOR_MULT) return null;

  // ── TP1 = FVG edge fully beyond the entry zone, else 1.5R; floored at 1.0R ──
  const fvgObj = direction === 'LONG' ? pyGet(fvg, 'bull_fvg', undefined) : pyGet(fvg, 'bear_fvg', undefined);
  let tp1 = null;
  if (pyTruthy(fvgObj)) {
    if (direction === 'LONG') {
      tp1 = fvgObj.fvg_high > entryHigh ? fvgObj.fvg_high : null;   // FVG inside/below the zone → unusable
    } else {
      tp1 = fvgObj.fvg_low < entryLow ? fvgObj.fvg_low : null;
    }
  }
  if (tp1 === null) {
    tp1 = direction === 'LONG' ? entryMid + risk * 1.5 : entryMid - risk * 1.5;
  }
  if (direction === 'LONG') {
    tp1 = pyMax2(tp1, entryMid + risk * MIN_TP1_RR);
  } else {
    tp1 = pyMin2(tp1, entryMid - risk * MIN_TP1_RR);
  }

  // ── TP2 = last swing high/low beyond the zone, else 2R FROM THE ZONE EDGE ──
  // QUIRK(spec §11.7): the TP2 fallback is measured from entry_high / entry_low, while
  // TP1 / TP3 fallbacks and the full fallback ladder are measured from entry_mid.
  const sh = pyGet(s, 'last_swing_high', undefined);
  const slSw = pyGet(s, 'last_swing_low', undefined);
  let tp2;
  if (direction === 'LONG' && pyTruthy(sh) && sh.price > entryHigh) {
    tp2 = sh.price;
  } else if (direction === 'SHORT' && pyTruthy(slSw) && slSw.price < entryLow) {
    tp2 = slSw.price;
  } else {
    tp2 = direction === 'LONG' ? entryHigh + risk * 2.0 : entryLow - risk * 2.0;
  }

  // ── TP3 = next liquidity zone (nearest equal-level cluster beyond TP2), else 4R from the edge ──
  const eqHighs = pyGet(liq, 'equal_highs', []);
  const eqLows = pyGet(liq, 'equal_lows', []);
  let tp3 = null;
  if (direction === 'LONG' && pyTruthy(eqHighs)) {
    const cands = eqHighs.map((e) => e.price).filter((p) => p > tp2);
    tp3 = cands.length ? pyMinList(cands) : null;
  } else if (direction === 'SHORT' && pyTruthy(eqLows)) {
    const cands = eqLows.map((e) => e.price).filter((p) => p < tp2);
    tp3 = cands.length ? pyMaxList(cands) : null;
  }
  if (tp3 === null) {
    tp3 = direction === 'LONG' ? entryHigh + risk * 4.0 : entryLow - risk * 4.0;
  }

  // [SMC-LADDER] R to the structural TP2 remembered BEFORE the fallback, so the
  // 1.2/2.5/4.0R ladder cannot rescue a setup whose structure gives less than MIN_RR
  // (build_smc_signal checks rr_structural). QUIRK(spec §11.8): it may itself be the
  // 2R edge-fallback value.
  const rrStructural = risk > 0 ? Math.abs(tp2 - entryMid) / risk : 0.0;
  let valid;
  if (direction === 'LONG') {
    valid = (entryHigh < tp1 && tp1 < tp2 && tp2 < tp3)
      && (tp2 - tp1) >= risk * 0.3
      && (tp3 - tp2) >= risk * 0.3;
    if (!valid) {
      tp1 = entryMid + risk * 1.2;
      tp2 = entryMid + risk * 2.5;
      tp3 = entryMid + risk * 4.0;
    }
  } else {
    valid = (entryLow > tp1 && tp1 > tp2 && tp2 > tp3)
      && (tp1 - tp2) >= risk * 0.3
      && (tp2 - tp3) >= risk * 0.3;
    if (!valid) {
      tp1 = entryMid - risk * 1.2;
      tp2 = entryMid - risk * 2.5;
      tp3 = entryMid - risk * 4.0;
    }
  }
  const ladderFallback = !valid;

  const rr = risk > 0 ? Math.abs(tp2 - entryMid) / risk : 0.0;
  // the RR filter is applied once, in build_smc_signal, not here

  const riskPct = entryMid > 0 ? Math.abs(sl - entryMid) / entryMid * 100 : 0.0;
  return {
    ladder_fallback: ladderFallback,
    rr_structural: pyRound(rrStructural, 2),
    entry_low: entryLow,
    entry_high: entryHigh,
    entry_mid: entryMid,
    sl,
    tp1,
    tp2,
    tp3,
    rr: pyRound(rr, 2),
    risk_pct: pyRound(riskPct, 3),
    liq_info: liqInfo,   // diagnostic only (the bot logs it); not part of the signal
  };
}

module.exports = { MEMCOIN_KW, MIN_TP1_RR, ATR_FLOOR_MULT, isMemcoin, isMajor, calculateLevels };
