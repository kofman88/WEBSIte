import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { authenticator } from 'otplib';

// Production runs under Passenger: several Node processes on one SQLite file, stopped when idle and
// started again. Every single-use secret must stay single-use across them, and the 2FA attempt
// budget must be one budget: here each "process" is a real child process (tests/fixtures/
// authRaceChild.cjs) on this test's DB file, all released at the same instant.

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-auth-race.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const CHILD = path.join(process.cwd(), 'tests', 'fixtures', 'authRaceChild.cjs');
const N = 6;
let db, twoFA, imp, oauth, mw, authService;
beforeAll(() => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  db = require('../models/database');
  twoFA = require('../services/twoFactorService');
  imp = require('../services/impersonationService');
  oauth = require('../services/oauthService');
  mw = require('../middleware/auth');
  authService = require('../services/authService');
});

function child(mode, startAt, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CHILD, mode, String(startAt), ...args.map(String)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (_e) { reject(new Error(`child ${mode}: ${out} ${err}`)); }
    });
  });
}
// n processes try the same thing at the same instant
async function race(n, mode, args) {
  const startAt = Date.now() + 2500;
  const outs = await Promise.all(Array.from({ length: n }, () => child(mode, startAt, args)));
  for (const o of outs) expect(o.error).toBeUndefined();
  return outs.map((o) => o.ok);
}
let seq = 0;
async function user() {
  seq += 1;
  const r = await authService.register({ email: `race${seq}@x.com`, password: 'Abcdef123' });
  return r.user.id;
}
async function with2FA() {
  const uid = await user();
  const s = await twoFA.setup(uid, `race${seq}@x.com`);
  const secret = /secret=([A-Z2-7]+)/.exec(s.otpauth)[1];
  db.prepare('UPDATE two_factor_secrets SET enabled = 1 WHERE user_id = ?').run(uid);
  return { uid, secret, recovery: s.recoveryCodes };
}

describe('single-use secrets across processes', () => {
  it('a TOTP code: one of the processes accepts it, the rest — and a process started later — refuse it', async () => {
    const { uid, secret } = await with2FA();
    // a code of a step that stays valid (±1 step window) for the whole race
    const code = authenticator.generate(secret);
    const got = await race(N, 'totp', [uid, code]);
    expect(got.filter(Boolean)).toHaveLength(1);
    // "after a restart": a fresh process, the same code
    expect((await child('totp', 0, [uid, code])).ok).toBe(false);
    expect(db.prepare('SELECT last_used_step FROM two_factor_secrets WHERE user_id = ?').get(uid).last_used_step).toBeGreaterThan(0);
  }, 30_000);

  it('a recovery code: accepted once across processes; the other codes still work', async () => {
    const { uid, recovery } = await with2FA();
    const got = await race(N, 'recovery', [uid, recovery[0]]);
    expect(got.filter(Boolean)).toHaveLength(1);
    expect((await child('recovery', 0, [uid, recovery[0]])).ok).toBe(false);
    // two different codes at once both work (the compare-and-swap retries on the other's change)
    const two = await Promise.all([recovery[1], recovery[2]].map((c) => child('recovery', Date.now() + 2500, [uid, c])));
    expect(two.map((o) => o.ok)).toEqual([true, true]);
    expect(db.prepare('SELECT recovery_codes_hash FROM two_factor_secrets WHERE user_id = ?').get(uid).recovery_codes_hash.split(',')).toHaveLength(5);
  }, 30_000);

  it('an impersonation hand-off code: one session, whichever process gets it', async () => {
    const admin = await user();
    db.prepare("UPDATE users SET is_admin = 1, admin_role = 'superadmin' WHERE id = ?").run(admin);
    const target = await user();
    const h = imp.newHandoff();
    db.prepare(`INSERT INTO impersonation_tokens (jti, admin_id, target_id, reason, expires_at, handoff_hash, handoff_expires_at)
                VALUES (?, ?, ?, 'race', ?, ?, ?)`).run(crypto.randomBytes(8).toString('hex'), admin, target, new Date(Date.now() + 1800_000).toISOString(), h.hash, h.expiresAt);
    const got = await race(N, 'imp', [h.code]);
    expect(got.filter(Boolean)).toHaveLength(1);
  }, 30_000);

  it('an OAuth hand-off code: one session, whichever process gets it', async () => {
    const uid = await user();
    const code = oauth.issueHandoff(uid, '/app/');
    const got = await race(N, 'oauth', [code]);
    expect(got.filter(Boolean)).toHaveLength(1);
  }, 30_000);
});

describe('a password reset link sets one password', () => {
  it('two confirms with the same token at once (bcrypt yields between check and write): one wins, the other is RESET_TOKEN_USED', async () => {
    const uid = await user();
    const email = `race${seq}@x.com`;
    const emailService = require('../services/emailService');
    authService.requestPasswordReset({ email });
    const token = emailService.randomToken();
    db.prepare('UPDATE password_resets SET token_hash = ? WHERE user_id = ? AND used_at IS NULL').run(emailService.hashToken(token), uid);
    const out = await Promise.allSettled([
      authService.confirmPasswordReset({ token, newPassword: 'FirstPass123' }),
      authService.confirmPasswordReset({ token, newPassword: 'SecondPass123' }),
    ]);
    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(out.find((o) => o.status === 'rejected').reason.code).toBe('RESET_TOKEN_USED');
    const winner = out[0].status === 'fulfilled' ? 'FirstPass123' : 'SecondPass123';
    const loser = winner === 'FirstPass123' ? 'SecondPass123' : 'FirstPass123';
    await expect((async () => authService.login({ email, password: winner }))()).resolves.toMatchObject({ user: { id: uid } });
    await expect((async () => authService.login({ email, password: loser }))()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('the 2FA attempt budget is one budget for every process (the DB store)', () => {
  it('concurrent increments from several processes are all counted, each count once', async () => {
    const startAt = Date.now() + 2500;
    const outs = await Promise.all(Array.from({ length: 4 }, () => child('hits', startAt, ['race:', 'u:7', 10])));
    const all = outs.flatMap((o) => o.ok).sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 40 }, (_v, i) => i + 1));
    expect(db.prepare("SELECT hits FROM rate_limit_hits WHERE key = 'race:u:7'").get().hits).toBe(40);
  }, 30_000);

  function limitedApp(opts) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    a.post('/verify', mw.createTwoFactorLimiter(opts), (_req, res) => res.json({ ok: true }));
    return a;
  }
  const hit = (a, ip, uid) => request(a).post('/verify').set('X-Forwarded-For', ip).send({ pendingToken: authService._signPending(uid), code: '000000' }).then((r) => r.status);

  it('a restarted process (a new limiter on the same DB) keeps the budget; another prefix has its own', async () => {
    const before = limitedApp({ shared: true, prefix: 'restart-test:', perSubject: 3, perIp: 100 });
    expect([await hit(before, '10.1.0.1', 501), await hit(before, '10.1.0.2', 501), await hit(before, '10.1.0.3', 501)]).toEqual([200, 200, 200]);
    expect(await hit(before, '10.1.0.4', 501)).toBe(429);
    const after = limitedApp({ shared: true, prefix: 'restart-test:', perSubject: 3, perIp: 100 });
    expect(await hit(after, '10.1.0.5', 501)).toBe(429);
    expect(await hit(after, '10.1.0.5', 502)).toBe(200);   // another sign-in subject
    const other = limitedApp({ shared: true, prefix: 'other-test:', perSubject: 3, perIp: 100 });
    expect(await hit(other, '10.1.0.6', 501)).toBe(200);
    // the per-IP half too
    const ipOnly = limitedApp({ shared: true, prefix: 'ip-test:', perSubject: 100, perIp: 2 });
    expect([await hit(ipOnly, '10.9.9.9', 601), await hit(ipOnly, '10.9.9.9', 602)]).toEqual([200, 200]);
    expect(await hit(limitedApp({ shared: true, prefix: 'ip-test:', perSubject: 100, perIp: 2 }), '10.9.9.9', 603)).toBe(429);
    // what the rows hold: limiter prefix + user id / address — never a token
    const keys = db.prepare("SELECT key FROM rate_limit_hits WHERE key LIKE '%-test:%' ORDER BY key").all().map((r) => r.key);
    expect(keys).toContain('restart-test:subject:u:501');
    expect(keys.some((k) => /eyJ/.test(k))).toBe(false);
  });

  it('the window ends: a counter whose reset time passed starts again at 1', async () => {
    const { SqliteRateLimitStore } = require('../middleware/rateLimitStore');
    const st = new SqliteRateLimitStore({ prefix: 'window-test:' });
    st.init({ windowMs: 60_000 });
    await st.increment('k'); await st.increment('k');
    db.prepare("UPDATE rate_limit_hits SET reset_at = ? WHERE key = 'window-test:k'").run(Date.now() - 1);
    expect(await st.get('k')).toBeUndefined();
    expect((await st.increment('k')).totalHits).toBe(1);
    await st.decrement('k');
    expect((await st.get('k')).totalHits).toBe(0);
    await st.resetAll();
    expect(db.prepare("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE key LIKE 'window-test:%'").get().n).toBe(0);
  });

  it('production uses the DB store for both halves (middleware/auth.js)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'middleware', 'auth.js'), 'utf8');
    expect(src).toContain('const twoFactorLimiter = TESTING ? noop : createTwoFactorLimiter({ shared: true });');
  });
});
