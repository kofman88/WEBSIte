# Phase 6 — Отчёт (Signal Scanner Worker)

**Статус:** ✅ Завершена. **Phase 7 (Backtest Engine) ждёт твоего "go"**.

---

## 1. Что сделано

### `services/signalRegistry.js` — fingerprint-дедуп
- `fingerprint({exchange, symbol, strategy, side, entry, timeframe})` → sha256 32-char
- **Бакетирование entry**: 0.1% magnitude — цена 50000.0 и 50000.1 → одинаковый бакет → один fingerprint. Защита от микросдвигов entry, которые иначе пробивали бы дедуп.
- `isDuplicate(fp)` — проверка живого дубля (не истёк TTL 24h)
- `register(fp, signalId, ttlMs)` — atomic upsert: новый или перезаписать истёкший
- `cleanupExpired()` — cron helper (чистит expired записи)

### `services/signalService.js` — полный rewrite под новую схему
Упразднил legacy `signal_history` таблицу из pre-v3 кода. Всё на `signals` с правильными FK.

API:
- `insert(sig)` → Signal | null (дубль отклоняется через registry)
- `getById(id)` / `listForUser(userId, filters)` / `listPublic(filters)`
- `stats(userId?)` → `{total, wins, losses, winRate, avgConfidence, avgQuality, …}`
- `recordResult(signalId, {result, resultPrice, resultPnlPct})`
- `getPrefs(userId)` / `updatePrefs(userId, patch)` — авто-создание defaults
- `trackView(userId, signalId)` + `viewsToday(userId)` + `freeDailyLimitHit(userId, plan)` — лимит для Free-тарифа

### `services/websocketService.js` — полный rewrite
Убрал legacy reference на `signal_history`. Добавил:
- `broadcastPublic(payload)` — всем клиентам
- **`broadcastToUser(userId, payload)`** — только авторизованным сокетам этого юзера (нужно для scanner worker, чтобы персональные сигналы летели только своему юзеру)
- `broadcastSignal(signal)` — умный роутер: публичный сигнал → всем, персональный → только владельцу
- Heartbeat (ping каждые 30s, терминирование мёртвых)
- Клиент аутентифицируется через `{type:'auth', token:'Bearer <JWT>'}` первым сообщением

### `workers/signalScanner.js` — фоновый воркер (worker_thread)
Главная петля — раз в `SCAN_INTERVAL_MS` (default 60s):
1. Читает `trading_bots WHERE is_active=1`
2. Для каждого бота:
   - Парсит `symbols` JSON-массив
   - Для каждого символа (через `p-queue` concurrency=3 per exchange):
     - `marketData.fetchCandles(exchange, symbol, timeframe, 300 bars)`
     - `strategies[bot.strategy].scan(candles, bot.strategy_config)`
     - Direction filter (если `bot.direction` не `both` — фильтрует)
     - `signalService.insert(...)` → dedup через registry
     - `parentPort.postMessage({type:'signal', signal, botId})` → родительский процесс броадкастит через WebSocket
     - Если `bot.auto_trade` → `postMessage({type:'auto_trade_request', ...})` (P10 повесит handler)
   - `UPDATE trading_bots.last_run_at`
3. Ждёт drain всех очередей (cap SCAN_INTERVAL-2s)
4. `registry.cleanupExpired()` — уборка

**Запуск в двух режимах:**
- **worker_thread** (prod): из `server.js`, общается через `parentPort.postMessage`
- **standalone** (dev): `npm run worker` — для отладки в отдельной консоли

### `server.js` — bridge к scanner worker
- `startScannerWorker()` — спавнит `Worker(path, {env})`, вешает listener на 3 типа сообщений: `signal` (брoadcast), `auto_trade_request` (stub), `stopped`.
- **Auto-restart**: при exit code ≠ 0 → рестарт через 5s (если не был явный stop).
- `stopScannerWorker()` — posts `{type:'stop'}`, ждёт 3s, терминирует.
- SIGTERM/SIGINT handler теперь `async` — ждёт стоп воркера до закрытия БД.
- `SCANNER_DISABLED=1` в env → скипает запуск (для тестов).

### `routes/signals.js` — переработан
- `GET /api/signals` (authed) — c фильтрами `limit/offset/strategy/symbol`. **Free-тариф** получает 403 `SIGNAL_LIMIT_REACHED` после дневного лимита.
- `GET /api/signals/public` — public signals без auth, ≤ 20
- `GET /api/signals/stats/me` (authed) — winrate / total / pending
- `GET /api/signals/stats/global` — глобальная статистика
- `GET /api/signals/prefs/me` / `PATCH /api/signals/prefs/me` — фильтры юзера
- `GET /api/signals/:id` (authed) — scope-checked + `trackView`
- Все с zod-валидацией + error codes

### Тесты `tests/signals.test.js` — 14 новых
- **signalRegistry** (5): deterministic fingerprint, price bucketing (50000.0 ≡ 50000.1), side distinction, lifecycle (insert → dup → no-op), cleanupExpired
- **signalService.insert** (2): успех + дедуп, metadata round-trip как объект
- **signalService.stats** (1): winrate calculation корректно
- **signalService.prefs** (2): auto-create defaults, update merge
- **GET /api/signals** (2): authed returns signals, 401 без auth
- **GET /api/signals/public** (1): public signals без auth
- **Free-tier limit** (1): 3 views → 4-й запрос → 403 SIGNAL_LIMIT_REACHED

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

 Test Files  7 passed (7)
      Tests  118 passed (118)
   Duration  10.24s
```

Fix-up: 3 теста исходно падали на FK-констрейнте `signal_registry.signal_id → signals.id` и `signal_views.signal_id → signals.id` — тесты создавали fingerprints/views с `signal_id=1` без реального сигнала. Исправлено: сначала реальный `signalService.insert()`, потом используем полученный `.id`.

---

## 3. Что не сделано / отложено

- **Auto-trade bridge** — в server.js `auto_trade_request` сейчас just logs. Phase 10 прокинет в `autoTradeService.execute()`.
- **SMC / Gerchik / Scalping** — не подключены в `STRATEGIES` registry — Phase 8 их добавит (требует доступ к боту).
- **Signal результаты tracking** — сканер только создаёт сигналы, watch'а цены для определения win/loss нет. Это отдельный worker для **signal outcome tracking** — `recordResult()` уже есть в service, нужен только cron-call. Отложил до Phase 10 (auto-trade) — они пересекаются по логике.

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Passenger убивает idle Node-процесс → worker_thread тоже умирает | Auto-restart при exit ≠ 0 + Passenger keepalive. Первый запрос после idle заново запустит scanner. Приемлемо для MVP |
| R2 | Ошибка в стратегии крэшит worker_thread → сервер висит без сканера | try/catch внутри каждого symbol scan + worker auto-restart. Отдельная ошибка одного бота не влияет на остальные (индивидуальный catch в p-queue task) |
| R3 | Свечи bulk-fetch → 429 rate-limit от бирж | `p-queue` concurrency=3 per exchange + ccxt `enableRateLimit:true`. На 4 биржах × 3 одновременно = 12 запросов max. На 8 бирж ×  3 = 24. Safe для public endpoints |
| R4 | `signal_registry` растёт неограниченно | `cleanupExpired()` вызывается в конце каждого цикла. При 100 ботов × 24h = ~2400 записей max |
| R5 | Дедуп слишком агрессивный (0.1% бакет) → пропуск реальных новых сетапов с близкой ценой | В MVP консервативно. Если юзеры жалуются — уменьшу до 0.05% или сделаю cfg-override per-bot |
| R6 | worker_thread не видит изменения плагинов/стратегий без рестарта | В Phase 14 добавим hot-reload SIGUSR2 handler. Сейчас — рестарт процесса |

---

## 5. Acceptance Phase 6

- [x] signalRegistry с fingerprint дедупом + bucket price
- [x] signalService полностью на новой схеме (legacy `signal_history` удалён)
- [x] websocketService: `broadcastToUser()` + broadcastSignal router
- [x] Worker runs as worker_thread with message-based signal/auto_trade flow
- [x] Server auto-restart worker on unexpected exit
- [x] Scanner runs LEVELS strategy end-to-end against fetched candles
- [x] Free-tier signal daily limit works (3 views → 403)
- [x] 14 новых тестов + 104 предыдущих = 118/118 passing

---

## 6. Следующий шаг — Phase 7 (Backtest Engine)

**Цель:** заменить текущий `Math.random()` мок на реальный walk-forward движок.

**План (~3-4 дня, но можно уложить за сессию):**

### `services/backtestEngine.js`
- Walk-forward iteration: для каждой свечи вызываем `strategy.scan(window[0..i], cfg)`, если сигнал — открываем виртуальную позицию, симулируем исполнение на следующих свечах (TP1 → 33% + BE, TP2 → 33% + trail, TP3/SL → закрыть)
- Fee/slippage модель: 0.05% fee + 0.02% slippage на каждое исполнение (configurable)
- Partial TP симуляция: 33%/33%/34% по умолчанию
- **Метрики**: total PnL, winrate, profit factor, Sharpe, Sortino, max drawdown, expectancy, monthly returns, by-symbol breakdown
- Прогресс через `backtests.progress_pct` (обновляется каждые 100 свечей)
- Очередь через `p-queue` concurrency=2 (max 2 бэктеста параллельно на сервере)

### `routes/backtests.js` — пересмотр
- POST создаёт запись с `status=pending`, кладёт в очередь
- GET polling / WebSocket `backtest_progress` events
- Per-plan cap: Pro 10/день, Elite ∞

### Тесты
- 1-year bybit BTCUSDT 1h с LEVELS → реалистичные метрики (winrate 40-70%, pnl ±30%)
- Shape validator на результатах

Жду **"go"** на Phase 7.
