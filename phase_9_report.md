# Phase 9 — Отчёт (Parameter Optimizer)

**Статус:** ✅ Завершена. **Phase 10 (Auto-trade) ждёт "go"**.

---

## 1. Что сделано

### `services/optimizer.js` — 240 строк

**3 функции:**
- `gridSearch({baseConfig, paramSpace, objective, maxCombos, userId})` — полный перебор с капом
- `randomSearch({..., nTrials})` — N случайных сэмплов из param-space
- `walkForward({..., method})` — 60/20/20 split: optimize на train → validate → test

**paramSpace** формат:
```js
{
  minQuality:      { type: 'int',    min: 3, max: 9, step: 1 },
  slAtrMult:       { type: 'float',  min: 0.5, max: 2.0, step: 0.25 },
  strategy:        { type: 'choice', choices: ['levels', 'smc'] },
}
```

**Objectives:** `profitFactor`, `sharpeRatio`, `sortinoRatio`, `totalPnlPct`, `winRatePct`, `expectancyUsd`.

**Walk-Forward pipeline:**
1. Split `[start, end]` → `train 60% / val 20% / test 20%`
2. Run search на train → bestParams
3. Re-run bestParams на validation → valScore
4. Re-run bestParams на test → testScore
5. Флаг `overfit: true` если `testScore / trainScore < 0.5`

**Важно:** каждый trial создаёт **эфемерный backtest row**, запускает engine, удаляет row после. Оптимизация не засирает `backtests` таблицу юзера.

### `services/optimizationService.js` — 130 строк

- `createOptimization(userId, cfg)` — **gate: Elite only** (403 `UPGRADE_REQUIRED`)
- Enqueue через `p-queue concurrency=1` (CPU-тяжёлое, не параллелим)
- `run(optId)` — выполняется в очереди, обновляет `trials_completed`, финализирует `best_params` + `best_score`
- `getOptimization(id, userId)` / `listForUser()` / `deleteOptimization()`

**Персист в `optimizations.best_params` (JSON)**:
```json
{
  "params": { "minQuality": 6 },
  "trainScore": 2.31,
  "valScore": 1.85,
  "testScore": 1.92,
  "overfit": false,
  "split": { "trainStart": ..., "trainEnd": ..., "valEnd": ..., "testEnd": ... },
  "topResults": [
    { "params": { "minQuality": 6 }, "score": 2.31 },
    { "params": { "minQuality": 5 }, "score": 2.11 },
    ...
  ]
}
```

### `routes/optimizations.js` — 5 endpoints

- `POST /api/optimizations` — create (Elite-only, zod-валидация включая типы param-spec'ов)
- `GET /api/optimizations` — list
- `GET /api/optimizations/:id`
- `DELETE /api/optimizations/:id`
- `GET /api/optimizations/meta/objectives` — список поддерживаемых objective'ов

Всё защищено `requireFeature('optimizer')` — выдаёт 403 `UPGRADE_REQUIRED` + `requiredPlan: 'elite'`.

### `server.js` — подключено
```js
app.use('/api/optimizations', optimizationsRoutes);
```

### Тесты `tests/optimizer.test.js` — **8 новых**

- **enumerateGrid**: cartesian product 3×3 int, choice+int, maxCombos cap
- **sampleRandom**: int/float/choice — все в пределах range, корректные типы
- **splitDates**: 60/20/20 порядок корректный
- **gridSearch E2E**: seed 300 candles → запустить 3-trial grid → получить valid `bestParams` + cleanup эфемерных backtests
- **Gating**: Pro plan → 403 UPGRADE_REQUIRED, Elite → queue enqueue
- **Concurrent runner**: optimization попадает в очередь и статус корректно меняется

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
 ✓ tests/strategies.test.js  (14)
 ✓ tests/optimizer.test.js   (8)   ← NEW

 Test Files  10 passed (10)
      Tests  153 passed (153)
   Duration  10.29s
```

---

## 3. Что не сделано

- **Bayesian (TPE)** — в Node.js нет зрелого пакета. Grid + Random покрывают 80% случаев. При накоплении данных (>10k trials) можно добавить `optuna-js` (непроверенный) или экспорт в Python.
- **WebSocket progress для оптимизатора** — сейчас fronted polls `GET /api/optimizations/:id` каждые 2s. Добавлю WS в Phase 11 (frontend integration).
- **Paralleled trials** — сейчас trials выполняются последовательно. На многоядерной машине можно добавить `worker_threads` пул. Отложил до Phase 14 (tuning).

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Большой grid забьёт очередь → другие юзеры ждут | `concurrency: 1` + `maxCombos: 50` per trial-run cap. Elite users могут запускать по одному; при росте юзеров — добавить priority queue |
| R2 | Overfitting при агрессивном tuning | Walk-forward flag `overfit: true`. Юзер видит `testScore << trainScore` и не применяет params в бою |
| R3 | Оптимизация на 1-year grid × 100 params = часы | Hard cap `maxCombos: 50` + `nTrials: 100`. UI покажет прогноз длительности |
| R4 | Trial падает из-за отсутствия свечей | `runTrial` ловит `engine.runBacktest()` exceptions, ставит score = -Infinity, идёт дальше |

---

## 5. Acceptance Phase 9

- [x] Grid search работает (enumerate + runTrials + bestOf)
- [x] Random search работает (sampleRandom + nTrials)
- [x] Walk-forward validation: train/val/test с overfit-flag
- [x] Plan gating: Elite-only, Pro/Starter/Free → 403
- [x] Ephemeral backtests cleanup (optimizer не засирает backtests таблицу)
- [x] 5 REST endpoints с zod + scope check
- [x] 8 новых тестов passing

---

## 6. Следующий шаг — Phase 10 (Auto-trade Executor)

Самая опасная часть проекта — баг здесь = потеря реальных денег.

**Файлы-референсы из бота** (уже в `/tmp/bot/`):
- `auto_trade.py` — 3500 строк оркестратора
- (partial_tp и sl_verifier объединены в auto_trade.py в нашей версии бота)

**План:**
1. `services/autoTradeService.js`:
   - `executeSignal(signal, bot)` — проверки баланса, sizing, place entry+SL+TP1/TP2/TP3 через CCXT
   - **Paper mode** default; live → manual confirm modal в UI
   - **Circuit breaker**: 10% суточного loss → автопауза всех ботов юзера
2. `services/partialTpManager.js` — watch open trades, двиг SL в BE после TP1, trail после TP2
3. `services/slVerifier.js` — cron каждую минуту: проверка что SL реально на бирже
4. Bridge в `server.js`: `auto_trade_request` от worker → `autoTradeService.executeSignal()`
5. Тесты в paper-mode (polished simulation без реальных ордеров)

**Acceptance:**
- Paper-trade end-to-end: сигнал → виртуальная позиция → TP1 → SL в BE → TP2 → TP3 closed
- Live testnet (Bybit demo) с реальными ордерами
- Circuit breaker срабатывает на тестовом сценарии
- Zero случаев «ордер размещён без SL» в тестах

Жду **«го»** на Phase 10.
