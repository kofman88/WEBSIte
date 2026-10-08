/**
 * GET/POST /api/app/settings/all (+ profile, settings/reset, volume/reset):
 * every validator branch of miniapp_api._coerce / _validate_sections, the
 * plan gates, the business checks, the apply order and side effects, the
 * `options.locked` list per plan — plus the D9 sections (levels.shared /
 * levels.long / levels.short / smc.advanced / ptp / risk.advanced /
 * trading.* / notifications.notify_*) with the Telegram handlers' validation.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

// Same module instance as server.js (Node require) — see me.test.js.
const nodeRequire = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-settings.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, app, ts, authService, appRouter, plan, exchangeService, kv, appSettings;

beforeAll(async () => {
  freshDb();
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = (await import('../../services/traderSettingsService.js')).default;
  plan = (await import('../../services/planService.js')).default;
  authService = (await import('../../services/authService.js')).default;
  appRouter = nodeRequire('../../routes/app.js');
  exchangeService = (await import('../../services/exchangeService.js')).default;
  kv = (await import('../../services/engineKvService.js')).default;
  appSettings = (await import('../../services/appSettingsService.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM exchange_keys').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
});

function makeUser({ isAdmin = 0, pro = false } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const uid = db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?)').run(e, 'x', ref, isAdmin).lastInsertRowid;
  if (pro) plan.grantAccess(uid, 30, { actor: 'test' });
  return uid;
}
const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });
const getAll = (uid) => request(app).get('/api/app/settings/all').set(H(uid));
const post = (uid, body) => request(app).post('/api/app/settings/all').set(H(uid)).send(body);
const bad = (key) => ({ ok: false, error: 'bad_request', message: key });
const addKey = (uid, exchange, extra = {}) => exchangeService.addKey(uid, { exchange, apiKey: `${exchange}-key-1234567890`, apiSecret: 'secret-0123456789', ...extra });

describe('GET settings/all', () => {
  it('fresh free user: documented sections + D9 blocks, options with the free locked list', async () => {
    const uid = makeUser();
    const r = await getAll(uid);
    expect(r.status).toBe(200);
    const { settings: s, options: o } = r.body;
    expect(Object.keys(s)).toEqual(['lang', 'ui_mode', 'levels', 'smc', 'volume', 'trading', 'ptp', 'risk', 'exchanges', 'notifications', 'genome_auto_apply']);
    expect(s.lang).toBe('ru');
    expect(s.ui_mode).toBe('simple');
    expect(s.levels).toMatchObject({ long_tf: '1h', short_tf: '1h', min_quality: 3, min_volume_usdt: 300000, min_rr: 2, max_dist_pct: 1.5, zone_pct: 0.7, use_rsi: true, use_volume: true, use_htf: false, trend_only: false, max_risk_pct: 1.5 });
    expect(s.levels.shared).toEqual({ timeframe: '1h', scan_interval: 300, pivot_strength: 7, max_level_age: 100, max_retest_bars: 30, zone_buffer: 0.3, max_level_tests: 4, ema_fast: 50, ema_slow: 200, htf_ema_period: 50, use_pattern: false, rsi_period: 14, rsi_ob: 65, rsi_os: 35, vol_mult: 1, cooldown_bars: 5, atr_period: 14, atr_mult: 1, tp1_rr: 2, tp2_rr: 3, tp3_rr: 4.5, high_wr_mode: false, levels_counter_trend_min_quality: 4 });
    expect(s.levels.long).toMatchObject({ pivot_strength: 7, min_rr: 2, interval: 3600, overrides: [] });
    expect(s.levels.long).not.toHaveProperty('timeframe');
    expect(s.levels.short.overrides).toEqual([]);
    expect(s.smc).toMatchObject({ tf_key: '1H', direction: 'BOTH', min_volume_usdt: 300000, max_sl_pct: 5, scan_interval: 300 });
    expect(s.smc.advanced).toEqual({ min_confirmations: 3, min_rr: 2, sl_buffer_pct: 0.35, fvg_enabled: true, choch_enabled: true, ob_use_breaker: true, sweep_close_req: true, ob_max_age: 80, smc_conf_type: 'BODY_CLOSE', smc_pd_filter: false, smc_retrace_depth: 0.2, smc_mtf_check: false, smc_use_volume_filter: false, smc_vol_mult: 1.2, smc_counter_trend_min_quality: 4 });
    expect(s.volume).toEqual({ timeframe: '1h', setup_cross: true, setup_turn: true, setup_bounce: true, setup_golden: true, setup_ribbon: true, ma_type: 'sma', vol_mult: 1.5, use_htf: true, min_quality: 3 });
    expect(s.trading).toEqual({ auto_trade: false, auto_trade_mode: 'confirm', trade_exchange: 'bybit', trade_risk_pct: 1, trade_leverage: 10, max_trades_limit: 5, risk_mode: 'risk', partial_tp_enabled: true, auto_trailing_enabled: true, prefer_market_entry: false, bybit_demo: false, disabled_days: [], fixed_amount: 0, vol_filter_mode: 'usdt', max_coins_count: 50, at_stats_period: 1, optimizer_enabled: false, optimizer_strategies: 'LEVELS' });
    expect(s.ptp).toEqual({ ptp_mode: 'R', partial_tp1_r: 1, partial_tp2_r: 1.5, partial_tp1_pct: 50, partial_tp2_pct: 40, ptp_profit_pct1: 30, ptp_profit_pct2: 50 });
    expect(s.risk).toMatchObject({ sl_streak_enabled: true, sl_streak_threshold: 3, circuit_breaker_enabled: false, circuit_breaker_threshold_r: 0, allow_counter_trend: false, filters_all_off: false, btc_correlation_block: false, spread_check_enabled: true, trade_trending_only: false, hour_filter_enabled: true });
    expect(s.risk.advanced).toEqual({ spread_max_pct: 0.3, allow_low_notional_boost: false, show_risk_preview: true, correlation_cap_enabled: false, correlation_cap_threshold: 0.7, adaptive_sizing_enabled: false, adaptive_sizing_mode: 'all', tilt_detector_enabled: true, hold_lock_enabled: false, hold_lock_min_rr: 0.5, min_signal_quality: 3 });
    expect(s.exchanges).toEqual({ bybit: { connected: false, key_hint: '' }, bingx: { connected: false, key_hint: '' }, binance: { connected: false, key_hint: '' }, okx: { connected: false, key_hint: '' } });
    expect(s.notifications).toEqual({ progress_notify_enabled: true, send_chart_enabled: true, signal_format: 'full', quiet_start: -1, quiet_end: -1, notify_signal: true, notify_breakout: false });
    expect(s.genome_auto_apply).toBe(false);
    expect(o).toMatchObject({ tf_levels: ['15m', '30m', '1h', '4h', '1d'], tf_smc: ['15m', '1H', '4H'], tf_volume: ['15m', '1h', '4h'], exchanges: ['bybit', 'bingx', 'binance', 'okx'], leverage: [1, 2, 3, 5, 10, 20], risk_pct: [0.25, 0.5, 1, 1.5, 2, 3], max_trades: [1, 2, 3, 5, 10], min_volume: [300000, 1000000, 5000000, 10000000, 25000000, 50000000] });
    expect(o.locked).toEqual(['smc.*', 'volume.*', 'trading.*', 'genome_auto_apply', 'ui_mode.expert', 'levels.long_tf', 'levels.short_tf']);
    expect(o.intervals).toEqual([60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400]);
    expect(o.choices['levels.long.pivot_strength']).toEqual([3, 5, 7, 10, 15, 17, 20]);
    expect(o.choices['smc.advanced.smc_conf_type']).toEqual(['BODY_CLOSE', 'WICK_TOUCH']);
    expect(o.choices['trading.fixed_amount']).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
    expect(o.choices.ui_mode).toEqual(['simple', 'expert']);
  });
  it('pro and admin users have nothing locked; read normalisation of odd stored values', async () => {
    expect((await getAll(makeUser({ pro: true }))).body.options.locked).toEqual([]);
    expect((await getAll(makeUser({ isAdmin: 1 }))).body.options.locked).toEqual([]);
    const uid = makeUser();
    const u = ts.getOrCreate(uid);
    Object.assign(u, { lang: 'xx', ui_mode: 'weird', smc_cfg: '{"tf_key": "30m", "direction": "UP"}', auto_trade_mode: 'maybe', trade_exchange: 'kraken', risk_mode: 'x', signal_format: 'mini', quiet_start: 5, quiet_end: 5, vol_filter_mode: 'q', ptp_mode: 'x', adaptive_sizing_mode: 'q', min_rr: 0.8 });
    ts.save(u);
    const { settings: s } = (await getAll(uid)).body;
    expect(s.lang).toBe('ru');
    expect(s.ui_mode).toBe('simple');
    expect(s.smc).toMatchObject({ tf_key: '1H', direction: 'BOTH' });
    expect(s.trading).toMatchObject({ auto_trade_mode: 'confirm', trade_exchange: 'bybit', risk_mode: 'risk', vol_filter_mode: 'usdt' });
    expect(s.ptp.ptp_mode).toBe('R');
    expect(s.risk.advanced.adaptive_sizing_mode).toBe('all');
    expect(s.notifications).toMatchObject({ signal_format: 'full', quiet_start: -1, quiet_end: -1 });
    expect(s.levels.min_rr).toBe(1);                   // QUIRK: stored 0.8 reads back clamped
  });
  it('exchanges: connected + key hint from exchange_keys (label-less or default row)', async () => {
    const uid = makeUser({ pro: true });
    await addKey(uid, 'bybit');
    await addKey(uid, 'okx', { apiKey: 'okx', passphrase: 'pp' });
    const { settings: s } = (await getAll(uid)).body;
    expect(s.exchanges.bybit).toEqual({ connected: true, key_hint: 'bybi…90' });
    expect(s.exchanges.okx).toEqual({ connected: true, key_hint: '…' });
    expect(s.exchanges.bingx.connected).toBe(false);
    expect(appSettings.keyHint('')).toBe('');
    expect(appSettings.keyHint('abcdef')).toBe('abcd…ef');
  });
});

describe('POST settings/all — validation (_coerce branches)', () => {
  it('section must be an object; empty / nothing recognised → bad_request "empty"; unknown keys ignored', async () => {
    const uid = makeUser();
    expect((await post(uid, { levels: 5 })).body).toEqual(bad('levels'));
    expect((await post(uid, { risk: [1] })).body).toEqual(bad('risk'));
    expect((await post(uid, { levels: { long: 'x' } })).body).toEqual(bad('levels.long'));
    expect((await post(uid, {})).body).toEqual(bad('empty'));
    expect((await post(uid, { levels: { bogus: 1 }, foo: 2 })).body).toEqual(bad('empty'));
    expect((await post(uid, [1, 2])).body).toEqual(bad('empty'));
    expect((await post(uid, { levels: null })).body).toEqual(bad('empty'));
  });
  it('bool: true/false, 0/1, "true/false/1/0/on/off"; everything else rejected', async () => {
    const uid = makeUser();
    for (const v of [2, 'yes', null, 'x', 1.5, [], {}]) {
      expect((await post(uid, { risk: { sl_streak_enabled: v } })).body).toEqual(bad('risk.sl_streak_enabled'));
    }
    for (const [v, exp] of [[true, true], [0, false], [1, true], ['on', true], [' Off ', false], [1.0, true], ['FALSE', false]]) {
      const r = await post(uid, { risk: { sl_streak_enabled: v } });
      expect(r.body.ok).toBe(true);
      expect(r.body.settings.risk.sl_streak_enabled).toBe(exp);
    }
  });
  it('enum: exact string only', async () => {
    const uid = makeUser();
    expect((await post(uid, { levels: { long_tf: '5m' } })).body).toEqual(bad('levels.long_tf'));
    expect((await post(uid, { levels: { long_tf: 1 } })).body).toEqual(bad('levels.long_tf'));
    expect((await post(uid, { levels: { long_tf: '1H' } })).body).toEqual(bad('levels.long_tf'));
    expect((await post(uid, { lang: 'EN' })).body).toEqual(bad('lang'));
    expect((await post(uid, { ui_mode: 'pro' })).body).toEqual(bad('ui_mode'));
    expect((await post(uid, { genome_auto_apply: 'maybe' })).body).toEqual(bad('genome_auto_apply'));
  });
  it('int: integral numbers (also numeric strings / 1e-9 tolerance); bools, blanks, NaN, out of range rejected', async () => {
    const uid = makeUser();
    for (const v of [3.5, true, '', ' ', 11, -1, 'nan', null, 'inf', [1]]) {
      expect((await post(uid, { levels: { min_quality: v } })).body).toEqual(bad('levels.min_quality'));
    }
    for (const [v, exp] of [[3, 3], [3.0, 3], ['4', 4], ['3.0000000001', 3], [10, 10], [0, 0]]) {
      const r = await post(uid, { levels: { min_quality: v } });
      expect(r.body.ok).toBe(true);
      expect(r.body.settings.levels.min_quality).toBe(exp);
    }
  });
  it('float: lo ≤ float(v) ≤ hi, not NaN; bools / blanks / inf / non-numbers rejected', async () => {
    const uid = makeUser();
    for (const v of [5.0001, 'inf', [1], true, '', 0.05, 'abc', {}]) {
      expect((await post(uid, { levels: { max_risk_pct: v } })).body).toEqual(bad('levels.max_risk_pct'));
    }
    for (const [v, exp] of [[2, 2], ['2.5', 2.5], [0.1, 0.1], [5, 5]]) {
      const r = await post(uid, { levels: { max_risk_pct: v } });
      expect(r.body.settings.levels.max_risk_pct).toBe(exp);
    }
    expect((await post(uid, { levels: { min_volume_usdt: 1e10 } })).body.settings.levels.min_volume_usdt).toBe(1e10);
    expect((await post(uid, { levels: { min_volume_usdt: 1e10 + 1 } })).body).toEqual(bad('levels.min_volume_usdt'));
  });
  it('D9 choice: only the Telegram keyboard options (numeric strings accepted)', async () => {
    const uid = makeUser();
    expect((await post(uid, { levels: { long: { pivot_strength: 6 } } })).body).toEqual(bad('levels.long.pivot_strength'));
    expect((await post(uid, { levels: { shared: { scan_interval: 120 } } })).body).toEqual(bad('levels.shared.scan_interval'));
    expect((await post(uid, { ptp: { partial_tp1_pct: 45 } })).body).toEqual(bad('ptp.partial_tp1_pct'));
    expect((await post(uid, { trading: { max_coins_count: '25' } })).body).toEqual(bad('trading.max_coins_count'));
    expect((await post(uid, { risk: { advanced: { min_signal_quality: 2 } } })).body).toEqual(bad('risk.advanced.min_signal_quality'));
    const r = await post(uid, { levels: { long: { pivot_strength: '7', zone_pct: 1.35 }, shared: { scan_interval: 900 } }, trading: { max_coins_count: 200 } });
    expect(r.body.ok).toBe(true);
    expect(r.body.settings.levels.long).toMatchObject({ pivot_strength: 7, zone_pct: 1.35, overrides: ['pivot_strength', 'zone_pct'] });
    expect(r.body.settings.levels.shared.scan_interval).toBe(900);
    expect(r.body.settings.trading.max_coins_count).toBe(200);
  });
  it('D9 ranges and free text: shared tp1 0 < v ≤ 100, tp2/tp3 any finite, retrace 0..1, vol mult 0.5..5, ct quality 0..5, corr cap 0.4..0.95', async () => {
    const uid = makeUser({ pro: true });
    expect((await post(uid, { levels: { shared: { tp1_rr: 0 } } })).body).toEqual(bad('levels.shared.tp1_rr'));
    expect((await post(uid, { levels: { shared: { tp1_rr: 101 } } })).body).toEqual(bad('levels.shared.tp1_rr'));
    expect((await post(uid, { levels: { shared: { tp2_rr: 'abc' } } })).body).toEqual(bad('levels.shared.tp2_rr'));
    expect((await post(uid, { levels: { shared: { tp2_rr: 'inf' } } })).body).toEqual(bad('levels.shared.tp2_rr'));
    expect((await post(uid, { smc: { advanced: { smc_retrace_depth: 1.5 } } })).body).toEqual(bad('smc.advanced.smc_retrace_depth'));
    expect((await post(uid, { smc: { advanced: { smc_vol_mult: 0.4 } } })).body).toEqual(bad('smc.advanced.smc_vol_mult'));
    expect((await post(uid, { smc: { advanced: { smc_counter_trend_min_quality: 6 } } })).body).toEqual(bad('smc.advanced.smc_counter_trend_min_quality'));
    expect((await post(uid, { risk: { advanced: { correlation_cap_threshold: 0.3 } } })).body).toEqual(bad('risk.advanced.correlation_cap_threshold'));
    expect((await post(uid, { risk: { advanced: { adaptive_sizing_mode: 'turbo' } } })).body).toEqual(bad('risk.advanced.adaptive_sizing_mode'));
    const r = await post(uid, { levels: { shared: { tp1_rr: 100, tp2_rr: 0.1, tp3_rr: -1, levels_counter_trend_min_quality: 0 }, long: { tp1_rr: 0.2 } }, smc: { advanced: { smc_retrace_depth: 1, smc_vol_mult: 5, smc_counter_trend_min_quality: 5 } }, risk: { advanced: { correlation_cap_threshold: 0.95 } } });
    expect(r.body.ok).toBe(true);
    const u = ts.get(uid);
    expect([u.tp1_rr, u.tp2_rr, u.tp3_rr, u.levels_counter_trend_min_quality, u.smc_counter_trend_min_quality, u.correlation_cap_threshold]).toEqual([100, 0.1, -1, 0, 5, 0.95]);
    expect(u.long_cfg).toBe('{"tp1_rr": 0.2, "_sparse": true}');
    expect(r.body.settings.levels.shared).toMatchObject({ tp1_rr: 100, tp2_rr: 101, tp3_rr: 102.5 });   // read back through TradeCfg clamps
    expect(r.body.settings.smc.advanced).toMatchObject({ smc_retrace_depth: 1, smc_vol_mult: 5 });
  });
  it('D9 days: weekday list or CSV, 0..6, deduped and sorted', async () => {
    const uid = makeUser();
    expect((await post(uid, { trading: { disabled_days: [7] } })).body).toEqual(bad('trading.disabled_days'));
    expect((await post(uid, { trading: { disabled_days: 'x' } })).body).toEqual(bad('trading.disabled_days'));
    expect((await post(uid, { trading: { disabled_days: 5 } })).body).toEqual(bad('trading.disabled_days'));
    expect((await post(uid, { trading: { disabled_days: [1.5] } })).body).toEqual(bad('trading.disabled_days'));
    let r = await post(uid, { trading: { disabled_days: [6, 0, '3', 6] } });
    expect(r.body.settings.trading.disabled_days).toEqual([0, 3, 6]);
    expect(ts.get(uid).autotrade_disabled_days).toBe('0,3,6');
    r = await post(uid, { trading: { disabled_days: '1,2' } });
    expect(ts.get(uid).autotrade_disabled_days).toBe('1,2');
    r = await post(uid, { trading: { disabled_days: [] } });
    expect(ts.get(uid).autotrade_disabled_days).toBe('');
  });
});

describe('POST settings/all — plan gates (nothing saved)', () => {
  it('free: smc / smc.advanced / volume / trading Pro keys / genome / expert / plan timeframes → pro_required', async () => {
    const uid = makeUser();
    const pr = { ok: false, error: 'pro_required' };
    expect((await post(uid, { smc: { tf_key: '4H' } })).body).toEqual(pr);
    expect((await post(uid, { smc: { advanced: { fvg_enabled: false } } })).body).toEqual(pr);
    expect((await post(uid, { volume: { ma_type: 'ema' } })).body).toEqual(pr);
    expect((await post(uid, { trading: { auto_trade_mode: 'auto' } })).body).toEqual(pr);
    expect((await post(uid, { trading: { auto_trade: false } })).body).toEqual(pr);
    expect((await post(uid, { genome_auto_apply: true })).body).toEqual(pr);
    expect((await post(uid, { ui_mode: 'expert' })).body).toEqual(pr);
    expect((await post(uid, { levels: { long_tf: '4h' } })).body).toEqual(pr);
    expect((await post(uid, { levels: { short_tf: '1d' } })).body).toEqual(pr);
    expect((await post(uid, { levels: { shared: { timeframe: '30m' } } })).body).toEqual(pr);
    // gate failure after a valid change → nothing saved
    expect((await post(uid, { levels: { min_rr: 3 }, smc: { tf_key: '4H' } })).body).toEqual(pr);
    expect(ts.get(uid).min_rr).toBe(2.0);
  });
  it('free: plan timeframes, genome false, simple mode, ptp / risk.advanced / levels.* / the D9 trading keys are accepted (bot parity, QUIRK vs locked list)', async () => {
    const uid = makeUser();
    const r = await post(uid, {
      levels: { long_tf: '15m', short_tf: '1h', shared: { timeframe: '1h', high_wr_mode: true }, long: { pivot_strength: 5 } },
      ptp: { ptp_mode: 'PCT' }, risk: { advanced: { show_risk_preview: false } },
      trading: { disabled_days: [0], fixed_amount: 1.5, vol_filter_mode: 'both', max_coins_count: 30, at_stats_period: 7 },
      notifications: { notify_breakout: true }, genome_auto_apply: false, ui_mode: 'simple', lang: 'en',
    });
    expect(r.body.ok).toBe(true);
    expect(r.body).not.toHaveProperty('options');
    const u = ts.get(uid);
    expect(u).toMatchObject({ long_tf: '15m', short_tf: '1h', high_wr_mode: true, ptp_mode: 'PCT', show_risk_preview: false, autotrade_disabled_days: '0', fixed_amount: 1.5, vol_filter_mode: 'both', max_coins_count: 30, at_stats_period: 7, notify_breakout: true, genome_auto_apply: false, ui_mode: 'simple', lang: 'en' });
    expect(u.long_cfg).toBe('{"pivot_strength": 5, "_sparse": true}');
    // a Pro trading key mixed in still trips the gate
    expect((await post(uid, { trading: { fixed_amount: 1, trade_leverage: 5 } })).body).toEqual({ ok: false, error: 'pro_required' });
    expect(ts.get(uid).fixed_amount).toBe(1.5);
  });
  it('admin on free bypasses every gate', async () => {
    const uid = makeUser({ isAdmin: 1 });
    const r = await post(uid, { smc: { tf_key: '4H' }, volume: { ma_type: 'ema' }, trading: { trade_leverage: 5 }, genome_auto_apply: true, ui_mode: 'expert', levels: { long_tf: '1d' } });
    expect(r.body.ok).toBe(true);
    expect(ts.get(uid)).toMatchObject({ trade_leverage: 5, genome_auto_apply: true, ui_mode: 'expert', long_tf: '1d' });
  });
});

describe('POST settings/all — business checks', () => {
  it('auto_trade on needs the keys of the (new or current) exchange; OKX also the passphrase', async () => {
    const uid = makeUser({ pro: true });
    expect((await post(uid, { trading: { auto_trade: true } })).body).toEqual(bad('trading.auto_trade: no API keys for bybit'));
    expect((await post(uid, { trading: { auto_trade: true, trade_exchange: 'okx' } })).body).toEqual(bad('trading.auto_trade: no API keys for okx'));
    expect(ts.get(uid).trade_exchange).toBe('bybit');
    await addKey(uid, 'okx');                                   // no passphrase
    expect((await post(uid, { trading: { auto_trade: true, trade_exchange: 'okx' } })).body).toEqual(bad('trading.auto_trade: no API keys for okx'));
    db.prepare('DELETE FROM exchange_keys').run();
    await addKey(uid, 'okx', { passphrase: 'pass' });
    let r = await post(uid, { trading: { auto_trade: true, trade_exchange: 'okx' } });
    expect(r.body.ok).toBe(true);
    expect(ts.get(uid)).toMatchObject({ auto_trade: true, trade_exchange: 'okx' });
    // current exchange is used when the payload has none
    await addKey(uid, 'bybit');
    r = await post(uid, { trading: { trade_exchange: 'bybit' } });
    r = await post(uid, { trading: { auto_trade: true } });
    expect(r.body.ok).toBe(true);
    expect((await post(uid, { trading: { auto_trade: false } })).body.settings.trading.auto_trade).toBe(false);
  });
  it('side effects: bybit_demo with a Bybit key and auto_trade on are reported to the trade hooks', async () => {
    const uid = makeUser({ pro: true });
    const user = ts.getOrCreate(uid);
    let out = appSettings.applySettings(user, { trading: { bybit_demo: true } }, { admin: false });
    expect(out._side_effects).toEqual([]);
    await addKey(uid, 'bybit');
    out = appSettings.applySettings(ts.get(uid), { trading: { bybit_demo: false, auto_trade: true } }, { admin: false });
    expect(out._side_effects).toEqual(['invalidate_bybit_session', 'reset_auth_failures:bybit']);
  });
  it('volume: at least one setup must stay on; the kv dict is merged and written in full', async () => {
    const uid = makeUser({ pro: true });
    expect((await post(uid, { volume: { setup_cross: false, setup_turn: false, setup_bounce: false, setup_golden: false, setup_ribbon: false } })).body).toEqual(bad('volume.setup_*'));
    expect(kv.get(`volume_cfg_${uid}`)).toBeNull();
    let r = await post(uid, { volume: { setup_cross: false, setup_turn: false, setup_bounce: false, setup_golden: false, ma_type: 'ema', vol_mult: 2, timeframe: '4h' } });
    expect(r.body.ok).toBe(true);
    expect(r.body.settings.volume).toMatchObject({ setup_ribbon: true, setup_cross: false, ma_type: 'ema', vol_mult: 2, timeframe: '4h' });
    expect(ts.get(uid).vol_timeframe).toBe('4h');
    expect(Object.keys(JSON.parse(kv.get(`volume_cfg_${uid}`))).length).toBe(38);
    expect((await post(uid, { volume: { setup_ribbon: false } })).body).toEqual(bad('volume.setup_*'));
    r = await post(uid, { volume: { setup_ribbon: false, setup_cross: true, min_quality: 5, use_htf: false } });
    expect(r.body.settings.volume).toMatchObject({ setup_ribbon: false, setup_cross: true, min_quality: 5, use_htf: false });
    // timeframe alone touches only the column, not the kv
    const before = kv.get(`volume_cfg_${uid}`);
    r = await post(uid, { volume: { timeframe: '15m' } });
    expect(kv.get(`volume_cfg_${uid}`)).toBe(before);
    expect(r.body.settings.volume.timeframe).toBe('15m');
  });
});

describe('POST settings/all — apply order and side effects', () => {
  it('levels: Mini App keys → flat columns; long/short JSON untouched; shared keys too', async () => {
    const uid = makeUser({ pro: true });
    const u = ts.get(uid); u.long_cfg = '{"min_rr": 2.5, "_sparse": true}'; ts.save(u);
    const r = await post(uid, { levels: { min_quality: 7, use_rsi: false, long_tf: '4h', shared: { pivot_strength: 10, use_pattern: true, scan_interval: 60, timeframe: '1d', ema_slow: 500 } } });
    expect(r.body.ok).toBe(true);
    const s = ts.get(uid);
    expect(s).toMatchObject({ min_quality: 7, use_rsi: false, long_tf: '4h', pivot_strength: 10, use_pattern: true, scan_interval: 60, timeframe: '1d', ema_slow: 500 });
    expect(s.long_cfg).toBe('{"min_rr": 2.5, "_sparse": true}');
    expect(r.body.settings.levels.long).toMatchObject({ min_rr: 2.5, pivot_strength: 10, overrides: ['min_rr'] });
    expect(r.body.settings.levels.shared.pivot_strength).toBe(10);
  });
  it('levels.long / levels.short: sparse overrides, interval column, reset (then re-apply in the same payload)', async () => {
    const uid = makeUser({ pro: true });
    let r = await post(uid, { levels: { long: { pivot_strength: 5, use_htf: true, tp2_rr: 7, interval: 900 }, short: { min_rr: 3.0, interval: 86400 } } });
    let s = ts.get(uid);
    expect(s.long_cfg).toBe('{"pivot_strength": 5, "use_htf": true, "tp2_rr": 7.0, "_sparse": true}');
    expect(s.short_cfg).toBe('{"min_rr": 3.0, "_sparse": true}');
    expect([s.long_interval, s.short_interval]).toEqual([900, 86400]);
    expect(r.body.settings.levels.long).toMatchObject({ pivot_strength: 5, use_htf: true, tp2_rr: 7, interval: 900, overrides: ['pivot_strength', 'use_htf', 'tp2_rr'] });
    expect(r.body.settings.levels.short).toMatchObject({ min_rr: 3, tp1_rr: 3, interval: 86400, overrides: ['min_rr'] });
    r = await post(uid, { levels: { long: { reset: true, zone_buffer: 0.5 }, short: { reset: true } } });
    s = ts.get(uid);
    expect(s.long_cfg).toBe('{"zone_buffer": 0.5, "_sparse": true}');
    expect(s.short_cfg).toBe('{}');
    expect(r.body.settings.levels.short.overrides).toEqual([]);
    r = await post(uid, { levels: { long: { reset: false } } });       // reset:false changes nothing
    expect(ts.get(uid).long_cfg).toBe('{"zone_buffer": 0.5, "_sparse": true}');
  });
  it('smc: cfg JSON, max_sl_pct column, direction → flags, advanced keys, ct quality column', async () => {
    const uid = makeUser({ pro: true });
    const r = await post(uid, { smc: { tf_key: '4H', direction: 'SHORT', max_sl_pct: 7.5, scan_interval: 600, advanced: { min_confirmations: 4, smc_conf_type: 'WICK_TOUCH', smc_pd_filter: true, ob_max_age: 100, smc_counter_trend_min_quality: 0 } } });
    expect(r.body.ok).toBe(true);
    const s = ts.get(uid);
    expect(s).toMatchObject({ smc_max_sl_pct: 7.5, smc_long_active: false, smc_short_active: true, smc_counter_trend_min_quality: 0 });
    expect(JSON.parse(s.smc_cfg)).toMatchObject({ tf_key: '4H', direction: 'SHORT', scan_interval: 600, min_confirmations: 4, smc_conf_type: 'WICK_TOUCH', smc_pd_filter: true, ob_max_age: 100 });
    expect(s.smc_cfg.startsWith('{"tf_key": "4H", "scan_interval": 600, "direction": "SHORT"')).toBe(true);
    expect(r.body.settings.smc).toMatchObject({ tf_key: '4H', direction: 'SHORT', max_sl_pct: 7.5, scan_interval: 600 });
    expect(r.body.settings.smc.advanced).toMatchObject({ min_confirmations: 4, smc_conf_type: 'WICK_TOUCH', smc_pd_filter: true, ob_max_age: 100, smc_counter_trend_min_quality: 0 });
    await post(uid, { smc: { direction: 'BOTH' } });
    expect(ts.get(uid)).toMatchObject({ smc_long_active: true, smc_short_active: true });
    await post(uid, { smc: { direction: 'LONG' } });
    expect(ts.get(uid)).toMatchObject({ smc_long_active: true, smc_short_active: false });
  });
  it('trading / ptp columns', async () => {
    const uid = makeUser({ pro: true });
    const r = await post(uid, { trading: { auto_trade_mode: 'auto', trade_risk_pct: 0.25, trade_leverage: 50, max_trades_limit: 1, risk_mode: 'notional', partial_tp_enabled: false, auto_trailing_enabled: false, prefer_market_entry: true, bybit_demo: true, trade_exchange: 'bingx' }, ptp: { ptp_mode: 'PCT', partial_tp1_r: 0.75, partial_tp2_r: 3, partial_tp1_pct: 20, partial_tp2_pct: 40, ptp_profit_pct1: 15, ptp_profit_pct2: 100 } });
    expect(r.body.ok).toBe(true);
    expect(ts.get(uid)).toMatchObject({ auto_trade_mode: 'auto', trade_risk_pct: 0.25, trade_leverage: 50, max_trades_limit: 1, risk_mode: 'notional', partial_tp_enabled: false, auto_trailing_enabled: false, prefer_market_entry: true, bybit_demo: true, trade_exchange: 'bingx', ptp_mode: 'PCT', partial_tp1_r: 0.75, partial_tp2_r: 3, partial_tp1_pct: 20, partial_tp2_pct: 40, ptp_profit_pct1: 15, ptp_profit_pct2: 100 });
    expect(r.body.settings.ptp).toEqual({ ptp_mode: 'PCT', partial_tp1_r: 0.75, partial_tp2_r: 3, partial_tp1_pct: 20, partial_tp2_pct: 40, ptp_profit_pct1: 15, ptp_profit_pct2: 100 });
  });
  it('risk coupling: threshold > 0 enables the breaker; enabling with threshold ≤ 0 sets 5.0', async () => {
    const uid = makeUser();
    let r = await post(uid, { risk: { circuit_breaker_threshold_r: 10 } });
    expect(r.body.settings.risk).toMatchObject({ circuit_breaker_enabled: true, circuit_breaker_threshold_r: 10 });
    r = await post(uid, { risk: { circuit_breaker_threshold_r: 0, circuit_breaker_enabled: false } });
    expect(r.body.settings.risk).toMatchObject({ circuit_breaker_enabled: false, circuit_breaker_threshold_r: 0 });
    r = await post(uid, { risk: { circuit_breaker_enabled: true } });
    expect(r.body.settings.risk).toMatchObject({ circuit_breaker_enabled: true, circuit_breaker_threshold_r: 5 });
    r = await post(uid, { risk: { circuit_breaker_threshold_r: 3, circuit_breaker_enabled: false } });
    expect(r.body.settings.risk).toMatchObject({ circuit_breaker_enabled: false, circuit_breaker_threshold_r: 3 });
    r = await post(uid, { risk: { sl_streak_threshold: 20, allow_counter_trend: true, filters_all_off: true, btc_correlation_block: true, spread_check_enabled: false, trade_trending_only: true, hour_filter_enabled: false, sl_streak_enabled: false } });
    expect(ts.get(uid)).toMatchObject({ sl_streak_threshold: 20, allow_counter_trend: true, filters_all_off: true, btc_correlation_block: true, spread_check_enabled: false, trade_trending_only: true, hour_filter_enabled: false, sl_streak_enabled: false });
  });
  it('risk.advanced: spread threshold re-enables the check; reset_all_filters; the toggles', async () => {
    const uid = makeUser();
    await post(uid, { risk: { spread_check_enabled: false, btc_correlation_block: true }, trading: { disabled_days: [1, 2] } });
    let r = await post(uid, { risk: { advanced: { spread_max_pct: 1.0 } } });
    expect(ts.get(uid)).toMatchObject({ spread_max_pct: 1.0, spread_check_enabled: true });
    r = await post(uid, { risk: { advanced: { reset_all_filters: true } } });
    expect(ts.get(uid)).toMatchObject({ filters_all_off: true, allow_counter_trend: true, btc_correlation_block: false, autotrade_disabled_days: '' });
    expect(r.body.settings.trading.disabled_days).toEqual([]);
    await post(uid, { risk: { btc_correlation_block: true } });
    await post(uid, { risk: { advanced: { reset_all_filters: false } } });
    expect(ts.get(uid).btc_correlation_block).toBe(true);
    r = await post(uid, { risk: { advanced: { allow_low_notional_boost: true, show_risk_preview: false, correlation_cap_enabled: true, correlation_cap_threshold: 0.5, adaptive_sizing_enabled: true, adaptive_sizing_mode: 'kelly', tilt_detector_enabled: false, hold_lock_enabled: true, min_signal_quality: 5 } } });
    expect(ts.get(uid)).toMatchObject({ allow_low_notional_boost: true, show_risk_preview: false, correlation_cap_enabled: true, correlation_cap_threshold: 0.5, adaptive_sizing_enabled: true, adaptive_sizing_mode: 'kelly', tilt_detector_enabled: false, hold_lock_enabled: true, min_signal_quality: 5 });
    expect(r.body.settings.risk.advanced).toMatchObject({ adaptive_sizing_mode: 'kelly', min_signal_quality: 5, hold_lock_min_rr: 0.5 });
  });
  it('notifications: quiet pair quirks (only start → start+9; only end keeps the stored start), the other keys', async () => {
    const uid = makeUser();
    let r = await post(uid, { notifications: { quiet_start: 22 } });
    expect(r.body.settings.notifications).toMatchObject({ quiet_start: 22, quiet_end: 7 });
    r = await post(uid, { notifications: { quiet_end: 9 } });
    expect(r.body.settings.notifications).toMatchObject({ quiet_start: 22, quiet_end: 9 });
    r = await post(uid, { notifications: { quiet_start: 5, quiet_end: 5 } });
    expect(r.body.settings.notifications).toMatchObject({ quiet_start: 5, quiet_end: 14 });
    r = await post(uid, { notifications: { quiet_start: -1, quiet_end: 9 } });
    expect(r.body.settings.notifications).toMatchObject({ quiet_start: -1, quiet_end: -1 });
    expect((await post(uid, { notifications: { quiet_start: 24 } })).body).toEqual(bad('notifications.quiet_start'));
    r = await post(uid, { notifications: { progress_notify_enabled: false, send_chart_enabled: 'off', signal_format: 'lite', notify_signal: false, notify_breakout: true } });
    expect(ts.get(uid)).toMatchObject({ progress_notify_enabled: false, send_chart_enabled: false, signal_format: 'lite', notify_signal: false, notify_breakout: true });
    expect((await post(uid, { notifications: { signal_format: 'short' } })).body).toEqual(bad('notifications.signal_format'));
  });
  it('top-level keys (pro): lang, ui_mode, genome_auto_apply', async () => {
    const uid = makeUser({ pro: true });
    const r = await post(uid, { lang: 'en', ui_mode: 'expert', genome_auto_apply: '1' });
    expect(r.body.settings).toMatchObject({ lang: 'en', ui_mode: 'expert', genome_auto_apply: true });
    expect(ts.get(uid)).toMatchObject({ lang: 'en', ui_mode: 'expert', genome_auto_apply: true });
  });
});

describe('POST settings/all — D9 keys found by the M7 verification', () => {
  it('trading.max_trades_limit takes the Telegram custom range 0..9999 (0 = unlimited)', async () => {
    const uid = makeUser({ pro: true });
    expect((await post(uid, { trading: { max_trades_limit: 0 } })).body.ok).toBe(true);
    expect(ts.get(uid).max_trades_limit).toBe(0);
    expect((await post(uid, { trading: { max_trades_limit: 9999 } })).body.ok).toBe(true);
    expect(ts.get(uid).max_trades_limit).toBe(9999);
    expect((await post(uid, { trading: { max_trades_limit: 10000 } })).body).toEqual(bad('trading.max_trades_limit'));
    expect((await post(uid, { trading: { max_trades_limit: -1 } })).body).toEqual(bad('trading.max_trades_limit'));
    expect((await post(uid, { trading: { max_trades_limit: 50 } })).body.ok).toBe(true);
  });

  it('trading.optimizer_enabled / optimizer_strategies (optimizer_menu, Free too)', async () => {
    const uid = makeUser();                                   // free — the bot's optimizer menu has no plan gate
    let r = await post(uid, { trading: { optimizer_enabled: true, optimizer_strategies: ['smc', 'LEVELS', 'SMC'] } });
    expect(r.body.ok).toBe(true);
    expect(ts.get(uid)).toMatchObject({ optimizer_enabled: true, optimizer_strategies: 'SMC,LEVELS' });   // insertion order kept
    expect(r.body.settings.trading).toMatchObject({ optimizer_enabled: true, optimizer_strategies: 'SMC,LEVELS' });
    r = await post(uid, { trading: { optimizer_strategies: 'levels' } });
    expect(ts.get(uid).optimizer_strategies).toBe('LEVELS');
    r = await post(uid, { trading: { optimizer_strategies: [] } });
    expect(ts.get(uid).optimizer_strategies).toBe('LEVELS');                                             // handler: empty → "LEVELS"
    r = await post(uid, { trading: { optimizer_strategies: ', ,' } });
    expect(ts.get(uid).optimizer_strategies).toBe('LEVELS');
    expect((await post(uid, { trading: { optimizer_strategies: 'VOLUME' } })).body).toEqual(bad('trading.optimizer_strategies'));
    expect((await post(uid, { trading: { optimizer_strategies: 5 } })).body).toEqual(bad('trading.optimizer_strategies'));
    expect((await post(uid, { trading: { optimizer_strategies: [1] } })).body).toEqual(bad('trading.optimizer_strategies'));
    expect((await post(uid, { trading: { optimizer_enabled: 'maybe' } })).body).toEqual(bad('trading.optimizer_enabled'));
    expect((await post(uid, { trading: { optimizer_enabled: false, trade_leverage: 5 } })).body).toEqual({ ok: false, error: 'pro_required' });
    expect((await getAll(uid)).body.options.choices['trading.optimizer_strategies']).toEqual(['LEVELS', 'SMC']);
  });

  it('numeric strings with PEP 515 underscores are accepted like Python float()', async () => {
    const uid = makeUser({ pro: true });
    expect((await post(uid, { levels: { min_quality: '1_0' } })).body.ok).toBe(true);
    expect(ts.get(uid).min_quality).toBe(10);
    expect((await post(uid, { levels: { min_volume_usdt: '1_000_000.5' } })).body.ok).toBe(true);
    expect(ts.get(uid).min_volume_usdt).toBe(1000000.5);
    expect((await post(uid, { levels: { min_quality: '1__0' } })).body).toEqual(bad('levels.min_quality'));
    expect((await post(uid, { levels: { min_quality: '_10' } })).body).toEqual(bad('levels.min_quality'));
    expect((await post(uid, { levels: { min_quality: '10_' } })).body).toEqual(bad('levels.min_quality'));
  });
});

describe('POST profile / settings/reset / volume/reset', () => {
  it('profile: unknown name → bad_request "name"; free vs pro apply and the settings payload', async () => {
    const uid = makeUser();
    let r = await request(app).post('/api/app/profile').set(H(uid)).send({ name: 'balanced' });
    expect(r.body).toEqual(bad('name'));
    r = await request(app).post('/api/app/profile').set(H(uid)).send({ name: 'Conservative' });
    expect(r.body).toMatchObject({ ok: true, profile: 'conservative', skipped: ['volume.min_quality', 'strategy.SMC'] });
    expect(r.body.applied).toContain('strategy.LEVELS');
    expect(r.body.settings.levels.min_quality).toBe(7);
    expect(r.body.settings.notifications).toMatchObject({ quiet_start: 23, quiet_end: 7 });
    expect(r.body.settings.trading).toMatchObject({ trade_risk_pct: 0.5, trade_leverage: 5, max_trades_limit: 3, auto_trade_mode: 'confirm' });
    const puid = makeUser({ pro: true });
    r = await request(app).post('/api/app/profile').set(H(puid)).send({ name: 'active' });
    expect(r.body.skipped).toEqual([]);
    expect(r.body.settings.volume.min_quality).toBe(3);
    expect(ts.get(puid).extra_strategies).toBe('SMC,VOLUME');
  });
  it('settings/reset: factory defaults, preserved columns, response = fresh settings', async () => {
    const uid = makeUser({ pro: true });
    await post(uid, { levels: { min_rr: 4, long: { pivot_strength: 5 } }, lang: 'en', trading: { trade_exchange: 'okx', bybit_demo: true } });
    const r = await request(app).post('/api/app/settings/reset').set(H(uid)).send({});
    expect(r.body.ok).toBe(true);
    expect(r.body.settings.levels.min_rr).toBe(2);
    expect(r.body.settings.levels.long.overrides).toEqual([]);
    expect(r.body.settings.lang).toBe('en');
    expect(r.body.settings.trading).toMatchObject({ trade_exchange: 'okx', bybit_demo: true });
    expect(ts.get(uid).sub_plan).toBe('pro');
  });
  it('volume/reset: Pro only; keeps the UI prefs, resets the genome-style params', async () => {
    const uid = makeUser();
    expect((await request(app).post('/api/app/volume/reset').set(H(uid)).send({})).body).toEqual({ ok: false, error: 'pro_required' });
    const puid = makeUser({ pro: true });
    await post(puid, { volume: { setup_cross: false, ma_type: 'ema', vol_mult: 3 } });
    const r = await request(app).post('/api/app/volume/reset').set(H(puid)).send({});
    expect(r.body.ok).toBe(true);
    expect(r.body.settings.volume).toMatchObject({ setup_cross: false, ma_type: 'sma', vol_mult: 1.5 });
  });
});
