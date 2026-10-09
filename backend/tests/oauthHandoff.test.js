import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

// Google sign-in: the callback never puts the session's tokens into a URL. They used to ride in the
// fragment of the return page — ?redirect= taken as-is when it started with '/', so //evil.example
// received them, and the default /dashboard.html is the SPA fallback, i.e. the landing with Yandex
// Metrika + Session Replay. Now: ?redirect= is one of the site's pages or the web app; the callback
// answers /auth/#oauth=<one-time 60-second code> (frontend/auth/: no counter, cleans the address bar
// first), the page trades the code by POST /api/auth/oauth/redeem, and the session is issued there —
// or the 2FA step, for an account with 2FA on. A provider-unverified e-mail never links an account.

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-oauth-handoff.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.APP_URL = 'https://chmup.top';

let app, db, oauth, authService, twoFA;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
  db = require('../models/database');
  oauth = require('../services/oauthService');
  authService = require('../services/authService');
  twoFA = require('../services/twoFactorService');
});
beforeEach(() => {
  for (const t of ['two_factor_secrets', 'refresh_tokens', 'login_history', 'audit_log', 'subscriptions', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM system_kv WHERE key LIKE 'oauth_handoff:%'").run();
});
afterEach(() => { vi.restoreAllMocks(); });

const cookieOf = (res, name) => {
  for (const c of res.headers['set-cookie'] || []) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
};
// the whole browser round trip with Google stubbed: /start (cookies) → /callback
async function signIn({ redirect, profile }) {
  vi.spyOn(oauth, 'googleExchangeCode').mockResolvedValue({ access_token: 'google-at' });
  vi.spyOn(oauth, 'googleFetchProfile').mockResolvedValue({ sub: 'g-sub-1', email: 'g@x.com', emailVerified: true, givenName: 'G', ...profile });
  const start = await request(app).get('/api/auth/oauth/google/start' + (redirect === undefined ? '' : '?redirect=' + encodeURIComponent(redirect))).redirects(0);
  const state = cookieOf(start, 'oauth_state');
  const ret = cookieOf(start, 'oauth_return');
  const cb = await request(app).get('/api/auth/oauth/google/callback?code=abc&state=' + encodeURIComponent(state))
    .set('Cookie', `oauth_state=${encodeURIComponent(state)}; oauth_return=${encodeURIComponent(ret)}`).redirects(0);
  return { start, ret, cb };
}
const codeOf = (loc) => (/^\/auth\/#oauth=([A-Za-z0-9_-]{43})$/.exec(loc || '') || [])[1];

describe('Google: ?redirect= is one of the site\'s pages, nothing else', () => {
  it.each([
    ['//evil.example', '/app/'], ['//evil.example/x', '/app/'], ['/\\evil.example', '/app/'], ['https://evil.example/', '/app/'],
    ['/dashboard.html', '/app/'], ['/settings.html?x=1', '/app/'], ['/settings.html#a', '/app/'], ['javascript:alert(1)', '/app/'],
    ['/%2F%2Fevil.example', '/app/'], ['', '/app/'], [undefined, '/app/'],
    ['/settings.html', '/settings.html'], ['/ops.html', '/ops.html'], ['/subscriptions.html', '/subscriptions.html'], ['/app/', '/app/'],
  ])('%s → returns to %s', async (redirect, want) => {
    const { start, ret, cb } = await signIn({ redirect });
    expect(start.status).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(ret).toBe(want);
    const r = await request(app).post('/api/auth/oauth/redeem').send({ code: codeOf(cb.headers.location) });
    expect(r.status).toBe(200);
    expect(r.body.returnTo).toBe(want);
  });
});

describe('Google callback: a one-time code for /auth/, no token in any URL', () => {
  it('redirects to /auth/#oauth=<code>, not cached, no Referer; the code buys the session once', async () => {
    const { cb } = await signIn({ redirect: '/settings.html' });
    expect(cb.status).toBe(302);
    const code = codeOf(cb.headers.location);
    expect(code, cb.headers.location).toBeTruthy();
    expect(cb.headers['cache-control']).toBe('no-store');
    expect(cb.headers['referrer-policy']).toBe('no-referrer');
    expect(cb.headers.location).not.toMatch(/access_token|refresh_token|eyJ/);
    // no session exists until the page trades the code
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('g@x.com');
    expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?').get(user.id).n).toBe(0);
    // only the code's hash is stored
    const kv = db.prepare("SELECT key, value FROM system_kv WHERE key LIKE 'oauth_handoff:%'").all();
    expect(kv).toHaveLength(1);
    expect(JSON.stringify(kv)).not.toContain(code);
    const r = await request(app).post('/api/auth/oauth/redeem').send({ code });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ returnTo: '/settings.html', user: { email: 'g@x.com' } });
    expect(authService.verifyAccessToken(r.body.accessToken).uid).toBe(user.id);
    expect(typeof r.body.refreshToken).toBe('string');
    const again = await request(app).post('/api/auth/oauth/redeem').send({ code });
    expect([again.status, again.body.code]).toEqual([400, 'INVALID_HANDOFF']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM system_kv WHERE key LIKE 'oauth_handoff:%'").get().n).toBe(0);
  });

  it('the code lives 60 seconds', () => {
    const u = db.prepare("INSERT INTO users (email, password_hash, referral_code, is_active) VALUES ('t@x.com', '', 'R1', 1)").run();
    const now = Date.now();
    const code = oauth.issueHandoff(Number(u.lastInsertRowid), '/ops.html', now);
    expect(() => oauth.redeemHandoff(code, now + 61_000)).toThrow(expect.objectContaining({ code: 'INVALID_HANDOFF' }));
    expect(() => oauth.redeemHandoff(code, now)).toThrow(expect.objectContaining({ code: 'INVALID_HANDOFF' }));   // claimed by the expired try
    const fresh = oauth.issueHandoff(Number(u.lastInsertRowid), '//evil.example', now);
    expect(oauth.redeemHandoff(fresh, now + 59_000)).toEqual({ userId: Number(u.lastInsertRowid), returnTo: '/app/' });
  });

  it.each(['', 'x'.repeat(43) + '=', 'short', 'A'.repeat(42), 'A'.repeat(43)])('a made-up code %j is refused', async (code) => {
    const r = await request(app).post('/api/auth/oauth/redeem').send({ code });
    expect(r.status).toBe(400);
    expect(r.body.accessToken).toBeUndefined();
  });

  it('an account with 2FA on gets the 2FA step, not a session', async () => {
    const { cb } = await signIn({ redirect: '/ops.html' });
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('g@x.com');
    db.prepare('INSERT INTO two_factor_secrets (user_id, secret_encrypted, enabled, recovery_codes_hash) VALUES (?, ?, 1, ?)').run(user.id, 'x', '');
    expect(twoFA.isEnabled(user.id)).toBe(true);
    const r = await request(app).post('/api/auth/oauth/redeem').send({ code: codeOf(cb.headers.location) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ twoFactorRequired: true, returnTo: '/ops.html' });
    expect(authService.verifyPending(r.body.pendingToken)).toBe(user.id);
    expect(r.body.accessToken).toBeUndefined();
    expect(r.body.refreshToken).toBeUndefined();
  });

  it('a disabled account gets no session (callback and redeem)', async () => {
    const first = await signIn({});
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get('g@x.com');
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
    const r = await request(app).post('/api/auth/oauth/redeem').send({ code: codeOf(first.cb.headers.location) });
    expect([r.status, r.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    const { cb } = await signIn({});
    expect(cb.headers.location).toBe('/auth/?oauth_error=ACCOUNT_DISABLED');
  });

  it('a provider-unverified e-mail does not take over the account registered with it', async () => {
    await authService.register({ email: 'owner@x.com', password: 'Abcdef123' });
    const { cb } = await signIn({ profile: { sub: 'g-attacker', email: 'owner@x.com', emailVerified: false } });
    expect(cb.headers.location).toBe('/auth/?oauth_error=OAUTH_EMAIL_UNVERIFIED');
    expect(db.prepare('SELECT google_id FROM users WHERE email = ?').get('owner@x.com').google_id).toBeNull();
    // verified by Google: linked, as before
    const ok = await signIn({ profile: { sub: 'g-owner', email: 'owner@x.com', emailVerified: true } });
    expect(codeOf(ok.cb.headers.location)).toBeTruthy();
    expect(db.prepare('SELECT google_id FROM users WHERE email = ?').get('owner@x.com').google_id).toBe('g-owner');
  });

  it('errors land on /auth/ (no counter there), never on the landing', async () => {
    const noCode = await request(app).get('/api/auth/oauth/google/callback').redirects(0);
    expect(noCode.headers.location).toBe('/auth/?oauth_error=no_code');
    const badState = await request(app).get('/api/auth/oauth/google/callback?code=a&state=forged').set('Cookie', 'oauth_state=forged').redirects(0);
    expect(badState.headers.location).toBe('/auth/?oauth_error=bad_state');
    vi.spyOn(oauth, 'googleExchangeCode').mockRejectedValue(Object.assign(new Error('x'), { code: 'OAUTH_TOKEN_FAILED' }));
    const start = await request(app).get('/api/auth/oauth/google/start').redirects(0);
    const state = cookieOf(start, 'oauth_state');
    const failed = await request(app).get('/api/auth/oauth/google/callback?code=a&state=' + encodeURIComponent(state)).set('Cookie', `oauth_state=${encodeURIComponent(state)}`).redirects(0);
    expect(failed.headers.location).toBe('/auth/?oauth_error=OAUTH_TOKEN_FAILED');
  });
});

describe('frontend/auth/ completes the Google sign-in', () => {
  const PAGE = fs.readFileSync(path.join(process.cwd(), '..', 'frontend', 'auth', 'index.html'), 'utf8');
  it('takes #oauth=, trades it by POST, keeps the session in the site\'s storage and returns only to a site page', () => {
    expect(PAGE).toContain("var WANTED = { reset: 1, verify: 1, oauth: 1, verified: 1, code: 1, verify_email: 1, oauth_error: 1 };");
    expect(PAGE).toContain("api('oauth/redeem', { code: code })");
    expect(PAGE).toContain("api('2fa/verify-login', { pendingToken: pending, code: code })");
    expect(PAGE).toContain("localStorage.setItem('chm_access', d.accessToken);");
    expect(PAGE).toContain("var RETURN_PATHS = ['/app/', '/settings.html', '/subscriptions.html', '/ops.html', '/admin.html'];");
    expect(PAGE).toContain("location.replace(RETURN_PATHS.indexOf(d.returnTo) >= 0 ? d.returnTo : '/app/');");
    expect(oauth.RETURN_PATHS).toEqual(['/app/', '/settings.html', '/subscriptions.html', '/ops.html', '/admin.html']);
  });
});
