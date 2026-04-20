# CHM Finance · Deployment + Operations runbook

End-to-end инструкция для ветки `claude/redesign-homepage-kkFmK` (PR #5).
Покрывает весь функционал, добавленный в сессии — от Phase A до block 31.

---

## 1. Deploy на cPanel (`chmtop@s33`)

Всё состояние ветки уже запушено в `origin`. На сервере:

```bash
ssh chmtop@s33.chmup.top

# Подтянуть изменения
cd ~/WEBSIte
git fetch origin
git checkout claude/redesign-homepage-kkFmK
git pull origin claude/redesign-homepage-kkFmK

# Атомарный деплой (написан в block 11)
bash scripts/deploy.sh
```

Если merge в `main` уже сделан — те же команды, только `git checkout main && git pull`.

**Rollback** (если что-то пошло не так):
```bash
bash scripts/deploy.sh --rollback
```
Symlink мгновенно переключается на предыдущий релиз + Passenger рестарт.

---

## 2. `.env` — обязательные и опциональные переменные

Редактируется через cPanel → **Node.js Apps** → *Edit environment variables*, либо напрямую в `~/chmup_backend/.env`.

### Critical (без них сервис либо не стартует, либо неполный)

```bash
NODE_ENV=production
JWT_SECRET=<32+ chars random>
JWT_REFRESH_SECRET=<32+ chars random>
WALLET_ENCRYPTION_KEY=<64 hex chars = 32 bytes>   # `openssl rand -hex 32`
DATABASE_PATH=/home/chmtop/chmup_backend/data/chm.db
CORS_ORIGIN=https://chmup.top
APP_URL=https://chmup.top
```

### Payments

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...          # CRITICAL в prod — без него /payments/webhook вернёт 503 (block 2)
PAYMENT_BEP20_ADDRESS=0x...              # необязательно, для крипто-оплаты
PAYMENT_TRC20_ADDRESS=T...
```

### Notifications

```bash
# Email (cPanel Exim или внешний SMTP)
SMTP_HOST=localhost
SMTP_PORT=465
SMTP_USER=no-reply@chmup.top
SMTP_PASS=<password>
SMTP_FROM="CHM Finance <no-reply@chmup.top>"

# Telegram
TELEGRAM_BOT_TOKEN=...                   # или после `node utils/migrate-tg-token.js` можно удалить
TELEGRAM_BOT_USERNAME=CHMUP_bot
TELEGRAM_WEBHOOK_SECRET=<random>         # block 5 — секрет для setWebhook

# Web Push (block 21)
WEB_PUSH_PUBLIC_KEY=...                  # `node utils/generate-vapid.js`
WEB_PUSH_PRIVATE_KEY=...
WEB_PUSH_SUBJECT=mailto:security@chmup.top
```

### Geo-block / security

```bash
GEO_BLOCK_ENABLED=1                      # block paid US/EU traffic
GEO_BLOCK_COUNTRIES=US,IR,KP,CU,SY       # default если не задано
SENTRY_DSN=https://...@sentry.io/...     # опционально
```

### Affiliate / features

```bash
REF_SIGNUP_BONUS_USD=10                  # block 29 — фиксированный bonus за первого платящего реферала (0 = off)
PUSH_TEST_ENABLED=0                      # block 21 — включать только для отладки
MAINTENANCE_DISABLED=0
SECURITY_MONITOR_DISABLED=0
```

После правок `.env`:
```bash
touch ~/chmup_backend/tmp/restart.txt
curl -s https://chmup.top/api/health | jq .
```

---

## 3. Первичная настройка

### 3.1 Сделать себя админом

Только через SQL (UI для этого нет намеренно):
```bash
sqlite3 ~/chmup_backend/data/chm.db "UPDATE users SET is_admin=1, admin_role='superadmin' WHERE email='your@email.com'"
```

Перелогинься на сайте — токен перевыпустится с `is_admin=1`, и станет доступен `/ops.html`.

### 3.2 Перенести TG-токен в encrypted storage (опционально)

```bash
cd ~/chmup_backend
node utils/migrate-tg-token.js            # читает TELEGRAM_BOT_TOKEN из env
# После: удалить TELEGRAM_BOT_TOKEN из .env + restart
```

Откатить:
```bash
node utils/migrate-tg-token.js --clear
```

### 3.3 Сгенерировать VAPID для Web Push

```bash
cd ~/chmup_backend
node utils/generate-vapid.js
# Скопировать обе строки в .env → restart.
```

### 3.4 Email deliverability (critical для инбокс-доставки)

См. `docs/email-deliverability.md` в репозитории. Коротко:
1. SPF → DNS TXT на `@`
2. DKIM → cPanel → Email Deliverability → Enable → копируй в DNS
3. DMARC → `_dmarc.chmup.top` с `p=none` на старте → через 2 недели `p=quarantine`
4. Email aliases: `support@`, `security@`, `privacy@`, `press@chmup.top`

### 3.5 Cron для smoke-test и бэкапов

```bash
crontab -e
```
Добавить:
```
*/5 * * * * cd ~/chmup_backend && node ../scripts/smoke.js >> /tmp/smoke.log 2>&1
0 3 * * * sqlite3 ~/chmup_backend/data/chm.db ".backup /home/chmtop/backups/chm-$(date +\%Y\%m\%d).db"
```

(Бэкапы также делаются из приложения — cron нужен как независимая страховка.)

---

## 4. Использование `/ops` back-office

Открыть `https://chmup.top/ops.html` залогиненным админом. 11 вкладок:

| Вкладка | Что делает |
|---|---|
| Dashboard | MRR, DAU/WAU/MAU, revenue-chart (7/30/90d), support queue, pipeline |
| Users | Поиск по email/ref-коду → клик на строку → 360° drawer (Block/Grant admin/Plan/Notify/Impersonate) |
| Bots | Global feed со всеми ботами платформы |
| Trades | Global feed сделок, фильтры status/mode |
| Signals | Global feed сигналов, фильтр strategy |
| Payments | Confirm (manual) + Refund (авто-cascade: cancel reward → downgrade → deactivate bots) |
| Billing | Cohort MRR, churn 30d, LTV, ARPPU (block 23) |
| Promo | CRUD промокодов |
| Referrals | Pay/Cancel выплат |
| Support | Очередь тикетов |
| System | Process / DB / backups состояние |
| Flags | 7 feature flags — toggleable без рестарта (block 12) |
| Audit | Activity chart + by-category + top-admins + полный log (block 27) |

### Раздача доступов сотрудникам

`/ops` → Users → найти → **Grant admin** → подтвердить.

Первый grant по дефолту создаёт `admin_role='support'`. Чтобы выдать более широкие права — повторно PATCH `/api/admin/users/:id/admin-role`:

```bash
curl -X PATCH https://chmup.top/api/admin/users/123/admin-role \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"billing"}'   # или superadmin / support / billing / viewer
```

Role → capabilities матрица зашита в `middleware/auth.ADMIN_ROLES`:

| Role | Capabilities (кратко) |
|---|---|
| `superadmin` | `*` — всё, включая feature flags и grant admin |
| `support` | User read/notify/plan/block, support r/w, read bots/trades/signals, audit, impersonate |
| `billing` | User read/plan, payments r/confirm/refund, promo r/w, rewards r/payout, audit |
| `viewer` | Read-only всё |

### Impersonation

User drawer → **🎭 Impersonate** → вводишь причину → открывается новая вкладка под target-юзером. Твой admin-session в исходной вкладке не трогается. Токен живёт 30 минут без refresh, красный баннер сверху весь период.

### Maintenance mode

Flags → `maintenance` → Turn on. API возвращает 503 для всех не-админов. Админы проходят, чтобы можно было выключить обратно.

---

## 5. Как выдавать подписки / раздавать триалы

### Через UI (быстро)
`/ops` → Users → открыть → **Plan…** → ввести `pro` + `30` (дней) → Apply.

### Промокод (массово)
`/ops` → Promo → форма:
- `code: TRIAL7` — любая уникальная строка
- `plan: pro`
- `durationDays: 7`
- `maxUses: 500`
- `discountPct: 100` (100 = бесплатно, 20 = −20%)

Ссылка: `https://chmup.top/?promo=TRIAL7`

### Через API
```bash
curl -X PATCH https://chmup.top/api/admin/users/42/plan \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"elite","durationDays":365}'
```

---

## 6. Community features (block 30-31)

### Copy trading

- **Публичный профиль** — пользователь включает в `/settings.html` → Community → Public profile toggle.
- **Подписка** — `/leaderboard.html` → кнопка **Copy** на любой строке → paper-бот `copy:<leaderId>` автоматически создаётся и зеркалит сигналы.
- **Live copy** намеренно выключено (400) — требует отдельного compliance-ревью.

### Strategy marketplace

- **Публикация** — `/market.html` → «+ Опубликовать свою» (требует paid-plan).
- **Установка** — 1 клик = клон в paper-бот, `is_active=0` (юзер активирует вручную).
- **Рейтинг** — 1-5 звёзд, после install, одна оценка на юзера на стратегию.

---

## 7. Проверка после деплоя

```bash
# 1. Health
curl -s https://chmup.top/api/health | jq .
curl -s https://chmup.top/api/health/deep | jq .

# 2. Smoke test (10 сценариев)
cd ~/chmup_backend && npm run smoke:prod

# 3. Посмотреть schema_migrations — должно быть 5
sqlite3 ~/chmup_backend/data/chm.db "SELECT * FROM schema_migrations"

# 4. Список feature flags
curl -s https://chmup.top/api/admin/flags -H "Authorization: Bearer $TOKEN" | jq .

# 5. Проверить background workers
# Из логов Passenger:
tail -f ~/chmup_backend/logs/app-$(date +%Y-%m-%d).log
# Должны видеть:
#   "scanner worker started"
#   "maintenance started"
#   "security monitor started"
```

---

## 8. Часто встречающиеся проблемы

| Симптом | Решение |
|---|---|
| «Validation failed» при создании paper-бота | Проверь что deployed версия включает block-18 фикс (`createBotSchema` с refine на `tradingMode==='live'`) |
| Stripe webhook → 503 | `STRIPE_WEBHOOK_SECRET` не задан в prod `.env` |
| «Кривая капитала плывёт» | Hard-reload (Ctrl+Shift+R) — HTML кэшируется 5 минут |
| Email не доходят | `/ops` → System → проверь `subsystems.database.userCount`, потом проверь `email_bounces` на suppression + DNS: SPF/DKIM/DMARC |
| Нет push-уведомлений | `.env`: `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` заданы? Service worker зарегистрирован (DevTools → Application → Service Workers)? |
| GEO_BLOCK не работает | `GEO_BLOCK_ENABLED=1` + перезагрузка Passenger |
| Last superadmin заблокирован | Прямо в DB: `UPDATE users SET is_admin=1, admin_role='superadmin' WHERE email=?` |
| Migration упала на старте | Процесс умирает — логи покажут версию. Откатить к предыдущему релизу через `deploy.sh --rollback` |

---

## 9. Monitoring checklist (ежедневно)

- `/ops` → Dashboard — аномалии в DAU/revenue
- `/ops` → Support — open > 5?
- `/ops` → Audit — подозрительные admin-действия
- `/ops` → System — backup свежий, память <512MB
- `/api/health/deep` — все subsystems.ok

Плюс в 09:00 UTC каждый день приходит автоматический daily digest через notifier (all channels) от `securityMonitor`.

---

## 10. Полезные команды

```bash
# Список активных ботов
sqlite3 ~/chmup_backend/data/chm.db \
  "SELECT u.email, b.name, b.strategy, b.trading_mode FROM trading_bots b JOIN users u ON u.id=b.user_id WHERE b.is_active=1"

# Суммарный revenue за 30 дней
sqlite3 ~/chmup_backend/data/chm.db \
  "SELECT SUM(amount_usd) FROM payments WHERE status='confirmed' AND created_at > datetime('now','-30 day')"

# Размер БД
du -h ~/chmup_backend/data/chm.db

# Восстановить из бэкапа
sqlite3 ~/chmup_backend/data/chm.db ".restore /home/chmtop/backups/chm-20260420.db"

# Очистить suppression list (если слишком жёстко зафильтровало)
sqlite3 ~/chmup_backend/data/chm.db \
  "UPDATE email_bounces SET suppressed=0 WHERE email='user@example.com'"
```

---

## 11. Ссылки на ключевые файлы

- **PR:** https://github.com/kofman88/WEBSIte/pull/5
- **Деплой-скрипт:** `scripts/deploy.sh`
- **Smoke-тест:** `scripts/smoke.js`
- **Email docs:** `docs/email-deliverability.md`
- **Migrations:** `backend/models/migrations.js`
- **Ops UI:** `frontend/ops.html` + `frontend/ops.js`
- **Runbook (этот файл):** `docs/runbook.md`
