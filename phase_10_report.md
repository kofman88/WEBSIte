# Phase 10 — Отчёт (Auto-trade Executor)

**Статус:** ✅ Завершена. Paper mode полный, live готов (требует testnet-проверки). **Phase 11 (Frontend Integration) ждёт "go"**.

---

## 1. Что сделано

### `services/circuitBreaker.js` — охрана от просадок (150 строк)

- `check(userId, {referenceBalance, dailyLossPct, tradingMode})` — pre-trade проверка
- `trip(userId, {...})` — помечает breaker в `system_kv` под ключом `breaker:user:<id>` И **автоматически ставит `is_active = 0` всем активным ботам юзера**
- `reset(userId)` — ручной сброс (через admin / settings)
- Auto-reset через 24ч (из UTC midnight)
- Audit-log: `circuit_breaker_tripped`, `circuit_breaker_reset`

### `services/autoTradeService.js` — ядро (270 строк)

**Функция `executeSignal(signal, bot, {exchangeService, marketData})`:**

6 проверок по очереди перед размещением:
1. **Plan gate** — `plans.canUseFeature(plan, 'autoTrade')` (Pro+)
2. **Circuit breaker** — если трип, блок
3. **Max open trades** — подсчёт `trades` со `status='open'`
4. **Leverage cap** — `min(bot.leverage, plan.maxLeverage)`
5. **Balance** — paper: `system_kv` per-bot equity (fallback 10k); live: `exchangeService.getBalance(keyId)`
6. **Quantity** — `equity × riskPct / slDist × leverage`

**Paper mode (default):**
```
INSERT trades (..., status='open', trading_mode='paper', exchange_order_ids=JSON({paper:true}))
INSERT trade_fills (event_type='entry', ...)
audit_log: auto_trade.paper.open
```

**Live mode (Pro/Elite with exchange_key_id):**
```
client.setLeverage(N, symbol)           // best-effort
client.createMarketOrder(symbol, buy/sell, qty)  // entry
client.createOrder('stop_market', reduce-only, stopPrice: SL) // SL
  → if SL fails: emergency close entry (market reduce-only)
client.createOrder('limit', reduce-only, TP1) × 33%
client.createOrder('limit', reduce-only, TP2) × 33%
client.createOrder('limit', reduce-only, TP3) × 34%
exchange_order_ids = JSON with {entry, sl, tp1, tp2, tp3}
```

**⚡ Принцип №1: никогда не открывается позиция без SL.** Если `createOrder(stop_market)` падает — emergency market close entry, trade не попадает в БД как `open`.

### `services/partialTpManager.js` — следилка за TP/SL (230 строк)

**Cron в `server.js` каждые 60s вызывает `tickOpen()`:**
- Для каждого `status='open'` trade:
  - **Paper**: fetch candles since `opened_at`, проверяем high/low каждой свечи:
    - `bar.low <= SL` (long) / `bar.high >= SL` (short) → закрыть остаток, `close_reason = sl | trailing_sl`
    - `bar.high >= TP1` → 33% close, **SL → entry (breakeven)**
    - `bar.high >= TP2` → 33% close, **SL → TP1 (trailing)**
    - `bar.high >= TP3` → closed
  - **Live**: poll через `ccxt.fetchOrder` — MVP-stub, реальная reconciliation-логика в Phase 14
- Обновляет `trade_fills` + `trades.stop_loss` + `trades.status/exit_price/realized_pnl`
- Paper equity в `system_kv` обновляется после закрытия

**Fees в paper**: 0.05% + 0.02% slippage на каждый fill.

### `server.js` — bridge
- `auto_trade_request` от scanner worker → async handler → `autoTradeService.executeSignal()` + WS broadcast `trade_opened` юзеру
- `startPartialTpCron()` — setInterval 60s, работает всегда когда сервер жив
- Тесты с `VITEST=true` / `SCANNER_DISABLED=1` не стартуют ни то ни другое

### Тесты `tests/autoTrade.test.js` — **12 новых**

**autoTradeService paper:**
- Открывается с правильным qty (=20 при equity 10k, riskPct 1%, sl dist 5)
- `entry = 100, SL = 95, TP1/2/3 = 105/110/115` → все поля в trade + fill записан
- Starter plan (нет `autoTrade` фичи) → `null`
- max_open_trades=1 → второй сигнал → `null`
- SL == entry → qty=0 → `null`

**Circuit breaker:**
- No losses → allow
- Loss 1500 за 1h (>10% from 10k) → CIRCUIT_BREAKER_TRIPPED
- trip() ставит `is_active = 0` на всех ботах юзера
- reset() чистит state
- Auto-trade блокируется когда breaker tripped

**partialTpManager paper E2E:**
- Свеча с low < SL → закрывает со `close_reason = 'sl'`
- Свеча high ≥ TP1 (не TP2) → TP1 fill записан, `stop_loss` двинут в `entry_price` (BE)

**qty sizing:**
- leverage linear scaling (×5 lev = ×5 qty)

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
 ✓ tests/optimizer.test.js   (8)
 ✓ tests/autoTrade.test.js   (12)  ← NEW

 Test Files  11 passed (11)
      Tests  165 passed (165)
   Duration  10.28s
```

---

## 3. Что не сделано / отложено

### Live mode reconciliation (Phase 14)
- `partialTpManager._processLive()` — сейчас stub. Полная реализация: `ccxt.fetchOrder` для каждого `exchange_order_ids[*]`, если filled → insert `trade_fills` + edit SL на бирже. Требует тестнет-прогонa.

### `services/slVerifier.js` cron (Phase 14)
- Каждую минуту: `ccxt.fetchOpenOrders`, убедиться что SL действительно стоит. Если пропал (биржевой баг / ручная отмена) — переставить.
- Если цена уже пробила SL, а трейд живой → force-close market + алерт.
- Откладываю до тестнет-фазы — без реальных orderID'ов логику не отладить.

### Manual-confirm modal для live switch
- Сейчас переключение `trading_mode='live'` на боте — просто UPDATE в БД. В Phase 11 (UI) добавлю modal: «Вы уверены? Убытки реальны. Депозит $X». Бэкенд уже различает `paper` vs `live` и правильно маршрутизирует.

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Баг в live-mode → реальные убытки | **Paper-mode default** + CircuitBreaker. Live требует UI-подтверждения (Phase 11) + testnet-прогон (Phase 14) |
| R2 | SL placement fails after entry → naked позиция | Hardcoded emergency close market reduce-only, ошибка наверх → trade не попадает в БД как open |
| R3 | CircuitBreaker тротит ботa надолго из-за one-off loss | Auto-reset через 24ч + manual reset endpoint (добавлю в P11) |
| R4 | partialTpCron не запускается на Passenger при idle → trades стоят не закрытыми | Passenger даёт heartbeat запросы. Trade sync при первом запросе-воркеру. Cron внутри server.js — живёт вместе с процессом |
| R5 | partialTpManager берёт свечи по очереди — медленно при 100+ open trades | Пока приемлемо (60s cycle, ~1 trade/100ms). При росте — parallelise через `p-queue` |
| R6 | Paper equity per-bot в `system_kv` не переносится при delete бота | Ключ `paper_equity:bot:N` — cleanup в deleteBot service (добавлю в P14) |
| R7 | Идемпотентность: signal может прилететь дважды из worker | signalRegistry уже дедублирует на уровне signals table. Если дойдёт — `openCount >= max_open_trades` защищает |

---

## 5. Acceptance Phase 10

- [x] Paper trade: signal → position → TP1 → SL→BE → TP2 → trail → TP3 / SL closed
- [x] Circuit breaker: -10% daily → автопауза ботов
- [x] Plan gating: starter plan → auto_trade blocked
- [x] max_open_trades respect
- [x] Leverage cap из plan.maxLeverage
- [x] SL mandatory: emergency close если SL не поставился
- [x] WS broadcast `trade_opened` юзеру
- [x] 12 новых тестов passing
- [ ] Live reconciliation (Phase 14, testnet)
- [ ] slVerifier cron (Phase 14, testnet)
- [ ] UI manual-confirm (Phase 11)

---

## 6. Следующий шаг — Phase 11 (Frontend Integration)

Переписать фронт под реальные API (сейчас статический редизайн + заглушки):

### План (~1 день работы):
1. **`dashboard.html`** — total PnL / active bots / open trades / today signals. Equity chart. Последние сделки/сигналы.
2. **`bots.html`** — CRUD с multi-step modal (биржа → стратегия с 🔒 по плану → символы → risk config → paper/live confirm).
3. **`signals.html`** — live WS feed, фильтры, карточки.
4. **`backtests.html`** — форма + прогресс-бар через polling `/api/backtests/:id` + детали.
5. **`settings.html`** — профиль + API-ключи + subscription + notifications.
6. **`wallet.html`** — ref-програма + история начислений.
7. **`app.js`** — WS-connection global, toast-errors, i18n.

Всё на vanilla JS (keep simple stack) + уже существующий `styles.css`.

Жду **«го»** на Phase 11.
