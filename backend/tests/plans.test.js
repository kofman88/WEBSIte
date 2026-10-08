import { describe, it, expect } from 'vitest';
import plans from '../config/plans.js';
import pf from '../config/planFeatures.js';

// Two tiers, same as the Telegram bot: free + pro ($69 / 30 d). The catalogue
// is derived from config/planFeatures.js; starter / elite / beginner are
// legacy ids that normalise onto the two live ones.

describe('plans catalogue', () => {
  it('returns the two live plans with the bot prices', () => {
    expect(plans.PLAN_ORDER).toEqual(['free', 'pro']);
    expect(Object.keys(plans.PLANS)).toEqual(['free', 'pro']);
    expect(plans.getLimits('free').priceUsd).toBe(0);
    expect(plans.getLimits('pro').priceUsd).toBe(69);
    expect(plans.getLimits('pro').periodDays).toBe(30);
    expect(plans.getLimits('pro').yearlyPriceUsd).toBeCloseTo(69 * 12 * 0.8);
    expect(plans.YEARLY_MULTIPLIER).toBeCloseTo(9.6);
  });
  it('embeds the bot matrix verbatim and derives the camelCase flags from it', () => {
    for (const id of ['free', 'pro']) {
      const p = plans.PLANS[id];
      // (toEqual, not toBe: vitest's ESM import and the CJS require inside
      // plans.js are two module instances of planFeatures)
      expect(p.features).toEqual(pf.PLAN_FEATURES[id]);
      expect(Object.isFrozen(p.features)).toBe(true);
      expect(p.strategies).toEqual(pf.PLAN_FEATURES[id].strategies.map((s) => s.toLowerCase()));
      expect(p.timeframes).toEqual(pf.PLAN_FEATURES[id].timeframes);
      expect(p.signalsPerDay).toBe(pf.PLAN_FEATURES[id].signals_per_day);
      expect(p.analyzePerDay).toBe(pf.PLAN_FEATURES[id].analyze_per_day);
      expect(p.autoTrade).toBe(pf.PLAN_FEATURES[id].auto_trade);
      expect(p.multiExchange).toBe(pf.PLAN_FEATURES[id].multi_exchange);
      expect(p.genome).toBe(pf.PLAN_FEATURES[id].genome);
      expect(p.challenge).toBe(pf.PLAN_FEATURES[id].challenge);
      expect(p.expertMode).toBe(pf.PLAN_FEATURES[id].expert_mode);
    }
    expect(plans.PLANS.free.strategies).toEqual(['levels']);
    expect(plans.PLANS.pro.strategies).toEqual(['levels', 'smc', 'volume']);
    expect(plans.PLANS.free.signalsPerDay).toBe(2);
    expect(plans.PLANS.pro.signalsPerDay).toBe(999);
    expect(plans.PLANS.free.paperTradingOnly).toBe(true);
    expect(plans.PLANS.pro.paperTradingOnly).toBe(false);
  });
});

describe('plans.normalizePlan / getPlan / getLimits', () => {
  it('normalizePlan is the bot rule: pro|elite|beginner → pro, else free', () => {
    for (const id of ['pro', 'elite', 'beginner', 'starter', 'free', '', null, 'x']) {
      expect(plans.normalizePlan(id)).toBe(pf.normalizePlan(id));
    }
    expect(plans.normalizePlan('elite')).toBe('pro');
    expect(plans.normalizePlan('beginner')).toBe('pro');
    expect(plans.normalizePlan('starter')).toBe('free');
    expect(plans.normalizePlan('ELITE')).toBe('pro');
    expect(plans.normalizePlan(null)).toBe('free');
  });
  it('legacy ids resolve: elite/beginner → pro, starter → free', () => {
    expect(plans.getLimits('elite').id).toBe('pro');
    expect(plans.getLimits('beginner').id).toBe('pro');
    expect(plans.getLimits('starter').id).toBe('free');
    expect(plans.getPlan('elite').id).toBe('pro');
    expect(plans.getPlan('starter').id).toBe('free');
    expect(plans.LEGACY_PLAN_IDS).toEqual(['starter', 'elite', 'beginner']);
  });
  it('unknown plan: getLimits falls back to free, getPlan → null', () => {
    expect(plans.getLimits('nonsense').id).toBe('free');
    expect(plans.getLimits(undefined).id).toBe('free');
    expect(plans.getPlan('nonsense')).toBe(null);
    expect(plans.getPlan('enterprise')).toBe(null);
  });
});

describe('plans.canUseFeature', () => {
  it('pro has everything (the former Elite)', () => {
    for (const f of ['autoTrade', 'optimizer', 'apiAccess', 'multiExchange', 'expertMode', 'prioritySupport',
      'genome', 'challenge', 'smc', 'volume', 'bothDirections', 'allTimeframes', 'auto_trade', 'ai_plus_tools']) {
      expect(plans.canUseFeature('pro', f), f).toBe(true);
      expect(plans.canUseFeature('elite', f), f).toBe(true);
    }
  });
  it('free is the bot Free plan', () => {
    for (const f of ['autoTrade', 'optimizer', 'apiAccess', 'multiExchange', 'expertMode', 'genome', 'challenge', 'smc', 'volume', 'bothDirections']) {
      expect(plans.canUseFeature('free', f), f).toBe(false);
      expect(plans.canUseFeature('starter', f), f).toBe(false);
    }
    expect(plans.canUseFeature('free', 'paperTradingOnly')).toBe(true);
    expect(plans.canUseFeature('pro', 'paperTradingOnly')).toBe(false);
    expect(plans.canUseFeature('free', 'signals_per_day')).toBe(true);
  });
  it('unknown feature → false', () => {
    expect(plans.canUseFeature('pro', 'marketplacePublish')).toBe(false);
    expect(plans.canUseFeature('pro', 'nope')).toBe(false);
  });
});

describe('plans.canUseStrategy / canUseTimeframe', () => {
  it('free only allows levels', () => {
    expect(plans.canUseStrategy('free', 'levels')).toBe(true);
    expect(plans.canUseStrategy('free', 'LEVELS')).toBe(true);
    expect(plans.canUseStrategy('free', 'smc')).toBe(false);
    expect(plans.canUseStrategy('free', 'volume')).toBe(false);
  });
  it('pro allows the three bot strategies and nothing else', () => {
    for (const s of ['levels', 'smc', 'volume', 'SMC']) expect(plans.canUseStrategy('pro', s)).toBe(true);
    expect(plans.canUseStrategy('elite', 'SMC')).toBe(true);
    for (const s of ['gerchik', 'scalping', 'dca', 'grid']) {
      expect(plans.canUseStrategy('pro', s)).toBe(false);
      expect(plans.canUseStrategy('free', s)).toBe(false);
    }
  });
  it('timeframes follow the matrix', () => {
    expect(plans.canUseTimeframe('free', '1h')).toBe(true);
    expect(plans.canUseTimeframe('free', '4h')).toBe(false);
    expect(plans.canUseTimeframe('pro', '4h')).toBe(true);
    expect(plans.canUseTimeframe('pro', '5m')).toBe(false);
  });
});

describe('plans.requiredPlanFor', () => {
  it('finds minimum plan for feature / strategy', () => {
    expect(plans.requiredPlanFor('autoTrade')).toBe('pro');
    expect(plans.requiredPlanFor('optimizer')).toBe('pro');
    expect(plans.requiredPlanFor('multiExchange')).toBe('pro');
    expect(plans.requiredPlanFor('expertMode')).toBe('pro');
    expect(plans.requiredPlanFor('genome')).toBe('pro');
    expect(plans.requiredPlanFor('paperTradingOnly')).toBe('free');
    expect(plans.requiredPlanFor('signals_per_day')).toBe('free');
    expect(plans.requiredPlanFor('nope')).toBe(null);
    expect(plans.requiredPlanForStrategy('levels')).toBe('free');
    expect(plans.requiredPlanForStrategy('smc')).toBe('pro');
    expect(plans.requiredPlanForStrategy('volume')).toBe('pro');
    expect(plans.requiredPlanForStrategy('gerchik')).toBe(null);
  });
});

describe('plans.comparePlan / isAtLeast', () => {
  it('ordering works, legacy ids included', () => {
    expect(plans.comparePlan('free', 'pro')).toBe(-1);
    expect(plans.comparePlan('pro', 'free')).toBe(1);
    expect(plans.comparePlan('pro', 'pro')).toBe(0);
    expect(plans.comparePlan('elite', 'pro')).toBe(0);
    expect(plans.comparePlan('nonsense', 'free')).toBe(0);
    expect(plans.isAtLeast('elite', 'pro')).toBe(true);
    expect(plans.isAtLeast('pro', 'pro')).toBe(true);
    expect(plans.isAtLeast('starter', 'pro')).toBe(false);
    expect(plans.isAtLeast('starter', 'free')).toBe(true);
    expect(plans.isAtLeast(undefined, 'free')).toBe(true);
  });
});

describe('plans.listPlans', () => {
  it('lists free + pro in order with the price and the matrix', () => {
    const list = plans.listPlans();
    expect(list.map((p) => p.id)).toEqual(['free', 'pro']);
    const pro = list.find((p) => p.id === 'pro');
    expect(pro.priceUsd).toBe(69);
    expect(pro.features.strategies).toEqual(['LEVELS', 'SMC', 'VOLUME']);
    expect(list.every((p) => typeof p.signalsPerDay === 'number')).toBe(true);
  });
});
