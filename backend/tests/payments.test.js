import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { decodeQrDataUrl } = require('./common/qrDecode');

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
  it('monthly prices match plans.js (pro $69; elite is a legacy alias of pro; starter is retired → unpaid)', () => {
    expect(paymentService.default.planPrice('pro', 'monthly')).toBe(69);
    expect(paymentService.default.planPrice('elite', 'monthly')).toBe(69);
    expect(() => paymentService.default.planPrice('starter', 'monthly')).toThrow(/Unpaid/);
  });
  it('yearly = monthly × 12 × 0.8 (20% off)', () => {
    expect(paymentService.default.planPrice('pro', 'yearly')).toBeCloseTo(69 * 12 * 0.8);
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
    expect(out.amountUsdt).toBeGreaterThan(69);
    expect(out.amountUsdt).toBeLessThan(71);
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
    paymentService.default.createCryptoPayment(a, { plan: 'elite', network: 'trc20' });   // legacy id → stored as pro
    paymentService.default.createCryptoPayment(b, { plan: 'pro', network: 'bep20' });
    expect(() => paymentService.default.createCryptoPayment(b, { plan: 'starter', network: 'bep20' })).toThrow(/Unpaid/);
    const list = paymentService.default.getUserPayments(a);
    expect(list).toHaveLength(2);
    expect(list.every((p) => p.userId === a)).toBe(true);
    expect(list.every((p) => p.plan === 'pro')).toBe(true);
  });
});

// ── POST /api/payments/crypto/create (the route settings.html calls) ──
// The checkout QR is drawn on this server (utils/qr.js): the deposit address of an invoice never goes
// to a third-party QR API. The page shows `qrUrl` as is; the other fields keep their names.
describe('POST /api/payments/crypto/create', () => {
  it('returns the invoice plus qrUrl: a local PNG data: URL whose QR decodes to exactly the deposit address', async () => {
    const app = (await import('../server.js')).default;
    const uid = makeUser();
    const token = jwt.sign({ uid }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    for (const [network, address] of [['bep20', process.env.PAYMENT_BEP20_ADDRESS], ['trc20', process.env.PAYMENT_TRC20_ADDRESS]]) {
      const r = await request(app).post('/api/payments/crypto/create').set('Authorization', 'Bearer ' + token).send({ plan: 'pro', network });
      expect(r.status, network).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(['address', 'amountUsdt', 'billingCycle', 'expiresAt', 'network', 'paymentId', 'plan', 'qrUrl']);
      expect(r.body.address).toBe(address);
      expect(r.body.qrUrl).toMatch(/^data:image\/png;base64,/);
      expect(decodeQrDataUrl(r.body.qrUrl)).toBe(address);
      expect(JSON.stringify(r.body)).not.toMatch(/https?:\/\//);
      expect(r.headers['cache-control'], 'the invoice is not stored by any cache').toBe('no-store');
    }
  });
});

// ── billing cycle end to end (the settings checkout's «Год −20%») ────────────
// validation.cryptoPaymentSchema used to strip billingCycle, so a yearly checkout was invoiced and
// activated as a month. Pinned for both cycles × both networks: the route's answer, the invoice row,
// the price and the activation length after the deposit is confirmed.
describe('POST /api/payments/crypto/create keeps the billing cycle: price, invoice, activation', () => {
  const CASES = [];
  for (const network of ['bep20', 'trc20']) {
    CASES.push({ network, billingCycle: 'monthly', base: 69, days: 30 });
    CASES.push({ network, billingCycle: 'yearly', base: 662.4, days: 365 });   // 69 × 12 × 0.8
  }
  const bearerFor = (uid) => 'Bearer ' + jwt.sign({ uid }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

  it.each(CASES)('$network $billingCycle → $base USDT + cents, $days days', async ({ network, billingCycle, base, days }) => {
    const app = (await import('../server.js')).default;
    const uid = makeUser();
    const r = await request(app).post('/api/payments/crypto/create').set('Authorization', bearerFor(uid)).send({ plan: 'pro', network, billingCycle });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plan: 'pro', network, billingCycle });
    // the unique-cents invoice amount on top of the cycle's price
    expect(r.body.amountUsdt).toBeGreaterThan(base);
    expect(r.body.amountUsdt).toBeLessThan(base + 1);
    expect(Number(r.body.amountUsdt.toFixed(2))).toBe(r.body.amountUsdt);
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(r.body.paymentId);
    expect(row).toMatchObject({ user_id: uid, plan: 'pro', duration_days: days, status: 'pending', method: 'usdt_' + network, amount_usd: r.body.amountUsdt });
    expect(JSON.parse(row.metadata)).toMatchObject({ network, billingCycle });
    // the deposit arrives → the plan runs for the cycle's length
    const t0 = Date.now();
    paymentService.default.confirmCryptoPayment(r.body.paymentId, { txHash: '0x' + network + billingCycle, amountUsdt: r.body.amountUsdt });
    const sub = db.prepare('SELECT plan, status, expires_at FROM subscriptions WHERE user_id = ?').get(uid);
    expect(sub).toMatchObject({ plan: 'pro', status: 'active' });
    const got = (Date.parse(sub.expires_at) - t0) / 86400_000;
    expect(got).toBeGreaterThan(days - 0.01);
    expect(got).toBeLessThan(days + 0.01);
    expect(paymentService.default.getUserPayments(uid)[0]).toMatchObject({ durationDays: days, status: 'confirmed', metadata: { billingCycle } });
  });

  it('no cycle → monthly (old clients); an unknown cycle → 400, nothing invoiced', async () => {
    const app = (await import('../server.js')).default;
    const uid = makeUser();
    const plain = await request(app).post('/api/payments/crypto/create').set('Authorization', bearerFor(uid)).send({ plan: 'pro', network: 'bep20' });
    expect(plain.body.billingCycle).toBe('monthly');
    expect(db.prepare('SELECT duration_days FROM payments WHERE id = ?').get(plain.body.paymentId).duration_days).toBe(30);
    const before = db.prepare('SELECT COUNT(*) n FROM payments').get().n;
    for (const billingCycle of ['weekly', 'YEARLY', '', 12]) {
      const r = await request(app).post('/api/payments/crypto/create').set('Authorization', bearerFor(uid)).send({ plan: 'pro', network: 'trc20', billingCycle });
      expect(r.status, String(billingCycle)).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM payments').get().n).toBe(before);
  });

  it('the schema itself keeps it (it used to strip it), the Stripe one the same way', () => {
    const v = require('../utils/validation');
    expect(v.cryptoPaymentSchema.parse({ plan: 'pro', network: 'trc20', billingCycle: 'yearly' })).toEqual({ plan: 'pro', network: 'trc20', billingCycle: 'yearly' });
    expect(v.cryptoPaymentSchema.parse({ plan: 'pro', network: 'bep20' })).toEqual({ plan: 'pro', network: 'bep20', billingCycle: 'monthly' });
    expect(v.stripeCheckoutSchema.parse({ plan: 'pro', billingCycle: 'yearly' }).billingCycle).toBe('yearly');
  });

  it('settings.html sends the chosen cycle, shows the invoice\'s own, and preselects the one subscriptions.html passes', () => {
    const front = path.join(process.cwd(), '..', 'frontend');
    const html = fs.readFileSync(path.join(front, 'settings.html'), 'utf8');
    expect(html).toContain("const billingCycle = document.querySelector('input[name=\"coCycle\"]:checked')?.value || 'monthly';");
    expect(html).toContain('await API.createCryptoPayment({ plan, network, billingCycle });');
    expect(html).toContain("const cycle = out.billingCycle === 'yearly' ? 'год' : 'месяц';");
    expect(html).toContain("const cycle = new URLSearchParams(location.search).get('cycle');");
    const subs = fs.readFileSync(path.join(front, 'subscriptions.html'), 'utf8');
    expect(subs).toContain("+ '&cycle=' + encodeURIComponent(currentCycle)");
  });
});
