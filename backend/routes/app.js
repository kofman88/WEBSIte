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
 * Mounted: appGenome (M16), appChallenge (M17), appTrend (trend, trend/notify)
 * and appData (M10b: dashboard, signals, chart, result, stats, analyze, share,
 * feedback, events) and appTrade (M13b: exchange keys, positions, the trade buttons).
 *
 * Router-level answers as aiohttp, before auth: 404 / 405 text (routeMethods, on the RAW path:
 * case-sensitive, no trailing-slash or '//' folding); a handler exception → aiohttp's 500 page.
 * The envelope is written as the bot writes it (aioResponse.js: no ETag / 304): the 401 is the
 * json.dumps bytes of _unauthorized() with Cache-Control: no-store, the 429 of the POST / plan
 * buckets the json.dumps bytes of _rate_limited_response (an HTTPException: no Cache-Control).
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
const { pyJsonDumps } = require('../services/engine/pyjson');
const Y = require('../services/engine/yarlUrl');
const { writeResponse, JSON_UTF8, TEXT_UTF8, HTML_UTF8 } = require('../services/engine/aioResponse');
const help = require('../content/help');
const logger = require('../utils/logger');
const { intOrUndefined } = require('../strategies/common/pynum');
const { pyLower, pyStrip, pyUpper } = require('../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const router = express.Router();

// ── rate limiter (miniapp_api._rate_ok) ──────────────────────────────────
// (int(os.getenv("MINIAPP_POST_PER_MIN", "30") or 30), 60.0): "0" is a 0 limit, an unset / empty value 30.
const POST_RATE_LIMIT = [process.env.MINIAPP_POST_PER_MIN ? (intOrUndefined(process.env.MINIAPP_POST_PER_MIN) ?? 30) : 30, 60.0];
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

/**
 * _rate_limited_response(retry_s): web.HTTPTooManyRequests(text=json.dumps({...}), content_type=
 * "application/json", Retry-After) — json.dumps bytes (", " / ": ", the Cyrillic message \u-escaped);
 * an HTTPException is not a _json() answer, so no Cache-Control.
 */
function rateLimited(res, retryS) {
  res.removeHeader('Cache-Control');
  return writeResponse(res, 429, JSON_UTF8,
    pyJsonDumps({ ok: false, error: 'rate_limited', message: `Слишком часто. Повторите через ${retryS} с` }),
    { 'Retry-After': String(retryS) });
}

// ── auth: reuse authMiddleware, answer with the Mini App envelope ────────
function appAuth(req, res, next) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    res.json = origJson;
    if (res.statusCode === 401 || res.statusCode === 403) {
      // the bot's _unauthorized() = _json({"ok": False, "error": "unauthorized"}, 401): json.dumps bytes +
      // Cache-Control: no-store; a 403 (ACCOUNT_DISABLED) keeps the site's `code` for the app's login screen
      const out = { ok: false, error: 'unauthorized', ...(res.statusCode === 403 && body && body.code ? { code: body.code } : {}) };
      return writeResponse(res, res.statusCode, JSON_UTF8, pyJsonDumps(out), { 'Cache-Control': 'no-store' });
    }
    return origJson(body);
  };
  return authMiddleware(req, res, () => {
    res.json = origJson;
    next();
  });
}

/**
 * aiohttp's resolve() over this router: the methods registered for the request's RAW path relative to
 * /api/app — aiohttp compares a plain resource with URL.path_safe exactly (case-sensitive, a trailing
 * or doubled slash is another path, %XX of anything but '/' and '%' decoded), so Express' own
 * matching (case-insensitive, optional trailing slash, '//' folded at the mount) is not used. Plain
 * routes: this router's and the mounted routers' (MOUNTS); the data routes answer through appData's
 * yarl dispatcher. GET implies HEAD.
 */
function routeMethods(rawRel) {
  const safe = Y.pathSafe(rawRel);
  const out = new Set();
  let plainHit = false;
  const plain = (stack, mount) => {
    for (const layer of stack) {
      if (!layer.route || typeof layer.route.path !== 'string') continue;
      const full = layer.route.path === '/' && mount ? mount : mount + layer.route.path;
      if (full !== safe) continue;
      plainHit = true;
      for (const [m, on] of Object.entries(layer.route.methods)) if (on && m !== '_all') out.add(m.toUpperCase());
    }
  };
  plain(router.stack, '');
  for (const [mount, sub] of MOUNTS) {
    if (typeof sub.methods === 'function') for (const m of sub.methods(rawRel)) out.add(m);
    else plain(sub.stack, mount);
  }
  if (out.has('GET')) out.add('HEAD');
  return { methods: out, plainHit, safe };
}

// The router-level answers come first, as in aiohttp (before any handler, so before the initData /
// JWT check, and never counted in a rate bucket): no route → 404 "404: Not Found", a route without
// this method → 405 "405: Method Not Allowed" + Allow (sorted, GET with HEAD) — the bodies of
// web.HTTPNotFound / HTTPMethodNotAllowed. The generic POST bucket below therefore only counts the
// requests a handler takes, like the bot's `_load_user`.
router.use((req, res, next) => {
  let r;
  const rawRel = Y.rawPath(req.originalUrl).slice(req.baseUrl.length) || '/';
  try { r = routeMethods(rawRel); } catch (_e) { r = { methods: new Set(), plainHit: false, safe: rawRel }; }
  const ms = r.methods;
  if (!ms.size) return writeResponse(res, 404, TEXT_UTF8, '404: Not Found');
  if (!ms.has(req.method)) {
    return writeResponse(res, 405, TEXT_UTF8, '405: Method Not Allowed', { Allow: Array.from(ms).sort().join(',') });
  }
  // a plain route reached through %XX (e.g. /m%65): dispatch Express on the decoded path, as aiohttp does
  if (r.plainHit && r.safe !== rawRel) {
    const q = req.url.indexOf('?');
    req.url = r.safe + (q === -1 ? '' : req.url.slice(q));
  }
  return next();
});
router.use(appAuth);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'POST' && !rateOk(req.userId, 'post', ...POST_RATE_LIMIT)) return rateLimited(res, 10);
  next();
});

// The routers mounted after the M7 routes: [mount path, router] (routeMethods reads the same list)
const MOUNTS = [
  ['/genome', require('./appGenome')],     // M16: GET genome, POST genome/apply, POST genome/evolve (D10)
  ['', require('./appChallenge')],         // M17: challenge + entry-advisor buttons
  ['', require('./appTrend')],             // M10 (D10): GET trend (the /trend command), POST trend/notify (opt-out)
  ['', require('./appData')],              // M10b: dashboard, signals, chart, result, stats, analyze, share, feedback, events
  ['', require('./appTrade')],             // M13b: exchange/keys(/remove), positions, trades/{id}/exec|qc/*|progress
];

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
  const s = pyUpper(pyStr(b.strategy));
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

/**
 * h_settings_all's side effects after the save, best effort like the bot: `bybit_demo` in the payload
 * with a Bybit key → bybit_trader.invalidate_pybit_session(key) (this thread's session cache; the
 * session key carries demo/live, so another thread's cached session never serves the other host);
 * `trading.auto_trade` on → auto_trade.reset_auth_failures(uid, trade_exchange) (the engine worker's
 * registry, through exchangeKeysService's hook).
 */
async function settingsSideEffects(user, effects) {
  for (const fx of effects || []) {
    try {
      if (fx === 'invalidate_bybit_session') {
        const key = appSettings.exchangeKeys(user.user_id, 'bybit')[0];
        if (key) require('../services/exchanges').getTrader('bybit').instance({ demo: false }).invalidatePybitSession(key);
      } else if (fx.startsWith('reset_auth_failures:')) {
        await require('../services/exchangeKeysService').resetAuthFailures(user.user_id, fx.slice('reset_auth_failures:'.length));
      }
    } catch (e) {
      logger.debug(`[MINIAPP] ${fx.split(':')[0]}: ${e && e.message}`);
    }
  }
}

router.post('/settings/all', wrap(async (req, res) => {
  const { user, opts } = loadUser(req);
  const out = appSettings.applySettings(user, body(req), opts);
  if (!out.ok) return res.json(out);
  await settingsSideEffects(user, out._side_effects);
  res.json({ ok: true, settings: out.settings });     // no `options` (quirk 3)
}));

// ── POST profile {name} ──────────────────────────────────────────────────
router.post('/profile', wrap((req, res) => {
  const { user, opts } = loadUser(req);
  const name = pyLower(pyStr(body(req).name));
  if (!profilesService.PROFILES[name]) return bad(res, 'name');
  const r = profilesService.applyProfile(user, name, opts);
  logger.info(`[MINIAPP] [PROFILE] uid=${user.user_id} ${JSON.stringify(r)}`);
  res.json({ ok: true, profile: name, applied: r.applied, skipped: r.skipped, settings: appSettings.settingsAll(user) });
}));

// ── POST lang {lang} ─────────────────────────────────────────────────────
router.post('/lang', wrap((req, res) => {
  const { user } = loadUser(req);
  const lang = pyStrip(pyLower(pyStr(body(req).lang)));
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

for (const [mount, sub] of MOUNTS) {
  if (mount) router.use(mount, sub);
  else router.use(sub);
}

// An exception in a handler: aiohttp's web_protocol.handle_error answer — 500 with the status line
// and "Server got itself in trouble" (an HTML page when the client accepts text/html), the
// traceback in the log ("Error handling request").
router.use((err, req, res, _next) => {
  logger.error(`Error handling request ${req.method} ${require('../utils/redact').redact(req.originalUrl)}: ${(err && err.stack) || err}`);
  if (res.headersSent) return res.end();
  res.removeHeader('Cache-Control');            // aiohttp's error page is not a _json() answer
  const title = '500 Internal Server Error';
  const msg = 'Server got itself in trouble';
  if (String(req.headers.accept || '').includes('text/html')) {
    // web_protocol.handle_error's page, newlines included
    return writeResponse(res, 500, HTML_UTF8, `<html><head><title>${title}</title></head><body>\n<h1>${title}</h1>\n${msg}\n</body></html>\n`);
  }
  return writeResponse(res, 500, TEXT_UTF8, `${title}\n\n${msg}`);
});

module.exports = router;
module.exports.rateOk = rateOk;
module.exports.resetRateLimits = resetRateLimits;
/** Tests: the stored hits of one bucket ("<bucket>:<uid>", as kept — not re-filtered by the window). */
module.exports._rateHits = (bucket, uid) => (_RATE.get(`${bucket}:${uid}`) || []).length;
module.exports.setClock = setClock;
module.exports.POST_RATE_LIMIT = POST_RATE_LIMIT;
module.exports.PLAN_RATE_LIMIT = PLAN_RATE_LIMIT;
