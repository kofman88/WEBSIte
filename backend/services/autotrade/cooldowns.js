'use strict';
/**
 * cooldowns.js — the per-(user, exchange) breakers of auto_trade.py:
 *
 *   zero-balance cooldown  (AUDIT-FIX-C59 / C78 #2)  30 min after "insufficient funds" /
 *       low-notional / insufficient-margin; persisted in kv `zb_cooldown_<uid>_<exchange>` =
 *       str(until_ts) (fire-and-forget), restored at start-up (`[C78]`), tombstoned ('') on reset/GC.
 *   commodity blocklist    ([FIX-TRADE-PLACEMENT]) 24 h per (uid, symbol) after Bybit 110125, memory only.
 *   auth-failure breaker   (AUDIT-FIX-C50/C54) 3 auth errors within 600 s → auto_trade=0 + one
 *       notification per 24 h, admin alert, `[AUTH-BREAKER]`; reset on a successful trade.
 *
 * kv writes go through `tasks.create(name, fn)` like the bot's `loop.create_task(...)`.
 */

const { pf, F } = require('./pyfmt');
const { makeLock } = require('./asyncio');
const { pyLower } = require('../../strategies/common/pyUnicode');
const { pyCapitalize } = require('../exchanges/pyCompat');

const ZERO_BAL_COOLDOWN_SEC = 30 * 60;
const COMMODITY_BLOCK_SEC = 24 * 3600;
const AUTH_FAIL_THRESHOLD = 3;
const AUTH_FAIL_WINDOW_SEC = 600;
const AUTH_FAIL_NOTIFIED_TTL = 24 * 3600;

// AUDIT-FIX-C50.2 / C61 / L4.11 — verbatim, in the bot's order
const USER_FACING_ERR_PATTERNS = Object.freeze([
  'api key is invalid', 'api key пов', 'auth failed after trying', 'contract is not live', 'qty invalid',
  'signature', 'ab not enough', 'insufficient', 'недостаточно средств', 'недостаточно маржи',
  'недостаточно свободного баланса',
  'errcode: 10003', 'errcode: 10001', 'errcode: 110074', 'errcode: 110001', 'errcode: 110007', 'errcode: 110043',
  'errcode: 10002', 'errcode: 110017', 'errcode: 110013', 'errcode: 10006', 'errcode: 34040',
  'server_timestamp', 'limit order not filled yet', 'position closed before tp',
  'code: 100413', 'code:100413',
  'code: -2014', 'code:-2014', 'code: -2015', 'code:-2015', 'code: -1022', 'code:-1022', 'code: -1021', 'code:-1021',
]);
const AUTH_FAILURE_PATTERNS = Object.freeze([
  'api key is invalid', 'api key пов', 'auth failed after trying',
  'errcode: 10003', '10003',
  'code: 100413', 'code:100413', '100413',
  'code: -2014', 'code:-2014', '-2014', 'code: -2015', 'code:-2015', '-2015',
]);

const errText = (e) => (e && e.message !== undefined ? String(e.message) : String(e));

/** _is_user_facing_error(err): str(err).lower() contains a known benign pattern. */
function isUserFacingError(err) {
  const s = pyLower(errText(err));
  return USER_FACING_ERR_PATTERNS.some((p) => s.includes(p));
}

/** _is_auth_failure(err) */
function isAuthFailure(err) {
  const s = pyLower(errText(err));
  return AUTH_FAILURE_PATTERNS.some((p) => s.includes(p));
}

function createCooldowns({
  now = () => Date.now() / 1000, kvSet = null, kvItemsWithPrefix = null, tasks = null, log = null,
  setAutoTrade = null, invalidateUserCaches = null, sendMessage = null, alertAuthBreaker = null,
} = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const zeroBalanceUntil = new Map();   // `${uid}|${exchange}` → until
  const commodityBlocklist = new Map(); // `${uid}|${symbol}` → until
  const authFailLog = new Map();        // `${uid}|${exchange}` → [ts]
  const authFailNotified = new Map();   // `${uid}|${exchange}` → ts
  const authFailLock = makeLock();
  const spawn = (name, fn) => {
    if (tasks) tasks.create(name, fn);
    else Promise.resolve().then(fn).catch(() => {});
  };

  const zbKvKey = (uid, exchange) => `zb_cooldown_${Math.trunc(Number(uid))}_${pyLower(String(exchange))}`;

  // ── zero-balance cooldown ────────────────────────────────────────────
  function checkZeroBalanceCooldown(uid, exchange) {
    const until = zeroBalanceUntil.get(`${uid}|${exchange}`) || 0.0;
    if (until > now()) return until - now();
    return 0.0;
  }

  function setZeroBalanceCooldown(uid, exchange) {
    const untilTs = now() + ZERO_BAL_COOLDOWN_SEC;
    zeroBalanceUntil.set(`${uid}|${exchange}`, untilTs);
    spawn(`zb_persist_${uid}_${exchange}`, async () => {
      try { await kvSet(zbKvKey(uid, exchange), pf('%s', F(untilTs))); } catch (e) { logger.debug(`zb_cooldown persist ${uid}: ${errText(e)}`); }
    });
  }

  function resetZeroBalanceCooldown(uid, exchange) {
    zeroBalanceUntil.delete(`${uid}|${exchange}`);
    spawn(`zb_reset_${uid}_${exchange}`, async () => {
      try { await kvSet(zbKvKey(uid, exchange), ''); } catch (e) { logger.debug(`silent exc auto_trade.py:248: ${errText(e)}`); }
    });
  }

  /** load_zero_balance_cooldowns_from_db → restored count. */
  async function loadZeroBalanceCooldownsFromDb() {
    try {
      const rows = await kvItemsWithPrefix('zb_cooldown_');
      const t = now();
      let restored = 0;
      for (const [key, value] of rows) {
        const ts = value ? Number(value) : 0;
        if (value && !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(value))) {
          logger.debug(`load_zb_cooldown parse ${key}: could not convert string to float: '${value}'`);
          continue;
        }
        if (ts <= t) continue;
        const rest = key.slice('zb_cooldown_'.length);
        const idx = rest.indexOf('_');
        if (idx < 0 || !/^-?\d+$/.test(rest.slice(0, idx))) {
          logger.debug(`load_zb_cooldown parse ${key}: bad key`);
          continue;
        }
        zeroBalanceUntil.set(`${Number(rest.slice(0, idx))}|${pyLower(rest.slice(idx + 1))}`, ts);
        restored += 1;
      }
      if (restored > 0) logger.info(pf('[C78] Zero-balance cooldowns restored from DB: %d', restored));
      return restored;
    } catch (e) {
      logger.debug(`load_zero_balance_cooldowns_from_db: ${errText(e)}`);
      return 0;
    }
  }

  function gcZeroBalanceRegistry() {
    const t = now();
    const stale = Array.from(zeroBalanceUntil.entries()).filter(([, ts]) => ts < t).map(([k]) => k);
    for (const k of stale) {
      zeroBalanceUntil.delete(k);
      const [uid, exch] = k.split('|');
      spawn(`zb_gc_${uid}_${exch}`, async () => {
        try { await kvSet(zbKvKey(uid, exch), ''); } catch (e) { logger.debug(`silent exc auto_trade.py:195: ${errText(e)}`); }
      });
    }
    return stale.length;
  }

  // ── commodity blocklist ──────────────────────────────────────────────
  function checkCommodityBlocklist(uid, symbol) {
    const until = commodityBlocklist.get(`${uid}|${symbol}`) || 0.0;
    if (until > now()) return until - now();
    return 0.0;
  }
  function setCommodityBlocklist(uid, symbol) {
    commodityBlocklist.set(`${uid}|${symbol}`, now() + COMMODITY_BLOCK_SEC);
  }
  function gcCommodityBlocklist() {
    const t = now();
    const stale = Array.from(commodityBlocklist.entries()).filter(([, ts]) => ts < t).map(([k]) => k);
    for (const k of stale) commodityBlocklist.delete(k);
    return stale.length;
  }

  // ── auth-failure breaker ─────────────────────────────────────────────
  function resetAuthFailures(uid, exchange) {
    authFailLog.delete(`${uid}|${exchange}`);
    authFailNotified.delete(`${uid}|${exchange}`);
  }

  function gcAuthFailRegistry() {
    const t = now();
    const cutoffLog = t - AUTH_FAIL_WINDOW_SEC;
    const cutoffNotified = t - AUTH_FAIL_NOTIFIED_TTL;
    let n = 0;
    for (const [k, lst] of Array.from(authFailLog.entries())) {
      if (!lst.length || Math.max(...lst) < cutoffLog) { authFailLog.delete(k); n += 1; }
    }
    for (const [k, ts] of Array.from(authFailNotified.entries())) {
      if (ts < cutoffNotified) { authFailNotified.delete(k); n += 1; }
    }
    return n;
  }

  /** _handle_auth_failure(user_id, exchange, bot) → true when the breaker tripped (auto_trade off). */
  async function handleAuthFailure(uid, exchange, bot) {
    const key = `${uid}|${exchange}`;
    const t = now();
    const decision = await authFailLock.run(async () => {
      const lst = authFailLog.get(key) || [];
      lst.push(t);
      const cutoff = t - AUTH_FAIL_WINDOW_SEC;
      const kept = lst.filter((x) => x >= cutoff);
      authFailLog.set(key, kept);
      if (kept.length < AUTH_FAIL_THRESHOLD) return { tripped: false };
      const prev = authFailNotified.get(key) || 0.0;
      if (prev && (t - prev) < AUTH_FAIL_NOTIFIED_TTL) return { tripped: true, already: true };
      authFailNotified.set(key, t);
      return { tripped: true, failCount: kept.length };
    });
    if (!decision.tripped) return false;
    if (decision.already) return true;
    try {
      await setAutoTrade(uid, false);
    } catch (e) {
      logger.warning(pf('auth-failure uid=%s: db_upsert_user failed: %s', uid, errText(e)));
    }
    try {
      if (invalidateUserCaches) await invalidateUserCaches();
    } catch (e) {
      logger.debug(pf('auth-failure cache invalidate uid=%s: %s', uid, errText(e)));
    }
    if (bot) {
      try {
        await sendMessage(bot, uid,
          '🔑 <b>Авто-трейд отключён</b>\n'
          + `Биржа <b>${pyCapitalize(String(exchange))}</b> ${AUTH_FAIL_THRESHOLD}× подряд `
          + 'вернула <code>API key is invalid (10003)</code>.\n'
          + '<i>Переподключи API-ключи в «Настройки → Авто-трейдинг → API» '
          + 'и включи авто-трейд снова.</i>',
          { parseMode: 'HTML' });
      } catch (e) {
        logger.debug(pf('auth-failure notify uid=%s: %s', uid, errText(e)));
      }
    }
    logger.warning(pf('[AUTH-BREAKER] uid=%s exch=%s: %d×10003 за %dс → auto_trade OFF', uid, exchange, decision.failCount, AUTH_FAIL_WINDOW_SEC));
    try {
      if (alertAuthBreaker) await alertAuthBreaker(bot, uid, exchange, decision.failCount);
    } catch (e) {
      logger.debug(`admin_alert auth-breaker: ${errText(e)}`);
    }
    return true;
  }

  /** record_auth_failure(user_id, exchange, bot, err=None) — public wrapper for any call site. */
  async function recordAuthFailure(uid, exchange, bot, err = null) {
    if (err !== null && err !== undefined && !isAuthFailure(err)) return false;
    return handleAuthFailure(uid, exchange, bot);
  }

  return {
    zbKvKey, checkZeroBalanceCooldown, setZeroBalanceCooldown, resetZeroBalanceCooldown, loadZeroBalanceCooldownsFromDb,
    gcZeroBalanceRegistry, checkCommodityBlocklist, setCommodityBlocklist, gcCommodityBlocklist,
    resetAuthFailures, gcAuthFailRegistry, handleAuthFailure, recordAuthFailure,
    _zeroBalanceUntil: zeroBalanceUntil, _commodityBlocklist: commodityBlocklist, _authFailLog: authFailLog, _authFailNotified: authFailNotified,
  };
}

module.exports = {
  ZERO_BAL_COOLDOWN_SEC, COMMODITY_BLOCK_SEC, AUTH_FAIL_THRESHOLD, AUTH_FAIL_WINDOW_SEC, AUTH_FAIL_NOTIFIED_TTL,
  USER_FACING_ERR_PATTERNS, AUTH_FAILURE_PATTERNS, isUserFacingError, isAuthFailure, createCooldowns,
};
