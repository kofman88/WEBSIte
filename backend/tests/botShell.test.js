import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

// server.js loads its routes/services through Node's own require(); grab the
// SAME module instances (not vite-node's ESM copies) so the fake bot API
// installed here is the one the routes talk to.
const nodeRequire = createRequire(import.meta.url);

// SITE_MODE=bot — the website as a shell of the Telegram bot.
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-botshell.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';
process.env.SITE_MODE = 'bot';
process.env.BOT_API_URL = 'http://127.0.0.1:18080';
process.env.BOT_SERVICE_TOKEN = 'svc-test-token';
process.env.TELEGRAM_LOGIN_BOT = 'CHM_test_bot';
process.env.PAYMENT_BEP20_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
process.env.PAYMENT_TRC20_ADDRESS = 'TRx1234567890abcdefgh1234567890abcd';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db, botBridge, paymentService, calls;
const GOOD_HASH = 'a'.repeat(64);   // the widget hash is a 64-hex HMAC; zod wants ≥ 32 chars

// Fake bot API: records every call, answers like miniapp_api.py would.
function fakeRequest(method, url, { headers = {}, body = null } = {}) {
  calls.push({ method, url, headers, body });
  const u = new URL(url, 'http://x');
  if (u.pathname === '/miniapp/api/auth/telegram') {
    if (!body || body.hash !== GOOD_HASH) return Promise.resolve({ status: 401, headers: {}, body: { ok: false, error: 'bad_signature' } });
    return Promise.resolve({ status: 200, headers: { 'set-cookie': ['chm_sid=abc.def; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax'] },
      body: { ok: true, user: { id: body.id, username: body.username || '', first_name: body.first_name || '', is_pro: false } } });
  }
  if (u.pathname === '/miniapp/api/me') {
    if ((headers.Cookie || '') !== 'chm_sid=abc.def') return Promise.resolve({ status: 401, headers: {}, body: { ok: false, error: 'unauthorized' } });
    return Promise.resolve({ status: 200, headers: {}, body: { ok: true, auth: 'web', user: { id: 555, username: 'alex', first_name: 'Alex', plan: 'free' } } });
  }
  if (u.pathname === '/miniapp/api/service/plan') {
    if (headers['X-CHM-Service-Token'] !== 'svc-test-token') return Promise.resolve({ status: 403, headers: {}, body: { ok: false, error: 'forbidden' } });
    if (body.telegram_id === 666) return Promise.resolve({ status: 200, headers: {}, body: { ok: false, error: 'banned' } });
    return Promise.resolve({ status: 200, headers: {}, body: { ok: true, telegram_id: body.telegram_id, plan: 'pro', sub_expires: 1800000000 } });
  }
  if (u.pathname === '/miniapp/api/public/stats') {
    return Promise.resolve({ status: 200, headers: {}, body: { ok: true, days: 30, rating: { best: 'SMC', by_strategy: {} }, recent: [], generated_at: 1 } });
  }
  return Promise.resolve({ status: 404, headers: {}, body: null });
}

beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = nodeRequire('../models/database.js');
  botBridge = nodeRequire('../services/botBridge.js');
  paymentService = nodeRequire('../services/paymentService.js');
  botBridge._setRequest(fakeRequest);
});

beforeEach(() => {
  calls = [];
  botBridge._resetCaches();
  for (const t of ['payments', 'subscriptions', 'system_kv', 'audit_log', 'users']) db.prepare('DELETE FROM ' + t).run();
});

function makeUser({ tgId = null, chatId = null } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const info = db.prepare(`INSERT INTO users (email, password_hash, referral_code, is_active, email_verified, tg_id, telegram_chat_id)
                           VALUES (?, 'x', ?, 1, 1, ?, ?)`).run(e, 'R' + Math.random().toString(36).slice(2, 9).toUpperCase(), tgId, chatId);
  return info.lastInsertRowid;
}

// ── plans / proxy mapping / engine gate ───────────────────────────────

describe('bot proxy path mapping', () => {
  it('maps /app → /miniapp and leaves everything else alone', async () => {
    const { mapPath, rewriteLocation } = nodeRequire('../middleware/botProxy.js');
    expect(mapPath('/app')).toEqual({ redirect: '/app/' });
    expect(mapPath('/app/')).toEqual({ target: '/miniapp/', prefix: '/app' });
    expect(mapPath('/app/static/app.js')).toEqual({ target: '/miniapp/static/app.js', prefix: '/app' });
    expect(mapPath('/app/api/me')).toEqual({ target: '/miniapp/api/me', prefix: '/app' });
    expect(mapPath('/miniapp/api/auth/telegram')).toEqual({ target: '/miniapp/api/auth/telegram', prefix: '/miniapp' });
    expect(mapPath('/application')).toBe(null);
    expect(mapPath('/admin/dashboard')).toBe(null);     // bot admin never exposed
    expect(mapPath('/metrics')).toBe(null);
    expect(rewriteLocation('/miniapp/', '/app')).toBe('/app/');
    expect(rewriteLocation('http://127.0.0.1:8080/miniapp/?tab=profile', '/app')).toBe('http://127.0.0.1:8080/app/?tab=profile');
    expect(rewriteLocation('/miniapp/', '/miniapp')).toBe('/miniapp/');
    expect(rewriteLocation('/other', '/app')).toBe('/other');
  });
  it('redirects /app to /app/ and proxies /app/… (502 when the bot is down)', async () => {
    const r1 = await request(app).get('/app?tab=profile');
    expect(r1.status).toBe(302);
    expect(r1.headers.location).toBe('/app/?tab=profile');
    const r2 = await request(app).get('/app/api/me');       // nothing listens on 18080
    expect(r2.status).toBe(502);
    expect(r2.body.error).toBe('unavailable');
  });
});

describe('engine gate (SITE_MODE=bot)', () => {
  it('engine APIs answer 410 ENGINE_MOVED, dashboard pages redirect to /app/', async () => {
    for (const p of ['/api/bots', '/api/backtests/run', '/api/signals', '/api/exchanges', '/api/strategies/market']) {
      const r = await request(app).get(p);
      expect(r.status, p).toBe(410);
      expect(r.body.code).toBe('ENGINE_MOVED');
      expect(r.body.app).toBe('/app');
    }
    const r = await request(app).get('/dashboard.html');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/app/');
  });
  it('keeps health, auth, payments and public routes', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/subscriptions/plans')).status).toBe(200);
    expect((await request(app).post('/api/payments/stripe/checkout').send({})).status).toBe(401);
  });
  it('catalogue lists only free + pro', async () => {
    const r = await request(app).get('/api/subscriptions/plans');
    expect(r.body.plans.map((p) => p.id)).toEqual(['free', 'pro']);
    expect(r.body.plans[1].price).toBe(69);
  });
});

// ── public stats ──────────────────────────────────────────────────────

describe('GET /api/public/bot-stats', () => {
  it('proxies the bot showcase with a cache', async () => {
    const r = await request(app).get('/api/public/bot-stats');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.rating.best).toBe('SMC');
    await request(app).get('/api/public/bot-stats');
    expect(calls.filter((c) => c.url.includes('public/stats')).length).toBe(1);
  });
});

// ── login through the bot ─────────────────────────────────────────────

describe('POST /api/auth/oauth/telegram (bot verifies, cookie passed through)', () => {
  it('signs in on the site and forwards the Mini App cookie', async () => {
    const r = await request(app).post('/api/auth/oauth/telegram')
      .send({ id: 555, first_name: 'Alex', username: 'alex', auth_date: Math.floor(Date.now() / 1000), hash: GOOD_HASH });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accessToken || r.body.tokens || r.body.user).toBeTruthy();
    const sc = r.headers['set-cookie'];
    expect(sc && sc.some((c) => c.startsWith('chm_sid=abc.def'))).toBe(true);
    const row = db.prepare("SELECT tg_id, oauth_provider FROM users WHERE tg_id = '555'").get();
    expect(row && row.oauth_provider).toBe('telegram');
    const call = calls.find((c) => c.url.includes('auth/telegram'));
    expect(call.body.id).toBe(555);
  });
  it('rejects a bad signature with 401 and sets no cookie', async () => {
    const r = await request(app).post('/api/auth/oauth/telegram')
      .send({ id: 555, auth_date: Math.floor(Date.now() / 1000), hash: 'x'.repeat(32) });
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});

describe('POST /api/auth/oauth/bot-session (adopt the Mini App cookie)', () => {
  it('turns a valid chm_sid into a site session', async () => {
    const r = await request(app).post('/api/auth/oauth/bot-session').set('Cookie', 'chm_sid=abc.def');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(db.prepare("SELECT id FROM users WHERE tg_id = '555'").get()).toBeTruthy();
  });
  it('401 without or with a stale cookie', async () => {
    expect((await request(app).post('/api/auth/oauth/bot-session')).status).toBe(401);
    expect((await request(app).post('/api/auth/oauth/bot-session').set('Cookie', 'chm_sid=stale')).status).toBe(401);
  });
});

// ── Pro grants ────────────────────────────────────────────────────────

describe('botBridge.grantForUser / flushGrants', () => {
  it('grants straight away when the Telegram id is known', async () => {
    const uid = makeUser({ tgId: '555' });
    const out = await botBridge.grantForUser(uid, 30, { source: 'stripe', ref: 'cs_1' });
    expect(out.granted).toBe(true);
    const c = calls.find((x) => x.url.includes('service/plan'));
    expect(c.headers['X-CHM-Service-Token']).toBe('svc-test-token');
    expect(c.body).toMatchObject({ telegram_id: 555, days: 30, plan: 'pro', source: 'stripe', ref: 'cs_1' });
  });
  it('queues when the id is unknown and flushes on link (deduped by ref)', async () => {
    const uid = makeUser();
    expect((await botBridge.grantForUser(uid, 30, { source: 'stripe', ref: 'cs_2' })).queued).toBe(true);
    expect((await botBridge.grantForUser(uid, 30, { source: 'stripe', ref: 'cs_2' })).pending).toBe(1);
    expect((await botBridge.grantForUser(uid, 7, { source: 'crypto_trc20', ref: 'tx_1' })).pending).toBe(2);
    expect(calls.filter((x) => x.url.includes('service/plan')).length).toBe(0);
    db.prepare("UPDATE users SET tg_id = '777' WHERE id = ?").run(uid);
    const f = await botBridge.flushGrants(uid);
    expect(f).toEqual({ flushed: 2, pending: 0 });
    expect(calls.filter((x) => x.url.includes('service/plan')).map((x) => x.body.days)).toEqual([30, 7]);
    expect(botBridge.pendingGrants(uid)).toEqual([]);
  });
  it('a banned bot user is refused, not queued', async () => {
    const uid = makeUser({ chatId: '666' });
    const out = await botBridge.grantForUser(uid, 30, { source: 'stripe', ref: 'cs_3' });
    expect(out.refused).toBe('banned');
    expect(botBridge.pendingGrants(uid)).toEqual([]);
  });
  it('uses telegram_chat_id when tg_id is empty and ignores non-numeric ids', () => {
    expect(botBridge.telegramIdOf(makeUser({ chatId: '888' }))).toBe('888');
    expect(botBridge.telegramIdOf(makeUser({ chatId: '-100123' }))).toBe(null);
  });
});

describe('confirmPayment mirrors Pro into the bot', () => {
  it('stripe checkout → service/plan with the session id as ref', async () => {
    const uid = makeUser({ tgId: '555' });
    const info = db.prepare(`INSERT INTO payments (user_id, amount_usd, currency, method, provider_tx_id, plan, duration_days, status)
                             VALUES (?, 69, 'USD', 'stripe', 'cs_test_9', 'pro', 30, 'pending')`).run(uid);
    paymentService.confirmPayment(info.lastInsertRowid, { metadata: { stripeSessionId: 'cs_test_9' } });
    await new Promise((r) => setTimeout(r, 30));
    const c = calls.find((x) => x.url.includes('service/plan'));
    expect(c, 'bot grant call').toBeTruthy();
    expect(c.body).toMatchObject({ telegram_id: 555, days: 30, source: 'stripe', ref: 'cs_test_9' });
    expect(db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(uid)).toMatchObject({ plan: 'pro', status: 'active' });
  });
  it('crypto payment of a legacy plan id still grants pro; a free plan does not', async () => {
    const uid = makeUser({ tgId: '555' });
    const info = db.prepare(`INSERT INTO payments (user_id, amount_usd, currency, method, provider_tx_id, plan, duration_days, status)
                             VALUES (?, 69.37, 'USDT', 'usdt_trc20', 'tx_abc', 'elite', 30, 'pending')`).run(uid);
    paymentService.confirmPayment(info.lastInsertRowid);
    await new Promise((r) => setTimeout(r, 30));
    const c = calls.find((x) => x.url.includes('service/plan'));
    expect(c.body).toMatchObject({ telegram_id: 555, source: 'crypto_trc20', ref: 'tx_abc' });
  });
});

describe('plan ids in the subscription service', () => {
  it('activateSubscription accepts legacy ids and stores the live one', async () => {
    const subs = nodeRequire('../services/subscriptionService.js');
    const uid = makeUser();
    const sub = subs.activateSubscription(uid, { plan: 'elite', paymentMethod: 'manual', durationDays: 10 });
    expect(sub.plan).toBe('pro');
    expect(sub.planDetails.id).toBe('pro');
    expect(subs.getUserSubscription(makeUser()).planDetails.id).toBe('free');
  });
});
