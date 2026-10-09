/**
 * Every per-user limit of the Mini App API equals the bot's (tests/app/fixtures/rate_limits.json,
 * gen_rate_limits.py: miniapp_api's constants and `_rate_limited_response` on CPython 3.11):
 * POST 30 / 60 s, chart 10 / 60 s (SEC-3, Retry-After 6), plan 10 / 60 s, challenge GET = plan
 * bucket, share 3 / 600 s (HTTP 200 rate_limited), feedback 5 a day (kv), analyze 10 s cooldown.
 * keys 1 / 30 s and positions 6 / 60 s belong to routes that arrive with M13b (exchange keys,
 * positions): until then those paths are the router's 404, nothing answers without a bucket.
 * The sliding window (`now - t < window`) is replayed on the bot's own hit trace, the 429 body /
 * Retry-After over HTTP. The site's global per-IP limiter does not count an authenticated /api/app
 * request (the bot has no per-IP cap there); a request without a valid token still counts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
const FIX = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'fixtures', 'rate_limits.json'), 'utf8'));
setupEnv('rate-limits');

let db; let server; let port; let authService; let appRouter; let appData; let jwt; let config;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  const app = (await import('../../../server.js')).default;
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  jwt = nodeRequire('jsonwebtoken');
  config = nodeRequire('../../../config/index.js');
  insertUser(db, 901);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

beforeEach(() => appRouter.resetRateLimits());

afterAll(async () => {
  appRouter.setClock(null);
  await new Promise((r) => server.close(r));
});

const auth = () => ({ Authorization: `Bearer ${authService._signAccessToken(901)}` });

describe('the bot\'s numbers', () => {
  it('buckets and quotas', () => {
    const CA = nodeRequire('../../../services/engine/coinAnalysisShell.js');
    expect(FIX.python.startsWith('3.11.')).toBe(true);
    expect(appRouter.POST_RATE_LIMIT).toEqual(FIX.buckets.post);
    expect(appRouter.PLAN_RATE_LIMIT).toEqual(FIX.buckets.plan);
    expect(appData.CHART_RATE_LIMIT).toEqual(FIX.buckets.chart);
    expect(appData.SHARE_RATE_LIMIT).toEqual(FIX.buckets.share);
    expect(appData.FEEDBACK_PER_DAY).toBe(FIX.feedback_per_day);
    expect(CA.ANALYZE_COOLDOWN_S).toBe(FIX.analyze_cooldown_s);
    expect(FIX.buckets.keys).toEqual([1, 30]);
    expect(FIX.buckets.positions).toEqual([6, 60]);
  });

  it('the sliding window on the bot\'s hit trace', () => {
    const { limit, window, times, ok } = FIX.trace;
    const got = times.map((t) => appRouter.rateOk(1, 'probe', limit, window, t));
    expect(got).toEqual(ok);
  });

  it('keys / positions (M13b) are not served yet: the router\'s 404, before any bucket', async () => {
    for (const [m, p] of [['GET', '/api/app/positions'], ['POST', '/api/app/exchange/keys'], ['POST', '/api/app/exchange/keys/remove']]) {
      const r = await rawRequest(port, { method: m, target: p, headers: auth(), body: m === 'POST' ? '{}' : null });
      expect(r.status).toBe(404);
      expect(r.text).toBe('404: Not Found');
    }
  });
});

describe('429 answers over HTTP', () => {
  it('plan: the 11th GET in 60 s → the bot\'s 429 (Retry-After 10, message)', async () => {
    let r;
    for (let i = 0; i < 11; i++) r = await rawRequest(port, { method: 'GET', target: '/api/app/plan', headers: auth() });
    expect(r.status).toBe(FIX.rate_limited_10.status);
    expect(r.headers['retry-after']).toBe(FIX.rate_limited_10.retry_after);
    expect(JSON.parse(r.text)).toEqual(FIX.rate_limited_10.json);
  });

  it('challenge GET shares the plan numbers in its own bucket', async () => {
    let r;
    for (let i = 0; i < 10; i++) {
      r = await rawRequest(port, { method: 'GET', target: '/api/app/challenge', headers: auth() });
      expect(r.status).toBe(200);
    }
    r = await rawRequest(port, { method: 'GET', target: '/api/app/challenge', headers: auth() });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(JSON.parse(r.text)).toEqual(FIX.rate_limited_10.json);
  });

  it('chart: the 11th GET in 60 s → 429 Retry-After 6, counted before the owner check (no existence oracle)', async () => {
    let r;
    for (let i = 0; i < 10; i++) {
      r = await rawRequest(port, { method: 'GET', target: `/api/app/signals/other-${i}/chart`, headers: auth() });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'not_found' });
    }
    r = await rawRequest(port, { method: 'GET', target: '/api/app/signals/whatever/chart', headers: auth() });
    expect(r.status).toBe(FIX.rate_limited_6.status);
    expect(r.headers['retry-after']).toBe(FIX.rate_limited_6.retry_after);
    expect(JSON.parse(r.text)).toEqual(FIX.rate_limited_6.json);
  });

  it('POST: the 31st in 60 s → 429 Retry-After 10', async () => {
    let r;
    for (let i = 0; i < 31; i++) r = await rawRequest(port, { method: 'POST', target: '/api/app/lang', headers: auth(), body: '{"lang":"ru"}' });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(JSON.parse(r.text)).toEqual(FIX.rate_limited_10.json);
  });
});

describe('global per-IP limiter vs the app surface', () => {
  const { isAuthenticatedAppRequest, authMiddleware } = nodeRequire('../../../middleware/auth.js');
  const req = (url, token) => ({ originalUrl: url, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  it('skips only /api/app requests with a valid access token', () => {
    const good = authService._signAccessToken(901);
    const expired = jwt.sign({ uid: 901, exp: Math.floor(Date.now() / 1000) - 5 }, config.jwtSecret, { algorithm: 'HS256' });
    const foreign = jwt.sign({ uid: 901 }, 'another-secret-0123456789abcdef0123', { algorithm: 'HS256', expiresIn: '1h' });
    const none = jwt.sign({ uid: 901 }, '', { algorithm: 'none' });
    expect(isAuthenticatedAppRequest(req('/api/app/dashboard', good))).toBe(true);
    expect(isAuthenticatedAppRequest(req('/api/app/events', good))).toBe(true);
    for (const t of [undefined, '', 'garbage', expired, foreign, none, `${good}x`]) {
      expect(isAuthenticatedAppRequest(req('/api/app/dashboard', t))).toBe(false);
    }
    expect(isAuthenticatedAppRequest(req('/api/public/feed', good))).toBe(false);
    expect(isAuthenticatedAppRequest(req('/api/auth/login', good))).toBe(false);
    expect(isAuthenticatedAppRequest(req('/api/application', good))).toBe(false);
  });

  it('authMiddleware exposes the token expiry (the SSE stream ends with it)', () => {
    const exp = Math.floor(Date.now() / 1000) + 1234;
    const t = jwt.sign({ uid: 901, exp }, config.jwtSecret, { algorithm: 'HS256' });
    const r = { headers: { authorization: `Bearer ${t}` } };
    let called = false;
    authMiddleware(r, { status: () => ({ json: () => null }) }, () => { called = true; });
    expect(called).toBe(true);
    expect(r.authExp).toBe(exp);
    expect(r.userId).toBe(901);
  });
});
