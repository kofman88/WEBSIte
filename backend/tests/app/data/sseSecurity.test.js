/**
 * GET /api/app/events — robustness and auth of the live stream behind the real server stack
 * (helmet, cors, compression, the /api/app transport, the JWT envelope):
 *   • no compression / buffering by the app itself: with Accept-Encoding: gzip the stream stays
 *     identity-encoded and `retry:` + `hello` arrive at once (X-Accel-Buffering: no for nginx /
 *     Passenger, Cache-Control no-transform for compression proxies, flush after every frame);
 *   • HEAD answers the stream headers and ends, nothing is registered;
 *   • a disabled account (403 envelope with its code), a token of a removed user (401);
 *   • the stream ends when the access token that opened it expires; disabling the account ends it at once;
 *   • caps: 10 per user (oldest dropped), SSE_MAX_CLIENTS per process (503 + Retry-After, the
 *     users already connected keep their slot);
 *   • 10 000 connect / disconnect cycles leave no client, timer or listener behind (unit level) and
 *     10 000 real HTTP cycles return the registry, the server and the process timers to baseline.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('sse-security');

let db; let app; let authService; let sse; let server; let port; let jwt; let config;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  authService = nodeRequire('../../../services/authService.js');
  sse = nodeRequire('../../../services/sseService.js');
  jwt = nodeRequire('jsonwebtoken');
  config = nodeRequire('../../../config/index.js');
  for (const uid of [601, 602, 603, 604, 605]) insertUser(db, uid);
  for (let uid = 800; uid < 900; uid++) insertUser(db, uid);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterEach(() => {
  sse._setMaxClientsTotal(null);
  vi.useRealTimers();
  sse.closeAll();
});

afterAll(async () => {
  sse.closeAll();
  await new Promise((r) => server.close(r));
});

const tok = (uid) => authService._signAccessToken(uid);
const turn = () => new Promise((r) => setImmediate(r));
async function drained(pred, n = 4000) {
  for (let i = 0; i < n && !pred(); i++) await turn();
  return pred();
}

/** Opens a stream over a raw socket; `text` accumulates; `ended` once the server closes it. */
function openRaw(token, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const st = { sock, text: '', ended: false, waiters: [] };
    sock.setEncoding('latin1');
    sock.on('data', (c) => {
      st.text += c;
      for (const w of st.waiters.slice()) if (w.pred(st.text)) { st.waiters.splice(st.waiters.indexOf(w), 1); w.ok(st.text); }
    });
    sock.on('end', () => { st.ended = true; });
    sock.on('close', () => { st.ended = true; });
    sock.on('error', () => { st.ended = true; });
    // the server ended the response: the chunked terminator (keep-alive: the socket stays open)
    st.done = () => st.ended || /\r\n0\r\n\r\n$/.test(st.text);
    st.until = (pred) => (pred(st.text) ? Promise.resolve(st.text) : new Promise((ok) => st.waiters.push({ pred, ok })));
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    sock.write(`GET /api/app/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n${extra}\r\n`, () => resolve(st));
    sock.on('error', reject);
  });
}

describe('stream transport', () => {
  it('Accept-Encoding: gzip — not compressed, retry + hello flushed at once, X-Accel-Buffering: no', async () => {
    const s = await openRaw(tok(601), { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    await s.until((t) => t.includes('event: hello'));
    const head = s.text.slice(0, s.text.indexOf('\r\n\r\n')).toLowerCase();
    expect(head).toMatch(/^http\/1\.1 200 ok/);
    expect(head).not.toMatch(/content-encoding/);
    expect(head).toMatch(/\r\nx-accel-buffering: no/);
    expect(head).toMatch(/\r\ncache-control: no-cache, no-transform/);
    expect(head).toMatch(/\r\ncontent-type: text\/event-stream; charset=utf-8/);
    // chunked framing: the hello frame is on the wire while the response is still open
    expect(s.ended).toBe(false);
    expect(s.text).toContain('retry: 10000');
    sse.broadcast(601, 'signal', { trade_id: 'x' });
    await s.until((t) => t.includes('event: signal'));
    s.sock.destroy();
    expect(await drained(() => sse.clientCount(601) === 0)).toBe(true);
  });

  it('HEAD: the stream headers only, the response ends, nothing registered', async () => {
    const r = await rawRequest(port, { method: 'HEAD', target: '/api/app/events', headers: { Authorization: `Bearer ${tok(601)}` } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(r.headers['x-accel-buffering']).toBe('no');
    expect(r.text).toBe('');
    expect(sse.clientCount()).toBe(0);
  });
});

describe('stream auth', () => {
  it('401 without / with a bad token, 403 envelope for a disabled account, 401 for a removed user', async () => {
    for (const h of [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${tok(601)}x` }]) {
      const r = await rawRequest(port, { method: 'GET', target: '/api/app/events', headers: h });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'unauthorized' });
    }
    db.prepare('UPDATE users SET is_active = 0 WHERE id = 605').run();
    const r = await rawRequest(port, { method: 'GET', target: '/api/app/events', headers: { Authorization: `Bearer ${tok(605)}` } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'unauthorized', code: 'ACCOUNT_DISABLED' });
    db.prepare('UPDATE users SET is_active = 1 WHERE id = 605').run();
    const ghost = jwt.sign({ uid: 999999 }, config.jwtSecret, { expiresIn: '1h', algorithm: 'HS256' });
    const g = await rawRequest(port, { method: 'GET', target: '/api/app/events', headers: { Authorization: `Bearer ${ghost}` } });
    expect(g.status).toBe(401);
    expect(sse.clientCount()).toBe(0);
  });

  it('the stream ends when its access token expires (the app reconnects with a refreshed one)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const exp = Math.floor(Date.now() / 1000) + 90;
    const short = jwt.sign({ uid: 602, exp }, config.jwtSecret, { algorithm: 'HS256' });
    const s = await openRaw(short);
    await s.until((t) => t.includes('event: hello'));
    expect(sse.clientCount(602)).toBe(1);
    vi.advanceTimersByTime(60_000);
    await turn();
    expect(s.ended).toBe(false);
    vi.advanceTimersByTime(31_000);
    expect(sse.clientCount(602)).toBe(0);
    vi.useRealTimers();
    // a clean end (the 0-terminator of the chunked body), not a reset: the app's reader sees `done`
    expect(await drained(() => s.done())).toBe(true);
    s.sock.destroy();
  });

  it('disabling the account (admin) ends its streams at once', async () => {
    const s1 = await openRaw(tok(603));
    const s2 = await openRaw(tok(603));
    const other = await openRaw(tok(604));
    await Promise.all([s1, s2, other].map((s) => s.until((t) => t.includes('event: hello'))));
    nodeRequire('../../../services/adminService.js').setUserActive(603, false, { adminId: 601 });
    expect(sse.clientCount(603)).toBe(0);
    expect(sse.clientCount(604)).toBe(1);
    expect(await drained(() => s1.done() && s2.done())).toBe(true);
    expect(other.done()).toBe(false);
    s1.sock.destroy();
    s2.sock.destroy();
    db.prepare('UPDATE users SET is_active = 1 WHERE id = 603').run();
    other.sock.destroy();
    expect(await drained(() => sse.clientCount() === 0)).toBe(true);
  });
});

describe('caps', () => {
  it('per process: SSE_MAX_CLIENTS streams, then 503 + Retry-After for a new user; a connected user keeps a slot', async () => {
    sse._setMaxClientsTotal(2);
    const a = await openRaw(tok(601));
    const b = await openRaw(tok(602));
    await Promise.all([a, b].map((s) => s.until((t) => t.includes('event: hello'))));
    const r = await rawRequest(port, { method: 'GET', target: '/api/app/events', headers: { Authorization: `Bearer ${tok(604)}` } });
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('30');
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'unavailable' });
    const a2 = await openRaw(tok(601));                 // a second tab of a connected user
    await a2.until((t) => t.includes('event: hello'));
    expect(sse.clientCount(601)).toBe(2);
    for (const s of [a, b, a2]) s.sock.destroy();
    expect(await drained(() => sse.clientCount() === 0)).toBe(true);
    expect(sse.maxClientsTotal({})).toBe(1000);
    expect(sse.maxClientsTotal({ SSE_MAX_CLIENTS: '250' })).toBe(250);
    expect(sse.maxClientsTotal({ SSE_MAX_CLIENTS: '0' })).toBe(1000);
    expect(sse.maxClientsTotal({ SSE_MAX_CLIENTS: 'x' })).toBe(1000);
  });

  it('per user: an 11th tab ends the oldest stream', async () => {
    const tabs = [];
    for (let i = 0; i < sse.MAX_CLIENTS_PER_USER + 1; i++) {
      const s = await openRaw(tok(601));
      await s.until((t) => t.includes('event: hello'));
      tabs.push(s);
    }
    expect(sse.clientCount(601)).toBe(sse.MAX_CLIENTS_PER_USER);
    expect(await drained(() => tabs[0].done())).toBe(true);
    expect(tabs.slice(1).every((s) => !s.done())).toBe(true);
    for (const s of tabs) s.sock.destroy();
    expect(await drained(() => sse.clientCount() === 0)).toBe(true);
  });
});

describe('no leak over connect / disconnect cycles', () => {
  function fakePair(uid, exp) {
    const res = new EventEmitter();
    res.headersSent = false;
    res.writeHead = () => { res.headersSent = true; };
    res.write = () => true;
    res.end = () => { res.writableEnded = true; };
    res.status = () => res;
    res.set = () => res;
    res.json = () => res;
    const socket = { setTimeout() {}, setKeepAlive() {} };
    return { req: { method: 'GET', user: { id: uid }, socket, authExp: exp }, res };
  }

  it('10 000 cycles through the handler: no client, timer or listener left', () => {
    vi.useFakeTimers();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const base = vi.getTimerCount();
    for (let i = 0; i < 10_000; i++) {
      const { req, res } = fakePair(700 + (i % 37), exp);
      const c = sse.handler(req, res);
      expect(c).not.toBe(null);
      if (i % 3 === 0) res.emit('close');
      else if (i % 3 === 1) res.emit('error', new Error('reset'));
      else c.close();
      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('error')).toBe(0);
    }
    expect(sse.clientCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(base);
    // a response already gone is never registered (nothing would unregister it)
    const { req, res } = fakePair(701, exp);
    res.destroyed = true;
    expect(sse.handler(req, res)).toBe(null);
    expect(sse.clientCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(base);
  });

  it('10 000 real HTTP cycles: registry, server connections and process timers back to baseline', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
    const t0 = timers();
    const listeners0 = server.listenerCount('request') + server.listenerCount('connection');
    const BATCH = 100;
    for (let k = 0; k < 10_000 / BATCH; k++) {
      const batch = await Promise.all(Array.from({ length: BATCH }, (_, i) => openRaw(tok(800 + i))));
      await Promise.all(batch.map((s) => s.until((t) => t.includes('event: hello'))));
      for (const s of batch) s.sock.destroy();
      expect(await drained(() => sse.clientCount() === 0)).toBe(true);
    }
    const conns = await new Promise((r) => server.getConnections((e, n) => r(n)));
    expect(await drained(() => sse.clientCount() === 0)).toBe(true);
    expect(conns).toBeLessThanOrEqual(1);
    expect(server.listenerCount('request') + server.listenerCount('connection')).toBe(listeners0);
    expect(timers()).toBeLessThanOrEqual(t0 + 2);
  }, 120_000);
});
