/**
 * Grid strategy — simplified V1.
 *
 * Истинный grid-бот работает с резервированием ордеров на бирже в диапазоне
 * [low..high] с шагом step — buy на минимумах, sell на максимумах. Это
 * требует order-lifecycle management поверх CCXT и ожидает тестнет.
 *
 * Текущая версия — paper-friendly имитация:
 *   - Определяет диапазон последних N баров автоматически
 *     (range = [min..max] за lookback баров)
 *   - Разбивает на gridCount уровней
 *   - Сигналит LONG когда цена пересекает нижний грид-уровень снизу вверх
 *     (на "отскоке")
 *   - TP = следующий грид-уровень выше
 *   - SL = нижняя граница диапазона минус одна клетка
 *
 * Это имитирует "купили на дне, продали на следующей полке". На сильном
 * downtrend стратегия будет терять — поэтому она работает на боковике.
 *
 * Параметры:
 *   lookback      — окно для определения range    (default 100)
 *   gridCount     — уровней в сетке               (default 10)
 *   minRangePct   — мин. ширина range от mid      (default 3)
 */

const DEFAULT_CONFIG = Object.freeze({
  lookback: 100,
  gridCount: 10,
  minRangePct: 3.0,
  minConfidence: 50,
});

function scan(candlesRaw, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  if (!Array.isArray(candlesRaw) || candlesRaw.length < cfg.lookback + 5) return null;

  const window = candlesRaw.slice(-cfg.lookback);
  const highs = window.map((c) => c[2]);
  const lows = window.map((c) => c[3]);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const rangePct = ((rangeHigh - rangeLow) / rangeMid) * 100;
  if (rangePct < cfg.minRangePct) return null;

  // Last closed candle
  const last = candlesRaw[candlesRaw.length - 1];
  const prev = candlesRaw[candlesRaw.length - 2];
  const closeNow = last[4];
  const closePrev = prev[4];

  // Grid step
  const step = (rangeHigh - rangeLow) / cfg.gridCount;
  if (step <= 0) return null;

  // Find bottom two grid levels — only trade in lower half of range
  // (buy dip, sell to next level up)
  const levels = [];
  for (let i = 0; i <= cfg.gridCount; i++) {
    levels.push(rangeLow + i * step);
  }

  // Which grid level is price crossing? We're looking for upward-cross
  // from below a grid line into the one above — classic "bounce off support"
  let crossedAt = -1;
  for (let i = 1; i < levels.length - 1; i++) {
    const lvl = levels[i];
    if (closePrev < lvl && closeNow >= lvl) { crossedAt = i; break; }
  }
  if (crossedAt < 0) return null;
  // Only take signals in the lower half (i < gridCount/2) — buy dips not tops
  if (crossedAt > Math.floor(cfg.gridCount / 2)) return null;

  const entry = closeNow;
  const stopLoss = levels[Math.max(0, crossedAt - 1)] - step * 0.3;
  const tp1 = levels[crossedAt + 1];                      // next level up
  const tp2 = levels[Math.min(levels.length - 1, crossedAt + 2)];
  const tp3 = levels[Math.min(levels.length - 1, crossedAt + 3)];

  const slDist = Math.abs(entry - stopLoss);
  const tpDist = Math.abs(tp1 - entry);
  if (slDist <= 0 || tpDist <= 0) return null;
  const riskReward = Number((tpDist / slDist).toFixed(2));

  // Confidence based on position in range — deeper = stronger
  const posInRange = (entry - rangeLow) / (rangeHigh - rangeLow);
  const confidence = Math.round(70 - posInRange * 30);  // 70 at bottom → 40 at mid
  if (confidence < cfg.minConfidence) return null;

  return {
    strategy: 'grid',
    side: 'long',
    entry: round(entry),
    stopLoss: round(stopLoss),
    tp1: round(tp1), tp2: round(tp2), tp3: round(tp3),
    riskReward,
    quality: Math.round((1 - posInRange) * 8) + 2,
    confidence,
    reason: `Grid L${crossedAt}/${cfg.gridCount} bounce · range ${rangePct.toFixed(1)}% · R:R ${riskReward}`,
    metadata: {
      gridLevel: crossedAt,
      gridCount: cfg.gridCount,
      rangeLow: round(rangeLow),
      rangeHigh: round(rangeHigh),
      rangePct: Number(rangePct.toFixed(2)),
      positionInRange: Number(posInRange.toFixed(3)),
    },
  };
}

function round(x, digits = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

module.exports = { scan, DEFAULT_CONFIG };
