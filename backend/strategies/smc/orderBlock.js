'use strict';
/**
 * orderBlock.js — one-to-one port of `smc/order_block.py`: order blocks, impulse
 * FVG, mitigation / 50 % retrace on the last CLOSED bar, breaker blocks and the
 * breaker slot swap (spec strategy-smc.md §4.3).
 */

const { pyRound } = require('../common/pyround');

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/** `_EMPTY_OB` of the Python module (fresh copy). */
function emptyOb() {
  return {
    found: false,
    ob_low: 0.0,
    ob_high: 0.0,
    ob_mid: 0.0,
    ob_50_reached: false,
    impulse_fvg: null,
    type: '',
    mitigated: false,
    bar_ago: 0,
    is_breaker: false,
  };
}

/** pandas `df[col].iloc[-1]` on an empty frame raises IndexError (captured as analysis.error). */
function requireLast(frame) {
  if (nBars(frame) === 0) throw new Error('single positional indexer is out-of-bounds');
}

/**
 * _find_impulse_start(df, bos_price, direction, lookback): first i from n−1 down
 * to start+1 (start = max(0, n − lookback)) with two consecutive closes on the
 * "before" side of bos_price. null when none.
 */
function findImpulseStart(frame, bosPrice, direction, lookback = 50) {
  const closes = frame.c;
  const n = closes.length;
  const start = Math.max(0, n - lookback);
  if (direction === 'BULLISH') {
    for (let i = n - 1; i > start; i--) {
      if (closes[i] < bosPrice && closes[i - 1] < bosPrice) return i;
    }
  } else {
    for (let i = n - 1; i > start; i--) {
      if (closes[i] > bosPrice && closes[i - 1] > bosPrice) return i;
    }
  }
  return null;
}

/**
 * _find_impulse_fvg(df, ob_idx, direction): gap between the OB candle and the
 * third impulse candle (no min-gap threshold). gap_pct = round(., 3).
 */
function findImpulseFvg(frame, obIdx, direction) {
  const n = nBars(frame);
  const i2 = obIdx + 2;
  if (i2 >= n) return null;
  const highs = frame.h, lows = frame.l;
  if (direction === 'BULLISH') {
    const gapLow = highs[obIdx];
    const gapHigh = lows[i2];
    if (gapHigh > gapLow) {
      const gapPct = (gapHigh - gapLow) / gapLow * 100;
      return { type: 'bullish', fvg_low: gapLow, fvg_high: gapHigh, gap_pct: pyRound(gapPct, 3), idx: i2, bar_ago: n - 1 - i2 };
    }
  } else {
    const gapHigh = lows[obIdx];
    const gapLow = highs[i2];
    if (gapHigh > gapLow) {
      const gapPct = (gapHigh - gapLow) / gapHigh * 100;
      return { type: 'bearish', fvg_low: gapLow, fvg_high: gapHigh, gap_pct: pyRound(gapPct, 3), idx: i2, bar_ago: n - 1 - i2 };
    }
  }
  return null;
}

/**
 * find_bullish_ob: the last bearish candle (close < open) before the impulse start
 * whose move to the last close is positive and ≥ min_impulse_pct %. First match wins.
 */
function findBullishOb(frame, bosPrice, minImpulsePct = 0.3, maxAgeCandles = 50) {
  const result = emptyOb();
  result.type = 'bullish';
  const closes = frame.c, highs = frame.h, lows = frame.l, opens = frame.o;
  const n = nBars(frame);

  const impulseStart = findImpulseStart(frame, bosPrice, 'BULLISH', maxAgeCandles);
  if (impulseStart === null) return result;

  for (let i = impulseStart; i > Math.max(0, impulseStart - maxAgeCandles); i--) {
    if (closes[i] < opens[i]) {
      const impulseMove = closes[n - 1] - closes[i];
      if (impulseMove <= 0) continue;
      const impulsePct = impulseMove / closes[i] * 100;
      if (impulsePct >= minImpulsePct) {
        const obLow = lows[i], obHigh = highs[i];
        Object.assign(result, {
          found: true,
          ob_low: obLow,
          ob_high: obHigh,
          ob_mid: (obLow + obHigh) / 2,
          impulse_fvg: findImpulseFvg(frame, i, 'BULLISH'),
          bar_ago: n - 1 - i,
        });
        return result;
      }
    }
  }
  return result;
}

/** find_bearish_ob: the last bullish candle before a bearish impulse (mirror of the above). */
function findBearishOb(frame, bosPrice, minImpulsePct = 0.3, maxAgeCandles = 50) {
  const result = emptyOb();
  result.type = 'bearish';
  const closes = frame.c, highs = frame.h, lows = frame.l, opens = frame.o;
  const n = nBars(frame);

  const impulseStart = findImpulseStart(frame, bosPrice, 'BEARISH', maxAgeCandles);
  if (impulseStart === null) return result;

  for (let i = impulseStart; i > Math.max(0, impulseStart - maxAgeCandles); i--) {
    if (closes[i] > opens[i]) {
      const impulseMove = closes[i] - closes[n - 1];
      if (impulseMove <= 0) continue;
      const impulsePct = impulseMove / closes[i] * 100;
      if (impulsePct >= minImpulsePct) {
        const obLow = lows[i], obHigh = highs[i];
        Object.assign(result, {
          found: true,
          ob_low: obLow,
          ob_high: obHigh,
          ob_mid: (obLow + obHigh) / 2,
          impulse_fvg: findImpulseFvg(frame, i, 'BEARISH'),
          bar_ago: n - 1 - i,
        });
        return result;
      }
    }
  }
  return result;
}

/** check_ob_mitigation: the last closed bar overlaps [ob_low, ob_high] (both type branches are the same predicate). */
function checkObMitigation(frame, ob) {
  if (!ob.found) return false;
  const lo = ob.ob_low, hi = ob.ob_high;
  requireLast(frame);
  const n = nBars(frame);
  const cLow = frame.l[n - 1], cHigh = frame.h[n - 1];
  if (ob.type === 'bullish' || ob.type === 'bullish_breaker') {
    return cLow <= hi && cHigh >= lo;
  }
  return cHigh >= lo && cLow <= hi;
}

/** check_ob_50_retrace: the last bar's wick reached ob_mid (low ≤ mid for bullish types, high ≥ mid otherwise). */
function checkOb50Retrace(frame, ob) {
  if (!ob.found) return false;
  const obMid = ob.ob_mid !== undefined ? ob.ob_mid : (ob.ob_low + ob.ob_high) / 2;
  if (obMid <= 0) return false;
  requireLast(frame);
  const n = nBars(frame);
  const cLow = frame.l[n - 1], cHigh = frame.h[n - 1];
  const obType = ob.type === undefined ? '' : ob.type;
  if (obType === 'bullish' || obType === 'bullish_breaker') return cLow <= obMid;
  return cHigh >= obMid;
}

/**
 * find_breaker_block(df, ob, trend): copy of the OB; a bullish OB closed through
 * below ob_low by ANY bar after its formation becomes a `bearish_breaker`, a
 * bearish OB closed above ob_high a `bullish_breaker`; mitigated / ob_50_reached
 * are then recomputed with the NEW type. `found` is whatever the copy had.
 */
function findBreakerBlock(frame, ob /* , trend */) {
  const result = { ...ob };
  result.is_breaker = false;
  if (!ob.found) return result;
  const lo = ob.ob_low, hi = ob.ob_high;
  // int(ob.get("bar_ago", 0) or 0)
  const rawBars = ob.bar_ago === undefined || ob.bar_ago === null ? 0 : ob.bar_ago;
  const barsAfter = Math.trunc(Number(rawBars || 0));
  const closes = frame.c;
  const n = closes.length;
  // df["close"].iloc[-bars_after:] (bars strictly after the OB bar), empty when bar_ago == 0
  const from = barsAfter > 0 ? Math.max(0, n - barsAfter) : n;
  if (ob.type === 'bullish') {
    let any = false;
    for (let j = from; j < n; j++) if (closes[j] < lo) { any = true; break; }
    if (any) { result.is_breaker = true; result.type = 'bearish_breaker'; }
  } else if (ob.type === 'bearish') {
    let any = false;
    for (let j = from; j < n; j++) if (closes[j] > hi) { any = true; break; }
    if (any) { result.is_breaker = true; result.type = 'bullish_breaker'; }
  }
  if (result.is_breaker) {
    result.mitigated = checkObMitigation(frame, result);
    result.ob_50_reached = checkOb50Retrace(frame, result);
  }
  return result;
}

/**
 * get_order_blocks(df, bos, min_impulse_pct, max_age_candles, mitigated_invalid, use_breaker_blocks)
 * → {bull_ob, bear_ob}. Order of operations is load-bearing (spec §4.3 steps 1–9):
 * reference price → OBs → mitigation → 50 % retrace → breaker copies (BEFORE
 * invalidation) → invalidation → slot swap.
 */
function getOrderBlocks(frame, bos, minImpulsePct = 0.3, maxAgeCandles = 50, mitigatedInvalid = true, useBreakerBlocks = true) {
  let bullOb, bearOb;
  if (bos.detected) {
    // QUIRK(spec §4.3 step 1): the same bos.price is the reference for BOTH directions
    bullOb = findBullishOb(frame, bos.price, minImpulsePct, maxAgeCandles);
    bearOb = findBearishOb(frame, bos.price, minImpulsePct, maxAgeCandles);
  } else {
    requireLast(frame);
    const n = nBars(frame);
    const lastHigh = frame.h[n - 1];
    const lastLow = frame.l[n - 1];
    bullOb = findBullishOb(frame, lastHigh, minImpulsePct, maxAgeCandles);
    bearOb = findBearishOb(frame, lastLow, minImpulsePct, maxAgeCandles);
  }

  bullOb.mitigated = checkObMitigation(frame, bullOb);
  bearOb.mitigated = checkObMitigation(frame, bearOb);

  bullOb.ob_50_reached = checkOb50Retrace(frame, bullOb);
  bearOb.ob_50_reached = checkOb50Retrace(frame, bearOb);

  // [SMC-BREAKER] breaker copies are taken BEFORE invalidation (keep found=True)
  const bullBrk = useBreakerBlocks ? findBreakerBlock(frame, bullOb, 'BULLISH') : null;
  const bearBrk = useBreakerBlocks ? findBreakerBlock(frame, bearOb, 'BEARISH') : null;

  if (mitigatedInvalid) {
    requireLast(frame);
    const cNow = frame.c[nBars(frame) - 1];
    if (bullOb.found && cNow < bullOb.ob_low) bullOb.found = false;
    if (bearOb.found && cNow > bearOb.ob_high) bearOb.found = false;
  }

  // QUIRK(spec §4.3 step 9): slot swap in this exact order — a real OB in the target
  // slot wins over a breaker; when both OBs became breakers the bull slot ends up
  // with the bullish_breaker (found=True) and the bear slot with the bearish_breaker
  // marked found=False.
  if (bullBrk !== null && bullBrk.is_breaker) {
    bullOb = { ...bullOb, found: false };
    if (!bearOb.found) bearOb = bullBrk;
  }
  if (bearBrk !== null && bearBrk.is_breaker) {
    bearOb = { ...bearOb, found: false };
    if (!bullOb.found) bullOb = bearBrk;
  }

  return { bull_ob: bullOb, bear_ob: bearOb };
}

module.exports = {
  emptyOb, findImpulseStart, findImpulseFvg, findBullishOb, findBearishOb,
  checkObMitigation, checkOb50Retrace, findBreakerBlock, getOrderBlocks,
};
