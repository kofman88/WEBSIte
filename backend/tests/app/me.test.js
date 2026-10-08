/**
 * GET /api/app/me, POST /api/app/strategy, POST /api/app/settings, POST lang,
 * GET plan, GET help — the Mini App envelope on the site's JWT.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

// routes/app.js keeps the rate-limit buckets in module state; server.js loads
// it through Node's require, so the test must reach the same instance
// (a vite-node import would be a second copy with its own buckets).
const nodeRequire = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-me.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, app, ts, authService, appRouter, plan;
const NOW = () => Date.now() / 1000;

beforeAll(async () => {
  freshDb();
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = (await import('../../services/traderSettingsService.js')).default;
  plan = (await import('../../services/planService.js')).default;
  authService = (await import('../../services/authService.js')).default;
  appRouter = nodeRequire('../../routes/app.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
  appRouter.setClock(null);
});

function makeUser({ isAdmin = 0, displayName = null, givenName = null, tgName = null, locale = 'ru', active = 1 } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin, display_name, given_name, telegram_username, locale, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(e, 'x', ref, isAdmin, displayName, givenName, tgName, locale, active).lastInsertRowid;
}
const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });
const pro = (uid, days = 30) => plan.grantAccess(uid, days, { actor: 'test' });

describe('auth envelope', () => {
  it('no / bad token → 401 {ok:false, error:"unauthorized"}', async () => {
    let r = await request(app).get('/api/app/me');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
    r = await request(app).get('/api/app/me').set({ Authorization: 'Bearer nope' });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
    const disabled = makeUser({ active: 0 });
    r = await request(app).get('/api/app/me').set(H(disabled));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(r.headers['cache-control']).toBeUndefined();
  });
});

describe('GET me', () => {
  it('fresh free user: the Mini App shape, SMC/VOLUME locked, nothing enabled', async () => {
    const uid = makeUser({ displayName: 'Trader One', givenName: 'Ivan', locale: 'en' });
    const r = await request(app).get('/api/app/me').set(H(uid));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      ok: true,
      user: { id: uid, username: 'Trader One', first_name: 'Ivan', lang: 'en', plan: 'free', plan_label: 'Free', sub_expires: 0, is_pro: false },
      strategy: 'LEVELS',
      strategies: {
        LEVELS: { long: false, short: false, locked: false, primary: true, enabled: false },
        SMC: { long: false, short: false, locked: true, primary: false, enabled: false },
        VOLUME: { long: false, short: false, locked: true, primary: false, enabled: false },
      },
      extra_strategies: '',
      prefs: { progress_notify_enabled: true, send_chart_enabled: true, genome_auto_apply: false, signal_format: 'full', quiet_start: -1, quiet_end: -1 },
      auto_trade: false,
      exchange: '',
      bot_username: null,
    });
    expect(ts.get(uid)).not.toBeNull();        // created on first contact
  });
  it('pro user: is_pro, Pro label, sub_expires, telegram username fallback, nothing locked', async () => {
    const uid = makeUser({ tgName: 'tg_nick' });
    const g = pro(uid);
    const r = await request(app).get('/api/app/me').set(H(uid));
    expect(r.body.user).toMatchObject({ username: 'tg_nick', plan: 'pro', plan_label: 'Pro', is_pro: true, sub_expires: Math.trunc(g.user.sub_expires) });
    expect(r.body.strategies.SMC.locked).toBe(false);
    expect(r.body.strategies.VOLUME.locked).toBe(false);
  });
  it('an expired pro reads as free (check_access in memory) and the row is not saved by GET me', async () => {
    const uid = makeUser();
    const u = ts.getOrCreate(uid); Object.assign(u, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW() - 10, vol_long_active: true, strategy: 'VOLUME' }); ts.save(u);
    const r = await request(app).get('/api/app/me').set(H(uid));
    expect(r.body.user.plan).toBe('free');
    expect(r.body.strategy).toBe('LEVELS');            // downgraded in memory …
    expect(ts.get(uid).sub_plan).toBe('pro');          // … but persisted only by the next saving handler (quirk 9)
    expect(ts.get(uid).strategy).toBe('VOLUME');
  });
  it('admin: nothing locked on free', async () => {
    const uid = makeUser({ isAdmin: 1 });
    const r = await request(app).get('/api/app/me').set(H(uid));
    expect(r.body.user.is_pro).toBe(false);
    expect(r.body.strategies.SMC.locked).toBe(false);
  });
});

describe('POST strategy', () => {
  it('bad strategy → HTTP 400 bad_strategy', async () => {
    const uid = makeUser();
    const r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'foo', long: true });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_strategy' });
    expect((await request(app).post('/api/app/strategy').set(H(uid)).send({})).status).toBe(400);
  });
  it('free: locked strategy → pro_required; LONG+SHORT → pro_required (mutex); one direction OK, active flag set', async () => {
    const uid = makeUser();
    let r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'smc', long: true });
    expect(r.body).toEqual({ ok: false, error: 'pro_required' });
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'LEVELS', long: true, short: true });
    expect(r.body).toEqual({ ok: false, error: 'pro_required' });
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'LEVELS', long: false, short: true });
    expect(r.body.ok).toBe(true);
    expect(r.body.strategy).toBe('LEVELS');
    expect(r.body.strategies.LEVELS).toEqual({ long: false, short: true, locked: false, primary: true, enabled: true });
    expect(ts.get(uid)).toMatchObject({ short_active: true, long_active: false, active: true });
    // turning a locked strategy off is allowed (no direction wanted)
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'SMC', long: false, short: false });
    expect(r.body.ok).toBe(true);
    // Python bool(): the string "false" is truthy
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'LEVELS', long: 'false', short: 0 });
    expect(r.body.strategies.LEVELS.long).toBe(true);
  });
  it('pro: both directions, _apply_multi adds extras while the primary runs, drops the primary to the first extra', async () => {
    const uid = makeUser();
    pro(uid);
    let r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'LEVELS', long: true, short: true });
    expect(r.body.strategies.LEVELS).toMatchObject({ long: true, short: true, enabled: true });
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'SMC', long: true, short: false });
    expect(r.body.strategy).toBe('LEVELS');
    expect(ts.get(uid).extra_strategies).toBe('SMC');
    expect(r.body.strategies.SMC).toMatchObject({ long: true, short: false, primary: false, enabled: true });
    r = await request(app).post('/api/app/strategy').set(H(uid)).send({ strategy: 'LEVELS', long: false, short: false });
    expect(r.body.strategy).toBe('SMC');
    expect(ts.get(uid).extra_strategies).toBe('');
    expect(r.body.strategies.SMC.primary).toBe(true);
  });
});

describe('POST settings (profile toggles)', () => {
  it('bools, signal_format, quiet pair; genome gate; nothing_to_change → 400', async () => {
    const uid = makeUser();
    let r = await request(app).post('/api/app/settings').set(H(uid)).send({ progress_notify_enabled: 0, signal_format: 'lite', quiet_start: 22 });
    expect(r.body).toEqual({ ok: true, prefs: { progress_notify_enabled: false, send_chart_enabled: true, genome_auto_apply: false, signal_format: 'lite', quiet_start: 22, quiet_end: 7 } });
    r = await request(app).post('/api/app/settings').set(H(uid)).send({ signal_format: 'weird', quiet_end: 5 });
    expect(r.body.prefs.signal_format).toBe('full');
    expect(r.body.prefs).toMatchObject({ quiet_start: -1, quiet_end: -1 });   // only quiet_end → start -1 → off
    r = await request(app).post('/api/app/settings').set(H(uid)).send({ genome_auto_apply: true });
    expect(r.body).toEqual({ ok: false, error: 'pro_required' });
    r = await request(app).post('/api/app/settings').set(H(uid)).send({ genome_auto_apply: false, send_chart_enabled: 'x' });
    expect(r.body.prefs).toMatchObject({ genome_auto_apply: false, send_chart_enabled: true });   // bool("x") = True
    r = await request(app).post('/api/app/settings').set(H(uid)).send({ foo: 1 });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'nothing_to_change' });
    pro(uid);
    r = await request(app).post('/api/app/settings').set(H(uid)).send({ genome_auto_apply: 1 });
    expect(r.body.prefs.genome_auto_apply).toBe(true);
  });
});

describe('POST lang / GET plan / GET help', () => {
  it('lang: ru|en only; stored on the row', async () => {
    const uid = makeUser();
    let r = await request(app).post('/api/app/lang').set(H(uid)).send({ lang: 'EN' });
    expect(r.body).toEqual({ ok: true, lang: 'en' });
    expect(ts.get(uid).lang).toBe('en');
    r = await request(app).post('/api/app/lang').set(H(uid)).send({ lang: 'de' });
    expect(r.body).toEqual({ ok: false, error: 'bad_request', message: 'lang' });
    r = await request(app).post('/api/app/lang').set(H(uid)).send({});
    expect(r.body).toEqual({ ok: false, error: 'bad_request', message: 'lang' });
  });
  it('plan: free vs pro, price, features by lang, no TON, payment methods; 11th call in a minute → 429', async () => {
    const uid = makeUser();
    let r = await request(app).get('/api/app/plan').set(H(uid));
    expect(r.body).toMatchObject({ ok: true, plan: 'free', plan_label: 'Free', sub_expires: 0, days_left: 0, price_usd: 69, ton: null, admin_contact: '@crypto_chm', checkout_url: '/subscriptions.html' });
    expect(r.body.features[0]).toBe('Стратегии LEVELS + SMC + Объём/MA — можно все сразу');
    expect(Array.isArray(r.body.payment_methods)).toBe(true);
    const g = pro(uid, 10);
    const u = ts.get(uid); u.lang = 'en'; ts.save(u);
    r = await request(app).get('/api/app/plan').set(H(uid));
    expect(r.body).toMatchObject({ plan: 'pro', plan_label: 'Pro', days_left: 9, sub_expires: Math.trunc(g.user.sub_expires) });
    expect(r.body.features[0]).toBe('LEVELS + SMC + Volume/MA strategies — all at once');
    for (let i = 0; i < 8; i++) await request(app).get('/api/app/plan').set(H(uid));
    r = await request(app).get('/api/app/plan').set(H(uid));
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(r.body).toEqual({ ok: false, error: 'rate_limited', message: 'Слишком часто. Повторите через 10 с' });
    // the window slides
    appRouter.setClock(() => Date.now() / 1000 + 61);
    expect((await request(app).get('/api/app/plan').set(H(uid))).status).toBe(200);
  });
  it('help: 11 sections in the user language, HTML stripped exactly like the bot', async () => {
    // fixtures/help_plain.json: the bot's own help payload (gen/gen_help_plain.py, CPython 3.11)
    const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'fixtures', 'help_plain.json'), 'utf8'));
    const uid = makeUser();
    let r = await request(app).get('/api/app/help').set(H(uid));
    expect(r.body.lang).toBe('ru');
    expect(r.body.sections).toEqual(fx.ru);
    await request(app).post('/api/app/lang').set(H(uid)).send({ lang: 'en' });
    r = await request(app).get('/api/app/help').set(H(uid));
    expect(r.body.sections).toEqual(fx.en);
    expect(r.body.sections.map((s) => s.number)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']);
  });
  it('POST bucket: 31st POST within a minute → 429 with Retry-After 10', async () => {
    const uid = makeUser();
    for (let i = 0; i < 30; i++) {
      const r = await request(app).post('/api/app/lang').set(H(uid)).send({ lang: 'ru' });
      expect(r.status).toBe(200);
    }
    const r = await request(app).post('/api/app/lang').set(H(uid)).send({ lang: 'ru' });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('10');
    expect(r.body.error).toBe('rate_limited');
    expect((await request(app).get('/api/app/me').set(H(uid))).status).toBe(200);   // GETs are not in the bucket
    expect((await request(app).post('/api/app/lang').set(H(makeUser())).send({ lang: 'ru' })).status).toBe(200);   // per user
  });
});
