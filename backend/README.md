# CHMUP Backend

Бэкенд для платформы chmup.top - создание торговых ботов и бэктестов для криптовалютных бирж.

## 🚀 Возможности

- **Аутентификация**: Регистрация, вход, JWT токены
- **Торговые боты**: Создание, управление, активация/деактивация
- **Бэктесты**: Запуск тестирования стратегий на исторических данных
- **Биржи**: Поддержка Bybit, BingX, Binance, OKX через CCXT
- **API**: REST API с документацией

## 📋 Требования

- Node.js 18+ 
- npm или yarn
- cPanel с поддержкой Node.js (для продакшена)

## ⚙️ Установка

### 1. Клонирование и установка зависимостей

```bash
cd chmup_backend
npm install
```

### 2. Настройка переменных окружения

Скопируйте `.env.example` в `.env` и настройте:

```bash
cp .env.example .env
```

Откройте `.env` и измените:

```env
PORT=3000
JWT_SECRET=ваш-секретный-ключ-случайная-строка
DATABASE_PATH=./data/chmup.db
NODE_ENV=production
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

## 📡 API Endpoints

### Аутентификация

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/auth/register` | Регистрация нового пользователя |
| POST | `/api/auth/login` | Вход пользователя |
| GET | `/api/auth/me` | Получить текущего пользователя |

### Боты

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/bots` | Список всех ботов |
| GET | `/api/bots/stats` | Статистика по ботам |
| POST | `/api/bots` | Создать нового бота |
| GET | `/api/bots/:id` | Получить бота по ID |
| PUT | `/api/bots/:id` | Обновить бота |
| PATCH | `/api/bots/:id/toggle` | Активировать/деактивировать |
| GET | `/api/bots/:id/trades` | История сделок |
| DELETE | `/api/bots/:id` | Удалить бота |

### Бэктесты

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/backtests` | Список всех бэктестов |
| GET | `/api/backtests/stats` | Статистика по бэктестам |
| POST | `/api/backtests` | Создать новый бэктест |
| GET | `/api/backtests/:id` | Получить бэктест по ID |
| DELETE | `/api/backtests/:id` | Удалить бэктест |

### Биржи

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/exchanges` | Список поддерживаемых бирж |
| GET | `/api/exchanges/:name/pairs` | Торговые пары биржи |
| GET | `/api/exchanges/:name/price?symbol=` | Цена для символа |
| GET | `/api/balance/:exchangeName` | Баланс на бирже (требуется auth) |

## 🔐 Примеры запросов

### Регистрация
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

### Вход
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

### Создание бота (нужен токен)
```bash
curl -X POST http://localhost:3000/api/bots \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "BTC Scalper",
    "exchangeName": "bybit",
    "symbol": "BTCUSDT",
    "strategyType": "scalping",
    "leverage": 5,
    "positionSizeUsd": 100,
    "stopLossPct": 2,
    "takeProfitPct": 4
  }'
```

### Запуск бэктеста
```bash
curl -X POST http://localhost:3000/api/backtests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "BTC Strategy Test",
    "symbol": "BTCUSDT",
    "exchangeName": "bybit",
    "timeframe": "1h",
    "startDate": "2024-01-01",
    "endDate": "2024-03-01",
    "initialCapital": 1000,
    "strategyConfig": {"rsiPeriod": 14, "emaPeriod": 50}
  }'
```

## 📁 Структура проекта

```
chmup_backend/
├── config/          # Конфигурация
│   └── index.js
├── models/          # Модель базы данных
│   └── database.js
├── routes/          # API роуты
│   ├── auth.js
│   ├── bots.js
│   ├── backtests.js
│   └── exchanges.js
├── services/        # Бизнес-логика
│   ├── authService.js
│   ├── botService.js
│   ├── backtestService.js
│   └── exchangeService.js
├── utils/           # Утилиты
├── data/            # SQLite база данных (создается автоматически)
├── .env             # Переменные окружения
├── .env.example     # Шаблон переменных
├── package.json
└── server.js        # Точка входа
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

## 🛡️ Безопасность

- JWT аутентификация
- Хеширование паролей (bcrypt)
- Rate limiting
- Helmet.js заголовки безопасности
- Валидация входных данных

## 📝 Лицензия

MIT
