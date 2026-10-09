'use strict';
/**
 * sseService — Server-Sent Events registry for `GET /api/app/events` (PLAN §2.4, D2).
 *
 * One process-wide registry userId → Set<client>. A client is an Express/Node response
 * kept open with `text/event-stream`; the service writes the handshake headers
 * (`X-Accel-Buffering: no` so nginx / Passenger do not buffer the stream,
 * `Cache-Control: no-cache, no-transform` so `compression` leaves it alone), a `retry:`
 * hint and a `hello` event, then a comment heartbeat every 25 s so proxies keep the
 * connection alive. `broadcast(userId, event, data)` writes `id / event / data` frames to
 * every open tab of that user; `broadcastAll` to everyone (trend changes).
 *
 * Event names used by the engine: `signal`, `progress`, `trade`, `trend`, `notification`,
 * `payment`, `report`. The SPA keeps the Mini App polling (30 s caches + refresh on
 * visibilitychange) as the baseline, so SSE is a progressive enhancement: a dropped or
 * buffered stream never loses data (D2).
 *
 * Bounds: MAX_CLIENTS_PER_USER (10) streams per user — an 11th drops the oldest (a runaway tab
 * loop never pins unlimited sockets, a fresh tab is never refused); MAX_CLIENTS_TOTAL
 * (SSE_MAX_CLIENTS, default 1000) streams per process — beyond it `GET events` answers 503
 * `{ok: false, error: 'unavailable'}` + Retry-After: 30 (the app then keeps polling and retries).
 * A stream lives no longer than the access token that opened it (`expiresAt`: the JWT `exp`):
 * at expiry the server ends it, the app reconnects with a refreshed token — so a disabled
 * account or a revoked session stops receiving events within one token lifetime; disabling an
 * account (adminService.setUserActive) ends its streams at once (closeUser). HEAD answers the
 * stream headers only. Cleanup is idempotent on close / error / end / a failed write: no timer,
 * listener or registry entry outlives the response.
 *
 * Timers are injectable (`{ setInterval, clearInterval, setTimeout, clearTimeout }`) and the
 * defaults are looked up at call time, so vitest fake timers drive heartbeat and expiry in tests.
 */

const HEARTBEAT_MS = 25_000;
const RETRY_MS = 10_000;
const MAX_CLIENTS_PER_USER = 10;
const MAX_TIMER_MS = 2 ** 31 - 1;
const BUSY_RETRY_S = 30;
const STREAM_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

/** SSE_MAX_CLIENTS: streams per process (a positive integer; default 1000). */
function maxClientsTotal(env = process.env) {
  const n = Number(String(env.SSE_MAX_CLIENTS === undefined ? '' : env.SSE_MAX_CLIENTS).trim());
  return Number.isInteger(n) && n > 0 ? n : 1000;
}
let MAX_CLIENTS_TOTAL = maxClientsTotal();

/** userId (string) → Set<client> */
const registry = new Map();
let nextClientId = 1;
let nextEventId = 1;

function key(userId) { return String(userId); }

/**
 * `data:` lines for a payload (strings as is, everything else JSON). CRLF, LF and a lone CR
 * all end a line in an event stream (WHATWG HTML §9.2.6), so each of them starts a new
 * `data:` line — a bare CR left inside one line would cut the payload on the client.
 */
function dataLines(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
  return text.split(/\r\n|\r|\n/).map((l) => `data: ${l}`).join('\n');
}

/** One SSE frame. */
function frame(event, data, id = null) {
  let out = '';
  if (id !== null && id !== undefined) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  return `${out}${dataLines(data)}\n\n`;
}

function safeWrite(client, chunk) {
  if (client.closed) return false;
  try {
    client.res.write(chunk);
    if (typeof client.res.flush === 'function') client.res.flush();   // compression middleware
    return true;
  } catch (_e) {
    removeClient(client);
    return false;
  }
}

/**
 * Registers an open response for `userId` and performs the handshake.
 * Returns the client handle ({ id, userId, close() }), or null when the response is already
 * gone (closed / ended before the handshake: nothing would ever unregister it).
 *   expiresAt  unix seconds after which the stream is ended (the access token's `exp`)
 *   now        () → unix seconds (default Date.now)
 */
function addClient(userId, res, opts = {}) {
  const {
    heartbeatMs = HEARTBEAT_MS,
    retryMs = RETRY_MS,
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (h) => clearInterval(h),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (h) => clearTimeout(h),
    expiresAt = null,
    now = () => Date.now() / 1000,
    hello = {},
  } = opts;
  if (res.destroyed || res.writableEnded || (res.socket && res.socket.destroyed)) return null;
  if (typeof res.writeHead === 'function' && !res.headersSent) res.writeHead(200, { ...STREAM_HEADERS });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const client = {
    id: nextClientId++, userId: key(userId), res, closed: false, timer: null, expiry: null, clearIntervalFn, clearTimeoutFn,
    close: () => removeClient(client),
  };
  let set = registry.get(client.userId);
  if (!set) { set = new Set(); registry.set(client.userId, set); }
  // a runaway tab loop must not pin unlimited sockets: drop the oldest beyond the cap
  while (set.size >= MAX_CLIENTS_PER_USER) {
    const oldest = set.values().next().value;
    removeClient(oldest, { end: true });
  }
  set.add(client);
  safeWrite(client, `retry: ${retryMs}\n\n`);
  safeWrite(client, frame('hello', { client: client.id, heartbeat_s: heartbeatMs / 1000, ...hello }));
  client.timer = setIntervalFn(() => { safeWrite(client, `: ping ${Date.now()}\n\n`); }, heartbeatMs);
  if (expiresAt !== null && expiresAt !== undefined && Number.isFinite(Number(expiresAt))) {
    const ms = Math.max(0, Math.min(MAX_TIMER_MS, Math.ceil((Number(expiresAt) - now()) * 1000)));
    client.expiry = setTimeoutFn(() => removeClient(client, { end: true }), ms);
  }
  if (typeof res.on === 'function') {
    const gone = () => removeClient(client);
    res.on('close', gone);
    res.on('error', gone);
    client.off = () => {
      if (typeof res.removeListener === 'function') {
        res.removeListener('close', gone);
        res.removeListener('error', gone);
      }
    };
  }
  return client;
}

/** Unregisters a client (idempotent); `end: true` also ends the response. */
function removeClient(client, { end = false } = {}) {
  if (!client || client.closed) return;
  client.closed = true;
  if (client.timer !== null) client.clearIntervalFn(client.timer);
  client.timer = null;
  if (client.expiry !== null) client.clearTimeoutFn(client.expiry);
  client.expiry = null;
  if (client.off) client.off();                     // no listener outlives the stream
  client.off = null;
  const set = registry.get(client.userId);
  if (set) {
    set.delete(client);
    if (!set.size) registry.delete(client.userId);
  }
  if (end) {
    try { client.res.end(); } catch (_e) { /* already gone */ }
  }
}

/** Sends one event to every open stream of the user. Returns the number of streams written. */
function broadcast(userId, event, data) {
  const set = registry.get(key(userId));
  if (!set || !set.size) return 0;
  const chunk = frame(event, data, nextEventId++);
  let n = 0;
  for (const client of Array.from(set)) if (safeWrite(client, chunk)) n++;
  return n;
}

/** Sends one event to every connected user (e.g. a BTC trend change). */
function broadcastAll(event, data) {
  const chunk = frame(event, data, nextEventId++);
  let n = 0;
  for (const set of Array.from(registry.values())) {
    for (const client of Array.from(set)) if (safeWrite(client, chunk)) n++;
  }
  return n;
}

function clientCount(userId = null) {
  if (userId !== null && userId !== undefined) {
    const set = registry.get(key(userId));
    return set ? set.size : 0;
  }
  let n = 0;
  for (const set of registry.values()) n += set.size;
  return n;
}

/** Ends every stream of one user (account disabled). Returns how many were open. */
function closeUser(userId) {
  const set = registry.get(key(userId));
  if (!set) return 0;
  const list = Array.from(set);
  for (const client of list) removeClient(client, { end: true });
  return list.length;
}

/**
 * Express handler for `GET /api/app/events` (mount behind the JWT middleware that sets
 * `req.user.id`; `req.authExp` = the token's `exp`). Keeps the socket open (no request timeout)
 * until the client goes away or the token expires. HEAD → the stream headers, no stream; over
 * MAX_CLIENTS_TOTAL → 503.
 */
function handler(req, res) {
  const uid = req.user && (req.user.id ?? req.user.userId);
  if (!uid) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (req.method === 'HEAD') {
    const { Connection: _keep, ...head } = STREAM_HEADERS;   // the response ends: no keep-alive promise
    res.writeHead(200, head);
    res.end();
    return null;
  }
  if (clientCount() >= MAX_CLIENTS_TOTAL && !clientCount(uid)) {
    res.status(503).set('Retry-After', String(BUSY_RETRY_S)).json({ ok: false, error: 'unavailable' });
    return null;
  }
  if (req.socket && typeof req.socket.setTimeout === 'function') req.socket.setTimeout(0);
  if (req.socket && typeof req.socket.setKeepAlive === 'function') req.socket.setKeepAlive(true);
  return addClient(uid, res, { expiresAt: req.authExp === undefined ? null : req.authExp });
}

/** Closes every stream (shutdown / tests). */
function closeAll() {
  for (const set of Array.from(registry.values())) {
    for (const client of Array.from(set)) removeClient(client, { end: true });
  }
}

function _resetForTests() {
  closeAll();
  registry.clear();
  nextClientId = 1;
  nextEventId = 1;
  MAX_CLIENTS_TOTAL = maxClientsTotal();
}

/** Tests: the process cap (null → SSE_MAX_CLIENTS / 1000). */
function _setMaxClientsTotal(n) { MAX_CLIENTS_TOTAL = n === null || n === undefined ? maxClientsTotal() : n; }

module.exports = {
  HEARTBEAT_MS, RETRY_MS, MAX_CLIENTS_PER_USER, BUSY_RETRY_S, STREAM_HEADERS,
  get MAX_CLIENTS_TOTAL() { return MAX_CLIENTS_TOTAL; },
  maxClientsTotal, addClient, removeClient, broadcast, broadcastAll, clientCount, closeUser, handler, closeAll, frame,
  _resetForTests, _setMaxClientsTotal,
};
