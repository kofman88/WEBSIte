/**
 * Signal generator — given a valid retest at a level, produce entry/SL/TP1/TP2/TP3.
 *
 * Principle (SUPPORT retest → long):
 *   entry = close of the current bar (the retest bar)
 *   SL    = level.price - slAtrMult * ATR   (safe below the level)
 *   TPn   = entry + (entry - SL) * tpRR      (fixed RR multiples)
 *
 * Mirrored for RESISTANCE → short.
 *
 * Returns { entry, stopLoss, tp1, tp2, tp3, riskReward, side } or null if
 * the geometry doesn't make sense (e.g. negative SL distance).
 */

function generateSignal({ level, side, closeNow, atrNow, cfg }) {
  if (!Number.isFinite(closeNow) || !Number.isFinite(atrNow) || atrNow <= 0) return null;

  const entry = closeNow;
  let stopLoss;

  if (side === 'long') {
    stopLoss = level.price - cfg.slAtrMult * atrNow;
    if (stopLoss >= entry) return null; // geometry broken — level wasn't below price
  } else if (side === 'short') {
    stopLoss = level.price + cfg.slAtrMult * atrNow;
    if (stopLoss <= entry) return null;
  } else {
    return null;
  }

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;

  const direction = side === 'long' ? 1 : -1;
  const tp1 = entry + direction * risk * cfg.tp1RR;
  const tp2 = entry + direction * risk * cfg.tp2RR;
  const tp3 = entry + direction * risk * cfg.tp3RR;

  // Reference RR = tp1 distance / sl distance
  const riskReward = cfg.tp1RR;

  return {
    side,
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    riskReward,
    riskPct: (risk / entry) * 100,
  };
}

module.exports = { generateSignal };
