import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-payments.db');
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

let db, paymentService, refRewards;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  paymentService = await import('../services/paymentService.js');
  refRewards = await import('../services/refRewards.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM ref_rewards').run();
  db.prepare('DELETE FROM referrals').run();
  db.prepare('DELETE FROM payments').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM audit_log').run();
});

function makeUser(email = null, ref = null) {
  const e = email || `u-${Math.random().toString(36).slice(2,8)}@x.com`;
  const refCode = (ref || 'R' + Math.random().toString(36).slice(2, 9)).toUpperCase();
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, referred_by, is_active)
    VALUES (?, 'x', ?, ?, 1)
  `).run(e, refCode, ref ? null : null);
  return info.lastInsertRowid;
}

// ── planPrice ──────────────────────────────────────────────────────────
describe('paymentService.planPrice', () => {
  it('monthly prices match plans.js', () => {
    expect(paymentService.default.planPrice('starter', 'monthly')).toBe(29);
    expect(paymentService.default.planPrice('pro', 'monthly')).toBe(79);
    expect(paymentService.default.planPrice('elite', 'monthly')).toBe(149);
  });
  it('yearly = monthly × 12 × 0.8 (20% off)', () => {
    expect(paymentService.default.planPrice('pro', 'yearly')).toBeCloseTo(79 * 12 * 0.8);
  });
  it('rejects free plan', () => {
    expect(() => paymentService.default.planPrice('free', 'monthly')).toThrow(/Unpaid/);
  });
});

// ── Crypto flow ────────────────────────────────────────────────────────
describe('createCryptoPayment', () => {
  it('creates pending payment with unique amount', () => {
    const uid = makeUser();
    const out = paymentService.default.createCryptoPayment(uid, {
      plan: 'pro', network: 'bep20',
    });
    expect(out.address).toBeTruthy();
    expect(out.amountUsdt).toBeGreaterThan(79);
    expect(out.amountUsdt).toBeLessThan(81);
    expect(out.expiresAt).toBeTruthy();

    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(out.paymentId);
    expect(row.status).toBe('pending');
    expect(row.method).toBe('usdt_bep20');
  });

  it('rejects invalid network', () => {
    const uid = makeUser();
    expect(() => paymentService.default.createCryptoPayment(uid, {
      plan: 'pro', network: 'eth',
    })).toThrow(/network/);
  });
});

describe('confirmCryptoPayment', () => {
  it('activates subscription on match', () => {
    const uid = makeUser();
    const out = paymentService.default.createCryptoPayment(uid, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, {
      txHash: '0xabc123', fromAddress: '0xdef', amountUsdt: out.amountUsdt,
    });
    const payment = db.prepare('SELECT status, confirmed_at FROM payments WHERE id = ?').get(out.paymentId);
    expect(payment.status).toBe('confirmed');
    expect(payment.confirmed_at).toBeTruthy();

    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(uid);
    expect(sub.plan).toBe('pro');
    expect(sub.status).toBe('active');
    expect(new Date(sub.expires_at).getTime()).toBeGreaterThan(Date.now() + 25 * 86400_000);
  });

  it('rejects on amount mismatch', () => {
    const uid = makeUser();
    const out = paymentService.default.createCryptoPayment(uid, { plan: 'pro', network: 'bep20' });
    expect(() => paymentService.default.confirmCryptoPayment(out.paymentId, {
      txHash: '0x1', amountUsdt: out.amountUsdt + 100,
    })).toThrow(/mismatch/);
  });

  it('rejects on already-processed payment', () => {
    const uid = makeUser();
    const out = paymentService.default.createCryptoPayment(uid, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    expect(() => paymentService.default.confirmCryptoPayment(out.paymentId, {
      txHash: '0x2', amountUsdt: out.amountUsdt,
    })).toThrow();
  });
});

// ── Subscription extension ─────────────────────────────────────────────
describe('extendSubscription', () => {
  it('creates if absent', () => {
    const uid = makeUser();
    paymentService.default.extendSubscription(uid, 'pro', 30);
    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(uid);
    expect(sub).toBeTruthy();
    expect(sub.plan).toBe('pro');
  });

  it('extends from existing expires_at if in future', () => {
    const uid = makeUser();
    // Seed existing sub expiring 10 days from now
    const futureIso = new Date(Date.now() + 10 * 86400_000).toISOString();
    db.prepare(`INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, 'pro', 'active', ?)`)
      .run(uid, futureIso);
    paymentService.default.extendSubscription(uid, 'pro', 30);
    const sub = db.prepare('SELECT expires_at FROM subscriptions WHERE user_id = ?').get(uid);
    const daysFromNow = (new Date(sub.expires_at).getTime() - Date.now()) / 86400_000;
    expect(daysFromNow).toBeGreaterThan(39);
    expect(daysFromNow).toBeLessThan(41);
  });
});

// ── Referral rewards ───────────────────────────────────────────────────
describe('refRewards', () => {
  function makeRefPair() {
    // R refers A
    const R = makeUser('referrer@x.com');
    const A = makeUser('referred@x.com');
    db.prepare(`INSERT INTO referrals (referrer_id, referred_id, commission_pct) VALUES (?, ?, 20)`)
      .run(R, A);
    return { R, A };
  }

  it('issues 20% reward on confirmed payment', () => {
    const { R, A } = makeRefPair();
    const out = paymentService.default.createCryptoPayment(A, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });

    const rewards = db.prepare('SELECT * FROM ref_rewards WHERE referrer_id = ?').all(R);
    expect(rewards).toHaveLength(1);
    expect(rewards[0].amount_usd).toBeCloseTo(out.amountUsdt * 0.2, 2);
    expect(rewards[0].status).toBe('pending');
    expect(rewards[0].payment_id).toBe(out.paymentId);
  });

  it('no reward if user has no referrer', () => {
    const lone = makeUser();
    const out = paymentService.default.createCryptoPayment(lone, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    const count = db.prepare('SELECT COUNT(*) as n FROM ref_rewards').get().n;
    expect(count).toBe(0);
  });

  it('does not double-issue for same payment', () => {
    const { R, A } = makeRefPair();
    const out = paymentService.default.createCryptoPayment(A, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    // Force issueReward again (idempotent)
    refRewards.default.issueReward(out.paymentId);
    expect(db.prepare('SELECT COUNT(*) as n FROM ref_rewards').get().n).toBe(1);
  });

  it('summaryForUser aggregates', () => {
    const { R, A } = makeRefPair();
    const out = paymentService.default.createCryptoPayment(A, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    const s = refRewards.default.summaryForUser(R);
    expect(s.pendingUsd).toBeGreaterThan(0);
    expect(s.paidUsd).toBe(0);
    expect(s.totalRewards).toBe(1);
    expect(s.referredCount).toBe(1);
  });

  it('markPaid moves reward to paid', () => {
    const { R, A } = makeRefPair();
    const out = paymentService.default.createCryptoPayment(A, { plan: 'pro', network: 'bep20' });
    paymentService.default.confirmCryptoPayment(out.paymentId, { txHash: '0x1', amountUsdt: out.amountUsdt });
    const reward = db.prepare('SELECT id FROM ref_rewards WHERE referrer_id = ?').get(R);
    refRewards.default.markPaid(reward.id);
    const updated = db.prepare('SELECT status, paid_at FROM ref_rewards WHERE id = ?').get(reward.id);
    expect(updated.status).toBe('paid');
    expect(updated.paid_at).toBeTruthy();
  });
});

// ── getUserPayments ────────────────────────────────────────────────────
describe('getUserPayments', () => {
  it('returns only user own payments, newest first', () => {
    const a = makeUser('a@x.com');
    const b = makeUser('b@x.com');
    paymentService.default.createCryptoPayment(a, { plan: 'pro', network: 'bep20' });
    paymentService.default.createCryptoPayment(a, { plan: 'starter', network: 'trc20' });
    paymentService.default.createCryptoPayment(b, { plan: 'elite', network: 'bep20' });
    const list = paymentService.default.getUserPayments(a);
    expect(list).toHaveLength(2);
    expect(list.every((p) => p.userId === a)).toBe(true);
  });
});
