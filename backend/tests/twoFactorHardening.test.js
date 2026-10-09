import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { authenticator } from 'otplib';

// 2FA verify: (a) the attempt limiter is keyed per sign-in subject AND per IP — before it was
// IP + the first 16 characters of the pending JWT (its constant header), so everyone behind one IP
// shared 10 attempts and nothing tied the budget to the sign-in; (b) a TOTP code is accepted once:
// the time step of every accepted code is stored (two_factor_secrets.last_used_step), a code of that
// step or an earlier one is a replay.

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-2fa-hardening.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

let app, db, twoFA, authService, mw;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  twoFA = (await import('../services/twoFactorService.js')).default;
  authService = (await import('../services/authService.js')).default;
  mw = (await import('../middleware/auth.js')).default;
});
afterEach(() => { vi.useRealTimers(); });

// ── (a) the limiter ──────────────────────────────────────────────────────
describe('2FA attempt limiter: per sign-in subject and per IP', () => {
  // the production limiter pair (smaller budgets) in front of a stub verify-login
  function limitedApp(opts) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    const limiter = mw.createTwoFactorLimiter(opts);   // one pair for both routes, like routes/auth.js
    a.post('/verify', limiter, (_req, res) => res.json({ ok: true }));
    a.post('/confirm', (req, _res, next) => { req.userId = Number(req.body.uid); next(); }, limiter, (_req, res) => res.json({ ok: true }));
    return a;
  }
  const pending = (uid) => authService._signPending(uid);
  const hit = (a, ip, body, p = '/verify') => request(a).post(p).set('X-Forwarded-For', ip).send(body).then((r) => r.status);
  const hits = async (n, ...args) => { const out = []; for (let i = 0; i < n; i += 1) out.push(await hit(...args)); return out; };

  it('two users behind one IP do not share a budget (the old key gave them one between them)', async () => {
    const a = limitedApp({ perSubject: 3, perIp: 100 });
    expect(await hits(3, a, '10.0.0.1', { pendingToken: pending(1), code: '000000' })).toEqual([200, 200, 200]);
    expect(await hit(a, '10.0.0.1', { pendingToken: pending(1), code: '000000' })).toBe(429);
    // user 2, same IP, same JWT header (the old key's 16 characters): still its own 3
    expect(pending(2).slice(0, 16)).toBe(pending(1).slice(0, 16));
    expect(await hits(3, a, '10.0.0.1', { pendingToken: pending(2), code: '000000' })).toEqual([200, 200, 200]);
  });

  it('one sign-in subject is capped whatever IPs and pending tokens the guesses use', async () => {
    const a = limitedApp({ perSubject: 3, perIp: 100 });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push(await hit(a, `10.1.0.${i}`, { pendingToken: pending(7), code: '123456' }));
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    // the session route (2fa/confirm) counts for the same account
    expect(await hit(a, '10.9.9.9', { uid: 7, code: '123456' }, '/confirm')).toBe(429);
    expect(await hit(a, '10.9.9.9', { uid: 8, code: '123456' }, '/confirm')).toBe(200);
  });

  it('one IP is capped across accounts', async () => {
    const a = limitedApp({ perSubject: 100, perIp: 4 });
    const statuses = [];
    for (let uid = 1; uid <= 6; uid += 1) statuses.push(await hit(a, '10.2.0.1', { pendingToken: pending(uid), code: '000000' }));
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    expect(await hit(a, '10.2.0.2', { pendingToken: pending(1), code: '000000' })).toBe(200);
  });

  it('forged / expired pending tokens get no bucket each: they share one per IP', async () => {
    const a = limitedApp({ perSubject: 2, perIp: 100 });
    const forged = (i) => pending(1).slice(0, -6) + String(100000 + i);
    expect(await hits(1, a, '10.3.0.1', { pendingToken: forged(1), code: '1' })).toEqual([200]);
    expect(await hits(1, a, '10.3.0.1', { pendingToken: forged(2), code: '1' })).toEqual([200]);
    expect(await hit(a, '10.3.0.1', { pendingToken: forged(3), code: '1' })).toBe(429);
    expect(await hit(a, '10.3.0.1', { code: '1' })).toBe(429);
    expect(await hit(a, '10.3.0.2', { pendingToken: forged(4), code: '1' })).toBe(200);
  });

  it('the subject key holds the user id the token verifies to, never the token', () => {
    const tok = pending(42);
    expect(mw.twoFactorSubjectKey({ body: { pendingToken: tok }, ip: '1.2.3.4' })).toBe('u:42');
    expect(mw.twoFactorSubjectKey({ userId: 9, body: {}, ip: '1.2.3.4' })).toBe('u:9');
    expect(mw.twoFactorSubjectKey({ body: { pendingToken: tok + 'x' }, ip: '1.2.3.4' })).toBe('bad:1.2.3.4');
    expect(mw.twoFactorSubjectKey({ body: {}, ip: '1.2.3.4' })).toBe('bad:1.2.3.4');
  });

  it('the routes use it: verify-login and confirm', () => {
    const routes = fs.readFileSync(path.join(process.cwd(), 'routes', 'auth.js'), 'utf8');
    expect(routes).toContain("router.post('/2fa/verify-login', twoFactorLimiter,");
    expect(routes).toContain("router.post('/2fa/confirm', authMiddleware, twoFactorLimiter,");
    const src = fs.readFileSync(path.join(process.cwd(), 'middleware', 'auth.js'), 'utf8');
    expect(src).toContain('const twoFactorLimiter = TESTING ? noop : createTwoFactorLimiter();');
    expect(src).not.toContain('String(tok).slice(0, 16)');
  });
});

// ── (b) TOTP replay ───────────────────────────────────────────────────────
describe('TOTP: a code is accepted once (its time step is stored)', () => {
  beforeEach(() => {
    for (const t of ['two_factor_secrets', 'login_history', 'refresh_tokens', 'audit_log', 'email_verifications', 'subscriptions', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  });
  const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);   // a step boundary (unix s divisible by 30)
  const at = (secret, ms) => authenticator.clone({ epoch: ms }).generate(secret);
  async function enabled(email) {
    const r = await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' });
    const setup = await twoFA.setup(r.body.user.id, email);
    const secret = setup.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    return { id: r.body.user.id, secret, recovery: setup.recoveryCodes };
  }
  const step = (uid) => db.prepare('SELECT last_used_step FROM two_factor_secrets WHERE user_id = ?').get(uid).last_used_step;

  it('confirming the setup uses the code: it cannot sign in afterwards', async () => {
    const u = await enabled('confirm@x.com');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 + 5_000);
    const code = at(u.secret, T0 + 5_000);
    expect(twoFA.confirm(u.id, code)).toEqual({ enabled: true });
    expect(step(u.id)).toBe(T0 / 30_000);
    expect(twoFA.verifyCode(u.id, code)).toBe(false);
    // the next step's code works
    vi.setSystemTime(T0 + 35_000);
    expect(twoFA.verifyCode(u.id, at(u.secret, T0 + 35_000))).toBe(true);
    expect(step(u.id)).toBe(T0 / 30_000 + 1);
  });

  it('a code replayed within its window is refused; an older step after a newer one too', async () => {
    const u = await enabled('replay@x.com');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 - 30_000);
    twoFA.confirm(u.id, at(u.secret, T0 - 30_000));
    vi.setSystemTime(T0 + 1_000);
    const now = at(u.secret, T0 + 1_000);
    expect(twoFA.verifyCode(u.id, now)).toBe(true);
    expect(twoFA.verifyCode(u.id, now)).toBe(false);                 // same code, same step
    vi.setSystemTime(T0 + 29_000);
    expect(twoFA.verifyCode(u.id, now)).toBe(false);                 // still inside its step
    vi.setSystemTime(T0 + 45_000);
    expect(twoFA.verifyCode(u.id, now)).toBe(false);                 // inside the ±1 drift window
    expect(twoFA.verifyCode(u.id, at(u.secret, T0 + 45_000))).toBe(true);   // the new step
    // a previous-step code (accepted by the window alone) after a newer step was used
    vi.setSystemTime(T0 + 61_000);
    expect(twoFA.verifyCode(u.id, at(u.secret, T0 + 31_000))).toBe(false);
    expect(twoFA.verifyCode(u.id, at(u.secret, T0 + 61_000))).toBe(true);
  });

  it('end to end: the same code completes one sign-in, never a second one', async () => {
    const u = await enabled('e2e@x.com');
    twoFA.confirm(u.id, at(u.secret, Date.now() - 30_000));
    const code = authenticator.generate(u.secret);
    const login1 = await request(app).post('/api/auth/login').send({ email: 'e2e@x.com', password: 'Abcdef123' });
    const ok = await request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: login1.body.pendingToken, code });
    expect(ok.status).toBe(200);
    const login2 = await request(app).post('/api/auth/login').send({ email: 'e2e@x.com', password: 'Abcdef123' });
    const replay = await request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: login2.body.pendingToken, code });
    expect([replay.status, replay.body.code]).toEqual([400, 'INVALID_2FA']);
    // and with the first sign-in's own pending token
    const replay2 = await request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: login1.body.pendingToken, code });
    expect(replay2.status).toBe(400);
  });

  it('two concurrent uses of one code: exactly one wins', async () => {
    const u = await enabled('race@x.com');
    twoFA.confirm(u.id, at(u.secret, Date.now() - 30_000));
    const code = authenticator.generate(u.secret);
    const [l1, l2] = await Promise.all([1, 2].map(() => request(app).post('/api/auth/login').send({ email: 'race@x.com', password: 'Abcdef123' })));
    const res = await Promise.all([l1, l2].map((l) => request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: l.body.pendingToken, code })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('a new setup starts afresh; recovery codes are unaffected; a wrong code stores nothing', async () => {
    const u = await enabled('fresh@x.com');
    twoFA.confirm(u.id, at(u.secret, Date.now()));
    expect(step(u.id)).not.toBeNull();
    expect(twoFA.verifyCode(u.id, '000000') || twoFA.verifyCode(u.id, '999999')).toBe(false);
    expect(twoFA.verifyCode(u.id, u.recovery[0])).toBe(true);
    const again = await twoFA.setup(u.id, 'fresh@x.com');
    expect(step(u.id)).toBeNull();
    const s2 = again.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    expect(twoFA.confirm(u.id, at(s2, Date.now()))).toEqual({ enabled: true });
  });

  it('matchStep: the step a code belongs to within ±1, null otherwise', () => {
    const secret = authenticator.generateSecret();
    const s0 = T0 / 30_000;
    expect(twoFA.matchStep(at(secret, T0), secret, T0 + 10_000)).toBe(s0);
    expect(twoFA.matchStep(at(secret, T0 - 30_000), secret, T0 + 10_000)).toBe(s0 - 1);
    expect(twoFA.matchStep(at(secret, T0 + 30_000), secret, T0 + 10_000)).toBe(s0 + 1);
    expect(twoFA.matchStep(at(secret, T0 - 60_000), secret, T0 + 10_000)).toBeNull();
  });
});
