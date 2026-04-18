# Phase 1 — Отчёт

**Дата:** 2026-04-18
**Статус:** ✅ Завершена, **Phase 2 ждёт твоего "go"**

---

## 1. Что сделано

### Конфигурация
- `backend/package.json` → **v3.0.0**. Обновлены deps: express 4.21, helmet 8, better-sqlite3 11.8, ccxt 4.5. Добавлены: `decimal.js`, `zod`, `stripe`, `winston` + `winston-daily-rotate-file`, `p-queue`, `vitest`, `supertest`, `eslint` + `eslint-plugin-security`, `@vitest/ui`. Удалён: `axios`.
- `backend/config/index.js` → **полностью переписан**. Fail-fast валидация ENV: в prod падает с `process.exit(1)` если `JWT_SECRET` / `JWT_REFRESH_SECRET` / `WALLET_ENCRYPTION_KEY` (64 hex) / `STRIPE_*` / `CORS_ORIGIN` отсутствуют. В dev — warning + слабые дефолты.
- `backend/.env.example` → расширен до финального списка (24 переменные, с комментариями и примерами).

### Утилиты
- `backend/utils/crypto.js` — **AES-256-GCM** encrypt/decrypt + `mask()` + `generateKey()` + `sha256()` + `safeEqual()`. Формат ciphertext: `base64(iv):base64(ct):base64(tag)`, nonce 12 байт на каждое шифрование.
- `backend/utils/logger.js` — winston, в dev pretty, в prod JSON + rotating files (`logs/app-YYYY-MM-DD.log` 14 дней, `error-*` 30 дней). Работает и без файловой системы (fallback на stdout).
- `backend/utils/validation.js` — 13 zod-схем: `email`, `password` (≥8, letter+digit), `symbol`, `exchange`, `timeframe`, `strategy`, `registerSchema`, `loginSchema`, `addKeySchema`, `createBotSchema`, `createBacktestSchema`, `stripeCheckoutSchema`, `cryptoPaymentSchema`, `promoRedeemSchema`, `signalPrefsSchema`. Enum-constants экспортируются для reuse.
- `backend/utils/db-reset.js` — dev-only скрипт удаления БД (защита: падает в prod и без `DB_RESET_CONFIRM=yes`).
- `backend/utils/db-seed.js` — создаёт admin + test юзеров + промокод `WELCOME2026`, идемпотентно.

### Схема БД
- `backend/models/database.js` → **полностью переписан**. 22 таблицы, 34 индекса. Все `CREATE TABLE IF NOT EXISTS` — безопасно для prod (не дропает существующие). SQLite pragmas: WAL + synchronous=NORMAL + FK=ON + busy_timeout=5000. Graceful `.close()` с `wal_checkpoint(TRUNCATE)`.

Список таблиц:
```
CORE:      users, refresh_tokens, subscriptions, payments,
           promo_codes, promo_redemptions
TRADING:   exchange_keys, trading_bots, trades, trade_fills,
           signals, signal_registry, user_signal_prefs, signal_views
ANALYTICS: backtests, backtest_trades, optimizations, candles_cache
REFERRAL:  referrals, ref_rewards
SYSTEM:    audit_log, system_kv
```

### Фича-матрица
- `backend/config/plans.js` — константа `PLANS` (free/starter/pro/elite) + API: `getLimits()`, `getPlan()`, `listPlans()`, `canUseFeature()`, `canUseStrategy()`, `requiredPlanFor()`, `requiredPlanForStrategy()`, `comparePlan()`, `isAtLeast()`. `Infinity` правильно конвертируется в `null` для JSON.

### Тесты
- `backend/tests/crypto.test.js` — **18 тестов** (round-trip ASCII/unicode/secret, fresh-nonce, tamper detection, ключи, маска, sha256, safeEqual)
- `backend/tests/plans.test.js` — **16 тестов** (все 4 плана × все фичи, ordering, JSON serialization)

---

## 2. Что протестировано

```
 ✓ tests/plans.test.js  (16 tests)  10ms
 ✓ tests/crypto.test.js (18 tests)  17ms

 Test Files  2 passed (2)
      Tests  34 passed (34)
   Duration  1.24s
```

Дополнительно вручную проверено:
- **Freshdb create:** `node utils/db-seed.js` на пустой папке → БД создана, 22 таблицы, 34 индекса, seed отработал.
- **Counts:** users=2, subscriptions=2, promo_codes=1 (admin + test + WELCOME2026).
- **ESM/CJS interop:** тесты в ESM, бэкенд в CommonJS — работает через Node interop (default import).
- **Идемпотентность seed:** второй запуск `db:seed` видит существующих юзеров и говорит `user exists`, не дублирует.

---

## 3. Что не сделано из плана

- **Hour 8 (подчасть — обновление `backend/README.md`)** — отложил, README обновлю в конце Phase 2 когда появится Auth.
- **`phase_2_plan.md`** — не писал отдельным файлом; вместо этого блок «Следующий шаг» внизу этого отчёта.
- **`db:migrate` на старой схеме** — решил **не делать**. Текущая `data/chmup.db` на проде юзерами не засеяна (Q3 не ответил, но маркетинг шёл только недавно). При деплое **безопасно** через `CREATE IF NOT EXISTS` — старые таблицы (`bot_trades`, `signal_history`, `wallets`) останутся, но не мешают. Если нужно — в Phase 2 сделаем миграцию ротацией.

---

## 4. Вопросы (повторяю критические из phase_0_audit.md)

**Жёстко блокирует Phase 5+** (4-5 фаз работы впереди):
1. **Q B1** — **где `bot/CHM_BREAKER_V4/`**? Без него невозможно порт стратегий (LEVELS/SMC/Gerchik/Scalping), реальный бэктест-движок (1491 строк Python), auto-trade логика. Phase 2/3/4 могу делать без него (они — только auth, exchange layer, indicators). Пока иду по ним, жди.

**Не блокируют, но нужно ответить до Phase 2:**
2. **Reset-password flow** — SMTP через свой сервер, SendGrid, Resend, или в MVP без email (показывать reset-ссылку в консоли для dev)? Сейчас в `.env.example` есть `SMTP_*` placeholders.
3. **Email verification** на регистрации — обязательна или опциональна? Если обязательна — юзер не может логиниться до клика по письму.
4. **Refresh-token rotation** — при каждом `/refresh` выдавать новый refresh + revoke старый (rotating) или один долгоживущий? Рекомендую rotating (безопасней).

**Не блокирует Phase 2 совсем:**
5. **Q B2** (Passenger vs PM2) — нужен только в Phase 6.
6. **Q B3/B4** (crypto-адреса, Stripe аккаунт) — Phase 12.

---

## 5. Риски

| # | Риск | Вероятность | Что сделано |
|---|---|---|---|
| R1 | Прод имеет старую схему — при деплое новая БД не применится | Низкая | `CREATE IF NOT EXISTS` — безопасно. Новые таблицы создадутся, старые (`bot_trades`, `signal_history`, `wallets`) останутся как были. Нужен **ответ Q3** для финального решения (дропать старые или оставить) |
| R2 | `.env` не обновлён на проде → новые обязательные поля (JWT_REFRESH_SECRET) отсутствуют → сервер не стартует | Средняя | Fail-fast ругается понятно: «Missing ENV: JWT_REFRESH_SECRET». При деплое **обязательно** сгенерировать новые 3 ключа (см. `.env.example` комменты с `openssl rand -hex 32`) |
| R3 | `winston-daily-rotate-file` прав на запись в `logs/` нет на cPanel | Низкая | Logger try/catch обёртывает file transport. Если падает — работает только stdout. Тестировалось локально |
| R4 | `better-sqlite3 11.8` требует Node 18+ | Низкая | Prebuilt binaries есть для Node 18/20/22. cPanel должен иметь Node ≥18 (спека подтверждает) |

---

## 6. Acceptance Phase 1

- [x] `npm install` без ошибок (366 пакетов)
- [x] БД создаётся с 22 таблицами и 34 индексами (verified via Node)
- [x] `npm run db:seed` — идемпотентно, создаёт admin/test/promo
- [x] `npm run test:run` — 34/34 passed
- [x] `config/index.js` падает с понятной ошибкой при отсутствии критичных ENV
- [x] AES-256-GCM crypto: round-trip, tamper detection, fresh nonce
- [x] Plans feature matrix: 4 плана × 10 проверок, ordering, JSON serialization

---

## 7. Следующий шаг — Phase 2 (Auth + сессии)

**План (≈ 6-8 часов):**

### H1. `backend/services/authService.js` → полная переработка
- `register(email, password, displayName?, referralCode?)` — bcrypt cost 12, создаёт user + subscription free + refresh_token + audit_log. Если `referralCode` валиден — вставка в `referrals`.
- `login(email, password, ip?, userAgent?)` — проверка, выдача access+refresh, logon в `audit_log`, обновление `last_login_at`.
- `refresh(refreshToken, ip?, userAgent?)` — rotating refresh (старый → revoked, новый → выдан). Проверка что token_hash существует и не revoked и не expired.
- `logout(refreshToken)` — revoke refresh в БД. Access-token ничем не инвалидируется (живёт до expiry, это норма для JWT).
- `logoutAll(userId)` — revoke все refresh-tokens юзера (например при смене пароля).
- `requestPasswordReset(email)` → кладёт временный token в `system_kv` (key=`reset:${uuid}`, value=JSON{userId, expires}), логирует ссылку в dev, отправляет email в prod.
- `confirmPasswordReset(token, newPassword)` — проверяет token, меняет пароль, инвалидирует все refreshes.

### H2-3. `backend/routes/auth.js` → расширение
Endpoints:
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/auth/password-reset/request`
- `POST /api/auth/password-reset/confirm`

Каждый — с zod-валидацией из `utils/validation.js`.

### H4. `backend/middleware/auth.js` → добавить
- `authMiddleware` — требует access token.
- `requireTier(minPlan)` — через `plans.isAtLeast()`.
- `requireAdmin` — проверка `users.is_admin = 1`.
- Rate-limiter специально для `/api/auth/login` (5/мин) и `/api/auth/register` (3/час).

### H5. `backend/tests/auth.test.js`
Интеграционные тесты через supertest:
- register happy path
- register: email уже существует → 409
- register: слабый пароль → 400
- login happy → access+refresh
- login wrong password → 401
- rate-limit на login: 6-й запрос → 429
- refresh → новая пара токенов, старый invalid
- logout → refresh больше не работает
- GET /me → user без password_hash
- password reset flow (request → confirm)

### H6. Обновить `backend/server.js`
- Закрывать БД по SIGTERM/SIGINT (`db.close()` + `websocketService.shutdown()`).
- Middleware для zod-ошибок → 400 с `{error, issues: [...]}`.
- Middleware для общих ошибок → в prod не утекает stack trace.

### Acceptance Phase 2
- [ ] Все тесты auth — passed
- [ ] `curl register → login → me → refresh → logout` полный flow работает
- [ ] При 6-м логин-запросе в минуту — 429
- [ ] При смене пароля — все existing refresh-tokens у юзера → revoked
- [ ] Prod-сервер не стартует без секретов

---

Жду твоего **"go"** на Phase 2 — или ответов на вопросы выше если хочешь скорректировать план.
