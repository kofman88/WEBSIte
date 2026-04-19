/**
 * SMC — Order Blocks + Breaker Blocks + impulse FVG.
 *
 * OB = last opposite-colored candle before a BOS-impulse.
 *   - ob_mid = midpoint of the OB candle (50% entry trigger)
 *   - impulse_fvg = FVG between 1st and 3rd candle of the impulse
 *   - mitigated = price has re-entered the OB zone
 *   - breaker = mitigated OB with price now on opposite side (role flip)
 *
 * Ported from bot/CHM_BREAKER_V4/smc/order_block.py
 */

const EMPTY_OB = Object.freeze({
  found: false, obLow: 0, obHigh: 0, obMid: 0, obFiftyReached: false,
  impulseFvg: null, type: '', mitigated: false, barAgo: 0, isBreaker: false,
});

function findImpulseStart(candles, bosPrice, direction, lookback = 50) {
  const closes = candles.map((c) => c[4]);
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

function findImpulseFvg(candles, obIdx, direction) {
  const i2 = obIdx + 2;
  if (i2 >= candles.length) return null;
  const [, , hi0, lo0] = candles[obIdx];
  const [, , hi2, lo2] = candles[i2];
  if (direction === 'BULLISH') {
    const gapLow = hi0;
    const gapHigh = lo2;
    if (gapHigh > gapLow) {
      return {
        type: 'bullish',
        fvgLow: gapLow, fvgHigh: gapHigh,
        gapPct: ((gapHigh - gapLow) / gapLow) * 100,
        idx: i2, barAgo: candles.length - 1 - i2,
      };
    }
  } else {
    const gapHigh = lo0;
    const gapLow = hi2;
    if (gapHigh > gapLow && gapHigh > 0) {
      return {
        type: 'bearish',
        fvgLow: gapLow, fvgHigh: gapHigh,
        gapPct: ((gapHigh - gapLow) / gapHigh) * 100,
        idx: i2, barAgo: candles.length - 1 - i2,
      };
    }
  }
  return null;
}

function findBullishOb(candles, bosPrice, { minImpulsePct = 0.15, maxAgeCandles = 60 } = {}) {
  const result = { ...EMPTY_OB, type: 'bullish' };
  const impulseStart = findImpulseStart(candles, bosPrice, 'BULLISH', maxAgeCandles);
  if (impulseStart === null) return result;

  const n = candles.length;
  const lastClose = candles[n - 1][4];

  for (let i = impulseStart; i > Math.max(0, impulseStart - maxAgeCandles); i--) {
    const [, o, h, l, c] = candles[i];
    if (c < o) {
      // Bearish candle → candidate bullish OB. Price must have RISEN after it.
      const move = lastClose - c;
      if (move <= 0) continue;
      const impulsePct = (move / c) * 100;
      if (impulsePct >= minImpulsePct) {
        const mid = (l + h) / 2;
        return {
          ...result,
          found: true, obLow: l, obHigh: h, obMid: mid,
          impulseFvg: findImpulseFvg(candles, i, 'BULLISH'),
          barAgo: n - 1 - i,
        };
      }
    }
  }
  return result;
}

function findBearishOb(candles, bosPrice, { minImpulsePct = 0.15, maxAgeCandles = 60 } = {}) {
  const result = { ...EMPTY_OB, type: 'bearish' };
  const impulseStart = findImpulseStart(candles, bosPrice, 'BEARISH', maxAgeCandles);
  if (impulseStart === null) return result;

  const n = candles.length;
  const lastClose = candles[n - 1][4];

  for (let i = impulseStart; i > Math.max(0, impulseStart - maxAgeCandles); i--) {
    const [, o, h, l, c] = candles[i];
    if (c > o) {
      const move = c - lastClose;
      if (move <= 0) continue;
      const impulsePct = (move / c) * 100;
      if (impulsePct >= minImpulsePct) {
        const mid = (l + h) / 2;
        return {
          ...result,
          found: true, obLow: l, obHigh: h, obMid: mid,
          impulseFvg: findImpulseFvg(candles, i, 'BEARISH'),
          barAgo: n - 1 - i,
        };
      }
    }
  }
  return result;
}

function checkMitigation(candles, ob) {
  if (!ob.found) return false;
  const last = candles[candles.length - 1];
  const cLow = last[3], cHigh = last[2];
  const { obLow: lo, obHigh: hi, type } = ob;
  if (type === 'bullish' || type === 'bullish_breaker') {
    return cLow <= hi && cHigh >= lo;
  }
  return cHigh >= lo && cLow <= hi;
}

function checkFiftyRetrace(candles, ob) {
  if (!ob.found || ob.obMid <= 0) return false;
  const last = candles[candles.length - 1];
  const cLow = last[3], cHigh = last[2];
  if (ob.type === 'bullish' || ob.type === 'bullish_breaker') {
    return cLow <= ob.obMid;
  }
  return cHigh >= ob.obMid;
}

function findBreaker(candles, ob) {
  const result = { ...ob, isBreaker: false };
  if (!ob.found || !ob.mitigated) return result;
  const { obLow: lo, obHigh: hi } = ob;
  const lastClose = candles[candles.length - 1][4];
  if (ob.type === 'bullish' && lastClose < lo) {
    result.isBreaker = true;
    result.type = 'bearish_breaker';
  } else if (ob.type === 'bearish' && lastClose > hi) {
    result.isBreaker = true;
    result.type = 'bullish_breaker';
  }
  return result;
}

function getOrderBlocks(candles, bos, {
  minImpulsePct = 0.15, maxAgeCandles = 60,
  mitigatedInvalid = true, useBreakerBlocks = true,
} = {}) {
  let bullOb = { ...EMPTY_OB };
  let bearOb = { ...EMPTY_OB };

  const last = candles[candles.length - 1];
  if (bos.detected) {
    bullOb = findBullishOb(candles, bos.price, { minImpulsePct, maxAgeCandles });
    bearOb = findBearishOb(candles, bos.price, { minImpulsePct, maxAgeCandles });
  } else {
    bullOb = findBullishOb(candles, last[2], { minImpulsePct, maxAgeCandles });
    bearOb = findBearishOb(candles, last[3], { minImpulsePct, maxAgeCandles });
  }

  bullOb.mitigated = checkMitigation(candles, bullOb);
  bearOb.mitigated = checkMitigation(candles, bearOb);
  bullOb.obFiftyReached = checkFiftyRetrace(candles, bullOb);
  bearOb.obFiftyReached = checkFiftyRetrace(candles, bearOb);

  if (mitigatedInvalid) {
    const cNow = last[4];
    if (bullOb.found && cNow < bullOb.obLow) bullOb.found = false;
    if (bearOb.found && cNow > bearOb.obHigh) bearOb.found = false;
  }

  if (useBreakerBlocks) {
    if (bullOb.mitigated) bullOb = findBreaker(candles, bullOb);
    if (bearOb.mitigated) bearOb = findBreaker(candles, bearOb);
  }

  return { bullOb, bearOb };
}

module.exports = {
  getOrderBlocks, findBullishOb, findBearishOb, checkMitigation, checkFiftyRetrace,
  EMPTY_OB,
};
