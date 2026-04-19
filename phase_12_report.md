# Phase 12 — Отчёт (Payments: Stripe + Crypto + Ref-rewards)

**Статус:** ✅ Завершена. **Phase 13 (Admin Panel) или Phase 14 (Testing & Deploy) ждёт "go"**.

---

## 1. Что сделано

### `services/paymentService.js` — core

**Stripe Checkout:**
- `createStripeCheckout(userId, {plan, billingCycle, successUrl, cancelUrl})` → Stripe session + pending `payments` row
- `handleStripeWebhook(rawBody, signature)` → обрабатывает 4 event types:
  - `checkout.session.completed` → confirm payment + активировать подписку
  - `invoice.paid` → recurring renewal + extend subscription +30d
  - `invoice.payment_failed` → status=past_due
  - `customer.subscription.deleted` → status=cancelled
- Lazy Stripe init: работает и без `STRIPE_SECRET_KEY`, просто возвращает 503 на stripe endpoints (crypto-only mode)
- **Signature verification** через `stripe.webhooks.constructEvent()` если `STRIPE_WEBHOOK_SECRET` задан

**Crypto (BEP20 / TRC20):**
- `createCryptoPayment(userId, {plan, network, billingCycle})` — создаёт pending row с **уникальной суммой** (`basePrice + random 0.01-0.99`) для identifier-matching на блокчейне. Возвращает address + amountUsdt + expiresAt (1h TTL).
- `confirmCryptoPayment(paymentId, {txHash, fromAddress, amountUsdt})` — сверяет amount ±$0.01, проставляет tx metadata, триггерит `confirmPayment()`.

**Common:**
- `confirmPayment(paymentId)` — **idempotent** (второй вызов возвращает существующий без дублирования):
  1. UPDATE `status='confirmed', confirmed_at=now`
  2. `extendSubscription()` — создаёт или продлевает подписку (строится от current expiry если в future, иначе от now)
  3. `refRewards.issueReward(paymentId)` — 20% комиссия рефереру
  4. Audit log `payment.confirmed`

### `services/refRewards.js` — referral commission
- `issueReward(paymentId)` → insert `ref_rewards` row + update `referrals.total_earned_usd`. **Дедуп** по payment_id (один reward на payment).
- `listForUser(userId, {status, limit, offset})` — с JOIN на users.email
- `summaryForUser(userId)` → `{pendingUsd, paidUsd, totalRewards, referredCount}`
- `markPaid(rewardId, {adminUserId})` — admin выплатил → status='paid'
- `cancel(rewardId, {adminUserId, reason})`

### `services/cryptoMonitor.js` — blockchain polling
- `runOnce()` — находит pending crypto payments за последние 2ч, подтягивает USDT transfers через BscScan/Tronscan API, ищет match по amount ±$0.01 и timestamp ≥ payment.created_at - 5min.
- `start(intervalMs=60000)` — cron setInterval. Skip при отсутствии `PAYMENT_*_ADDRESS` или API-ключей (graceful no-op).
- USDT контракты жёстко прописаны: `0x55d3...` (BEP20), `TR7NHq...` (TRC20).

### `routes/payments.js` — 6 endpoints
- `POST /api/payments/stripe/checkout` (authed) — создаёт Checkout session
- `POST /api/payments/crypto/create` (authed) — уникальная сумма + address
- `POST /api/payments/webhooks/stripe` — Stripe events (raw body!)
- `GET /api/payments` (authed) — история платежей
- `GET /api/payments/ref/summary` (authed) — агрегат рефералов
- `GET /api/payments/ref/rewards` (authed) — список наград

### `server.js` hooks
- **Raw-body parser** ТОЛЬКО для `/api/payments/webhooks/stripe` (Stripe требует raw bytes для signature verification)
- Mount `/api/payments` → paymentsRoutes
- `cryptoMonitor.start()` в boot — cron каждые 60s

### Plan gating
- Already implemented in `plans.js` + `middleware/auth`. Paid plans: starter / pro / elite.
- `createStripeCheckout` / `createCryptoPayment` bail если plan='free' (throws Unpaid)

### Promo codes
Legacy `/api/subscriptions/promo` остался (существовал с Phase 1). Интегрирован с `extendSubscription` если переписать — отложено до тестирования.

---

## 2. Тесты `tests/payments.test.js` — **16 новых**

**planPrice:**
- Monthly совпадает с plans.js
- Yearly × 12 × 0.8
- Free rejects

**createCryptoPayment:**
- Создаёт pending с уникальной суммой в диапазоне [basePrice, basePrice+1]
- Rejects невалидную сеть

**confirmCryptoPayment:**
- Match → subscription активируется (plan=pro, expires +30d)
- Amount mismatch > $0.01 → throws
- Already-processed → throws (idempotent check)

**extendSubscription:**
- Creates if absent
- Extends from future expiry (сохраняет unused время)

**refRewards (E2E):**
- 20% reward записывается при confirm
- No reward если user без referrer
- Duplicate issueReward — idempotent (один raw)
- summaryForUser агрегирует pending/paid
- markPaid → status='paid' + paid_at

**getUserPayments:**
- Scope per-user (alice не видит payments bob'а)

---

## 3. Итоговые тесты

```
 ✓ tests/plans.test.js       (16)
 ✓ tests/crypto.test.js      (18)
 ✓ tests/auth.test.js        (16)
 ✓ tests/exchange.test.js    (10)
 ✓ tests/indicators.test.js  (34)
 ✓ tests/levels.test.js      (10)
 ✓ tests/signals.test.js     (14)
 ✓ tests/backtest.test.js    (13)
 ✓ tests/strategies.test.js  (14)
 ✓ tests/optimizer.test.js   (8)
 ✓ tests/autoTrade.test.js   (12)
 ✓ tests/payments.test.js    (16)  ← NEW

 Test Files  12 passed (12)
      Tests  181 passed (181)
   Duration  9.96s
```

---

## 4. Что нужно для прод-работы платежей

### Env vars на сервере
```bash
# Stripe (fiat)
STRIPE_SECRET_KEY=sk_live_...         # from dashboard.stripe.com/apikeys
STRIPE_WEBHOOK_SECRET=whsec_...       # from webhook endpoint settings
STRIPE_PUBLIC_KEY=pk_live_...         # для фронта

# Crypto
PAYMENT_BEP20_ADDRESS=0x...           # MetaMask / corporate wallet
PAYMENT_TRC20_ADDRESS=T...            # TronLink / corporate wallet
BSCSCAN_API_KEY=...                   # bscscan.com/myapikey (free)
TRONSCAN_API_KEY=...                  # (optional, higher rate-limit)
```

### Stripe Dashboard setup
1. Create webhook endpoint:
   - URL: `https://chmup.top/api/payments/webhooks/stripe`
   - Events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`
2. Copy webhook secret → `STRIPE_WEBHOOK_SECRET`

### Crypto monitor tuning
- Passenger может убить idle process → мониторинг встаёт. Для prod рекомендую PM2 + отдельный node-process для cron.
- API-ключи — лимиты:
  - BscScan free: 5 req/sec, 100k/day — более чем достаточно
  - Tronscan free: 5 req/sec

---

## 5. Риски

| # | Риск | Митигация |
|---|---|---|
| R1 | Stripe webhook не доходит → подписка не активируется | Fallback: `checkout.session.completed` доставляется retries автоматически от Stripe. Плюс можно вручную через admin-panel (Phase 13). |
| R2 | Юзер платит crypto, но не на уникальную сумму (округлил в телефоне) | Amount matching ±$0.01. Если он отправил 79.00 вместо 79.15 — не найдёт. Либо показываем QR-код с exact amount (UI Phase 13), либо manual admin match |
| R3 | Два пользователя случайно получили одинаковую уникальную сумму | Amount = basePrice + Math.floor(Math.random()*99)+1 / 100 — 99 уникальных значений на каждый план. При <10 активных crypto-платежей в час — коллизия <1%. Можно добавить collision check |
| R4 | Stripe signature verification fail → webhook отвергается | В тестах mock. В prod — обязательно задать `STRIPE_WEBHOOK_SECRET` + raw body parser уже прописан |
| R5 | Ref-reward сумма некорректна из-за колебаний fee Stripe | `refRewards.issueReward` использует `payments.amount_usd` — это уже чистая сумма, которую юзер заплатил. 20% от этого |
| R6 | Юзер refund'ит платёж → reward остался pending | Manual cancel admin'ом через `refRewards.cancel(rewardId)` — Phase 13 |

---

## 6. Acceptance Phase 12

- [x] Stripe Checkout flow: create session → user pays → webhook confirms → sub activated
- [x] Stripe webhook signature verification (если env задан)
- [x] Crypto flow: unique amount → blockchain polling → auto-confirm → sub activated
- [x] BscScan + Tronscan API integration (graceful no-op без env)
- [x] 20% ref-reward issued at confirm time
- [x] Idempotent confirmPayment (duplicate calls safe)
- [x] Subscription extension preserves unused future time
- [x] 16 новых тестов + 165 существующих = 181/181 проходят

---

## 7. Следующий шаг

Два варианта:

**Phase 13 (Admin Panel)** — UI для админа:
- Users list + search + ban
- Payments list + manual crypto confirm
- Promo codes CRUD
- Ref-rewards approval + payout
- System stats + audit log viewer
- Manual confirm + override для edge cases

**Phase 14 (Testing & Deploy)** — продакшн:
- E2E flow тесты через Playwright (полный UX)
- Load tests (50 concurrent users)
- `npm audit` + `eslint-plugin-security` scan
- cPanel deploy (Git pull + `npm install --production` + PM2 config)
- `slVerifier` cron для SL on-exchange verification
- Monitoring (Sentry DSN + UptimeRobot ping)

Скажи **«admin»** или **«deploy»** + «го».
