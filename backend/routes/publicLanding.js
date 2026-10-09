/**
 * /api/public/{trend,stats,feed} — the landing's read-only data (frontend/landing/README.md),
 * from the site's own engine: the BTC trend monitor's state and the paper track of the system
 * accounts (services/publicTrack). No auth, no cookies read, nothing per user.
 *
 *   GET /trend              { symbol, updated_at, tfs: {tf: {trend, strength, since}}, change_24h, source }
 *   GET /stats              { source: 'paper', tracked_signals, closed_signals, open_signals, showcase_days,
 *                             bots_30d, outcomes_recent, registry, … }
 *   GET /feed               { delay_min: 60, levels_hidden: true, cursor, items, … }
 *   GET /feed?after=<c>     { cursor, events: [{type: 'new', item} | {type: 'update', id, status, path, r}], updated_at }
 *   no data yet             { empty: true, reason } (200)
 *
 * Every payload is computed at most once per minute and served with a weak ETag
 * (If-None-Match → 304) and `Cache-Control: public, max-age=30`. Rate limit: PUBLIC_API_RATE_PER_MIN
 * (default 60) requests per IP per 60 s over the three paths → 429 + Retry-After. A malformed
 * cursor → 400 { error: 'bad_cursor' }; a failure → 503 (the landing then shows «Данные временно
 * недоступны»). Showcase / sandbox / genome do not exist yet (product layer V1–V4) and fall
 * through to the API 404.
 */

'use strict';

const express = require('express');
const { RATE_WINDOW_S } = require('../services/publicTrack/config');
const { createRateLimiter } = require('../services/publicTrack/rateLimit');
const logger = require('../utils/logger');

const router = express.Router();
const CACHE_CONTROL = 'public, max-age=30';

let _track = null;
let _clock = () => Date.now() / 1000;
let _limiter = null;

function track() {
  if (!_track) _track = require('../services/publicTrack').defaultTrack();
  return _track;
}

function limiter() {
  if (!_limiter) {
    const limit = track().config.ratePerMin;
    _limiter = limit > 0 ? createRateLimiter({ limit, windowS: RATE_WINDOW_S, now: () => _clock() }) : { hit: () => ({ ok: true }), reset() {} };
  }
  return _limiter;
}

/** Tests: the track instance (services/publicTrack createPublicTrack) and the limiter's clock. */
function setTrack(inst) { _track = inst; _limiter = null; }
function setClock(fn) { _clock = fn || (() => Date.now() / 1000); _limiter = null; }
function resetRateLimits() { if (_limiter) _limiter.reset(); }

/**
 * An error answer: JSON, `Cache-Control: no-store` and no ETag (res.json would add one, so a
 * client could revalidate an error as if it were the payload).
 */
function sendError(res, status, body) {
  res.status(status).set('Cache-Control', 'no-store').set('Content-Type', 'application/json; charset=utf-8');
  res.removeHeader('ETag');
  return res.end(JSON.stringify(body));
}

router.use(['/trend', '/stats', '/feed'], (req, res, next) => {
  const r = limiter().hit(req.ip || (req.socket && req.socket.remoteAddress) || '?');
  if (r.ok) return next();
  res.set('Retry-After', String(r.retryS));
  return sendError(res, 429, { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' });
});

/** { body, etag } → 200 (or 304 when If-None-Match matches). */
function send(req, res, packed) {
  res.set('Cache-Control', CACHE_CONTROL);
  res.set('ETag', packed.etag);
  const inm = req.get('If-None-Match');
  if (inm && inm.split(',').map((s) => s.trim()).some((x) => x === packed.etag || x === '*')) {
    return res.status(304).end();
  }
  return res.type('application/json; charset=utf-8').send(packed.body);
}

function fail(res, where, e) {
  logger.warn(`[PUBLIC-API] ${where}: ${e && e.message}`);
  return sendError(res, 503, { error: 'unavailable', code: 'PUBLIC_UNAVAILABLE' });
}

router.get('/trend', async (req, res) => {
  try {
    return send(req, res, await track().trend());
  } catch (e) {
    return fail(res, 'trend', e);
  }
});

router.get('/stats', (req, res) => {
  try {
    return send(req, res, track().stats());
  } catch (e) {
    return fail(res, 'stats', e);
  }
});

router.get('/feed', (req, res) => {
  const after = req.query.after;
  try {
    return send(req, res, track().feed(after === undefined ? undefined : after));
  } catch (e) {
    if (e && e.code === 'bad_cursor') return sendError(res, 400, { error: 'bad_cursor' });
    return fail(res, 'feed', e);
  }
});

module.exports = router;
module.exports.setTrack = setTrack;
module.exports.setClock = setClock;
module.exports.resetRateLimits = resetRateLimits;
