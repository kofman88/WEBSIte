/**
 * GERCHIK strategy — strict level-retest with absorption + trend alignment.
 *
 * Differences from `strategies/levels`:
 *   - minTouches=3 (KRP)
 *   - trend alignment mandatory
 *   - absorption candle required (hammer / shooting_star / engulfing)
 *   - volume spike ≥1.5× required
 *   - minRR 2.0 (vs 1.5)
 *
 * Shares the `levelBuilder` + `marketRegime` + `generateSignal` +
 * `qualityScorer` with the base levels strategy, so we only re-implement
 * the higher-level scan logic.
 *
 * Pure function — never reads DB, never fetches network.
 */

const indicators = require('../../services/indicators');
const { buildLevels } = require('../levels/levelBuilder');
const { generateSignal } = require('../levels/signalGenerator');
const { scoreSignal } = require('../levels/qualityScorer');
const { classifyRegime } = require('../levels/marketRegime');
const { DEFAULT_CONFIG, LONG_ABSORPTION, SHORT_ABSORPTION } = require('./config');

function scan(candlesRaw, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  if (!Array.isArray(candlesRaw) || candlesRaw.length < cfg.pivotStrength * 2 + 10) {
    return null;
  }

  const candles = candlesRaw.length > cfg.maxBarsLookback
    ? candlesRaw.slice(-cfg.maxBarsLookback)
    : candlesRaw.slice();

  const index = candles.length - 1;
  const current = candles[index];
  const closeNow = current[4];
  const highNow  = current[2];
  const lowNow   = current[3];

  const atrSeries = indicators.atr(candles, 14);
  const atrNow = atrSeries[index];
  if (!Number.isFinite(atrNow) || atrNow <= 0) return null;

  const levels = buildLevels(candles, cfg, atrNow);
  if (!levels.length) return null;

  const regime = classifyRegime(candles, cfg.trendEmaPeriod);
  const pattern = indicators.detectCandlePattern(candles, index);

  // Volume spike check — gate everything on this
  const vp = indicators.volumeProfile(candles, 20);
  const volRatio = vp[index] ? vp[index].ratio : null;
  if (!Number.isFinite(volRatio) || volRatio < cfg.volumeRatioMin) return null;

  const retestZone = cfg.retestZoneAtrMult * atrNow;
  const minDist = cfg.minDistAtrMult * atrNow;
  const maxDist = cfg.maxDistAtrMult * atrNow;

  let best = null;

  for (const level of levels) {
    // Re-assert KRP — defense in depth even if cfg.minTouches is overridden
    if (level.touches.length < cfg.minTouches) continue;

    const age = index - level.lastTouch;
    if (age > cfg.maxLevelAgeBars) continue;

    const distFromPrice = Math.abs(closeNow - level.price);

    if (level.side === 'support') {
      // Long setup requirements
      if (cfg.requireTrendAlignment && regime === 'bear') continue;
      if (cfg.requireAbsorption && !LONG_ABSORPTION.has(pattern)) continue;

      const dippedIn = lowNow <= level.price + retestZone && lowNow >= level.price - retestZone;
      if (!dippedIn) continue;
      if (cfg.requireCloseBack && closeNow <= level.price) continue;
      if (distFromPrice < minDist || distFromPrice > maxDist) continue;

      const sig = generateSignal({ level, side: 'long', closeNow, atrNow, cfg });
      if (!sig) continue;
      if (sig.riskReward < cfg.minRiskReward) continue;

      const quality = scoreSignal({
        candles, index, level, side: 'long', rr: sig.riskReward, cfg, regime,
      });
      if (quality < cfg.minQuality) continue;

      if (!best || quality > best.quality) {
        best = { ...sig, level, quality, regime, pattern };
      }
    } else if (level.side === 'resistance') {
      if (cfg.requireTrendAlignment && regime === 'bull') continue;
      if (cfg.requireAbsorption && !SHORT_ABSORPTION.has(pattern)) continue;

      const reachedUp = highNow >= level.price - retestZone && highNow <= level.price + retestZone;
      if (!reachedUp) continue;
      if (cfg.requireCloseBack && closeNow >= level.price) continue;
      if (distFromPrice < minDist || distFromPrice > maxDist) continue;

      const sig = generateSignal({ level, side: 'short', closeNow, atrNow, cfg });
      if (!sig) continue;
      if (sig.riskReward < cfg.minRiskReward) continue;

      const quality = scoreSignal({
        candles, index, level, side: 'short', rr: sig.riskReward, cfg, regime,
      });
      if (quality < cfg.minQuality) continue;

      if (!best || quality > best.quality) {
        best = { ...sig, level, quality, regime, pattern };
      }
    }
  }

  if (!best) return null;

  const closes = candles.map((c) => c[4]);
  const rsiNow = indicators.rsi(closes, 14)[index];

  // Gerchik signals are inherently higher-confidence — start bias at 60
  const confidence = Math.min(98, Math.round(60 + best.quality * 4));

  const reasonBits = [
    best.side === 'long' ? 'KRP support retest' : 'KRP resistance retest',
    `@ ${round(best.level.price)}`,
    `(${best.level.touches.length} touches)`,
    best.pattern,
    `vol ${volRatio.toFixed(1)}x`,
  ];
  if (regime !== 'sideways') reasonBits.push(`+ ${regime} regime`);
  reasonBits.push(`RR=${best.riskReward.toFixed(1)}`);

  return {
    strategy: 'gerchik',
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
      volumeRatio: Number(volRatio.toFixed(2)),
      rsi: Number.isFinite(rsiNow) ? Number(rsiNow.toFixed(1)) : null,
      atr: Number(atrNow.toFixed(6)),
      absorptionPattern: best.pattern,
    },
  };
}

function round(x, digits = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

module.exports = { scan, DEFAULT_CONFIG };
