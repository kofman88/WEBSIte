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
 * refuses a key that can withdraw — and, fail-closed, a key whose permissions cannot be read:
 *   bybit    GET  <api|api-demo>.bybit.com/v5/user/query-api   (pybit get_api_key_information)
 *            result.permissions{group: [names]} — any name /withdraw/i (Wallet: "Withdraw")
 *   bingx    GET  open-api.bingx.com/openApi/v1/account/apiPermissions (signed like every
 *            BingX call) — data.permissions [codes]; 5 = Withdraw (also "5" / /withdraw/i)
 *   binance  GET  api.binance.com/sapi/v1/account/apiRestrictions (HMAC query, X-MBX-APIKEY)
 *            enableWithdrawals must be exactly false
 *   okx      GET  www.okx.com/api/v5/account/config — data[0].perm "read_only,trade[,withdraw]"
 * The bot only warns in its setup texts ("Без Withdraw!") and stores any key that tests OK.
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
const { PyError, pyGet, pyTruthy, isDict, pyFloat, errStr, pySlice, pyStr } = require('./exchanges/pyCompat');
const { pyRound } = require('../strategies/common/pyround');

const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);   // miniapp_api._EXCHANGES
const TEST_TIMEOUT_S = 20;              // asyncio.wait_for(_test_exchange(...), 20)
const PERMISSION_TIMEOUT_S = 8;         // D15: the permission read (keeps the request under the app's 30 s)
const BINANCE_SAPI_URL = 'https://api.binance.com';
const BINGX_WITHDRAW_CODE = 5;          // BingX api permission codes: 1 spot, 2 read, 3 perpetual, 4 universal transfer, 5 withdraw

const D15_MESSAGES = Object.freeze({
  withdraw: {
    ru: 'Ключ с правом вывода средств не принимается. Создайте на бирже новый API-ключ без права вывода (только торговля фьючерсами) и подключите его.',
    en: 'A key with withdrawal permission is not accepted. Create a new API key on the exchange without withdrawal permission (futures trading only) and connect it.',
  },
  unknown: {
    ru: 'Не удалось проверить права ключа на бирже — ключ не сохранён. Попробуйте ещё раз через минуту.',
    en: 'Could not check the key permissions on the exchange — the key was not saved. Try again in a minute.',
  },
});

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

// ── D15: the key's own permissions ───────────────────────────────────────

const WITHDRAW_RE = /withdraw/i;

/** Bybit /v5/user/query-api answer → verdict. */
function bybitVerdict(resp) {
  if (!isDict(resp) || resp.retCode !== 0) return { verdict: 'unknown', reason: 'retCode' };
  const res = resp.result;
  if (!isDict(res) || !isDict(res.permissions)) return { verdict: 'unknown', reason: 'no permissions' };
  for (const names of Object.values(res.permissions)) {
    if (names === null) continue;
    if (!Array.isArray(names)) return { verdict: 'unknown', reason: 'permissions shape' };
    if (names.some((n) => typeof n !== 'string')) return { verdict: 'unknown', reason: 'permissions shape' };
    if (names.some((n) => WITHDRAW_RE.test(n))) return { verdict: 'withdraw', reason: 'Withdraw' };
  }
  return { verdict: 'ok', reason: '' };
}

/** BingX /openApi/v1/account/apiPermissions answer → verdict. */
function bingxVerdict(resp) {
  if (!isDict(resp) || resp.code !== 0) return { verdict: 'unknown', reason: 'code' };
  const data = resp.data;
  if (!isDict(data) || !Array.isArray(data.permissions)) return { verdict: 'unknown', reason: 'no permissions' };
  for (const p of data.permissions) {
    if (typeof p === 'number') {
      if (p === BINGX_WITHDRAW_CODE) return { verdict: 'withdraw', reason: '5' };
    } else if (typeof p === 'string') {
      if (p.trim() === String(BINGX_WITHDRAW_CODE) || WITHDRAW_RE.test(p)) return { verdict: 'withdraw', reason: p };
    } else {
      return { verdict: 'unknown', reason: 'permissions shape' };
    }
  }
  return { verdict: 'ok', reason: '' };
}

/** Binance /sapi/v1/account/apiRestrictions answer → verdict. */
function binanceVerdict(resp) {
  if (!isDict(resp)) return { verdict: 'unknown', reason: 'shape' };
  if (resp.enableWithdrawals === true) return { verdict: 'withdraw', reason: 'enableWithdrawals' };
  if (resp.enableWithdrawals === false) return { verdict: 'ok', reason: '' };
  return { verdict: 'unknown', reason: 'no enableWithdrawals' };
}

/** OKX /api/v5/account/config answer → verdict. */
function okxVerdict(resp) {
  if (!isDict(resp) || resp.code !== '0' || !Array.isArray(resp.data) || !resp.data.length) return { verdict: 'unknown', reason: 'code' };
  const perm = isDict(resp.data[0]) ? resp.data[0].perm : undefined;
  if (typeof perm !== 'string') return { verdict: 'unknown', reason: 'no perm' };
  const parts = perm.split(',').map((s) => s.trim().toLowerCase());
  if (parts.includes('withdraw')) return { verdict: 'withdraw', reason: 'withdraw' };
  return { verdict: 'ok', reason: '' };
}

/** Binance: a signed GET on the spot API host with the trader's own signing (timestamp offset, recvWindow). */
async function binanceRestrictions(inst, key, secret) {
  const [qs, headers] = inst._buildQuery(key, secret, {});
  const resp = await inst.rt.transport({
    method: 'GET', url: `${BINANCE_SAPI_URL}/sapi/v1/account/apiRestrictions?${qs}`, headers, timeoutMs: PERMISSION_TIMEOUT_S * 1000,
  });
  // fail-closed: only a 200 answer counts (an error page never reads as "no withdrawals")
  if (Number(resp.status) !== 200) throw new PyError('HTTPError', `HTTP ${resp.status}`);
  const { parseJsonPy } = require('./exchanges/transport');
  return parseJsonPy(resp.text);
}

/**
 * checkWithdrawPermission(ex, {apiKey, apiSecret, passphrase, demo}) → {verdict: 'ok'|'withdraw'|'unknown', reason}.
 * Any error, timeout or unexpected answer → 'unknown' (the caller refuses the key).
 */
async function checkWithdrawPermission(ex, creds, deps = {}) {
  const timeoutS = deps.permissionTimeoutS === undefined || deps.permissionTimeoutS === null ? PERMISSION_TIMEOUT_S : deps.permissionTimeoutS;
  const key = creds.apiKey;
  const secret = creds.apiSecret;
  const run = async () => {
    if (ex === 'bybit') {
      const session = instanceOf('bybit', deps)._getSession(key, secret, Boolean(creds.demo));
      return bybitVerdict(await session._submit('GET', `${session.endpoint}/v5/user/query-api`, {}, true));
    }
    if (ex === 'bingx') return bingxVerdict(await instanceOf('bingx', deps)._request('GET', '/openApi/v1/account/apiPermissions', key, secret));
    if (ex === 'binance') return binanceVerdict(await binanceRestrictions(instanceOf('binance', deps), key, secret));
    if (ex === 'okx') return okxVerdict(await instanceOf('okx', deps)._request('GET', '/api/v5/account/config', key, secret, creds.passphrase || ''));
    return { verdict: 'unknown', reason: 'exchange' };
  };
  try {
    return await waitFor(run, timeoutS);
  } catch (e) {
    return { verdict: 'unknown', reason: e && e.isTimeout ? 'timeout' : String((e && (e.pyType || e.name)) || 'error') };
  }
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

/** h_exchange_keys_remove after the exchange check: the keys go, auto-trade stops when it was the trade exchange. */
function removeKeys(user, ex, deps = {}) {
  const L = deps.log || log();
  db.transaction(() => {
    clearKeys(user.user_id, ex);
    const cur = user.trade_exchange === undefined || user.trade_exchange === null ? 'bybit' : user.trade_exchange;
    if (cur === ex) user.auto_trade = false;
    ts.save(user);
  })();
  L.info(`[MINIAPP] exchange keys uid=${user.user_id} ${ex} removed`);
  return { body: { ok: true } };
}

module.exports = {
  EXCHANGES, TEST_TIMEOUT_S, PERMISSION_TIMEOUT_S, BINANCE_SAPI_URL, D15_MESSAGES,
  configure, keyHint, exchangeKeys, okxPassphrase, writeKeys, clearKeys, testExchange, checkWithdrawPermission,
  connectKeys, removeKeys, waitFor,
  _verdicts: { bybitVerdict, bingxVerdict, binanceVerdict, okxVerdict },
};
