# SMTP Password Rotation — no-reply@chmup.top

Rotate the SMTP password any time it has been exposed (accidentally pasted,
committed, shared in a ticket, or as routine hygiene every ~90 days).

Total time: **~5 minutes**. Requires cPanel access only — no code changes.

---

## 1. Generate a new password in cPanel

1. cPanel → **Email Accounts**
2. Find `no-reply@chmup.top` → **Manage**
3. Scroll to **NEW PASSWORD** → click the **Generate** button (avoid typing
   one by hand; cPanel's generator produces 16+ chars with symbols that
   SMTP negotiates cleanly)
4. Check **✓ "I have copied this password in a safe place"** — copy it to
   your password manager before clicking **Update Email Settings**
5. Click **Update Email Settings**. cPanel invalidates the old password
   immediately — any process still using it will get `535 Auth failed`.

---

## 2. Update `.env` on the server

```bash
ssh chmtop@chmup.top         # or cPanel Terminal
cd ~/chmup_backend
nano .env
```

Find the line `SMTP_PASSWORD=...` and replace the value with the new
password. Save (`Ctrl+O` → `Enter` → `Ctrl+X`).

Restart Passenger:

```bash
touch ~/chmup_backend/tmp/restart.txt
```

---

## 3. Smoke test — send a real email

```bash
# Trigger a verification email by registering with a throwaway address,
# OR: force a password-reset for an existing account:
curl -X POST https://chmup.top/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_TEST_EMAIL@gmail.com"}'
```

Expected: 200 response, and an email arrives in the inbox within 30s
(check spam too). If nothing arrives within 2 minutes:

```bash
tail -n 100 ~/chmup_backend/logs/error-$(date +%Y-%m-%d).log | grep -i smtp
```

Common failures:
- `535 5.7.8 Authentication failed` → password typo in `.env`, or cPanel
  hasn't propagated yet (wait 30s, try again)
- `ECONNREFUSED` → `SMTP_HOST` / `SMTP_PORT` wrong (should be
  `mail.chmup.top:465` with `SMTP_SECURE=true`)
- `self signed certificate` → add `SMTP_TLS_REJECT_UNAUTHORIZED=false` if
  cPanel cert chain is broken (rare)

---

## 4. After a leak — audit recent activity

If the rotation was in response to a **leak** (password pasted in chat,
pushed to git, etc.), also:

1. cPanel → **Email Accounts** → `no-reply` → **Email Routing** → look at
   the last 24h of outbound. Anything not from our app is suspicious.
2. GitHub → repo → **Settings → Security → Secret scanning** to see if
   GitHub already flagged the leak.
3. `git log --all -S'<leaked password prefix>'` — purge with BFG or
   `git filter-repo` if the password is in git history.

---

## 5. Rotation log

Keep a note here so we know when last rotated:

| Date       | Who    | Reason                         |
|------------|--------|--------------------------------|
| 2026-04-22 | system | Initial setup                  |
| _next_     |        | Routine 90-day                 |
