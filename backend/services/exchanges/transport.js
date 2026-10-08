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

/** json.loads → JS value with the Python repr attached (null for 'null'). */
function parseJsonPy(text) {
  const value = JSON.parse(text);
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

/** Production transport on global fetch (AbortSignal timeout). */
function fetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  return async ({ method, url, headers = {}, body = undefined, timeoutMs = 15000 }) => {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
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

module.exports = { TransportError, aiohttpJson, parseJsonPy, headerGet, fetchTransport, defaultTransport, JSON_CT_RE };
