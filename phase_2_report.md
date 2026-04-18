# Phase 2 — Отчёт (Auth + сессии)

**Статус:** ✅ Завершена. **Phase 3 (Exchange Layer) ждёт твоего "go"**.

---

## 1. Что сделано

### `services/authService.js` — полностью переписан
- `register({ email, password, displayName, referralCode, ip, ua })` → транзакционно создаёт user + subscription(free) + (если ref-код валиден) referrals-запись. Возвращает access+refresh.
- `login({ email, password, ip, ua })` → enumeration-protection (одинаковое сообщение для unknown email и wrong password, плюс dummy-bcrypt для тайминг-защиты). Обновляет `last_login_at`.
- `refresh({ refreshToken, ip, ua })` → **rotating**: старый refresh revoked, новый выдан. **Replay detection**: если юзер пытается использовать revoked-токен — **все его сессии revoked** (защита от кражи refresh).
- `logout({ refreshToken })` / `logoutAll({ userId })` — revoke refresh'ей.
- `requestPasswordReset({ email })` — всегда returns `{sent: true}` (без enumeration), если юзер существует — кладёт токен в `system_kv` (ключ = `reset:${sha256(token)}`), TTL 1 час, логирует reset URL в консоль (в dev). В prod — пока только в логи, SMTP wire в Phase 12.
- `confirmPasswordReset({ token, newPassword })` → меняет пароль + revoke **все refresh-токены** юзера.
- `changePassword({ userId, currentPassword, newPassword })` → требует старый пароль + revoke все refresh.
- `getUserPublic(userId)` → JOIN users × subscriptions, возвращает безопасное представление (без `password_hash`) с `subscription.limits` из plans.js.
- Bcrypt cost **12**. Refresh tokens: 48 random bytes base64url. SHA-256 hash в БД.
- Audit-логи для всех событий: register, login, refresh, logout, password_changed, reset_request, reset_confirmed, refresh_replay_detected.

### `middleware/auth.js` — расширен
- `authMiddleware` → проверка Bearer-token, загружает в `req`: `userId`, `userEmail`, `userPlan`, `isAdmin`. Отдельные коды: `NO_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `NO_USER`, `ACCOUNT_DISABLED`.
- `requireTier(minPlan)` → через `plans.isAtLeast()`. Возвращает 403 `UPGRADE_REQUIRED` с `currentPlan` + `requiredPlan`.
- `requireFeature(feature)` → проверка boolean-фичи (`autoTrade` / `optimizer` / `apiAccess`) через `plans.canUseFeature()`.
- `requireAdmin` → проверка `users.is_admin=1`.
- 3 rate-limiter'а (скипаются в VITEST env):
  - `loginLimiter`: 5 попыток/мин по **ip+email** (чтобы один IP не блокировал всех юзеров)
  - `registerLimiter`: 3 регистрации/час на IP
  - `passwordResetLimiter`: 5/час на IP

### `routes/auth.js` — 9 endpoints
Всё с zod-валидацией через `utils/validation.js`:
- `POST /api/auth/register` — 201 + user+tokens
- `POST /api/auth/login` — 200 + user+tokens
- `POST /api/auth/refresh` — 200 + новая пара
- `POST /api/auth/logout` — revoke refresh
- `POST /api/auth/logout-all` (auth'd) — revoke все refresh'и
- `GET /api/auth/me` (auth'd) — профиль
- `POST /api/auth/password-reset/request` — rate-limited
- `POST /api/auth/password-reset/confirm` — меняет пароль
- `POST /api/auth/change-password` (auth'd)

### `server.js` — graceful shutdown + error pipeline
- `app.set('trust proxy', 1)` — корректный `req.ip` за Passenger/CDN.
- Глобальный rate-limit поднят 200→300/15мин (реальный auth-лимит в middleware).
- `express.json({limit:'1mb'})` — было 10mb (атака вектор).
- **Zod error middleware**: `ZodError` → 400 с массивом `issues[{path, message}]`.
- **Status error middleware**: `err.statusCode` → возвращает ту же статус с `err.code`.
- **500-handler**: в prod не утекает stack.
- **SIGTERM/SIGINT**: `websocketService.shutdown()` + `db.close()` (WAL-checkpoint) + `process.exit(0)`.

### Тесты `tests/auth.test.js` — 16 новых
supertest + vitest, свежая БД на старте, clean tables между тестами:
- register happy path → user без password_hash, с tokens
- register: дубликат email → 409 EMAIL_EXISTS
- login happy → tokens
- login wrong password → 401 INVALID_CREDENTIALS
- login unknown email → тот же 401 (enumeration protection)
- GET /me с токеном → user
- GET /me без токена → 401 NO_TOKEN
- GET /me с garbage → 401
- refresh rotation: старый refresh после использования → 401 REFRESH_REUSED, **все сессии revoked**
- logout → рефреш больше не работает
- logout-all → оба рефреша юзера revoked
- password-reset/request для unknown email → success (no enumeration)
- password-reset полный flow + сохранение старой сессии до подтверждения
- referral-код валидный → запись в `referrals`
- referral-код мусорный → игнор + успешная регистрация

---

## 2. Тесты

```
 ✓ tests/plans.test.js  (16 tests)
 ✓ tests/crypto.test.js (18 tests)
 ✓ tests/auth.test.js   (16 tests)

 Test Files  3 passed (3)
      Tests  50 passed (50)
   Duration  10.42s
```

---

## 3. Что не сделано

- **Email delivery для reset-password** — сейчас reset URL только в логах. Это отложено до Phase 12 (payments/email infrastructure).
- **Email verification flow** — принял решение **пока опциональная** (`email_verified` остаётся 0, юзер всё равно может логиниться). Если хочешь обязательную — скажи, добавлю middleware.
- **2FA для админов** — флаг в БД есть, реализация — в P13 (Admin panel).

---

## 4. Известные legacy-проблемы (не в Phase 2 scope)

Эти куски кода обращаются к таблицам со старыми именами. **Они не работают сейчас, но Phase 2 их не использует:**

| Файл | Ссылается на | Решение |
|---|---|---|
| `services/signalService.js` | `signal_history` (было), теперь `signals` | Переписать в **Phase 6** (Signal Scanner) |
| `services/botService.js` | `bot_trades` (было), теперь `trades` | Переписать в **Phase 5/6** |
| `services/walletService.js` | `wallets`, `wallet_transactions` (удалены, у нас теперь `ref_rewards`) | Переписать под ref-payouts в **Phase 12** |
| `services/websocketService.js` | `signal_history` | Переписать в **Phase 6** |

В ходе Phase 2 тестов видна одна строка: `WebSocket broadcast error: no such table: signal_history` — это safe-caught warning, тесты проходят нормально.

---

## 5. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Прод-сервер не стартанёт после деплоя (нет `JWT_REFRESH_SECRET`) | Добавить в `.env` на сервере: `openssl rand -hex 32` 3 раза, засунуть в `JWT_SECRET`, `JWT_REFRESH_SECRET`, `WALLET_ENCRYPTION_KEY` |
| R2 | Старые access-токены пользователей (до деплоя) станут невалидны | Нормально — юзеры редиректнутся на login. Refresh-tokens с старой схемой не существуют, таблица `refresh_tokens` новая |
| R3 | Legacy signalService/botService ломают фронт (500) | Игры с signals/bots на фронте сейчас не работают с реальным API. Починим в P5/P6 |
| R4 | Rate-limit на 5 login/мин может мешать юзеру с забытым паролем | Ключ лимитера `ip+email` — перебор одного email на своём IP ограничит, но другой email с того же IP пройдёт |

---

## 6. Acceptance Phase 2

- [x] `register → login → me → refresh → logout` full flow работает (через тесты)
- [x] Refresh-tokens rotating, replay detection работает
- [x] Rate-limit на login (5/мин), register (3/час) — включаются в prod, скипаются в test
- [x] Prod-сервер fail-fast при отсутствии 3 критичных секретов
- [x] Password-reset flow: request + confirm + revoke all sessions
- [x] Zod-валидация возвращает 400 с issues
- [x] Enumeration protection (login, password-reset)
- [x] 50/50 тестов зелёные

---

## 7. Следующий шаг — Phase 3 (Exchange Layer через CCXT)

**План (≈ 10-12 часов):**

### H1-2. `services/exchangeService.js` → полный rewrite
- `addKey(userId, { exchange, apiKey, apiSecret, passphrase?, testnet?, label? })`:
  - Зашифровать каждое поле через `utils/crypto.encrypt()`
  - Создать CCXT instance, вызвать `fetchBalance()` как проверку
  - Записать в `exchange_keys`, обновить `last_verified_at`
- `verifyKey(keyId)` — re-verify existing
- `listKeys(userId)` — маска `...abcd` (last 4), не возвращает секрет
- `deleteKey(keyId, userId)`
- `getCcxtClient(keyId)` — internal, с **LRU-кэшем** (max 100 клиентов, TTL 10 мин)

### H3. `services/marketDataService.js`
- `fetchCandles(exchange, symbol, timeframe, since?, limit?)` с кэшем в `candles_cache`
- `fetchSymbols(exchange)` — раз в час, in-memory cache
- `fetchTicker(exchange, symbol)`
- `fetchBalance(keyId)` — требует ключ

### H4-5. `routes/exchanges.js`
- `GET /api/exchanges` — список поддерживаемых (enum из validation.js)
- `GET /api/exchanges/:exchange/symbols`
- `GET /api/exchanges/:exchange/ticker/:symbol`
- `POST /api/exchanges/keys` (auth'd, zod: `addKeySchema`)
- `GET /api/exchanges/keys` (auth'd) — masked
- `DELETE /api/exchanges/keys/:id`
- `POST /api/exchanges/keys/:id/verify`
- `GET /api/exchanges/keys/:id/balance`

### H6. Тесты
- Unit на шифрование ключа при сохранении (read back → decrypt → match)
- Integration mocking CCXT: add-verify-delete flow
- Маскировка: `listKeys` не содержит `apiSecret`
- LRU: повторные запросы не создают новый CCXT instance

### Acceptance Phase 3
- [ ] Добавление testnet Bybit-ключа → `/balance` работает
- [ ] Ключ в БД зашифрован (Node-скрипт `SELECT api_secret_encrypted` возвращает `iv:ct:tag` формат)
- [ ] Повторный `/verify` после рестарта сервера — работает (decrypt OK)
- [ ] `apiSecret` никогда не в API-ответе
- [ ] CCXT-клиент переиспользуется (лог показывает cache hits)

---

Жду **"go"** на Phase 3.
