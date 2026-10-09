# CHMUP Backend

Бэкенд для платформы chmup.top — standalone-порт Telegram-бота CHM_BREAKER_V4
(сигналы LEVELS / SMC / VOLUME, авто-трейд, тарифы Free/Pro). План порта:
`docs/port/PLAN.md` (в репозитории — после M0), спеки — `docs/port/*.md`.

Статус: **M0 (prune)** — удалено всё, чего нет у бота (боты-инстансы, бэктесты,
маркетплейс, копитрейдинг, кошелёк, академия/блог/AI, старый движок сигналов и
аналитика); **M1** — числовые примитивы pandas/numpy и golden-тесты; **M7** —
домен настроек и тарифа (`trader_settings` как `UserSettings` бота, `TradeCfg`,
тихие часы, профили, зеркало подписки + цикл истечения) и API приложения
`/api/app/*` (см. ниже). Движки (`strategies/{levels,smc,volume}`), рынок,
сканеры и SPA появляются в M2–M12.

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

### `/api/app/*` — API приложения (зеркало Mini App бота, с M7)

Конверт ответов как у бота: `{ok:true, …}` / `{ok:false, error, message?}`,
бизнес-ошибки — HTTP 200; `401 {ok:false,error:"unauthorized"}`; `429
{ok:false,error:"rate_limited",message:"Слишком часто. Повторите через 10 с"}`
(+ `Retry-After`); 400 только там, где у бота 400 (`bad_strategy`,
`nothing_to_change`). Авторизация — JWT сайта (`Authorization: Bearer`).
Корзины лимитов: `post` 30 / 60 с на пользователя (`MINIAPP_POST_PER_MIN`),
`plan` 10 / 60 с.

| Маршрут | Описание |
|---------|----------|
| `GET me` | `user{id, username, first_name, lang, plan, plan_label, sub_expires, is_pro}`, `strategy`, `extra_strategies`, `strategies{LEVELS\|SMC\|VOLUME:{long,short,locked,primary,enabled}}`, `prefs`, `auto_trade`, `exchange` (всегда `""`, как у бота), `bot_username: null` |
| `POST strategy` `{strategy, long, short}` | вкл/выкл направлений; `bad_strategy` (400), `pro_required` (стратегия заблокирована тарифом или LONG+SHORT на Free — [FREE-MUTEX]); `_apply_multi` — доп. стратегии параллельно с основной |
| `POST settings` | тумблеры профиля: `progress_notify_enabled`, `send_chart_enabled`, `genome_auto_apply` (Pro), `signal_format` (`lite`/`full`), `quiet_start`/`quiet_end` (нормализация `quiet_hours.normalize`); пустое тело → 400 `nothing_to_change` |
| `GET settings/all` | `settings` (секции `lang, ui_mode, levels, smc, volume, trading, ptp, risk, exchanges, notifications, genome_auto_apply`) + `options` (`tf_*`, `exchanges`, `leverage`, `risk_pct`, `max_trades`, `min_volume`, `locked[]`, `intervals`, `choices{"секция.ключ": [варианты]}`) |
| `POST settings/all` | частичное тело той же формы; порядок: валидация (`bad_request "<секция>.<ключ>"`) → `bad_request "empty"` → тарифные гейты (`pro_required`, ничего не сохраняется) → бизнес-проверки (`trading.auto_trade: no API keys for <ex>`, `volume.setup_*`) → применение → сохранение. Ответ без `options` |
| `POST profile` `{name}` | профили `conservative` / `active` → `{ok, profile, applied[], skipped[], settings}` |
| `POST lang` `{lang}` | `ru` / `en` |
| `GET plan` | `plan, plan_label, sub_expires, days_left, price_usd (69), features[] (ru/en), ton: null, payment_methods[], checkout_url, admin_contact` |
| `GET help` | 11 разделов справки (`help_content.py` дословно, HTML снят) на языке пользователя |
| `POST settings/reset` | заводской сброс настроек (`db_reset_user_settings`, `_RESET_PRESERVE`) → `{ok, settings}` |
| `POST volume/reset` | сброс параметров VOLUME (`reset_user_cfg`, сетапы и HTF-фильтр сохраняются; Pro) → `{ok, settings}` |

Секции `settings/all`, которых нет в Mini App бота (решение D9 — всё, что у бота
менялось только через Telegram-меню, теперь доступно на вебе с той же валидацией,
что в хендлерах: радио-меню принимают ровно свои варианты, явные clamp'ы стали
диапазонами):

| Секция | Ключи |
|--------|-------|
| `levels.shared` | `timeframe`, `scan_interval`, `pivot_strength`, `max_level_age`, `max_retest_bars`, `zone_buffer`, `max_level_tests`, `ema_fast`, `ema_slow`, `htf_ema_period`, `use_pattern`, `rsi_period`, `rsi_ob`, `rsi_os`, `vol_mult`, `cooldown_bars`, `atr_period`, `atr_mult`, `tp1_rr` (0 < v ≤ 100), `tp2_rr`, `tp3_rr`, `high_wr_mode`, `levels_counter_trend_min_quality` (0..5) |
| `levels.long` / `levels.short` | все поля `TradeCfg` как явные оверрайды направления (sparse `long_cfg`/`short_cfg`), `interval` (`long_interval`/`short_interval`), `reset: true` (= `reset_long_cfg`); в ответе `overrides[]` — какие ключи переопределены |
| `smc.advanced` | `min_confirmations`, `min_rr`, `sl_buffer_pct`, `fvg_enabled`, `choch_enabled`, `ob_use_breaker`, `sweep_close_req`, `ob_max_age`, `smc_conf_type`, `smc_pd_filter`, `smc_retrace_depth` (0..1), `smc_mtf_check`, `smc_use_volume_filter`, `smc_vol_mult` (0.5..5), `smc_counter_trend_min_quality` (0..5) |
| `ptp` | `ptp_mode` (`R`/`PCT`), `partial_tp1_r`, `partial_tp2_r`, `partial_tp1_pct`, `partial_tp2_pct`, `ptp_profit_pct1`, `ptp_profit_pct2` |
| `risk.advanced` | `spread_max_pct` (включает проверку спреда), `allow_low_notional_boost`, `show_risk_preview`, `correlation_cap_enabled`, `correlation_cap_threshold` (0.4..0.95), `adaptive_sizing_enabled`, `adaptive_sizing_mode`, `tilt_detector_enabled`, `hold_lock_enabled`, `min_signal_quality` (3/4/5), `reset_all_filters: true` |
| `trading.*` (доп.) | `disabled_days` (список дней 0..6 или CSV), `fixed_amount`, `vol_filter_mode`, `max_coins_count`, `at_stats_period`, `optimizer_enabled`, `optimizer_strategies` (список или CSV из `LEVELS`/`SMC`, порядок сохраняется, пусто → `LEVELS` — как `optim_strat_<S>`) — как в боте доступны и на Free (гейт `trading.*` касается только исходных ключей Mini App; `options.locked` при этом остаётся `trading.*` — та же причуда, что у заблокированного в UI выбора ТФ). `max_trades_limit` принимает 0..9999 (0 = без лимита) — диапазон «✏️ Своё значение» бота; 1..50 Mini App входит в него |
| `notifications.*` (доп.) | `notify_signal`, `notify_breakout` |

Домен настроек и тарифа: `services/traderSettingsService.js` (строка
`trader_settings` = `UserSettings` бота, `_from_db`/`to_db`, кэш 30 с,
`db_get_active_users`, factory reset), `services/engine/{tradeCfg,smcUserCfg,
quietHours,userAccess,strategySet,volumeCfgShim}.js` (чистые модули:
`TradeCfg` с порядком clamp'ов и sparse merge, `SMCUserCfg`, тихие часы,
`check_access`/`grant_access`/`can`, `_apply_multi`, `VolumeConfig.from_params`
по спецификации с хуком на движок M2), `services/volumeUserCfg.js` (kv
`volume_cfg_<uid>`), `services/profilesService.js`, `services/planService.js`
(зеркало `subscriptions` → `trader_settings.sub_*`, `grantAccess`, бесплатная
активация, часовой цикл истечения с напоминаниями 3d/1d/expired как записями
`notifications`, `plan_changes`), `services/appSettingsService.js`,
`content/help.js`.

### Платформенные маршруты

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
├── routes/          # app (/api/app — API приложения, M7), auth, exchanges,
│                    # subscriptions, payments, admin, notifications, telegram,
│                    # push, support, public
├── content/         # help.js — справка бота (help_content.py) дословно
├── services/        # authService, paymentService, subscriptionService,
│                    # adminService, supportService, notifier, emailService,
│                    # telegramService, pushService, exchangeService, …
│                    # M7: traderSettingsService, planService, profilesService,
│                    # appSettingsService, volumeUserCfg, engineKvService
│   └── engine/      # чистые модули домена: tradeCfg, smcUserCfg, quietHours,
│                    # userAccess, strategySet, volumeCfgShim, pyjson, pycoerce
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
- Content-Security-Policy в production — целиком в `config/csp.js` (почему там каждый
  источник). Страницы не используют inline-обработчики (`onclick=` и т. п.: их блокирует
  `script-src-attr`) — кроме переключения шрифтов лендинга, разрешённого точным sha256;
  CDN-скрипты вне политики не подключаются (lucide — `frontend/assets/vendor/`).
  `tests/csp.test.js` фиксирует заголовок (в т. ч. от `server.js` в production), а
  `node tests/e2e/csp_pages_probe.mjs [--shots DIR]` открывает каждую страницу в Chromium
  (1440×900 и 390×844, аноним / пользователь / админ) и падает на любом нарушении CSP,
  ошибке консоли или сломанном обработчике; внешние хосты (Google Fonts, Метрика) отвечают
  заглушки, решение CSP принимает браузер.

## 📝 Лицензия

MIT
