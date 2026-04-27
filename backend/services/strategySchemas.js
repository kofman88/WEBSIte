/**
 * Strategy parameter schemas — drives the dynamic config form in the
 * bot wizard. Each entry describes one DEFAULT_CONFIG field so the UI
 * can render the right input (number with min/max/step, boolean toggle,
 * or select) and show a Russian description.
 *
 * The default numeric values must match those in strategies/<s>/config.js
 * — kept here separately so a new strategy param is surfaced in the UI
 * without a separate migration.
 */

const SCHEMAS = {
  smc: {
    title: 'SMC (Smart Money Concepts)',
    description: 'Order Blocks, FVG, liquidity sweeps. 3+ confirmations из 5 шагов SMC.',
    groups: [
      {
        title: 'Структура',
        fields: [
          { key: 'swingLookback',    type: 'int',    min: 5,  max: 30, step: 1, default: 10,  label: 'Swing lookback', desc: 'Баров для определения swing high/low' },
          { key: 'bosConfirmation',  type: 'bool',                                default: true,label: 'BoS confirmation', desc: 'Требовать Break of Structure' },
          { key: 'chochEnabled',     type: 'bool',                                default: true,label: 'CHoCH enabled', desc: 'Change of Character — разворот тренда' },
        ],
      },
      {
        title: 'Ликвидность',
        fields: [
          { key: 'equalThresholdPct',   type: 'float', min: 0.01,max: 0.5, step: 0.01, default: 0.1,  label: 'Equal threshold %', desc: 'Допуск для equal highs/lows' },
          { key: 'sweepWickRatio',      type: 'float', min: 0.1, max: 0.8, step: 0.05, default: 0.3,  label: 'Sweep wick ratio', desc: 'Доля тени для sweep liquidity' },
          { key: 'sweepCloseRequired',  type: 'bool',                                  default: false,label: 'Close back required', desc: 'Закрытие обратно за уровень' },
        ],
      },
      {
        title: 'Order Block',
        fields: [
          { key: 'obMinImpulsePct',  type: 'float', min: 0.05,max: 1.0,  step: 0.05, default: 0.15, label: 'OB min impulse %', desc: 'Минимальный импульс после OB' },
          { key: 'obMaxAgeCandles',  type: 'int',   min: 10,  max: 200,  step: 5,    default: 60,   label: 'OB max age (bars)', desc: 'Срок годности OB' },
          { key: 'obMitigatedInvalid', type: 'bool',                                   default: true, label: 'Mitigated = invalid', desc: 'Уже касавшиеся OB не считать' },
          { key: 'obUseBreaker',     type: 'bool',                                     default: true, label: 'Use breaker blocks', desc: 'Пробитые OB как breaker' },
        ],
      },
      {
        title: 'FVG (Fair Value Gap)',
        fields: [
          { key: 'fvgEnabled',     type: 'bool',                                    default: true, label: 'FVG enabled', desc: 'Включить поиск FVG' },
          { key: 'fvgMinGapPct',   type: 'float',min: 0.02,max: 0.5,  step: 0.01,   default: 0.08, label: 'FVG min gap %', desc: 'Минимальный размер гэпа' },
          { key: 'fvgInversed',    type: 'bool',                                    default: true, label: 'Inverse FVG', desc: 'Пробитые FVG как противоположные' },
        ],
      },
      {
        title: 'Сигнал',
        fields: [
          { key: 'minConfirmations', type: 'int',   min: 1,  max: 5,   step: 1,     default: 3,    label: 'Min confirmations', desc: 'Сколько из 5 шагов SMC должны совпасть' },
          { key: 'minRr',            type: 'float', min: 1.0,max: 5.0, step: 0.1,   default: 2.0,  label: 'Min R:R', desc: 'Минимальный риск/прибыль к TP1' },
          { key: 'slBufferPct',      type: 'float', min: 0.1,max: 2.0, step: 0.1,   default: 0.5,  label: 'SL buffer %', desc: 'Отступ SL за OB/FVG' },
          { key: 'slAtrMult',        type: 'float', min: 0.5,max: 3.0, step: 0.1,   default: 1.0,  label: 'SL × ATR', desc: 'Запасной SL по ATR' },
          { key: 'tp1Rr',            type: 'float', min: 0.5,max: 3.0, step: 0.1,   default: 1.0,  label: 'TP1 R:R', desc: 'Первый тейк' },
          { key: 'tp2Rr',            type: 'float', min: 1.0,max: 5.0, step: 0.1,   default: 2.0,  label: 'TP2 R:R', desc: 'Второй тейк' },
          { key: 'tp3Rr',            type: 'float', min: 1.5,max: 8.0, step: 0.1,   default: 3.0,  label: 'TP3 R:R', desc: 'Третий тейк' },
          { key: 'useVolumeFilter',  type: 'bool',                                  default: false,label: 'Volume filter', desc: 'Требовать объёмный спайк' },
          { key: 'volMult',          type: 'float', min: 1.0,max: 3.0, step: 0.1,   default: 1.2,  label: 'Volume × avg', desc: 'Множитель от среднего объёма' },
        ],
      },
    ],
  },

  gerchik: {
    title: 'Gerchik (ключевые опорные точки)',
    description: 'Строгий ретест уровней с ≥3 касаниями, поглощающая свеча, объёмный спайк, по тренду HTF.',
    groups: [
      {
        title: 'Pivot & уровни',
        fields: [
          { key: 'pivotStrength',   type: 'int',   min: 3,   max: 15,  step: 1,    default: 5,   label: 'Pivot strength', desc: 'Баров слева/справа для swing' },
          { key: 'maxBarsLookback', type: 'int',   min: 100, max: 500, step: 10,   default: 300, label: 'Max lookback',   desc: 'Глубина анализа' },
          { key: 'minTouches',      type: 'int',   min: 2,   max: 6,   step: 1,    default: 3,   label: 'Min touches (KRP)',desc: 'Касаний уровня чтоб считать ключевым' },
          { key: 'clusterAtrMult',  type: 'float', min: 0.2, max: 1.5, step: 0.1,  default: 0.5, label: 'Cluster × ATR',   desc: 'Склейка близких уровней' },
          { key: 'topLevelsPerSide',type: 'int',   min: 1,   max: 10,  step: 1,    default: 3,   label: 'Top levels per side',desc: 'Сколько уровней учитывать' },
          { key: 'maxLevelAgeBars', type: 'int',   min: 50,  max: 500, step: 10,   default: 200, label: 'Max level age',   desc: 'Старый уровень игнорим' },
        ],
      },
      {
        title: 'Ретест',
        fields: [
          { key: 'retestZoneAtrMult', type: 'float',min: 0.1,max: 1.0, step: 0.05, default: 0.4, label: 'Retest zone × ATR',desc: 'Зона вокруг уровня для ретеста' },
          { key: 'requireCloseBack',  type: 'bool',                                default: true,label: 'Close back',      desc: 'Закрытие обратно за уровень' },
          { key: 'requireAbsorption', type: 'bool',                                default: true,label: 'Absorption candle',desc: 'Поглощающая свеча (hammer/engulfing) обязательна' },
        ],
      },
      {
        title: 'HTF тренд',
        fields: [
          { key: 'requireTrendAlignment', type: 'bool',                              default: true, label: 'HTF trend alignment', desc: 'Торговать только по тренду старшего TF' },
          { key: 'trendEmaPeriod',       type: 'int',  min: 20, max: 200, step: 10, default: 50,   label: 'Trend EMA period',    desc: 'Период EMA для тренда' },
          { key: 'volumeRatioMin',       type: 'float',min: 1.0,max: 3.0, step: 0.1,default: 1.5,  label: 'Volume × avg',        desc: 'Объёмный спайк минимум' },
        ],
      },
      {
        title: 'Risk',
        fields: [
          { key: 'slAtrMult',      type: 'float', min: 0.5, max: 3.0, step: 0.1, default: 1.0, label: 'SL × ATR',     desc: 'Стоп за уровень' },
          { key: 'tp1RR',          type: 'float', min: 1.0, max: 3.0, step: 0.1, default: 1.5, label: 'TP1 R:R',      desc: 'Первый тейк' },
          { key: 'tp2RR',          type: 'float', min: 1.5, max: 5.0, step: 0.1, default: 2.5, label: 'TP2 R:R',      desc: 'Основной тейк (Gerchik 2.5)' },
          { key: 'tp3RR',          type: 'float', min: 2.0, max: 8.0, step: 0.1, default: 3.5, label: 'TP3 R:R',      desc: 'Дальний тейк' },
          { key: 'minQuality',     type: 'int',   min: 1,   max: 10,  step: 1,   default: 6,   label: 'Min quality',  desc: 'Минимальный скор (0–10)' },
          { key: 'minRiskReward',  type: 'float', min: 1.0, max: 4.0, step: 0.1, default: 2.0, label: 'Min R:R',      desc: 'Фиксированный минимум Герчика' },
        ],
      },
    ],
  },

  levels: {
    title: 'Levels (отбой от уровня)',
    description: 'Классический S/R retest с расширенными порогами (чаще сигналы, чем Gerchik).',
    groups: [
      {
        title: 'Pivot',
        fields: [
          { key: 'pivotStrength',    type: 'int',   min: 3,  max: 15,  step: 1,   default: 5,   label: 'Pivot strength' },
          { key: 'maxBarsLookback',  type: 'int',   min: 100,max: 500, step: 10,  default: 300, label: 'Max lookback' },
          { key: 'clusterAtrMult',   type: 'float', min: 0.2,max: 1.5, step: 0.1, default: 0.5, label: 'Cluster × ATR' },
          { key: 'minTouches',       type: 'int',   min: 1,  max: 5,   step: 1,   default: 2,   label: 'Min touches' },
          { key: 'topLevelsPerSide', type: 'int',   min: 1,  max: 15,  step: 1,   default: 5,   label: 'Top levels per side' },
          { key: 'maxLevelAgeBars',  type: 'int',   min: 50, max: 500, step: 10,  default: 150, label: 'Max level age' },
        ],
      },
      {
        title: 'Ретест',
        fields: [
          { key: 'retestZoneAtrMult',type: 'float', min: 0.1,max: 1.0, step: 0.05,default: 0.4, label: 'Retest zone × ATR' },
          { key: 'requireCloseBack', type: 'bool',                                 default: true,label: 'Require close back' },
          { key: 'maxDistAtrMult',   type: 'float', min: 2,  max: 15,  step: 0.5, default: 8,   label: 'Max distance × ATR' },
          { key: 'minDistAtrMult',   type: 'float', min: 0.1,max: 1.0, step: 0.05,default: 0.25,label: 'Min distance × ATR' },
        ],
      },
      {
        title: 'Risk & quality',
        fields: [
          { key: 'slAtrMult',    type: 'float', min: 0.5,max: 3.0, step: 0.1, default: 1.0, label: 'SL × ATR' },
          { key: 'tp1RR',        type: 'float', min: 0.5,max: 3.0, step: 0.1, default: 1.0, label: 'TP1 R:R' },
          { key: 'tp2RR',        type: 'float', min: 1.0,max: 5.0, step: 0.1, default: 2.0, label: 'TP2 R:R' },
          { key: 'tp3RR',        type: 'float', min: 1.5,max: 8.0, step: 0.1, default: 3.0, label: 'TP3 R:R' },
          { key: 'minQuality',   type: 'int',   min: 1,  max: 10,  step: 1,   default: 5,   label: 'Min quality' },
          { key: 'minRiskReward',type: 'float', min: 1.0,max: 4.0, step: 0.1, default: 1.5, label: 'Min R:R' },
        ],
      },
    ],
  },

  scalping: {
    title: 'Scalping (быстрые сетапы на 1-15m)',
    description: 'Pullback к BB middle + RSI divergence + squeeze. Для внутридневной торговли.',
    groups: [
      {
        title: 'Индикаторы',
        fields: [
          { key: 'bbPeriod',      type: 'int',   min: 10, max: 50, step: 1,   default: 20,  label: 'Bollinger period' },
          { key: 'bbStdDev',      type: 'float', min: 1.5,max: 3.0,step: 0.1, default: 2.0, label: 'BB std dev' },
          { key: 'rsiPeriod',     type: 'int',   min: 7,  max: 30, step: 1,   default: 14,  label: 'RSI period' },
          { key: 'rsiOversold',   type: 'int',   min: 15, max: 40, step: 1,   default: 30,  label: 'RSI oversold' },
          { key: 'rsiOverbought', type: 'int',   min: 60, max: 85, step: 1,   default: 70,  label: 'RSI overbought' },
          { key: 'emaFast',       type: 'int',   min: 5,  max: 30, step: 1,   default: 9,   label: 'EMA fast' },
          { key: 'emaSlow',       type: 'int',   min: 15, max: 100,step: 1,   default: 21,  label: 'EMA slow' },
        ],
      },
      {
        title: 'Risk',
        fields: [
          { key: 'slAtrMult', type: 'float', min: 0.5,max: 2.5, step: 0.1, default: 1.0, label: 'SL × ATR' },
          { key: 'tp1RR',     type: 'float', min: 0.5,max: 2.0, step: 0.1, default: 0.8, label: 'TP1 R:R (scalp = быстрый тейк)' },
          { key: 'tp2RR',     type: 'float', min: 1.0,max: 3.0, step: 0.1, default: 1.5, label: 'TP2 R:R' },
          { key: 'minQuality',type: 'int',   min: 1,  max: 10,  step: 1,   default: 5,   label: 'Min quality' },
        ],
      },
    ],
  },

  dca: {
    title: 'DCA (усреднение на дипах)',
    description: 'Покупает на просадках к SMA-50, продаёт по лестнице TP. Работает в боковом / растущем рынке.',
    groups: [
      {
        title: 'Триггер',
        fields: [
          { key: 'smaPeriod',     type: 'int',   min: 20, max: 200, step: 5,   default: 50,  label: 'SMA period' },
          { key: 'dipPct',        type: 'float', min: 0.5,max: 10,  step: 0.5, default: 3.0, label: 'Dip % от SMA', desc: 'Какой дроп триггерит покупку' },
          { key: 'rsiFilter',     type: 'bool',                                 default: true,label: 'RSI фильтр (< 40)' },
        ],
      },
      {
        title: 'Ordering',
        fields: [
          { key: 'baseOrderSize',   type: 'float', min: 1,  max: 100, step: 1,   default: 10, label: 'Base order (USDT)' },
          { key: 'safetyOrders',    type: 'int',   min: 0,  max: 10,  step: 1,   default: 3,  label: 'Safety orders (докупки)' },
          { key: 'safetyStepPct',   type: 'float', min: 0.5,max: 10,  step: 0.5, default: 2,  label: 'Шаг между докупками %' },
          { key: 'safetyVolumeMult',type: 'float', min: 1.0,max: 3.0, step: 0.1, default: 1.5,label: 'Множитель размера докупки' },
        ],
      },
      {
        title: 'Take profit',
        fields: [
          { key: 'takeProfitPct', type: 'float', min: 0.5,max: 10,  step: 0.25,default: 1.5, label: 'TP % от средней цены' },
          { key: 'trailingTp',    type: 'bool',                                default: false,label: 'Trailing TP' },
        ],
      },
    ],
  },

  grid: {
    title: 'Grid (сеточная стратегия)',
    description: 'Равномерная сетка ордеров в заданном диапазоне. Работает в боковом рынке.',
    groups: [
      {
        title: 'Диапазон',
        fields: [
          { key: 'autoRange',      type: 'bool',                                default: true,label: 'Авто-определение диапазона' },
          { key: 'rangePct',       type: 'float', min: 1, max: 30, step: 0.5,  default: 5,   label: 'Ширина диапазона %' },
          { key: 'rangeLookbackBars',type: 'int', min: 50,max: 500,step: 10,   default: 200, label: 'Lookback для расчёта' },
        ],
      },
      {
        title: 'Сетка',
        fields: [
          { key: 'gridLevels',     type: 'int',   min: 3, max: 30, step: 1,    default: 10,  label: 'Количество уровней' },
          { key: 'orderSize',      type: 'float', min: 1, max: 100,step: 1,    default: 10,  label: 'Размер ордера (USDT)' },
          { key: 'takeProfitPct',  type: 'float', min: 0.2,max: 5, step: 0.1,  default: 0.8, label: 'TP между уровнями %' },
        ],
      },
      {
        title: 'Защита',
        fields: [
          { key: 'stopLossPct',    type: 'float', min: 1, max: 20, step: 0.5, default: 5,   label: 'SL при пробое диапазона %' },
          { key: 'pauseOnTrend',   type: 'bool',                              default: true,label: 'Пауза при сильном тренде' },
        ],
      },
    ],
  },
};

function listStrategies() {
  return Object.keys(SCHEMAS).map((key) => ({
    key,
    title: SCHEMAS[key].title,
    description: SCHEMAS[key].description,
  }));
}

function getSchema(strategy) {
  return SCHEMAS[strategy] || null;
}

function defaultConfig(strategy) {
  const s = SCHEMAS[strategy];
  if (!s) return {};
  const out = {};
  for (const g of s.groups) for (const f of g.fields) out[f.key] = f.default;
  return out;
}

// Validate a user-supplied strategy config against the strategy's schema.
// Returns a sanitised object (only known keys, coerced to declared type,
// clamped to declared min/max). Throws { code: 'VALIDATION_ERROR', issues }
// with concrete paths so the bot wizard can highlight bad fields.
//
// Without this, a frontend bug or malicious actor could send
// strategyConfig: { minConfirmations: 'abc' } / { lookback: 999999 } and
// scanner would NaN out or memory-spike on first run. Used by createBot
// and updateBot before INSERT/UPDATE.
function validateConfig(strategy, config) {
  const schema = SCHEMAS[strategy];
  if (!schema) {
    const e = new Error('Unknown strategy: ' + strategy);
    e.code = 'VALIDATION_ERROR';
    e.issues = [{ path: 'strategy', message: 'Unknown strategy: ' + strategy }];
    throw e;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};

  const allowed = new Map();
  for (const g of schema.groups) for (const f of g.fields) allowed.set(f.key, f);

  const issues = [];
  const out = {};
  for (const [key, raw] of Object.entries(config)) {
    const f = allowed.get(key);
    if (!f) continue; // silently drop unknown — matches Zod's default object stripping

    if (f.type === 'int' || f.type === 'float') {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        issues.push({ path: `strategyConfig.${key}`, message: `${key} must be a number, got ${typeof raw}` });
        continue;
      }
      if (f.type === 'int' && !Number.isInteger(n)) {
        issues.push({ path: `strategyConfig.${key}`, message: `${key} must be an integer` });
        continue;
      }
      if (typeof f.min === 'number' && n < f.min) {
        issues.push({ path: `strategyConfig.${key}`, message: `${key} must be >= ${f.min}` });
        continue;
      }
      if (typeof f.max === 'number' && n > f.max) {
        issues.push({ path: `strategyConfig.${key}`, message: `${key} must be <= ${f.max}` });
        continue;
      }
      out[key] = n;
    } else if (f.type === 'bool' || f.type === 'boolean') {
      out[key] = Boolean(raw);
    } else if (f.type === 'choice' || f.type === 'select') {
      const opts = Array.isArray(f.options) ? f.options.map((o) => (typeof o === 'object' ? o.value : o)) : null;
      if (opts && !opts.includes(raw)) {
        issues.push({ path: `strategyConfig.${key}`, message: `${key} must be one of: ${opts.join(', ')}` });
        continue;
      }
      out[key] = raw;
    } else {
      // Unknown field type — accept as-is to avoid blocking strategies
      // that haven't been schema-typed yet.
      out[key] = raw;
    }
  }

  if (issues.length) {
    const e = new Error('Strategy config validation failed');
    e.statusCode = 400;
    e.code = 'VALIDATION_ERROR';
    e.issues = issues;
    throw e;
  }
  return out;
}

module.exports = { SCHEMAS, listStrategies, getSchema, defaultConfig, validateConfig };
