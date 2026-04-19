/**
 * SMC — Liquidity Sweeps + Equal Highs/Lows.
 *
 * Ported from bot/CHM_BREAKER_V4/smc/liquidity.py
 */

function findEqualLevels(levels, thresholdPct = 0.1) {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const groups = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const ref = group[0].price;
    const diff = (Math.abs(sorted[i].price - ref) / ref) * 100;
    if (diff <= thresholdPct) group.push(sorted[i]);
    else {
      if (group.length >= 2) {
        const avgPrice = group.reduce((s, l) => s + l.price, 0) / group.length;
        groups.push({ price: avgPrice, count: group.length, levels: group, type: group[0].type || '' });
      }
      group = [sorted[i]];
    }
  }
  if (group.length >= 2) {
    const avgPrice = group.reduce((s, l) => s + l.price, 0) / group.length;
    groups.push({ price: avgPrice, count: group.length, levels: group, type: group[0].type || '' });
  }
  return groups;
}

function detectSweep(candles, equalLevel, direction, { closeRequired = false, wickRatio = 0.3 } = {}) {
  const result = { swept: false, level: equalLevel.price, direction, wickRatio: 0 };
  if (candles.length < 5) return result;
  const c = candles[candles.length - 1];
  const [, open, high, low, close] = c;
  const lvl = equalLevel.price;
  const body = Math.abs(close - open);
  const range = Math.max(high - low, 1e-10);

  if (direction === 'UP') {
    // Tag below, close above
    const tol = lvl * 0.0002;
    const sweptBelow = low < lvl + tol;
    const closedBack = closeRequired ? close > lvl : true;
    const lowerWick = Math.min(close, open) - low;
    const wr = lowerWick / range;
    if (sweptBelow && closedBack && wr >= wickRatio) {
      result.swept = true;
      result.wickRatio = Number(wr.toFixed(3));
    }
  } else {
    const tol = lvl * 0.0002;
    const sweptAbove = high > lvl - tol;
    const closedBack = closeRequired ? close < lvl : true;
    const upperWick = high - Math.max(close, open);
    const wr = upperWick / range;
    if (sweptAbove && closedBack && wr >= wickRatio) {
      result.swept = true;
      result.wickRatio = Number(wr.toFixed(3));
    }
  }
  return result;
}

function findLiquiditySweeps(candles, swingHighs, swingLows, {
  thresholdPct = 0.1, closeRequired = false, wickRatio = 0.3,
} = {}) {
  const tagged = (arr, type) => arr.map((x) => ({ ...x, type }));
  const eqHighs = findEqualLevels(tagged(swingHighs, 'high'), thresholdPct);
  const eqLows = findEqualLevels(tagged(swingLows, 'low'), thresholdPct);

  let sweepUp = { swept: false, level: 0, direction: 'UP' };
  let sweepDown = { swept: false, level: 0, direction: 'DOWN' };

  for (const eq of eqLows) {
    const res = detectSweep(candles, eq, 'UP', { closeRequired, wickRatio });
    if (res.swept) { sweepUp = res; break; }
  }
  for (const eq of [...eqHighs].reverse()) {
    const res = detectSweep(candles, eq, 'DOWN', { closeRequired, wickRatio });
    if (res.swept) { sweepDown = res; break; }
  }

  return { equalHighs: eqHighs, equalLows: eqLows, sweepUp, sweepDown };
}

module.exports = { findEqualLevels, detectSweep, findLiquiditySweeps };
