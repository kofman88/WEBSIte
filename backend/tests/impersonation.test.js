import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';

// ops → "Impersonate" hands the impersonated session to the new tab without any URL: the admin route
// answers a one-time 60-second code (not the access token), ops.js leaves it in same-origin
// localStorage, the tab (frontend/app.js) trades it by POST /api/auth/impersonation/redeem. The
// audit trail is the one it always was. In Chromium: tests/e2e/csp_pages_probe.mjs (ops scenario).

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-impersonation.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

let app, db, imp;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  imp = (await import('../services/impersonationService.js')).default;
});

let admin, user, support, viewer, other;
async function account(email, { isAdmin = false, role = null } = {}) {
  const r = await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' });
  if (isAdmin) db.prepare('UPDATE users SET is_admin = 1, admin_role = ? WHERE id = ?').run(role, r.body.user.id);
  return { id: r.body.user.id, email, token: r.body.accessToken };
}
beforeAll(async () => {
  admin = await account('root@x.com', { isAdmin: true, role: 'superadmin' });
  support = await account('support@x.com', { isAdmin: true, role: 'support' });
  viewer = await account('viewer@x.com', { isAdmin: true, role: 'viewer' });
  user = await account('target@x.com');
  other = await account('other@x.com');
});
beforeEach(() => {
  for (const t of ['impersonation_tokens', 'audit_log']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('UPDATE users SET is_admin = 0, admin_role = NULL, is_active = 1').run();
  for (const [u, role] of [[admin, 'superadmin'], [support, 'support'], [viewer, 'viewer']]) db.prepare('UPDATE users SET is_admin = 1, admin_role = ? WHERE id = ?').run(role, u.id);
});
const bearer = (t) => ({ Authorization: 'Bearer ' + t });
const start = (who, target, reason = 'support ticket #42') => request(app).post(`/api/admin/users/${target.id}/impersonate`).set(bearer(who.token)).send({ reason });
const redeem = (code) => request(app).post('/api/auth/impersonation/redeem').send({ code });

describe('POST /api/admin/users/:id/impersonate: a one-time code, never the token', () => {
  it('answers a 43-character code valid 60 s; no access token anywhere in the answer; no-store', async () => {
    const r = await start(admin, user);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['expiresIn', 'handoffCode', 'handoffExpiresIn', 'jti', 'reason', 'targetEmail']);
    expect(r.body.handoffCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body).toMatchObject({ handoffExpiresIn: 60, expiresIn: 1800, targetEmail: 'target@x.com', reason: 'support ticket #42' });
    expect(JSON.stringify(r.body)).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);   // no JWT
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('stores only the code\'s sha256 with a 60 s expiry, next to the 30-minute session row', async () => {
    const r = await start(admin, user);
    const row = db.prepare('SELECT * FROM impersonation_tokens WHERE jti = ?').get(r.body.jti);
    expect(row.handoff_hash).toBe(crypto.createHash('sha256').update(r.body.handoffCode).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(r.body.handoffCode);
    expect(Date.parse(row.handoff_expires_at) - Date.now()).toBeGreaterThan(55_000);
    expect(Date.parse(row.handoff_expires_at) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(1795_000);
    expect(row).toMatchObject({ admin_id: admin.id, target_id: user.id, reason: 'support ticket #42', revoked_at: null, handoff_used_at: null });
  });

  it('the audit log of impersonation is as it was: admin.user.impersonate with the reason and the jti', async () => {
    const r = await start(admin, user);
    await redeem(r.body.handoffCode);
    const rows = db.prepare("SELECT user_id, action, entity_type, entity_id, metadata FROM audit_log WHERE action LIKE 'admin.%' OR action LIKE '%imperson%'").all();
    expect(rows).toEqual([{ user_id: admin.id, action: 'admin.user.impersonate', entity_type: 'user', entity_id: user.id, metadata: JSON.stringify({ reason: 'support ticket #42', jti: r.body.jti }) }]);
  });

  it('still: support may, viewer may not, a plain user may not; never another admin; a reason is required', async () => {
    expect((await start(support, user)).status).toBe(200);
    expect((await start(viewer, user)).status).toBe(403);
    expect((await start(other, user)).status).toBe(403);
    expect((await start(admin, support)).status).toBe(403);   // the target is an admin (the check never ran before: is_admin was not selected)
    expect((await start(admin, user, 'x')).status).toBe(400);
    expect((await start(admin, { id: 999999 })).status).toBe(404);
  });
});

describe('POST /api/auth/impersonation/redeem: the code buys the session once', () => {
  it('returns the impersonated access token: the target user, flagged with the admin and the jti, ending with the session', async () => {
    const r = await start(admin, user);
    const out = await redeem(r.body.handoffCode);
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(Object.keys(out.body).sort()).toEqual(['accessToken', 'expiresIn', 'targetEmail']);
    const d = jwt.verify(out.body.accessToken, process.env.JWT_SECRET);
    expect(d).toMatchObject({ uid: user.id, imp: admin.id, jti: r.body.jti });
    const row = db.prepare('SELECT expires_at FROM impersonation_tokens WHERE jti = ?').get(r.body.jti);
    expect(Math.abs(d.exp * 1000 - Date.parse(row.expires_at))).toBeLessThan(2000);   // 30 min after the admin asked
    const me = await request(app).get('/api/auth/me').set(bearer(out.body.accessToken));
    expect(me.body.user.email).toBe('target@x.com');
  });

  it('single use: a second redeem of the same code is refused, also when two race', async () => {
    const r = await start(admin, user);
    const [a, b] = await Promise.all([redeem(r.body.handoffCode), redeem(r.body.handoffCode)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const again = await redeem(r.body.handoffCode);
    expect([again.status, again.body.code]).toEqual([400, 'INVALID_HANDOFF']);
  });

  it('60 seconds: an expired code is refused (and spent)', async () => {
    const r = await start(admin, user);
    db.prepare('UPDATE impersonation_tokens SET handoff_expires_at = ? WHERE jti = ?').run(new Date(Date.now() - 1000).toISOString(), r.body.jti);
    expect((await redeem(r.body.handoffCode)).body.code).toBe('INVALID_HANDOFF');
    expect(db.prepare('SELECT handoff_used_at FROM impersonation_tokens WHERE jti = ?').get(r.body.jti).handoff_used_at).not.toBeNull();
    // the service's own clock check, 61 s later
    const r2 = await start(admin, user);
    expect(() => imp.redeem(r2.body.handoffCode, Date.now() + 61_000)).toThrow(/Invalid or expired/);
  });

  it('a revoked session, a demoted or disabled admin, a target made admin: refused', async () => {
    const revoked = await start(admin, user);
    await request(app).post(`/api/admin/impersonations/${revoked.body.jti}/revoke`).set(bearer(admin.token));
    expect((await redeem(revoked.body.handoffCode)).status).toBe(400);

    const demoted = await start(support, user);
    db.prepare("UPDATE users SET admin_role = 'viewer' WHERE id = ?").run(support.id);
    expect((await redeem(demoted.body.handoffCode)).status).toBe(400);

    const disabled = await start(admin, user);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(admin.id);
    expect((await redeem(disabled.body.handoffCode)).status).toBe(400);
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(admin.id);

    const promoted = await start(admin, other);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(other.id);
    expect((await redeem(promoted.body.handoffCode)).status).toBe(400);
  });

  it('a malformed or unknown code: 400, nothing issued', async () => {
    for (const code of [undefined, '', 'short', 'x'.repeat(43), 'é'.repeat(43), 'a'.repeat(200)]) {
      const r = await redeem(code);
      expect(r.status, String(code)).toBe(400);
      expect(r.body.accessToken).toBeUndefined();
    }
  });

  it('the token it buys is revocable like before (authMiddleware checks the jti)', async () => {
    const r = await start(admin, user);
    const { body } = await redeem(r.body.handoffCode);
    await request(app).post(`/api/admin/impersonations/${r.body.jti}/revoke`).set(bearer(admin.token));
    const me = await request(app).get('/api/auth/me').set(bearer(body.accessToken));
    expect([me.status, me.body.code]).toEqual([401, 'IMP_REVOKED']);
  });
});

describe('the pages: no token or code in any URL', () => {
  const ops = fs.readFileSync(path.join(FRONTEND, 'ops.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');

  it('ops.js leaves the code in localStorage and opens /settings.html#impersonate=<random key>', () => {
    expect(ops).not.toMatch(/#imp=|accessToken/);
    expect(ops).toContain("localStorage.setItem(slot, JSON.stringify({ code: r.handoffCode, email }));");
    expect(ops).toContain("window.open('/settings.html#impersonate=' + key, '_blank', 'noopener');");
    expect(ops).toContain('window.crypto.getRandomValues(rnd);');
    // the code itself never goes into the opened URL
    expect(ops.slice(ops.indexOf('window.Ops.impersonate'), ops.indexOf('window.Ops.notifyUser'))).not.toMatch(/window\.open\([^)]*handoffCode/);
  });

  it('app.js takes the code out of storage before anything else, redeems by POST, never reads a token from the address', () => {
    expect(appJs).toContain("const key = 'chm_imp_handoff:' + m[1];");
    expect(appJs).toContain('try { localStorage.removeItem(key); } catch (_e) {}');
    expect(appJs).toContain("fetch(API_BASE + '/auth/impersonation/redeem', {");
    expect(appJs).toContain("sessionStorage.setItem('chm_imp_access', d.accessToken);");
    // no token or e-mail is taken from location any more (an old #imp= address is only cleaned)
    expect(appJs).not.toMatch(/\[#&\]imp=\(\[\^&\]\+\)/);
    expect(appJs).not.toMatch(/decodeURIComponent\(m\[1\]\)/);
    // until the hand-off reloads the tab: no session, the page held, the API waiting
    expect(appJs).toContain('if (impHandoff) return null;   // an impersonation hand-off in flight');
    expect(appJs).toContain('if (impHandoff) return false;   // hold the page');
    expect(appJs).toContain('if (impHandoff) return impHandoff;   // never settles');
  });
});
