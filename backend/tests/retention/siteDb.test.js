/**
 * The M17b retention ports on the site's own storage (default deps — no fakes below the
 * notifier): engagement reads trader_settings through traderSettingsService, delivers a
 * `reminder` notification and saves the flags; the opt-out route flips reminders_optout for the
 * caller only; drip reads trader_settings rows and marks engine_kv; the smart prompt goes
 * through the delivery facade's notifier.dispatch and checks the user's sub_plan.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { setupEnv, insertUser } from '../challenge/helpers.js';

const req = createRequire(import.meta.url);
setupEnv('retention-site');

const NOW = Date.UTC(2026, 9, 5, 8, 0, 0) / 1000;
const DAY = 86400;
let db; let app; let ts; let kv; let E; let DC; let SP; let authService; let appRouter; let delivery;
const H = (uid) => ({ Authorization: `Bearer ${authService._signAccessToken(uid)}` });

function userRow(uid, fields) {
  insertUser(db, uid);
  const u = ts.getOrCreate(uid, { now: fields.created_at || NOW - 30 * DAY });
  Object.assign(u, fields);
  ts.save(u);
  ts.invalidateCache();
  return u;
}
const notes = (uid) => db.prepare('SELECT type, title, body, link FROM notifications WHERE user_id = ? ORDER BY id').all(uid);
const silentLog = { info() {}, warning() {}, warn() {}, debug() {}, error() {} };

beforeAll(async () => {
  db = req('../../models/database.js');
  app = (await import('../../server.js')).default;
  ts = req('../../services/traderSettingsService.js');
  kv = req('../../services/engineKvService.js');
  E = req('../../services/retention/engagement.js');
  DC = req('../../services/retention/dripCampaign.js');
  SP = req('../../services/retention/smartPrompts.js');
  authService = req('../../services/authService.js');
  appRouter = req('../../routes/app.js');
  const sd = req('../../services/engine/signalDelivery.js');
  delivery = sd.localFacade(sd.createSignalDelivery({ log: silentLog }));
});

beforeEach(() => {
  E.resetDeps();
  DC.resetDeps();
  SP.resetDeps();
  appRouter.resetRateLimits();
});

describe('engagement on trader_settings + notifier', () => {
  it('one pass: a 3d reminder for the expiring Pro, nothing for the rest; flags and last_reminder_at saved', async () => {
    userRow(3101, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 2 * DAY, active: true, lang: 'en' });
    userRow(3102, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 20 * DAY, active: true });
    userRow(3103, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 2 * DAY, active: false });
    E.configure({ clock: () => NOW, log: silentLog, sleep: async () => {} });
    const r = await E.runPass();
    expect(r.sent).toBe(1);
    const n = notes(3101);
    expect(n.length).toBe(1);
    expect(n[0].type).toBe('reminder');
    expect(n[0].title).toBe('⏰ Your access expires in 3 days');
    expect(n[0].body).toContain('<code>3101</code>');
    expect(n[0].link).toBe('/app/?tab=settings&sec=plan');
    expect(notes(3102)).toEqual([]);
    expect(notes(3103)).toEqual([]);
    ts.invalidateCache();
    const u = ts.get(3101);
    expect(u.reminder_3d_sent).toBe(true);
    expect(u.last_reminder_at).toBe(NOW);
    // the 24 h anti-spam: the next pass sends nothing
    ts.invalidateCache();
    expect((await E.runPass()).sent).toBe(0);
  });

  it('a deactivated site account (dispatch user_not_found) = Forbidden → trader_settings.active = 0', async () => {
    userRow(3104, { sub_plan: 'pro', sub_status: 'trial', sub_expires: NOW + 0.5 * DAY, active: true });
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(3104);
    E.configure({ clock: () => NOW, log: silentLog, sleep: async () => {} });
    ts.invalidateCache();
    await E.runPass();
    ts.invalidateCache();
    const u = ts.get(3104);
    expect(u.active).toBe(false);
    expect(u.reminder_1d_sent).toBe(false);
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(3104);
  });
});

describe('POST /api/app/engagement/optout', () => {
  it('own button → reminders_optout = 1 (the caller\'s language); someone else\'s uid → wrong_user, nothing changes', async () => {
    userRow(3201, { lang: 'en' });
    userRow(3202, { lang: 'ru' });
    let r = await request(app).post('/api/app/engagement/optout').set(H(3201)).send({ action: 'engagement_optout:3202' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, error: 'wrong_user', show_alert: true, message: "⚠️ This action isn't for you" });
    ts.invalidateCache();
    expect(ts.get(3202).reminders_optout).toBe(false);
    r = await request(app).post('/api/app/engagement/optout').set(H(3201)).send({ action: 'engagement_optout:3201' });
    expect(r.body).toEqual({ ok: true, show_alert: true, message: '🔕 Reminders disabled. Change your mind? Message admin.' });
    ts.invalidateCache();
    expect(ts.get(3201).reminders_optout).toBe(true);
    // no / unparsable data → the caller's own id, as the bot
    r = await request(app).post('/api/app/engagement/optout').set(H(3202)).send({});
    expect(r.body.ok).toBe(true);
    ts.invalidateCache();
    expect(ts.get(3202).reminders_optout).toBe(true);
  });

  it('a caller without a trader_settings row → failed; no token → 401', async () => {
    insertUser(db, 3203);
    let r = await request(app).post('/api/app/engagement/optout').set(H(3203)).send({ action: 'engagement_optout:3203' });
    expect(r.body).toEqual({ ok: false, error: 'failed', show_alert: true, message: '❌ Не удалось обновить настройки' });
    r = await request(app).post('/api/app/engagement/optout').send({ action: 'engagement_optout:3203' });
    expect(r.status).toBe(401);
  });

  it('an opted-out user gets no reminder', async () => {
    userRow(3204, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 2 * DAY, active: true });
    await request(app).post('/api/app/engagement/optout').set(H(3204)).send({ action: 'engagement_optout:3204' });
    E.configure({ clock: () => NOW, log: silentLog, sleep: async () => {} });
    ts.invalidateCache();
    await E.runPass();
    expect(notes(3204)).toEqual([]);
  });
});

describe('drip on trader_settings rows + engine_kv', () => {
  it('day 3 of a Free user → one silent promo with the plan link, kv drip_sent_day3_<uid>; a second pass sends nothing', async () => {
    userRow(3301, { sub_plan: 'free', created_at: NOW - 2.5 * DAY });
    userRow(3302, { sub_plan: 'pro', created_at: NOW - 2.5 * DAY });
    userRow(3303, { sub_plan: 'free', created_at: NOW - 1.5 * DAY });           // day 2: no drip
    DC.configure({ clock: () => NOW, log: silentLog, sleep: async () => {} });
    await DC.runPass();
    const n = notes(3301);
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ type: 'promo', title: '📊 3 дня в боте.', link: '/app/?tab=settings&sec=plan' });
    expect(kv.get('drip_sent_day3_3301')).toBe(String(Math.trunc(NOW)));
    expect(notes(3302)).toEqual([]);
    expect(notes(3303)).toEqual([]);
    await DC.runPass();
    expect(notes(3301).length).toBe(1);
  });
});

describe('smart prompts through the delivery facade', () => {
  it('quota hit: a Free user gets the prompt once per 24 h, a Pro user never', async () => {
    userRow(3401, { sub_plan: 'free' });
    userRow(3402, { sub_plan: 'pro' });
    let T = NOW;
    SP.configure({ clock: () => T, log: silentLog });
    await SP.triggerAfterQuotaHit(delivery, 3401);
    await SP.triggerAfterQuotaHit(delivery, 3402);
    expect(notes(3401).map((x) => [x.type, x.title])).toEqual([['promo', '⏳ Лимит free тарифа достигнут.']]);
    expect(notes(3402)).toEqual([]);
    T += DAY - 1;
    await SP.triggerAfterQuotaHit(delivery, 3401);
    expect(notes(3401).length).toBe(1);
    T += 1;
    await SP.triggerAfterQuotaHit(delivery, 3401);
    expect(notes(3401).length).toBe(2);
  });
});
