# CHMUP Backend

Бэкенд для платформы chmup.top — standalone-порт Telegram-бота CHM_BREAKER_V4
(сигналы LEVELS / SMC / VOLUME, авто-трейд, тарифы Free/Pro). План порта:
`docs/port/PLAN.md` (в репозитории — после M0), спеки — `docs/port/*.md`.

Статус: **M0 (prune)** — удалено всё, чего нет у бота (боты-инстансы, бэктесты,
маркетплейс, копитрейдинг, кошелёк, академия/блог/AI, старый движок сигналов и
аналитика). Движок (`strategies/{levels,smc,volume}`, `services/engine/*`,
`routes/app.js`) появляется в M1–M12.

## 🚀 Что уже есть (платформа)

- **Аутентификация**: регистрация, вход, JWT + refresh-rotation, email-верификация, 2FA, сессии, OAuth (Google / Telegram)
- **Платежи и подписки**: Stripe, USDT (BEP20/TRC20) с авто-подтверждением, промокоды, рефералы
- **Биржевые ключи**: AES-256-GCM хранение ключей Bybit / Binance / BingX / OKX (`/api/exchanges/keys`)
- **Админ / ops**: пользователи, платежи, промо, рефералы, флаги, аудит, impersonation (`/ops.html`)
- **Поддержка**: тикеты, шаблоны ответов, присутствие агентов
- **Уведомления**: in-app, email outbox, Telegram, Web Push
- **Платформа**: health/metrics, бэкапы и retention, Sentry, логи

## 📋 Требования

- Node.js 18+ (CI — 20)
- npm
- cPanel с поддержкой Node.js (для продакшена)

## ⚙️ Установка

### 1. Клонирование и установка зависимостей

```bash
cd backend
npm install
```

### 2. Настройка переменных окружения

Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
```

Критичные переменные (в production сервер не стартует без них):

```env
PORT=3000
JWT_SECRET=...            # openssl rand -hex 32
JWT_REFRESH_SECRET=...    # openssl rand -hex 32
WALLET_ENCRYPTION_KEY=... # ровно 64 hex-символа — шифрование биржевых ключей
DATABASE_PATH=./data/chmup.db
NODE_ENV=production
CORS_ORIGIN=https://chmup.top
```

### 3. Запуск сервера

**Режим разработки:**
```bash
npm run dev
```

**Продакшен режим:**
```bash
npm start
```

**Проверки:**
```bash
npm run lint       # eslint (flat config в корне репозитория)
npm run test:run   # vitest
npm run smoke      # scripts/smoke.js против запущенного сервера
```

## 📡 API Endpoints

Пользовательский API движка (`/api/app/*`, зеркало `miniapp/API.md` бота)
появляется с M7. Сейчас доступны платформенные маршруты:

| Префикс | Описание |
|---------|----------|
| `/api/auth` | Регистрация, вход, refresh, `/me`, email-верификация, сброс пароля, 2FA, сессии, OAuth, экспорт данных |
| `/api/exchanges` | Список бирж, CRUD биржевых ключей (`verify` / `balance` отвечают 501 до M13) |
| `/api/subscriptions` | Тарифы, статус, промокоды, usage, отмена |
| `/api/payments` | Stripe checkout + webhooks, USDT-инвойсы, рефералы |
| `/api/notifications` | In-app уведомления |
| `/api/telegram`, `/api/push` | Привязка Telegram, Web Push подписки |
| `/api/support` | Тикеты (пользователь + админ), гостевой контакт |
| `/api/admin` | Back-office (требует `is_admin`) |
| `/api/health`, `/api/health/deep`, `/api/version`, `/metrics` | Liveness / readiness / build info / Prometheus |

### Примеры

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'

curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'

curl http://localhost:3000/api/exchanges/keys -H "Authorization: Bearer YOUR_TOKEN"
```

## 🧪 Тесты веб-приложения `/app/` (M11)

Экраны бота (`frontend/app/`) проверяются против контрактного стаба
`backend/utils/app-stub.js` — in-memory Express без БД: `/api/app/*` по
`miniapp/API.md` в форме M7 (`settings/all` с секциями D9 `levels.shared / long /
short`, `smc.advanced`, `risk.advanced`, `ptp`, `options.choices`, валидация по
схеме `appSettingsService` → `bad_request "<секция>.<ключ>"`), срез `/api/auth`
(login / 2FA / register / refresh с ротацией / logout / `me` / providers /
telegram) и раздача `frontend/` как в `server.js` (`/app/` → `frontend/app/index.html`).
Учётки: `demo@chm.local` (Free), `pro@chm.local` (Pro), `2fa@chm.local` (код
`000000`), `empty@chm.local` (без сигналов), пароль `demo1234`; заголовок
`X-Demo-Plan: pro|free` показывает другой тариф тому же аккаунту. Тестовые хуки:
`POST /api/auth/__stub/expire-access` (протухшие access-токены → приложение
обязано обновиться один раз), `__stub/disable {email, disabled}` (403
`ACCOUNT_DISABLED`), `__stub/reset` (исходное состояние).

```bash
cd backend
npx vitest run tests/e2e                 # контракт стаба + статическая обвязка (supertest)
node tests/e2e/serve-stub.js 3199        # ручной QA: http://127.0.0.1:3199/app/
python tests/e2e/app.e2e.py              # Playwright, 390×844 и 1280×900: вход (ошибка пароля,
                                         # 2FA), все вкладки и 12 разделов настроек без
                                         # «Раздел недоступен», деталь сигнала + Back браузера,
                                         # POST strategy с телом Mini App (+ Free-мьютекс),
                                         # bad_request settings/all → тост бота, вложенное
                                         # сохранение D9, refresh после 401, 403 → экран входа,
                                         # logout, session-only вход, ?demo=pro без бэкенда
python tests/e2e/app_smoke.py            # короткий smoke тех же экранов (один viewport)
```

Playwright-скрипты не входят в `vitest run` (нужны Chromium и Playwright для
Python: `pip install playwright && playwright install chromium`; свой бинарь —
`--chromium /path/to/chromium`, скриншоты — `--shots DIR`, порт — `--port`).

## 📁 Структура проекта

```
backend/
├── config/          # index.js (env), planFeatures.js (матрица тарифов бота, verbatim),
│                    # plans.js (каталог free / pro, производный от planFeatures)
├── middleware/      # auth, geoBlock, handleErr, requestId
├── models/          # database.js (better-sqlite3, WAL), migrations.js (v10 engine_core,
│                    # v11 genome, v12 retire_bots), engineSchema.js (trader_settings /
│                    # signal_trades / engine_kv / … — см. services/engine/README.md)
├── routes/          # auth, exchanges, subscriptions, payments, admin,
│                    # notifications, telegram, push, support, public
├── services/        # authService, paymentService, subscriptionService,
│                    # adminService, supportService, notifier, emailService,
│                    # telegramService, pushService, exchangeService, …
├── workers/         # paymentWatcher (крипто-платежи)
├── utils/           # logger, metrics, sentry, crypto, validation, db-*, app-stub (контракт /api/app)
├── tests/           # vitest; tests/e2e — стаб-контракт + Playwright (app.e2e.py, app_smoke.py)
├── data/            # SQLite база данных + бэкапы (создаётся автоматически)
├── .env.example
├── package.json
└── server.js        # Точка входа (Passenger / standalone)
```

## 🔧 Установка на cPanel

1. **Загрузите файлы** через File Manager или FTP
2. **Установите Node.js** через "Setup Node.js App" в cPanel
3. **Создайте приложение**:
   - Node.js version: 18 или выше
   - Application root: `/home/username/chmup_backend`
   - Application URL: `chmup.top`
   - Application startup file: `server.js`
4. **Установите зависимости** через Terminal:
   ```bash
   cd ~/chmup_backend
   npm install --production
   ```
5. **Настройте .env** файл
6. **Запустите приложение** через кнопку "Start" в cPanel

Подробнее: `DEPLOYMENT.md`, `docs/runbook.md`.

## 🛡️ Безопасность

- JWT аутентификация + refresh-rotation
- Хеширование паролей (bcrypt), 2FA (TOTP)
- Rate limiting, Helmet.js, валидация входных данных (zod)
- Биржевые ключи только в зашифрованном виде (AES-256-GCM)

## 📝 Лицензия

MIT
