import { describe, it, expect } from 'vitest';
import pf from '../config/planFeatures.js';

// Every key of the bot's PLAN_FEATURES (CHM_BREAKER_V4/config.py) pinned to
// the values in port/specs/signal-pipeline.md §1.2 / data-and-market.md §3.
const SPEC = {
  free: {
    strategies: ['LEVELS'],
    both_directions: false,
    long_only: false,
    auto_trade: false,
    max_trades: 0,
    signals_per_day: 2,
    min_signal_quality: 5,
    signal_window_morning_utc: [6, 13],
    signal_window_evening_utc: [13, 21],
    analyze_per_day: 1,
    symbols_limit: 5,
    timeframes: ['15m', '1h'],
    smc: false,
    volume: false,
    notifications: 'basic',
    optimizer: false,
    target_wr: false,
    genome: false,
    ai_explanations: false,
    multi_exchange: false,
    api_access: false,
    priority_support: false,
    all_timeframes: false,
    more_symbols: false,
    unlimited_trades: false,
    expert_mode: false,
    strategies_extended: false,
    ai_layer_market_regime: false,
    ai_layer_news_monitor: false,
    ai_layer_genome_engine: false,
    ai_plus_tools: false,
    challenge: false,
  },
  pro: {
    strategies: ['LEVELS', 'SMC', 'VOLUME'],
    both_directions: true,
    long_only: false,
    auto_trade: true,
    max_trades: 0,
    signals_per_day: 999,
    min_signal_quality: 3,
    analyze_per_day: 999,
    symbols_limit: 999,
    timeframes: ['15m', '30m', '1h', '4h', '1d'],
    smc: true,
    volume: true,
    notifications: 'premium',
    optimizer: true,
    target_wr: true,
    genome: true,
    ai_explanations: true,
    multi_exchange: true,
    api_access: true,
    priority_support: true,
    all_timeframes: true,
    more_symbols: true,
    unlimited_trades: true,
    expert_mode: true,
    strategies_extended: true,
    ai_layer_market_regime: true,
    ai_layer_news_monitor: true,
    ai_layer_genome_engine: true,
    ai_plus_tools: true,
    challenge: true,
  },
};

describe('PLAN_FEATURES matrix (verbatim)', () => {
  it('has exactly the two bot plans and the bot prices', () => {
    expect(Object.keys(pf.PLAN_FEATURES).sort()).toEqual(['free', 'pro']);
    expect(pf.VALID_PLANS).toEqual(['free', 'pro']);
    expect(pf.PLAN_PRICES_USD).toEqual({ free: 0, pro: 69 });
    expect(pf.PRICE_PRO).toBe('69$');
    expect(pf.PLAN_PERIOD_DAYS).toBe(30);
  });

  for (const plan of ['free', 'pro']) {
    it(`${plan}: every key matches the spec, no extra keys`, () => {
      const row = pf.PLAN_FEATURES[plan];
      expect(Object.keys(row).sort()).toEqual(Object.keys(SPEC[plan]).sort());
      for (const [k, v] of Object.entries(SPEC[plan])) {
        expect(row[k], `${plan}.${k}`).toEqual(v);
      }
    });
  }

  it('free has 32 keys, pro 30 (no signal windows on pro)', () => {
    expect(Object.keys(pf.PLAN_FEATURES.free)).toHaveLength(32);
    expect(Object.keys(pf.PLAN_FEATURES.pro)).toHaveLength(30);
    expect(pf.PLAN_FEATURES.pro.signal_window_morning_utc).toBeUndefined();
    expect(pf.PLAN_FEATURES.pro.signal_window_evening_utc).toBeUndefined();
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(pf.PLAN_FEATURES)).toBe(true);
    expect(Object.isFrozen(pf.PLAN_FEATURES.free)).toBe(true);
    expect(Object.isFrozen(pf.PLAN_FEATURES.free.strategies)).toBe(true);
    expect(() => { pf.PLAN_FEATURES.free.strategies.push('SMC'); }).toThrow();
  });

  it('signalWindows falls back to (6,13)/(13,21) for pro', () => {
    expect(pf.signalWindows('free')).toEqual({ morning: [6, 13], evening: [13, 21] });
    expect(pf.signalWindows('pro')).toEqual({ morning: [6, 13], evening: [13, 21] });
  });
});

describe('normalizePlan', () => {
  it('pro | elite | beginner → pro (case/whitespace insensitive)', () => {
    for (const p of ['pro', 'PRO', ' Pro ', 'elite', 'ELITE', 'beginner', 'Beginner']) {
      expect(pf.normalizePlan(p)).toBe('pro');
    }
  });
  it('anything else → free', () => {
    for (const p of ['free', 'FREE', '', null, undefined, 'starter', 'enterprise', 'trial', 0, false, 'nonsense']) {
      expect(pf.normalizePlan(p)).toBe('free');
    }
  });
  it('planLabel', () => {
    expect(pf.planLabel('pro')).toBe('⭐ Pro');
    expect(pf.planLabel('elite')).toBe('⭐ Pro');
    expect(pf.planLabel('starter')).toBe('🆓 Free');
    expect(pf.planLabel(null)).toBe('🆓 Free');
  });
});

describe('can(plan, feature)', () => {
  it('bool values return themselves', () => {
    expect(pf.can('free', 'auto_trade')).toBe(false);
    expect(pf.can('pro', 'auto_trade')).toBe(true);
    expect(pf.can('free', 'long_only')).toBe(false);
    expect(pf.can('pro', 'long_only')).toBe(false);
    expect(pf.can('pro', 'challenge')).toBe(true);
    expect(pf.can('free', 'challenge')).toBe(false);
    expect(pf.can('free', 'expert_mode')).toBe(false);
    expect(pf.can('pro', 'expert_mode')).toBe(true);
  });
  it('numbers → > 0 (max_trades 0 is falsy on both plans)', () => {
    expect(pf.can('free', 'signals_per_day')).toBe(true);
    expect(pf.can('free', 'max_trades')).toBe(false);
    expect(pf.can('pro', 'max_trades')).toBe(false);
    expect(pf.can('pro', 'analyze_per_day')).toBe(true);
  });
  it('sets → non-empty; strings → Boolean', () => {
    expect(pf.can('free', 'strategies')).toBe(true);
    expect(pf.can('free', 'timeframes')).toBe(true);
    expect(pf.can('free', 'notifications')).toBe(true);
    expect(pf.can('free', 'signal_window_morning_utc')).toBe(true);
  });
  it('unknown feature → false; unknown plan → free', () => {
    expect(pf.can('pro', 'nope')).toBe(false);
    expect(pf.can('elite', 'smc')).toBe(true);
    expect(pf.can('starter', 'smc')).toBe(false);
    expect(pf.can(undefined, 'volume')).toBe(false);
  });
  it('admin bypass → always true', () => {
    expect(pf.can('free', 'auto_trade', { admin: true })).toBe(true);
    expect(pf.can('free', 'nope', { admin: true })).toBe(true);
  });
  it('the enforced consumers: volume/smc/auto_trade/genome/challenge/expert_mode/ai_*', () => {
    for (const f of ['volume', 'smc', 'auto_trade', 'genome', 'challenge', 'expert_mode',
      'ai_plus_tools', 'ai_layer_market_regime', 'all_timeframes', 'both_directions']) {
      expect(pf.can('free', f), f).toBe(false);
      expect(pf.can('pro', f), f).toBe(true);
    }
  });
});

describe('planLimit(plan, feature)', () => {
  it('analyze_per_day: free 1, pro 999, legacy ids normalised', () => {
    expect(pf.planLimit('free', 'analyze_per_day')).toBe(1);
    expect(pf.planLimit('pro', 'analyze_per_day')).toBe(999);
    expect(pf.planLimit('elite', 'analyze_per_day')).toBe(999);
    expect(pf.planLimit('starter', 'analyze_per_day')).toBe(1);
    expect(pf.planLimit('', 'analyze_per_day')).toBe(1);
  });
  it('other numeric keys', () => {
    expect(pf.planLimit('free', 'signals_per_day')).toBe(2);
    expect(pf.planLimit('pro', 'signals_per_day')).toBe(999);
    expect(pf.planLimit('free', 'symbols_limit')).toBe(5);
    expect(pf.planLimit('free', 'min_signal_quality')).toBe(5);
    expect(pf.planLimit('pro', 'min_signal_quality')).toBe(3);
    expect(pf.planLimit('pro', 'max_trades')).toBe(0);
  });
  it('unknown feature → 0; non-numeric values returned as is', () => {
    expect(pf.planLimit('pro', 'nope')).toBe(0);
    expect(pf.planLimit('free', 'notifications')).toBe('basic');
    expect(pf.planLimit('free', 'timeframes')).toEqual(['15m', '1h']);
  });
  it('admin → max(pro value, 999999) for numbers (bool counts as int — Python quirk), else pro value', () => {
    expect(pf.planLimit('free', 'analyze_per_day', { admin: true })).toBe(999999);
    expect(pf.planLimit('free', 'max_trades', { admin: true })).toBe(999999);
    expect(pf.planLimit('free', 'auto_trade', { admin: true })).toBe(999999);
    expect(pf.planLimit('free', 'notifications', { admin: true })).toBe('premium');
    expect(pf.planLimit('free', 'timeframes', { admin: true })).toEqual(['15m', '30m', '1h', '4h', '1d']);
    expect(pf.planLimit('free', 'nope', { admin: true })).toBe(999999);
  });
});

describe('isMutualExclusionRequired ([FREE-MUTEX])', () => {
  it('free → true; pro → false; admin → false; empty → free → true', () => {
    expect(pf.isMutualExclusionRequired('free')).toBe(true);
    expect(pf.isMutualExclusionRequired('')).toBe(true);
    expect(pf.isMutualExclusionRequired(null)).toBe(true);
    expect(pf.isMutualExclusionRequired('pro')).toBe(false);
    expect(pf.isMutualExclusionRequired('free', { admin: true })).toBe(false);
  });
});

describe('parseStrategies', () => {
  it('CSV → upper-cased, de-duplicated, ordered LEVELS, SMC, VOLUME; unknown dropped', () => {
    expect(pf.parseStrategies('smc,volume')).toEqual(['SMC', 'VOLUME']);
    expect(pf.parseStrategies('VOLUME, levels ,SMC,smc')).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(pf.parseStrategies('GERCHIK,scalping, ,')).toEqual([]);
    expect(pf.parseStrategies('')).toEqual([]);
    expect(pf.parseStrategies(null)).toEqual([]);
    expect(pf.parseStrategies(undefined)).toEqual([]);
  });
  it('SCANNER_OWNERSHIP / isOwnedBy', () => {
    expect(pf.SCANNER_OWNERSHIP).toEqual({ LEVELS: 'scanner_mid', SMC: 'smc_scanner', VOLUME: 'volume_scanner' });
    expect(pf.isOwnedBy('SMC', 'smc_scanner')).toBe(true);
    expect(pf.isOwnedBy('SMC', 'scanner_mid')).toBe(false);
    expect(pf.isOwnedBy('GERCHIK', 'scanner_mid')).toBe(false);
  });
});

describe('enabledStrategies / strategyEnabled', () => {
  it('empty extras → exactly the primary; default primary LEVELS', () => {
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: '', sub_plan: 'free' })).toEqual(['LEVELS']);
    expect(pf.enabledStrategies({ strategy: '', extra_strategies: '', sub_plan: 'free' })).toEqual(['LEVELS']);
    expect(pf.enabledStrategies({})).toEqual(['LEVELS']);
    expect(pf.enabledStrategies({ strategy: 'smc', sub_plan: 'pro' })).toEqual(['SMC']);
  });
  it('QUIRK: the primary is not plan-filtered (free user with primary SMC is enabled for SMC)', () => {
    expect(pf.enabledStrategies({ strategy: 'SMC', extra_strategies: '', sub_plan: 'free' })).toEqual(['SMC']);
    expect(pf.strategyEnabled({ strategy: 'VOLUME', sub_plan: 'free' }, 'VOLUME')).toBe(true);
  });
  it('unknown primary → empty set (plus allowed extras)', () => {
    expect(pf.enabledStrategies({ strategy: 'GERCHIK', extra_strategies: '', sub_plan: 'pro' })).toEqual([]);
    expect(pf.enabledStrategies({ strategy: 'GERCHIK', extra_strategies: 'SMC', sub_plan: 'pro' })).toEqual(['SMC']);
  });
  it('extras are filtered by the plan strategies', () => {
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', sub_plan: 'free' })).toEqual(['LEVELS']);
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', sub_plan: 'pro' })).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', sub_plan: 'elite' })).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', sub_plan: 'starter' })).toEqual(['LEVELS']);
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'volume', sub_plan: 'pro' })).toEqual(['LEVELS', 'VOLUME']);
  });
  it('admin → all extras allowed regardless of plan', () => {
    expect(pf.enabledStrategies({ strategy: 'LEVELS', extra_strategies: 'SMC,VOLUME', sub_plan: 'free' }, { admin: true }))
      .toEqual(['LEVELS', 'SMC', 'VOLUME']);
  });
  it('result is ordered LEVELS, SMC, VOLUME whatever the input order', () => {
    expect(pf.enabledStrategies({ strategy: 'VOLUME', extra_strategies: 'LEVELS,SMC', sub_plan: 'pro' })).toEqual(['LEVELS', 'SMC', 'VOLUME']);
  });
  it('strategyEnabled / isMulti', () => {
    const u = { strategy: 'LEVELS', extra_strategies: 'SMC', sub_plan: 'pro' };
    expect(pf.strategyEnabled(u, 'SMC')).toBe(true);
    expect(pf.strategyEnabled(u, 'smc')).toBe(true);
    expect(pf.strategyEnabled(u, 'VOLUME')).toBe(false);
    expect(pf.isMulti(u)).toBe(true);
    expect(pf.isMulti({ strategy: 'LEVELS', extra_strategies: 'SMC', sub_plan: 'free' })).toBe(false);
  });
});

describe('timeframeAllowed', () => {
  it('free: 15m + 1h only; pro: all five; admin: anything', () => {
    expect(pf.timeframeAllowed('free', '15m')).toBe(true);
    expect(pf.timeframeAllowed('free', '1h')).toBe(true);
    expect(pf.timeframeAllowed('free', '4h')).toBe(false);
    expect(pf.timeframeAllowed('free', '30m')).toBe(false);
    for (const tf of ['15m', '30m', '1h', '4h', '1d']) expect(pf.timeframeAllowed('pro', tf), tf).toBe(true);
    expect(pf.timeframeAllowed('pro', '5m')).toBe(false);
    expect(pf.timeframeAllowed('free', '1d', { admin: true })).toBe(true);
  });
});
