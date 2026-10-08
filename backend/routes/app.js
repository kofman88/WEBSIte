/**
 * /api/app/* — the bot's Mini App API (miniapp_api.py, ui-inventory.md §6)
 * on the site. Same envelope: `{ok:true, …}` / `{ok:false, error, message?}`
 * with HTTP 200 for business errors, 401 `unauthorized`, 429 `rate_limited`
 * (Retry-After), 400 only where the bot answers 400 (`bad_strategy`,
 * `nothing_to_change`). Auth = the site's JWT (`authMiddleware` → req.userId)
 * instead of X-Telegram-Init-Data.
 *
 * M7 routes: me, strategy, settings, settings/all GET/POST, profile, lang,
 * plan (no TON — the site's payment methods instead), help, settings/reset
 * and volume/reset (decision D10: the Telegram-only factory / VOLUME resets).
 * Signals / dashboard / analyze / genome / exchange keys / positions /
 * feedback / stats / share / challenge arrive with M10–M17.
 *
 * Rate buckets (`_rate_ok`, in-memory sliding window per "<bucket>:<uid>",
 * map pruned above 5000 keys): post 30 / 60 s (MINIAPP_POST_PER_MIN),
 * plan 10 / 60 s. Log markers `[MINIAPP] …` as in the bot.
 */

'use strict';

const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const db = require('../models/database');
const pf = require('../config/planFeatures');
const ts = require('../services/traderSettingsService');
const planService = require('../services/planService');
const profilesService = require('../services/profilesService');
const appSettings = require('../services/appSettingsService');
const volumeUserCfg = require('../services/volumeUserCfg');
const strategySet = require('../services/engine/strategySet');
const quietHours = require('../services/engine/quietHours');
const { pyBool } = require('../services/engine/pycoerce');
const help = require('../content/help');
const logger = require('../utils/logger');

const router = express.Router();

// ── rate limiter (miniapp_api._rate_ok) ──────────────────────────────────
const POST_RATE_LIMIT = [parseInt(process.env.MINIAPP_POST_PER_MIN || '30', 10) || 30, 60.0];
const PLAN_RATE_LIMIT = [10, 60.0];
const _RATE = new Map();
let _clock = () => Date.now() / 1000;

function rateOk(uid, bucket, limit, windowS, now = null) {
  const t = now === null || now === undefined ? _clock() : now;
  const key = `${bucket}:${uid}`;
  const hits = (_RATE.get(key) || []).filter((x) => t - x < windowS);
  if (hits.length >= limit) {
    _RATE.set(key, hits);
    return false;
  }
  hits.push(t);
  _RATE.set(key, hits);
  if (_RATE.size > 5000) {
    for (const [k, v] of _RATE) if (!v.length || t - v[v.length - 1] > 600) _RATE.delete(k);
  }
  return true;
}

function resetRateLimits() {
  _RATE.clear();
}

function setClock(fn) {
  _clock = fn || (() => Date.now() / 1000);
}

function rateLimited(res, retryS) {
  return res.status(429).set('Retry-After', String(retryS))
    .json({ ok: false, error: 'rate_limited', message: `Слишком часто. Повторите через ${retryS} с` });
}

// ── auth: reuse authMiddleware, answer with the Mini App envelope ────────
function appAuth(req, res, next) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    res.json = origJson;
    if (res.statusCode === 401 || res.statusCode === 403) {
      return origJson({ ok: false, error: 'unauthorized', ...(body && body.code ? { code: body.code } : {}) });
    }
    return origJson(body);
  };
  return authMiddleware(req, res, () => {
    res.json = origJson;
    next();
  });
}

router.use(appAuth);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'POST' && !rateOk(req.userId, 'post', ...POST_RATE_LIMIT)) return rateLimited(res, 10);
  next();
});

/** `_load_user`: the trader_settings row (created on first contact) + the admin bypass. */
function loadUser(req) {
  const user = ts.getOrCreate(req.userId);
  const opts = { admin: Boolean(req.isAdmin) };
  return { user, opts };
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
// Python `str(v)` as the bot applies it to enum-like fields: only a real string can ever
// match ("ru", "LEVELS", "active"); str(None) = "None", str(["en"]) = "['en']", str(5) = "5"
// never do, so every non-string collapses to '' (→ the same rejection).
const pyStr = (v) => (typeof v === 'string' ? v : '');
const bad = (res, key) => res.json({ ok: false, error: 'bad_request', message: key });
const STRATS = strategySet.STRATS;
const PREF_BOOLS = ['progress_notify_enabled', 'send_chart_enabled', 'genome_auto_apply'];

/** `_prefs(user)` */
function prefs(user) {
  const out = {};
  for (const k of PREF_BOOLS) out[k] = Boolean(user[k]);
  out.signal_format = user.signal_format === 'lite' ? 'lite' : 'full';
  [out.quiet_start, out.quiet_end] = quietHours.window(user);
  return out;
}

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

// ── GET me ───────────────────────────────────────────────────────────────
router.get('/me', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const site = db.prepare('SELECT display_name, telegram_username, given_name FROM users WHERE id = ?').get(req.userId) || {};
  const pro = ts.isPro(user, opts);          // QUIRK: check_access may downgrade in memory; persisted by the next saving handler
  res.json({
    ok: true,
    user: {
      id: user.user_id,
      username: site.display_name || site.telegram_username || '',
      first_name: site.given_name || '',
      lang: user.lang || 'ru',
      plan: pro ? 'pro' : 'free',
      plan_label: pro ? 'Pro' : 'Free',
      sub_expires: Math.trunc(Number(user.sub_expires || 0)),
      is_pro: pro,
    },
    strategy: user.strategy || 'LEVELS',
    strategies: strategySet.strategiesState(user, opts),
    extra_strategies: user.extra_strategies || '',
    prefs: prefs(user),
    auto_trade: Boolean(user.auto_trade),
    // QUIRK(ui-inventory §6.1): the bot returns getattr(user, "exchange", "") — UserSettings has no such attribute.
    exchange: '',
    bot_username: null,
  });
}));

// ── POST strategy {strategy, long, short} ────────────────────────────────
router.post('/strategy', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const b = body(req);
  const s = pyStr(b.strategy).toUpperCase();
  if (!STRATS.includes(s)) return res.status(400).json({ ok: false, error: 'bad_strategy' });
  const wantLong = pyBool(b.long);
  const wantShort = pyBool(b.short);
  if ((wantLong || wantShort) && strategySet.strategyLocked(user, s, opts)) return res.json({ ok: false, error: 'pro_required' });
  if (wantLong && wantShort) {
    try {
      if (ts.isMutualExclusionRequired(user, opts)) return res.json({ ok: false, error: 'pro_required' });
    } catch (_e) { /* bot: except Exception: pass */ }
  }
  const [lf, sf] = strategySet.FLAGS[s];
  user[lf] = wantLong;
  user[sf] = wantShort;
  strategySet.applyMulti(user, s, wantLong || wantShort);
  if (wantLong || wantShort) user.active = true;
  ts.save(user);
  logger.info(`[MINIAPP] strategy uid=${user.user_id} ${s} long=${wantLong} short=${wantShort}`);
  res.json({ ok: true, strategy: user.strategy, strategies: strategySet.strategiesState(user, opts) });
}));

// ── POST settings (profile toggles) ──────────────────────────────────────
router.post('/settings', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const b = body(req);
  let changed = false;
  for (const k of PREF_BOOLS) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
    if (k === 'genome_auto_apply' && pyBool(b[k]) && !ts.can(user, 'genome', opts)) return res.json({ ok: false, error: 'pro_required' });
    user[k] = pyBool(b[k]);
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'signal_format')) {
    user.signal_format = b.signal_format === 'lite' ? 'lite' : 'full';
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'quiet_start') || Object.prototype.hasOwnProperty.call(b, 'quiet_end')) {
    [user.quiet_start, user.quiet_end] = quietHours.normalize(
      Object.prototype.hasOwnProperty.call(b, 'quiet_start') ? b.quiet_start : -1,
      Object.prototype.hasOwnProperty.call(b, 'quiet_end') ? b.quiet_end : -1,
    );
    changed = true;
  }
  if (!changed) return res.status(400).json({ ok: false, error: 'nothing_to_change' });
  ts.save(user);
  res.json({ ok: true, prefs: prefs(user) });
}));

// ── GET / POST settings/all ──────────────────────────────────────────────
router.get('/settings/all', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  res.json({ ok: true, settings: appSettings.settingsAll(user), options: appSettings.options(user, opts) });
}));

router.post('/settings/all', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const out = appSettings.applySettings(user, body(req), opts);
  if (!out.ok) return res.json(out);
  res.json({ ok: true, settings: out.settings });     // no `options` (quirk 3)
}));

// ── POST profile {name} ──────────────────────────────────────────────────
router.post('/profile', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const name = pyStr(body(req).name).toLowerCase();
  if (!profilesService.PROFILES[name]) return bad(res, 'name');
  const r = profilesService.applyProfile(user, name, opts);
  logger.info(`[MINIAPP] [PROFILE] uid=${user.user_id} ${JSON.stringify(r)}`);
  res.json({ ok: true, profile: name, applied: r.applied, skipped: r.skipped, settings: appSettings.settingsAll(user) });
}));

// ── POST lang {lang} ─────────────────────────────────────────────────────
router.post('/lang', wrap((req, res) => {
  const { user } = loadUser(req);
  const lang = pyStr(body(req).lang).toLowerCase().trim();
  if (!['ru', 'en'].includes(lang)) return bad(res, 'lang');
  const before = user.lang || '?';
  user.lang = lang;
  ts.save(user);
  logger.info(`[MINIAPP] [LANG-CHANGE] uid=${user.user_id} lang: ${before}→${lang}`);
  res.json({ ok: true, lang });
}));

// ── GET plan ─────────────────────────────────────────────────────────────
router.get('/plan', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  if (!rateOk(user.user_id, 'plan', ...PLAN_RATE_LIMIT)) return rateLimited(res, 10);
  const pro = ts.isPro(user, opts);
  const exp = Number(user.sub_expires || 0);
  const lang = user.lang === 'en' ? 'en' : 'ru';
  const now = _clock();
  res.json({
    ok: true,
    plan: pro ? 'pro' : 'free',
    plan_label: pro ? 'Pro' : 'Free',
    sub_expires: Math.trunc(exp),
    days_left: pro ? Math.max(0, Math.floor((exp - now) / 86400)) : 0,
    price_usd: Math.trunc(pf.PLAN_PRICES_USD.pro),
    features: planService.PLAN_FEATURES_TEXT[lang].slice(),
    ton: null,                                              // decision D12: no TON on the site
    payment_methods: planService.paymentMethods(),
    checkout_url: '/subscriptions.html',
    admin_contact: planService.ADMIN_CONTACT,
  });
}));

// ── GET help ─────────────────────────────────────────────────────────────
router.get('/help', wrap((req, res) => {
  const { user } = loadUser(req);
  const lang = user.lang === 'en' ? 'en' : 'ru';
  res.json({ ok: true, lang, sections: help.plainSections(lang) });
}));

// ── POST settings/reset (bot settings:factory_reset_yes) ─────────────────
router.post('/settings/reset', wrap((req, res) => {
  const { user } = loadUser(req);
  let ok = false;
  try {
    ok = ts.resetSettings(user.user_id);
  } catch (e) {
    logger.warn(`factory_reset uid=${user.user_id}: ${e.message}`);
  }
  if (!ok) return res.json({ ok: false, error: 'unavailable' });
  logger.info(`[MINIAPP] settings/reset uid=${user.user_id}`);
  res.json({ ok: true, settings: appSettings.settingsAll(ts.get(user.user_id)) });
}));

// ── POST volume/reset (bot vol_cfg_reset, Pro) ───────────────────────────
router.post('/volume/reset', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  if (!ts.can(user, 'volume', opts)) return res.json({ ok: false, error: 'pro_required' });
  volumeUserCfg.resetUserCfg(user.user_id);
  logger.info(`[MINIAPP] volume/reset uid=${user.user_id}`);
  res.json({ ok: true, settings: appSettings.settingsAll(user) });
}));

router.use('/genome', require('./appGenome'));    // M16: GET genome, POST genome/apply, POST genome/evolve (D10)

module.exports = router;
module.exports.rateOk = rateOk;
module.exports.resetRateLimits = resetRateLimits;
module.exports.setClock = setClock;
module.exports.POST_RATE_LIMIT = POST_RATE_LIMIT;
module.exports.PLAN_RATE_LIMIT = PLAN_RATE_LIMIT;
