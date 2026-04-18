# Phase 0 — Аудит и фундамент

> **Статус:** Черновик аудита. Код не пишу до твоего "go".

---

## 0. Executive summary

- Сайт `/home/user/WEBSIte/` существует: бэкенд ~3 086 строк JS (16 файлов), фронтенд 11 HTML + `app.js` + `styles.css` — редизайн завершён.
- Бэктест сейчас — **мок на `Math.random()`** (`backend/services/backtestService.js` строки 86-98). Подтверждено.
- Текущая схема БД: 14 таблиц. Требуемая в спеке: 19 таблиц. Названия тарифов уже совпадают (`free/starter/pro/elite`).
- **Папка `bot/CHM_BREAKER_V4/` в окружении отсутствует.** Без неё невозможно выполнить P0/P1 корректно — см. Блокеры ниже.
- Шифрование: в текущем `exchange_keys` хранится `api_key` **открытым текстом** и `api_secret_encrypted` — без указания алгоритма. Надо переделать на AES-256-GCM для обоих полей.
- WebSocket-сервис на бэкенде есть (`websocketService.js`, 248 строк) — переиспользую.

---

## 1. 🔴 Блокирующие проблемы (нужно решить до Phase 1)

### B1. Нет доступа к референсу бота
Искал рекурсивно в `/home`, `/root`, `/tmp`, `/workspace`, `/corp` — `CHM_BREAKER_V4` нигде. В рабочем окружении только `/home/user/WEBSIte/` (сайт).

**Что без него невозможно:**
| Фаза | Блок | Почему нужен бот |
|---|---|---|
| P5 | `strategies/levels/` | 4 500 строк `scanner_mid.py` — алгоритм pivot + retest + quality scoring |
| P7 | `backtestEngine.js` | 1 491 строк `backtest.py` — правила walk-forward, partial TP sim, close reasons |
| P8 | `strategies/smc/` | 8 файлов SMC — OB, FVG, liquidity, BOS/CHoCH, premium/discount |
| P8 | `strategies/gerchik/` | 69 KB логики ATR-фильтров и false-breakout rules |
| P10 | `autoTradeService.js` | 133 KB `auto_trade.py` + `partial_tp.py` + `sl_verifier.py` |
| P4 | `indicators.js` | `indicator.py` ~3 000 строк — валидация JS-реализации против Python-эталона |

**Варианты разблокировки (нужно решение):**
1. **A.** Залить `bot/CHM_BREAKER_V4/` в доступное место (`/home/user/bot/` или git-сабмодуль в том же репо).
2. **B.** Выдать только нужные файлы частями по запросу. Риск — порт без полного контекста даст расхождения с продакшн-ботом.
3. **C.** Реализовать стратегии с нуля по публичным описаниям (SMC / Герчик / Scalping есть в литературе). Риск — получим **другие** сигналы по сравнению с ботом, юзеры увидят разницу. Не рекомендую.

Без разблокировки иду только до Phase 4 включительно (DB + Auth + Exchange + Indicators).

### B2. Деплой-инфра для воркеров (Passenger vs PM2)
Спека ставит вопрос в P6: сайт сейчас под Passenger (cPanel) — он рассчитан на короткоживущие HTTP-процессы, долгоживущие воркеры через него не живут корректно.

**Варианты:**
1. **PM2 / screen** — отдельный процесс воркера, запускается через SSH на cPanel VPS.
2. **worker_threads внутри `server.js`** — воркер живёт в процессе Passenger, выживает между запросами, но Passenger может убить idle-процесс через N минут.
3. **Переезд на полноценный VPS** (Hetzner / DO) — долгосрочно правильно, в MVP избыточно.

Нужно знать твой cPanel-план: есть ли SSH, разрешён ли PM2 как долгоживущий процесс.

### B3. Crypto-платежи: какая сеть и адрес
В спеке указан статический кошелёк компании (USDT BEP20 + TRC20). Нужно:
- Адрес получателя (или создать через MetaMask/Trust).
- API-ключи BscScan (BEP20) и Tronscan (TRC20) для мониторинга платежей — оба бесплатные.
- Решение: делать уникальную сумму (например `79.03 USDT`) для идентификации платежа, или генерить per-user deposit address? Адрес per-user — это HD-wallet + keys managed, сложнее. Для MVP рекомендую **уникальную сумму + static address**.

### B4. Stripe account
Для P12 нужно:
- Live Stripe account (KYC пройден).
- Webhook secret задать в `.env`.
- Для крипто-трейдинга Stripe иногда отказывает — есть план Б если аккаунт заблокируют?

---

## 2. Текущий сайт: что оставляем / переделываем

### `backend/server.js` (97 строк)
**Keep (минорные правки):** структура middlewares, Passenger fallback, health endpoint, SPA-фолбек.
**Change:**
- CORS `origin: '*'` → prod-only `chmup.top` (сейчас допустим `*` для dev).
- `helmet({ contentSecurityPolicy: false })` → включить CSP с whitelist'ом (Google Fonts, Tailwind CDN, Iconify, Chart.js, Lucide).
- `express.json({ limit: '10mb' })` → 1mb (10mb ломает rate-limit, 10mb JSON — это уже атака).
- Rate-limit по всему `/api/` — **добавить отдельные лимиты** для `/api/auth/login` (5/мин), `/api/auth/register` (3/час), `/api/backtests` POST (3/мин).
- Нет graceful shutdown для БД — добавить `db.close()` в SIGTERM/SIGINT handlers.
- Winston-логгер вместо `console.*`.

### `backend/models/database.js` (276 строк) — 🔴 ПЕРЕПИСАТЬ
Текущая схема vs требуемая:

| Таблица | Сейчас | Надо | Действие |
|---|---|---|---|
| `users` | 9 колонок | 14 колонок | **Расширить**: `display_name`, `avatar_url`, `locale`, `timezone`, `referred_by`, `email_verified`, `is_admin`, `last_login_at`, `updated_at` |
| `exchange_keys` | `api_key` plaintext | `api_key_encrypted` | **🔴 Security fix**: шифровать оба поля, добавить `passphrase_encrypted` для OKX, `label`, `last_verified_at`, `last_error` |
| `trading_bots` | один `symbol` TEXT | `symbols` JSON + `strategy_config` + `risk_config` | **Расширить** под мультисимволы и конфиги стратегий |
| `bot_trades` | 10 колонок | объединить в `trades` (18 колонок) | **Переименовать** + добавить `signal_id`, `tp1/tp2/tp3`, `close_reason`, `trading_mode`, `exchange_order_ids`, `margin_used` |
| нет | — | `trade_fills` | **Новая** — partial TP, trailing moves |
| `signals` (legacy) | 10 колонок + `signal_history` 14 | единая `signals` (20+) | **Слить в одну**, удалить legacy |
| нет | — | `signal_registry` | **Новая** — fingerprint-дедуп |
| `user_signals_config` | 7 | `user_signal_prefs` (12) | **Переименовать + расширить** (RR, timeframes, notifications split, tg_chat_id) |
| `user_signal_usage` | ✓ | `signal_views` | **Переименовать** |
| `backtests` | 13 | 17 | **Расширить**: `symbols` JSON, `risk_config`, `progress_pct`, `error_message`, `duration_ms` |
| нет | — | `backtest_trades` | **Новая** — детализация сделок бэктеста |
| нет | — | `optimizations` | **Новая** |
| нет | — | `candles_cache` | **Новая** |
| `wallets` + `wallet_transactions` | кастодиальный | **удалить** | Спека явно говорит: только ref-payouts, не кастодиальные wallet'ы |
| нет | — | `payments` | **Новая** — Stripe/crypto история |
| нет | — | `ref_rewards` | **Новая** |
| `referrals` | ✓ (commission 10%) | commission 20% | **Минор** |
| нет | — | `refresh_tokens` | **Новая** |
| нет | — | `audit_log`, `system_kv` | **Новые** |

**Итого:** из 14 текущих → 19 требуемых. Основная работа — `users` / `exchange_keys` / объединение `bot_trades`+`trades`+`signals`+`signal_history`, плюс 8 новых таблиц. Данные в проде отсутствуют — миграции не нужны, дропаем `data/chmup.db` и создаём заново.

### `backend/services/authService.js` (122 строки)
**Keep:** bcrypt для паролей, JWT-генерация.
**Change:**
- Добавить refresh-tokens (сейчас только access).
- Нет логики reset password / email verification.
- Нет `logout` (revoke refresh token).
- Rate-limit на login делается в middleware, но enumeration-protection (одинаковые сообщения) — надо проверить.

### `backend/services/exchangeService.js` (115 строк)
**Keep:** use of `ccxt`.
**Change:**
- **🔴 Не шифрует api_key**. Переписать с AES-256-GCM.
- Нет LRU-кэша CCXT-клиентов — создаёт новый на каждый запрос (тяжело).
- Нет `verifyKey` отдельной операции.
- Нет маскировки секрета в ответе (`last4` pattern).
- Нет `label` для мультиключей одной биржи.

### `backend/services/backtestService.js` (131 строка) — 🔴 ПОЛНОСТЬЮ ВЫКИНУТЬ
Мок на `Math.random()` (строки 86-98). Переписать в Phase 7 с нуля.

### `backend/services/signalService.js` (397 строк)
Надо перечитать — скорее всего тоже местами мок. В Phase 5-6 перепишется под реальный scanner worker.

### `backend/services/subscriptionService.js` (280 строк)
**Keep:** основа проверок статуса + промокоды.
**Change:**
- Фича-матрица должна быть в `config/plans.js` (константа), не в БД.
- Добавить gating-методы: `canCreateBot(userId)`, `canEnableAutoTrade(userId)`, `canRunBacktest(userId)`, `canUseStrategy(userId, strategy)`, возвращающие `{allowed, reason, requiredPlan}`.

### `backend/services/walletService.js` (319 строк) — 🔴 ПОЧТИ ВСЁ ВЫКИНУТЬ
Сейчас кастодиальный кошелёк + transactions. Спека явно: только **ref-payouts**. Оставить ~50 строк для начислений, остальное удалить.

### `backend/services/websocketService.js` (248 строк)
**Keep** — основа WS-broadcasting. В Phase 6 дополнить `broadcastToUser(userId, message)`.

### `backend/middleware/auth.js` (59 строк)
**Change:** добавить `requireTier(plan)` и `requireAdmin`.

### `backend/config/index.js` (44 строки)
**Change:** fail-fast проверка всех критичных env (JWT_SECRET ≥32, WALLET_ENCRYPTION_KEY ровно 64 hex, NODE_ENV, STRIPE_* в prod) с `process.exit(1)` при отсутствии.

### `backend/routes/*`
Все 7 роутов → минорные правки + zod-валидация payload'ов.

### Что **добавить** (новые папки / файлы)
- `backend/strategies/{levels,smc,gerchik,scalping}/` — стратегии.
- `backend/workers/signalScanner.js` — фоновый сканер.
- `backend/workers/slVerifier.js` — cron на проверку SL.
- `backend/services/marketDataService.js` — свечи + кэш.
- `backend/services/signalRegistry.js` — антидубли.
- `backend/services/indicators.js` — EMA/RSI/ATR и прочее.
- `backend/services/backtestEngine.js` — реальный движок.
- `backend/services/autoTradeService.js`, `partialTpManager.js`.
- `backend/services/optimizer.js`.
- `backend/services/paymentService.js` (Stripe + Crypto).
- `backend/utils/crypto.js` — AES-256-GCM helpers.
- `backend/utils/logger.js` — winston.
- `backend/utils/validation.js` — zod-схемы.
- `backend/config/plans.js` — фича-матрица.
- `backend/routes/payments.js`, `backend/routes/admin.js`.

### Фронтенд
**Keep:** всё что сейчас есть (редизайн завершён, дизайн-система единая).
**Change:** добавить интерактив под реальные API — бот-билдер multi-step, backtest-прогресс бар (WS), signals live feed.

---

## 3. Финальный `package.json`

```json
{
  "name": "chmup-backend",
  "version": "3.0.0",
  "description": "CHM Finance — crypto trading platform (signals, bots, backtests, auto-trade, payments)",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "worker": "node workers/signalScanner.js",
    "worker:dev": "nodemon workers/signalScanner.js",
    "test": "vitest",
    "test:run": "vitest run",
    "test:e2e": "vitest run tests/e2e",
    "lint": "eslint . --ext .js",
    "db:reset": "node utils/db-reset.js",
    "db:seed": "node utils/db-seed.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.0",
    "bcryptjs": "^2.4.3",
    "ccxt": "^4.5.0",
    "compression": "^1.7.5",
    "cors": "^2.8.5",
    "date-fns": "^4.1.0",
    "decimal.js": "^10.4.3",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.0",
    "helmet": "^8.0.0",
    "jsonwebtoken": "^9.0.2",
    "node-cron": "^3.0.3",
    "p-queue": "^8.0.1",
    "stripe": "^17.5.0",
    "uuid": "^10.0.0",
    "winston": "^3.15.0",
    "winston-daily-rotate-file": "^5.0.0",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@vitest/ui": "^2.1.0",
    "eslint": "^9.14.0",
    "eslint-plugin-security": "^3.0.1",
    "nodemon": "^3.1.7",
    "supertest": "^7.0.0",
    "vitest": "^2.1.0"
  }
}
```

### Отличия от текущего
| Пакет | Текущий | Финальный | Причина |
|---|---|---|---|
| `express` | 4.18.2 | 4.21.0 | LTS-минор, security fixes |
| `better-sqlite3` | 9.2.2 | 11.8.0 | Node 22 compat, faster |
| `helmet` | 7.1.0 | 8.0.0 | Major, CSP-улучшения |
| `ccxt` | 4.2.1 | 4.5.0 | Новые биржи (Bitget + HTX + Gate) |
| `axios` | 1.6.2 | — | **Удалить**, везде fetch() встроенный |
| `ws` | 8.16.0 | 8.18.0 | minor fixes |
| `decimal.js` | — | 10.4.3 | **Новое** — финансовая точность |
| `zod` | — | 3.23.0 | **Новое** — валидация input |
| `stripe` | — | 17.5.0 | **Новое** — платежи |
| `winston` + `daily-rotate` | — | 3.15.0 | **Новое** — нормальные логи |
| `p-queue` | — | 8.0.1 | **Новое** — очередь бэктестов |
| `vitest` + `supertest` | — | ^2 / ^7 | **Новое** — тесты |
| `eslint` + `security` | — | 9 / 3 | **Новое** — линт + security scan |

**Drop:** `axios` (fetch встроен в Node 18+), `uuid` оставляем если реально используем — иначе тоже выкинуть.

### ENV vars (обновлённый `.env.example`)
Критичные (fail-fast):
```
JWT_SECRET=<64+ hex chars>
JWT_REFRESH_SECRET=<64+ hex chars, != JWT_SECRET>
WALLET_ENCRYPTION_KEY=<ровно 64 hex chars = 32 bytes>
NODE_ENV=production
```

В prod-only:
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLIC_KEY=pk_live_...
PAYMENT_BEP20_ADDRESS=0x...
PAYMENT_TRC20_ADDRESS=T...
BSCSCAN_API_KEY=
TRONSCAN_API_KEY=
SENTRY_DSN=
CORS_ORIGIN=https://chmup.top
```

Опциональные:
```
SMTP_HOST=, SMTP_USER=, SMTP_PASS=  # для reset-password email
TELEGRAM_BOT_TOKEN=                 # для нотификаций (P3)
```

---

## 4. Вопросы к тебе

### Группа А — инфраструктура (блокирует Phase 1)

**Q1.** Где лежит `bot/CHM_BREAKER_V4/`? Варианты:
- Загрузишь сюда (git-сабмодуль / tar-архив)?
- Отдельный репо (дай URL, если приватный — доступ)?
- Не лежит здесь специально, давать по файлам по запросу?

**Q2.** cPanel-план — есть SSH? Можно ли запускать PM2 как долгоживущий процесс? Если нет — делаю scanner worker как `worker_threads` внутри `server.js`, но заложу ограничения.

**Q3.** Какой SQLite-файл сейчас в продакшене `/home/chmtop/chmup_backend/data/chmup.db`? Там данные (зарегистрированные юзеры) или пусто? Если пусто — дропаем и создаём по новой схеме. Если есть юзеры — нужен bridge-migration.

### Группа Б — бизнес-решения

**Q4.** Тарифы: подтверди или измени:
- Free $0: 3 cherry-picked signals/day, 1 bot, strategy LEVELS only
- Starter $29: ∞ signals, 2 bots, LEVELS + SMC
- Pro $79: ∞ signals, 5 bots, **auto-trade**, LEVELS+SMC+GERCHIK, 10 backtests/day
- Elite $149: всё безлимит, все стратегии, optimizer, API access

Есть trial period? (Сейчас в спеке нет, но стандартная практика — 7 дней Pro бесплатно при регистрации.)

**Q5.** Ref-программа — спека говорит 20%. Текущая БД `referrals.commission_pct` = 10%. Подтверди 20%? Ещё: выплаты — только крипто, раз в месяц, manual approval admin'а (как сейчас описано) или автовывод при достижении порога?

**Q6.** Auto-trade в MVP: подтверждаешь что **paper mode по умолчанию**, live-trade включается отдельно с модалкой подтверждения? Circuit breaker 10% суточного убытка ок?

**Q7.** Какие биржи из списка спеки реально поддерживаем в MVP:
- P0 (обязательно): Bybit + Binance + BingX + OKX
- P1 (если успеем): Bitget, HTX, Gate, BitMEX
- Подтверди или урежь.

### Группа В — дизайн архитектуры (не блокирует, но повлияет на код)

**Q8.** Я собираюсь:
- Использовать **CommonJS** (текущий стиль проекта) или переехать на **ESM**? (Node 18+ поддерживает ESM натив но миграция — сейчас всё в `require()`.) Рекомендую CommonJS в MVP, миграция на ESM — отдельная задача.
- Добавить TypeScript? Рекомендую **нет** в MVP (простота), но если хочешь — делаем `tsconfig.json` с `allowJs:true`, постепенная миграция.

**Q9.** Тесты: vitest достаточно? Или поверх нужен playwright для E2E UI-тестов? В MVP предлагаю только unit + supertest для API, UI-e2e — в P14.

**Q10.** Email рассылка: SMTP через свой (`smtp.yandex.ru`?) или SendGrid / Resend (API)? Резервные коды / magic links сейчас не нужны?

### Группа Г — безопасность

**Q11.** API-ключи бирж — текущие в базе в plaintext. Старых юзеров нет → просто дропаем. Подтверждаешь?

**Q12.** JWT тайминги: access 1 час, refresh 30 дней — ок? Refresh хранится в БД (инвалидация), access — stateless. Если юзер поменял пароль — инвалидировать ВСЕ его refresh-tokens автоматом.

**Q13.** 2FA — для админ-аккаунта (есть `users.is_admin`). TOTP (Google Authenticator)? В MVP ставим заглушку (флаг `requires_2fa`), реальную реализацию — в P13. Подтверди приоритет.

### Группа Д — продуктовые детали

**Q14.** «Cherry-picked» 3 сигнала/день для Free — это:
- Автоматически выбранные по `quality DESC` из всех сгенерированных за день, или
- Админский ручной отбор (через admin panel)?

**Q15.** Demo / paper-trading показывается в UI как «Демо-режим» + виртуальный баланс? Начальный виртуальный капитал — $10 000 по дефолту?

**Q16.** В спеке «expectancy_usd» в метриках бэктеста — это `(winRate × avgWin) - ((1-winRate) × avgLoss)` per trade? Подтверди формулу или своя.

**Q17.** Watermark на графиках (упомянуто как «15 мин работы») — чей он? Логотип CHM на equity curve Chart.js? Как в боте — проверить в `bot/` когда дашь доступ.

---

## 5. Phase 1 — почасовой план (≈ 8 часов работы)

**Цель:** полностью переписанная схема БД + криптоутилиты + фундамент инфраструктуры. После Phase 1 сервер должен стартовать и создавать все 19 таблиц + быть готовым принимать Auth (Phase 2).

### Hour 1 — Подготовка и deps
- Обновить `package.json` под финальный список (раздел 3).
- `npm install` + зафиксировать `package-lock.json`.
- Создать папки: `backend/workers/`, `backend/strategies/`, `backend/utils/`, `backend/tests/`, `backend/tests/fixtures/`.
- Удалить `axios` импорты если где-то используется (замена на fetch).
- Обновить `config/index.js` с fail-fast для ENV.
- Deliverable: `npm run dev` стартует без ошибок. Отчёт в консоли — какие ENV не заданы (если в dev).

### Hour 2 — `backend/utils/crypto.js`
- Реализовать `encrypt(plaintext, key) → 'iv:ct:tag'` через `crypto.createCipheriv('aes-256-gcm', ...)`.
- Реализовать `decrypt(encrypted, key) → plaintext`.
- Валидация ключа: 32 байта (64 hex символа), иначе throw.
- 12-байтный nonce через `crypto.randomBytes(12)`.
- Формат: `base64(iv) + ':' + base64(ciphertext) + ':' + base64(authTag)`.
- Unit-тесты: round-trip на 20 разных строках, валидация неправильного ключа/поломанного ct → throw.
- Deliverable: `npm run test -- crypto` проходит.

### Hour 3 — `backend/utils/logger.js` + `backend/utils/validation.js`
- Winston: в dev — pretty-print в stdout, в prod — JSON через `winston-daily-rotate-file` (директория `logs/`, daily rotation, 14 дней retention).
- Базовые уровни: `error`, `warn`, `info`, `debug`.
- Zod-схемы в `validation.js`: `emailSchema`, `passwordSchema` (min 8, ≥1 digit, ≥1 letter), `symbolSchema` (regex `^[A-Z]{2,10}/?[A-Z]{2,10}$|^[A-Z]{4,20}$`), `timeframeSchema` (enum), `exchangeSchema` (enum).
- Deliverable: `logger.info('test')` → пишет в консоль / файл.

### Hour 4-5 — Переписать `backend/models/database.js`
- Удалить старые таблицы (`DROP TABLE IF EXISTS` каскадно в dev, просто пересоздать файл в prod при первом деплое).
- Создать 19 таблиц по спеке (раздел 4 спеки).
- Создать все индексы по спеке.
- `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON` (уже есть).
- Добавить `PRAGMA synchronous=NORMAL` (быстрее в WAL-режиме, безопасно для trading-app).
- Комментарии на русском к каждой таблице — зачем она.
- Deliverable: `sqlite3 data/chmup.db ".schema"` показывает все 19 таблиц + 20+ индексов.

### Hour 6 — `backend/config/plans.js`
Фича-матрица как константа:
```js
module.exports = {
  free: {
    price: 0, signalsPerDay: 3, maxBots: 1, autoTrade: false,
    strategies: ['levels'], backtestsPerDay: 0, optimizer: false, apiAccess: false,
    maxLeverage: 5, paperTradingOnly: true
  },
  starter: { price: 29, signalsPerDay: Infinity, maxBots: 2, autoTrade: false,
    strategies: ['levels', 'smc'], backtestsPerDay: 0, optimizer: false, apiAccess: false,
    maxLeverage: 10 },
  pro: { price: 79, signalsPerDay: Infinity, maxBots: 5, autoTrade: true,
    strategies: ['levels', 'smc', 'gerchik'], backtestsPerDay: 10, optimizer: false, apiAccess: false,
    maxLeverage: 25 },
  elite: { price: 149, signalsPerDay: Infinity, maxBots: Infinity, autoTrade: true,
    strategies: ['levels', 'smc', 'gerchik', 'scalping'], backtestsPerDay: Infinity, optimizer: true, apiAccess: true,
    maxLeverage: 100 }
};
```
Метод `getLimits(plan)` → возвращает нужный объект. Метод `canUseFeature(plan, feature)` → boolean.
- Deliverable: unit-тесты на все 4 плана × 10 проверок.

### Hour 7 — `backend/utils/db-test.js` и smoke-seed
- Скрипт создаёт:
  - 1 admin юзера (email `admin@chm.local`, password из ENV).
  - 1 test юзера (email `test@chm.local`) с планом Pro.
  - 1 promo-код `WELCOME2026` → grants Pro на 30 дней, max_uses 100.
- Запуск: `npm run db:seed`.
- Deliverable: после `seed` — `sqlite3 ... "SELECT * FROM users"` возвращает 2 строки.

### Hour 8 — Документация + Phase 2 prep
- Обновить `backend/README.md` с описанием новой структуры папок и ENV.
- Написать `phase_1_report.md` с отчётом (что сделано / тесты / риски / вопросы).
- Подготовить `phase_2_plan.md` — задать вопросы по Auth до начала (reset-password flow, refresh rotation, email verification).

### Acceptance Phase 1 (завершена когда):
- [ ] `npm run dev` стартует, БД создаётся, 19 таблиц присутствуют.
- [ ] `npm run test` — все юнит-тесты (crypto + plans) проходят.
- [ ] `npm run db:seed` создаёт тестовых юзеров.
- [ ] Логи пишутся в `logs/app.log` (prod) / консоль (dev).
- [ ] `config/index.js` падает с понятной ошибкой если ENV неполный.
- [ ] `phase_1_report.md` готов.

---

## 6. Риски и предостережения

| # | Риск | Вероятность | Митигация |
|---|---|---|---|
| R1 | Без бота пропорции стратегий не совпадут с ботом — юзеры увидят другие сигналы | Высокая | Разблокировать B1 до P5. Иначе порт даст визуально похожие, но численно другие сигналы |
| R2 | SQLite на Passenger — файл может быть залочен при shutdown, WAL-файл остаётся | Средняя | Graceful shutdown, `db.close()` в SIGTERM/SIGINT. Бэкап раз в 6 часов |
| R3 | CCXT rate-limits для bulk-scanning → 429 блокировки | Высокая | p-queue concurrency=3, exponential backoff, уважать `ccxt.enableRateLimit` |
| R4 | Auto-trade баг = реальная потеря денег | Высокая | Paper-mode default, testnet first, circuit breaker 10%, обязательный manual confirm при switch на live |
| R5 | Stripe заблочит аккаунт за «крипто» | Средняя | Crypto-пэймент как primary, Stripe — опциональный. Формулировка на сайте: «software subscription», не «trading service» |
| R6 | cPanel Passenger убивает long-lived worker | Средняя | Альтернатива — PM2 через SSH, если нет — `setInterval` внутри Passenger + cron hook через node-cron |
| R7 | Math.random() в MVP продержится дольше чем надо (соблазн «допилим потом») | Высокая | **Жёсткое правило**: не деплоим в prod пока бэктест не реален. Прод только после P7 |
| R8 | Новая схема БД в prod без миграции сломает юзеров если они уже есть | Низкая (по Q3 должна быть пустая) | Проверить через Q3. Если юзеры есть — миграция, не дроп |

---

## 7. Что делаю следующим шагом

**Жду твоих ответов минимум на:**
- **B1** (доступ к боту) — без этого дальше P4 идти нельзя.
- **Q3** (пустая ли prod БД).
- **Q4** (подтверждение тарифов и trial).
- **Q7** (список бирж на MVP).

Остальные вопросы можно отложить — не блокируют Phase 1.

Когда ответишь и дашь **"go"**, начну Phase 1 по плану выше (часы 1-8). По окончании — `phase_1_report.md` и жду "go" на Phase 2.

Код не трогаю до твоего сигнала. Подтверди что готов идти.


