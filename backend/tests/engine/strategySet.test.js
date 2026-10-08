/**
 * strategySet.js — miniapp_api._apply_multi truth table (12 cases printed by
 * the bot), _strategies / _strategy_locked.
 */
import { describe, it, expect } from 'vitest';
import ss from '../../services/engine/strategySet.js';

const flags0 = { long_active: false, short_active: false, smc_long_active: false, smc_short_active: false, vol_long_active: false, vol_short_active: false };
const mk = (strategy, extra, flags = {}, more = {}) => ({ strategy, extra_strategies: extra, ...flags0, ...flags, sub_plan: 'pro', sub_status: 'active', sub_expires: 4e9, ...more });

describe('_apply_multi(user, s, on)', () => {
  const cases = [
    // [primary, extras, flags, S, on] → [primary, extras]
    ['LEVELS', '', { long_active: true }, 'SMC', true, 'LEVELS', 'SMC'],
    ['LEVELS', '', {}, 'SMC', true, 'SMC', ''],
    ['LEVELS', 'SMC', { long_active: true }, 'SMC', true, 'LEVELS', 'SMC'],
    ['LEVELS', 'SMC,VOLUME', { long_active: true }, 'SMC', false, 'LEVELS', 'VOLUME'],
    ['LEVELS', 'SMC,VOLUME', { long_active: true }, 'LEVELS', false, 'SMC', 'VOLUME'],
    ['LEVELS', '', { long_active: true }, 'LEVELS', false, 'LEVELS', ''],
    ['SMC', 'LEVELS', {}, 'VOLUME', true, 'VOLUME', 'LEVELS'],
    ['LEVELS', 'VOLUME,SMC,LEVELS', { long_active: true }, 'VOLUME', false, 'LEVELS', 'SMC'],
    ['VOLUME', '', { vol_long_active: true }, 'LEVELS', true, 'VOLUME', 'LEVELS'],
    ['LEVELS', '', { short_active: true }, 'LEVELS', true, 'LEVELS', ''],
    ['', '', {}, 'SMC', true, 'SMC', ''],
    ['LEVELS', 'smc, volume', { long_active: true }, 'SMC', false, 'LEVELS', 'VOLUME'],
  ];
  for (const [p, e, f, s, on, ep, ee] of cases) {
    it(`${p || '∅'} + [${e}] ${s} ${on ? 'on' : 'off'} → ${ep} + [${ee}]`, () => {
      const u = mk(p, e, f);
      ss.applyMulti(u, s, on);
      expect(u.strategy).toBe(ep);
      expect(u.extra_strategies).toBe(ee);
    });
  }
  it('primaryOn reads the primary strategy flags only', () => {
    expect(ss.primaryOn(mk('SMC', '', { long_active: true }))).toBe(false);
    expect(ss.primaryOn(mk('SMC', '', { smc_short_active: true }))).toBe(true);
    expect(ss.primaryOn(mk('', '', { long_active: true }))).toBe(false);
  });
});

describe('_strategy_locked / _strategies', () => {
  it('free: SMC and VOLUME locked, LEVELS not; admin never locked', () => {
    const u = mk('LEVELS', '', {}, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0 });
    expect(ss.strategyLocked(u, 'LEVELS')).toBe(false);
    expect(ss.strategyLocked(u, 'SMC')).toBe(true);
    expect(ss.strategyLocked(u, 'VOLUME')).toBe(true);
    expect(ss.strategyLocked(u, 'SMC', { admin: true })).toBe(false);
  });
  it('pro: nothing locked; an expired pro is treated as free (check_access downgrade in memory)', () => {
    expect(ss.strategyLocked(mk('LEVELS', ''), 'VOLUME')).toBe(false);
    const expired = mk('LEVELS', '', {}, { sub_expires: 1 });
    expect(ss.strategyLocked(expired, 'SMC')).toBe(true);
    expect(expired.sub_plan).toBe('free');        // mutated like the bot
  });
  it('_strategies: long/short/locked/primary/enabled per strategy', () => {
    const u = mk('LEVELS', 'SMC,VOLUME', { long_active: true, smc_short_active: true, vol_long_active: true });
    const st = ss.strategiesState(u);
    expect(st.LEVELS).toEqual({ long: true, short: false, locked: false, primary: true, enabled: true });
    expect(st.SMC).toEqual({ long: false, short: true, locked: false, primary: false, enabled: true });
    expect(st.VOLUME).toEqual({ long: true, short: false, locked: false, primary: false, enabled: true });
    // free user: extras are plan-filtered → SMC not enabled even with a flag on; primary is not plan-filtered
    const f = mk('SMC', 'VOLUME', { smc_long_active: true, vol_long_active: true }, { sub_plan: 'free', sub_status: 'expired', sub_expires: 0 });
    const sf = ss.strategiesState(f);
    expect(sf.SMC.enabled).toBe(true);           // QUIRK: primary not plan-filtered
    expect(sf.SMC.locked).toBe(true);
    expect(sf.VOLUME.enabled).toBe(false);
    expect(ss.enabledStrategies(f)).toEqual(['SMC']);
  });
});
