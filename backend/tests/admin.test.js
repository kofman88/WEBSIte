import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-admin.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';
process.env.PAYMENT_BEP20_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
process.env.PAYMENT_TRC20_ADDRESS = 'TRx1234567890abcdefgh1234567890abcd';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, app, admin, paymentService, authService;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  app = (await import('../server.js')).default;
  admin = (await import('../services/adminService.js')).default || await import('../services/adminService.js');
  paymentService = (await import('../services/paymentService.js')).default;
  authService = (await import('../services/authService.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM ref_rewards').run();
  db.prepare('DELETE FROM referrals').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM promo_redemptions').run();
  db.prepare('DELETE FROM promo_codes').run();
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM users').run();
});

function makeUser({ email = null, isAdmin = 0, isActive = 1 } = {}) {
  const e = email || `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_admin, is_active)
    VALUES (?, 'x', ?, ?, ?)
  `).run(e, ref, isAdmin, isActive);
  return info.lastInsertRowid;
}

function tokenFor(userId) {
  return authService._signAccessToken(userId);
}

// ── Users ──────────────────────────────────────────────────────────────
describe('adminService.listUsers', () => {
  it('returns users with join data', () => {
    const a = makeUser({ email: 'alice@x.com' });
    makeUser({ email: 'bob@x.com' });
    db.prepare("INSERT INTO subscriptions (user_id, plan, status) VALUES (?, 'pro', 'active')").run(a);
    const out = admin.listUsers();
    expect(out.total).toBe(2);
    expect(out.users.find((u) => u.email === 'alice@x.com').plan).toBe('pro');
    expect(out.users.find((u) => u.email === 'bob@x.com').plan).toBe('free');
  });

  it('filters by search (email substring)', () => {
    makeUser({ email: 'alice@x.com' });
    makeUser({ email: 'bob@x.com' });
    const out = admin.listUsers({ search: 'alice' });
    expect(out.total).toBe(1);
    expect(out.users[0].email).toBe('alice@x.com');
  });
});

describe('adminService.setUserActive', () => {
  it('deactivates user + pauses bots + revokes refresh tokens', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const u = makeUser();
    db.prepare(`
      INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy, is_active)
      VALUES (?, 'b1', 'bybit', '["BTC/USDT"]', 'scalping', 1)
    `).run(u);
    db.prepare(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES (?, 'h1', datetime('now', '+7 days'))
    `).run(u);

    admin.setUserActive(u, false, { adminId: adminUid });

    const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(u);
    expect(user.is_active).toBe(0);
    const bot = db.prepare('SELECT is_active FROM trading_bots WHERE user_id = ?').get(u);
    expect(bot.is_active).toBe(0);
    const tok = db.prepare('SELECT revoked_at FROM refresh_tokens WHERE user_id = ?').get(u);
    expect(tok.revoked_at).toBeTruthy();

    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'admin.user.deactivate'").get();
    expect(entry.entity_id).toBe(u);
  });

  it('throws 404 for missing user', () => {
    expect(() => admin.setUserActive(99999, false)).toThrow(/not found/);
  });
});

describe('adminService.setUserPlan', () => {
  it('extends subscription and writes audit entry', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const u = makeUser();
    admin.setUserPlan(u, 'pro', { adminId: adminUid, durationDays: 30 });
    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(u);
    expect(sub.plan).toBe('pro');
    expect(sub.status).toBe('active');
    const log = db.prepare("SELECT * FROM audit_log WHERE action = 'admin.user.set_plan'").get();
    expect(log.entity_id).toBe(u);
  });
});

// ── Payments ───────────────────────────────────────────────────────────
describe('adminService.manualConfirmPayment', () => {
  it('confirms pending payment and activates subscription', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const u = makeUser();
    const out = paymentService.createCryptoPayment(u, { plan: 'pro', network: 'bep20' });
    admin.manualConfirmPayment(out.paymentId, { adminId: adminUid, note: 'manual' });
    const p = db.prepare('SELECT status FROM payments WHERE id = ?').get(out.paymentId);
    expect(p.status).toBe('confirmed');
    const sub = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(u);
    expect(sub.plan).toBe('pro');
  });

  it('rejects already-confirmed payment', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const u = makeUser();
    const out = paymentService.createCryptoPayment(u, { plan: 'pro', network: 'bep20' });
    paymentService.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    expect(() => admin.manualConfirmPayment(out.paymentId, { adminId: adminUid })).toThrow(/already/);
  });
});

describe('adminService.refundPayment', () => {
  it('marks payment refunded and cancels associated ref reward', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const referrer = makeUser({ email: 'ref@x.com' });
    const buyer = makeUser({ email: 'buyer@x.com' });
    db.prepare('INSERT INTO referrals (referrer_id, referred_id, commission_pct) VALUES (?, ?, 20)')
      .run(referrer, buyer);

    const out = paymentService.createCryptoPayment(buyer, { plan: 'pro', network: 'bep20' });
    paymentService.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });

    const reward = db.prepare('SELECT * FROM ref_rewards WHERE payment_id = ?').get(out.paymentId);
    expect(reward.status).toBe('pending');

    admin.refundPayment(out.paymentId, { adminId: adminUid, reason: 'chargeback' });

    const p = db.prepare('SELECT status FROM payments WHERE id = ?').get(out.paymentId);
    expect(p.status).toBe('refunded');
    const r = db.prepare('SELECT status FROM ref_rewards WHERE id = ?').get(reward.id);
    expect(r.status).toBe('cancelled');
  });
});

// ── Promo codes ────────────────────────────────────────────────────────
describe('adminService promo CRUD', () => {
  it('create → list → disable → delete lifecycle', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const created = admin.createPromoCode(
      { code: 'test50', plan: 'pro', durationDays: 30, maxUses: 100, discountPct: 50 },
      { adminId: adminUid },
    );
    expect(created.code).toBe('TEST50');

    const list = admin.listPromoCodes();
    expect(list.some((p) => p.code === 'TEST50')).toBe(true);

    admin.setPromoActive(created.id, false, { adminId: adminUid });
    const after = admin.listPromoCodes().find((p) => p.id === created.id);
    expect(after.isActive).toBe(false);

    admin.deletePromo(created.id, { adminId: adminUid });
    expect(admin.listPromoCodes().find((p) => p.id === created.id)).toBeUndefined();
  });

  it('rejects duplicate code', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    admin.createPromoCode(
      { code: 'DUP', plan: 'pro', durationDays: 30, maxUses: 1, discountPct: 100 },
      { adminId: adminUid },
    );
    expect(() => admin.createPromoCode(
      { code: 'dup', plan: 'pro', durationDays: 30, maxUses: 1, discountPct: 100 },
      { adminId: adminUid },
    )).toThrow(/exists/);
  });
});

// ── System stats & audit ───────────────────────────────────────────────
describe('adminService.systemStats', () => {
  it('returns aggregated counts', () => {
    const u = makeUser();
    db.prepare("INSERT INTO subscriptions (user_id, plan, status) VALUES (?, 'pro', 'active')").run(u);
    db.prepare(`
      INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy, is_active)
      VALUES (?, 'b', 'bybit', '["BTC/USDT"]', 'scalping', 1)
    `).run(u);
    const out = paymentService.createCryptoPayment(u, { plan: 'pro', network: 'bep20' });
    paymentService.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });

    const s = admin.systemStats();
    expect(s.users.total).toBe(1);
    expect(s.users.active).toBe(1);
    expect(s.subscriptions.pro).toBe(1);
    expect(s.bots.total).toBe(1);
    expect(s.bots.active).toBe(1);
    expect(s.payments.total).toBe(1);
    expect(s.payments.revenue).toBeGreaterThan(0);
  });
});

describe('adminService.auditLog', () => {
  it('filters by action and entityType', () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const u = makeUser();
    admin.setUserActive(u, false, { adminId: adminUid });
    admin.setUserPlan(u, 'pro', { adminId: adminUid });

    const all = admin.auditLog({});
    expect(all.length).toBeGreaterThanOrEqual(2);

    const deacts = admin.auditLog({ action: 'deactivate' });
    expect(deacts.length).toBe(1);
    expect(deacts[0].action).toBe('admin.user.deactivate');

    const users = admin.auditLog({ entityType: 'user' });
    expect(users.length).toBeGreaterThanOrEqual(2);
  });
});

// ── HTTP: access control ───────────────────────────────────────────────
describe('admin routes access control', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const u = makeUser({ isAdmin: 0 });
    const res = await request(app).get('/api/admin/stats')
      .set('Authorization', `Bearer ${tokenFor(u)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('allows admin users through', async () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const res = await request(app).get('/api/admin/stats')
      .set('Authorization', `Bearer ${tokenFor(adminUid)}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toBeTruthy();
  });

  it('POST /promo-codes as admin creates + returns 201', async () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const res = await request(app).post('/api/admin/promo-codes')
      .set('Authorization', `Bearer ${tokenFor(adminUid)}`)
      .send({ code: 'HTTP10', plan: 'pro', durationDays: 30, maxUses: 10, discountPct: 50 });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('HTTP10');
  });

  it('PATCH /users/:id/active as admin deactivates', async () => {
    const adminUid = makeUser({ isAdmin: 1 });
    const target = makeUser();
    const res = await request(app).patch(`/api/admin/users/${target}/active`)
      .set('Authorization', `Bearer ${tokenFor(adminUid)}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    const row = db.prepare('SELECT is_active FROM users WHERE id = ?').get(target);
    expect(row.is_active).toBe(0);
  });
});
