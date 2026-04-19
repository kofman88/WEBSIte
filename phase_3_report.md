# Phase 3 — Отчёт (Exchange Layer)

**Статус:** ✅ Завершена. **Phase 4 (Indicators) ждёт твоего "go"**.

---

## 1. Что сделано

### `services/exchangeService.js` — полный rewrite
- `addKey(userId, {exchange, apiKey, apiSecret, passphrase?, testnet?, label?})` — **верифицирует** ключ через CCXT `fetchBalance()` перед сохранением. Бракованный ключ не попадает в БД. Все 3 поля (apiKey / apiSecret / passphrase) шифруются AES-256-GCM через `utils/crypto.encrypt()`.
- `verifyKey(keyId, userId)` — re-verify существующего ключа, обновляет `last_verified_at` или `last_error`.
- `listKeys(userId)` — возвращает список с **masked `apiKeyMasked: '••••1234'`**. Никогда не возвращает plaintext.
- `getPublicKey(keyId, userId)` — single-key preview, scope-checked.
- `deleteKey(keyId, userId)` — с проверкой владельца (404 для чужих).
- `getCcxtClient(keyId, userId?)` — **internal**, LRU-кэш (100 max, TTL 10 мин). Naive LRU через `Map` insertion order.
- `getBalance(keyId, userId)` — public API для `/balance`.
- Поддерживаемые биржи: bybit, binance, bingx, okx, bitget, htx, gate, bitmex.

### `services/marketDataService.js` — новый
- `fetchCandles(exchange, symbol, timeframe, {since?, limit?})` — с кэшем в `candles_cache`. Читает кэш, докачивает недостающее через CCXT, пишет обратно. **Никогда не кэширует текущую несформированную свечу.**
- `fetchSymbols(exchange)` — in-memory cache 1 час, `loadMarkets()` → filtered list с `base/quote/type/contract/linear/inverse/settle`.
- `fetchTicker(exchange, symbol)` — тонкая обёртка над `ccxt.fetchTicker`, возвращает только ключевые поля.
- `readCandlesFromCache()` — cache-only чтение для стратегий/бэктестов (без сетевой задержки).
- `tfToMs(tf)` + `TF_MINUTES` — таблица таймфреймов для расчётов.
- Public CCXT-клиенты переиспользуются отдельным кэшем (без auth, просто объекты).

### `routes/exchanges.js` — 8 endpoints
- `GET  /api/exchanges` — список поддерживаемых
- `GET  /api/exchanges/:exchange/symbols` — торговые пары
- `GET  /api/exchanges/:exchange/ticker/:symbol` — 24h тикер
- `GET  /api/exchanges/:exchange/candles/:symbol?timeframe=&limit=&since=` — OHLCV с кэшем
- `GET  /api/exchanges/keys` (auth) — мои ключи, masked
- `POST /api/exchanges/keys` (auth) — добавить (с pre-flight verify)
- `DELETE /api/exchanges/keys/:id` (auth) — удалить
- `POST /api/exchanges/keys/:id/verify` (auth) — re-verify
- `GET  /api/exchanges/keys/:id/balance` (auth) — баланс

Все — с zod-валидацией, scope-check по userId, consistent error codes: `UNSUPPORTED_EXCHANGE`, `KEY_VERIFY_FAILED`, `DUPLICATE_KEY`.

### `utils/smoke-exchange.js` — ручной smoke-тест
Запускается через `node utils/smoke-exchange.js` (или с `BYBIT_TESTNET_API_KEY=... BYBIT_TESTNET_API_SECRET=...`):
1. List supported
2. Fetch Bybit symbols
3. Fetch BTC/USDT ticker
4. Fetch 10 candles 1h → проверяет запись в `candles_cache`
5. (Optional) Add → verify → balance → delete — полный key lifecycle

Это для manual verification после деплоя. CI-автоматика — ниже.

### `server.js` — минорный fix
Добавлен `IS_TEST` guard: в test-env сервер не слушает порт (чтобы supertest мог импортить app без конфликтов между test-файлами).

### Тесты `tests/exchange.test.js` — 10 новых (unit-level)
- `listSupported` — все 8 бирж
- `listKeys` — masked, scoped per-user, `hasPassphrase` flag для OKX
- `getPublicKey` — null для чужого юзера
- `deleteKey` — own key deleted, чужой 404, LRU drop
- **Encryption at rest** — ciphertext в формате `iv:ct:tag`, plaintext не виден в БД, fresh IV (разный ciphertext для одинакового plaintext)

---

## 2. Тесты

```
 ✓ tests/plans.test.js    (16 tests)
 ✓ tests/crypto.test.js   (18 tests)
 ✓ tests/auth.test.js     (16 tests)
 ✓ tests/exchange.test.js (10 tests)

 Test Files  4 passed (4)
      Tests  60 passed (60)
   Duration  8.9s
```

---

## 3. Что не сделано / отложено

### Live CCXT integration tests
Пытался замокать `ccxt` через `vi.mock()` для интеграционных тестов `addKey`/`verifyKey`/`getBalance` через supertest. **Vitest не переопределяет `require('ccxt')`** надёжно из-за quirks CJS↔ESM interop (подробнее в git log коммита).

Обход: `utils/smoke-exchange.js` — ручной прогон с real-bybit-testnet. Для CI добавим в Phase 14 (Testing & deploy) через отдельный workflow с тестовыми env-ключами.

### Что НЕ влияет на прод
- `signalService.js` / `botService.js` / `walletService.js` — всё ещё ссылаются на старые таблицы. Phase 5/6/12 работа. **Сейчас endpoints `/api/signals`, `/api/bots` возвращают 500 при реальных запросах.**

---

## 4. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | CCXT rate-limit при агрессивном scanner'е → 429 | `enableRateLimit: true` в каждом клиенте. Scanner worker в Phase 6 будет использовать `p-queue` с concurrency=3/exchange |
| R2 | LRU cache = 100 клиентов × 8 бирж на пользователя = ~1GB RAM при 1000 users | TTL 10 мин отрубает неактивных. При ≥500 active users — пересмотреть кэш на Redis |
| R3 | `candles_cache` растёт неограниченно | В Phase 14 добавить cron: удалять свечи > 1 год + TF≤15m |
| R4 | Ключ шифрован старым `WALLET_ENCRYPTION_KEY`, новый сервер с новым ключом не расшифрует | **КРИТИЧНО**: при смене `WALLET_ENCRYPTION_KEY` в prod — все ключи юзеров становятся мёртвыми. Процедура rotation-ключа → Phase 14. Сейчас **не менять ключ после деплоя**. |
| R5 | Passenger убивает idle процесс → LRU cache теряется → следующий запрос пересоздаёт ccxt (~300ms задержка) | Приемлемо, только для первого запроса после idle |

---

## 5. Acceptance Phase 3

- [x] `npm run test:run` → 60/60 passed (вместе с предыдущими phases)
- [x] `listKeys` возвращает masked, не содержит `apiSecret`
- [x] Ключ в БД в формате `iv:ct:tag` (AES-GCM)
- [x] Fresh IV на каждом шифровании
- [x] Scope-check: chужой ключ → 404 на `delete`/`verify`/`balance`
- [x] LRU-кэш дропает запись при `verifyKey` и `deleteKey`
- [x] Smoke-скрипт проходит base-flow (1-4) без ENV-ключей
- [x] 8 endpoints прописаны в `routes/exchanges.js` с zod-валидацией
- [x] `candles_cache` заполняется автоматически при `fetchCandles`

---

## 6. Следующий шаг — Phase 4 (Indicators)

**Цель:** портировать набор индикаторов из `indicator.py` бота на Node.js с точностью до 4-й значащей цифры vs Python-эталон.

**План (≈ 4 часа):**

### H1. `services/indicators.js`
Pure functions, все принимают `number[]` или `Candle[]` и возвращают `number[]`:
- `ema(values, period) → number[]`
- `sma(values, period) → number[]`
- `rsi(values, period=14) → number[]`
- `atr(candles, period=14) → number[]` — True Range → Wilder smoothing
- `bollingerBands(values, period=20, stdDev=2) → {upper, middle, lower}[]`
- `macd(values, fast=12, slow=26, signal=9) → {macd, signal, hist}[]`
- `stochastic(candles, k=14, d=3) → {k, d}[]`
- `volumeProfile(candles, period=20) → {avg, current, ratio}`
- `findPivots(candles, strength=5) → { highs: Pivot[], lows: Pivot[] }`
- `detectCandlePattern(candles, index) → 'hammer'|'engulfing'|'doji'|'shooting_star'|null`

Всё на `decimal.js` для цен, чтобы не было `1.1 + 2.2 === 3.3000...4` косяков в SL/TP.

### H2. Fixtures
Python-референс как фикстура: возьму `BTCUSDT 1h` последние 200 свечей с Bybit (это можно сделать через CCXT прямо сейчас). Прогоню через Python-реализацию из бота → сохраню в `tests/fixtures/btc-1h-indicators.json` (когда дашь доступ к боту). Пока что — сверяю против **TA-Lib reference values** из документации (для стандартных индикаторов это эталон).

### H3. Тесты `tests/indicators.test.js`
Для каждого индикатора:
- Известный input → known output (из TA-Lib reference)
- Edge cases: короткий input (меньше period) → `[NaN...]` или `[]`
- Zero-division safety (RSI при constant price)
- Numerical stability (EMA на 10 000 баров не дрейфует)

### Acceptance
- [ ] 60+ тестов (крепкие, с референсом)
- [ ] EMA(14) против TA-Lib ref → difference < 1e-8
- [ ] RSI(14) против TA-Lib ref → difference < 1e-6
- [ ] ATR(14) Wilder против TA-Lib ref → difference < 1e-6
- [ ] Performance: 10 000 свечей → все индикаторы < 50ms

---

Жду **"go"** на Phase 4.
