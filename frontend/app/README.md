# `/app/` — веб-приложение CHM Breaker (M11)

Порт Telegram Mini App бота (`CHM_BREAKER_V4/miniapp/static/{index.html, app.js,
app.css, splash.js}`) в самостоятельное веб-приложение сайта. Экраны и тексты —
те же (Главная, Сигналы, деталь сигнала, Анализ, Профиль, 11 разделов настроек,
геном, уведомления, тихие часы, профили, тариф, помощь, обратная связь, язык,
челлендж), Telegram-обвязка убрана.

| Было (Mini App) | Стало (`/app/`) |
|---|---|
| `telegram-web-app.js`, `X-Telegram-Init-Data` | JWT сайта: `Authorization: Bearer <chm_access>` (те же ключи `chm_access` / `chm_refresh` / `chm_user` в localStorage, либо sessionStorage при `chm_session_only=1` — «Запомнить меня»), один `POST /api/auth/refresh` на 401, затем экран входа; HTTP 403 `ACCOUNT_DISABLED` (конверт `{ok:false, error:"unauthorized", code}`) — экран входа с причиной |
| Фатальный экран «Нет доступа» | Экран входа внутри приложения: email + пароль (`POST /api/auth/login`, шаг 2FA через `POST /api/auth/2fa/verify-login`), «Зарегистрироваться» (`POST /api/auth/register`), «Войти через Telegram» (popup `oauth.telegram.org` → `POST /api/auth/oauth/telegram`; имя бота из `GET /api/auth/oauth/providers`), кнопка «Выйти» в профиле |
| `tg.BackButton`, `goBack()` | История браузера: деталь сигнала и под-экраны настроек — `pushState`, `popstate` закрывает их, кнопки «Назад» / «Настройки» / «Профиль» всегда на экране |
| `HapticFeedback` | `navigator.vibrate` (splash.js, тумблер «Звук и вибрация» как раньше) |
| `./api/` бота | `/api/app/*` — маршруты Mini App один-к-одному (`miniapp/API.md`), конверт `{ok, error, message}` сохранён |
| «Оформить Pro» → `t.me/<bot>?start=subscribe`, TON-блок тарифа | `checkout_url` из `GET plan` (M7 отдаёт `/subscriptions.html`), иначе константа `CHECKOUT_URL` (TODO: `/pricing`, когда появится страница оплаты сайта); TON не переносится (D12) |
| «Открыть бота» / «В боте» / «Открыть в боте» | убраны (бессмысленны вне Telegram); на экране профиля — ссылка «Аккаунт и безопасность» → `/settings.html` |
| PNG-график с сервера | `chart.js`: свечи + оверлеи из `GET signals/:id/chart` рисуются на canvas (решение D3); base64 PNG по-прежнему принимается |
| «Поделиться результатом» → картинка в чат бота | карточка рисуется на canvas → Web Share API, иначе скачивание; `POST share` держит лимит 3/10 мин и отдаёт статистику |
| Обновление по кнопке / по `visibilitychange` | так же (D2), плюс живые события: после входа `Live` читает `GET /api/app/events` (SSE) через `fetch` с `Authorization: Bearer` (EventSource заголовок не шлёт); события `signal` / `progress` / `trade` сбрасывают 30-секундные кэши и обновляют открытый экран (Главная / Сигналы). Переподключение через `retry:` сервера (10 с), на 401 — один refresh токена; при выходе поток закрывается. Если прокси буферизует поток, остаётся поллинг |
| Кнопки сделки под карточкой сигнала в чате («✅ Открыть сделку», 🎯 50% / 💰 100% / 🛡 SL→BE / 📊 Прогресс, диалог Hold-Lock) | карточка «Сделка» в детали сигнала: `GET trades/:id/card` отдаёт кнопки, которые доставленная карточка ещё несёт (D16), с маршрутом (`exec`, `qc/half` / `full` / `force` / `be` / `wait`, `progress`); нажатие — запрос в очередь trade-ops (таймаут 30 с > ожидания маршрута 25 с), ответ бота показывается текстом, кнопки «Всё равно закрыть» / «Подождать» приходят в ответе |
| Шрифты Google: `media="print" onload="…"` | `onload` в разметке запрещён CSP сайта (`script-src-attr 'none'` helmet): `media` на `all` переключает `splash.js` |

Новое: раздел настроек **«Расширенные настройки»** (D9) — экран, который
рендерит всё, что `GET settings/all` отдаёт сверх основных экранов (параметры из
Telegram-меню бота), по типу значения. Вложенные секции M7 (`levels.shared`,
`levels.long` / `levels.short` с `overrides[]` и кнопкой «Сбросить» →
`{levels:{long:{reset:true}}}`, `smc.advanced`, `risk.advanced` с «♻️ Сбросить все
фильтры», `ptp`, `trading.disabled_days` как Пн…Вс) становятся отдельными
карточками; тело `POST settings/all` вкладывается так же (`{levels:{shared:{pivot_strength:10}}}`).
Наборы значений берутся из `options.choices["<секция>.<ключ>"]` сервера, подписи —
из меню бота (ui-inventory §7.4–7.6) по полному пути или `<раздел>.<ключ>`,
остальное — по имени ключа; `options.locked` (в т.ч. причуда `trading.*` для
D9-ключей на Free) и `options.schema / labels` учитываются.

## Режимы

* `?demo=1 | pro | empty` — встроенный мок без бэкенда (дизайн-превью), как в боте;
  `?genome=off`, `?api=off`, `?splash=off|hold` — тоже.
* Глубокие ссылки: `?tab=home|signals|analyze|profile|settings`, `?sec=<раздел>`.

## Раздача

`server.js` отдаёт `~/public_html` (= `frontend/`) через `express.static`, поэтому
`/app/` → `frontend/app/index.html`, `/app` → 302 на `/app/`. Статика кэшируется
на 30 дней — `?v=` у `app.css / app.js / splash.js / chart.js` в `index.html`
поднимать при каждом релизе.

Вход через Telegram открывает официальный popup `oauth.telegram.org/auth?bot_id=<username>`
(тот же приём, что у `frontend/index.html`): домен сайта должен быть задан боту через
BotFather `/setdomain`; проверить на проде, что popup принимает username в `bot_id`
(иначе `GET /api/auth/oauth/providers` должен отдавать числовой id бота).

## Проверки

```
cd backend
npx eslint ../frontend/app --quiet          # 0 ошибок (блок frontend/app в eslint.config.js)
npx vitest run tests/e2e                    # контракт /api/app на стабе (backend/utils/app-stub.js)
python tests/e2e/app.e2e.py                 # Playwright: сценарии входа/вкладок/разделов/деталей/
                                            # стратегий/settings/all/refresh/logout/demo на 390×844 и 1280×900
python tests/e2e/app_smoke.py               # короткий Playwright-прогон экранов на стабе
node tests/e2e/serve-stub.js 3199           # ручной QA: http://127.0.0.1:3199/app/
node tests/e2e/app_real_smoke.mjs           # Playwright на НАСТОЯЩЕМ бэкенде (serve-app.js): вход, Главная,
                                            # SSE-поток, Сигналы + новый сигнал через SSE, деталь с графиком,
                                            # Анализ, Профиль; 0 ошибок консоли / запросов
node tests/e2e/serve-app.js --port 3198 --dir /tmp/chm   # ручной QA на настоящем сервере:
                                            # smoke@chm.local / smoke-pass-123
```

`serve-app.js` поднимает `server.js` в режиме production (CSP helmet, лимитер API) на свежей
SQLite в `--dir`, без воркера движка и без сети: рынок для маршрутов (свечи REST, тикеры 24 ч) —
golden-свечи, стоящие на закрытии 2025-12-30 12:00 UTC, сдвинутые на целые сутки к текущему времени.
`app_real_smoke.mjs` берёт `playwright-core` из `$PLAYWRIGHT_CORE` (по умолчанию
`/opt/node-tools/node_modules/playwright-core`) и Chromium из `$CHROMIUM` (`/opt/pw-browsers/chromium`),
браузер не скачивает; запросы к чужим хостам (Google Fonts) получают пустой ответ локально.
