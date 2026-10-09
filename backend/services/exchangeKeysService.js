'use strict';
/**
 * exchangeKeysService — the bot's per-user exchange API keys (miniapp_api.py `_EXCHANGES`,
 * `_key_hint`, `_exchange_keys`, `_test_exchange`, the bodies of h_exchange_keys /
 * h_exchange_keys_remove) on the site's encrypted key storage: the `exchange_keys` table of
 * services/exchangeService.js (AES-256-GCM with WALLET_ENCRYPTION_KEY, utils/crypto). The bot
 * keeps one key pair per exchange in `users.<ex>_api_key / _api_secret` (+ `okx_passphrase`);
 * here that is exactly one row per (user, exchange), label 'default' — the row every reader
 * (appSettingsService.exchangeKeys, the scanners' getApiKeys) picks first.
 *
 *   EXCHANGES                      ("bybit", "bingx", "binance", "okx")
 *   keyHint(key)                   f"{key[:4]}…{key[-2:]}" if len(key) >= 6 else ("…" if key else "")
 *   exchangeKeys(uid, ex)          → [key, secret, passphrase (okx only, else '')]  ('' when absent)
 *   testExchange(ex, key, secret, passphrase, demo, {registry})
 *                                  <exchange>_trader.test_connection(...) as the bot dispatches it
 *   checkWithdrawPermission(ex, creds, {registry, timeoutS})          decision D15 (below)
 *   connectKeys(user, ex, key, secret, passphrase, deps)              h_exchange_keys after its
 *                                  input checks: test (20 s) → D15 → save → reset auth failures
 *   removeKeys(user, ex)           h_exchange_keys_remove after its input check
 *
 * Decision D15 (docs/PORT_DECISIONS.md; the landing's security section promises it): after a
 * successful test_connection the site asks the exchange for the key's own permissions and
 * refuses a key that can withdraw — and, fail-closed, a key whose permissions cannot be read.
 * The reads and verdicts are services/autotrade/keyPermissions.js (the same code the account
 * page's POST /api/exchanges/keys uses). The bot only warns in its setup texts ("Без Withdraw!")
 * and stores any key that tests OK.
 *
 * Keys are never logged or returned (only the 4+2 hint); the bot's `[MINIAPP] exchange keys …`
 * log lines are kept verbatim.
 */

const db = require('../models/database');
const config = require('../config');
const ts = require('./traderSettingsService');
const { encrypt } = require('../utils/crypto');
const exchangeService = require('./exchangeService');
const exchanges = require('./exchanges');
const KP = require('./autotrade/keyPermissions');
const { PyError, pyGet, pyTruthy, isDict, pyFloat, errStr, pySlice, pyStr } = require('./exchanges/pyCompat');
const { pyRound } = require('../strategies/common/pyround');

const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);   // miniapp_api._EXCHANGES
const TEST_TIMEOUT_S = 20;              // asyncio.wait_for(_test_exchange(...), 20)
const PERMISSION_TIMEOUT_S = KP.PERMISSION_TIMEOUT_S;   // D15: the permission read (keeps the request under the app's 30 s)
const BINANCE_SAPI_URL = KP.BINANCE_SAPI_URL;
const D15_MESSAGES = KP.MESSAGES;

const D = { log: null, registry: null, resetAuthFailures: null };
const log = () => D.log || require('../utils/logger');

/** Tests / wiring: { log, registry, resetAuthFailures } (null → the default). */
function configure(o = {}) {
  for (const k of Object.keys(D)) if (Object.prototype.hasOwnProperty.call(o, k)) D[k] = o[k];
}

/** `_key_hint(key)` — code points like Python slicing. */
function keyHint(key) {
  const cps = Array.from(String(key === null || key === undefined ? '' : key));
  if (cps.length >= 6) return `${cps.slice(0, 4).join('')}…${cps.slice(-2).join('')}`;
  return cps.length ? '…' : '';
}

/** The exchange_keys row the bot's single column pair stands for. */
function keyRow(userId, ex) {
  return db.prepare(`
    SELECT id FROM exchange_keys WHERE user_id = ? AND exchange = ?
    ORDER BY CASE WHEN label = 'default' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1
  `).get(Number(userId), ex);
}

/** `_exchange_keys(user, ex)` → [key, secret, passphrase (okx only)]; an undecryptable row reads as no keys. */
function exchangeKeys(userId, ex) {
  const row = keyRow(userId, ex);
  if (!row) return ['', '', ''];
  try {
    const c = exchangeService.getCredentials(row.id, Number(userId));
    return [String(c.apiKey || ''), String(c.apiSecret || ''), ex === 'okx' ? String(c.passphrase || '') : ''];
  } catch (_e) {
    return ['', '', ''];
  }
}

/** The OKX passphrase (getattr(user, "okx_passphrase", "")) — '' without an OKX row. */
function okxPassphrase(userId) {
  return exchangeKeys(userId, 'okx')[2];
}

/** setattr(user, f"{ex}_api_key", key) … for one exchange: the row is replaced (one per exchange). */
function writeKeys(userId, ex, key, secret, passphrase) {
  const enc = (v) => encrypt(String(v), config.walletEncryptionKey);
  db.prepare('DELETE FROM exchange_keys WHERE user_id = ? AND exchange = ?').run(Number(userId), ex);
  db.prepare(`
    INSERT INTO exchange_keys (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted,
                               is_testnet, label, last_verified_at)
    VALUES (?, ?, ?, ?, ?, 0, 'default', CURRENT_TIMESTAMP)
  `).run(Number(userId), ex, enc(key), enc(secret), ex === 'okx' && passphrase ? enc(passphrase) : null);
}

/** The keys of one exchange set to "" (and the OKX passphrase): no row at all. */
function clearKeys(userId, ex) {
  db.prepare('DELETE FROM exchange_keys WHERE user_id = ? AND exchange = ?').run(Number(userId), ex);
}

function timeoutError() {
  const e = new Error('');
  e.name = 'TimeoutError';
  e.pyType = 'TimeoutError';
  e.isTimeout = true;
  return e;
}

/**
 * asyncio.wait_for(coro, timeout) — `work` is a function starting the coroutine (or a promise).
 * Rejects with a TimeoutError (str() ''). timeout <= 0: wait_for cancels the task before its first
 * step, so the work is never started (no request goes out). A timed-out call cannot be cancelled in
 * JS: its (read-only) result is dropped.
 */
function waitFor(work, timeoutS) {
  if (!(timeoutS > 0)) return Promise.reject(timeoutError());
  return new Promise((resolve, reject) => {
    let done = false;
    const h = setTimeout(() => {
      if (done) return;
      done = true;
      reject(timeoutError());
    }, timeoutS * 1000);
    if (h && h.unref) h.unref();
    let p;
    try {
      p = Promise.resolve(typeof work === 'function' ? work() : work);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(h);
      resolve(v);
    }, (e) => {
      if (done) return;
      done = true;
      clearTimeout(h);
      reject(e);
    });
  });
}

const registryOf = (deps) => (deps && deps.registry) || D.registry || undefined;
const instanceOf = (ex, deps, demo = false) => exchanges.getTrader(ex, { registry: registryOf(deps) }).instance({ demo });

/** `_test_exchange(ex, key, secret, passphrase, demo)`: <exchange>_trader.test_connection as handlers/trading.py calls it. */
async function testExchange(ex, key, secret, passphrase, demo, deps = {}) {
  if (ex === 'bybit') return instanceOf('bybit', deps).testConnection(key, secret, demo);
  if (ex === 'bingx') return instanceOf('bingx', deps).testConnection(key, secret);
  if (ex === 'binance') return instanceOf('binance', deps).testConnection(key, secret);
  return instanceOf('okx', deps).testConnection(key, secret, passphrase);
}

// ── D15: the key's own permissions (one implementation: services/autotrade/keyPermissions.js) ──

/**
 * checkWithdrawPermission(ex, {apiKey, apiSecret, passphrase, demo}) → {verdict: 'ok'|'withdraw'|'unknown', reason}.
 * Any error, timeout or unexpected answer → 'unknown' (the caller refuses the key).
 */
function checkWithdrawPermission(ex, creds, deps = {}) {
  const timeoutS = deps.permissionTimeoutS === undefined || deps.permissionTimeoutS === null ? PERMISSION_TIMEOUT_S : deps.permissionTimeoutS;
  return KP.checkPermissions(ex, creds, { registry: registryOf(deps), timeoutS });
}

/** auto_trade.reset_auth_failures(uid, ex): the auth breaker of the auto-trade registry (best effort, like the bot). */
async function resetAuthFailures(userId, ex) {
  if (D.resetAuthFailures) return D.resetAuthFailures(userId, ex);
  return require('../workers/tradeOpsWorker').client().resetAuthFailures(userId, ex);
}

/**
 * h_exchange_keys from the test call on (the route did _load_user, the plan / rate checks and
 * the input checks). → { body } — the JSON object the bot answers (HTTP 200 in every case).
 */
async function connectKeys(user, ex, key, secret, passphrase, deps = {}) {
  const L = deps.log || log();
  const lang = user.lang === 'en' ? 'en' : 'ru';
  const demo = Boolean(user.bybit_demo);
  let result;
  try {
    result = await waitFor(() => testExchange(ex, key, secret, passphrase, demo, deps), deps.testTimeoutS === undefined || deps.testTimeoutS === null ? TEST_TIMEOUT_S : deps.testTimeoutS);
  } catch (e) {
    if (e && e.isTimeout) return { body: { ok: false, error: 'invalid_keys', message: 'timeout' } };
    L.info(`[MINIAPP] exchange keys uid=${user.user_id} ${ex}: test failed (${(e && (e.pyType || e.name)) || 'Exception'})`);
    return { body: { ok: false, error: 'invalid_keys', message: pySlice(errStr(e), 200) } };
  }
  if (!isDict(result) || !pyTruthy(pyGet(result, 'ok'))) {
    const msg = isDict(result) ? pyStr(pyTruthy(pyGet(result, 'error')) ? pyGet(result, 'error') : '?') : '?';
    return { body: { ok: false, error: 'invalid_keys', message: pySlice(msg, 200) } };
  }
  // D15: the exchange's own word on the key — a key that can withdraw (or whose permissions
  // cannot be read) is not stored. Bybit asks the endpoint the key works on (demo / live).
  const onDemo = ex === 'bybit' && pyGet(result, 'endpoint') === 'demo';
  const perm = await checkWithdrawPermission(ex, { apiKey: key, apiSecret: secret, passphrase, demo: onDemo }, deps);
  if (perm.verdict !== 'ok') {
    const kind = perm.verdict === 'withdraw' ? 'withdraw' : 'unknown';
    L.info(`[MINIAPP] exchange keys uid=${user.user_id} ${ex}: ${kind === 'withdraw' ? 'withdraw permission' : `permission check failed (${perm.reason})`} — refused (D15)`);
    return {
      body: { ok: false, error: kind === 'withdraw' ? 'withdraw_permission' : 'permission_unknown', message: D15_MESSAGES[kind][lang] },
      refused: kind,
    };
  }
  let switched = false;
  db.transaction(() => {
    writeKeys(user.user_id, ex, key, secret, passphrase);
    if (ex === 'bybit' && pyTruthy(pyGet(result, '_switched'))) {      // авто-определение demo/live
      user.bybit_demo = pyGet(result, 'endpoint') === 'demo';
      switched = true;
    }
    user.trade_exchange = ex;
    ts.save(user);                                                     // exchange_keys encrypts the keys
  })();
  if (switched) {
    try {
      instanceOf('bybit', deps).invalidatePybitSession(key);
    } catch (e) {
      L.debug(`[MINIAPP] invalidate pybit session: ${e && e.message}`);
    }
  }
  try {
    await resetAuthFailures(user.user_id, ex);
  } catch (e) {
    L.debug(`[MINIAPP] reset_auth_failures: ${e && e.message}`);
  }
  L.info(`[MINIAPP] exchange keys uid=${user.user_id} ${ex} connected`);
  const out = { ok: true, exchange: ex, key_hint: keyHint(key) };
  try {
    const b = pyGet(result, 'balance');
    out.balance_usdt = pyRound(pyFloat(pyTruthy(b) ? b : 0), 2);
  } catch (e) {
    if (!(e instanceof PyError) || !['TypeError', 'ValueError'].includes(e.pyType)) throw e;
  }
  return { body: out };
}

/**
 * site: a removed key's in-memory copies in this thread go with its row — the Bybit session (it
 * holds the secret for up to 12 h) and the cached balance; the bot keeps them until their TTL.
 * Both removal paths call it (app exchange/keys/remove, account page DELETE /api/exchanges/keys/:id).
 * Best effort: the row is already gone, so no new order can use the key.
 */
function forgetKeyState(userId, ex, apiKey, deps = {}) {
  const L = deps.log || log();
  if (ex === 'bybit' && apiKey) {
    try { instanceOf('bybit', deps).invalidatePybitSession(apiKey); } catch (e) { L.debug(`[MINIAPP] invalidate pybit session: ${e && e.message}`); }
  }
  try {
    require('./exchanges/balanceCache').defaultCache()._cache.delete(`${Number(userId)}|${ex}`);
  } catch (_e) { /* best effort */ }
}

/** h_exchange_keys_remove after the exchange check: the keys go, auto-trade stops when it was the trade exchange. */
function removeKeys(user, ex, deps = {}) {
  const L = deps.log || log();
  const oldKey = ex === 'bybit' ? exchangeKeys(user.user_id, ex)[0] : '';
  db.transaction(() => {
    clearKeys(user.user_id, ex);
    const cur = user.trade_exchange === undefined || user.trade_exchange === null ? 'bybit' : user.trade_exchange;
    if (cur === ex) user.auto_trade = false;
    ts.save(user);
  })();
  forgetKeyState(user.user_id, ex, oldKey, deps);
  L.info(`[MINIAPP] exchange keys uid=${user.user_id} ${ex} removed`);
  return { body: { ok: true } };
}

module.exports = {
  EXCHANGES, TEST_TIMEOUT_S, PERMISSION_TIMEOUT_S, BINANCE_SAPI_URL, D15_MESSAGES,
  configure, keyHint, exchangeKeys, okxPassphrase, writeKeys, clearKeys, testExchange, checkWithdrawPermission,
  connectKeys, removeKeys, forgetKeyState, waitFor, resetAuthFailures,
  _verdicts: KP.verdicts,
};
