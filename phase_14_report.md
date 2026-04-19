# Phase 14 — Отчёт (Testing & Deploy)

**Статус:** ✅ Завершена. **Все 205/205 тестов проходят.**

---

## 1. Что сделано

### 1.1 `services/slVerifier.js` — safety-крон для live-сделок

Каждые 5 минут:
- `SELECT * FROM trades WHERE status='open' AND trading_mode='live'`
- Для каждой сделки: парс `exchange_order_ids.sl` → `ccxt.fetchOrder(sl_id)`
- Если SL-ордер `canceled / closed / expired / rejected / null` → запись
  в `audit_log` с `action='sl_verifier.missing'`, метаданные
  `{reason, slOrderId, symbol, exchange}`, плюс ERROR-лог через winston
- Возвращает отчёт `{checked, ok, missing, errors, tradeIds}` — годный
  для /api/health/deep и админского UI

Design notes:
- `clientResolver` pluggable — по умолчанию берёт ccxt через
  `exchangeService.getCcxtClient(userId, exchange_key_id)` ботa сделки;
  в тестах передаётся мок
- Не закрывает позицию автоматически — это отдельная операция,
  которую включим после verified testnet integration (см. §3)
- Запускается из `server.js` в Passenger- и standalone-ветках
  (skip в test/worker режиме)

### 1.2 Health-эндпоинты

**`GET /api/health`** — лёгкий liveness probe (без DB). 200 OK всегда
если процесс жив. Для ALB / Passenger / Docker healthcheck.

**`GET /api/health/deep`** — readiness probe:
- DB: `SELECT COUNT(*) FROM users` — быстрый connect-check
- `scanner` worker жив
- `partialTp` cron тикает
- `slVerifier` зарегистрирован

Возвращает:
```json
{
  "status": "ok",
  "timestamp": "2026-04-19T13:31:12.000Z",
  "version": "3.0.0",
  "uptimeSeconds": 43210,
  "memoryMb": 142,
  "subsystems": {
    "database": {"ok": true, "userCount": 1523},
    "scanner": {"ok": true},
    "partialTp": {"ok": true},
    "slVerifier": {"ok": true}
  }
}
```

Если любая подсистема падает — `status='degraded'` + HTTP 503. Подходит
для UptimeRobot monitoring.

### 1.3 `ecosystem.config.cjs` — PM2 конфиг

Для standalone-деплоев (не cPanel/Passenger):
- `instances: 1, exec_mode: 'fork'` (SQLite single-writer — кластер не подходит)
- `max_memory_restart: 512M`
- Логи в `./logs/pm2-{error,out}.log`
- Support `--env production` и `--env staging`

### 1.4 DEPLOYMENT.md — production-чеклист

Добавлен раздел «Production-чеклист (Phase 14)» с:
1. Полный список env vars (JWT / wallet / Stripe / Crypto / Sentry)
2. PM2-запуск (`pm2 start ecosystem.config.cjs --env production`)
3. Health-эндпоинты + UptimeRobot-рекомендация
4. slVerifier — проверка через SQL
5. `npm audit --omit=dev` (0 prod-уязвимостей)
6. autocannon load-тест smoke
7. SQLite-бэкапы

### 1.5 Тесты

`backend/tests/slVerifier.test.js` — 7 новых:
- OK-path когда SL-ордер `open`
- Missing когда SL `canceled`
- Missing когда `fetchOrder → null`
- Missing когда нет `sl` в `exchange_order_ids`
- Errors-bump при exception + continue до следующих сделок
- Paper-mode trades пропущены
- No-client error когда resolver возвращает null

Все мокают `clientResolver` → тесты полностью детерминированы, без сети.

**Итого:** 198 → **205/205 тестов**.

---

## 2. Аудит безопасности

```bash
$ cd backend && npm audit --omit=dev
found 0 vulnerabilities
```

Dev-deps (vitest → vite) содержат 6 moderate уязвимостей, но они не
попадают в production bundle.

---

## 3. Что не сделано / отложено

| # | Что | Почему |
|---|---|---|
| 1 | **Playwright E2E-тесты** | Требует headless Chromium в CI — отдельная настройка. Все backend flows уже покрыты supertest-тестами. |
| 2 | **slVerifier auto-close** | Закрытие позиции при обнаружении gap — рискованная операция; включим только после verified Bybit testnet run (Phase 14.5). |
| 3 | **Sentry wire-up** | Env-ключ `SENTRY_DSN` готов к использованию в `config`, но `@sentry/node` не подключён к зависимостям. Добавим при первой обнаруженной проблеме в проде. |
| 4 | **Autocannon load-тест в CI** | Описан в DEPLOYMENT.md как smoke-команда. Полноценный нагрузочный тест 50 concurrent users — ручной шаг перед каждым релизом. |
| 5 | **Gerchik strategy port** | 1500 строк, deferred с Phase 8.5. |
| 6 | **Multi-step bot wizard** | UX-улучшение, не блокер прода. |

---

## 4. Acceptance Phase 14

- [x] `slVerifier` cron — создан, зарегистрирован в server.js
- [x] Health probes — liveness + readiness (`/api/health`, `/api/health/deep`)
- [x] PM2 ecosystem — `backend/ecosystem.config.cjs`
- [x] Production-чеклист в DEPLOYMENT.md
- [x] npm audit --omit=dev = 0 уязвимостей
- [x] Тесты slVerifier — 7/7
- [x] Общий прогон — **205/205 тестов** зелёные

---

## 5. Что дальше

Платформа **готова к деплою**. Порядок выкатки:

1. **Staging**: залить на `staging.chmup.top`, пройти ручной smoke
   (register → wallet → create bot → create backtest)
2. **Production**: `deploy-cpanel.sh` → перезапуск Passenger
3. **Monitoring**: UptimeRobot на `/api/health/deep`, alert в TG
4. **Testnet**: подключить один `Bybit testnet` API-ключ и дать одному
   боту `trading_mode='live'` — следить за `audit_log` +
   `slVerifier` отчётами неделю
5. **Go-live**: после 7 дней чистого testnet — открыть регистрации

Всё готово к запуску.
