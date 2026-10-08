'use strict';
/**
 * transport.js — the injectable HTTP layer of the exchange traders.
 *
 * A transport is `async ({ method, url, headers, body, timeoutMs }) → { status, headers, text }`
 * (`headers` lower-cased). It throws `TransportError` with
 *   kind 'timeout'  — asyncio.TimeoutError / requests ReadTimeout   (str(e) is '' for asyncio)
 *   kind 'connect'  — aiohttp.ClientConnectorError / socket.gaierror / requests ConnectionError
 *   kind 'error'    — any other client error (str(e) = message)
 * Tests replace it with a scripted fake; production uses `fetchTransport` (Node 22 fetch).
 *
 * `aiohttpJson(resp, { checkContentType })` reproduces aiohttp's `ClientResponse.json()`:
 * content-type check (application/json or application/*+json) unless disabled
 * (`content_type=None`), empty body → null, otherwise json.loads — the parsed value
 * carries its Python repr (pyCompat.attachRepr) so str(response) is byte-exact.
 */

const { attachRepr, reprFromJsonText, PyError } = require('./pyCompat');

class TransportError extends Error {
  constructor(kind, message = '') {
    super(message);
    this.kind = kind;
    this.pyType = kind === 'timeout' ? 'TimeoutError' : (kind === 'connect' ? 'ClientConnectorError' : 'ClientError');
    this.name = this.pyType;
  }
  toString() { return this.message; }
}

const JSON_CT_RE = /^application\/(?:[\w.+-]+?\+)?json/;

function headerGet(resp, name) {
  const h = resp.headers || {};
  const v = h[name.toLowerCase()];
  return v === undefined ? null : v;
}

/**
 * json.loads → JS value with the Python repr attached (null for 'null').
 * Integers beyond 2^53 (BingX int64 order ids) become their exact decimal STRING: Python
 * keeps them as exact ints and the traders only ever str() / compare them.
 */
function bigIntReviver(_k, v, ctx) {
  if (typeof v === 'number' && !Number.isSafeInteger(v) && Number.isInteger(v) && ctx && typeof ctx.source === 'string' && /^-?\d+$/.test(ctx.source)) {
    return ctx.source;
  }
  return v;
}

function parseJsonPy(text) {
  const value = JSON.parse(text, bigIntReviver);
  try { attachRepr(value, reprFromJsonText(text)); } catch (_e) { /* keep generic repr */ }
  return value;
}

/**
 * aiohttp ClientResponse.json(). Throws PyError('ContentTypeError' | 'JSONDecodeError').
 */
function aiohttpJson(resp, { checkContentType = true } = {}) {
  if (checkContentType) {
    // aiohttp 3.14: the whole Content-Type header, lower-cased ('' when missing)
    const ct = String(headerGet(resp, 'content-type') || '').toLowerCase();
    if (!JSON_CT_RE.test(ct)) {
      throw new PyError('ContentTypeError', `${resp.status}, message='Attempt to decode JSON with unexpected mimetype: ${ct}', url='${resp.url || ''}'`);
    }
  }
  const stripped = String(resp.text ?? '').trim();
  if (!stripped) return null;
  try {
    return parseJsonPy(stripped);
  } catch (_e) {
    throw new PyError('JSONDecodeError', 'Expecting value: line 1 column 1 (char 0)');
  }
}

const AIOHTTP_POST_METHODS = new Set(['PATCH', 'POST', 'PUT']);

/**
 * Header fields the bot's HTTP client adds on its own and Node fetch does not.
 *
 * aiohttp 3.14 ClientRequest.send: "set default content-type" — a PATCH/POST/PUT that carries
 * no Content-Type goes out with `Content-Type: application/octet-stream` (BingX / Binance POSTs
 * sign the query string and send no body, so every one of them carries it on the wire). Node
 * fetch sends no Content-Type for a body-less POST. pybit (requests) always sets its own
 * Content-Type, and every other trader request either has one or is a GET/DELETE, so this is
 * the only gap (verified by tests/exchanges/adversarial.test.js against the real aiohttp).
 */
function wireHeaders(method, headers) {
  const out = { ...(headers || {}) };
  if (AIOHTTP_POST_METHODS.has(String(method).toUpperCase())
      && !Object.keys(out).some((k) => k.toLowerCase() === 'content-type')) {
    out['Content-Type'] = 'application/octet-stream';
  }
  return out;
}

/** Production transport on global fetch (AbortSignal timeout). */
function fetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async ({ method, url, headers = {}, body = undefined, timeoutMs = 15000 }) => {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: wireHeaders(method, headers),
        body: body === undefined || body === null ? undefined : body,
        signal: globalThis.AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new TransportError('timeout', '');
      const cause = e && e.cause;
      const code = cause && (cause.code || cause.errno);
      if (code && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        let host = '';
        try { host = new URL(url).host; } catch (_e) { /* ignore */ }
        throw new TransportError('connect', `Cannot connect to host ${host}:443 ssl:default [${code}]`);
      }
      throw new TransportError('error', String((cause && cause.message) || (e && e.message) || e));
    }
    const text = await res.text();
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
    return { status: res.status, headers: hdrs, text, url };
  };
}

let _default = null;
function defaultTransport() {
  if (!_default) _default = fetchTransport();
  return _default;
}

module.exports = { TransportError, aiohttpJson, parseJsonPy, headerGet, fetchTransport, defaultTransport, wireHeaders, JSON_CT_RE };
