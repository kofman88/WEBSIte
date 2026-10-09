/**
 * GET /api/app/events — the site-only live channel (services/sseService.js behind the /api/app
 * JWT auth): the handshake (status, text/event-stream, X-Accel-Buffering: no, no-transform cache
 * header, `retry:` hint, `hello`), the 25 s comment heartbeat, the per-user channel (another user's
 * events never arrive), the events the engine's delivery emits (signalDelivery: `notification` +
 * `signal` card, a `trade` notice, the chart descriptor; the tracker's `progress`), cleanup on
 * disconnect, 401 without a token and 405 for another method.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('events');

let db; let app; let authService; let sse; let server; let port; let ts;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  authService = nodeRequire('../../../services/authService.js');
  sse = nodeRequire('../../../services/sseService.js');
  ts = nodeRequire('../../../services/traderSettingsService.js');
  for (const uid of [501, 502]) { insertUser(db, uid); ts.getOrCreate(uid); }
  db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, created_at, strategy)
              VALUES ('ev-1', 501, 'BTC-USDT-SWAP', 'LONG', 100, 99, 101.5, 103, 104.5, 1, 'LEVELS')`).run();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  sse.closeAll();
  await new Promise((r) => server.close(r));
});

/** Opens the stream; collects the raw text; `until(text)` resolves when the predicate holds. */
function openStream(uid) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/app/events', headers: { Authorization: `Bearer ${authService._signAccessToken(uid)}` } }, (res) => {
      let text = '';
      const waiters = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        for (const w of waiters.slice()) if (w.pred(text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(text); }
      });
      resolve({
        res, req,
        get text() { return text; },
        until(pred, ms = 3000) {
          if (pred(text)) return Promise.resolve(text);
          return new Promise((ok, fail) => {
            const w = { pred, resolve: ok };
            waiters.push(w);
            setTimeout(() => fail(new Error(`stream timeout; got: ${text.slice(-300)}`)), ms).unref();
          });
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

/** SSE frames → [{event, data}] (comments and retry lines skipped). */
function frames(text) {
  return text.split('\n\n').filter((b) => b.trim() && !b.startsWith(':') && !b.startsWith('retry:')).map((b) => {
    const ev = {};
    for (const ln of b.split('\n')) {
      if (ln.startsWith('event: ')) ev.event = ln.slice(7);
      else if (ln.startsWith('data: ')) ev.data = (ev.data ? `${ev.data}\n` : '') + ln.slice(6);
      else if (ln.startsWith('id: ')) ev.id = Number(ln.slice(4));
    }
    try { ev.json = JSON.parse(ev.data); } catch (_e) { /* text payload */ }
    return ev;
  });
}

/** Lets the event loop run (I/O callbacks included) without a timer. */
const turn = () => new Promise((r) => setImmediate(r));
async function drained(uid) {
  for (let i = 0; i < 2000 && sse.clientCount(uid); i++) await turn();
  return sse.clientCount(uid);
}

describe('GET /api/app/events', () => {
  it('401 without a token (the Mini App envelope), 405 for POST', async () => {
    const r = await rawRequest(port, { method: 'GET', target: '/api/app/events' });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'unauthorized' });
    const p = await rawRequest(port, { method: 'POST', target: '/api/app/events', headers: { Authorization: `Bearer ${authService._signAccessToken(501)}` }, body: '{}' });
    expect(p.status).toBe(405);
    expect(p.headers.allow).toBe('GET,HEAD');
  });

  it('handshake, per-user channel, engine events, cleanup', async () => {
    const a = await openStream(501);
    const b = await openStream(502);
    expect(a.res.statusCode).toBe(200);
    expect(a.res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(a.res.headers['x-accel-buffering']).toBe('no');
    expect(a.res.headers['cache-control']).toBe('no-cache, no-transform');
    await a.until((t) => t.includes('event: hello'));
    await b.until((t) => t.includes('event: hello'));
    expect(a.text.startsWith('retry: 10000\n\n')).toBe(true);
    expect(frames(a.text)[0].json).toMatchObject({ heartbeat_s: 25 });
    expect(sse.clientCount(501)).toBe(1);

    // the tracker's card edit / progress notice
    sse.broadcast(501, 'progress', { trade_id: 'ev-1', kind: 'card', stage: 'TP1', rr: 1.5 });
    sse.broadcast(502, 'progress', { trade_id: 'other', kind: 'card', stage: 'SL' });
    await a.until((t) => t.includes('event: progress'));
    // a delivered card: the feed row (notification) + the signal event, signal_msg_id stored
    const { createSignalDelivery } = nodeRequire('../../../services/engine/signalDelivery.js');
    const delivery = createSignalDelivery({ log: { debug() {}, info() {}, warning() {}, warn() {}, error() {} } });
    expect(await delivery.deliver({ kind: 'card', userId: 501, tradeId: 'ev-1', strategy: 'LEVELS', symbol: 'BTC-USDT-SWAP', direction: 'LONG', text: '<b>BTC</b> LONG', lang: 'ru', silent: true })).toBe(true);
    expect(await delivery.deliver({ kind: 'notice', type: 'trade', userId: 501, text: 'Сделка открыта', lang: 'ru' })).toBe(true);
    delivery.deliverChart({ userId: 501, tradeId: 'ev-1', chart: { timeframe: '1h' } });
    await a.until((t) => (t.match(/event: notification/g) || []).length >= 2 && t.includes('event: trade') && (t.match(/event: signal/g) || []).length >= 2);
    const fa = frames(a.text);
    const names = fa.map((f) => f.event);
    expect(names[0]).toBe('hello');
    expect(names).toEqual(expect.arrayContaining(['progress', 'notification', 'signal', 'trade']));
    const card = fa.find((f) => f.event === 'signal' && f.json.kind === 'card');
    expect(card.json).toMatchObject({ trade_id: 'ev-1', symbol: 'BTC-USDT-SWAP', silent: true });
    expect(fa.find((f) => f.event === 'signal' && f.json.kind === 'chart').json.trade_id).toBe('ev-1');
    expect(fa.filter((f) => f.id).map((f) => f.id)).toEqual([...fa.filter((f) => f.id).map((f) => f.id)].sort((x, y) => x - y));
    const row = db.prepare("SELECT signal_msg_id FROM signal_trades WHERE trade_id = 'ev-1'").get();
    expect(row.signal_msg_id).toBeGreaterThan(0);
    // user 502 saw only its own progress event (a last marker: the stream is ordered)
    sse.broadcast(502, 'marker', {});
    await b.until((t) => t.includes('event: marker'));
    expect(frames(b.text).map((f) => f.event)).toEqual(['hello', 'progress', 'marker']);
    expect(frames(b.text)[1].json.trade_id).toBe('other');

    a.close();
    b.close();
    expect(await drained(501)).toBe(0);
    expect(await drained(502)).toBe(0);
  });

  it('25 s comment heartbeat keeps the stream open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const a = await openStream(501);
      await a.until((t) => t.includes('event: hello'));
      expect(a.text.includes(': ping')).toBe(false);
      vi.advanceTimersByTime(25_000);
      await a.until((t) => t.includes(': ping'));
      vi.advanceTimersByTime(25_000);
      await a.until((t) => (t.match(/: ping/g) || []).length === 2);
      a.close();
      expect(await drained(501)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
