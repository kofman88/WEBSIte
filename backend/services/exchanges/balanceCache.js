'use strict';
/**
 * balanceCache.js — port of `balance_cache.py` ([W1.2 BALANCE-CACHE]): one shared 60 s cache
 * of exchange balances per (user_id, exchange), used by risk preview / adaptive sizing /
 * prop gates so they do not hammer the exchange.
 *
 *   getCachedBalance(user, exchange) → number | null
 *     user_id ≤ 0 → null; fresh entry (expires_at > now) → cached value; missing api key or
 *     secret (`<exchange>_api_key` / `<exchange>_api_secret`) → null; unknown exchange → null;
 *     the exchange call gets 5 s (asyncio.wait_for) — bybit with demo = bool(bybit_demo), okx
 *     with okx_passphrase; result float(balance or 0) cached until now + 60 (now taken BEFORE
 *     the call); any error / timeout → null and nothing cached.
 *   gcCache() → number of expired entries removed (expires_at < now).
 *
 * `user` is any object carrying the bot's column names (users row / UserSettings view).
 */

const { pyInt, pyFloat, pyOr, errStr } = require('./pyCompat');

const TTL_S = 60.0;
const TIMEOUT_S = 5.0;

class BalanceTimeout extends Error {
  constructor() { super(''); this.name = 'TimeoutError'; this.pyType = 'TimeoutError'; }
}

/**
 * asyncio.wait_for(work(), s): `work` starts inside a cancel scope (services/autotrade/asyncio), so
 * on the timeout the balance call's in-flight request is abandoned and no retry / fallback request
 * follows (a Bybit pybit call runs on in its thread) — BalanceTimeout ('') like the bot's.
 */
function realWithTimeout(work, s) {
  const asyncio = require('../autotrade/asyncio');
  return asyncio.waitFor(typeof work === 'function' ? work : () => work, s).catch((e) => {
    if (asyncio.isTimeoutError(e)) throw new BalanceTimeout();
    throw e;
  });
}

function createBalanceCache({
  getTrader = (ex) => require('./index').getTrader(ex),
  now = () => Date.now() / 1000,
  withTimeout = realWithTimeout,
  log = null,
} = {}) {
  const cache = new Map(); // `${uid}|${exchange}` → [balance, expiresAt]
  const logger = log || require('../marketData/mdLog').log;

  async function getCachedBalance(user, exchange) {
    const uid = pyInt(pyOr(user ? user.user_id : 0, 0));
    if (uid <= 0) return null;
    const key = `${uid}|${exchange}`;
    const nowTs = now();
    const cached = cache.get(key);
    if (cached && cached[1] > nowTs) return cached[0];

    const apiKey = pyOr(user[`${exchange}_api_key`], '');
    const apiSecret = pyOr(user[`${exchange}_api_secret`], '');
    if (!apiKey || !apiSecret) return null;
    try {
      let call;
      if (exchange === 'bybit') {
        call = () => getTrader('bybit').getBalance({ apiKey, apiSecret, demo: Boolean(user.bybit_demo) });
      } else if (exchange === 'bingx' || exchange === 'binance') {
        call = () => getTrader(exchange).getBalance({ apiKey, apiSecret });
      } else if (exchange === 'okx') {
        call = () => getTrader('okx').getBalance({ apiKey, apiSecret, passphrase: pyOr(user.okx_passphrase, '') });
      } else {
        return null;
      }
      const balance = await withTimeout(call, TIMEOUT_S);
      const balanceF = pyFloat(pyOr(balance, 0));
      cache.set(key, [balanceF, nowTs + TTL_S]);
      return balanceF;
    } catch (e) {
      logger.debug(`balance fetch uid=${uid} ex=${exchange}: ${errStr(e)}`);
      return null;
    }
  }

  function gcCache() {
    const nowTs = now();
    const stale = [...cache.entries()].filter(([, [, exp]]) => exp < nowTs).map(([k]) => k);
    for (const k of stale) cache.delete(k);
    return stale.length;
  }

  return { getCachedBalance, gcCache, _cache: cache };
}

let _default = null;
function defaultCache() {
  if (!_default) _default = createBalanceCache();
  return _default;
}

module.exports = {
  createBalanceCache, defaultCache, TTL_S, TIMEOUT_S, BalanceTimeout,
  getCachedBalance: (user, exchange) => defaultCache().getCachedBalance(user, exchange),
  gcCache: () => defaultCache().gcCache(),
};
