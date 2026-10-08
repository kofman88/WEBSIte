# `/app/` — веб-приложение CHM Breaker (M11)

Порт Telegram Mini App бота (`CHM_BREAKER_V4/miniapp/static/{index.html, app.js,
app.css, splash.js}`) в самостоятельное веб-приложение сайта. Экраны и тексты —
те же (Главная, Сигналы, деталь сигнала, Анализ, Профиль, 11 разделов настроек,
геном, уведомления, тихие часы, профили, тариф, помощь, обратная связь, язык,
челлендж), Telegram-обвязка убрана.

| Было (Mini App) | Стало (`/app/`) |
|---|---|
| `telegram-web-app.js`, `X-Telegram-Init-Data` | JWT сайта: `Authorization: Bearer <chm_access>` (те же ключи `chm_access` / `chm_refresh` / `chm_user` в localStorage, либо sessionStorage при `chm_session_only=1` — «Запомнить меня»), один `POST /api/auth/refresh` на 401, затем экран входа |
| Фатальный экран «Нет доступа» | Экран входа внутри приложения: email + пароль (`POST /api/auth/login`, шаг 2FA через `POST /api/auth/2fa/verify-login`), «Зарегистрироваться» (`POST /api/auth/register`), «Войти через Telegram» (popup `oauth.telegram.org` → `POST /api/auth/oauth/telegram`; имя бота из `GET /api/auth/oauth/providers`), кнопка «Выйти» в профиле |
| `tg.BackButton`, `goBack()` | История браузера: деталь сигнала и под-экраны настроек — `pushState`, `popstate` закрывает их, кнопки «Назад» / «Настройки» / «Профиль» всегда на экране |
| `HapticFeedback` | `navigator.vibrate` (splash.js, тумблер «Звук и вибрация» как раньше) |
| `./api/` бота | `/api/app/*` — маршруты Mini App один-к-одному (`miniapp/API.md`), конверт `{ok, error, message}` сохранён |
| «Оформить Pro» → `t.me/<bot>?start=subscribe`, TON-блок тарифа | `/subscriptions.html` (TODO: `/pricing`, когда появится страница оплаты сайта); TON не переносится (D12) |
| «Открыть бота» / «В боте» / «Открыть в боте» | убраны (бессмысленны вне Telegram); на экране профиля — ссылка «Аккаунт и безопасность» → `/settings.html` |
| PNG-график с сервера | `chart.js`: свечи + оверлеи из `GET signals/:id/chart` рисуются на canvas (решение D3); base64 PNG по-прежнему принимается |
| «Поделиться результатом» → картинка в чат бота | карточка рисуется на canvas → Web Share API, иначе скачивание; `POST share` держит лимит 3/10 мин и отдаёт статистику |

Новое: раздел настроек **«Расширенные настройки»** (D9) — экран-заглушка, который
рендерит всё, что `GET settings/all` отдаёт сверх основных экранов (параметры из
Telegram-меню бота), по типу значения; для известных ключей бота — подписи и
наборы значений из его меню (ui-inventory §7.4–7.6), `options.schema / choices /
labels` сервера уточняют контрол.

## Режимы

* `?demo=1 | pro | empty` — встроенный мок без бэкенда (дизайн-превью), как в боте;
  `?genome=off`, `?api=off`, `?splash=off|hold` — тоже.
* Глубокие ссылки: `?tab=home|signals|analyze|profile|settings`, `?sec=<раздел>`.

## Раздача

`server.js` отдаёт `~/public_html` (= `frontend/`) через `express.static`, поэтому
`/app/` → `frontend/app/index.html`, `/app` → 302 на `/app/`. Статика кэшируется
на 30 дней — `?v=` у `app.css / app.js / splash.js / chart.js` в `index.html`
поднимать при каждом релизе.

## Проверки

```
cd backend
npx eslint ../frontend/app --quiet          # 0 ошибок (блок frontend/app в eslint.config.js)
npx vitest run tests/e2e                    # контракт /api/app на стабе (backend/utils/app-stub.js)
python tests/e2e/app_smoke.py               # Playwright-прогон экранов на стабе (Chromium нужен)
node tests/e2e/serve-stub.js 3999           # ручной QA: http://127.0.0.1:3999/app/
```
