# Phase 7 — Отчёт (Backtest Engine)

**Статус:** ✅ Завершена. `Math.random()` мок **удалён** — реальный walk-forward движок. **Phase 8 (остальные стратегии) ждёт "go"**.

---

## 1. Что сделано

### `services/backtestEngine.js` — **600 строк**, настоящий движок

**Алгоритм (walk-forward, no look-ahead):**
```
Для каждого symbol:
  Fetch candles (через marketDataService с кэшем)
  Для каждой свечи i:
    1. Process OPEN positions против этой свечи (реалистичный порядок)
    2. Если ещё можем открыть (MAX_OPEN_PER_SYMBOL=1):
         window = candles[0..i]
         sig = strategy.scan(window, cfg)
         if sig: открыть virtual position
    3. Обновить equity curve
    4. Каждые 1000 свечей → UPDATE backtests.progress_pct
  При завершении: liquidate все open positions по close последней свечи
```

**Partial TP симуляция:**
- TP1 → закрыть 33%, двинуть SL в **BE** (breakeven)
- TP2 → закрыть 33%, trailing SL к TP1
- TP3 → закрыть остаток (34%)
- SL → закрыть остаток (`close_reason: sl` или `trailing_sl`)
- При касании SL+TP в одной свече: **SL выигрывает** (conservative) — честно, т.к. intra-bar order неизвестен

**Fee + slippage:** 0.05% + 0.02% на каждое исполнение (configurable через `risk_config`).

**Расчёт qty:** `equity * riskPct / abs(entry - stopLoss)` — риск одинаковый на всех сделках.

**Метрики результата** (`backtests.results` JSON):
- totalTrades, winningTrades, losingTrades, breakevenTrades
- winRatePct, totalPnlUsd, totalPnlPct
- maxDrawdownPct, maxDrawdownUsd
- maxConsecutiveWins, maxConsecutiveLosses
- avgWinUsd, avgLossUsd
- **profitFactor** (gross win / gross loss)
- **sharpeRatio** (daily returns, annualized √365)
- **sortinoRatio** (downside-only deviation)
- **calmarRatio** (total return % / max DD %)
- expectancyUsd
- avgTradeDurationHours
- bestTradePct, worstTradePct
- **equityCurve**: `[[timestamp, equity], ...]` для Chart.js
- **monthlyReturnsUsd**: `{"2025-01": 420, ...}`
- **bySymbol**: `{BTCUSDT: {trades, wins, pnl}, ...}`

**Персистим `backtest_trades`** — детали каждой сделки с entry/exit/PnL/close_reason для UI Detail View.

**Graceful failure:** `try/catch` вокруг всей runBacktest → если падает, `status=failed, error_message` сохраняется, а не виснет в `pending`/`running`.

### `services/backtestService.js` — rewrite
- `createBacktest(userId, cfg)` — проверка daily cap из plans.js + strategy gating, insert status=`pending`, enqueue в `p-queue concurrency=2`
- `getBacktest(id, userId)` — с scope check
- `listForUser(userId, {limit, offset})`
- `getTradesForBacktest(btId, userId, {limit, offset})` — пагинация сделок
- `deleteBacktest(id, userId)` — 404 для чужого
- `stats(userId)` — {total, completed, running, pending, failed}

### `routes/backtests.js` — 7 endpoints (все с zod + scope)
- `POST /api/backtests` — create (с gate, 403 BACKTEST_LIMIT_REACHED)
- `GET /api/backtests` — list
- `GET /api/backtests/stats` — aggregate
- `GET /api/backtests/:id` — single
- `GET /api/backtests/:id/trades?limit=&offset=` — детализация
- `DELETE /api/backtests/:id`

### Тесты `tests/backtest.test.js` — **13 новых**
- `_computeQty`: risk-adjusted (10k*1% / 2-dist = 50), zero-division safety
- `_simulateBarExit` LONG: SL exit, TP1 → move SL to BE, TP1+TP2 в одной свече → trail SL to TP1, TP1+TP2+TP3 → closed
- `_simulateBarExit` SHORT: mirrored cases
- `_buildMetrics`: winRate, profitFactor, drawdown, consecutive streaks
- **Service gating**: Free plan → BACKTEST_LIMIT_REACHED; Free+scalping → UPGRADE_REQUIRED
- **E2E**: seed 400 candles в `candles_cache` → run engine напрямую → status=`completed`, progress=100, duration > 0, trades persisted
- **Failure path**: unknown strategy → status=`failed` + error_message

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

 Test Files  8 passed (8)
      Tests  131 passed (131)
   Duration  13.07s
```

---

## 3. Что не сделано / отложено

- **WebSocket progress updates** — сейчас прогресс полится через `GET /api/backtests/:id` (frontend опросит каждые 2s). WS-push `{type:'backtest_progress', id, pct}` добавлю когда UI будет в Phase 11.
- **Multi-strategy backtest** — один бэктест = одна стратегия. Если юзер хочет SMC+LEVELS одновременно — пусть создаёт 2 бэктеста.
- **Walk-Forward оптимизация** — это Phase 9 (Optimizer). Сейчас всё на одном окне.
- **Funding rates** не учитываются для perp. Для spot — неважно. Для futures добавлю в `risk_config` optional.

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Несколько симуляций одновременно забивают CPU | `p-queue concurrency=2` глобально + плагинный gate |
| R2 | Завис backtest (зациклился) на >10 мин | Нет timeout'а. В Phase 14 добавлю `duration_ms > 600k → status=failed + cancel` |
| R3 | Large equity curve (1yr × 1h = 8760 точек) → тяжёлый JSON в БД | Equity curve сохраняется с шагом 50 баров → 175 точек для годового 1h. Нормально |
| R4 | `backtest_trades` неограниченно растут | Cascade delete при deleteBacktest → cleanup автоматом |
| R5 | CCXT fetchCandles недоступен → весь backtest падает | Try/catch per-symbol (не крашит всё), неудачные символы скипаются с warning |
| R6 | SL+TP в одной свече — rule conservative (SL first). Может занизить winrate vs реальности | Документировано в коде. Можно сделать optional `optimistic: true` в risk_config (P9) |

---

## 5. Acceptance Phase 7

- [x] `Math.random()` мок удалён — реальный движок
- [x] Walk-forward без look-ahead bias
- [x] Partial TP + trailing SL симуляция
- [x] Fee + slippage в каждом fill
- [x] Метрики: PnL, winrate, profit factor, Sharpe, Sortino, Calmar, max DD, expectancy, monthly returns, bySymbol
- [x] Equity curve для Chart.js
- [x] Per-trade детали в `backtest_trades`
- [x] Queue (p-queue concurrency=2)
- [x] Plan gating (daily cap + strategy)
- [x] 13 новых тестов passing
- [x] E2E test: seed candles → run → verify persisted status/progress/trades

---

## 6. Следующий шаг — Phase 8 (SMC + Gerchik + Scalping)

Три оставшиеся стратегии. **Блокер:** нужен доступ к `bot/CHM_BREAKER_V4/smc/*.py` + `gerchik_strategy.py` + `scalping_strategy.py` для 1-в-1 порта.

**Без бота** — генерик-реализации (как Phase 5):
- **SMC**: Order Blocks + FVG + BOS/CHoCH + liquidity sweeps
- **Gerchik**: pivot + ATR filter + false-breakout rules
- **Scalping**: EMA cross + RSI + volume на 1-5m

Все подключатся в `STRATEGIES` registry в `workers/signalScanner.js` и `services/backtestEngine.js` одной строкой каждая.

**Варианты:**
- **A.** Залить бот → портирую 1-в-1
- **B.** Делать generic (SMC уже публично хорошо описан, Gerchik — спорный, Scalping — базовая техника)
- **C.** Skip Phase 8 → Phase 9 (Optimizer) на одной LEVELS

Скажи **A/B/C + "го"** — пойдём дальше.
