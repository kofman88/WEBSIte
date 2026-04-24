# CHM Finance — pre-launch checklist

Run top to bottom. **Do not announce to public users until every blocker (🔴) is checked.**

Mark each line with `[x]` as you complete it. Commit this file after you sign off so we have a record.

---

## 🔴 Blockers (must all pass)

### Smoke tests green against prod

```bash
SMOKE_URL=https://chmup.top node scripts/smoke.js
SMOKE_URL=https://chmup.top SMOKE_STRICT=1 node scripts/smoke.js   # fails on SMTP missing
```

- [ ] All checks PASS (health, auth, bot CRUD, PATCH, stats, equity, quick-backtest polling, signals, analytics)
- [ ] Migration at v7+ (proves `email_outbox` exists)
- [ ] Backtest queue <50 pending
- [ ] Email outbox sane (oldest pending < 60min)

### Live exchange keys

- [ ] One **testnet** key (Bybit or Binance) added via `/exchanges/keys` — verified green
- [ ] One real bot in `tradingMode: 'live'` created → toggled ON → placed one small order on testnet
- [ ] Order arrived on the exchange with correct side / quantity / SL / TP
- [ ] TV webhook: rotate secret, send a test alert, confirm it's recorded in `trades`

### Payments end-to-end

- [ ] `STRIPE_SECRET_KEY` is a **live** key (starts with `sk_live_`), not test
- [ ] Stripe webhook URL registered with Stripe dashboard and secret matches `STRIPE_WEBHOOK_SECRET`
- [ ] Real $1 Stripe test → payment row `confirmed`, subscription extended, email received
- [ ] One USDT BEP20 payment → confirmed via admin → plan changed in UI
- [ ] Promo code flow: create one from admin, redeem as another user, verify plan changed

### SMTP actually sends

- [ ] `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` set in `backend/.env`
- [ ] `npm i nodemailer` installed on prod (`ls node_modules/nodemailer` returns something)
- [ ] Register new account → verification email arrives in Gmail/iCloud (not spam)
- [ ] Password reset email arrives
- [ ] `email_outbox` pending drains to zero within 2 minutes

### SPF / DKIM / DMARC

- [ ] `dig TXT chmup.top` shows SPF record including SMTP provider
- [ ] DKIM signing enabled with the provider (Mailgun / SendGrid / Postmark docs)
- [ ] DMARC policy at least `p=quarantine` (`_dmarc.chmup.top`)
- [ ] Gmail marks verification email as "signed by chmup.top"

---

## 🟡 Strongly recommended before public launch

### Ops / infra

- [ ] Backup cron installed: `0 * * * * bash ~/WEBSIte/scripts/backup-db.sh`
- [ ] Backup file appeared in `~/backups/chmup/` and is valid:
      `sqlite3 <(gzip -dc file.db.gz) 'SELECT COUNT(*) FROM users'`
- [ ] Off-site copy: sync backups to S3 / Dropbox / another box nightly
- [ ] Recovery dry run: restored the latest backup to a scratch dir and opened it
- [ ] Sentry: `SENTRY_DSN` set, triggered one test error, it appeared in dashboard
- [ ] Log rotation: `logrotate.d` entry or winston daily rotate (check disk usage)
- [ ] Uptime monitor (UptimeRobot / BetterStack) hits `/api/health/deep` every 5min

### Security

- [ ] Admin account has 2FA enabled
- [ ] Admin account password is NOT in git, NOT in browser history, IS in password manager
- [ ] `JWT_SECRET`, `JWT_REFRESH_SECRET`, `WALLET_ENCRYPTION_KEY` are **not** the defaults from `.env.example`
- [ ] Keys are >32 bytes random: `openssl rand -hex 32`
- [ ] `backend/.env` is `chmod 600` and NOT readable by the web server user
- [ ] Cloudflare (or equivalent) in front of the domain with bot-fight mode on
- [ ] OFAC geo-block covers more than just `/register` — audit `backend/middleware/geoBlock.js`

### Frontend smoke (manual, in a browser)

- [ ] Landing (/) renders — hero, pricing, FAQ all show
- [ ] Register → login → dashboard
- [ ] Create paper bot via wizard → it appears in the list with a sparkline
- [ ] Click bot card → drawer opens with KPIs + equity chart + TV iframe + trades
- [ ] Inline settings form saves (PATCH returns 200, header updates)
- [ ] Quick-backtest from drawer completes and shows 6 result tiles
- [ ] Mobile: landing renders on iPhone-sized viewport without horizontal scroll
- [ ] Dark/light theme toggle works on every page

### Content / legal

- [ ] Terms of Service published at `/terms.html` (or equivalent)
- [ ] Privacy Policy published
- [ ] Risk disclosure (prominent, especially for LIVE mode)
- [ ] Footer links resolve — no broken links to docs/blog/telegram
- [ ] Cookie / analytics consent banner if tracking non-essential (EU users)
- [ ] Jurisdiction: confirmed with a local lawyer that bots-with-user-keys isn't a licenced activity where you operate

---

## 🟢 Soft-launch plan (don't skip)

1. [ ] Invite 5–10 friends. Explicit ask: "don't deposit more than $100, use DEMO first."
2. [ ] Run for **two weeks** in soft launch
3. [ ] Daily: check Sentry, admin dashboard, `/api/health/deep`
4. [ ] Weekly: review `audit_log` for anything surprising
5. [ ] Only then: open registration publicly + announce

---

## Post-launch watch

- Smoke cron: `*/5 * * * * SMOKE_URL=https://chmup.top node ~/WEBSIte/scripts/smoke.js >> ~/smoke.log 2>&1`
- Alert on: `health/deep` returning 503, `email_outbox.oldestPendingMinutes > 60`, `backtestQueue.pending > 50`
- Weekly: `VACUUM` the DB and compare size before/after to spot bloat
- Every 30 days: rotate `JWT_SECRET` (kicks all sessions — warn users)
