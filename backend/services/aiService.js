/**
 * AI assistant — thin wrapper around Google Gemini's free-tier API.
 *
 * Why Gemini (and not Claude / OpenAI)?
 *   - Free tier: 1000 requests/day with Gemini 2.5 Flash-Lite, no card
 *     required to get started. Good-enough for educational Q&A.
 *   - Trade-off: Google trains models on free-tier traffic. We therefore
 *     NEVER pass user-private data (balances, trades, strategies,
 *     positions) through this endpoint. The system prompt forbids the
 *     model from asking for such data, and server-side guards decline
 *     requests that contain clear PII markers.
 *
 *   Upgrade path: the same REST shape works with the paid tier (same
 *   endpoint, same key, just billed). Swap GEMINI_FREE_TIER=1 → 0 when
 *   we decide to handle user data.
 *
 * Endpoint: POST /api/ai/chat
 *   Body: { message: string, history?: [{ role, content }] }
 *   Returns: { reply, usage: { requestsToday, requestsLimit } }
 *
 * Rate limits (per user, rolling 24h):
 *   free    — 20 / day
 *   starter — 100 / day
 *   pro     — 250 / day
 *   elite   — 500 / day
 */

const https = require('https');
const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Default to gemini-2.5-flash-lite — 1000 req/day free for every project.
// gemini-2.0-flash is tempting for quality but Google hands out quota=0
// on free tier to some new projects/regions (observed 429 in prod from
// day one), so it's not a reliable default. Override via GEMINI_MODEL=
// env var once billing is enabled.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/'
  + GEMINI_MODEL + ':generateContent';

// Detects data that should NEVER leave the server in a free-tier prompt.
// Catches: BTC addresses, long numbers (likely account ids / balances),
// api-key-ish strings. Conservative — blocks more than it lets through.
const PII_PATTERNS = [
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,                 // BTC legacy
  /\bbc1[a-z0-9]{25,59}\b/,                              // BTC bech32
  /\b0x[a-fA-F0-9]{40}\b/,                               // ETH
  /\b[A-Z0-9]{32,}\b/,                                   // long alnum (api keys, hashes)
];

function looksLikePII(text) {
  if (!text) return false;
  for (const rx of PII_PATTERNS) if (rx.test(text)) return true;
  return false;
}

const SYSTEM_PROMPT_RU = `
Ты AI-помощник CHM Finance — платформы алго-торговли криптой.

Твои задачи:
  • Объяснять торговые концепции: что такое SL/TP, R:R, leverage, liquidation, funding rate.
  • Рассказывать про стратегии CHM: SMC, Gerchik, Scalping, Levels, DCA, Grid.
  • Помогать ориентироваться в интерфейсе: где создать бота, как подключить биржу.
  • Отвечать лаконично — 2–5 предложений, без воды.

ЧЕГО ТЫ НЕ ДЕЛАЕШЬ:
  • Не даёшь financial advice. Если спрашивают «купить ли BTC сейчас» — честно скажи
    что не знаешь и посоветуй backtest / paper-trading.
  • НЕ запрашиваешь у пользователя приватные данные (api-ключи, балансы, конкретные суммы).
  • Не обрабатываешь запросы которые содержат чужие конфиденциальные данные —
    вежливо откажись.

Отвечай на языке пользователя (русский по умолчанию, английский / испанский / турецкий / индонезийский если спросили на них).
`.trim();

// Lightweight in-memory rate limit per user. Resets at local midnight.
// Good enough for MVP — if the process restarts we reset which is fine.
const _dailyCount = new Map(); // userId → { count, dayKey }
function _dayKey() { return new Date().toISOString().slice(0, 10); }
function bumpCount(userId) {
  const key = _dayKey();
  const hit = _dailyCount.get(userId);
  if (!hit || hit.dayKey !== key) {
    _dailyCount.set(userId, { count: 1, dayKey: key });
    return 1;
  }
  hit.count += 1;
  return hit.count;
}
function getCount(userId) {
  const hit = _dailyCount.get(userId);
  if (!hit || hit.dayKey !== _dayKey()) return 0;
  return hit.count;
}
function limitForPlan(plan) {
  return ({ free: 20, starter: 100, pro: 250, elite: 500 })[plan] || 20;
}

function _postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const json = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 400) {
            const msg = (json.error && (json.error.message || json.error)) || ('HTTP ' + res.statusCode);
            return reject(Object.assign(new Error(msg), { statusCode: res.statusCode, body: json }));
          }
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gemini request timed out')));
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Ask Gemini for a reply. The caller is responsible for plan-based
 * rate-limiting (see routes/ai.js). We just enforce PII safety + call out.
 */
async function ask({ userId, plan, message, history = [] }) {
  if (!GEMINI_API_KEY) {
    const e = new Error('AI assistant is not configured (GEMINI_API_KEY missing)');
    e.statusCode = 503; e.code = 'AI_DISABLED';
    throw e;
  }
  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    const e = new Error('Message too short'); e.statusCode = 400; throw e;
  }
  if (message.length > 2000) {
    const e = new Error('Message too long (max 2000 chars)'); e.statusCode = 400; throw e;
  }
  if (looksLikePII(message)) {
    // Silently decline — return a canned reply rather than error, so the UX
    // is "the AI politely refused" not "system crashed".
    return {
      reply:
        'Похоже, ты пытаешься передать приватные данные (api-ключ, адрес кошелька, длинный hash). '
        + 'В бесплатной версии AI-ассистента я такое не обрабатываю — Google обучает модели на free-tier '
        + 'запросах. Задай вопрос общего плана, например «как работает SMC-стратегия?».',
      usage: { requestsToday: getCount(userId), requestsLimit: limitForPlan(plan) },
      declined: true,
    };
  }

  const limit = limitForPlan(plan);
  const current = getCount(userId);
  if (current >= limit) {
    const e = new Error(
      'Дневной лимит AI-ассистента исчерпан (' + limit + '/день на плане ' + plan + '). '
      + 'Попробуй завтра или обнови план.'
    );
    e.statusCode = 429; e.code = 'AI_RATE_LIMITED'; throw e;
  }

  // Build the Gemini request body. history[].role must be 'user' | 'model'.
  const contents = [];
  // Inject system prompt as the first user turn — Gemini's v1beta doesn't
  // have a dedicated "system" field across all models, so we front-load it.
  contents.push({ role: 'user',  parts: [{ text: SYSTEM_PROMPT_RU }] });
  contents.push({ role: 'model', parts: [{ text: 'Понял. Готов помочь.' }] });
  for (const turn of (Array.isArray(history) ? history.slice(-10) : [])) {
    if (!turn || !turn.content) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(turn.content).slice(0, 2000) }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  let json;
  try {
    json = await _postJson(GEMINI_ENDPOINT + '?key=' + encodeURIComponent(GEMINI_API_KEY), {
      contents,
      generationConfig: {
        temperature: 0.6,
        topP: 0.95,
        maxOutputTokens: 600,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    });
  } catch (err) {
    logger.error('gemini request failed', { err: err.message, status: err.statusCode });
    const e = new Error('AI временно недоступен — попробуй ещё раз через минуту.');
    e.statusCode = 502; e.code = 'AI_UPSTREAM';
    throw e;
  }

  const candidate = json.candidates && json.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) {
    logger.warn('gemini empty reply', { json });
    const e = new Error('AI не сгенерировал ответ — попробуй переформулировать.');
    e.statusCode = 502; throw e;
  }

  const count = bumpCount(userId);
  return {
    reply: text.trim(),
    usage: { requestsToday: count, requestsLimit: limit },
  };
}

module.exports = { ask, limitForPlan, getCount, looksLikePII, _SYSTEM_PROMPT: SYSTEM_PROMPT_RU };
