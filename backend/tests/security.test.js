import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { authenticator } from 'otplib';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-security.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db, twoFA, authService;
beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  twoFA = (await import('../services/twoFactorService.js')).default;
  authService = (await import('../services/authService.js')).default;
});
beforeEach(() => {
  db.prepare('DELETE FROM login_history').run();
  db.prepare('DELETE FROM email_verifications').run();
  db.prepare('DELETE FROM password_resets').run();
  db.prepare('DELETE FROM two_factor_secrets').run();
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function registerAndLogin(email = 'sec@x.com') {
  const r = await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' });
  return r.body; // { user, accessToken, refreshToken }
}

describe('2FA flow', () => {
  it('setup returns otpauth URI + 8 recovery codes', async () => {
    const u = await registerAndLogin();
    const res = await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrUrl).toContain('qrserver');
    expect(res.body.recoveryCodes).toHaveLength(8);
  });

  it('confirm with valid code flips enabled=1', async () => {
    const u = await registerAndLogin();
    const setup = await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    const secret = setup.body.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    const code = authenticator.generate(secret);
    const res = await request(app).post('/api/auth/2fa/confirm')
      .set('Authorization', 'Bearer ' + u.accessToken).send({ code });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    const st = twoFA.status(u.user.id);
    expect(st.enabled).toBe(true);
  });

  it('confirm with wrong code returns 400', async () => {
    const u = await registerAndLogin();
    await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    const res = await request(app).post('/api/auth/2fa/confirm')
      .set('Authorization', 'Bearer ' + u.accessToken).send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_2FA');
  });

  it('login with 2FA enabled returns pending token, not full tokens', async () => {
    const u = await registerAndLogin('twofa@x.com');
    const setup = await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    const secret = setup.body.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    await request(app).post('/api/auth/2fa/confirm').set('Authorization', 'Bearer ' + u.accessToken)
      .send({ code: authenticator.generate(secret) });

    const login = await request(app).post('/api/auth/login').send({ email: 'twofa@x.com', password: 'Abcdef123' });
    expect(login.status).toBe(200);
    expect(login.body.twoFactorRequired).toBe(true);
    expect(login.body.pendingToken).toBeTruthy();
    expect(login.body.accessToken).toBeUndefined();
  });

  it('2fa/verify-login completes login with correct code', async () => {
    const u = await registerAndLogin('twofa2@x.com');
    const setup = await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    const secret = setup.body.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    await request(app).post('/api/auth/2fa/confirm').set('Authorization', 'Bearer ' + u.accessToken)
      .send({ code: authenticator.generate(secret) });

    const login = await request(app).post('/api/auth/login').send({ email: 'twofa2@x.com', password: 'Abcdef123' });
    const verify = await request(app).post('/api/auth/2fa/verify-login').send({
      pendingToken: login.body.pendingToken,
      code: authenticator.generate(secret),
    });
    expect(verify.status).toBe(200);
    expect(verify.body.accessToken).toBeTruthy();
    expect(verify.body.user.email).toBe('twofa2@x.com');
  });

  it('disable with wrong password returns 401', async () => {
    const u = await registerAndLogin();
    const setup = await request(app).post('/api/auth/2fa/setup').set('Authorization', 'Bearer ' + u.accessToken);
    const secret = setup.body.otpauth.match(/secret=([A-Z2-7]+)/i)[1];
    await request(app).post('/api/auth/2fa/confirm').set('Authorization', 'Bearer ' + u.accessToken)
      .send({ code: authenticator.generate(secret) });

    const res = await request(app).post('/api/auth/2fa/disable')
      .set('Authorization', 'Bearer ' + u.accessToken).send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(twoFA.isEnabled(u.user.id)).toBe(true); // still on
  });

  it('recovery code works as fallback', async () => {
    const u = await registerAndLogin();
    const setup = twoFA.setup(u.user.id, u.user.email);
    twoFA.confirm(u.user.id, authenticator.generate(setup.otpauth.match(/secret=([A-Z2-7]+)/i)[1]));
    // Use a recovery code instead of a TOTP
    expect(twoFA.verifyCode(u.user.id, setup.recoveryCodes[0])).toBe(true);
    // Same code must not work twice
    expect(twoFA.verifyCode(u.user.id, setup.recoveryCodes[0])).toBe(false);
  });
});

describe('Email verification', () => {
  it('new users start unverified', async () => {
    const u = await registerAndLogin('new@x.com');
    const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(u.user.id);
    expect(row.email_verified).toBe(0);
  });

  it('request creates token, confirm flips email_verified', async () => {
    const u = await registerAndLogin('verify@x.com');
    const req1 = await request(app).post('/api/auth/verify-email/request').set('Authorization', 'Bearer ' + u.accessToken);
    expect(req1.status).toBe(200);
    expect(req1.body.sent).toBe(true);

    // Extract raw token from DB (hashed stored — so we need to manually create one for the test)
    // Simpler: generate via service and verify round-trip
    const emailService = (await import('../services/emailService.js')).default || await import('../services/emailService.js');
    const token = emailService.randomToken();
    const tokenHash = emailService.hashToken(token);
    // Replace the DB token with one we know
    db.prepare('UPDATE email_verifications SET token_hash = ? WHERE user_id = ?').run(tokenHash, u.user.id);

    const confirm = await request(app).post('/api/auth/verify-email/confirm').send({ token });
    expect(confirm.status).toBe(200);
    expect(confirm.body.verified).toBe(true);
    const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(u.user.id);
    expect(row.email_verified).toBe(1);
  });

  it('confirm with bad token returns 400', async () => {
    const res = await request(app).post('/api/auth/verify-email/confirm').send({ token: 'nope-not-real-token-1234567890' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VERIFY_TOKEN');
  });
});

describe('Sessions management', () => {
  it('lists active refresh tokens', async () => {
    const u = await registerAndLogin();
    // register issues 1 refresh token
    const res = await request(app).get('/api/auth/sessions').set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].id).toBeTruthy();
  });

  it('revokeSession marks refresh_tokens.revoked_at', async () => {
    const u = await registerAndLogin();
    const list = await request(app).get('/api/auth/sessions').set('Authorization', 'Bearer ' + u.accessToken);
    const sessionId = list.body.sessions[0].id;
    const del = await request(app).delete('/api/auth/sessions/' + sessionId).set('Authorization', 'Bearer ' + u.accessToken);
    expect(del.status).toBe(200);
    // Try to use refresh — should fail
    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken: u.refreshToken });
    expect(refresh.status).toBe(401);
  });
});

describe('Login history', () => {
  it('records successful login', async () => {
    await registerAndLogin('hist@x.com');
    await request(app).post('/api/auth/login').send({ email: 'hist@x.com', password: 'Abcdef123' });
    const rows = db.prepare('SELECT * FROM login_history WHERE user_id IN (SELECT id FROM users WHERE email = ?)').all('hist@x.com');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].success).toBe(1);
  });

  it('records failed login with WRONG_PASSWORD code', async () => {
    await registerAndLogin('fail@x.com');
    await request(app).post('/api/auth/login').send({ email: 'fail@x.com', password: 'wrong' });
    const rows = db.prepare(`
      SELECT * FROM login_history WHERE user_id IN (SELECT id FROM users WHERE email = ?) AND success = 0
    `).all('fail@x.com');
    expect(rows.length).toBe(1);
    expect(rows[0].failure_code).toBe('WRONG_PASSWORD');
  });
});

describe('Notifications', () => {
  it('create → list → markRead flow', async () => {
    const u = await registerAndLogin('notif@x.com');
    const notifs = (await import('../services/notificationsService.js')).default;
    notifs.create(u.user.id, { type: 'test', title: 'Hello', body: 'World', link: '/dashboard.html' });
    notifs.create(u.user.id, { type: 'test', title: 'Second' });

    const list = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + u.accessToken);
    expect(list.status).toBe(200);
    expect(list.body.notifications).toHaveLength(2);
    expect(list.body.unreadCount).toBe(2);

    const id = list.body.notifications[0].id;
    await request(app).post('/api/notifications/' + id + '/read').set('Authorization', 'Bearer ' + u.accessToken);
    const after = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + u.accessToken);
    expect(after.body.unreadCount).toBe(1);
  });

  it('markAllRead clears everything', async () => {
    const u = await registerAndLogin('notif2@x.com');
    const notifs = (await import('../services/notificationsService.js')).default;
    for (let i = 0; i < 5; i++) notifs.create(u.user.id, { type: 'test', title: 'N' + i });
    await request(app).post('/api/notifications/read-all').set('Authorization', 'Bearer ' + u.accessToken);
    const res = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.body.unreadCount).toBe(0);
  });
});
