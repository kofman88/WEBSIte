# CHM Finance — Инструкция по запуску на cPanel

## Структура проекта

```
WEBSIte/
├── backend/           # Node.js API сервер
│   ├── server.js      # Точка входа
│   ├── config/        # Конфигурация
│   ├── middleware/     # Auth middleware
│   ├── models/        # SQLite база данных
│   ├── routes/        # API маршруты
│   ├── services/      # Бизнес-логика
│   └── package.json
├── frontend/          # Статические HTML файлы
│   ├── index.html     # Лендинг (главная)
│   ├── dashboard.html # Дашборд
│   ├── bots.html      # Управление ботами
│   ├── signals.html   # Сигналы
│   ├── backtests.html # Бэктесты
│   ├── wallet.html    # Кошелёк и биржи
│   ├── settings.html  # Настройки
│   ├── app.js         # Общий JS (API client, Auth, i18n)
│   ├── styles.css     # Общие стили
│   └── assets/        # Изображения
└── deploy-cpanel.sh   # Скрипт деплоя
```

---

## Шаг 1: Подготовка cPanel

### 1.1 Зайдите в cPanel вашего хостинга (chmup.top)

### 1.2 Создайте Node.js приложение
1. Перейдите в **"Setup Node.js App"**
2. Нажмите **"Create Application"**
3. Настройте:
   - **Node.js version**: 18.x или выше
   - **Application mode**: Production
   - **Application root**: `chmup_backend`
   - **Application URL**: `chmup.top` (или поддомен `api.chmup.top`)
   - **Application startup file**: `server.js`
4. Нажмите **"Create"**
5. Запомните путь к виртуальному окружению (напр. `/home/chmtop/nodevenv/chmup_backend/18/`)

---

## Шаг 2: Загрузка файлов

### Вариант A: Через Git (рекомендуется)
```bash
# На сервере через SSH (Terminal в cPanel)
cd /home/chmtop
git clone https://github.com/kofman88/WEBSIte.git
cd WEBSIte
git checkout claude/migrate-bot-functions-0CR4F

# Копируем файлы
cp -r frontend/* ~/public_html/
cp -r backend/* ~/chmup_backend/
```

### Вариант B: Через File Manager
1. Загрузите содержимое `frontend/` в `public_html/`
2. Загрузите содержимое `backend/` в `chmup_backend/`

### Вариант C: Через SSH + rsync (deploy-cpanel.sh)
```bash
CPANEL_HOST=chmup.top CPANEL_USER=chmtop ./deploy-cpanel.sh
```

---

## Шаг 3: Настройка бэкенда

### 3.1 Установите зависимости
```bash
cd ~/chmup_backend
source /home/chmtop/nodevenv/chmup_backend/18/bin/activate
npm install --production
```

### 3.2 Создайте файл .env
```bash
cp .env.example .env
nano .env
```

Заполните:
```env
PORT=3000
JWT_SECRET=СГЕНЕРИРУЙТЕ_ДЛИННЫЙ_СЛУЧАЙНЫЙ_КЛЮЧ_32+_СИМВОЛОВ
DATABASE_PATH=./data/chmup.db
NODE_ENV=production
CORS_ORIGIN=https://chmup.top

# Шифрование кошельков (сгенерируйте: openssl rand -hex 32)
WALLET_ENCRYPTION_KEY=ВАШ_64_СИМВОЛЬНЫЙ_HEX_КЛЮЧ

# API ключи бирж (опционально, для серверной торговли)
BYBIT_API_KEY=
BYBIT_API_SECRET=
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINGX_API_KEY=
BINGX_API_SECRET=
```

### 3.3 Создайте директорию для БД
```bash
mkdir -p ~/chmup_backend/data
```

---

## Шаг 4: Настройка проксирования API

### Вариант A: .htaccess (Apache + mod_proxy)
Добавьте в `~/public_html/.htaccess`:
```apache
RewriteEngine On

# API запросы проксируем на Node.js
RewriteRule ^api/(.*)$ http://127.0.0.1:3000/api/$1 [P,L]

# WebSocket
RewriteRule ^ws$ ws://127.0.0.1:3000/ws [P,L]

# Все остальное — статика
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.*)$ /index.html [L]
```

### Вариант B: Поддомен для API
1. Создайте поддомен `api.chmup.top`
2. Направьте его на порт Node.js приложения
3. Во фронтенде `app.js` измените `API_BASE` на `https://api.chmup.top/api`

---

## Шаг 5: Запуск

### Запустите Node.js приложение
1. В cPanel → **"Setup Node.js App"**
2. Найдите ваше приложение
3. Нажмите **"Restart"**

### Проверьте работу
```bash
curl https://chmup.top/api/health
# Ожидаемый ответ: {"status":"ok","timestamp":"...","version":"2.0.0"}
```

---

## Шаг 6: Проверка

Откройте в браузере:
- `https://chmup.top/` — лендинг
- `https://chmup.top/api/health` — API health check
- Зарегистрируйтесь через форму → попадёте в дашборд

---

## API Endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| GET | `/api/auth/me` | Текущий пользователь |
| GET | `/api/bots` | Список ботов |
| POST | `/api/bots` | Создать бота |
| PATCH | `/api/bots/:id/toggle` | Вкл/выкл бота |
| GET | `/api/signals` | Сигналы (с пагинацией) |
| GET | `/api/signals/live` | SSE поток сигналов |
| GET | `/api/signals/stats` | Статистика сигналов |
| GET | `/api/subscriptions/plans` | Тарифы |
| POST | `/api/subscriptions/activate` | Активация подписки |
| POST | `/api/subscriptions/promo` | Промо-код |
| POST | `/api/wallet/create` | Создать кошелёк |
| GET | `/api/wallet/balance` | Баланс кошелька |
| POST | `/api/wallet/withdraw` | Вывод средств |
| GET | `/api/backtests` | Список бэктестов |
| POST | `/api/backtests` | Запустить бэктест |
| GET | `/api/exchanges/exchanges` | Список бирж |
| GET | `/api/health` | Health check |

---

## Подписки и тарифы

| План | Цена | Сигналы | Боты | Авто-торговля | Бэктесты |
|------|------|---------|------|---------------|----------|
| Free | $0 | 3/день | 1 | Нет | Нет |
| Starter | $29/мес | Безлимит | 3 | Нет | Нет |
| Pro | $79/мес | Безлимит | 10 | Да | Да |
| Elite | $149/мес | Безлимит | Безлимит | Да | Да + API |

---

## Технологический стек

**Backend**: Node.js 18+, Express 4, SQLite (better-sqlite3), JWT, bcrypt, CCXT, WebSocket (ws)

**Frontend**: HTML5, Tailwind CSS 4, Chart.js, GSAP, Vanilla JS

**Безопасность**: Helmet.js, CORS, Rate Limiting, AES-256-CBC шифрование ключей, JWT auth

---

## Обновление

```bash
cd /home/chmtop/WEBSIte
git pull origin claude/migrate-bot-functions-0CR4F
cp -r frontend/* ~/public_html/
cp -r backend/* ~/chmup_backend/
cd ~/chmup_backend
npm install --production
# Перезапустите приложение через cPanel
```

---

## Устранение проблем

**Приложение не запускается:**
```bash
cd ~/chmup_backend
node server.js  # Смотрите ошибки в терминале
```

**API возвращает 502/503:**
- Проверьте что Node.js приложение запущено в cPanel
- Проверьте .htaccess проксирование
- Проверьте логи: `~/chmup_backend/logs/` или cPanel Error Log

**БД не создаётся:**
```bash
mkdir -p ~/chmup_backend/data
chmod 755 ~/chmup_backend/data
```

---

## Production-чеклист (Phase 14)

### 1. Переменные окружения (`backend/.env`)

Обязательные:
```
NODE_ENV=production
PORT=3000
DATABASE_PATH=/home/<user>/chmup_backend/data/chm.db
JWT_SECRET=<32+ символа hex>
JWT_REFRESH_SECRET=<32+ символа hex>
WALLET_ENCRYPTION_KEY=<64 символа hex — AES-256 ключ>
CORS_ORIGIN=https://chmup.top
```

Платежи (если используете):
```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PAYMENT_BEP20_ADDRESS=0x...
PAYMENT_TRC20_ADDRESS=T...
BSCSCAN_API_KEY=...
TRONSCAN_API_KEY=...   # опционально
```

Мониторинг:
```
LOG_LEVEL=info
SENTRY_DSN=https://...@sentry.io/...   # опционально
```

### 2. PM2 (если не cPanel/Passenger)

```bash
cd ~/chmup_backend
npm install --production
npm install -g pm2
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # — выполните выданную команду
```

Мониторинг:
```bash
pm2 monit            # live-дашборд
pm2 logs chm-api     # tail логов
pm2 restart chm-api  # рестарт без downtime
```

### 3. Health-чеки

- **Liveness**: `GET /api/health` — быстрый 200 без DB
- **Readiness**: `GET /api/health/deep` — проверяет DB, scanner worker,
  partialTp cron, slVerifier; возвращает 503 если любая подсистема упала

Для UptimeRobot: настройте HTTP-проверку `/api/health/deep` каждые 5 минут.

### 4. Safety-крон: slVerifier

`services/slVerifier.js` каждые 5 минут:
- Считывает все trades где `status='open' AND trading_mode='live'`
- Для каждой сделки парсит `exchange_order_ids.sl`
- Вызывает `ccxt.fetchOrder(sl_id)`
- Если ордера нет / cancelled / filled — пишет в `audit_log` с
  `action='sl_verifier.missing'` и выдаёт ERROR-лог

Проверка работы:
```bash
sqlite3 data/chm.db "SELECT * FROM audit_log WHERE action LIKE 'sl_verifier.%' ORDER BY created_at DESC LIMIT 20;"
```

### 5. Аудит безопасности

```bash
cd backend
npm audit --omit=dev    # должно быть "found 0 vulnerabilities"
```

Dev-зависимости (vitest/vite) содержат известные низко-критичные
уязвимости — на прод они не попадают.

### 6. Нагрузочный тест (smoke)

Быстрый тест 100 параллельных запросов к health:
```bash
npm install -g autocannon
autocannon -c 50 -d 30 https://chmup.top/api/health
```

Ожидаемо: p99 < 100ms, 0 ошибок.

### 7. Бэкапы

SQLite файл `data/chm.db` — единственное состояние. Настройте daily:
```bash
cp data/chm.db backups/chm-$(date +%F).db
find backups -mtime +30 -delete
```

Либо через cPanel → Backup → Partial Backup → Home Directory.
