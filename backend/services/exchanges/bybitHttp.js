'use strict';
/**
 * bybitHttp.js — the pybit 5.14.0 `unified_trading.HTTP` client the bot drives Bybit with,
 * reproduced request-for-request on the injectable transport.
 *
 * Wire format (pybit `_V5HTTPManager`):
 *   GET  query  = "&".join(f"{k}={v}" for k, v in sorted(params) if v is not None)  (NOT url-encoded)
 *   POST body   = json.dumps(params) after cast_values (qty/price/triggerPrice/takeProfit/stopLoss
 *                 → str, positionIdx → int); integral floats were already turned into ints
 *   sign        = HMAC-SHA256(secret, f"{timestamp}{api_key}{recv_window}{payload}").hexdigest()
 *   headers     = Content-Type: application/json, X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-SIGN-TYPE: 2,
 *                 X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW
 *   timestamp   = int(time.time() * 1000) — local clock: pybit 5.14 ignores `session.time_offset`
 *                 (the bot sets it, pybit never reads it — quirk reproduced)
 *   host        = api.bybit.com, api-demo.bybit.com when demo=True
 *
 * Errors (exact `str(e)` the bot returns to users):
 *   HTTP ≠ 200             FailedRequestError  "<Message.capitalize()> (ErrCode: <status>) (ErrTime: HH:MM:SS).\nRequest → <METHOD> <url>: <payload>."
 *   retCode ≠ 0            InvalidRequestError "<retMsg> (ErrCode: <code>) (ErrTime: …).\nRequest → …."
 *   retCode in retry codes {10002, 10006, 30034, 30035, 130035, 130150}
 *                          sleep retry_delay (3 s; 10006 → until X-Bapi-Limit-Reset-Timestamp) and
 *                          raise Exception("Retryable error occurred, retrying...") — pybit never
 *                          actually retries (its loop only catches network/JSON errors)
 *   network error          re-raised (force_retry=False)
 *   invalid JSON           FailedRequestError("Conflict. Could not decode JSON.", 409)
 */

const crypto = require('crypto');
const { pyJsonDumps } = require('../engine/pyjson');
const { PyError, pyStr, pyCapitalize, pyStrftimeHMS, isDict, pyGet, pyIndex, pyTruthy, KeyError, ValueError } = require('./pyCompat');
const { parseJsonPy, headerGet, TransportError } = require('./transport');

const HTTP_MAINNET = 'https://api.bybit.com';
const HTTP_DEMO = 'https://api-demo.bybit.com';
const RETRY_CODES = Object.freeze([10002, 10006, 30034, 30035, 130035, 130150]);

const METHODS = Object.freeze({
  place_order: ['POST', '/v5/order/create', true],
  cancel_order: ['POST', '/v5/order/cancel', true],
  get_open_orders: ['GET', '/v5/order/realtime', true],
  cancel_all_orders: ['POST', '/v5/order/cancel-all', true],
  get_positions: ['GET', '/v5/position/list', true],
  set_leverage: ['POST', '/v5/position/set-leverage', true],
  switch_margin_mode: ['POST', '/v5/position/switch-isolated', true],
  set_trading_stop: ['POST', '/v5/position/trading-stop', true],
  get_executions: ['GET', '/v5/execution/list', true],
  get_closed_pnl: ['GET', '/v5/position/closed-pnl', true],
  get_wallet_balance: ['GET', '/v5/account/wallet-balance', true],
  get_instruments_info: ['GET', '/v5/market/instruments-info', false],
  get_tickers: ['GET', '/v5/market/tickers', false],
});

class InvalidRequestError extends PyError {
  constructor({ request, message, statusCode, time }) {
    super('InvalidRequestError', `${pyStr(message)} (ErrCode: ${pyStr(statusCode)}) (ErrTime: ${time}).\nRequest → ${request}.`);
    this.request = request;
    this.retMessage = message;
    this.status_code = statusCode;
    this.time = time;
  }
}

class FailedRequestError extends PyError {
  constructor({ request, message, statusCode, time }) {
    super('FailedRequestError', `${pyCapitalize(message)} (ErrCode: ${pyStr(statusCode)}) (ErrTime: ${time}).\nRequest → ${request}.`);
    this.request = request;
    this.retMessage = message;
    this.status_code = statusCode;
    this.time = time;
  }
}

/**
 * Transport failure → the requests exception pybit lets through (force_retry=False):
 * ReadTimeout for timeouts, ConnectionError otherwise; str(e) = the transport message or
 * a urllib3-style text when the transport gave none.
 */
function requestsError(e, url, timeout) {
  if (!(e instanceof TransportError)) return e;
  // production transport: the exact requests 2.x flavour of the failure (transport.fetchError)
  if (e.requestsMessage !== undefined) {
    return new PyError(e.requestsType || (e.kind === 'timeout' ? 'ReadTimeout' : 'ConnectionError'), e.requestsMessage);
  }
  // scripted transports (replay fixtures) carry str(e) of the requests exception as the message
  // itself — kept verbatim, '' included (requests.ReadTimeout('') prints '')
  void url; void timeout;
  return new PyError(e.kind === 'timeout' ? 'ReadTimeout' : 'ConnectionError', e.message);
}

/** HMAC-SHA256 hex — pybit generate_signature (HMAC mode). */
function bybitSign(secret, paramStr) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(Buffer.from(paramStr, 'utf8')).digest('hex');
}

/** str(v) of a query value the way pybit prints it. */
function qv(v) {
  if (typeof v === 'string') return v;
  return pyStr(v);
}

/** pybit prepare_payload. */
function preparePayload(method, params) {
  if (method === 'GET') {
    return Object.keys(params).sort()
      .filter((k) => params[k] !== null && params[k] !== undefined)
      .map((k) => `${k}=${qv(params[k])}`)
      .join('&');
  }
  const p = { ...params };
  for (const k of Object.keys(p)) {
    if (['qty', 'price', 'triggerPrice', 'takeProfit', 'stopLoss'].includes(k)) {
      if (typeof p[k] !== 'string') p[k] = qv(p[k]);
    } else if (k === 'positionIdx') {
      if (typeof p[k] !== 'number' || !Number.isInteger(p[k])) p[k] = Math.trunc(Number(p[k]));
    }
  }
  return pyJsonDumps(p);
}

/**
 * pybit HTTP session.
 * @param {object} o { apiKey, apiSecret, demo=false, recvWindow=15000, timeout=10, rt }
 */
function createPybitSession({ apiKey, apiSecret, demo = false, recvWindow = 15000, timeout = 10, rt }) {
  const endpoint = demo ? HTTP_DEMO : HTTP_MAINNET;
  const session = {
    endpoint, demo, apiKey, recvWindow,
    time_offset: 0, // set by the bot, ignored by pybit (quirk)
    closed: false,
  };

  async function submit(method, path, query, auth) {
    const params = {};
    for (const k of Object.keys(query || {})) {
      const v = query[k];
      if (v === null || v === undefined) continue;
      params[k] = v; // integral floats are already ints in JS (`_clean_query`)
    }
    const reqParams = preparePayload(method, params);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) {
      if (!apiKey || !apiSecret) throw new PyError('PermissionError', 'Authenticated endpoints require keys.');
      const ts = Math.trunc(rt.now() * 10 ** 3);
      const sign = bybitSign(apiSecret, String(ts) + apiKey + String(recvWindow) + reqParams);
      Object.assign(headers, {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(ts),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
      });
    }
    const url = method === 'GET' && reqParams ? `${path}?${reqParams}` : path;
    const requestDesc = `${method} ${path}: ${reqParams}`;
    // network errors propagate (force_retry=False) as requests exceptions
    let resp;
    try {
      resp = await rt.transport({
        method, url, headers, body: method === 'GET' ? undefined : reqParams, timeoutMs: timeout * 1000,
      });
    } catch (e) {
      throw requestsError(e, url, timeout);
    }
    const errTime = () => pyStrftimeHMS(rt.now());
    if (resp.status !== 200) {
      const msg = resp.status === 403
        ? 'You have breached the IP rate limit or your IP is from the USA.'
        : 'HTTP status code is not 200.';
      throw new FailedRequestError({ request: requestDesc, message: msg, statusCode: resp.status, time: errTime() });
    }
    let sJson;
    try {
      sJson = parseJsonPy(resp.text);
    } catch (_e) {
      throw new FailedRequestError({ request: 'JSON decoding', message: 'Conflict. Could not decode JSON.', statusCode: 409, time: errTime() });
    }
    const code = pyGet(sJson, 'retCode');
    if (pyTruthy(code)) {
      const errorCode = pyIndex(sJson, 'retCode');
      const retMsg = pyIndex(sJson, 'retMsg');
      if (RETRY_CODES.includes(errorCode)) {
        let delay = 3; // retry_delay
        if (errorCode === 10006) {
          const raw = headerGet(resp, 'x-bapi-limit-reset-timestamp');
          if (raw === null) throw KeyError('X-Bapi-Limit-Reset-Timestamp');
          const reset = Math.trunc(Number(raw));
          delay = (reset - Math.trunc(rt.now() * 10 ** 3)) / 10 ** 3;
        }
        rt.log.error(`${pyStr(retMsg)} (ErrCode: ${pyStr(errorCode)}). Retrying...`);
        if (delay < 0) throw ValueError('sleep length must be non-negative');
        await rt.sleep(delay);
        throw new PyError('Exception', 'Retryable error occurred, retrying...');
      }
      throw new InvalidRequestError({ request: requestDesc, message: retMsg, statusCode: errorCode, time: errTime() });
    }
    return sJson;
  }

  for (const [name, [method, path, auth]] of Object.entries(METHODS)) {
    session[name] = (kwargs = {}) => submit(method, `${endpoint}${path}`, kwargs, auth);
  }
  session._submit = submit;
  return session;
}

module.exports = {
  createPybitSession, bybitSign, preparePayload, requestsError, InvalidRequestError, FailedRequestError,
  HTTP_MAINNET, HTTP_DEMO, RETRY_CODES, METHODS, isDict,
};
