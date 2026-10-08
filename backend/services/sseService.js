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
 * Timers are injectable (`{ setInterval, clearInterval }`) and the defaults are looked up
 * at call time, so vitest fake timers drive the heartbeat in tests.
 */

const HEARTBEAT_MS = 25_000;
const RETRY_MS = 10_000;
const MAX_CLIENTS_PER_USER = 10;

/** userId (string) → Set<client> */
const registry = new Map();
let nextClientId = 1;
let nextEventId = 1;

function key(userId) { return String(userId); }

/** `data:` lines for a payload (strings as is, everything else JSON). */
function dataLines(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
  return text.split(/\r?\n/).map((l) => `data: ${l}`).join('\n');
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
 * Returns the client handle ({ id, userId, close() }).
 */
function addClient(userId, res, opts = {}) {
  const {
    heartbeatMs = HEARTBEAT_MS,
    retryMs = RETRY_MS,
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearIntervalFn = (h) => clearInterval(h),
    hello = {},
  } = opts;
  if (typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const client = {
    id: nextClientId++, userId: key(userId), res, closed: false, timer: null, clearIntervalFn,
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
  if (typeof res.on === 'function') {
    res.on('close', () => removeClient(client));
    res.on('error', () => removeClient(client));
  }
  return client;
}

/** Unregisters a client (idempotent); `end: true` also ends the response. */
function removeClient(client, { end = false } = {}) {
  if (!client || client.closed) return;
  client.closed = true;
  if (client.timer !== null) client.clearIntervalFn(client.timer);
  client.timer = null;
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

/**
 * Express handler for `GET /api/app/events` (mount behind the JWT middleware that sets
 * `req.user.id`). Keeps the socket open (no request timeout) until the client goes away.
 */
function handler(req, res) {
  const uid = req.user && (req.user.id ?? req.user.userId);
  if (!uid) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (req.socket && typeof req.socket.setTimeout === 'function') req.socket.setTimeout(0);
  if (req.socket && typeof req.socket.setKeepAlive === 'function') req.socket.setKeepAlive(true);
  return addClient(uid, res);
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
}

module.exports = {
  HEARTBEAT_MS, RETRY_MS, MAX_CLIENTS_PER_USER,
  addClient, removeClient, broadcast, broadcastAll, clientCount, handler, closeAll, frame,
  _resetForTests,
};
