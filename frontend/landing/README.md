# Лендинг CHM Breaker (`/`) и тарифы (`/pricing/`)

Статичные HTML, CSS и JS без сборки и без внешних скриптов. Шрифты Google (Inter, JetBrains Mono, Oswald)
грузятся неблокирующе; до их загрузки работают fallback-шрифты с подогнанными метриками, поэтому
строки заголовков не переносятся иначе и раскладка не прыгает.

| Файл | Что внутри |
|---|---|
| `../index.html` | лендинг: 12 секций из `docs/PRODUCT_CONCEPT.md` §5.3, SEO-мета, JSON-LD (Organization, SoftwareApplication), Яндекс Метрика, юридические ссылки |
| `../pricing/index.html` | страница тарифов: планы, калькулятор, перенос убытка по месяцам, сравнение, FAQ об оплате (JSON-LD Product и FAQPage); стили, нужные только ей, лежат в её `<style>` |
| `landing.css` | токены красного Liquid Glass из `frontend/app/app.css`, `--loss` для убытка, мобильная раскладка (320–390 px, поля 16 px), `prefers-reduced-motion` |
| `landing.js` | общий скрипт обеих страниц: адаптер данных, SVG-графики (слева R, справа % при выбранном риске), все интерактивные секции |
| `data/mock-api.js` | **заглушка, все числа выдуманы**; ответы той же формы, что будущие `GET /api/public/*` |
| `../og-cover.png`, `../logo.png`, `../apple-touch-icon.png` | картинка для соцсетей (1200×630, без чисел), логотип для JSON-LD, иконка iOS |

Деплой:
- `backend/server.js` отдаёт `.css`/`.js` с `Cache-Control: immutable` на 30 дней, поэтому файлы подключены как
  `landing.css?v=2`, `landing.js?v=2`, `data/mock-api.js?v=2` (и `/support-widget.js?v=2` из `landing.js`). При любом
  изменении поднять `v` во всех местах (`../index.html`, `../pricing/index.html`, строки `mock-api.js` и
  `support-widget.js` в `landing.js`).
- Тарифы лежат в папке: `/pricing` → `express.static` отвечает 301 на `/pricing/` и отдаёт `pricing/index.html`
  без отдельного маршрута в бэкенде (так же работает любой статический сервер). Canonical, ссылки и sitemap — `/pricing/`.
- Папка `data/` попадает под корневое правило `.gitignore` (`data/`), поэтому `data/mock-api.js` добавлен в git через
  `git add -f`. Уже отслеживаемый файл правило не трогает; новый файл в `data/` нужно добавлять так же.
- Бюджет веса `/`: HTML + CSS + JS (с `yandex-metrika.js`, без шрифтов и `mc.yandex.ru/tag.js`) меньше 250 000 байт;
  сейчас около 249 000, из них мок около 26 000. После перехода на `'api'` и удаления `data/` запас ~27 КБ.

## Источник данных: один переключатель

В начале `landing.js`:

```js
const DATA_SOURCE = 'mock'; // 'api' — когда /api/public/* отвечает настоящими данными
```

- `'mock'` — `landing.js` сам подгружает `data/mock-api.js` и берёт ответы из него.
- `'api'` — запросы `fetch('/api/public/<path>')`; мок не грузится. Ошибка запроса = честная заглушка «данные временно недоступны», мок не подставляется.

Вместе с переходом на `'api'` нужно:
1. в `../index.html` заменить `<meta name="robots" content="noindex,follow">` на `index,follow` (пока числа тестовые, страница закрыта от индекса);
2. удалить папку `data/` (пометка «Прототип · тестовые данные» в шапке и подвале скрывается сама в режиме `'api'`).

Параметры адреса для проверки:
- `?data=empty` — все ответы «данных пока нет»: страница показывает честные заглушки («Статистика появится после 30 закрытых сигналов»), раскладка та же;
- `?data=api` — настоящие пути при `DATA_SOURCE = 'mock'`;
- `?coin=BTC#showcase`, `?strategy=SMC#showcase` — фильтр витрины (ссылки SEO-колонок футера).

## Эндпоинты, которые заменят мок

Все только на чтение, без авторизации, с кэшем 30–60 с. Время — Unix ms, R — в единицах риска сделки,
комиссии уже вычтены по модели бэктестера (0,12% за круг + 0,1% проскальзывания). Пустой ответ любого
эндпоинта: `{ "empty": true, "reason": "текст для посетителя" }`.

| Эндпоинт | Секция | Форма ответа (главное) |
|---|---|---|
| `GET /api/public/trend` | лента тренда в шапке, фильтр «работает в текущем режиме» | `{ symbol, updated_at, tfs: { "15m"…"1M": { trend: LONG\|SHORT\|RANGE, strength, since } }, change_24h: { BTC, ETH } }`; `?tick=1` игнорируется |
| `GET /api/public/stats` | счётчики трекера, доли исходов | `{ source: "paper", tracked_signals, closed_signals, open_signals: { value, updated_at }, showcase_days: { value, since, updated_at }, bots_30d: { median_r, positive, total, worst_r, best_r, n, median_dd_r, updated_at }, outcomes_recent: { tp2plus, tp1be, sl, exp, window, updated_at }, registry: { launched_since, candidates, published, waiting, archived } }` |
| `GET /api/public/feed` | лента сигналов (задержка 60 мин, уровни скрыты) | первый запрос: `{ delay_min: 60, levels_hidden: true, cursor, items: [{ id, t, pair, bot_id, strategy, strategy_name, tf, side, status, path: ["open","tp1","be"], r }] }`; опрос `?after=<cursor>`: `{ cursor, events: [{ type: "new", item } \| { type: "update", id, status, path, r }] }`. Статусы: `open, tp1, tp1be, tp2be, tp3, sl, exp` |
| `GET /api/public/showcase` | витрина, архив и реестр, бот для сверки в челлендже | `{ updated_at, rules, bots: [{ id, version, status: published, strategy, coins, coins_extra, dir, tf, leverage_max, published_at, track_days, stats: { n, wins, r_total, pf, max_dd_r, p95_dd_r, p95_month_r, max_loss_streak, avg_hold_h, r_30d, n_30d, dd_30d }, curve: [[t, r]], backtest_holdout: { r_total, pf, n, max_dd_r, period_days }, exchange_copies: { median_r, median_dd_r, n, liquidations }, copies, regime_r: { up, down, range }, how, params, weak, min_deposit_usd, updated_at }], archive: [...], registry: { launched_since, candidates, published, waiting, archived, items: [{ strategy, coins, tf, v, launched_at, status: published\|waiting\|archived, n, days, r_total, max_dd_r, to?, reason? }] } }`. На витрину (`bots`) попадают только боты после 30 сигналов и 30 дней; остальные кандидаты — только в `registry.items` |
| `GET /api/public/sandbox` | песочница hero, список монет площадки | ночной предрасчёт: `{ updated_at, period: { from, to, days }, selection_end, coins: [{ sym, vol24h_musd }], cells: { "LEVELS:BTC:both": { n, wins, r_total, gross_r, fee_r_total, pf, max_dd_r, p95_dd_r, p95_month_r, max_loss_streak, curve, hold_pct } } }` |
| `GET /api/public/sandbox?strategy&coin&dir&period[&pessimistic&fees]` | площадка бэктеста | `period=hold\|year`: `{ available, zones: [{ id: early\|sel\|hold, from, to, trades: [{ t, side, kind, r }], stats }], selection_end, mc: { p5, p95 }, quarters, hold_pct }`; `period=2025-10\|2021-05\|2022-11`: стресс-окно `{ available, window: { label, from, to, event, expires_at }, price: [[t, close]], zones: [{ id: "stress", trades: [{ t, side, kind, gap, r }] }], mc, normal_sl_r, hold_pct }` или `{ available: false, reason: no_archive\|no_history\|expired, available_for }` |
| `GET /api/public/genome` | Genome: фитнес по поколениям, последние эволюции | `{ updated_at, auto_apply_bots, live_pf_factor: 0.6, strategies: [{ id, tf, last_run, generations, population, genes, best_fitness, prev_fitness, holdout_check: passed\|failed\|pending, history: [[fitness × population] × generations], best: { fitness, wr, pf, n, selection_days }, holdout: { wr, pf, n, sum_r, max_dd_r, days } }] }` |

## Правила честности, которые держит разметка

`docs/PORT_DECISIONS.md` и замечания критика К3/К4 в `docs/PRODUCT_CONCEPT.md`:

- источник у каждой цифры: «трек сигналов (бумажный)», «бэктест · отложенный период», «биржа»; слова LIVE, «вне выборки» и walk-forward не используются;
- данные отбора Genome затенены и подписаны «завышено», рядом PF × 0,6; сравнение «было → станет» — только на отложенном периоде;
- песочница: монеты по объёму за 24 ч, пунктир медианы по 20 монетам, доля монет в минусе, тег «выше медианы — не выбирайте монету по лучшему результату»;
- уровень риска 1–5 считается от p95 просадки за месяц (Монте-Карло) при выбранном риске посетителя; просадка в % всегда рядом с доходностью;
- лента: задержка 60 минут, стопы наравне с тейками, пауза обновлений; без суммы R по платформе — медиана, доля в плюсе, худший рядом с лучшим;
- витрина: после 30 сигналов **и** 30 дней (до порога бот виден только в реестре), параметры заморожены, архив снятых и реестр всех кандидатов с датой запуска; рядом с сортировкой «Топ» — медиана витрины;
- доходность везде рядом с просадкой и числом сделок (карточка, бэктест отложенного периода, копии на бирже, счётчики, Genome, стресс-окно); R в % — с оговоркой «при риске N% на сделку, без реинвеста»; R трека — «после комиссий, оценка»;
- стресс-окна: «май 2021» и «ноябрь 2022» — «нет истории» для всех монет, пока нет отдельного архива свечей; 10–11.10.2025 — с пометкой «окно выпадет из хранилища 11.10.2026»;
- «стоп или усреднение»: сетка без мартингейла, четыре сценария, включая пилу и гэп, где выигрывает сетка; «стоп не гарантирует цену исполнения»;
- планировщик без цели по умолчанию и без примера «+N% в месяц», сверка по умолчанию с медианой витрины, а не с лучшим ботом;
- калькулятор оплаты с прибылью 0 и минусовым месяцем; перенос по месяцам тоже с нуля, условный пример — только по кнопке;
- примеры экранов приложения подписаны «пример, числа условные»; «демо обычно выглядит лучше реальной торговли».
