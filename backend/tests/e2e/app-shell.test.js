import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createStubServer, STRATS } from '../../utils/app-stub.js';

// M11 — the web app shell (frontend/app) against the /api/app contract stub.
// The stub mirrors miniapp/API.md + ui-inventory.md §6; these tests pin the
// pieces the SPA relies on (envelope, auth, shapes) and the static wiring
// (/app/ → frontend/app/index.html, no Telegram glue left in the bundle).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');
const APP_DIR = path.join(FRONTEND, 'app');
const app = createStubServer({ staticDir: FRONTEND });

async function login(email = 'demo@chm.local', password = 'demo1234') {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  expect(r.status).toBe(200);
  return r.body;
}
const bearer = (tok) => ({ Authorization: 'Bearer ' + tok });

describe('static shell: /app/ is frontend/app/index.html', () => {
  it('serves the SPA shell at /app/ and redirects /app → /app/', async () => {
    const r = await request(app).get('/app/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('id="tabbar"');
    expect(r.text).toContain('data-tab="profile"');
    expect(r.text).toContain('Включите JavaScript, чтобы открыть приложение.');
    const r2 = await request(app).get('/app');
    expect([301, 302]).toContain(r2.status);
    expect(r2.headers.location).toBe('/app/');
  });
  it('ships app.js / app.css / splash.js / chart.js next to the page', async () => {
    for (const f of ['app.js', 'app.css', 'splash.js', 'chart.js']) {
      const r = await request(app).get('/app/' + f);
      expect(r.status, f).toBe(200);
    }
  });
  it('has no Telegram WebApp glue left', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
    const splash = fs.readFileSync(path.join(APP_DIR, 'splash.js'), 'utf8');
    expect(html).not.toContain('telegram-web-app.js');
    for (const needle of ['X-Telegram-Init-Data', 'Telegram.WebApp', 'openTelegramLink', 'BackButton', 'HapticFeedback', 'initData']) {
      expect(js, needle).not.toContain(needle);
      expect(splash, needle).not.toContain(needle);
    }
    expect(js).toContain('var API_BASE = "/api/app/"');
    expect(js).toContain('"Bearer " + tok');
    expect(js).toContain('AUTH_BASE + "refresh"');
    expect(js).toContain('history.pushState');
    expect(js).toContain('popstate');
    expect(splash).toContain('navigator.vibrate');
  });
  it('keeps the Mini App screens and the checkout link', () => {
    const js = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
    for (const text of ['heading("Сигналы", "center")', 'heading("Анализ", "center")', 'heading("Профиль", "center")',
      '"Тихие часы (UTC)"', '"Авто-применение генома"', 'id: "advanced", t: "Расширенные настройки"', '"Выйти"',
      'var CHECKOUT_URL = "/subscriptions.html"', 'TODO(pricing)', '?demo=1|pro|empty']) {
      expect(js, text).toContain(text);
    }
    // texts that only made sense inside Telegram are gone
    for (const text of ['Оформить Pro в боте', 'Открыть в боте', 'Оплата в TON', 'tonRow(']) expect(js, text).not.toContain(text);
  });
});

describe('/api/app auth: site JWT, envelope', () => {
  it('rejects a missing / unknown bearer with the Mini App 401 envelope', async () => {
    const r = await request(app).get('/api/app/me');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ ok: false, error: 'unauthorized' });
    const r2 = await request(app).get('/api/app/me').set(bearer('acc.nope'));
    expect(r2.status).toBe(401);
  });
  it('login → me / dashboard with the documented shapes', async () => {
    const s = await login();
    expect(s.accessToken).toMatch(/^acc\./);
    expect(s.refreshToken).toMatch(/^ref\./);
    const me = await request(app).get('/api/app/me').set(bearer(s.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.ok).toBe(true);
    expect(me.body.user).toMatchObject({ plan: 'free', plan_label: 'Free', is_pro: false, lang: 'ru' });
    expect(Object.keys(me.body.strategies).sort()).toEqual([...STRATS].sort());
    expect(me.body.strategies.SMC.locked).toBe(true);
    expect(me.body.prefs).toHaveProperty('quiet_start');
    const d = await request(app).get('/api/app/dashboard').set(bearer(s.accessToken));
    expect(d.body.ok).toBe(true);
    for (const k of ['stats', 'market', 'recent', 'trend', 'rating', 'market_trend']) expect(d.body, k).toHaveProperty(k);
    expect(d.body.stats).toMatchObject({ days: 30 });
    expect(Array.isArray(d.body.stats.equity)).toBe(true);
    expect(d.body.market_trend['15m']).toMatchObject({ trend: 'LONG', ema: '50/200' });
  });
  it('refresh rotation: an expired access token is refreshed once, a dead refresh token is 401', async () => {
    const s = await login();
    await request(app).post('/api/auth/__stub/expire-access');
    expect((await request(app).get('/api/app/me').set(bearer(s.accessToken))).status).toBe(401);
    const r = await request(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken });
    expect(r.status).toBe(200);
    expect(r.body.accessToken).not.toBe(s.accessToken);
    expect((await request(app).get('/api/app/me').set(bearer(r.body.accessToken))).status).toBe(200);
    // rotation: the old refresh token is gone
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: s.refreshToken })).status).toBe(401);
  });
  it('2FA: login answers twoFactorRequired, verify-login completes', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: '2fa@chm.local', password: 'demo1234' });
    expect(r.body).toMatchObject({ twoFactorRequired: true });
    const bad = await request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: r.body.pendingToken, code: '123456' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_2FA');
    const ok = await request(app).post('/api/auth/2fa/verify-login').send({ pendingToken: r.body.pendingToken, code: '000000' });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });
  it('X-Demo-Plan previews the other plan for the same account; /api/auth/me; disabled account → 403 envelope', async () => {
    const s = await login();
    const me = await request(app).get('/api/app/me').set(bearer(s.accessToken)).set('X-Demo-Plan', 'pro');
    expect(me.body.user).toMatchObject({ plan: 'pro', is_pro: true });
    expect((await request(app).get('/api/app/me').set(bearer(s.accessToken))).body.user.plan).toBe('free');
    const am = await request(app).get('/api/auth/me').set(bearer(s.accessToken));
    expect(am.body.user).toMatchObject({ email: 'demo@chm.local', plan: 'free' });
    await request(app).post('/api/auth/__stub/disable').send({ email: 'empty@chm.local', disabled: true });
    const d = await login('empty@chm.local');
    const r = await request(app).get('/api/app/me').set(bearer(d.accessToken));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: 'unauthorized', code: 'ACCOUNT_DISABLED' });
    await request(app).post('/api/auth/__stub/disable').send({ email: 'empty@chm.local', disabled: false });
  });
  it('register validates like the site (8+ chars, letter + digit) and refuses a taken email', async () => {
    expect((await request(app).post('/api/auth/register').send({ email: 'x@y.z', password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ email: 'demo@chm.local', password: 'demo1234' })).status).toBe(409);
    const ok = await request(app).post('/api/auth/register').send({ email: 'new@chm.local', password: 'pass1234' });
    expect(ok.status).toBe(201);
    expect(ok.body.accessToken).toBeTruthy();
  });
  it('providers + telegram login', async () => {
    const p = await request(app).get('/api/auth/oauth/providers');
    expect(p.body.telegram).toMatchObject({ enabled: true, username: 'CHMUP_bot' });
    const bad = await request(app).post('/api/auth/oauth/telegram').send({ id: 1, first_name: 'A', auth_date: 1, hash: 'bad'.padEnd(40, 'x') });
    expect(bad.status).toBe(401);
    const ok = await request(app).post('/api/auth/oauth/telegram').send({ id: 42, first_name: 'A', username: 'a', auth_date: 1, hash: 'f'.repeat(64) });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });
});

describe('/api/app contract (miniapp/API.md one-to-one)', () => {
  let tok, proTok;
  beforeAll(async () => {
    tok = (await login()).accessToken;
    proTok = (await login('pro@chm.local')).accessToken;
  });
  it('signals: status filter, strategy filter, limit', async () => {
    const all = await request(app).get('/api/app/signals?status=all&limit=50').set(bearer(proTok));
    expect(all.body.ok).toBe(true);
    expect(all.body.strategy).toBe('ALL');
    expect(all.body.signals.length).toBeGreaterThan(5);
    const open = await request(app).get('/api/app/signals?status=open&limit=50').set(bearer(proTok));
    expect(open.body.signals.every((s) => ['open', 'tp1', 'tp2'].includes(s.status))).toBe(true);
    const closed = await request(app).get('/api/app/signals?status=closed&limit=2').set(bearer(proTok));
    expect(closed.body.signals.length).toBe(2);
    expect(closed.body.signals.every((s) => !['open', 'tp1', 'tp2'].includes(s.status))).toBe(true);
    const smc = await request(app).get('/api/app/signals?status=all&strategy=SMC').set(bearer(proTok));
    expect(smc.body.strategy).toBe('SMC');
    expect(smc.body.signals.every((s) => s.strategy === 'SMC')).toBe(true);
    for (const s of all.body.signals) {
      for (const k of ['id', 'symbol', 'pair', 'direction', 'strategy', 'timeframe', 'entry', 'sl', 'sl0', 'tp1', 'tp2', 'tp3', 'quality', 'created_at', 'status']) expect(s, k).toHaveProperty(k);
    }
  });
  it('signals/:id/chart returns candles + overlays (D3), 404 for a foreign id', async () => {
    const list = (await request(app).get('/api/app/signals?status=all').set(bearer(proTok))).body.signals;
    const r = await request(app).get('/api/app/signals/' + encodeURIComponent(list[0].id) + '/chart').set(bearer(proTok));
    expect(r.body.ok).toBe(true);
    expect(r.body.candles.length).toBeGreaterThan(60);
    expect(r.body.overlays).toMatchObject({ entry: list[0].entry, sl: list[0].sl });
    expect(r.body.overlays.tps.length).toBe(3);
    const nf = await request(app).get('/api/app/signals/nope/chart').set(bearer(proTok));
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ ok: false, error: 'not_found' });
  });
  it('signals/:id/result: manual result + note, already_set', async () => {
    const list = (await request(app).get('/api/app/signals?status=open').set(bearer(tok))).body.signals;
    const id = encodeURIComponent(list[0].id);
    const r = await request(app).post('/api/app/signals/' + id + '/result').send({ result: 'TP1' }).set(bearer(tok));
    expect(r.body.ok).toBe(true);
    expect(r.body.signal.status).toBe('tp1');
    expect(r.body.signal.rr).toBeCloseTo(1.5, 2);
    const again = await request(app).post('/api/app/signals/' + id + '/result').send({ result: 'SL' }).set(bearer(tok));
    expect(again.body).toMatchObject({ ok: false, error: 'already_set' });
    const note = await request(app).post('/api/app/signals/' + id + '/result').send({ note: 'вошёл по рынку' }).set(bearer(tok));
    expect(note.body.signal.note).toBe('вошёл по рынку');
    const empty = await request(app).post('/api/app/signals/' + id + '/result').send({}).set(bearer(tok));
    expect(empty.body).toMatchObject({ ok: false, error: 'bad_request', message: 'result' });
  });
  it('strategy: free mutex and locked strategies → pro_required (HTTP 200), bad strategy → 400', async () => {
    const both = await request(app).post('/api/app/strategy').send({ strategy: 'LEVELS', long: true, short: true }).set(bearer(tok));
    expect(both.status).toBe(200);
    expect(both.body).toEqual({ ok: false, error: 'pro_required' });
    const smc = await request(app).post('/api/app/strategy').send({ strategy: 'SMC', long: true, short: false }).set(bearer(tok));
    expect(smc.body).toEqual({ ok: false, error: 'pro_required' });
    const bad = await request(app).post('/api/app/strategy').send({ strategy: 'XXX', long: true }).set(bearer(tok));
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/app/strategy').send({ strategy: 'LEVELS', long: false, short: true }).set(bearer(tok));
    expect(ok.body.ok).toBe(true);
    expect(ok.body.strategies.LEVELS).toMatchObject({ long: false, short: true, enabled: true });
  });
  it('settings: prefs + quiet hours normalisation; nothing_to_change → 400', async () => {
    const r = await request(app).post('/api/app/settings').send({ quiet_start: 22, quiet_end: 22, signal_format: 'lite' }).set(bearer(tok));
    expect(r.body.ok).toBe(true);
    expect(r.body.prefs).toMatchObject({ quiet_start: 22, quiet_end: 7, signal_format: 'lite' });
    const none = await request(app).post('/api/app/settings').send({ foo: 1 }).set(bearer(tok));
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('nothing_to_change');
    const g = await request(app).post('/api/app/settings').send({ genome_auto_apply: true }).set(bearer(tok));
    expect(g.body).toEqual({ ok: false, error: 'pro_required' });
  });
  it('settings/all: GET shape, locked keys for Free, POST partial body + D9 extras', async () => {
    const r = await request(app).get('/api/app/settings/all').set(bearer(tok));
    expect(r.body.ok).toBe(true);
    for (const k of ['lang', 'ui_mode', 'levels', 'smc', 'volume', 'trading', 'risk', 'exchanges', 'notifications', 'genome_auto_apply']) expect(r.body.settings, k).toHaveProperty(k);
    expect(r.body.options.locked).toEqual(expect.arrayContaining(['smc.*', 'volume.*', 'trading.*', 'genome_auto_apply', 'ui_mode.expert', 'levels.long_tf', 'levels.short_tf']));
    // D9 sections (M7 appSettingsService.settingsAll) → the «Расширенные настройки» screen
    for (const k of ['shared', 'long', 'short']) expect(r.body.settings.levels, k).toHaveProperty(k);
    expect(r.body.settings.levels.shared).toHaveProperty('pivot_strength');
    expect(r.body.settings.levels.short.overrides).toEqual([]);
    expect(r.body.settings.smc).toHaveProperty('advanced');
    expect(r.body.settings.risk).toHaveProperty('advanced');
    expect(r.body.settings).toHaveProperty('ptp');
    expect(r.body.settings.trading.disabled_days).toEqual([]);
    expect(r.body.options.choices['levels.shared.pivot_strength']).toEqual([3, 5, 7, 10, 15, 17, 20]);
    expect(r.body.options.choices['ui_mode']).toEqual(['simple', 'expert']);
    expect(r.body.options.intervals).toContain(300);
    const locked = await request(app).post('/api/app/settings/all').send({ smc: { tf_key: '4H' } }).set(bearer(tok));
    expect(locked.body).toEqual({ ok: false, error: 'pro_required' });
    const bad = await request(app).post('/api/app/settings/all').send({ levels: { use_rsi: 'yes' } }).set(bearer(tok));
    expect(bad.body).toMatchObject({ ok: false, error: 'bad_request', message: 'levels.use_rsi' });
    const empty = await request(app).post('/api/app/settings/all').send({}).set(bearer(tok));
    expect(empty.body).toMatchObject({ ok: false, error: 'bad_request', message: 'empty' });
    // ranges / choices as in the M7 schema: bad_request names the dotted key
    expect((await request(app).post('/api/app/settings/all').send({ levels: { min_quality: 99 } }).set(bearer(tok))).body).toMatchObject({ ok: false, error: 'bad_request', message: 'levels.min_quality' });
    expect((await request(app).post('/api/app/settings/all').send({ levels: { shared: { pivot_strength: 8 } } }).set(bearer(tok))).body).toMatchObject({ ok: false, error: 'bad_request', message: 'levels.shared.pivot_strength' });
    expect((await request(app).post('/api/app/settings/all').send({ levels: { long_tf: '5m' } }).set(bearer(proTok))).body).toMatchObject({ ok: false, error: 'bad_request', message: 'levels.long_tf' });
    const ok = await request(app).post('/api/app/settings/all').send({ levels: { min_quality: 4, shared: { pivot_strength: 10 }, short: { zone_pct: 0.5 } }, ui_mode: 'simple' }).set(bearer(tok));
    expect(ok.body.ok).toBe(true);
    expect(ok.body.settings.levels).toMatchObject({ min_quality: 4 });
    expect(ok.body.settings.levels.shared.pivot_strength).toBe(10);
    expect(ok.body.settings.levels.short).toMatchObject({ zone_pct: 0.5, overrides: ['zone_pct'] });
    expect(ok.body).not.toHaveProperty('options');   // quirk §10.3: POST returns settings only
    const reset = await request(app).post('/api/app/settings/all').send({ levels: { short: { reset: true } } }).set(bearer(tok));
    expect(reset.body.settings.levels.short.overrides).toEqual([]);
    // D9 trading keys stay open on Free (QUIRK: options.locked keeps trading.*), the Mini App keys do not
    expect((await request(app).post('/api/app/settings/all').send({ trading: { disabled_days: [0, 6] } }).set(bearer(tok))).body.settings.trading.disabled_days).toEqual([0, 6]);
    expect((await request(app).post('/api/app/settings/all').send({ trading: { trade_leverage: 3 } }).set(bearer(tok))).body).toEqual({ ok: false, error: 'pro_required' });
    const rf = await request(app).post('/api/app/settings/all').send({ risk: { advanced: { reset_all_filters: true } } }).set(bearer(proTok));
    expect(rf.body.settings.risk).toMatchObject({ filters_all_off: true, allow_counter_trend: true, btc_correlation_block: false });
    expect(rf.body.settings.risk.advanced).not.toHaveProperty('reset_all_filters');
    const expert = await request(app).post('/api/app/settings/all').send({ ui_mode: 'expert' }).set(bearer(tok));
    expect(expert.body).toEqual({ ok: false, error: 'pro_required' });
    const vol = await request(app).post('/api/app/settings/all').send({ volume: { setup_cross: false, setup_turn: false, setup_bounce: false, setup_golden: false, setup_ribbon: false } }).set(bearer(proTok));
    expect(vol.body).toMatchObject({ ok: false, error: 'bad_request', message: 'volume.setup_*' });
  });
  it('profile, exchange keys, positions, feedback, plan, stats, help, lang, share, genome, challenge', async () => {
    const prof = await request(app).post('/api/app/profile').send({ name: 'conservative' }).set(bearer(tok));
    expect(prof.body.ok).toBe(true);
    expect(prof.body.skipped).toContain('strategy.SMC');
    expect(prof.body.settings.levels.min_quality).toBe(7);
    expect((await request(app).post('/api/app/profile').send({ name: 'x' }).set(bearer(tok))).body).toMatchObject({ error: 'bad_request', message: 'name' });

    expect((await request(app).post('/api/app/exchange/keys').send({ exchange: 'bybit', api_key: 'k'.repeat(12), api_secret: 's'.repeat(12) }).set(bearer(tok))).body).toEqual({ ok: false, error: 'pro_required' });
    const keys = await request(app).post('/api/app/exchange/keys').send({ exchange: 'okx', api_key: 'abcd1234567890', api_secret: 's'.repeat(12), passphrase: 'pppp' }).set(bearer(proTok));
    expect(keys.body).toMatchObject({ ok: true, exchange: 'okx', key_hint: 'abcd…90' });
    expect((await request(app).post('/api/app/exchange/keys/remove').send({ exchange: 'okx' }).set(bearer(proTok))).body).toEqual({ ok: true });

    const pos = await request(app).get('/api/app/positions').set(bearer(proTok));
    expect(pos.body.ok).toBe(true);
    expect(Array.isArray(pos.body.positions)).toBe(true);
    expect(pos.body).toHaveProperty('orders_count');

    expect((await request(app).post('/api/app/feedback').send({ type: 'idea', text: 'short' }).set(bearer(tok))).body).toMatchObject({ error: 'bad_request', message: 'text' });
    const fb = await request(app).post('/api/app/feedback').send({ type: 'bug', text: 'десять символов и больше' }).set(bearer(tok));
    expect(fb.body.ok).toBe(true);
    expect(fb.body.id).toBeGreaterThan(0);

    const plan = await request(app).get('/api/app/plan').set(bearer(tok));
    expect(plan.body).toMatchObject({ ok: true, plan: 'free', price_usd: 69, admin_contact: '@crypto_chm' });
    expect(plan.body.features.length).toBe(8);
    expect(plan.body).not.toHaveProperty('ton');   // TON dropped (D12)

    const st = await request(app).get('/api/app/stats?days=30').set(bearer(proTok));
    expect(st.body.ok).toBe(true);
    for (const k of ['summary', 'filters', 'by_strategy', 'by_session', 'by_weekday', 'equity', 'by_symbol', 'by_timeframe', 'by_source', 'by_context']) expect(st.body, k).toHaveProperty(k);
    expect(st.body.by_weekday.length).toBe(7);

    const help = await request(app).get('/api/app/help').set(bearer(tok));
    expect(help.body.sections.length).toBe(11);
    expect(help.body.sections[0]).toMatchObject({ id: 'quick_start', number: '01', title: 'Быстрый старт' });

    expect((await request(app).post('/api/app/lang').send({ lang: 'en' }).set(bearer(tok))).body).toEqual({ ok: true, lang: 'en' });
    expect((await request(app).post('/api/app/lang').send({ lang: 'de' }).set(bearer(tok))).body).toMatchObject({ error: 'bad_request', message: 'lang' });

    const share = await request(app).post('/api/app/share').send({ days: 30 }).set(bearer(proTok));
    expect(share.body).toMatchObject({ ok: true, sent: false, days: 30 });
    expect(share.body.stats).toHaveProperty('win_rate');
    await request(app).post('/api/app/share').send({}).set(bearer(proTok));
    await request(app).post('/api/app/share').send({}).set(bearer(proTok));
    expect((await request(app).post('/api/app/share').send({}).set(bearer(proTok))).body).toEqual({ ok: false, error: 'rate_limited' });

    const gf = await request(app).get('/api/app/genome').set(bearer(tok));
    expect(gf.body).toMatchObject({ ok: true, available: false });
    const gp = await request(app).get('/api/app/genome').set(bearer(proTok));
    expect(gp.body.strategies.LEVELS).toMatchObject({ generation: 14, applied: true });
    expect((await request(app).post('/api/app/genome/apply').send({ strategy: 'VOLUME' }).set(bearer(proTok))).body).toMatchObject({ ok: false, error: 'genome_not_ready' });
    expect((await request(app).post('/api/app/genome/apply').send({ strategy: 'SMC' }).set(bearer(proTok))).body).toEqual({ ok: true });

    const chFree = await request(app).get('/api/app/challenge').set(bearer(tok));
    expect(chFree.body).toMatchObject({ ok: true, available: false, active: false });
    const answers = { deposit: 1000, goal_kind: 'pct', goal_value: 25, term: '1m', risk_pct: 1, leverage: 5, max_trades_day: 3, daily_loss_pct: 3, topup_monthly: 0, strategies: ['LEVELS'], mode: 'signals' };
    const prev = await request(app).post('/api/app/challenge').send({ ...answers, preview: true }).set(bearer(proTok));
    expect(prev.body).toMatchObject({ ok: true, preview: true });
    expect(prev.body.plan.r_needed).toBe(25);
    expect((await request(app).post('/api/app/challenge').send({ ...answers, deposit: 1 }).set(bearer(proTok))).body).toMatchObject({ ok: false, error: 'bad_request', field: 'deposit' });
    const start = await request(app).post('/api/app/challenge').send(answers).set(bearer(proTok));
    expect(start.body).toMatchObject({ ok: true, active: true });
    expect((await request(app).post('/api/app/challenge').send(answers).set(bearer(proTok))).body).toEqual({ ok: false, error: 'already_active' });
    expect((await request(app).post('/api/app/challenge/topup').send({ amount: 100 }).set(bearer(proTok))).body.progress.topups_total).toBe(100);
    expect((await request(app).post('/api/app/challenge/finish').send({}).set(bearer(proTok))).body.active).toBe(false);
    expect((await request(app).post('/api/app/challenge/finish').send({}).set(bearer(proTok))).status).toBe(404);
  });
  it('unknown /api/app route → 404 envelope', async () => {
    const r = await request(app).get('/api/app/whatever').set(bearer(tok));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('CSP: the shell works under the site\'s helmet policy (script-src-attr \'none\')', () => {
  it('index.html has no inline event handler; splash.js switches the font stylesheet to media=all', () => {
    const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
    expect(html).toMatch(/<link id="app-fonts" rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/[^"]+" media="print">/);
    const splash = fs.readFileSync(path.join(APP_DIR, 'splash.js'), 'utf8');
    expect(splash).toContain('document.getElementById("app-fonts")');
    expect(splash).toContain('fonts.addEventListener("load", function () { fonts.media = "all"; });');
  });
});

describe('live events: the SPA subscribes to GET /api/app/events with its JWT', () => {
  it('app.js reads the SSE stream with fetch() + Bearer (EventSource cannot send the header) and only refreshes caches', () => {
    const js = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
    expect(js).toContain('fetch(API_BASE + "events", {');
    expect(js).toContain('"Authorization": "Bearer " + Auth.access()');
    expect(js).not.toContain('new EventSource');
    expect(js).toContain('var REFRESH_ON = { signal: 1, progress: 1, trade: 1 };');
    expect(js).toContain('if (S.me) Live.start();');
    expect(js).toMatch(/function resetState\(\) \{\n {4}Live\.stop\(\);/);
  });

  it('the stub answers the handshake (event-stream, retry, hello) for a bearer and 401 without one', async () => {
    const http = await import('http');
    const { accessToken } = await login();
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const got = await new Promise((resolve, reject) => {
        const rq = http.get({ host: '127.0.0.1', port, path: '/api/app/events', headers: bearer(accessToken) }, (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            buf += c;
            if (buf.includes('event: hello')) { rq.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], buf }); }
          });
        });
        rq.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      });
      expect(got.status).toBe(200);
      expect(got.type).toMatch(/^text\/event-stream/);
      expect(got.buf).toContain('retry: 10000');
      expect(got.buf).toMatch(/event: hello\ndata: \{"user_id":\d+,"heartbeat_s":25\}/);
      const r = await request(app).get('/api/app/events');
      expect(r.status).toBe(401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
