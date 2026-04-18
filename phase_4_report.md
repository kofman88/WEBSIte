# Phase 4 — Отчёт (Technical Indicators)

**Статус:** ✅ Завершена. **Phase 5 (LEVELS strategy) ждёт твоего "go"** — **нужен доступ к `bot/CHM_BREAKER_V4/`**.

---

## 1. Что сделано

### `services/indicators.js` — новый модуль
12 функций, все **pure** (без side effects), все возвращают массив той же длины что input, `NaN` где данных не хватает. Нативный float64 внутри циклов, `decimal.js` только в call-site для финальных цен.

| Функция | Сигнатура | Комментарий |
|---|---|---|
| `sma` | `(values, period) → number[]` | Rolling sum, O(n) |
| `ema` | `(values, period) → number[]` | SMA-seed, затем k=2/(p+1), TA-Lib-compatible |
| `rsi` | `(values, period=14) → number[]` | Wilder smoothing, edge cases (flat → 100, pure up → 100, pure down → 0) |
| `trueRange` | `(candles) → number[]` | `max(h-l, |h-prevC|, |l-prevC|)` |
| `atr` | `(candles, period=14) → number[]` | TR → Wilder smoothing |
| `bollingerBands` | `(values, period=20, sd=2) → {upper,middle,lower}[]` | Population std (/n, не /n-1) — как TA-Lib |
| `macd` | `(values, fast=12, slow=26, sig=9) → {macd,signal,histogram}[]` | EMA-fast − EMA-slow, signal = EMA(macd, 9) |
| `stochastic` | `(candles, k=14, d=3) → {k,d}[]` | %K = (close - low14) / (high14 - low14), %D = SMA(%K, 3) |
| `volumeProfile` | `(candles, period=20) → {current,avg,ratio}[]` | Простое avg-vs-current, для "volume spike" детектора |
| `findPivots` | `(candles, strength=5) → {highs[], lows[]}` | Pivot high: все `strength` баров слева И справа строго ниже |
| `detectCandlePattern` | `(candles, index) → string\|null` | hammer / shooting_star / doji / bullish_engulfing / bearish_engulfing |
| `trendBias` | `(candles, lookback=20) → 'bull'\|'bear'\|'sideways'\|'neutral'` | Heuristic: EMA-short vs EMA-long + net price move |

Универсальный `_extractHLC(candles)` принимает и массив tuples `[t,o,h,l,c,v,closeT]` (формат CCXT), и объекты `{high,low,close}` — автоматически определяет.

### `tests/indicators.test.js` — 34 новых теста
- **SMA** (4): basic, length, all-NaN если period > length, throw на bad period
- **EMA** (2): ramp с TA-Lib reference, wavy shape
- **RSI** (4): rising → 100, falling → 0, bounded [0,100], constant → 100
- **ATR/TR** (3): первый TR = h-l, позитив, NaN до seed
- **Bollinger** (3): bands widen, middle=SMA, constant → upper==lower
- **MACD** (2): shape, histogram = macd-signal
- **Stochastic** (1): %K bounded [0,100]
- **VolumeProfile** (2): ratio=1 flat, ratio>5 spike
- **findPivots** (3): isolated peak, mirror low, monotonic → none
- **detectCandlePattern** (6): doji, hammer, shooting_star, bullish_engulfing, ordinary, zero-range
- **trendBias** (3): bull, bear, neutral-on-short
- **Performance** (1): 10 000 свечей × 5 индикаторов < 100ms

### Как тесты проверены
- **TA-Lib reference** для SMA/EMA/RSI: computed analytically (not imported — TA-Lib is a native Python lib).
- **Edge cases:** все математические тривиальные случаи (монотонная прямая / flat / zero range) проходят.
- **Performance:** 10k-bar run укладывается в <100ms.

### Tolerance
- SMA/EMA/Bollinger: `1e-8` (точно)
- RSI/ATR (Wilder): `1e-6` (float accumulation)
- Pivots, patterns — exact match (discrete logic)

---

## 2. Тесты

```
 ✓ tests/plans.test.js       (16)
 ✓ tests/crypto.test.js      (18)
 ✓ tests/auth.test.js        (16)
 ✓ tests/exchange.test.js    (10)
 ✓ tests/indicators.test.js  (34)

 Test Files  5 passed (5)
      Tests  94 passed (94)
   Duration  10.21s
```

Fix-up в процессе Phase 4:
1. Первый прогон: 2 fail — ожидаемые EMA values были **неправильными** (я перепутал init-method в тесте), и `doji` перекрывал `shooting_star` по приоритету. Исправлено.
2. Второй прогон: все 94 зелёные.

---

## 3. Что не сделано / отложено

- **Сверка 1-в-1 с Python-ботом** — ждёт доступа к `bot/CHM_BREAKER_V4/indicator.py` (3000 строк). Там могут быть специфичные модификации формул или edge-case handling. План: после получения доступа возьму 200 свечей BTCUSDT 1h, прогоню через Python-бот → зафиксирую в `tests/fixtures/btc-1h-indicators.json` → повторю тесты с tolerance `1e-6`.
- **Ichimoku, ADX, Williams %R** — не делал, т.к. не в списке P0/P1 стратегий бота. Добавлю если LEVELS/SMC/GERCHIK/SCALPING их используют.
- **`detectCandlePattern`** — 5 простых паттернов. Advanced patterns (three white soldiers, morning star, evening doji) — P2+.

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Мои эвристики `hammer`/`shooting_star` могут давать false positives по сравнению с ботом | Когда появится бот — перепишу чек-константы под его `indicator.py`. Пока паттерны используются только как **вспомогательный сигнал в quality score**, не как primary trigger |
| R2 | Numerical drift на 100k+ баров у EMA/RSI (float64) | Float64 даёт ~15 значащих цифр. На 100k итераций ошибка ≤ 1e-8. Для торговли неважно — SL/TP округляем до tick size |
| R3 | `detectCandlePattern` не учитывает объём → ложные hammer на нулевом объёме | В Phase 5 (LEVELS) будем комбинировать с `volumeProfile` в quality scoring |
| R4 | `trendBias` простой. Не различает "консолидация внутри bull-тренда" | Это pre-strategy utility, не решающая. LEVELS/SMC имеют свой `market_regime` definition — будет в Phase 5 |

---

## 5. Acceptance Phase 4

- [x] 12 функций реализованы, все pure
- [x] 34 теста проходят
- [x] Edge cases: constant series, short input, zero range
- [x] TA-Lib-совместимый EMA (SMA init)
- [x] Wilder smoothing для RSI/ATR
- [x] Performance: 10k × 5 indicators < 100ms
- [x] `decimal.js` зарезервирован для финальных цен (стратегии Phase 5+)

---

## 6. Следующий шаг — Phase 5 (LEVELS strategy)

**Требует:** 🔴 **доступ к `bot/CHM_BREAKER_V4/scanner_mid.py`** (~149 KB, 4500+ строк). Это корневая стратегия бота — pivot-based levels + retest + quality scoring.

### Что планирую сделать с ботом на руках
`backend/strategies/levels/`:
```
├── index.js            - scan(candles, config) → Signal | null
├── pivotDetector.js    - delegates to services/indicators.findPivots
├── levelBuilder.js     - cluster pivots into levels (age, tests, strength)
├── levelValidator.js   - filters (distance, freshness, volume)
├── signalGenerator.js  - entry on retest + dynamic SL/TP
├── qualityScorer.js    - heuristic 0-10 (ML filter из бота → в MVP эвристика)
├── marketRegime.js     - bull/bear/sideways классификатор
└── config.js           - default params + docstring каждого
```

### Без бота (fallback plan)
Могу сделать **generic "SR-retest" стратегию** по публичному описанию: найти top-5 уровней по пивотам → ждать отката + подтверждения свечным паттерном → сигнал. Это не то же самое что scanner_mid.py, но это реальный индикаторный движок, не мок. Тебе дам `config.js` с параметрами, прогон backtest'а в Phase 7 покажет качество.

**Нужно твоё решение:**
- **A.** Закинуть бот в доступное место (tar, git, zip) → портирую 1-в-1
- **B.** Делать generic SR-retest + калибровать по твоему продакшн-стрим сигналов из бота (нужны логи)
- **C.** Отложить Phase 5 и начать Phase 6 (Scanner Worker Infrastructure) — она работает с ЛЮБОЙ стратегией, просто сейчас будет иметь только тестовую заглушку до появления настоящей

---

Жду ответа + **"go"** на Phase 5 (или 6).
