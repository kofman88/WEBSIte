/**
 * LEVELS strategy — main entry point.
 *
 *   const { scan } = require('./strategies/levels');
 *   const signal = scan(candles, { ...overrides });
 *   if (signal) { ... }
 *
 * `candles`: array of CCXT-style tuples [openTime, o, h, l, c, v, closeTime]
 *            in ASCENDING time order. The LAST candle is the "current" bar
 *            being evaluated. Must be a CLOSED bar — strategy never looks
 *            at a forming bar.
 *
 * Returns a Signal object or `null` if no valid retest/quality signal.
 *
 *   Signal = {
 *     strategy: 'levels',
 *     side: 'long' | 'short',
 *     entry, stopLoss, tp1, tp2, tp3,
 *     riskReward, quality (0-10), confidence (0-100),
 *     reason: string, metadata: { level, regime, volumeRatio }
 *   }
 *
 * Pure function — never reads DB, never fetches network.
 */

const indicators = require('../../services/indicators');
const { DEFAULT_CONFIG } = require('./config');
const { buildLevels } = require('./levelBuilder');
const { generateSignal } = require('./signalGenerator');
const { scoreSignal } = require('./qualityScorer');
const { classifyRegime } = require('./marketRegime');

function scan(candlesRaw, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  if (!Array.isArray(candlesRaw) || candlesRaw.length < cfg.pivotStrength * 2 + 10) {
    return null;
  }

  // Trim to lookback window (most recent `maxBarsLookback` bars)
  const candles = candlesRaw.length > cfg.maxBarsLookback
    ? candlesRaw.slice(-cfg.maxBarsLookback)
    : candlesRaw.slice();

  const index = candles.length - 1;
  const current = candles[index];
  const closeNow = current[4];
  const highNow = current[2];
  const lowNow = current[3];
  const openNow = current[1];

  // Compute ATR
  const atrSeries = indicators.atr(candles, 14);
  const atrNow = atrSeries[index];
  if (!Number.isFinite(atrNow) || atrNow <= 0) return null;

  // Build levels
  const levels = buildLevels(candles, cfg, atrNow);
  if (!levels.length) return null;

  // Regime
  const regime = classifyRegime(candles, cfg.trendEmaPeriod);

  // Try each level: is this a valid retest right now?
  const retestZone = cfg.retestZoneAtrMult * atrNow;
  const minDist = cfg.minDistAtrMult * atrNow;
  const maxDist = cfg.maxDistAtrMult * atrNow;

  let best = null;

  for (const level of levels) {
    const age = index - level.lastTouch;
    if (age > cfg.maxLevelAgeBars) continue;

    const distFromPrice = Math.abs(closeNow - level.price);

    if (level.side === 'support') {
      // Long retest: bar must have dipped into the zone AND closed back above
      const dippedIn = lowNow <= level.price + retestZone && lowNow >= level.price - retestZone;
      const closedBack = closeNow > level.price;
      if (!dippedIn) continue;
      if (cfg.requireCloseBack && !closedBack) continue;
      if (distFromPrice < minDist || distFromPrice > maxDist) continue;
      if (closeNow <= level.price) continue; // safety

      const sig = generateSignal({ level, side: 'long', closeNow, atrNow, cfg });
      if (!sig) continue;
      if (sig.riskReward < cfg.minRiskReward) continue;

      const quality = scoreSignal({
        candles, index, level, side: 'long', rr: sig.riskReward, cfg, regime,
      });
      if (quality < cfg.minQuality) continue;

      if (!best || quality > best.quality) {
        best = { ...sig, level, quality, regime };
      }
    } else if (level.side === 'resistance') {
      const reachedUp = highNow >= level.price - retestZone && highNow <= level.price + retestZone;
      const closedBack = closeNow < level.price;
      if (!reachedUp) continue;
      if (cfg.requireCloseBack && !closedBack) continue;
      if (distFromPrice < minDist || distFromPrice > maxDist) continue;
      if (closeNow >= level.price) continue;

      const sig = generateSignal({ level, side: 'short', closeNow, atrNow, cfg });
      if (!sig) continue;
      if (sig.riskReward < cfg.minRiskReward) continue;

      const quality = scoreSignal({
        candles, index, level, side: 'short', rr: sig.riskReward, cfg, regime,
      });
      if (quality < cfg.minQuality) continue;

      if (!best || quality > best.quality) {
        best = { ...sig, level, quality, regime };
      }
    }
  }

  if (!best) return null;

  const closes = candles.map((c) => c[4]);
  const rsiNow = indicators.rsi(closes, 14)[index];
  const vp = indicators.volumeProfile(candles, 20);
  const volRatio = vp[index] ? vp[index].ratio : null;
  const pattern = indicators.detectCandlePattern(candles, index);

  // Confidence: map quality 0..10 → 50..95
  const confidence = Math.round(50 + best.quality * 4.5);

  const reasonBits = [
    best.side === 'long' ? 'Retest support' : 'Retest resistance',
    `@ ${round(best.level.price)}`,
    `(${best.level.touches.length} touches)`,
  ];
  if (regime !== 'sideways') reasonBits.push(`+ ${regime} regime`);
  if (Number.isFinite(volRatio) && volRatio > 1.2) reasonBits.push(`+ vol ${volRatio.toFixed(1)}x`);
  if (pattern) reasonBits.push(`+ ${pattern}`);
  reasonBits.push(`RR=${best.riskReward.toFixed(1)}`);

  return {
    strategy: 'levels',
    side: best.side,
    entry: round(best.entry),
    stopLoss: round(best.stopLoss),
    tp1: round(best.tp1),
    tp2: round(best.tp2),
    tp3: round(best.tp3),
    riskReward: Number(best.riskReward.toFixed(2)),
    quality: best.quality,
    confidence,
    reason: reasonBits.join(' '),
    metadata: {
      level: {
        price: round(best.level.price),
        side: best.level.side,
        touches: best.level.touches.length,
        firstTouch: best.level.firstTouch,
        lastTouch: best.level.lastTouch,
      },
      regime,
      volumeRatio: Number.isFinite(volRatio) ? Number(volRatio.toFixed(2)) : null,
      rsi: Number.isFinite(rsiNow) ? Number(rsiNow.toFixed(1)) : null,
      atr: Number(atrNow.toFixed(6)),
      candlePattern: pattern,
    },
  };
}

function round(x, digits = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

module.exports = { scan, DEFAULT_CONFIG };
