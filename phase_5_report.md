# Phase 5 — Отчёт (LEVELS strategy, generic SR-retest)

**Статус:** ✅ Завершена. **Phase 6 (Scanner Worker) ждёт твоего "go"**.

**Важное уведомление:** реализована **generic SR-retest** (вариант B). Когда появится доступ к `bot/CHM_BREAKER_V4/scanner_mid.py` — параметры `config.js` перекалибруются + QualityScorer заменится на port из Python (или ONNX-модель). Пока что: честно работающая стратегия, не мок.

---

## 1. Что сделано

### `strategies/levels/` — 6 файлов, 420 строк
```
levels/
├── config.js           - DEFAULT_CONFIG (19 параметров с docstring каждого)
├── levelBuilder.js     - clusterPivots() + buildLevels() → Array<Level>
├── marketRegime.js     - classifyRegime() → 'bull' | 'bear' | 'sideways'
├── qualityScorer.js    - scoreSignal() → 0..10 (7 факторов)
├── signalGenerator.js  - generateSignal() → {entry, SL, TP1, TP2, TP3}
└── index.js            - scan(candles, cfg) → Signal | null (pure function)
```

### Алгоритм `scan()`

1. **Guard**: ≥ `pivotStrength*2+10` свечей (иначе null).
2. **ATR** через `indicators.atr(candles, 14)` — нужна для шкалы всех порогов.
3. **buildLevels**:
   - Находим пивоты через `indicators.findPivots(candles, strength)`
   - Сортируем по цене, кластеризуем: два пивота мержатся, если `|Δprice| ≤ clusterAtrMult * ATR`
   - Фильтруем по `minTouches` (по умолчанию 2)
   - Топ-5 уровней с каждой стороны (support + resistance) по убыванию touches → recency
4. **Market regime**: EMA-short vs EMA-long + slope → `bull`/`bear`/`sideways`.
5. **Retest check** для каждого уровня:
   - **Support (long)**: `low` бара зашёл в зону `±retestZoneAtrMult*ATR` от уровня И `close > level.price` (если `requireCloseBack`).
   - **Resistance (short)**: зеркально.
   - Расстояние от цены до уровня в пределах `[minDistAtrMult, maxDistAtrMult] * ATR`.
   - Возраст уровня ≤ `maxLevelAgeBars`.
6. **generateSignal**: entry=close, SL=level∓slAtrMult*ATR, TP1/2/3 по RR-мультипликаторам. Геометрия проверяется (SL на правильной стороне от entry).
7. **qualityScorer** (0..10):
   - Touches (3→+1, 4+→+2)
   - Volume ratio (≥1.2×→+1, ≥2.0×→+2)
   - RR (≥2→+1, ≥3→+2)
   - HTF regime aligned (+1)
   - RSI в нейтральной зоне (35-55 long / 45-65 short) (+1)
   - Свечной паттерн (hammer/engulfing) (+1)
   - Свежесть (last touch ≤ 20 баров назад) (+1)
8. **Фильтры финала**: quality ≥ minQuality, RR ≥ minRiskReward.
9. **Confidence**: линейная мапа quality → 50..95 на выходе.

### Формат сигнала
```js
{
  strategy: 'levels',
  side: 'long' | 'short',
  entry: number,           // rounded to 8 decimals
  stopLoss, tp1, tp2, tp3,
  riskReward: 1.0,         // RR к TP1
  quality: 0..10,
  confidence: 50..95,
  reason: "Retest support @ 100.5 (3 touches) + bull regime + vol 1.8x + hammer RR=1.0",
  metadata: {
    level: { price, side, touches, firstTouch, lastTouch },
    regime: 'bull' | 'bear' | 'sideways',
    volumeRatio: number,
    rsi: number,
    atr: number,
    candlePattern: string | null,
  }
}
```

### Тесты `tests/levels.test.js` — 10 новых
- Smoke: null на мало данных, null на монотонной серии
- Support retest → long signal shape
- Resistance retest → short signal shape
- Геометрия: SL на правильной стороне от entry, TP1<TP2<TP3 (long) / TP1>TP2>TP3 (short)
- `DEFAULT_CONFIG` frozen
- Config overrides (`minQuality` гейт)
- **Shape-validator** на 5 псевдослучайных сериях — гарантия что каждый выданный сигнал полностью валиден
- Performance: 300-bar × 10 scans, avg < 50ms

---

## 2. Тесты

```
 ✓ tests/plans.test.js       (16)
 ✓ tests/crypto.test.js      (18)
 ✓ tests/auth.test.js        (16)
 ✓ tests/exchange.test.js    (10)
 ✓ tests/indicators.test.js  (34)
 ✓ tests/levels.test.js      (10)

 Test Files  6 passed (6)
      Tests  104 passed (104)
   Duration  10.11s
```

Housekeeping:
- `.gitignore`: добавил `*.db-wal`, `*.db-shm`, `data/`
- Удалил из tracking accidentally-committed тестовые WAL-файлы (Phase 4 ошибка)

---

## 3. Что не сделано / отложено

### Калибровка с ботом (P5.5 after bot access)
- Параметры `config.js` — generic, могут расходиться с продакшн-ботом на ±10-30% по количеству сигналов.
- QualityScorer — эвристика. Когда дашь `signal_filter.py` (XGBoost), рассмотрю ONNX-экспорт модели.
- Exact retest-logic бота (zone math, wick handling, breakeven rules) может отличаться. Сейчас: "дип в зону + close-back".

### Не реализовано (не P0)
- **Anti-retest detection** — когда уровень пробит и возвращается с обратной стороны (бот это делает). Добавлю если `scanner_mid.py` это делает.
- **Multi-timeframe confluence** — проверка что уровень на HTF подтверждён. Пока trend-regime даёт +1 балл, но не жёсткий фильтр.
- **Level decay** — уровни старше N баров затухают плавно, не резко. Сейчас бинарное `maxLevelAgeBars`.

### Fixture-тесты против бота
После доступа к `bot/` — возьму 20 реальных ботовских сигналов LEVELS, прогоню мою `scan()` на тех же свечах, сравню:
- Если ≥ 80% сигналов совпадают по side + ±5% по entry → generic работает приемлемо
- Если <50% — перекалибрую config + попробую ONNX

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Generic ≠ бот → юзеры видят разные сигналы чем в канале | Пока бот-аудитория отдельная. Когда переводим — сообщаем «обновлённый сканер v3.0, параметры переработаны». После калибровки разница ≤ 10% |
| R2 | Квантование ATR → ложные retest'ы на высоковолатильных парах | retestZoneAtrMult=0.4 консервативно. Можно поднять до 0.6 в тестах |
| R3 | qualityScorer дает 8+ слишком легко → спам сигналов | minQuality=5 по умолчанию режет. В тестах видно — на плоских сериях signal=null |
| R4 | findPivots с `strength=5` пропускает короткие пивоты → мало уровней на coin с низкой волатильностью | Юзерский override `pivotStrength=3` для alt-коинов. Добавить auto-tuning в Phase 9 (Optimizer) |

---

## 5. Acceptance Phase 5

- [x] Pure `scan(candles, config) → Signal | null`
- [x] 6 модулей: config, levelBuilder, marketRegime, qualityScorer, signalGenerator, index
- [x] Все параметры задокументированы в config.js
- [x] Сигнал имеет полную схему: entry + SL + TP1/2/3 + quality + confidence + reason + metadata
- [x] Геометрия SL/TP проверяется (reject если SL на неверной стороне)
- [x] RR filter + quality filter работают
- [x] 10 тестов passing, включая shape-validator на random-данных
- [x] Performance < 50ms per scan на 300 свечах

---

## 6. Следующий шаг — Phase 6 (Scanner Worker)

**Цель:** фоновый процесс, который каждые N секунд для каждого активного бота:
1. Подгружает свечи через `marketDataService.fetchCandles`
2. Вызывает `strategies[bot.strategy].scan(candles, config)`
3. Проверяет `signal_registry` — новый ли это сигнал (антидубль)
4. Если новый — вставляет в БД, броадкастит через WebSocket
5. Если `bot.auto_trade=true` — дёргает `autoTradeService` (P10)

**Архитектурное решение требует ответа:**
- **A.** `worker_threads` внутри `server.js` — Passenger-friendly, проще деплой, риск блокировки event-loop
- **B.** Отдельный процесс `node workers/signalScanner.js` + PM2 — чище разделение, требует SSH + PM2 на сервере
- **C.** `node-cron` внутри server.js — simplest, полагается на Passenger держать процесс живым

Скажи **A/B/C** + «го» — делаю.

Если игнорить — пойду по **A** (`worker_threads`), как наименее ломающий текущий setup.

---

Жду **"go"** на Phase 6.
