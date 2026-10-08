import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-subscription.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, app, subs, authService;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  app = (await import('../server.js')).default;
  subs = (await import('../services/subscriptionService.js')).default;
  authService = (await import('../services/authService.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM promo_redemptions').run();
  db.prepare('DELETE FROM promo_codes').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

function makeUser({ isAdmin = 0 } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?)')
    .run(e, 'x', ref, isAdmin).lastInsertRowid;
}

describe('subscriptionService catalogue', () => {
  it('getPlans is derived from config/plans: free + pro, $69/month, bot matrix embedded', () => {
    const plans = subs.getPlans();
    expect(plans.map((p) => p.id)).toEqual(['free', 'pro']);
    const pro = plans[1];
    expect(pro).toMatchObject({ name: 'Pro', price: 69, interval: 'month', periodDays: 30 });
    expect(pro.features.strategies).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(pro.limits.signalsPerDay).toBe(999);
    expect(plans[0]).toMatchObject({ price: 0, interval: null });
    expect(plans[0].limits).toMatchObject({ signalsPerDay: 2, analyzePerDay: 1, autoTrade: false, bothDirections: false });
    expect(plans[0].strategies).toEqual(['levels']);
  });
});

describe('subscriptionService.getUserSubscription / limits', () => {
  it('lazily creates a free row and reports the plan', () => {
    const uid = makeUser();
    const s = subs.getUserSubscription(uid);
    expect(s.plan).toBe('free');
    expect(s.planId).toBe('free');
    expect(s.planDetails.id).toBe('free');
    expect(subs.getUserLimits(uid).signalsPerDay).toBe(2);
    expect(subs.planLimit(uid, 'analyze_per_day')).toBe(1);
    expect(subs.planLimit(uid, 'signals_per_day')).toBe(2);
  });
  it('legacy stored ids normalise (elite → pro) until v12 rewrites them', () => {
    const uid = makeUser();
    db.prepare("INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, 'elite', 'active', ?)")
      .run(uid, new Date(Date.now() + 86_400_000).toISOString());
    const s = subs.getUserSubscription(uid);
    expect(s.planId).toBe('pro');
    expect(s.planDetails.autoTrade).toBe(true);
    expect(subs.planLimit(uid, 'analyze_per_day')).toBe(999);
  });
  it('admins get the bot admin bypass on numeric limits', () => {
    const uid = makeUser({ isAdmin: 1 });
    expect(subs.planLimit(uid, 'analyze_per_day')).toBe(999999);
  });
  it('an expired paid subscription downgrades to free on read', () => {
    const uid = makeUser();
    db.prepare("INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, 'pro', 'active', ?)")
      .run(uid, new Date(Date.now() - 1000).toISOString());
    const s = subs.getUserSubscription(uid);
    expect(s.plan).toBe('free');
    expect(s.status).toBe('expired');
  });
});

describe('subscriptionService.activateSubscription', () => {
  it('stores the payment reference in payment_provider_id (no payment_tx column exists)', () => {
    const uid = makeUser();
    const s = subs.activateSubscription(uid, { plan: 'pro', paymentMethod: 'manual', paymentTx: 'TX-1' });
    expect(s.plan).toBe('pro');
    expect(s.status).toBe('active');
    const row = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(uid);
    expect(row.payment_provider_id).toBe('TX-1');
    expect(row.payment_method).toBe('manual');
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // update path
    const s2 = subs.activateSubscription(uid, { plan: 'elite', paymentMethod: 'promo', paymentTx: 'PROMO:X', durationDays: 7 });
    expect(s2.plan).toBe('pro');
    expect(db.prepare('SELECT payment_provider_id FROM subscriptions WHERE user_id = ?').get(uid).payment_provider_id).toBe('PROMO:X');
  });
  it('legacy elite activates as pro; starter and free are refused; unknown ids are refused', () => {
    const uid = makeUser();
    expect(subs.activateSubscription(uid, { plan: 'elite' }).plan).toBe('pro');
    expect(() => subs.activateSubscription(uid, { plan: 'free' })).toThrow(/free plan/);
    expect(() => subs.activateSubscription(uid, { plan: 'starter' })).toThrow(/free plan/);
    expect(() => subs.activateSubscription(uid, { plan: 'enterprise' })).toThrow(/Unknown plan/);
  });
  it('promo code path still works through the catalogue', () => {
    const uid = makeUser();
    db.prepare("INSERT INTO promo_codes (code, plan, duration_days, max_uses) VALUES ('ELITE7', 'elite', 7, 5)").run();
    const s = subs.applyPromoCode(uid, 'ELITE7');
    expect(s.plan).toBe('pro');
    expect(db.prepare('SELECT payment_provider_id FROM subscriptions WHERE user_id = ?').get(uid).payment_provider_id).toBe('PROMO:ELITE7');
  });
});

describe('GET /api/subscriptions/*', () => {
  it('/plans, /status, /limits and /usage answer with the two-plan catalogue', async () => {
    const uid = makeUser();
    const token = authService._signAccessToken(uid);
    const plansRes = await request(app).get('/api/subscriptions/plans');
    expect(plansRes.status).toBe(200);
    expect(plansRes.body.plans.map((p) => p.id)).toEqual(['free', 'pro']);

    const status = await request(app).get('/api/subscriptions/status').set('Authorization', 'Bearer ' + token);
    expect(status.status).toBe(200);
    expect(status.body.subscription.plan).toBe('free');
    expect(status.body.limits.id).toBe('free');

    const limits = await request(app).get('/api/subscriptions/limits').set('Authorization', 'Bearer ' + token);
    expect(limits.status).toBe(200);
    expect(limits.body.signalsPerDay).toBe(2);
    expect(limits.body.analyzePerDay).toBe(1);
    expect(limits.body.limits.strategies).toEqual(['levels']);

    const usage = await request(app).get('/api/subscriptions/usage').set('Authorization', 'Bearer ' + token);
    expect(usage.status).toBe(200);
    expect(usage.body.plan).toEqual({ id: 'free', name: 'Free', priceUsd: 0 });
    expect(usage.body.next.id).toBe('pro');
    expect(usage.body.next.priceUsd).toBe(69);
    expect(usage.body.next.unlocks).toContain('Стратегии: SMC, VOLUME');
    expect(usage.body.next.unlocks).toContain('LONG + SHORT одновременно');
  });
});
