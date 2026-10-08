/**
 * userAccess.js — UserSettings.check_access / grant_access / can / plan_limit /
 * is_mutual_exclusion_required / plan_label / time_left_str. Reference values
 * printed by the bot:
 *   banned → (False,'banned'); free+expired → (True,'free'); pro live → (True,'active');
 *   pro dead (vol on, strategy VOLUME) → (True,'free') active free long_active vol off LEVELS;
 *   pro dead with short on → long stays off; legacy expired pro → downgrade; trial live → 'trial';
 *   unknown status → (False,'unknown').
 *   grant_access: free → now+30d, reminder flags reset; pro live +10d → +40d; pro past → now+30d;
 *   banned → False; free "active for a year" → now+30d.
 */
import { describe, it, expect } from 'vitest';
import A from '../../services/engine/userAccess.js';

const NOW = 1_800_000_000;
const u = (o = {}) => ({
  sub_status: 'expired', sub_plan: 'free', sub_expires: 0, long_active: false, short_active: false,
  vol_long_active: false, vol_short_active: false, strategy: 'LEVELS', active: false, scan_mode: 'both',
  expired_notified: false, reminder_3d_sent: false, reminder_1d_sent: false, ...o,
});

describe('check_access', () => {
  it('banned / free / pro live / trial / unknown', () => {
    expect(A.checkAccess(u({ sub_status: 'banned', sub_plan: 'pro' }), { now: NOW })).toEqual([false, 'banned']);
    expect(A.checkAccess(u(), { now: NOW })).toEqual([true, 'free']);
    expect(A.checkAccess(u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW + 100 }), { now: NOW })).toEqual([true, 'active']);
    expect(A.checkAccess(u({ sub_status: 'trial', sub_plan: 'pro', sub_expires: NOW + 100 }), { now: NOW })).toEqual([true, 'trial']);
    expect(A.checkAccess(u({ sub_status: 'weird', sub_plan: 'pro' }), { now: NOW })).toEqual([false, 'unknown']);
  });
  it('expired pro → free active in memory, LONG on when no direction, tier-locked flags disabled', () => {
    const x = u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW - 100, vol_long_active: true, strategy: 'VOLUME' });
    expect(A.checkAccess(x, { now: NOW })).toEqual([true, 'free']);
    expect(x).toMatchObject({ sub_status: 'active', sub_plan: 'free', long_active: true, vol_long_active: false, strategy: 'LEVELS' });
    const y = u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW - 100, short_active: true });
    A.checkAccess(y, { now: NOW });
    expect([y.long_active, y.short_active]).toEqual([false, true]);
    const z = u({ sub_status: 'expired', sub_plan: 'pro', sub_expires: NOW - 100 });
    expect(A.checkAccess(z, { now: NOW })).toEqual([true, 'free']);
    expect(z.long_active).toBe(true);
  });
  it('admins keep the VOLUME flags on downgrade', () => {
    const x = u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW - 100, vol_long_active: true, strategy: 'VOLUME' });
    A.checkAccess(x, { now: NOW, admin: true });
    expect(x.vol_long_active).toBe(true);
    expect(x.strategy).toBe('VOLUME');
    expect(A.disableTierLockedFlags(u({ vol_short_active: true }))).toEqual(['vol_short_active']);
  });
  it('isPro = access ok and normalized plan pro', () => {
    expect(A.isPro(u({ sub_status: 'active', sub_plan: 'elite', sub_expires: NOW + 1 }), { now: NOW })).toBe(true);
    expect(A.isPro(u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW - 1 }), { now: NOW })).toBe(false);
    expect(A.isPro(u({ sub_status: 'banned', sub_plan: 'pro' }), { now: NOW })).toBe(false);
    expect(A.isPro(null)).toBe(false);
  });
});

describe('grant_access', () => {
  it('free → from now; reminder flags reset', () => {
    const x = u({ sub_expires: NOW + 365 * 86400, reminder_3d_sent: true, expired_notified: true });
    expect(A.grantAccess(x, 30, { now: NOW })).toBe(true);
    expect(x.sub_expires - NOW).toBe(30 * 86400);
    expect(x.sub_status).toBe('active');
    expect([x.reminder_3d_sent, x.reminder_1d_sent, x.expired_notified]).toEqual([false, false, false]);
  });
  it('live pro extends from the current expiry; past pro from now; free-active from now; banned refused', () => {
    const live = u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW + 10 * 86400 });
    A.grantAccess(live, 30, { now: NOW });
    expect(live.sub_expires - NOW).toBe(40 * 86400);
    const past = u({ sub_status: 'active', sub_plan: 'pro', sub_expires: NOW - 10 * 86400 });
    A.grantAccess(past, 30, { now: NOW });
    expect(past.sub_expires - NOW).toBe(30 * 86400);
    const freeActive = u({ sub_status: 'active', sub_plan: 'free', sub_expires: NOW + 300 * 86400 });
    A.grantAccess(freeActive, 30, { now: NOW });
    expect(freeActive.sub_expires - NOW).toBe(30 * 86400);
    expect(A.grantAccess(u({ sub_status: 'banned' }), 30, { now: NOW })).toBe(false);
  });
});

describe('can / plan_limit / mutex / label / any_active / time_left', () => {
  it('legacy elite reads as pro; unknown plan reads as free; the raw mutex check', () => {
    const e = u({ sub_plan: 'elite' });
    expect(A.planLabel(e)).toBe('⭐ Pro');
    expect(A.can(e, 'smc')).toBe(true);
    expect(A.planLimit(e, 'analyze_per_day')).toBe(999);
    expect(A.isMutualExclusionRequired(e)).toBe(false);
    const w = u({ sub_plan: 'weird' });
    expect(A.isMutualExclusionRequired(w)).toBe(false);   // raw compare with "free" (bot quirk)
    expect(A.can(w, 'smc')).toBe(false);
    expect(A.isMutualExclusionRequired(u())).toBe(true);
    expect(A.isMutualExclusionRequired(u({ sub_plan: '' }))).toBe(true);
  });
  it('admin bypass', () => {
    const f = u();
    expect(A.can(f, 'smc', { admin: true })).toBe(true);
    expect(A.planLimit(f, 'analyze_per_day', { admin: true })).toBe(999999);
    expect(A.planLimit(f, 'smc', { admin: true })).toBe(999999);     // bool is int in Python
    expect(A.planLimit(f, 'strategies', { admin: true })).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(A.isMutualExclusionRequired(f, { admin: true })).toBe(false);
  });
  it('any_active and time_left_str', () => {
    expect(A.anyActive(u())).toBe(false);
    expect(A.anyActive(u({ short_active: true }))).toBe(true);
    expect(A.anyActive(u({ active: true, scan_mode: 'both' }))).toBe(true);
    expect(A.anyActive(u({ active: true, scan_mode: 'long' }))).toBe(false);
    expect(A.timeLeftStr(u({ sub_expires: NOW + 90 }), 'ru', NOW)).toBe('1 мин.');
    expect(A.timeLeftStr(u({ sub_expires: NOW + 3700 }), 'ru', NOW)).toBe('1ч 1м');
    expect(A.timeLeftStr(u({ sub_expires: NOW + 90000 }), 'en', NOW)).toBe('1d 1h');
    expect(A.timeLeftStr(u({ sub_expires: NOW + 86400 + 3599 }), 'ru', NOW)).toBe('1д 0ч');
    expect(A.timeLeftStr(u({ sub_expires: NOW - 1 }), 'ru', NOW)).toBe('истёк');
    expect(A.timeLeftStr(u({ sub_expires: NOW - 1 }), 'en', NOW)).toBe('expired');
  });
});
