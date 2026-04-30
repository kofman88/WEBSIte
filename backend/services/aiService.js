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

// ── Bot config assistant ─────────────────────────────────────────────────
// Given a free-form intent ("безопасный DCA на BTC, депозит $100"), return
// a structured bot config that the wizard / drawer can apply directly.
// Uses Gemini's responseSchema for clean JSON output — no more brittle
// regex-extraction-of-JSON-from-prose. Validated server-side with zod
// before returning, so a malicious / hallucinated reply can't sneak past.

const SYSTEM_PROMPT_BOT_CONFIG = `
Ты — AI-помощник по настройке торговых ботов в CHM Finance.
Пользователь описывает что хочет, ты возвращаешь конкретные параметры бота
в виде JSON (схема задана через responseSchema, ничего лишнего не пиши).

Выбирай безопасные дефолты:
  • leverage: 1–3× для новичков, 3–10× для опытных, выше — только если явно просят.
  • riskPct: 0.5–1.5% на сделку (никогда не больше 5%).
  • maxOpenTrades: 1–3 для DCA/Grid, 3–5 для остальных.
  • tradingMode: "paper" по умолчанию (deemo). "live" только если пользователь явно сказал «реальные деньги».
  • timeframe: 1h по умолчанию для levels/smc/dca/grid; 5m–15m для scalping; 4h для gerchik.
  • direction: "both" по умолчанию; "long" если пользователь говорит «лонг» / «вверх» / «бычий»; "short" если «шорт» / «вниз» / «медвежий».

Правила выбора стратегии:
  • DCA — для усреднения, накопления, спокойных рынков, новичков.
  • Grid — для боковика / диапазона.
  • Levels — классические уровни поддержки/сопротивления, универсальная.
  • SMC — Smart Money Concepts, для опытных, ищет действия крупных игроков.
  • Gerchik — стратегия Александра Герчика (ретесты ключевых уровней).
  • Scalping — много мелких сделок на 5m/15m, быстрая ротация.

Объяснение (поле "explanation") — 1–3 предложения, по-русски, простым языком,
почему ты выбрал именно эти параметры. Если запрос подозрительный (просят
открыть конкретную сделку «купи BTC сейчас», слить депозит, etc.) — верни
безопасные демо-настройки и в explanation объясни что делать «прямо сейчас»
ты не можешь.
`.trim();

// Schema for Gemini's structured-output mode. Keep it close to the
// validation.createBotSchema shape so the frontend can apply the result
// without reshaping. Only the highest-leverage decisions are constrained
// via `enum` — numeric ranges live in zod for server-side validation.
const BOT_CONFIG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:          { type: 'STRING', description: 'Короткое имя бота, 3–48 символов' },
    strategy:      { type: 'STRING', enum: ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'] },
    timeframe:     { type: 'STRING', enum: ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] },
    symbol:        { type: 'STRING', description: 'Торговый символ, напр. BTCUSDT, ETHUSDT' },
    direction:     { type: 'STRING', enum: ['long', 'short', 'both'] },
    leverage:      { type: 'INTEGER', description: '1–100' },
    riskPct:       { type: 'NUMBER',  description: '0.1–10 (% риска на сделку)' },
    maxOpenTrades: { type: 'INTEGER', description: '1–20' },
    tradingMode:   { type: 'STRING', enum: ['paper', 'live'] },
    explanation:   { type: 'STRING', description: '1–3 предложения почему такие параметры' },
  },
  required: ['strategy', 'timeframe', 'direction', 'leverage', 'riskPct', 'maxOpenTrades', 'tradingMode', 'explanation'],
};

// Server-side validator — defends against hallucinations / out-of-range
// numbers that slip past the schema (Gemini is loose on numeric ranges).
function _sanitizeBotConfig(raw, plan) {
  const STRATS = ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'];
  const TFS    = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
  const DIRS   = ['long', 'short', 'both'];
  const MODES  = ['paper', 'live'];

  const out = {};
  out.strategy = STRATS.includes(raw.strategy) ? raw.strategy : 'levels';
  out.timeframe = TFS.includes(raw.timeframe) ? raw.timeframe : '1h';
  out.direction = DIRS.includes(raw.direction) ? raw.direction : 'both';
  out.tradingMode = MODES.includes(raw.tradingMode) ? raw.tradingMode : 'paper';

  out.leverage = Math.max(1, Math.min(100, Math.round(Number(raw.leverage) || 1)));
  out.riskPct = Math.max(0.1, Math.min(10, Number(raw.riskPct) || 1));
  out.maxOpenTrades = Math.max(1, Math.min(20, Math.round(Number(raw.maxOpenTrades) || 3)));

  const sym = String(raw.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  out.symbol = (sym && sym.length >= 3) ? sym : 'BTCUSDT';

  const name = String(raw.name || '').trim().slice(0, 48);
  out.name = name || (out.strategy.toUpperCase() + ' ' + out.symbol + ' ' + out.timeframe);

  out.explanation = String(raw.explanation || '').trim().slice(0, 600)
    || 'Безопасные дефолты для старта. Подкрути параметры под себя.';

  // Clamp leverage to plan limit if known. Frontend also shows the user
  // why it was clamped via the `_planClamps` field.
  const PLAN_LEV = { free: 5, starter: 10, pro: 25, elite: 100 };
  const cap = PLAN_LEV[plan] || 5;
  if (out.leverage > cap) {
    out._planClamps = (out._planClamps || []);
    out._planClamps.push('leverage clamped from ' + out.leverage + '× to ' + cap + '× (plan ' + plan + ')');
    out.leverage = cap;
  }
  return out;
}

async function configureBot({ userId, plan, intent }) {
  if (!GEMINI_API_KEY) {
    const e = new Error('AI assistant is not configured (GEMINI_API_KEY missing)');
    e.statusCode = 503; e.code = 'AI_DISABLED'; throw e;
  }
  const txt = String(intent || '').trim();
  if (txt.length < 4) {
    const e = new Error('Опиши задачу (хотя бы 4 символа): «безопасный DCA на BTC, депозит $100»');
    e.statusCode = 400; throw e;
  }
  if (txt.length > 1000) {
    const e = new Error('Слишком длинно — упрости описание (макс 1000 символов).');
    e.statusCode = 400; throw e;
  }
  if (looksLikePII(txt)) {
    const e = new Error('Не передавай приватные данные (api-ключи, адреса) — переформулируй без них.');
    e.statusCode = 400; e.code = 'AI_PII_BLOCKED'; throw e;
  }
  const limit = limitForPlan(plan);
  if (getCount(userId) >= limit) {
    const e = new Error('Дневной лимит AI-ассистента исчерпан (' + limit + '/день на плане ' + plan + ').');
    e.statusCode = 429; e.code = 'AI_RATE_LIMITED'; throw e;
  }

  const contents = [
    { role: 'user',  parts: [{ text: SYSTEM_PROMPT_BOT_CONFIG }] },
    { role: 'model', parts: [{ text: 'OK, верну только JSON по схеме.' }] },
    { role: 'user',  parts: [{ text: 'Запрос пользователя: ' + txt }] },
  ];

  let json;
  try {
    json = await _postJson(GEMINI_ENDPOINT + '?key=' + encodeURIComponent(GEMINI_API_KEY), {
      contents,
      generationConfig: {
        temperature: 0.4,        // lower for structured output — less wild
        maxOutputTokens: 800,
        responseMimeType: 'application/json',
        responseSchema: BOT_CONFIG_SCHEMA,
      },
    });
  } catch (err) {
    logger.error('gemini configure-bot failed', { err: err.message, status: err.statusCode });
    const e = new Error('AI временно недоступен — попробуй ещё раз через минуту.');
    e.statusCode = 502; e.code = 'AI_UPSTREAM'; throw e;
  }

  const cand = json.candidates && json.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = parts && parts[0] && parts[0].text;
  if (!text) {
    logger.warn('gemini empty configure-bot reply', { json });
    const e = new Error('AI не сгенерировал ответ — попробуй переформулировать.');
    e.statusCode = 502; throw e;
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    logger.warn('gemini configure-bot non-json reply', { text: text.slice(0, 200) });
    const e = new Error('AI вернул некорректный JSON — попробуй ещё раз.');
    e.statusCode = 502; throw e;
  }

  const config = _sanitizeBotConfig(parsed, plan);
  bumpCount(userId);
  return {
    config,
    usage: { requestsToday: getCount(userId), requestsLimit: limit },
  };
}

module.exports = { ask, configureBot, limitForPlan, getCount, looksLikePII, _SYSTEM_PROMPT: SYSTEM_PROMPT_RU };
