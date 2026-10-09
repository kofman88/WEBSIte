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
| `data/mock-api.js` | **заглушка, все числа выдуманы**; ответы той же формы, что `GET /api/public/*`; нужна, пока витрина, песочница и Genome без эндпоинтов, и для `?data=mock` |
| `../og-cover.png`, `../logo.png`, `../apple-touch-icon.png` | картинка для соцсетей (1200×630, без чисел), логотип для JSON-LD, иконка iOS |

Деплой:
- `backend/server.js` отдаёт `.css`/`.js` с `Cache-Control: immutable` на 30 дней, поэтому файлы подключены как
  `landing.css?v=4`, `landing.js?v=4`, `data/mock-api.js?v=4` (и `/support-widget.js?v=4` из `landing.js`). При любом
  изменении поднять `v` во всех местах (`../index.html`, `../pricing/index.html`, строки `mock-api.js` и
  `support-widget.js` в `landing.js`); `backend/tests/public/landing.test.js` проверяет, что версия везде одна.
- Тарифы лежат в папке: `/pricing` → `express.static` отвечает 301 на `/pricing/` и отдаёт `pricing/index.html`
  без отдельного маршрута в бэкенде (так же работает любой статический сервер). Canonical, ссылки и sitemap — `/pricing/`.
- Папка `data/` попадает под корневое правило `.gitignore` (`data/`), поэтому `data/mock-api.js` добавлен в git через
  `git add -f`. Уже отслеживаемый файл правило не трогает; новый файл в `data/` нужно добавлять так же.
- Бюджет веса `/`: HTML + CSS + JS (с `yandex-metrika.js`, без шрифтов и `mc.yandex.ru/tag.js`) меньше 250 000 байт;
  сейчас 249 883, из них мок около 26 000: запас около 120 байт, любую правку проверять на бюджет (его держит
  `backend/tests/public/landing.test.js`). Когда все блоки перейдут на `'api'` и `data/` удалится, запас ~26 КБ.

## Источник данных: по эндпоинту

В начале `landing.js` источник задан для каждого эндпоинта отдельно:

```js
const DATA_SOURCE = { trend: 'api', stats: 'api', feed: 'api', showcase: 'mock', sandbox: 'mock', genome: 'mock' };
```

| Эндпоинт | Источник | Почему |
|---|---|---|
| `trend`, `stats`, `feed` | `'api'` | отвечает бэкенд сайта: монитор тренда и бумажный трек сигналов (`backend/routes/publicLanding.js`, `backend/services/publicTrack/`) |
| `showcase`, `sandbox`, `genome` | `'mock'` | эндпоинтов ещё нет: витрина, песочница и Genome — продуктовый слой V1–V4 (`docs/ROADMAP.md`) |

- `'mock'` — `landing.js` сам подгружает `data/mock-api.js` и берёт ответ из него (только для этих эндпоинтов).
- `'api'` — `fetch('/api/public/<path>')`. Ошибка запроса = честная заглушка «Данные временно недоступны», мок не подставляется.

Пока хоть один блок на моке:
- в `../index.html` остаётся `<meta name="robots" content="noindex,follow">`;
- пометка «Прототип · тестовые данные» в шапке и подвале видна (её подсказка называет блоки на тестовых данных:
  витрина, бэктест, Genome); `landing.js` прячет её сам, только когда источник каждого эндпоинта — `'api'`.

Когда все шесть перейдут на `'api'`: заменить `noindex,follow` на `index,follow`, удалить папку `data/`
(и строку загрузки мока в `api()`), поднять `v`. Правила держит `backend/tests/public/landing.test.js`.

Параметры адреса для проверки (переопределяют источник всех эндпоинтов):
- `?data=empty` — все ответы «данных пока нет»: страница показывает честные заглушки («Статистика появится после 30 закрытых сигналов»), раскладка та же;
- `?data=api` — настоящие пути для всех блоков (у витрины, песочницы и Genome пока 404 → «Данные временно недоступны»);
- `?data=mock` — мок для всех блоков (просмотр дизайна);
- `?coin=BTC#showcase`, `?strategy=SMC#showcase` — фильтр витрины (ссылки SEO-колонок футера).

## Эндпоинты, которые уже отвечают

`backend/routes/publicLanding.js` (смонтирован на `/api/public` рядом с `routes/public.js`). Без авторизации,
только чтение, ничего персонального: ни id пользователей, ни email, ни id сделок, ни уровней, ни биржи.
Каждый ответ считается не чаще раза в минуту (кэш в памяти), отдаётся со слабым `ETag` (`If-None-Match` → 304)
и `Cache-Control: public, max-age=30`. Лимит — `PUBLIC_API_RATE_PER_MIN` (60) запросов с IP за 60 с на три пути →
429 + `Retry-After`. Сбой → 503, кривой курсор → 400 `{ "error": "bad_cursor" }` (ответы-ошибки — `no-store`,
без `ETag`). Время — Unix ms. Задержку не сдвигает ни один параметр и ни один курсор (`backend/tests/public/adversarial.test.js`,
`delay.test.js`).

**Трек.** Источник ленты и счётчиков — бумажный трек системных («витринных») аккаунтов из `PUBLIC_TRACK_USER_IDS`
(`12,15` или `12:majors,15:alts`; псевдоним — публичный `bot_id` = `<псевдоним>-<стратегия>`, по умолчанию `sys1`…).
Берутся их доставленные сигналы без ордера на бирже: трекер ведёт их по ценам уровней. Статус и R — из
`services/engine/signalOutcome.js` (signal_status / signal_rr бота) на «виде трекера»: ручной итог, SKIP от ghost
cleanup и сделки на бирже трек не меняют. Чужие аккаунты не читаются вовсе. Пустой `PUBLIC_TRACK_USER_IDS` → честные
пустые ответы. Трек хранится в своём архиве (`public_track`): бот удаляет бумажные сигналы из `signal_trades` через
30 дней, а трек живёт дольше и помнит, когда какой этап стал известен.

**Задержка.** Лента и счётчики показывают трек на момент `now − 60 мин` (`updated_at`): сигнал появляется через
60 минут после выдачи, смена статуса — через 60 минут после того, как трекер её записал (не позже чем через час
после бара, к которому трекер её отнёс). Уровни скрыты всегда.

**R** — в R сделки после оценки комиссий по модели бэктестера: `fee_r = clamp((0,12 + 0,10) / риск %, 0, 0,5)`,
риск % = `|вход − исходный стоп| / вход × 100`; в ответах `fees: { round_trip_pct, slippage_pct, max_r, note: "после комиссий, оценка" }`.

| Статус | Путь `path` | `r` | Что значит |
|---|---|---|---|
| `open` | `open` | `null` | сигнал в работе (для SMC-зоны — и до касания зоны) |
| `tp1` | `open, tp1` или `open, tp1, tp2` | `null` | в сделке после TP1, стоп в БУ; `tp2` в пути — TP2 уже взят |
| `tp3` | `open, tp1, tp2, tp3` | R до TP3 − fee | отработал полностью |
| `sl` | `open, sl` | −1 − fee | стоп |
| `tp1be` / `tp2be` | `open, tp1, be` / `open, tp1, tp2, be` | 0 − fee | БУ после TP1 / после TP2 (TP2 виден, если трек успел его записать) |
| `exp` | `open, [tp1, [tp2,]] exp` | R по рынку − fee или `null` | 72 ч без исхода: закрыт по цене (без цены трекера — `null`) |
| `missed` | `open, missed` | `null` | зона входа SMC так и не была достигнута, цена ушла: сделки не было |

| Эндпоинт | Ответ |
|---|---|
| `GET /api/public/feed` | `{ delay_min: 60, levels_hidden: true, cursor, items: [{ id, t, pair, bot_id, strategy, strategy_name, tf, side, status, path, r }], source: "paper", updated_at, fees }` — 20 последних видимых сигналов, новые сверху; `id` — непрозрачный |
| `GET /api/public/feed?after=<cursor>` | `{ cursor, events: [{ type: "new", item } \| { type: "update", id, status, path, r }], updated_at }`: каждое изменение после курсора ровно один раз — `new`, если сигнал стал виден после курсора (сразу с последним состоянием), иначе `update`; обновления по порядку изменений, новые — от старых к новым (лента вставляет каждый сверху); не больше 60 новых и 500 изменений за ответ. Курсор `<архив>.<счётчик>.<время>` переживает перезапуск; курсор чужого архива → пересинхронизация от его времени (`update` для известных, `new` для более поздних) |
| `GET /api/public/stats` | `{ source: "paper", tracked_signals, closed_signals, open_signals, showcase_days, bots_30d, outcomes_recent, registry, missed_signals, delay_min, updated_at, rules, fees }`. Пока закрытых сигналов меньше 30 — пустой ответ. Закрытые = `tp1be, tp2be, tp3, sl, exp`; открытые = `open, tp1`; `missed` — отдельно. `showcase_days` — дни с первого сигнала трека. `bots_30d` — по ботам трека (аккаунт × стратегия) за 30 дней: медиана, сколько в плюсе, худший и лучший, число сделок, медиана просадки — суммы по платформе нет. `outcomes_recent` — последние 24 закрытых каждого бота. `registry` — `candidates` = боты трека, `published: 0` и `archived: 0`, пока витрины нет (V4), `qualified` — сколько набрали 30 закрытых сигналов и 30 дней |
| `GET /api/public/trend` | `{ symbol: "BTC", updated_at, tfs: { "15m"…"1M": { trend, strength, since } }, change_24h: { BTC, ETH }, source: "trend_monitor" }`. Тренд и `since` — состояние монитора тренда движка (`engine_kv trend_state_v1`), сила — `ribbon_strength` монитора по закрытым барам BTC, 24 ч — как `_market()` бота (`round(change_pct, 2)`). ТФ без состояния не отдаётся; нет 15m/1H/4H — пустой ответ; не прочиталось — `null` (лента пишет «—»). `?tick=1` игнорируется |

## Эндпоинты, которые ещё на моке

Все только на чтение, без авторизации, с кэшем 30–60 с. Время — Unix ms, R — в единицах риска сделки,
комиссии уже вычтены по модели бэктестера (0,12% за круг + 0,1% проскальзывания). Пустой ответ любого
эндпоинта: `{ "empty": true, "reason": "текст для посетителя" }`.

| Эндпоинт | Секция | Форма ответа (главное) |
|---|---|---|
| `GET /api/public/showcase` | витрина, архив и реестр, бот для сверки в челлендже | `{ updated_at, rules, bots: [{ id, version, status: published, strategy, coins, coins_extra, dir, tf, leverage_max, launched_at, published_at, track_days, stats: { n, wins, r_total, pf, max_dd_r, p95_dd_r, p95_month_r, max_loss_streak, avg_hold_h, r_30d, n_30d, dd_30d }, curve: [[t, r]], backtest_holdout: { r_total, pf, n, max_dd_r, period_days }, exchange_copies: { median_r, median_dd_r, n, liquidations }, copies, regime_r: { up, down, range }, how, params, weak, min_deposit_usd, updated_at }], archive: [{ ..., launched_at, published_at\|null, to, reason }], registry: { launched_since, candidates, published, waiting, archived, items: [{ strategy, coins, tf, v, launched_at, status: published\|waiting\|archived, n, days, r_total, max_dd_r, to?, reason? }] } }`. Трек и `track_days` считаются с запуска (`launched_at`), а не с публикации: на витрину (`bots`) бот попадает после 30 сигналов и 30 дней (`published_at`), остальные кандидаты — только в `registry.items`. `stats.showcase_days.since` — первая публикация, включая ботов из архива |
| `GET /api/public/sandbox` | песочница hero, список монет площадки | ночной предрасчёт: `{ updated_at, period: { from, to, days }, selection_end, coins: [{ sym, vol24h_musd }], cells: { "LEVELS:BTC:both": { n, wins, r_total, gross_r, fee_r_total, pf, max_dd_r, p95_dd_r, p95_month_r, max_loss_streak, curve, hold_pct } } }` |
| `GET /api/public/sandbox?strategy&coin&dir&period[&pessimistic&fees]` | площадка бэктеста | `period=hold\|year`: `{ available, zones: [{ id: early\|sel\|hold, from, to, trades: [{ t, side, kind, r }], stats }], selection_end, mc: { p5, p95 }, quarters, hold_pct }`; `period=2025-10\|2021-05\|2022-11`: стресс-окно `{ available, window: { label, from, to, event, expires_at }, price: [[t, close]], zones: [{ id: "stress", trades: [{ t, side, kind, gap, g, r }], stats }] (g — R до комиссий: «исполнен хуже уровня» считается по нему, а не по R после комиссий), mc, normal_sl_r, hold_pct }` или `{ available: false, reason: no_archive\|no_history\|expired, available_for }` |
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
