# Email deliverability setup — CHM Finance

Transactional email from `chmup.top` lands in **Inbox** (not Spam /
Promotions) only when the receiving server can cryptographically
verify our identity. Three DNS records do 95% of the work:

1. **SPF** — which hosts are allowed to send as `@chmup.top`
2. **DKIM** — digital signature on every outbound message
3. **DMARC** — policy telling inbox providers what to do when SPF+DKIM fail

Without these, Gmail/Outlook downgrade us to Spam from Feb 2024 onwards.

---

## 1. SPF (TXT record on `chmup.top`)

Replace `<YOUR_HOST_IP>` with your cPanel shared-server outbound IP
(cPanel → Email → Email Deliverability usually shows it).

```
Type: TXT
Host: @
Value: v=spf1 +a +mx ip4:<YOUR_HOST_IP> include:_spf.chmup.top ~all
```

Notes:
- `+a +mx` — allow A/MX records
- `~all` — softfail (recommended over `-all` while tuning)
- After 4 DNS lookups SPF breaks; if you have SendGrid/Mailgun add
  their include statement *instead of* ip4 rather than alongside

Verify: `dig +short TXT chmup.top | grep spf`

---

## 2. DKIM (TXT record on `default._domainkey.chmup.top`)

In cPanel → **Email Deliverability** → **Manage** → **Enable DKIM**.
cPanel generates a 2048-bit key and prints the TXT content. Paste it:

```
Type: TXT
Host: default._domainkey
Value: v=DKIM1; k=rsa; p=MIIBIjANBgkqh... (long base64 blob)
```

For rotation: generate a `rotate1` selector, give it a few days to
propagate, flip cPanel to use it, then remove old `default` after a
week when existing mails have been read.

Verify: `dig +short TXT default._domainkey.chmup.top`

---

## 3. DMARC (TXT record on `_dmarc.chmup.top`)

```
Type: TXT
Host: _dmarc
Value: v=DMARC1; p=quarantine; rua=mailto:security@chmup.top; ruf=mailto:security@chmup.top; fo=1; adkim=s; aspf=s; pct=100
```

Staging → production rollout:
1. Week 1: `p=none` + `rua=` → collect reports without enforcement
2. Week 2: `p=quarantine; pct=25` → 1/4 of failing mail to Spam
3. Week 3: `p=quarantine; pct=100`
4. Week 4 (optional): `p=reject` — only do this once reports are clean

Verify: https://mxtoolbox.com/dmarc.aspx?domain=chmup.top

---

## 4. "From" address best practices

Use a subdomain for transactional mail so marketing blasts later don't
poison the main-domain reputation:

- `no-reply@chmup.top`              — current
- `security@chmup.top`              — security alerts (required by DMARC `ruf=`)
- `billing@chmup.top`               — payment receipts (optional)
- `support@chmup.top`               — ticket replies
- `privacy@chmup.top`               — GDPR DPO contact

When you start sending >1000/day, move marketing to
`mail.chmup.top` subdomain and keep transactional on the root.

---

## 5. Bounce handling

Bounces now get written to the `email_bounces` table via
`emailService.logBounce()`. The `security@` alias should be wired to
an IMAP mailbox and periodically polled (cron or cPanel's
Pipe-to-program) to feed back into the table for automated suppression.

**SMTP 5xx hard bounce** → suppress the address permanently.
**SMTP 4xx soft bounce** → retry 3 times over 72h, then suppress.

See `backend/services/emailService.js` → `shouldSuppress()` and
`logBounce()`.

---

## 6. Monitoring

- **MX tests**: weekly run of `mail-tester.com` on a freshly registered
  test account → log score in audit_log as `ops.email.mx_test`
- **Inbox placement**: use https://www.gmass.co/inbox every release
- **Reputation**: Google Postmaster Tools (add TXT for domain
  verification once DKIM is green) tells you if any ISP is flagging
  us as spammy, usually with a 2-3 day lag
- **Volume**: `SELECT COUNT(*) FROM email_bounces WHERE created_at >=
  datetime('now','-7 day')` — if >3% of send volume, pause campaigns

Target: <1% bounce rate, <0.1% spam complaints, >95% inbox placement.
