/**
 * /api/app/challenge* — the bot's Mini App challenge routes (miniapp_api.py
 * h_challenge_get / h_challenge_post / h_challenge_topup / h_challenge_finish) on the site,
 * plus the two entry-advisor buttons (decision D10: Telegram-only callbacks become
 * /api/app/* routes). Mounted from routes/app.js, so auth (site JWT → req.userId), the
 * `Cache-Control: no-store` header and the generic POST bucket (30 / 60 s) come from there.
 *
 *   GET  challenge            rate bucket "challenge" = PLAN_RATE_LIMIT (10 / 60 s) → state
 *   POST challenge            {…answers, preview?, replace?}: Pro (feature `challenge`) →
 *                             bad_request {field} | preview {challenge, plan} |
 *                             already_active | start → state + applied / skipped
 *   POST challenge/topup      {amount} → 404 not_found | bad_request {message: "amount"} | state
 *   POST challenge/finish     → 404 not_found | cancelled → state
 *   POST entry-advice/on      entry_market_on   → {ok, message, prefer_market_entry}
 *   POST entry-advice/keep    entry_market_keep → {ok, message}
 *
 * Envelope as the bot: business errors with HTTP 200 (`pro_required`, `bad_request`,
 * `already_active`), 404 only for `not_found`, 429 `rate_limited` with Retry-After.
 */

'use strict';

const express = require('express');
const ts = require('../services/traderSettingsService');
const C = require('../services/challengeService');
const advisor = require('../services/entryAdvisor');
const logger = require('../utils/logger');

const router = express.Router();
// routes/app.js owns the rate buckets (and requires this file) — resolve it at call time.
const app = () => require('./app');

function loadUser(req) {
  const user = ts.getOrCreate(req.userId);
  return { user, opts: { admin: Boolean(req.isAdmin) } };
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

// ── GET challenge ────────────────────────────────────────────────────────
router.get('/challenge', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const a = app();
  if (!a.rateOk(user.user_id, 'challenge', ...a.PLAN_RATE_LIMIT)) {
    return res.status(429).set('Retry-After', '10')
      .json({ ok: false, error: 'rate_limited', message: 'Слишком часто. Повторите через 10 с' });
  }
  res.json(C.challengeState(user, opts));
}));

// ── POST challenge {...answers, preview?, replace?} ──────────────────────
router.post('/challenge', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  if (!ts.can(user, 'challenge', opts)) return res.json({ ok: false, error: 'pro_required' });
  const b = body(req);
  const answers = {};
  for (const k of C.ANSWER_KEYS) if (has(b, k)) answers[k] = b[k];
  let ch;
  try {
    ch = C.build(user.user_id, answers);
  } catch (e) {
    if (!C.isValueOrTypeError(e)) throw e;
    return res.json({ ok: false, error: 'bad_request', field: String(e.message) || 'answers' });
  }
  let stats;
  try {
    stats = C.stats30(user.user_id);
  } catch (_e) {
    stats = null;
  }
  if (C.truthy(b.preview)) {
    return res.json({ ok: true, preview: true, challenge: C.challengeDict(ch), plan: C.plan(ch, stats) });
  }
  const cur = C.load(user.user_id);
  if (cur !== null && cur.status === C.STATUS_ACTIVE && !C.truthy(b.replace)) {
    return res.json({ ok: false, error: 'already_active' });
  }
  const [, r] = C.start(user, answers, { admin: opts.admin });
  logger.info(`[MINIAPP] [CHALLENGE] uid=${user.user_id} start {'applied': ${C.pyListRepr(r.applied)}, 'skipped': ${C.pyListRepr(r.skipped)}}`);
  const out = C.challengeState(user, opts);
  Object.assign(out, { applied: r.applied, skipped: r.skipped });
  res.json(out);
}));

// ── POST challenge/topup {amount} ────────────────────────────────────────
router.post('/challenge/topup', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const ch = C.load(user.user_id);
  if (ch === null || ch.status !== C.STATUS_ACTIVE) return res.status(404).json({ ok: false, error: 'not_found' });
  try {
    const raw = body(req).amount;
    C.addTopup(ch, C.truthy(raw) ? C.pyFloat(raw) : 0.0);       // float(body.get("amount") or 0)
  } catch (e) {
    if (!C.isValueOrTypeError(e)) throw e;
    return res.json({ ok: false, error: 'bad_request', message: 'amount' });
  }
  res.json(C.challengeState(user, opts));
}));

// ── POST challenge/finish ────────────────────────────────────────────────
router.post('/challenge/finish', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const ch = C.load(user.user_id);
  if (ch === null || ch.status !== C.STATUS_ACTIVE) return res.status(404).json({ ok: false, error: 'not_found' });
  C.finish(ch, C.STATUS_CANCELLED);
  logger.info(`[MINIAPP] [CHALLENGE] uid=${user.user_id} finished by user`);
  res.json(C.challengeState(user, opts));
}));

// ── entry advisor buttons (handlers/entry_advisor.py) ────────────────────
router.post('/entry-advice/on', wrap(async (req, res) => {
  const r = await advisor.entryMarketOn(req.userId);
  res.json(r);
}));

router.post('/entry-advice/keep', wrap(async (req, res) => {
  res.json(await advisor.entryMarketKeep(req.userId));
}));

module.exports = router;
