'use strict';
/**
 * transport.js — the injectable HTTP layer of the exchange traders.
 *
 * A transport is `async ({ method, url, headers, body, timeoutMs }) → { status, headers, text }`
 * (`headers` lower-cased). It throws `TransportError` with
 *   kind 'timeout'  — asyncio.TimeoutError / requests ReadTimeout   (str(e) is '' for asyncio)
 *   kind 'connect'  — aiohttp.ClientConnectorError (DNS failure, refused connect)
 *   kind 'error'    — any other client error (str(e) = message): ServerDisconnectedError,
 *                     ClientOSError (reset), ClientPayloadError (truncated body), ...
 * `message` is the aiohttp str(e) (BingX / Binance / OKX / Bybit async helpers); for pybit the
 * requests flavour travels along as `requestsType` / `requestsMessage` (bybitHttp.requestsError).
 * Tests replace it with a scripted fake; production uses `fetchTransport` (Node 22 fetch), whose
 * failure texts are held to the real aiohttp 3.14 / requests 2.x ones by
 * tests/exchanges/netErrors.test.js (fixtures/net_errors.json, py/gen_net_errors.py).
 *
 * `aiohttpJson(resp, { checkContentType })` reproduces aiohttp's `ClientResponse.json()`:
 * content-type check (application/json or application/*+json) unless disabled
 * (`content_type=None`), empty body → null, otherwise json.loads — the parsed value
 * carries its Python repr (pyCompat.attachRepr) so str(response) is byte-exact.
 */

const { attachRepr, reprFromJsonText, PyError } = require('./pyCompat');

class TransportError extends Error {
  /**
   * @param {'timeout'|'connect'|'error'} kind
   * @param {string} [message]  aiohttp str(e)
   * @param {object} [extra]    { pyType, requestsType, requestsMessage } - exact client flavours
   */
  constructor(kind, message = '', extra = {}) {
    super(message);
    this.kind = kind;
    this.pyType = extra.pyType || (kind === 'timeout' ? 'TimeoutError' : (kind === 'connect' ? 'ClientConnectorError' : 'ClientError'));
    this.name = this.pyType;
    if (extra.requestsType) this.requestsType = extra.requestsType;
    if (extra.requestsMessage !== undefined) this.requestsMessage = extra.requestsMessage;
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

// getaddrinfo failures: Node code -> (errno, glibc gai_strerror) as CPython's socket.gaierror shows them
const GAI = {
  ENOTFOUND: [-2, 'Name or service not known'],
  EAI_NONAME: [-2, 'Name or service not known'],
  EAI_AGAIN: [-3, 'Temporary failure in name resolution'],
  EAI_FAIL: [-4, 'Non-recoverable failure in name resolution'],
  EAI_NODATA: [-5, 'No address associated with hostname'],
};
// connect(2) failures: Node code -> (errno, strerror)
const CONNECT_ERRNO = {
  ECONNREFUSED: [111, 'Connection refused'],
  EHOSTUNREACH: [113, 'No route to host'],
  ENETUNREACH: [101, 'Network is unreachable'],
  ETIMEDOUT: [110, 'Connection timed out'],
};

function urlParts(url) {
  try {
    const u = new URL(url);
    const https = u.protocol === 'https:';
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : (https ? 443 : 80), https, path: `${u.pathname || '/'}${u.search}` };
  } catch (_e) {
    return { host: '', port: 443, https: true, path: '' };
  }
}

/** Python repr of a socket address tuple (asyncio "Connect call failed (...)"). */
function pyAddr(address, port) {
  return String(address).includes(':') ? `('${address}', ${port}, 0, 0)` : `('${address}', ${port})`;
}

/** Python repr of a short str (single quotes unless the text holds one and no double quote). */
function pyStrRepr(s) {
  if (s.includes("'") && !s.includes('"')) return `"${s.replace(/\\/g, '\\\\')}"`;
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** str() of the timeout in seconds as the bot passes it (pybit: int 10 -> "10"). */
function pySeconds(ms) {
  return String(ms / 1000);
}

/**
 * undici fetch rejection -> TransportError carrying the aiohttp 3.14 and requests 2.x texts the bot
 * would have seen for the same failure (verified against the real libraries, py/gen_net_errors.py).
 */
function fetchError(e, url, timeoutMs) {
  const p = urlParts(url);
  const scheme = p.https ? 'HTTPS' : 'HTTP';
  const pool = `${scheme}ConnectionPool(host='${p.host}', port=${p.port})`;
  const conn = `${scheme}Connection(host='${p.host}', port=${p.port})`;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    // aiohttp: asyncio.TimeoutError (str ''); requests: ReadTimeout
    return new TransportError('timeout', '', {
      requestsType: 'ReadTimeout', requestsMessage: `${pool}: Read timed out. (read timeout=${pySeconds(timeoutMs)})`,
    });
  }
  let cause = e && e.cause;
  if (cause && Array.isArray(cause.errors) && cause.errors.length) cause = cause.errors[0]; // happy-eyeballs AggregateError
  const code = cause && (cause.code || cause.errno);
  if (GAI[code]) {
    const [errno, msg] = GAI[code];
    return new TransportError('connect', `Cannot connect to host ${p.host}:${p.port} ssl:default [${msg}]`, {
      pyType: 'ClientConnectorDNSError',
      requestsType: 'ConnectionError',
      requestsMessage: `${pool}: Max retries exceeded with url: ${p.path} (Caused by NameResolutionError("${conn}: Failed to resolve '${p.host}' ([Errno ${errno}] ${msg})"))`,
    });
  }
  if (CONNECT_ERRNO[code] && (!cause.syscall || cause.syscall === 'connect')) {
    const [errno, msg] = CONNECT_ERRNO[code];
    const addr = pyAddr(cause.address || p.host, cause.port || p.port);
    return new TransportError('connect', `Cannot connect to host ${p.host}:${p.port} ssl:default [Connect call failed ${addr}]`, {
      requestsType: 'ConnectionError',
      requestsMessage: `${pool}: Max retries exceeded with url: ${p.path} (Caused by NewConnectionError("${conn}: Failed to establish a new connection: [Errno ${errno}] ${msg}"))`,
    });
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') {
    // aiohttp ConnectionTimeoutError is an asyncio.TimeoutError -> the traders' timeout branches
    return new TransportError('timeout', `Connection timeout to host ${url}`, {
      pyType: 'ConnectionTimeoutError', requestsType: 'ConnectTimeout',
      requestsMessage: `${pool}: Max retries exceeded with url: ${p.path} (Caused by ConnectTimeoutError('Connection to ${p.host} timed out. (connect timeout=${pySeconds(timeoutMs)})'))`,
    });
  }
  if (code === 'ECONNRESET') {
    return new TransportError('error', '[Errno 104] Connection reset by peer', {
      pyType: 'ClientOSError', requestsType: 'ConnectionError',
      requestsMessage: "('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))",
    });
  }
  if (code === 'UND_ERR_SOCKET' && cause.message === 'other side closed') {
    return new TransportError('error', 'Server disconnected', {
      pyType: 'ServerDisconnectedError', requestsType: 'ConnectionError',
      requestsMessage: "('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))",
    });
  }
  const msg = String((cause && cause.message) || (e && e.message) || e);
  return new TransportError('error', msg, { requestsType: 'ConnectionError', requestsMessage: `('Connection aborted.', ${pyStrRepr(msg)})` });
}

/** Body cut short after the headers (aiohttp ClientPayloadError / requests ChunkedEncodingError). */
function payloadError(res, received) {
  const cl = res.headers.get('content-length');
  if (cl !== null && /^\d+$/.test(cl)) {
    const total = Number(cl);
    const left = total - received;
    return new TransportError('error', `Response payload is not completed: <ContentLengthError: 400, message='Not enough data to satisfy content length header (received ${received} of ${total} bytes).'>`, {
      pyType: 'ClientPayloadError', requestsType: 'ChunkedEncodingError',
      requestsMessage: `('Connection broken: IncompleteRead(${received} bytes read, ${left} more expected)', IncompleteRead(${received} bytes read, ${left} more expected))`,
    });
  }
  return new TransportError('error', "Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>", {
    pyType: 'ClientPayloadError', requestsType: 'ChunkedEncodingError', requestsMessage: 'Response ended prematurely',
  });
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
      throw fetchError(e, url, timeoutMs);
    }
    // read the body chunk by chunk so a truncated payload reports what arrived (as aiohttp does)
    const chunks = [];
    let received = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          received += value.byteLength;
        }
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw fetchError(e, url, timeoutMs);
        throw payloadError(res, received);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8'); // Python bytes.decode('utf-8'): a BOM is kept
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

module.exports = {
  TransportError, aiohttpJson, parseJsonPy, headerGet, fetchTransport, defaultTransport, wireHeaders, fetchError, payloadError, JSON_CT_RE,
};
