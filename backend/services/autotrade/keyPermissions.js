'use strict';
/**
 * keyPermissions.js — SITE DECISION D15 (docs/PORT_DECISIONS.md; the landing's security section
 * promises it): an exchange API key that can WITHDRAW funds is never stored. On every key add the
 * exchange's own key-permission endpoint is asked; a withdrawal-capable key is refused, and so is a
 * key whose permissions could not be determined (fail-closed: network error, timeout, HTTP error,
 * unparsable / unexpected body, API error code). The bot only warns in its setup texts ("Без
 * Withdraw!") and stores any key that tests OK.
 *
 * The one implementation behind both key-add paths — POST /api/app/exchange/keys
 * (services/exchangeKeysService.connectKeys, after the bot's test_connection) and the account page's
 * POST /api/exchanges/keys (routes/exchanges.js). Each read is signed by the trader's own request
 * code, i.e. byte for byte what the bot's signing builds for that endpoint
 * (tests/autotrade/ops/d15.test.js pins the wire against the bot):
 *
 *   bybit    GET  <api|api-demo>.bybit.com/v5/user/query-api   (pybit get_api_key_information)
 *            result.permissions {group: [names]} — any name /withdraw/i (Wallet: "Withdraw") → withdraw;
 *            a group that is null counts as empty; a group that is not a list, or a non-string name → unknown
 *   bingx    GET  open-api.bingx.com/openApi/v1/account/apiPermissions (signed like every BingX call)
 *            data.permissions [codes]: 5 = Withdraw (also "5" / names /withdraw/i); other entry types → unknown
 *   binance  GET  api.binance.com/sapi/v1/account/apiRestrictions (HMAC query, X-MBX-APIKEY); HTTP 200 only
 *            enableWithdrawals: true → withdraw, false → ok, anything else → unknown
 *   okx      GET  www.okx.com/api/v5/account/config (demo key: x-simulated-trading) — code "0" and
 *            data[0].perm a non-empty string "read_only,trade[,withdraw]"; any part containing "withdraw" → withdraw
 *
 *   checkPermissions(exchange, {apiKey, apiSecret, passphrase, demo}, {registry, timeoutS, log})
 *       → {verdict: 'ok' | 'withdraw' | 'unknown', reason}   (never throws; 8 s budget)
 *   createKeyPermissionChecker({transport, now, sleep, log, registry}) → {
 *     check({exchange, apiKey, apiSecret, passphrase, testnet}) → the verdict
 *     assertKeyCanBeAdded(input, {lang}) → throws {statusCode 400 KEY_CAN_WITHDRAW | 503 KEY_PERMISSIONS_UNVERIFIED,
 *                                          message (ru | en)} unless 'ok'
 *   }
 *   MESSAGES — the refusal texts (ru / en) of both paths.
 *
 * No request goes out without a key and a secret (and the OKX passphrase). Secrets never leave this
 * module except inside the signed request; nothing here logs a key, a secret, a passphrase or a
 * signature. Under NODE_ENV=test / vitest the default transport refuses to open connections (tests
 * inject recorded responses), which makes every check `unknown`.
 */

const { TransportError, fetchTransport, parseJsonPy } = require('../exchanges/transport');

const PERMISSION_TIMEOUT_S = 8;          // keeps the app's key-add request under its 30 s client timeout
const BINANCE_SAPI_URL = 'https://api.binance.com';
const BINGX_WITHDRAW_CODE = 5;           // BingX api permission codes: 1 spot, 2 read, 3 perpetual, 4 universal transfer, 5 withdraw
const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);

const MESSAGES = Object.freeze({
  withdraw: Object.freeze({
    ru: 'Ключ с правом вывода средств не принимается. Создайте на бирже новый API-ключ без права вывода (только торговля фьючерсами) и подключите его.',
    en: 'A key with withdrawal permission is not accepted. Create a new API key on the exchange without withdrawal permission (futures trading only) and connect it.',
  }),
  unknown: Object.freeze({
    ru: 'Не удалось проверить права ключа на бирже — ключ не сохранён. Попробуйте ещё раз через минуту.',
    en: 'Could not check the key permissions on the exchange — the key was not saved. Try again in a minute.',
  }),
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const WITHDRAW_RE = /withdraw/i;

// ── verdicts (anything but a clear "no withdrawals" is unknown) ──────────

/** Bybit /v5/user/query-api answer → verdict. */
function bybitVerdict(resp) {
  if (!isObj(resp) || resp.retCode !== 0) return { verdict: 'unknown', reason: 'retCode' };
  const res = resp.result;
  if (!isObj(res) || !isObj(res.permissions)) return { verdict: 'unknown', reason: 'no permissions' };
  for (const names of Object.values(res.permissions)) {
    if (names === null) continue;   // an empty group
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) return { verdict: 'unknown', reason: 'permissions shape' };
    if (names.some((n) => WITHDRAW_RE.test(n))) return { verdict: 'withdraw', reason: 'Withdraw' };
  }
  return { verdict: 'ok', reason: '' };
}

/** BingX /openApi/v1/account/apiPermissions answer → verdict. */
function bingxVerdict(resp) {
  if (!isObj(resp) || resp.code !== 0) return { verdict: 'unknown', reason: 'code' };
  const data = resp.data;
  if (!isObj(data) || !Array.isArray(data.permissions)) return { verdict: 'unknown', reason: 'no permissions' };
  for (const p of data.permissions) {
    if (typeof p === 'number') {
      if (p === BINGX_WITHDRAW_CODE) return { verdict: 'withdraw', reason: '5' };
    } else if (typeof p === 'string') {
      if (p.trim() === String(BINGX_WITHDRAW_CODE) || WITHDRAW_RE.test(p)) return { verdict: 'withdraw', reason: 'withdraw' };
    } else {
      return { verdict: 'unknown', reason: 'permissions shape' };
    }
  }
  return { verdict: 'ok', reason: '' };
}

/** Binance /sapi/v1/account/apiRestrictions answer → verdict. */
function binanceVerdict(resp) {
  if (!isObj(resp)) return { verdict: 'unknown', reason: 'shape' };
  if (resp.enableWithdrawals === true) return { verdict: 'withdraw', reason: 'enableWithdrawals' };
  if (resp.enableWithdrawals === false) return { verdict: 'ok', reason: '' };
  return { verdict: 'unknown', reason: 'no enableWithdrawals' };
}

/** OKX /api/v5/account/config answer → verdict. */
function okxVerdict(resp) {
  if (!isObj(resp) || resp.code !== '0' || !Array.isArray(resp.data) || !resp.data.length) return { verdict: 'unknown', reason: 'code' };
  const perm = isObj(resp.data[0]) ? resp.data[0].perm : undefined;
  if (typeof perm !== 'string' || !perm.trim()) return { verdict: 'unknown', reason: 'no perm' };
  const parts = perm.split(',').map((s) => s.trim().toLowerCase());
  if (parts.some((p) => p.includes('withdraw'))) return { verdict: 'withdraw', reason: 'withdraw' };
  return { verdict: 'ok', reason: '' };
}

const verdicts = Object.freeze({ bybitVerdict, bingxVerdict, binanceVerdict, okxVerdict });

// ── the reads (the trader's own signing) ─────────────────────────────────

function timeoutError() {
  const e = new Error('');
  e.name = 'TimeoutError';
  e.isTimeout = true;
  return e;
}

/** asyncio.wait_for(work(), timeout): timeout <= 0 never starts the work (no request goes out). */
function waitFor(work, timeoutS) {
  if (!(timeoutS > 0)) return Promise.reject(timeoutError());
  return new Promise((resolve, reject) => {
    let done = false;
    const h = setTimeout(() => { if (!done) { done = true; reject(timeoutError()); } }, timeoutS * 1000);
    if (h && h.unref) h.unref();
    Promise.resolve().then(work).then(
      (v) => { if (!done) { done = true; clearTimeout(h); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(h); reject(e); } },
    );
  });
}

/** Binance: a signed GET on the spot API host with the trader's own signing (timestamp offset, recvWindow). */
async function binanceRestrictions(inst, key, secret, timeoutS) {
  const [qs, headers] = inst._buildQuery(key, secret, {});
  const resp = await inst.rt.transport({
    method: 'GET', url: `${BINANCE_SAPI_URL}/sapi/v1/account/apiRestrictions?${qs}`, headers, timeoutMs: timeoutS * 1000,
  });
  // fail-closed: only a 200 answer counts (an error page never reads as "no withdrawals")
  if (Number(resp.status) !== 200) {
    const e = new Error(`HTTP ${resp.status}`);
    e.pyType = 'HTTPError';
    throw e;
  }
  return parseJsonPy(resp.text);
}

/**
 * checkPermissions(ex, {apiKey, apiSecret, passphrase, demo}, {registry, timeoutS}) → {verdict, reason}.
 * Any error, timeout or unexpected answer → 'unknown' (the caller refuses the key).
 */
async function checkPermissions(exchange, creds = {}, deps = {}) {
  const ex = String(exchange || '').toLowerCase();
  if (!EXCHANGES.includes(ex)) return { verdict: 'unknown', reason: 'exchange' };
  const key = creds.apiKey ? String(creds.apiKey) : '';
  const secret = creds.apiSecret ? String(creds.apiSecret) : '';
  const passphrase = creds.passphrase ? String(creds.passphrase) : '';
  if (!key || !secret) return { verdict: 'unknown', reason: 'missing key or secret' };
  if (ex === 'okx' && !passphrase) return { verdict: 'unknown', reason: 'missing passphrase' };
  const timeoutS = deps.timeoutS === undefined || deps.timeoutS === null ? PERMISSION_TIMEOUT_S : deps.timeoutS;
  const exchanges = require('../exchanges');
  const inst = (demo) => exchanges.getTrader(ex, { registry: deps.registry || undefined }).instance({ demo });
  const run = async () => {
    if (ex === 'bybit') {
      const session = inst(false)._getSession(key, secret, Boolean(creds.demo));
      return bybitVerdict(await session._submit('GET', `${session.endpoint}/v5/user/query-api`, {}, true));
    }
    if (ex === 'bingx') return bingxVerdict(await inst(false)._request('GET', '/openApi/v1/account/apiPermissions', key, secret));
    if (ex === 'binance') return binanceVerdict(await binanceRestrictions(inst(false), key, secret, timeoutS));
    return okxVerdict(await inst(Boolean(creds.demo))._request('GET', '/api/v5/account/config', key, secret, passphrase));
  };
  try {
    return await waitFor(run, timeoutS);
  } catch (e) {
    return { verdict: 'unknown', reason: e && e.isTimeout ? 'timeout' : String((e && (e.pyType || e.name)) || 'error') };
  }
}

// ── the account page's checker (routes/exchanges.js) ─────────────────────

function networkDisabledTransport() {
  return async () => { throw new TransportError('connect', 'network disabled under NODE_ENV=test'); };
}

/** Tests (NODE_ENV=test or under vitest) never reach an exchange: the default transport refuses. */
function defaultPermissionTransport() {
  const testing = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  return testing ? networkDisabledTransport() : fetchTransport();
}

function createKeyPermissionChecker({ transport = null, now = null, sleep = null, log = null, registry = null } = {}) {
  const logger = log || require('../marketData/mdLog').log;
  let reg = registry;
  const registryOf = () => {
    if (!reg) {
      const overrides = { transport: transport || defaultPermissionTransport(), log: logger };
      if (now) overrides.now = now;
      if (sleep) overrides.sleep = sleep;
      reg = require('../exchanges').createRegistry({ overrides });
    }
    return reg;
  };

  /** input: the key-add body {exchange, apiKey, apiSecret, passphrase, testnet} (testnet → the demo host). */
  async function check({ exchange, apiKey, apiSecret, passphrase = null, testnet = false } = {}) {
    return checkPermissions(exchange, { apiKey, apiSecret, passphrase, demo: Boolean(testnet) }, { registry: registryOf() });
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
  PERMISSION_TIMEOUT_S, BINANCE_SAPI_URL, BINGX_WITHDRAW_CODE, MESSAGES, verdicts,
  checkPermissions, createKeyPermissionChecker, defaultKeyPermissionChecker, setDefaultKeyPermissionChecker,
  networkDisabledTransport, waitFor,
  _verdicts: verdicts,
};
