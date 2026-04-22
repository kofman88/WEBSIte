# OAuth Setup — Google + Telegram

This guide walks you through getting CHM Finance's OAuth login working in
production. ~10 minutes UI work. Zero code changes needed — everything is
env-var driven.

---

## 1. Google OAuth 2.0

### 1.1 Create a Google Cloud project

1. Go to https://console.cloud.google.com and sign in with the account that
   will own the OAuth app.
2. Top bar → **Select a project** → **New project**.
   - Name: `CHM Finance` (or similar)
   - Organization: leave default
   - Click **Create**.
3. Wait a few seconds, then select the new project from the top-bar
   dropdown.

### 1.2 Configure the OAuth consent screen

1. Left nav → **APIs & Services** → **OAuth consent screen**.
2. User type: **External**. Click **Create**.
3. Fill in:
   - App name: `CHM Finance`
   - User support email: `support@chmup.top`
   - App logo: optional — upload your CHM logo if you have one at
     512×512 or larger.
   - App domain: `https://chmup.top`
   - Authorized domains: `chmup.top`
   - Developer contact: your email.
4. Click **Save and continue**.
5. Scopes — click **Add or remove scopes**. Select exactly these three:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   Click **Update**, then **Save and continue**.
6. Test users (only required while app is in "Testing" status): add your
   own Gmail so you can test before publishing. Click **Save and continue**.
7. Summary page → **Back to dashboard**.

**Publishing status** (recommended after testing): from the consent screen
page click **PUBLISH APP**. Without this, only the test-users list can
sign in. Publishing to "In production" needs no review for the basic
scopes we use.

### 1.3 Create OAuth Client ID

1. Left nav → **APIs & Services** → **Credentials**.
2. **+ Create credentials** → **OAuth client ID**.
3. Application type: **Web application**.
4. Name: `CHM Finance — production`
5. **Authorized JavaScript origins**:
   ```
   https://chmup.top
   ```
6. **Authorized redirect URIs**:
   ```
   https://chmup.top/api/auth/oauth/google/callback
   ```
   (For local dev also add `http://localhost:3000/api/auth/oauth/google/callback`)
7. Click **Create**.
8. Modal shows **Client ID** and **Client Secret**. Copy both. The secret
   is only shown here — save it in a password manager.

### 1.4 Add to `.env` on the server

```bash
cd ~/chmup_backend
cat >> .env <<'EOF'

# ── Google OAuth ────────────────────────────────
GOOGLE_OAUTH_CLIENT_ID=<paste Client ID here>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<paste secret here>
EOF

# Restart Passenger
touch ~/chmup_backend/tmp/restart.txt
```

Verify:

```bash
curl -s https://chmup.top/api/auth/oauth/providers
# Expected: {"google":{"enabled":true,"clientId":"...apps.googleusercontent.com"},"telegram":{...}}
```

The Google button on the login/register modals should now work.

---

## 2. Telegram Login Widget

Already uses your existing `@CHMUP_bot`. Just confirm `.env` has:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=CHMUP_bot
```

Then in **@BotFather** (in Telegram):

1. `/mybots` → pick `@CHMUP_bot`
2. **Bot Settings** → **Domain** → **Set domain**
3. Enter: `chmup.top`

Without this step Telegram Login Widget refuses to open — it only renders
for domains that are registered against the bot.

Verify:

```bash
curl -s https://chmup.top/api/auth/oauth/providers | jq .telegram
# {"enabled":true,"username":"CHMUP_bot"}
```

The Telegram button on login/register modals should now work end-to-end.

---

## 3. Apple Sign In — skipped

Requires an Apple Developer account ($99/year). If you decide to pay and
enable it later:

1. https://developer.apple.com/account → **Certificates, Identifiers &
   Profiles** → **Identifiers** → **+** → **Services IDs**
2. Register a Services ID (e.g. `top.chmup.signin`), enable **Sign In
   with Apple**, configure redirect URI
   `https://chmup.top/api/auth/oauth/apple/callback`.
3. **Keys** → **+** → **Sign In with Apple** → download the `.p8`.
4. Add to `.env`:
   ```
   APPLE_SIGN_IN_CLIENT_ID=top.chmup.signin
   APPLE_SIGN_IN_TEAM_ID=<10-char Apple Team ID>
   APPLE_SIGN_IN_KEY_ID=<10-char Key ID>
   APPLE_SIGN_IN_PRIVATE_KEY=<multiline .p8 contents>
   ```
5. The current code doesn't yet consume these — add a branch to
   `oauthService.js` analogous to the Google one (`apple-auth` on npm
   handles the JWT signing quirks).

---

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| `?oauth_error=bad_state` after Google click | Cookie was dropped — make sure `NODE_ENV=production` set `secure:true` only under HTTPS |
| `?oauth_error=disabled&provider=google` | `GOOGLE_OAUTH_CLIENT_ID` not set or empty — verify `.env` and that Passenger restarted |
| "redirect_uri_mismatch" from Google | The URL in step 1.3 must match EXACTLY what the backend uses — including scheme and trailing path |
| Telegram popup says "please set a domain" | Step 2 BotFather domain not set |
| Tests using `GOOGLE_OAUTH_CLIENT_ID` env — remove from CI | Not needed — tests mock the providers() return |
