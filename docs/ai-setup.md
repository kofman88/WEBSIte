# AI Assistant Setup — Google Gemini (free tier)

Get the AI-assistant tab inside the support widget working. Bootstraps in
~2 minutes. No credit card required.

---

## 1. Create a Google AI Studio API key

1. Go to **https://aistudio.google.com/app/apikey**
2. Sign in with any Google account (personal works fine; no Workspace needed)
3. Click **Get API key** → **Create API key** → **Create API key in new project**
4. Copy the key (starts with `AIza...`). It's shown once — save to your
   password manager.

**Free-tier limits** (as of April 2026):
| Model                      | RPM | Daily limit |
|----------------------------|-----|-------------|
| `gemini-2.5-flash-lite`    | 15  | 1000        |
| `gemini-2.5-flash-lite` (default) | 15 | 1000  |
| `gemini-2.0-flash`         | 15  | 1500 *free\* |
| `gemini-2.5-flash`         | 10  | 250         |

The app defaults to **`gemini-2.5-flash-lite`** — Google gives 1000 req/day
free on every project. `gemini-2.0-flash` looks more attractive on paper
(1500/day, nominally higher quality) but Google hands out `quota=0` on
free tier for many new projects / regions, producing 429 errors from day
one. Switch to it via `GEMINI_MODEL=gemini-2.0-flash` once you've either
enabled billing or confirmed your project has non-zero quota.

**Privacy caveat**: Google uses free-tier traffic to train models. We
therefore block PII-looking content (api keys, wallet addresses, long
hashes) server-side and warn users in the widget. The paid tier is
exempt from training — switch when you start handling personal data.

---

## 2. Add to `.env` on the server

```bash
ssh chmtop@chmup.top         # or cPanel Terminal
cd ~/chmup_backend
nano .env
```

Append:

```
GEMINI_API_KEY=AIza...<your key>
# Optional override (default is gemini-2.5-flash-lite — 1000/day free):
# GEMINI_MODEL=gemini-2.5-flash    # 250/day, slightly higher quality
# GEMINI_MODEL=gemini-2.0-flash    # 1500/day IF your project has quota (not all do)
```

Save (`Ctrl+O` → Enter → `Ctrl+X`), restart Passenger:

```bash
touch ~/chmup_backend/tmp/restart.txt
```

---

## 3. Verify

```bash
# Usage endpoint (requires auth — grab the access token from a logged-in
# session in DevTools → Application → Local Storage → chm_access)
curl -s https://chmup.top/api/ai/usage \
  -H 'Authorization: Bearer <paste token>' | jq
```

Expected:
```json
{
  "requestsToday": 0,
  "requestsLimit": 20,
  "plan": "free",
  "enabled": true
}
```

If `enabled: false` → key not set / Passenger didn't pick up the env
(double-check `nano .env` saved, and that the line is exactly
`GEMINI_API_KEY=...` with no quotes).

Then open the site, click the support bubble, switch to the **AI** tab
and ask something like "что такое trailing stop?". Response arrives in
2–5 seconds.

---

## 4. Per-plan rate limits

Configured in `backend/services/aiService.js:limitForPlan()`:

| Plan    | Messages / day |
|---------|----------------|
| free    | 20             |
| starter | 100            |
| pro     | 250            |
| elite   | 500            |

Global ceiling on free Gemini tier is 1000–1500 req/day across ALL
users. If you grow past that, either:
1. Upgrade the Google billing (then bump per-user limits accordingly)
2. Add Redis-backed global counter + soft degrade with a "try again in
   an hour" message

For MVP the in-memory counter is fine — resets on process restart,
which matters only if a single user hammers the endpoint within one
Passenger lifetime.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `"AI assistant is not configured"` | `GEMINI_API_KEY` not set in `.env`, or Passenger not restarted |
| `"AI временно недоступен"` | Google API returned 5xx or timed out (30s). Check logs: `tail ~/chmup_backend/logs/error-*.log` |
| HTTP 429 `"Quota exceeded ... limit: 0, model: gemini-2.0-flash"` | Your project has 0 free-tier quota on that specific model. Switch: `GEMINI_MODEL=gemini-2.5-flash-lite` in `.env` + restart. Known quirk of Google's free tier for new projects. |
| Rate-limited at unexpectedly low counts | Per-minute (RPM) limit of 15 — not the daily. Add `setTimeout(..., 4000)` between retries |
| Replies in English when RU expected | System prompt says "respond in user's language"; make sure the user writes in Russian (the model mirrors) |
| "Похоже, ты пытаешься передать приватные данные" | PII detector triggered. Falsely-positive sometimes on long symbol names or hashes — that's by design; re-word the question |

---

## 6. Cost model

Free tier: **$0 forever** within the quota.

If you decide to pay for exemption from training or higher limits:
- Gemini 2.0 Flash paid: ~$0.075 per 1M input tokens, $0.30 per 1M
  output tokens
- Typical conversation: 500 input + 400 output tokens ≈ **$0.00016 per
  message**
- 10,000 messages / month ≈ **$1.60**

---

## 7. Future work

- **RAG over our own docs** — index `docs/`, `academy/`, strategy
  descriptions; retrieve before prompting Gemini so answers cite our
  actual content, not generic web knowledge.
- **Tools / function calls** — let the AI query the user's own data
  ("show my last 5 trades"). Requires paid tier for privacy.
- **Streaming responses** — `streamGenerateContent` + SSE on our side.
  Better UX for long answers, slightly more complex code.
