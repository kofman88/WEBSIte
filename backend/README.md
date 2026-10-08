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
├── utils/           # logger, metrics, sentry, crypto, validation, db-*
├── tests/           # vitest
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
