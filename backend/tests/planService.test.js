/**
 * planService — subscriptions → trader_settings mirror, grant / free activation,
 * bot expiry loop A (auto-downgrade + 3d / 1d reminders as notification rows),
 * plan_changes audit, the paymentService / subscriptionService hooks.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-plan-service.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.PAYMENT_BEP20_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, ts, plan, paymentService, subs;
const NOW = 1_800_000_000;
const DAY = 86400;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  ts = (await import('../services/traderSettingsService.js')).default;
  plan = (await import('../services/planService.js')).default;
  paymentService = (await import('../services/paymentService.js')).default;
  subs = (await import('../services/subscriptionService.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
});

function makeUser() {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return db.prepare('INSERT INTO users (email, password_hash, referral_code) VALUES (?, ?, ?)').run(e, 'x', ref).lastInsertRowid;
}

function setSub(uid, plan_, status, expiresSec) {
  db.prepare('INSERT OR REPLACE INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, ?, ?, ?)')
    .run(uid, plan_, status, expiresSec ? new Date(expiresSec * 1000).toISOString() : null);
}

const changes = (uid) => db.prepare('SELECT old_plan, new_plan, actor, reason FROM plan_changes WHERE user_id = ? ORDER BY id').all(uid);
const notes = (uid) => db.prepare('SELECT type, title, body, link FROM notifications WHERE user_id = ? ORDER BY id').all(uid);

describe('effectivePlan / sync', () => {
  it('no row → free; live pro → paid; expired / inactive pro → free', () => {
    const uid = makeUser();
    expect(plan.effectivePlan(uid, { now: NOW })).toMatchObject({ plan: 'free', paid: false, expiresAt: 0 });
    setSub(uid, 'pro', 'active', NOW + DAY);
    expect(plan.effectivePlan(uid, { now: NOW })).toMatchObject({ plan: 'pro', paid: true, expiresAt: NOW + DAY });
    setSub(uid, 'pro', 'active', NOW - 1);
    expect(plan.effectivePlan(uid, { now: NOW }).paid).toBe(false);
    setSub(uid, 'elite', 'cancelled', NOW + DAY);
    expect(plan.effectivePlan(uid, { now: NOW }).paid).toBe(false);
    expect(plan.toUnixSeconds('2026-01-02 03:04:05')).toBe(Math.floor(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000));
    expect(plan.toUnixSeconds('junk')).toBe(0);
  });
  it('sync writes the mirror for a live subscription (reminder flags reset, plan_changes logged) and is idempotent', async () => {
    const uid = makeUser();
    const u = ts.getOrCreate(uid);
    u.reminder_3d_sent = true; u.expired_notified = true; ts.save(u);
    setSub(uid, 'elite', 'active', NOW + 20 * DAY);
    const s = await plan.sync(uid, { now: NOW });
    expect(s).toMatchObject({ sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 20 * DAY, reminder_3d_sent: false, expired_notified: false });
    expect(changes(uid)).toEqual([{ old_plan: 'free', new_plan: 'pro', actor: 'system:sync', reason: 'subscriptions mirror' }]);
    // extension of a live plan: expiry follows, flags untouched, no new audit row
    s.reminder_3d_sent = true; ts.save(s);
    setSub(uid, 'pro', 'active', NOW + 50 * DAY);
    const s2 = await plan.sync(uid, { now: NOW });
    expect(s2.sub_expires).toBe(NOW + 50 * DAY);
    expect(s2.reminder_3d_sent).toBe(true);
    expect(changes(uid).length).toBe(1);
  });
  it('sync on a dead subscription while the mirror says pro → loop-A downgrade (+ "expired" text); free stays free; banned untouched', async () => {
    const uid = makeUser();
    setSub(uid, 'pro', 'active', NOW + DAY);
    await plan.sync(uid, { now: NOW });
    setSub(uid, 'pro', 'active', NOW + DAY);              // keep the row, run past the expiry
    const s = await plan.sync(uid, { now: NOW + 2 * DAY });
    expect(s).toMatchObject({ sub_plan: 'free', sub_status: 'active', long_active: true, expired_notified: true });
    expect(s.sub_expires).toBe(NOW + 2 * DAY + 365 * DAY);
    expect(db.prepare('SELECT plan, status FROM subscriptions WHERE user_id = ?').get(uid)).toEqual({ plan: 'free', status: 'expired' });
    expect(notes(uid)).toEqual([{ type: 'plan', title: '⏳ Подписка истекла', body: expect.stringContaining('Вы переведены на 🆓 Free план'), link: '/subscriptions.html' }]);
    expect(changes(uid).map((c) => c.actor)).toEqual(['system:sync', 'system:auto_downgrade']);
    const free = makeUser();
    const f = await plan.sync(free, { now: NOW });
    expect(f).toMatchObject({ sub_plan: 'free', sub_status: 'expired' });
    const banned = makeUser();
    const b = ts.getOrCreate(banned); b.sub_status = 'banned'; b.sub_plan = 'pro'; ts.save(b);
    setSub(banned, 'pro', 'active', NOW + DAY);
    expect((await plan.sync(banned, { now: NOW })).sub_status).toBe('banned');
  });
});

describe('grantAccess / activateFree', () => {
  it('grant: bot base rule, sub_plan set, both tables written, audit row', () => {
    const uid = makeUser();
    const r = plan.grantAccess(uid, 30, { actor: 'admin:1', reason: 'test', now: NOW });
    expect(r.ok).toBe(true);
    expect(r.user).toMatchObject({ sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 30 * DAY });
    expect(plan.effectivePlan(uid, { now: NOW })).toMatchObject({ paid: true, expiresAt: NOW + 30 * DAY });
    expect(changes(uid)).toEqual([{ old_plan: 'free', new_plan: 'pro', actor: 'admin:1', reason: 'test' }]);
    // live → extends from the current expiry
    const r2 = plan.grantAccess(uid, 10, { now: NOW + DAY });
    expect(r2.user.sub_expires).toBe(NOW + 40 * DAY);
    expect(changes(uid).length).toBe(1);                   // pro → pro is a no-op in the audit
    // banned
    const b = ts.get(uid); b.sub_status = 'banned'; ts.save(b);
    expect(plan.grantAccess(uid, 10, { now: NOW })).toMatchObject({ ok: false, error: 'banned' });
    expect(plan.logPlanChange(uid, 'pro', 'pro')).toBe(false);
    plan.logPlanChange(uid, 'a', 'b', { actor: 'x'.repeat(100), reason: 'y'.repeat(300) });
    const last = changes(uid).pop();
    expect(last.actor.length).toBe(64);
    expect(last.reason.length).toBe(256);
  });
  it('activateFree: 365 d free-active, LONG on, onboarding done; refused on a live pro', () => {
    const uid = makeUser();
    const r = plan.activateFree(uid, { now: NOW });
    expect(r.ok).toBe(true);
    expect(r.user).toMatchObject({ sub_plan: 'free', sub_status: 'active', sub_expires: NOW + 365 * DAY, long_active: true, strategy: 'LEVELS', onboarding_done: true });
    expect(db.prepare('SELECT plan, status, expires_at FROM subscriptions WHERE user_id = ?').get(uid)).toEqual({ plan: 'free', status: 'active', expires_at: null });
    expect(changes(uid)).toEqual([]);                      // free → free: no audit row
    plan.grantAccess(uid, 30, { now: NOW });
    expect(plan.activateFree(uid, { now: NOW })).toMatchObject({ ok: false, error: 'already_pro', plan_label: '⭐ Pro' });
  });
});

describe('runExpiryLoop (bot loop A)', () => {
  it('downgrades expired paid users (free, active, +365 d, LONG on, flags reset, "expired" text) and skips the rest', async () => {
    const uid = makeUser();
    plan.grantAccess(uid, 30, { now: NOW });
    const u = ts.get(uid); u.strategy = ''; u.reminder_3d_sent = true; u.reminder_1d_sent = true; ts.save(u);
    const out = await plan.runExpiryLoop({ now: NOW + 31 * DAY });
    expect(out.downgraded).toEqual([uid]);
    const s = ts.get(uid);
    expect(s).toMatchObject({ sub_plan: 'free', sub_status: 'active', long_active: true, strategy: 'LEVELS', reminder_3d_sent: false, reminder_1d_sent: false, expired_notified: true });
    expect(s.sub_expires).toBe(NOW + 31 * DAY + 365 * DAY);
    expect(notes(uid).map((n) => n.title)).toEqual(['⏳ Подписка истекла']);
    expect(changes(uid).pop()).toEqual({ old_plan: 'pro', new_plan: 'free', actor: 'system:auto_downgrade', reason: 'sub_expires elapsed' });
    // a second run: free users are never downgraded again
    const out2 = await plan.runExpiryLoop({ now: NOW + 400 * DAY });
    expect(out2.downgraded).toEqual([]);
    expect(notes(uid).length).toBe(1);
  });
  it('3d reminder, then the 1d reminder one run later (elif quirk), each once; trial users get reminders but no loop-A downgrade', async () => {
    const uid = makeUser();
    plan.grantAccess(uid, 30, { now: NOW });
    expect((await plan.runExpiryLoop({ now: NOW + 20 * DAY })).reminded3d).toEqual([]);
    const a = await plan.runExpiryLoop({ now: NOW + 29.5 * DAY });     // 12 h left: inside both windows
    expect(a.reminded3d).toEqual([uid]);
    expect(a.reminded1d).toEqual([]);
    const b = await plan.runExpiryLoop({ now: NOW + 29.5 * DAY + 3600 });
    expect(b.reminded3d).toEqual([]);
    expect(b.reminded1d).toEqual([uid]);
    const c = await plan.runExpiryLoop({ now: NOW + 29.5 * DAY + 7200 });
    expect(c).toEqual({ downgraded: [], reminded3d: [], reminded1d: [] });
    expect(notes(uid).map((n) => n.title)).toEqual(['⏰ Pro заканчивается через 3 дня.', '⚠️ Pro заканчивается завтра.']);
    expect(notes(uid)[0].body).toContain('Вопросы: @crypto_chm');
    // trial: reminded, never downgraded by loop A
    const t = makeUser();
    const tu = ts.getOrCreate(t); Object.assign(tu, { sub_plan: 'pro', sub_status: 'trial', sub_expires: NOW + 2 * DAY, lang: 'en' }); ts.save(tu);
    const d = await plan.runExpiryLoop({ now: NOW });
    expect(d.reminded3d).toEqual([t]);
    expect(notes(t)[0].title).toBe('⏰ Pro ends in 3 days.');
    const e = await plan.runExpiryLoop({ now: NOW + 3 * DAY });
    expect(e.downgraded).toEqual([]);
    expect(ts.get(t).sub_plan).toBe('pro');
    expect((await plan.runExpiryLoop({ now: NOW, notify: false })).reminded3d).toEqual([]);
  });
  it('reminder texts are the bot texts verbatim (ru / en)', () => {
    expect(plan.reminderText('3d', 'ru')).toBe('⏰ <b>Pro заканчивается через 3 дня.</b>\nПродлить можно прямо здесь: счёт ниже, или в приложении → Тариф. Вопросы: @crypto_chm');
    expect(plan.reminderText('1d', 'en', '@x')).toBe('⚠️ <b>Pro ends tomorrow.</b>\nAfter that Free applies: 2 LEVELS signals a day. Renewal invoice below; questions: @x');
    expect(plan.reminderText('expired', 'ru')).toBe('⏳ <b>Подписка истекла</b>\n\nВы переведены на 🆓 <b>Free план</b>: 2 сигнала LEVELS в день, одно направление.\n\n⭐ Pro $69/мес вернёт все три стратегии, LONG + SHORT, автотрейд и полное приложение. Вопросы: @crypto_chm');
    expect(plan.reminderText('expired', 'en')).toBe('⏳ <b>Your subscription has expired</b>\n\nYou are on the 🆓 <b>Free plan</b>: 2 LEVELS signals a day, one direction.\n\n⭐ Pro $69/mo brings back all three strategies, LONG + SHORT, auto-trade and the full app. Questions: @crypto_chm');
    expect(() => plan.reminderText('7d')).toThrow();
    expect(plan.PLAN_FEATURES_TEXT.ru.length).toBe(8);
    expect(plan.paymentMethods().map((m) => m.id)).toContain('usdt_bep20');
  });
});

describe('site hooks → mirror', () => {
  it('paymentService.extendSubscription and subscriptionService.activateSubscription sync trader_settings', async () => {
    const uid = makeUser();
    paymentService.extendSubscription(uid, 'pro', 30);
    await new Promise((r) => setTimeout(r, 20));
    expect(ts.get(uid)).toMatchObject({ sub_plan: 'pro', sub_status: 'active' });
    expect(ts.get(uid).sub_expires).toBeGreaterThan(Date.now() / 1000 + 29 * DAY);
    const uid2 = makeUser();
    subs.activateSubscription(uid2, { plan: 'elite', durationDays: 7 });
    await new Promise((r) => setTimeout(r, 20));
    expect(ts.get(uid2)).toMatchObject({ sub_plan: 'pro', sub_status: 'active' });
    expect(plan.can(uid2, 'smc')).toBe(true);
    expect(plan.planLimit(uid2, 'analyze_per_day')).toBe(999);
    expect(plan.isMutualExclusionRequired(uid2)).toBe(false);
    expect(plan.isMutualExclusionRequired(uid)).toBe(false);
    expect(plan.can(makeUser(), 'smc')).toBe(false);
  });
});
