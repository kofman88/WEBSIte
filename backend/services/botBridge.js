/**
 * Bot bridge — the website as a shell of the CHM Breaker Telegram bot.
 *
 * In SITE_MODE=bot the site has no trading engine of its own: the Mini App
 * at /app is proxied to the bot (see middleware/botProxy.js) and the only
 * thing the site does with money is sell Pro. This module is the single
 * server-to-server client for the bot's HTTP API (aiohttp on 127.0.0.1:8080):
 *
 *   verifyLogin(payload, ip)   POST /miniapp/api/auth/telegram  — Login Widget
 *                              payload → bot verifies the signature with its
 *                              own token (the site never holds it) and returns
 *                              the user + Set-Cookie for the Mini App session.
 *   meFromCookie(sid)          GET  /miniapp/api/me with Cookie: chm_sid=…
 *   grantPro(tgId, days, …)    POST /miniapp/api/service/plan (service token)
 *   getUser(tgId)              GET  /miniapp/api/service/user
 *   publicStats()              GET  /miniapp/api/public/stats (cached 5 min)
 *
 * Pro grants for a site user whose Telegram id is unknown yet are queued in
 * system_kv (`botgrant:<userId>`) and flushed when the account gets linked
 * (Telegram Login Widget → users.tg_id, or the bot DM link → telegram_chat_id).
 */

const http = require('http');
const https = require('https');
const config = require('../config');
const db = require('../models/database');
const logger = require('../utils/logger');

const TIMEOUT_MS = 6000;
const ME_CACHE_TTL_MS = 60_000;
const STATS_CACHE_TTL_MS = 5 * 60_000;

function enabled() { return Boolean(config.botShell && config.botShell.enabled); }
function baseUrl() { return (config.botShell && config.botShell.apiUrl) || 'http://127.0.0.1:8080'; }

// Low-level JSON request. Resolves {status, headers, body(parsed|null)};
// rejects only on network errors / timeout. Tests replace this via _setRequest.
function rawRequest(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl());
    const data = body != null ? JSON.stringify(body) : null;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_e) { parsed = null; }
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('bot API timeout')); });
    if (data) req.write(data);
    req.end();
  });
}
let _request = rawRequest;
function _setRequest(fn) { _request = fn || rawRequest; }

function botError(message, statusCode, code) {
  const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
}

// ── Login via the bot ─────────────────────────────────────────────────
async function verifyLogin(payload, ip) {
  const r = await _request('POST', '/miniapp/api/auth/telegram', {
    body: payload, headers: ip ? { 'X-Forwarded-For': String(ip) } : {},
  });
  if (r.status === 429) throw botError('Too many login attempts', 429, 'RATE_LIMITED');
  if (r.status !== 200 || !r.body || !r.body.ok || !r.body.user) {
    throw botError('Telegram signature invalid', 401, 'INVALID_SIGNATURE');
  }
  const sc = r.headers['set-cookie'];
  return { user: r.body.user, setCookie: Array.isArray(sc) ? sc : (sc ? [sc] : []) };
}

const _meCache = new Map();   // sid → {at, user}
async function meFromCookie(sid) {
  if (!sid) return null;
  const hit = _meCache.get(sid);
  if (hit && Date.now() - hit.at < ME_CACHE_TTL_MS) return hit.user;
  const r = await _request('GET', '/miniapp/api/me', { headers: { Cookie: 'chm_sid=' + sid } });
  if (r.status !== 200 || !r.body || !r.body.ok || !r.body.user) return null;
  const user = r.body.user;
  if (_meCache.size > 500) _meCache.clear();
  _meCache.set(sid, { at: Date.now(), user });
  return user;
}

// ── Service API (Pro grants) ──────────────────────────────────────────
function serviceHeaders() {
  const token = config.botShell && config.botShell.serviceToken;
  if (!token) throw botError('BOT_SERVICE_TOKEN not configured', 503, 'BOT_SERVICE_DISABLED');
  return { 'X-CHM-Service-Token': token };
}

async function grantPro(telegramId, days, { source = 'site', ref = '' } = {}) {
  const r = await _request('POST', '/miniapp/api/service/plan', {
    headers: serviceHeaders(),
    body: { telegram_id: Number(telegramId), days: Number(days), plan: 'pro', source, ref: String(ref || '').slice(0, 120) },
  });
  if (r.status === 403) throw botError('bot rejected service token', 502, 'BOT_FORBIDDEN');
  if (r.status !== 200 || !r.body) throw botError('bot API error ' + r.status, 502, 'BOT_ERROR');
  if (!r.body.ok) throw botError('bot refused grant: ' + (r.body.error || '?'), 409, 'BOT_' + String(r.body.error || 'refused').toUpperCase());
  return r.body;   // {ok, telegram_id, plan, sub_expires}
}

async function getUser(telegramId) {
  const r = await _request('GET', '/miniapp/api/service/user?telegram_id=' + encodeURIComponent(String(telegramId)), {
    headers: serviceHeaders(),
  });
  if (r.status === 404) return null;
  if (r.status !== 200 || !r.body || !r.body.ok) throw botError('bot API error ' + r.status, 502, 'BOT_ERROR');
  return r.body;
}

// ── Public stats for the homepage ─────────────────────────────────────
let _stats = { at: 0, data: null };
async function publicStats() {
  if (_stats.data && Date.now() - _stats.at < STATS_CACHE_TTL_MS) return _stats.data;
  const r = await _request('GET', '/miniapp/api/public/stats');
  if (r.status !== 200 || !r.body || !r.body.ok) {
    if (_stats.data) return _stats.data;          // stale beats empty
    throw botError('bot stats unavailable', 503, 'BOT_UNAVAILABLE');
  }
  _stats = { at: Date.now(), data: r.body };
  return r.body;
}

// ── Grants for site users ─────────────────────────────────────────────
function telegramIdOf(userId) {
  const row = db.prepare('SELECT tg_id, telegram_chat_id FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  const id = row.tg_id || row.telegram_chat_id;
  return id && /^\d+$/.test(String(id)) ? String(id) : null;
}

function queueGrant(userId, days, source, ref) {
  const key = 'botgrant:' + userId;
  const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key);
  let pending = [];
  try { pending = row ? JSON.parse(row.value) : []; } catch (_e) { pending = []; }
  if (ref && pending.some((p) => p.ref === ref)) return pending.length;
  pending.push({ days, source, ref, at: new Date().toISOString() });
  db.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(key, JSON.stringify(pending));
  return pending.length;
}

function pendingGrants(userId) {
  const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get('botgrant:' + userId);
  try { return row ? JSON.parse(row.value) : []; } catch (_e) { return []; }
}

/**
 * Give `days` of Pro in the bot to a site user. Called after every confirmed
 * payment. Unknown Telegram id → queued; bot down → queued (retried on the
 * next link/flush). Never throws: a payment is confirmed on the site first,
 * the bot grant is best-effort with a durable queue behind it.
 */
async function grantForUser(userId, days, { source = 'site', ref = '' } = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  const tgId = telegramIdOf(userId);
  if (!tgId) {
    const n = queueGrant(userId, days, source, ref);
    logger.info('bot grant queued (no telegram id yet)', { userId, days, pending: n });
    return { queued: true, pending: n };
  }
  try {
    const out = await grantPro(tgId, days, { source, ref });
    logger.info('bot grant ok', { userId, tgId, days, until: out.sub_expires });
    return { granted: true, telegramId: tgId, subExpires: out.sub_expires };
  } catch (err) {
    if (err.code && err.code.startsWith('BOT_BANNED')) {
      logger.warn('bot grant refused: user banned in bot', { userId, tgId });
      return { refused: 'banned' };
    }
    const n = queueGrant(userId, days, source, ref);
    logger.warn('bot grant failed — queued', { userId, tgId, err: err.message, pending: n });
    return { queued: true, pending: n, error: err.message };
  }
}

/** Flush queued grants once the user's Telegram id is known. */
async function flushGrants(userId, telegramId = null) {
  if (!enabled()) return { flushed: 0 };
  const pending = pendingGrants(userId);
  if (!pending.length) return { flushed: 0 };
  const tgId = telegramId || telegramIdOf(userId);
  if (!tgId) return { flushed: 0, pending: pending.length };
  const left = [];
  let flushed = 0;
  for (const p of pending) {
    try {
      await grantPro(tgId, p.days, { source: p.source || 'site', ref: p.ref || '' });
      flushed += 1;
    } catch (err) {
      if (err.code && err.code.startsWith('BOT_BANNED')) continue;   // drop: nothing to retry
      left.push(p);
    }
  }
  const key = 'botgrant:' + userId;
  if (left.length) {
    db.prepare(`INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
      .run(key, JSON.stringify(left));
  } else {
    db.prepare('DELETE FROM system_kv WHERE key = ?').run(key);
  }
  if (flushed) logger.info('bot grants flushed', { userId, tgId, flushed, left: left.length });
  return { flushed, pending: left.length };
}

module.exports = {
  enabled, baseUrl,
  verifyLogin, meFromCookie,
  grantPro, getUser, publicStats,
  grantForUser, flushGrants, pendingGrants, telegramIdOf,
  _setRequest,
  _resetCaches() { _meCache.clear(); _stats = { at: 0, data: null }; },
};
