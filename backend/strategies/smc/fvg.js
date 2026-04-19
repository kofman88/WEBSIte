/**
 * SMC — Fair Value Gap (FVG) & Inverted FVG (IFVG).
 *
 * Bullish FVG:  candle[i-2].high < candle[i].low   (up-gap between i-2 top and i bottom)
 * Bearish FVG:  candle[i-2].low  > candle[i].high
 *
 * Ported from bot/CHM_BREAKER_V4/smc/fvg.py
 */

function findFvgs(candles, { minGapPct = 0.08, direction = 'both' } = {}) {
  const n = candles.length;
  const result = [];
  for (let i = 2; i < n; i++) {
    if (direction === 'bullish' || direction === 'both') {
      const gapLow = candles[i - 2][2];
      const gapHigh = candles[i][3];
      if (gapHigh > gapLow) {
        const gapPct = ((gapHigh - gapLow) / gapLow) * 100;
        if (gapPct >= minGapPct) {
          result.push({
            type: 'bullish', fvgLow: gapLow, fvgHigh: gapHigh,
            gapPct, barAgo: n - 1 - i, idx: i, filled: false, inversed: false,
          });
        }
      }
    }
    if (direction === 'bearish' || direction === 'both') {
      const gapHigh = candles[i - 2][3];
      const gapLow = candles[i][2];
      if (gapHigh > gapLow) {
        const gapPct = gapLow > 0 ? ((gapHigh - gapLow) / gapLow) * 100 : 0;
        if (gapPct >= minGapPct) {
          result.push({
            type: 'bearish', fvgLow: gapLow, fvgHigh: gapHigh,
            gapPct, barAgo: n - 1 - i, idx: i, filled: false, inversed: false,
          });
        }
      }
    }
  }

  // Mark filled FVGs (price has already crossed the entire gap)
  const last = candles[n - 1];
  const currentHigh = last[2], currentLow = last[3];
  for (const fvg of result) {
    if (fvg.type === 'bullish') {
      if (currentLow <= fvg.fvgLow) fvg.filled = true;
    } else {
      if (currentHigh >= fvg.fvgHigh) fvg.filled = true;
    }
  }

  const active = result.filter((f) => !f.filled);
  active.sort((a, b) => b.idx - a.idx);
  return active;
}

function findIfvgs(candles, fvgList) {
  // In the bot's implementation, IFVGs are filled FVGs that now act as reverse levels.
  // For our port we generate them from the full scan (not the active-only list).
  // Caller should pass raw FVG list including filled ones for this to work.
  // As simplified logic we return empty here and re-emit via findFvgsAll().
  return [];
}

function findFvgsAll(candles, { minGapPct = 0.08 } = {}) {
  const n = candles.length;
  const all = [];
  for (let i = 2; i < n; i++) {
    const gapLowBull = candles[i - 2][2];
    const gapHighBull = candles[i][3];
    if (gapHighBull > gapLowBull) {
      const pct = ((gapHighBull - gapLowBull) / gapLowBull) * 100;
      if (pct >= minGapPct) all.push({
        type: 'bullish', fvgLow: gapLowBull, fvgHigh: gapHighBull, gapPct: pct,
        barAgo: n - 1 - i, idx: i, filled: false, inversed: false,
      });
    }
    const gapHighBear = candles[i - 2][3];
    const gapLowBear = candles[i][2];
    if (gapHighBear > gapLowBear) {
      const pct = gapLowBear > 0 ? ((gapHighBear - gapLowBear) / gapLowBear) * 100 : 0;
      if (pct >= minGapPct) all.push({
        type: 'bearish', fvgLow: gapLowBear, fvgHigh: gapHighBear, gapPct: pct,
        barAgo: n - 1 - i, idx: i, filled: false, inversed: false,
      });
    }
  }
  const last = candles[n - 1];
  const currentHigh = last[2], currentLow = last[3];
  for (const fvg of all) {
    if (fvg.type === 'bullish' && currentLow <= fvg.fvgLow) fvg.filled = true;
    else if (fvg.type === 'bearish' && currentHigh >= fvg.fvgHigh) fvg.filled = true;
  }
  return all;
}

function nearestFvg(fvgList, price, direction = 'bullish') {
  const matching = fvgList.filter((f) => {
    if (f.filled) return false;
    if (direction === 'bullish') return f.type === 'bullish' || f.type === 'ifvg_bullish';
    return f.type === 'bearish' || f.type === 'ifvg_bearish';
  });
  if (!matching.length) return null;
  return matching.reduce((best, f) => {
    const mid = (f.fvgLow + f.fvgHigh) / 2;
    const d = Math.abs(mid - price);
    if (!best || d < best._d) return { ...f, _d: d };
    return best;
  }, null);
}

function getFvgAnalysis(candles, { minGapPct = 0.08, inversedFvg = true } = {}) {
  const all = findFvgsAll(candles, { minGapPct });
  // Build IFVGs from filled ones
  const ifvgs = !inversedFvg ? [] : all
    .filter((f) => f.filled)
    .map((f) => ({
      ...f,
      inversed: true,
      type: f.type === 'bullish' ? 'ifvg_bearish' : 'ifvg_bullish',
    }));
  const active = all.filter((f) => !f.filled);
  const price = candles[candles.length - 1][4];
  const bullFvg = nearestFvg([...active, ...ifvgs], price, 'bullish');
  const bearFvg = nearestFvg([...active, ...ifvgs], price, 'bearish');
  return {
    allFvgs: active, ifvgs,
    bullFvg, bearFvg,
    bullFound: !!bullFvg, bearFound: !!bearFvg,
  };
}

module.exports = { findFvgs, findFvgsAll, nearestFvg, getFvgAnalysis };
