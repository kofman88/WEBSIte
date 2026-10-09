'use strict';
/**
 * keyPermissions.js — SITE DECISION D15 (docs/PORT_DECISIONS.md): an exchange API key that can
 * WITHDRAW funds is never stored. On key add the exchange's own key-permission endpoint is asked;
 * a withdrawal-capable key is refused, and so is a key whose permissions could not be determined
 * (fail-closed: network error, timeout, non-200, unparsable / unexpected body, API error code).
 *
 *   Bybit    GET  https://api.bybit.com/v5/user/query-api            (demo key: api-demo.bybit.com)
 *            V5 auth (X-BAPI-*); result.permissions.{Wallet,…}: any entry "Withdraw" → withdraw
 *   Binance  GET  https://api.binance.com/sapi/v1/account/apiRestrictions  (SIGNED, X-MBX-APIKEY)
 *            enableWithdrawals: true → withdraw, false → ok, anything else → unknown
 *   OKX      GET  https://www.okx.com/api/v5/account/config           (OK-ACCESS-* + passphrase;
 *            demo key: x-simulated-trading: 1) data[0].perm "read_only,trade,withdraw"
 *   BingX    GET  https://open-api.bingx.com/openApi/v1/account/apiPermissions  (signed, X-BX-APIKEY)
 *            data.permissions: codes (5 = withdraw) or names containing "withdraw"
 *
 *   createKeyPermissionChecker({transport, now, log}) → {
 *     check({exchange, apiKey, apiSecret, passphrase, testnet}) → {verdict: 'ok'|'withdraw'|'unknown', reason}
 *     assertKeyCanBeAdded(input, {lang}) → throws {statusCode, code, message (ru|en)} unless 'ok'
 *   }
 *
 * Secrets never leave this module except inside the signed request; nothing here logs a key,
 * a secret, a passphrase or a signature. Under NODE_ENV=test / vitest the default transport refuses
 * to open connections (tests inject recorded responses), which makes every check `unknown`.
 */

const { TransportError, fetchTransport } = require('../exchanges/transport');
const { bybitSign } = require('../exchanges/bybitHttp');
const { binanceSign } = require('../exchanges/binanceTrader');
const { bingxSign, bingxQueryString } = require('../exchanges/bingxTrader');
const { okxSign, isoTimestamp } = require('../exchanges/okxTrader');

const TIMEOUT_MS = 10000;
const RECV_WINDOW = 5000;
const HOSTS = Object.freeze({
  bybit: 'https://api.bybit.com',
  bybitDemo: 'https://api-demo.bybit.com',
  binance: 'https://api.binance.com',
  okx: 'https://www.okx.com',
  bingx: 'https://open-api.bingx.com',
});
const BINGX_WITHDRAW_CODE = 5;

const MESSAGES = Object.freeze({
  withdraw: {
    ru: 'У этого API-ключа включено право на вывод средств. Создайте на бирже ключ без вывода (только чтение и торговля) и добавьте его снова.',
    en: 'This API key is allowed to withdraw funds. Create a key without withdrawals on the exchange (read + trade only) and add it again.',
  },
  unknown: {
    ru: 'Не удалось проверить права API-ключа на бирже. Попробуйте ещё раз через минуту.',
    en: 'Could not verify the API key permissions with the exchange. Please try again in a minute.',
  },
});

function networkDisabledTransport() {
  return async () => { throw new TransportError('connect', 'network disabled under NODE_ENV=test'); };
}

/** Tests (NODE_ENV=test or under vitest) never reach an exchange: the default transport refuses. */
function defaultPermissionTransport() {
  const testing = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  return testing ? networkDisabledTransport() : fetchTransport();
}

function parseJson(text) {
  try {
    return JSON.parse(String(text));
  } catch (_e) {
    return undefined;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mentionsWithdraw = (v) => typeof v === 'string' && /withdraw/i.test(v);

// ── per-exchange requests + verdicts ─────────────────────────────────────

function bybitRequest({ apiKey, apiSecret, testnet }, nowS) {
  const ts = String(Math.trunc(nowS * 1000));
  const sign = bybitSign(apiSecret, ts + apiKey + String(RECV_WINDOW));
  return {
    method: 'GET',
    url: `${testnet ? HOSTS.bybitDemo : HOSTS.bybit}/v5/user/query-api`,
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
    },
  };
}

function bybitVerdict(j) {
  if (!isObj(j) || j.retCode !== 0) return { verdict: 'unknown', reason: `retCode=${isObj(j) ? j.retCode : 'n/a'}` };
  const perms = isObj(j.result) ? j.result.permissions : undefined;
  if (!isObj(perms)) return { verdict: 'unknown', reason: 'no permissions object' };
  for (const [group, list] of Object.entries(perms)) {
    if (!Array.isArray(list)) return { verdict: 'unknown', reason: `permissions.${group} is not a list` };
    if (list.some(mentionsWithdraw)) return { verdict: 'withdraw', reason: `permissions.${group}` };
  }
  return { verdict: 'ok', reason: 'no Withdraw permission' };
}

function binanceRequest({ apiKey, apiSecret }, nowS) {
  const qs = `timestamp=${Math.trunc(nowS * 1000)}&recvWindow=${RECV_WINDOW}`;
  return {
    method: 'GET',
    url: `${HOSTS.binance}/sapi/v1/account/apiRestrictions?${qs}&signature=${binanceSign(qs, apiSecret)}`,
    headers: { 'X-MBX-APIKEY': apiKey },
  };
}

function binanceVerdict(j) {
  if (!isObj(j)) return { verdict: 'unknown', reason: 'not an object' };
  if (j.enableWithdrawals === true) return { verdict: 'withdraw', reason: 'enableWithdrawals' };
  if (j.enableWithdrawals === false) return { verdict: 'ok', reason: 'enableWithdrawals=false' };
  return { verdict: 'unknown', reason: j.code !== undefined ? `code=${j.code}` : 'no enableWithdrawals' };
}

function okxRequest({ apiKey, apiSecret, passphrase, testnet }, nowS) {
  const ts = isoTimestamp(nowS);
  const path = '/api/v5/account/config';
  const headers = {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': okxSign(ts, 'GET', path, '', apiSecret),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': passphrase || '',
    'Content-Type': 'application/json',
  };
  if (testnet) headers['x-simulated-trading'] = '1';
  return { method: 'GET', url: `${HOSTS.okx}${path}`, headers };
}

function okxVerdict(j) {
  if (!isObj(j) || String(j.code) !== '0' || !Array.isArray(j.data) || !isObj(j.data[0])) {
    return { verdict: 'unknown', reason: `code=${isObj(j) ? j.code : 'n/a'}` };
  }
  const perm = j.data[0].perm;
  if (typeof perm !== 'string' || !perm.trim()) return { verdict: 'unknown', reason: 'no perm' };
  const parts = perm.split(',').map((p) => p.trim().toLowerCase());
  if (parts.some((p) => p.includes('withdraw'))) return { verdict: 'withdraw', reason: 'perm' };
  return { verdict: 'ok', reason: `perm=${parts.join(',')}` };
}

function bingxRequest({ apiKey, apiSecret }, nowS) {
  const params = { timestamp: Math.trunc(nowS * 1000), recvWindow: RECV_WINDOW };
  return {
    method: 'GET',
    url: `${HOSTS.bingx}/openApi/v1/account/apiPermissions?${bingxQueryString(params)}&signature=${bingxSign(params, apiSecret)}`,
    headers: { 'X-BX-APIKEY': apiKey },
  };
}

function bingxVerdict(j) {
  if (!isObj(j) || j.code !== 0 || !isObj(j.data)) return { verdict: 'unknown', reason: `code=${isObj(j) ? j.code : 'n/a'}` };
  const perms = j.data.permissions;
  if (!Array.isArray(perms)) return { verdict: 'unknown', reason: 'no permissions list' };
  for (const p of perms) {
    if (Number(p) === BINGX_WITHDRAW_CODE || mentionsWithdraw(p)) return { verdict: 'withdraw', reason: 'permissions' };
    if (typeof p !== 'number' && typeof p !== 'string') return { verdict: 'unknown', reason: 'unexpected permission entry' };
  }
  return { verdict: 'ok', reason: `permissions=${perms.join(',')}` };
}

const EXCHANGES = Object.freeze({
  bybit: { request: bybitRequest, verdict: bybitVerdict },
  binance: { request: binanceRequest, verdict: binanceVerdict },
  okx: { request: okxRequest, verdict: okxVerdict },
  bingx: { request: bingxRequest, verdict: bingxVerdict },
});

function createKeyPermissionChecker({ transport = null, now = () => Date.now() / 1000, log = null } = {}) {
  const tx = transport || defaultPermissionTransport();
  const logger = log || require('../marketData/mdLog').log;

  async function check({ exchange, apiKey, apiSecret, passphrase = null, testnet = false } = {}) {
    const ex = EXCHANGES[String(exchange || '').toLowerCase()];
    if (!ex) return { verdict: 'unknown', reason: 'unsupported exchange' };
    if (!apiKey || !apiSecret) return { verdict: 'unknown', reason: 'missing key or secret' };
    if (exchange === 'okx' && !passphrase) return { verdict: 'unknown', reason: 'missing passphrase' };
    let resp;
    try {
      const req = ex.request({ apiKey: String(apiKey), apiSecret: String(apiSecret), passphrase, testnet: Boolean(testnet) }, now());
      resp = await tx({ ...req, timeoutMs: TIMEOUT_MS });
    } catch (e) {
      return { verdict: 'unknown', reason: `transport ${e && e.kind ? e.kind : 'error'}` };
    }
    if (!resp || resp.status !== 200) return { verdict: 'unknown', reason: `http ${resp ? resp.status : 'n/a'}` };
    const j = parseJson(resp.text);
    if (j === undefined) return { verdict: 'unknown', reason: 'invalid json' };
    try {
      return ex.verdict(j);
    } catch (_e) {
      return { verdict: 'unknown', reason: 'unexpected body' };
    }
  }

  /** D15 gate of the key-add path. Throws a route error unless the key provably cannot withdraw. */
  async function assertKeyCanBeAdded(input, { lang = 'ru' } = {}) {
    const res = await check(input);
    const l = lang === 'en' ? 'en' : 'ru';
    logger.info(`[KEY-PERMS] ${String(input && input.exchange)} verdict=${res.verdict} (${res.reason})`);
    if (res.verdict === 'ok') return res;
    const kind = res.verdict === 'withdraw' ? 'withdraw' : 'unknown';
    const err = new Error(MESSAGES[kind][l]);
    err.statusCode = kind === 'withdraw' ? 400 : 503;
    err.code = kind === 'withdraw' ? 'KEY_CAN_WITHDRAW' : 'KEY_PERMISSIONS_UNVERIFIED';
    throw err;
  }

  return { check, assertKeyCanBeAdded };
}

let defaultChecker = null;
function defaultKeyPermissionChecker() {
  if (!defaultChecker) defaultChecker = createKeyPermissionChecker();
  return defaultChecker;
}
/** tests: route the key-add gate through a checker over recorded responses (null → default). */
function setDefaultKeyPermissionChecker(checker) {
  defaultChecker = checker;
}

module.exports = {
  createKeyPermissionChecker, defaultKeyPermissionChecker, setDefaultKeyPermissionChecker, networkDisabledTransport, MESSAGES, HOSTS,
  BINGX_WITHDRAW_CODE, _verdicts: { bybitVerdict, binanceVerdict, okxVerdict, bingxVerdict },
  _requests: { bybitRequest, binanceRequest, okxRequest, bingxRequest },
};
