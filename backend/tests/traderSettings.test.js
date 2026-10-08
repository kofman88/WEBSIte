/**
 * traderSettingsService — row lifecycle over trader_settings, _from_db / to_db
 * coercions, db_get_active_users SQL, 30 s caches, factory reset, admin bypass.
 * volumeUserCfg — kv volume_cfg_<uid> load / save(keep_prefs) / reset.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-trader-settings.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, ts, vuc, kv;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  ts = (await import('../services/traderSettingsService.js')).default;
  vuc = (await import('../services/volumeUserCfg.js')).default;
  kv = (await import('../services/engineKvService.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
});

function makeUser({ isAdmin = 0, locale = 'ru' } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin, locale) VALUES (?, ?, ?, ?, ?)')
    .run(e, 'x', ref, isAdmin, locale).lastInsertRowid;
}

describe('getOrCreate / defaults', () => {
  it('a new row carries the dataclass defaults (incl. the 8 DB-vs-dataclass mismatches) and lang from locale', () => {
    const uid = makeUser({ locale: 'uk' });
    const u = ts.getOrCreate(uid);
    expect(u).toMatchObject({
      user_id: uid, sub_status: 'expired', sub_plan: 'free', sub_expires: 0, trial_used: true, scan_interval: 300,
      min_volume_usdt: 300000, partial_tp_enabled: true, partial_tp1_pct: 50, partial_tp2_pct: 40, ui_mode: 'simple',
      lang: 'ru', strategy: 'LEVELS', long_cfg: '{}', smc_cfg: '{}', quiet_start: -1, extra_strategies: '',
      ai_filter_settings: { market_regime: true, news_monitor: true, genome_engine: false },
    });
    expect(ts.getOrCreate(makeUser({ locale: 'de' })).lang).toBe('en');
    expect(ts.getOrCreate(uid)).toEqual(u);            // idempotent
    expect(ts.get(999999)).toBeNull();
    expect(() => ts.getOrCreate(999999)).toThrow(/User not found/);
    expect(typeof u.created_at).toBe('number');
    expect(u.created_at).toBeGreaterThan(0);
  });
  it('toDb writes bools as 0/1 and the ai_filter dict as Python json; fromDb reverses it', () => {
    const uid = makeUser();
    const u = ts.getOrCreate(uid);
    u.use_rsi = false; u.min_rr = 0.8; u.strategy = 'SMC'; u.ai_filter_settings.genome_engine = true;
    ts.save(u);
    const row = ts.getRow(uid);
    expect(row.use_rsi).toBe(0);
    expect(row.min_rr).toBe(0.8);
    expect(row.ai_filter_settings).toBe('{"market_regime": true, "news_monitor": true, "genome_engine": true}');
    expect(row.updated_at).toBeGreaterThan(0);
    const back = ts.get(uid);
    expect(back.use_rsi).toBe(false);
    expect(back.min_rr).toBe(0.8);
    expect(back.ai_filter_settings.genome_engine).toBe(true);
    expect(ts.toDb({ user_id: 1, use_rsi: true, bybit_demo: 1, bogus: 3 })).toEqual({ user_id: 1, use_rsi: 1, bybit_demo: 1 });
  });
  it('fromDb: strategy / sub_plan normalised, NULL keeps the default, junk ints fall back, bad JSON keeps the default', () => {
    const u = ts.fromDb({ user_id: 5, strategy: 'FOO', sub_plan: 'elite', min_quality: 'abc', vol_mult: 'x', ai_filter_settings: '{bad', lang: null, trade_leverage: 7.9 });
    expect(u.strategy).toBe('LEVELS');
    expect(u.sub_plan).toBe('pro');
    expect(u.min_quality).toBe(3);
    expect(u.vol_mult).toBe(1.0);
    expect(u.ai_filter_settings).toEqual({ market_regime: true, news_monitor: true, genome_engine: false });
    expect(u.lang).toBe('ru');
    expect(u.trade_leverage).toBe(7);
    expect(ts.fromDb({ user_id: 5, ai_filter_settings: { a: 1 } }).ai_filter_settings).toEqual({ a: 1 });
  });
  it('save: created_at set once and never updated; updated_at every save', () => {
    const uid = makeUser();
    const u = ts.getOrCreate(uid, { now: 1000 });
    expect(ts.getRow(uid).created_at).toBe(1000);
    ts.save(u, { now: 2000 });
    expect(ts.getRow(uid)).toMatchObject({ created_at: 1000, updated_at: 2000 });
    u.created_at = 5;
    ts.save(u, { now: 3000 });
    expect(ts.getRow(uid)).toMatchObject({ created_at: 1000, updated_at: 3000 });
  });
});

describe('getActiveUsers / allUsers (bot SQL + 30 s TTL cache)', () => {
  it('free users count when any flag is on; paid users only while sub_expires > now; nobody without flags', () => {
    const now = 1_800_000_000;
    const a = ts.getOrCreate(makeUser());                // free, no flags
    const b = ts.getOrCreate(makeUser()); b.long_active = true; ts.save(b);
    const c = ts.getOrCreate(makeUser()); c.sub_plan = 'pro'; c.sub_status = 'active'; c.sub_expires = now + 10; c.smc_short_active = true; ts.save(c);
    const d = ts.getOrCreate(makeUser()); d.sub_plan = 'pro'; d.sub_status = 'active'; d.sub_expires = now - 10; d.vol_long_active = true; ts.save(d);
    const e = ts.getOrCreate(makeUser()); e.sub_plan = 'pro'; e.sub_status = 'expired'; e.sub_expires = now + 10; e.active = true; ts.save(e);
    const f = ts.getOrCreate(makeUser()); f.sub_plan = 'free'; f.sub_status = 'banned'; f.active = true; ts.save(f);   // SQL does not know "banned"
    const ids = ts.getActiveUsers({ now }).map((x) => x.user_id).sort();
    expect(ids).toEqual([b.user_id, c.user_id, f.user_id].sort());
    expect(ts.allUsers({ now }).length).toBe(6);
    expect(a.user_id).toBeTruthy();
  });
  it('the list is cached for 30 s and invalidated by save', () => {
    const now = 1_800_000_000;
    const a = ts.getOrCreate(makeUser()); a.long_active = true; ts.save(a);
    expect(ts.getActiveUsers({ now }).length).toBe(1);
    db.prepare('UPDATE trader_settings SET long_active = 0 WHERE user_id = ?').run(a.user_id);   // behind the cache's back
    expect(ts.getActiveUsers({ now: now + 10 }).length).toBe(1);
    expect(ts.getActiveUsers({ now: now + 31 }).length).toBe(0);
    db.prepare('UPDATE trader_settings SET long_active = 1 WHERE user_id = ?').run(a.user_id);
    expect(ts.getActiveUsers({ now: now + 32 }).length).toBe(0);
    ts.save(a);                                           // invalidates
    expect(ts.getActiveUsers({ now: now + 33 }).length).toBe(1);
  });
});

describe('resetSettings (db_reset_user_settings)', () => {
  it('rebuilds the defaults but keeps the _RESET_PRESERVE columns', () => {
    const uid = makeUser();
    const u = ts.getOrCreate(uid, { now: 50 });
    Object.assign(u, { lang: 'en', sub_plan: 'pro', sub_status: 'active', sub_expires: 123, onboarding_done: true, trade_exchange: 'okx', bybit_demo: true, prop_mode: true, prop_firm: 'FTMO',
      min_rr: 3.3, long_active: true, auto_trade: true, long_cfg: '{"min_rr": 2.5, "_sparse": true}', quiet_start: 22, quiet_end: 7, active: true, reminder_3d_sent: true });
    ts.save(u, { now: 50 });
    expect(ts.resetSettings(uid, { now: 60 })).toBe(true);
    const r = ts.get(uid);
    expect(r).toMatchObject({ lang: 'en', sub_plan: 'pro', sub_status: 'active', sub_expires: 123, onboarding_done: true, trade_exchange: 'okx', bybit_demo: true, prop_mode: true, prop_firm: 'FTMO', active: true, reminder_3d_sent: true });
    expect(r).toMatchObject({ min_rr: 2.0, long_active: false, auto_trade: false, long_cfg: '{}', quiet_start: -1, quiet_end: -1 });
    expect(ts.getRow(uid).created_at).toBe(50);
    expect(ts.getRow(uid).updated_at).toBe(60);
    expect(ts.resetSettings(424242)).toBe(false);
  });
});

describe('admin bypass wrappers', () => {
  it('can / planLimit / mutex / isPro resolve the admin flag from users.is_admin', () => {
    const admin = ts.getOrCreate(makeUser({ isAdmin: 1 }));
    const free = ts.getOrCreate(makeUser());
    expect(ts.can(admin, 'smc')).toBe(true);
    expect(ts.can(free, 'smc')).toBe(false);
    expect(ts.planLimit(admin, 'analyze_per_day')).toBe(999999);
    expect(ts.planLimit(free, 'analyze_per_day')).toBe(1);
    expect(ts.isMutualExclusionRequired(admin)).toBe(false);
    expect(ts.isMutualExclusionRequired(free)).toBe(true);
    expect(ts.isPro(free)).toBe(false);
    expect(ts.can(free, 'smc', { admin: true })).toBe(true);   // explicit override
    expect(ts.checkAccess(free)).toEqual([true, 'free']);
  });
});

describe('volumeUserCfg (kv volume_cfg_<uid>)', () => {
  it('load → defaults when absent; save writes the full dict; keep_prefs copies the UI toggles', () => {
    const uid = makeUser();
    expect(vuc.loadUserCfg(uid).vol_mult).toBe(1.5);
    expect(vuc.userTf({ vol_timeframe: '4H' })).toBe('4h');
    expect(vuc.userTf({ vol_timeframe: '5m' })).toBe('1h');
    expect(vuc.userTf({})).toBe('1h');
    vuc.saveUserCfg(uid, { setup_cross: false, use_htf: false, vol_mult: 2 });
    const raw = kv.get(`volume_cfg_${uid}`);
    expect(JSON.parse(raw)).toMatchObject({ setup_cross: false, use_htf: false, vol_mult: 2, min_quality: 3 });
    expect(Object.keys(JSON.parse(raw)).length).toBe(38);
    expect(raw).toContain('"vol_mult": 2.0');
    // genome-like partial save keeps the prefs, resets other non-given keys to defaults
    vuc.saveUserCfg(uid, { min_quality: 5 });
    const c = vuc.loadUserCfg(uid);
    expect(c).toMatchObject({ setup_cross: false, use_htf: false, min_quality: 5, vol_mult: 1.5 });
    // keep_prefs=false → prefs back to defaults
    vuc.saveUserCfg(uid, { min_quality: 4 }, false);
    expect(vuc.loadUserCfg(uid)).toMatchObject({ setup_cross: true, use_htf: true, min_quality: 4 });
  });
  it('reset keeps only the non-default prefs; a corrupt kv value falls back to defaults', () => {
    const uid = makeUser();
    vuc.saveUserCfg(uid, { setup_golden: false, ma_type: 'ema', vol_mult: 3 });
    vuc.resetUserCfg(uid);
    expect(vuc.loadUserCfg(uid)).toMatchObject({ setup_golden: false, ma_type: 'sma', vol_mult: 1.5 });
    vuc.resetUserCfg(uid, false);
    expect(kv.get(`volume_cfg_${uid}`)).toBeNull();
    kv.set(`volume_cfg_${uid}`, 'not json');
    expect(vuc.loadUserCfg(uid)).toEqual(vuc.loadUserCfg(999));
    expect(kv.incrDay('miniapp_feedback', uid, { now: 86400 * 10 })).toBe(1);
    expect(kv.incrDay('miniapp_feedback', uid, { now: 86400 * 10 + 5 })).toBe(2);
    expect(kv.incrDay('miniapp_feedback', uid, { now: 86400 * 11 })).toBe(1);
    expect(kv.has(`miniapp_feedback_${uid}_10`)).toBe(true);
    expect(kv.del(`miniapp_feedback_${uid}_10`)).toBe(1);
  });
});
