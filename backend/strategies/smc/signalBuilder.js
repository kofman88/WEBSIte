/**
 * SMC Signal Builder — combines analyzer output into a concrete entry signal.
 *
 * Scoring model (bot's approach):
 *   Each LONG/SHORT direction accumulates "confirmations" from:
 *     1. Market structure trend (BULLISH/BEARISH)
 *     2. BOS + matching OB
 *     3. Liquidity sweep in opposite direction
 *     4. Premium/Discount zone alignment
 *     5. FVG in the direction
 *     6. CHoCH confirming reversal
 *     7. Volume confirmation (soft: extra point)
 *
 * Required: minConfirmations (default 3). If both directions reach minimum,
 * we pick the higher score. Ties → drop (ranging market, don't trade).
 *
 * Output: standard Signal shape compatible with LEVELS.
 *
 * Loosely ported from bot/CHM_BREAKER_V4/smc/signal_builder.py — kept
 * simpler because the bot file is 800+ lines with many fine-grained rules.
 * Calibrate further when we have example-by-example fixtures.
 */

const { DEFAULT_CONFIG } = require('./config');

function buildSignal(symbol, analysis, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  if (analysis.error || analysis.atr <= 0) return null;

  const {
    structure, liquidity, ob, fvg, pdZone,
    currentPrice, currentHigh, currentLow, atr,
    volRatio, volumeOk,
  } = analysis;

  if (!currentPrice || !atr) return null;

  // Collect direction scores
  const longScore = scoreDirection('long', { structure, liquidity, ob, fvg, pdZone, volumeOk });
  const shortScore = scoreDirection('short', { structure, liquidity, ob, fvg, pdZone, volumeOk });

  let side, score, reasons;
  if (longScore.score > shortScore.score && longScore.score >= cfg.minConfirmations) {
    side = 'long'; score = longScore.score; reasons = longScore.reasons;
  } else if (shortScore.score > longScore.score && shortScore.score >= cfg.minConfirmations) {
    side = 'short'; score = shortScore.score; reasons = shortScore.reasons;
  } else {
    return null; // ranging or insufficient
  }

  // Hard filter: volume required
  if (cfg.useVolumeFilter && !volumeOk) return null;

  // Entry/SL/TP
  let entry, stopLoss;
  const targetOb = side === 'long' ? ob.bullOb : ob.bearOb;

  if (targetOb && targetOb.found) {
    // Enter at OB-mid (or current price if price already there)
    entry = side === 'long'
      ? Math.max(targetOb.obMid, currentPrice)
      : Math.min(targetOb.obMid, currentPrice);
    // SL beyond OB extreme + buffer
    stopLoss = side === 'long'
      ? targetOb.obLow - atr * cfg.slAtrMult
      : targetOb.obHigh + atr * cfg.slAtrMult;
  } else {
    // Fallback: ATR-based
    entry = currentPrice;
    stopLoss = side === 'long' ? entry - atr * cfg.slAtrMult : entry + atr * cfg.slAtrMult;
  }

  // Geometry guard
  if (side === 'long' && stopLoss >= entry) return null;
  if (side === 'short' && stopLoss <= entry) return null;

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;

  const dir = side === 'long' ? 1 : -1;
  const tp1 = entry + dir * risk * cfg.tp1Rr;
  const tp2 = entry + dir * risk * cfg.tp2Rr;
  const tp3 = entry + dir * risk * cfg.tp3Rr;
  const riskReward = cfg.tp1Rr;

  if (riskReward < cfg.minRr / cfg.tp2Rr) return null; // keep conservative

  // Quality 0..10 — mapped from score
  const quality = Math.min(10, Math.round((score / 7) * 10));
  const confidence = Math.min(95, Math.max(50, 50 + score * 7));

  const reason = `SMC ${side.toUpperCase()}: ${reasons.join(', ')}`;

  return {
    strategy: 'smc',
    side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1), tp2: round(tp2), tp3: round(tp3),
    riskReward: Number(riskReward.toFixed(2)),
    quality,
    confidence,
    reason,
    metadata: {
      structure: {
        trend: structure.trend,
        bos: structure.bos.detected ? structure.bos.direction : null,
        choch: structure.choch.detected ? structure.choch.direction : null,
      },
      ob: targetOb && targetOb.found ? {
        type: targetOb.type,
        low: round(targetOb.obLow),
        high: round(targetOb.obHigh),
        mid: round(targetOb.obMid),
        isBreaker: targetOb.isBreaker,
      } : null,
      fvg: side === 'long' ? (fvg.bullFvg && {
        low: round(fvg.bullFvg.fvgLow), high: round(fvg.bullFvg.fvgHigh), type: fvg.bullFvg.type,
      }) : (fvg.bearFvg && {
        low: round(fvg.bearFvg.fvgLow), high: round(fvg.bearFvg.fvgHigh), type: fvg.bearFvg.type,
      }),
      liquiditySweep: side === 'long' ? liquidity.sweepUp.swept : liquidity.sweepDown.swept,
      pdZone: pdZone.zone,
      atr: Number(atr.toFixed(8)),
      volumeRatio: Number((volRatio || 0).toFixed(2)),
      confirmations: score,
    },
  };
}

function scoreDirection(dir, { structure, liquidity, ob, fvg, pdZone, volumeOk }) {
  let s = 0;
  const reasons = [];

  const isLong = dir === 'long';

  // 1. Structural trend
  if (isLong && structure.trend === 'BULLISH') { s++; reasons.push('bull trend'); }
  if (!isLong && structure.trend === 'BEARISH') { s++; reasons.push('bear trend'); }

  // 2. BOS aligned with direction
  if (structure.bos && structure.bos.detected) {
    if (isLong && structure.bos.direction === 'BULLISH') { s++; reasons.push('BOS up'); }
    if (!isLong && structure.bos.direction === 'BEARISH') { s++; reasons.push('BOS down'); }
  }

  // 3. OB present + 50% retrace reached (strong trigger)
  const targetOb = isLong ? ob.bullOb : ob.bearOb;
  if (targetOb && targetOb.found) {
    s++;
    reasons.push(targetOb.isBreaker ? 'breaker' : 'OB');
    if (targetOb.obFiftyReached) { s++; reasons.push('50% mid'); }
  }

  // 4. Liquidity sweep in opposite direction (stop hunt → reversal fuel)
  if (isLong && liquidity.sweepUp && liquidity.sweepUp.swept) { s++; reasons.push('liquidity swept'); }
  if (!isLong && liquidity.sweepDown && liquidity.sweepDown.swept) { s++; reasons.push('liquidity swept'); }

  // 5. Premium/Discount zone alignment
  if (isLong && pdZone.zone === 'DISCOUNT') { s++; reasons.push('discount zone'); }
  if (!isLong && pdZone.zone === 'PREMIUM') { s++; reasons.push('premium zone'); }

  // 6. FVG in direction
  if (isLong && fvg.bullFound) { s++; reasons.push('bull FVG'); }
  if (!isLong && fvg.bearFound) { s++; reasons.push('bear FVG'); }

  // 7. CHoCH confirming reversal (catching beginning of new trend)
  if (structure.choch && structure.choch.detected) {
    if (isLong && structure.choch.direction === 'UP') { s++; reasons.push('CHoCH up'); }
    if (!isLong && structure.choch.direction === 'DOWN') { s++; reasons.push('CHoCH down'); }
  }

  // Soft volume bonus
  if (volumeOk) { s++; reasons.push('vol confirm'); }

  return { score: s, reasons };
}

function round(x, digits = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

module.exports = { buildSignal };
