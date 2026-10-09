/**
 * The generic POST bucket of /api/app (MINIAPP_POST_PER_MIN, 30 / 60 s → 429 Retry-After 10).
 * The bot counts it inside `_load_user`, the first line of every handler, so only a request the
 * router dispatched to a handler is counted: a POST to an unknown path (404) or to a known path
 * with another method (405) is never counted and keeps its 404 / 405 even when the bucket is
 * exhausted. Routes of routes/app.js itself, of the mounted routers (genome, challenge) and of
 * the data dispatcher (appData.js, its yarl view of the target) all count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('post-bucket');

const UID = 731;
const NOW = 1_760_000_000;
let app; let appRouter; let appData; let server; let port; let token;

beforeAll(async () => {
  const db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  const authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  insertUser(db, UID);
  nodeRequire('../../../services/traderSettingsService.js').getOrCreate(UID);
  appRouter.setClock(() => NOW);
  appData.configure({ clock: () => NOW, rest: { async getCandles() { return null; }, async get24hChange() { return null; } }, log: { info() {}, warn() {}, debug() {}, error() {} } });
  token = authService._signAccessToken(UID);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  appRouter.setClock(null);
  appData.configure({ clock: null, rest: null, log: null });
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => { appRouter.resetRateLimits(); appData.resetState(); });

const post = (target, body = '{}') => rawRequest(port, { method: 'POST', target: `/api/app${target}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
const LIMIT = 30;

describe('POST bucket counts only the requests a handler takes', () => {
  it('404 / 405 POSTs are not counted: 30 handled POSTs still pass after them, the 31st is 429', async () => {
    const misses = ['/dashboard', '/signals', '/stats', '/events', '/signals/x/chart', '/nope', '/signals/a%7Bb/result', '/x/../lang', '/me', '/genome'];
    for (let i = 0; i < 3; i++) {
      for (const t of misses) {
        const r = await post(t);
        expect([t, r.status === 405 || r.status === 404]).toEqual([t, true]);
      }
    }
    for (let i = 0; i < LIMIT; i++) {
      const r = await post('/lang', '{"lang": "ru"}');
      expect(r.status, `#${i + 1}`).toBe(200);
    }
    const over = await post('/lang', '{"lang": "ru"}');
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBe('10');
    expect(JSON.parse(over.text)).toEqual({ ok: false, error: 'rate_limited', message: 'Слишком часто. Повторите через 10 с' });
  });

  it('with the bucket exhausted a 405 stays 405 (Allow) and an unknown path stays 404', async () => {
    for (let i = 0; i < LIMIT; i++) await post('/lang', '{"lang": "ru"}');
    expect((await post('/lang', '{"lang": "ru"}')).status).toBe(429);
    const m = await post('/dashboard');
    expect([m.status, m.headers.allow]).toEqual([405, 'GET,HEAD']);
    const c = await post('/signals/abc/chart');
    expect([c.status, c.headers.allow]).toEqual([405, 'GET,HEAD']);
    expect((await post('/nope')).status).toBe(404);
    expect((await post('/signals/a%7Bb/result')).status).toBe(404);
  });

  it('every kind of handler counts: own routes, mounted routers, the data dispatcher (yarl view of the id)', async () => {
    const counted = ['/lang', '/genome/apply', '/challenge/finish', '/feedback', '/signals/a%2Fb/result', '/share', '/analyze'];
    let n = 0;
    for (;;) {
      for (const t of counted) {
        const r = await post(t, t === '/lang' ? '{"lang": "ru"}' : '{}');
        n += 1;
        if (n <= LIMIT) expect([t, n, r.status === 429]).toEqual([t, n, false]);
        else {
          expect([t, n, r.status]).toEqual([t, n, 429]);
          return;
        }
      }
    }
  });
});
