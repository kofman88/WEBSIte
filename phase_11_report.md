# Phase 11 — Отчёт (Frontend Integration)

**Статус:** ✅ Завершена. **Phase 12 (Payments — Stripe + Crypto) ждёт "go"**.

---

## 1. Что сделано

### Backend — добьём legacy (prereq Phase 11)

**`services/botService.js`** — полный rewrite под v3 схему:
- `createBot(userId, bot)` — с plan gating (maxBots / strategy / autoTrade) + leverage cap
- `updateBot(id, userId, patch)` — selective field update с зарегавшимся gating
- `toggleActive(id, userId)` — pause/resume
- `deleteBot(id, userId)` — защита: нельзя удалить бота с открытыми live-сделками
- `getBot` / `listForUser` / `getBotTrades` / `getBotStats` / `userSummary`
- Вместо legacy `(exchange_name, symbol, strategy_type, position_size_usd, stop_loss_pct)` — новые (`exchange, symbols JSON, strategy, strategy_config JSON, risk_config JSON, auto_trade, trading_mode`)
- Audit log на create/update/toggle/delete

**`routes/bots.js`** — 9 endpoints:
- `GET /api/bots` / `GET /api/bots/summary`
- `POST /api/bots` / `GET /api/bots/:id` / `PATCH /api/bots/:id`
- `POST /api/bots/:id/toggle` / `DELETE /api/bots/:id`
- `GET /api/bots/:id/trades` (с фильтрами) / `GET /api/bots/:id/stats`
- Все с zod + scope check + gating errors (403 UPGRADE_REQUIRED, BOT_LIMIT_REACHED, BOT_HAS_OPEN_TRADES)

### Frontend — полный переписан `app.js` (300 строк)

Глобальные объекты через IIFE:

**`Auth`**
- `accessToken` / `refreshToken` / `user` getters из `localStorage` (keys `chm_access`, `chm_refresh`, `chm_user`)
- `isLoggedIn()` — парсит JWT, проверяет exp
- `requireAuth()` — редирект на `/?login=1` если нет
- `setTokens()` / `setUser()` / `clear()` / `logout()`

**`API`** — все эндпоинты обёрнуты:
- Auth: `register`, `login`, `logout`, `me`
- Exchanges: `listExchanges`, `listSymbols`, `ticker`, `candles`, `listKeys`, `addKey`, `verifyKey`, `deleteKey`, `getBalance`
- Bots: `listBots`, `botSummary`, `createBot`, `getBot`, `updateBot`, `toggleBot`, `deleteBot`, `botTrades`, `botStats`
- Signals: `listSignals`, `publicSignals`, `getSignal`, `mySignalStats`, `globalSignalStats`, `getPrefs`, `updatePrefs`
- Backtests: `listBacktests`, `createBacktest`, `getBacktest`, `getBacktestTrades`, `deleteBacktest`, `backtestStats`
- Subscriptions: `listPlans`, `mySubscription`, `redeemPromo`
- Optimizations: `listOptimizations`, `createOptimization`, `getOptimization`

**Key feature: auto-refresh на 401** — если access истёк, автоматически POST'ит refresh, сохраняет новую пару, повторяет запрос. При неудаче → `Auth.clear()` + throw 401.

**`Toast`** — `success/error/info/warn`, стилизованы под новый дизайн (glass + color-coded left border).

**`WS`** — WebSocket client:
- Auto-connect при `Auth.isLoggedIn()`
- Auth через `{type:'auth', token}` после open
- Auto-reconnect с экспоненциальным backoff (1s → 2s → 4s ... cap 30s)
- Listeners через `WS.on(type, fn)` + unsubscribe returns
- `*` wildcard listener

**`Fmt`** — `currency / percent / number / timeAgo / date / price` helpers.

**`I18n`** — stub для лендинга (index.html uses detailed TR dict).

### Страницы — все 6 подключены к реальному API

**`dashboard.html`:**
- 4 stat cards (Total PnL, Active Bots, Signals Today, Win Rate) через `API.botSummary()` + `API.mySignalStats()`
- Equity chart — аккумулирует PnL по всем trades за 30 дней
- Recent Signals — `API.listSignals({limit:5})` + WS on `signal`
- Recent Trades table — merge trades от всех ботов
- `setInterval(loadSummary, 30s)` для live обновлений

**`bots.html`:**
- `loadBots()` — grid с карточками из `API.listBots()`, stats через `API.botStats(id)`
- Toggle переключатели → `API.toggleBot()`
- Delete buttons → `API.deleteBot()` с confirm
- Create form → `API.createBot()` с mapping legacy→new field names
- Plan gating ошибки ловятся, показываются как warn toast
- WS on `trade_opened` → refresh list

**`signals.html`:**
- Stats cards: `API.mySignalStats()`
- Signal feed: `API.listSignals({limit:30, strategy})`
- Filter buttons (Все / SMC / Gerchik / Scalping / LONG / SHORT)
- **WS on `signal`** → insert новую карточку в начало + toast «Новый сигнал: BTC LONG»
- Signal card: entry/SL/TP1/TP2 + confidence progress bar + R:R + reason
- Rate-limit handling: 403 SIGNAL_LIMIT_REACHED → показывает upgrade CTA
- Strategy donut — из `API.globalSignalStats()`

**`backtests.html`:**
- `loadBacktests()` — grid c карточками: pending/running → прогресс-бар + %, completed → метрики + equity mini-chart
- Create form → `API.createBacktest()`
- **Auto-polling** каждые 2s пока есть pending/running
- Plan gating errors (UPGRADE_REQUIRED / BACKTEST_LIMIT_REACHED) → warn toasts

**`settings.html`:**
- `loadProfile()` — email через `API.me()`
- `loadSubscription()` — план + expiry
- Promo button → `API.redeemPromo(code)`
- Change password → прямой fetch на `/api/auth/change-password` + автологаут через 2s
- Stab tabs работают

**`wallet.html`:**
- `loadKeys()` — список API-ключей через `API.listKeys()` + параллельно `API.getBalance(id)` для баланса
- Verify / Delete кнопки
- Add modal → `API.addKey()` с exchange + apiKey + apiSecret
- (Polygon custodial wallet UI stub оставлен — ref-программа будет в Phase 12)

### Тесты

Никаких regressions — все **165 тестов проходят** (изменений в backend services только 2: botService + routes/bots, их модели и endpoint-shape те же что ожидали существующие тесты).

---

## 2. Что не сделано / отложено

- **Multi-step bot create modal** (4-шаговый wizard по спецификации) — сейчас используется legacy single-form modal, hooked to new API через field mapping. Multi-step оставил на Phase 13 когда будет админка.
- **Manual-confirm modal для `paper → live`** — пока просто UPDATE через `API.updateBot({tradingMode:'live'})` без confirm. В Phase 13 добавлю.
- **Academy / legal pages** — не трогаем (static content).
- **Subscription upgrade UI** — ссылки на `/#pricing` (ведут на index.html pricing section). Интеграция Stripe — Phase 12.

---

## 3. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Legacy `Sidebar.init()` и `Utils.generateEquityData()` более не существуют → старые скрипты могут падать на cached HTML | Новые скрипты не используют их; добавил `throw new Error('noauth')` как guard чтобы остальная часть inline-script не выполнялась после failed requireAuth |
| R2 | WebSocket `/ws` путь без HTTPS может блокироваться прокси на cPanel | `/ws` только attach'ится в standalone mode; в Passenger WebSocket работает через upgrade-header. Проверим при деплое |
| R3 | Free-tier юзер кликает в sig feed → 403 SIGNAL_LIMIT_REACHED → UI показывает «upgrade» | Явный код сообщения + ссылка на pricing |
| R4 | `API.getBalance(keyId)` в `loadKeys()` делает N network-запросов одновременно | Parallel Promise.all. При 5+ ключах возможен ratelimit от биржи. В Phase 14 добавлю pool/cache в marketDataService |

---

## 4. Acceptance Phase 11

- [x] `app.js` — полный refactor, все globals (Auth/API/Toast/WS/Fmt/I18n)
- [x] Auto-refresh JWT на 401
- [x] WS auto-connect + reconnect + auth
- [x] dashboard — live данные + equity chart
- [x] bots — CRUD + toggle + gating
- [x] signals — list + WS live feed + filters
- [x] backtests — create + polling + results
- [x] settings — profile + promo + change password
- [x] wallet — API keys CRUD + balance
- [x] botService / routes/bots переписаны под новую схему
- [x] 165/165 тестов проходят

---

## 5. Следующий шаг — Phase 12 (Stripe + Crypto платежи)

**План:**
1. `services/paymentService.js` — Stripe Checkout + webhook handler
2. `services/cryptoPaymentService.js` — BEP20/TRC20 через BscScan/Tronscan API с unique-amount matching
3. `routes/payments.js` — `/checkout/stripe`, `/crypto/create`, `/webhooks/stripe`
4. Обработка событий: `invoice.paid` → продлить подписку, `payment_failed` → status=past_due, `subscription.deleted` → cancelled
5. Ref-rewards: 20% с каждого платежа referred_user → в `ref_rewards` для payout

Жду **«го»**.
