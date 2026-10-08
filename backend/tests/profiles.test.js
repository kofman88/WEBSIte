/**
 * profilesService — profiles.apply_profile for free vs pro (bot output:
 *   free conservative → applied [levels.min_quality, trade_risk_pct, trade_leverage, max_trades_limit,
 *     allow_counter_trend, levels_counter_trend_min_quality, auto_trade_mode, quiet_hours, strategy.LEVELS],
 *     skipped [volume.min_quality, strategy.SMC]; min_quality 7, long on, short off, scan_mode long, quiet 23/7, confirm, 0.5
 *   pro active → all applied except volume.min_quality when the kv table is missing (here: applied),
 *     min_quality 5, both directions on for all three, scan_mode both, extras "SMC,VOLUME", quiet off, 1.5 / 10 / 5 / ct on / 4)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-profiles.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, ts, prof, vuc;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  ts = (await import('../services/traderSettingsService.js')).default;
  prof = (await import('../services/profilesService.js')).default;
  vuc = (await import('../services/volumeUserCfg.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
});

function makeUser({ pro = false } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const uid = db.prepare('INSERT INTO users (email, password_hash, referral_code) VALUES (?, ?, ?)').run(e, 'x', ref).lastInsertRowid;
  const u = ts.getOrCreate(uid);
  if (pro) { u.sub_plan = 'pro'; u.sub_status = 'active'; u.sub_expires = Date.now() / 1000 + 86400; ts.save(u); }
  return ts.get(uid);
}

describe('apply_profile', () => {
  it('free + conservative: SMC and VOLUME parts skipped, LEVELS long only (mutex), quiet 23–07, confirm', () => {
    const u = makeUser();
    const r = prof.applyProfile(u, 'conservative');
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['levels.min_quality', 'trade_risk_pct', 'trade_leverage', 'max_trades_limit', 'allow_counter_trend', 'levels_counter_trend_min_quality', 'auto_trade_mode', 'quiet_hours', 'strategy.LEVELS']);
    expect(r.skipped).toEqual(['volume.min_quality', 'strategy.SMC']);
    const s = ts.get(u.user_id);
    expect(s).toMatchObject({ min_quality: 7, long_active: true, short_active: false, active: true, scan_mode: 'long', strategy: 'LEVELS', extra_strategies: '', quiet_start: 23, quiet_end: 7, auto_trade_mode: 'confirm', trade_risk_pct: 0.5, trade_leverage: 5, max_trades_limit: 3, allow_counter_trend: false, levels_counter_trend_min_quality: 5 });
    expect(db.prepare('SELECT COUNT(*) n FROM engine_kv').get().n).toBe(0);   // VOLUME cfg untouched
  });
  it('pro + active: everything applied, all three strategies both directions, extras SMC,VOLUME, quiet off, mode unchanged', () => {
    const u = makeUser({ pro: true });
    u.auto_trade_mode = 'auto'; ts.save(u);
    const r = prof.applyProfile(u, 'ACTIVE');
    expect(r.profile).toBe('active');
    expect(r.applied).toEqual(['levels.min_quality', 'volume.min_quality', 'trade_risk_pct', 'trade_leverage', 'max_trades_limit', 'allow_counter_trend', 'levels_counter_trend_min_quality', 'quiet_hours', 'strategy.LEVELS', 'strategy.SMC', 'strategy.VOLUME']);
    expect(r.skipped).toEqual([]);
    const s = ts.get(u.user_id);
    expect(s).toMatchObject({ min_quality: 5, long_active: true, short_active: true, smc_long_active: true, smc_short_active: true, vol_long_active: true, vol_short_active: true, active: true, scan_mode: 'both', strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', quiet_start: -1, quiet_end: -1, auto_trade_mode: 'auto', trade_risk_pct: 1.5, trade_leverage: 10, max_trades_limit: 5, allow_counter_trend: true, levels_counter_trend_min_quality: 4 });
    expect(vuc.loadUserCfg(u.user_id).min_quality).toBe(3);
    // conservative on pro writes VOLUME quality 4 and keeps the long/short JSON untouched
    s.long_cfg = '{"min_rr": 2.5, "_sparse": true}';
    prof.applyProfile(s, 'conservative');
    expect(vuc.loadUserCfg(u.user_id).min_quality).toBe(4);
    expect(ts.get(u.user_id).long_cfg).toBe('{"min_rr": 2.5, "_sparse": true}');
  });
  it('unknown profile; save=false leaves the row alone; enableStrategy refuses plan-locked strategies', () => {
    const u = makeUser();
    expect(prof.applyProfile(u, 'xx')).toEqual({ ok: false, error: 'unknown_profile' });
    prof.applyProfile(u, 'active', { save: false });
    expect(ts.get(u.user_id).min_quality).toBe(3);
    expect(prof.enableStrategy(u, 'SMC')).toBe(false);
    expect(prof.enableStrategy(u, 'SMC', { admin: true })).toBe(true);
    expect(prof.enableStrategy(u, 'NOPE')).toBe(false);
  });
  it('summary_text with and without skipped parts (RU / EN verbatim)', () => {
    expect(prof.summaryText('conservative', { applied: [], skipped: ['strategy.SMC', 'volume.min_quality', 'quiet_hours'] }, 'ru'))
      .toBe('🎚 <b>Профиль «Консервативный» применён</b>\nКачество 4★+, риск 0.5%, плечо 5, до 3 сделок, вход с подтверждением, только по тренду, тихие часы 23–07 UTC, стратегии: Уровни + SMC\n\n<i>Часть пропущена — доступно на Pro: SMC, min_quality</i>');
    expect(prof.summaryText('active', { skipped: [] }, 'en'))
      .toBe('🎚 <b>Profile «Active» applied</b>\nQuality 3★+, 1.5% risk, 10x, up to 5 trades, counter-trend from 4★, no quiet hours, strategies: Levels + SMC + Volume');
    expect(prof.title('active', 'en')).toBe('Active');
    expect(prof.title('zzz')).toBe('zzz');
    expect(prof.describe('zzz')).toBe('');
  });
});
