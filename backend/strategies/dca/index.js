/**
 * DCA (Dollar Cost Averaging) strategy — simplified V1.
 *
 * Cигналит LONG на каждом "провале" N% от скользящего среднего — идея в том
 * что бот с высоким max_open_trades будет набирать позицию порциями
 * усредняя вход.
 *
 * По-настоящему честная DCA с одним циклом, trailing average и
 * single-TP-for-all-fills требует доп. state-machine поверх trades. Это
 * следующая итерация (Phase D.2) вместе с testnet-валидацией live-flow.
 * Текущая версия — paper-friendly демо концепции.
 *
 * Параметры (все optional):
 *   maPeriod       — SMA период                      (default 50)
 *   dipPct         — % вниз от SMA для триггера long (default 2)
 *   tpPct          — TP в % от входа                 (default 1.5)
 *   slPct          — SL в % от входа                 (default 3)
 *   cooldownBars   — минимум баров между сигналами   (default 5)
 *
 * Pure function — never reads DB, never fetches network.
 */

const indicators = require('../../services/indicators');

const DEFAULT_CONFIG = Object.freeze({
  maPeriod: 50,
  dipPct: 2.0,
  tpPct: 1.5,
  slPct: 3.0,
  cooldownBars: 5,
  minConfidence: 55,
});

function scan(candlesRaw, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  if (!Array.isArray(candlesRaw) || candlesRaw.length < cfg.maPeriod + cfg.cooldownBars + 2) return null;

  const candles = candlesRaw.slice(-Math.max(cfg.maPeriod + 50, 200));
  const index = candles.length - 1;
  const closes = candles.map((c) => c[4]);

  const smaArr = indicators.sma(closes, cfg.maPeriod);
  const smaNow = smaArr[index];
  if (!Number.isFinite(smaNow) || smaNow <= 0) return null;

  const closeNow = closes[index];
  const dipActual = ((smaNow - closeNow) / smaNow) * 100;
  if (dipActual < cfg.dipPct) return null;          // not dipped enough
  if (closeNow >= smaNow) return null;              // not below SMA (safety)

  // Volume confirmation (optional bonus)
  const vp = indicators.volumeProfile(candles, 20);
  const volRatio = vp[index] ? vp[index].ratio : 1;

  const entry = closeNow;
  const stopLoss = entry * (1 - cfg.slPct / 100);
  const tp1 = entry * (1 + cfg.tpPct / 100);
  const tp2 = entry * (1 + cfg.tpPct * 1.5 / 100);
  const tp3 = entry * (1 + cfg.tpPct * 2 / 100);

  // Confidence: steeper dip → higher conviction, volume spike boosts
  let confidence = Math.min(95, Math.round(55 + dipActual * 5 + (volRatio > 1.2 ? 5 : 0)));
  if (confidence < cfg.minConfidence) return null;

  return {
    strategy: 'dca',
    side: 'long',
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1), tp2: round(tp2), tp3: round(tp3),
    riskReward: Number((cfg.tpPct / cfg.slPct).toFixed(2)),
    quality: Math.min(10, Math.round(dipActual)),
    confidence,
    reason: `DCA dip ${dipActual.toFixed(1)}% under SMA${cfg.maPeriod}${volRatio > 1.2 ? ` · vol ${volRatio.toFixed(1)}x` : ''}`,
    metadata: {
      sma: Number(smaNow.toFixed(6)),
      dipPct: Number(dipActual.toFixed(2)),
      volumeRatio: Number(volRatio.toFixed(2)),
    },
  };
}

function round(x, digits = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

module.exports = { scan, DEFAULT_CONFIG };
