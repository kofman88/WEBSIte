# Phase 8 — Отчёт (SMC + Scalping portированы из бота)

**Статус:** ✅ SMC + Scalping готовы. 🔶 **Gerchik отложен** (1500 строк Python, один модуль). **Phase 9 (Bayesian Optimizer) ждёт "go"**.

---

## 1. Что сделано

### Источники расшифрованы
В сессии использован `/home/user/WEBSIte/FULL_PROJECT_DUMP.txt` (≈60 тыс. строк Python). Извлечены 17 файлов бота в `/tmp/bot/` — референсы для порта:
```
scanner_mid.py       87 KB
backtest.py          62 KB
gerchik_strategy.py  55 KB   ← отложен, см. §3
scalping_strategy.py 20 KB   ← портирован
indicator.py         74 KB   ← основа уже в Phase 4
auto_trade.py        49 KB   ← Phase 10
signal_filter.py     15 KB   ← ML, упрощённая эвристика уже в qualityScorer
smc/*.py             ~70 KB  ← все 8 файлов портированы
```

### `strategies/smc/` — полный port (8 файлов)

```
strategies/smc/
├── config.js            — DEFAULT_CONFIG (18 параметров, 1-в-1 из Python SMCConfig)
├── structure.js         — findSwingHighs/Lows, detectTrend, detectBos, detectChoch
├── orderBlock.js        — getOrderBlocks (bull/bear OB + impulse FVG + 50% retrace + breaker)
├── fvg.js               — findFvgs, findFvgsAll, IFVGs, nearestFvg, getFvgAnalysis
├── liquidity.js         — findEqualLevels, detectSweep, findLiquiditySweeps
├── premiumDiscount.js   — getPremiumDiscount (строгий 50/50, DISCOUNT/PREMIUM)
├── analyzer.js          — оркестратор 5 шагов (Structure → Liquidity → OB → FVG → PD)
├── signalBuilder.js     — scoring-model для long/short + entry/SL/TP
└── index.js             — `scan(candles, cfg)` pure entry point
```

**Ключевые принципы перенесены:**
- **Body-Close confirmation**: BOS/CHoCH только при закрытии тела над уровнем. Wick-only → `wickSweep: true`, сигнала нет.
- **Strict 50/50 PD zone**: DISCOUNT < 50%, PREMIUM ≥ 50%. Только long в DISCOUNT, только short в PREMIUM.
- **Impulse FVG**: FVG между 1 и 3 свечами импульса после OB, как secondary-entry.
- **Breaker blocks**: митигированный OB противоположной стороны.
- **Volume filter**: soft (бонус к score) или hard (reject без объёма) в зависимости от `useVolumeFilter`.
- **7 confirmation factors**: trend, BOS, OB, liquidity sweep, PD zone, FVG, CHoCH + volume bonus. `minConfirmations=3` (как в боте).

**Упрощения от бота** (осознанные):
- Single-timeframe режим — бот хочет HTF+MTF+LTF, мы пока принимаем одну серию и используем её на всех уровнях. Когда scanner добавит fetchCandles для нескольких TF → можно будет разделить.
- Упрощённый IFVG — только для filled FVGs.
- signalBuilder: наш scoring получается проще чем 800+ строк Python `smc/signal_builder.py`. Функционально корректно, но без тонких edge-case rules. Калибровка против исторических сигналов бота — Phase 9.

### `strategies/scalping/` — полный port (1 файл, 300+ строк)

```
strategies/scalping/index.js
```

**Три подхода из бота, все портированы 1-в-1:**
1. **VWAP Bounce** — цена коснулась VWAP + volume ≥1.5× + close обратно через VWAP → long/short по EMA-тренду.
2. **Liquidity Grab** — wick пробивает recent high/low (lookback=20 баров), тело ≥25%, волна ≥ lg_wick_pct (55%) → long/short на отскок.
3. **Volume Spike** — объём ≥2.5× среднего + тело ≥55% бара → long/short по направлению свечи + EMA-alignment.

**Все 3 всегда пробуются**, лучший по RR выбирается.

**Риск-менеджмент:**
- SL **всегда структурный** (VWAP ± ATR или bar extreme ± 0.5 ATR).
- `clampSl` — адаптивный clamp SL: ≥ max(0.25%, 0.3×ATR%) и ≤ max(1%, 2×ATR%).
- TP = entry ± risk × (min_rr + 0.5) — то есть 2.5R+.
- ATR filter: пропуск если ATR > 5% цены (слишком волатильно).

### Интеграция

`workers/signalScanner.js` + `services/backtestEngine.js` обновлены:
```js
const STRATEGIES = {
  levels:   require('../strategies/levels'),
  smc:      require('../strategies/smc'),      // ← NEW
  scalping: require('../strategies/scalping'), // ← NEW
  // gerchik: deferred
};
```

Теперь юзер может:
- Создать бота с `strategy='smc'` → сканер производит SMC-сигналы каждые 60s
- Запустить backtest по SMC или scalping
- Plans.js gating: SMC требует `starter+`, scalping — `elite`.

### Тесты `tests/strategies.test.js` — **14 новых**

- `findSwingHighs` на inverted-V → pivot найден в середине
- `detectTrend` → `BULLISH` на HH+HL, `BEARISH` на LH+LL
- `detectBos` body-close = реальный BOS (не wickSweep)
- `findFvgs` обнаруживает bullish gap на 3-бар сетапе
- `getPremiumDiscount` → `DISCOUNT` / `PREMIUM` / `NEUTRAL` (с правильной проверкой 0 как валидного swing low)
- `findEqualLevels` кластеризует близкие цены
- `smc.scan()` null на малых данных, shape-check на случайных сериях
- `scalping.scan()` null на малых данных, signal-shape при volume spike
- `getOrderBlocks` на импульс-сетапе (проверка формата возврата)

---

## 2. Тесты

```
 ✓ tests/plans.test.js       (16)
 ✓ tests/crypto.test.js      (18)
 ✓ tests/auth.test.js        (16)
 ✓ tests/exchange.test.js    (10)
 ✓ tests/indicators.test.js  (34)
 ✓ tests/levels.test.js      (10)
 ✓ tests/signals.test.js     (14)
 ✓ tests/backtest.test.js    (13)
 ✓ tests/strategies.test.js  (14)   ← NEW (SMC + Scalping)

 Test Files  9 passed (9)
      Tests  145 passed (145)
   Duration  9.86s
```

---

## 3. 🔶 Gerchik — отложен до Phase 8.5

`gerchik_strategy.py` — **1500 строк**, плотно напичканных ATR-логикой, false-breakout rules, volume profile analysis. Это самая нагруженная стратегия бота. Честный порт требует:
- Полного чтения файла (сессия растянется)
- Тщательной проверки каждого SL/TP правила
- Отдельных тестов на 5-10 реальных ботовских сигналах

**Рекомендация:** Phase 8.5 — выделить отдельную сессию под Gerchik, когда будет возможность сравнивать с реальными ботовскими сигналами на BTCUSDT 1h. Пока что в scanner/backtest регистрируются только 3 стратегии (LEVELS, SMC, Scalping) — этого достаточно для MVP.

Если ты говоришь «нет, Gerchik сейчас» — сделаю в следующей сессии с фокусом 100% на него.

---

## 4. Калибровка LEVELS (отложено)

Я прочитал только config-блок `scanner_mid.py` — основные параметры хранятся в глобальном `CONFIG` dict в ~150 строках в начале файла. Их адаптация к нашему `strategies/levels/config.js` — **микрокалибровка**, важная но не блокер. Предлагаю сделать в Phase 14 (тестирование + деплой) вместе с reg-тестами против реальных свечей.

---

## 5. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | SMC signalBuilder упрощён (800 строк Python → 100 JS) → сигналы могут отличаться от бота | Структурные элементы (BOS, OB, FVG, PD zone) идентичны. Финальное scoring упрощено. Калибровка против реальных сигналов — в Phase 14 |
| R2 | Single-timeframe SMC теряет HTF-confluence | Когда scanner будет fetch'ить HTF параллельно — пропишется MULTI-tf. Сейчас достаточно для MVP |
| R3 | Scalping session filter не реализован (UTC 8-22) | По дефолту отключён, не критично. Добавлю если вернём `sessionFilter: true` |
| R4 | Gerchik отсутствует → тариф Pro не получает полный набор | Plan.js уже указывает gerchik только от `pro`. При отсутствии стратегии UI покажет "coming soon" |

---

## 6. Acceptance Phase 8

- [x] SMC: 8 файлов портировано из bot/smc/*.py
- [x] Scalping: все 3 подхода портированы из scalping_strategy.py
- [x] STRATEGIES registry обновлён в scanner + engine
- [x] Pure-function API (scan(candles, cfg) → Signal | null)
- [x] 14 новых тестов проходят
- [ ] Gerchik порт — **отложен до Phase 8.5**
- [ ] LEVELS calibration против scanner_mid defaults — **отложено до Phase 14**

---

## 7. Следующий шаг — Phase 9 (Bayesian Optimizer)

**Цель:** над backtestEngine построить парам-оптимизатор: ищем лучший `strategy_config` по objective (profit_factor / sharpe / winrate).

Python-бот использует Optuna (TPE), но в Node.js аналога нет. **План (из Phase 0 audit):**

### Вариант B: Grid + Random search (рекомендую для MVP)
```js
services/optimizer.js:
  gridSearch(cfg, paramSpace, objective) → {bestParams, allResults}
  randomSearch(cfg, paramSpace, nTrials, objective) → ...
```
Каждый trial запускает `backtestEngine.runBacktest()` под капотом, собирает метрики, сортирует.

**Walk-Forward validation:**
- 60% train / 20% validation / 20% test
- Best-params на train, verify на validation, final metric на test (unseen).

**Acceptance:**
- [ ] 5-param grid search для LEVELS → выдаёт top-3 конфига
- [ ] Walk-forward работает: test-period metrics ≤ train-period metrics (проверяет overfitting)
- [ ] Plan gating: optimizer — только Elite
- [ ] API: `POST /api/optimizations`, `GET /api/optimizations/:id`

Жду **"go"** на Phase 9.
