import { describe, it, expect } from 'vitest';
import plans from '../config/plans.js';

// Two tiers, same as the Telegram bot: free + pro ($69). Starter / Elite are
// legacy ids that normalise onto them.

describe('plans.getLimits / normalizePlan', () => {
  it('returns the two live plans', () => {
    expect(plans.getLimits('free').priceUsd).toBe(0);
    expect(plans.getLimits('pro').priceUsd).toBe(69);
    expect(plans.PLAN_ORDER).toEqual(['free', 'pro']);
  });
  it('maps legacy ids: starter → free, elite → pro', () => {
    expect(plans.normalizePlan('starter')).toBe('free');
    expect(plans.normalizePlan('elite')).toBe('pro');
    expect(plans.normalizePlan('ELITE')).toBe('pro');
    expect(plans.getLimits('elite').id).toBe('pro');
    expect(plans.getPlan('starter').id).toBe('free');
  });
  it('falls back to free for unknown plan', () => {
    expect(plans.getLimits('nonsense').id).toBe('free');
    expect(plans.getPlan('nonsense')).toBe(null);
  });
});

describe('plans.canUseFeature', () => {
  it('pro has everything the old Elite had', () => {
    for (const f of ['autoTrade', 'optimizer', 'apiAccess', 'multiExchange', 'marketScanner', 'multiStrategy', 'expertMode']) {
      expect(plans.canUseFeature('pro', f)).toBe(true);
      expect(plans.canUseFeature('elite', f)).toBe(true);
    }
  });
  it('free is a preview tier', () => {
    expect(plans.canUseFeature('free', 'autoTrade')).toBe(false);
    expect(plans.canUseFeature('free', 'paperTradingOnly')).toBe(true);
    expect(plans.canUseFeature('pro', 'paperTradingOnly')).toBe(false);
    expect(plans.canUseFeature('starter', 'autoTrade')).toBe(false);
  });
});

describe('plans.canUseStrategy', () => {
  it('free only allows levels', () => {
    expect(plans.canUseStrategy('free', 'levels')).toBe(true);
    expect(plans.canUseStrategy('free', 'smc')).toBe(false);
    expect(plans.canUseStrategy('free', 'volume')).toBe(false);
  });
  it('pro allows the bot strategies (levels, smc, volume) and the utility ones', () => {
    for (const s of ['levels', 'smc', 'volume', 'dca', 'grid']) expect(plans.canUseStrategy('pro', s)).toBe(true);
    expect(plans.canUseStrategy('elite', 'SMC')).toBe(true);
    expect(plans.canUseStrategy('pro', 'gerchik')).toBe(false);
  });
});

describe('plans.requiredPlanFor', () => {
  it('finds minimum plan for feature / strategy', () => {
    expect(plans.requiredPlanFor('autoTrade')).toBe('pro');
    expect(plans.requiredPlanFor('optimizer')).toBe('pro');
    expect(plans.requiredPlanFor('paperTradingOnly')).toBe('free');
    expect(plans.requiredPlanForStrategy('levels')).toBe('free');
    expect(plans.requiredPlanForStrategy('smc')).toBe('pro');
    expect(plans.requiredPlanForStrategy('gerchik')).toBe(null);
  });
});

describe('plans.comparePlan / isAtLeast', () => {
  it('ordering works, legacy ids included', () => {
    expect(plans.comparePlan('free', 'pro')).toBe(-1);
    expect(plans.comparePlan('pro', 'free')).toBe(1);
    expect(plans.comparePlan('pro', 'pro')).toBe(0);
    expect(plans.comparePlan('elite', 'pro')).toBe(0);
    expect(plans.isAtLeast('elite', 'pro')).toBe(true);
    expect(plans.isAtLeast('starter', 'pro')).toBe(false);
    expect(plans.isAtLeast('starter', 'free')).toBe(true);
  });
});

describe('plans.listPlans', () => {
  it('lists free + pro in order, Infinity → null', () => {
    const list = plans.listPlans();
    expect(list.map((p) => p.id)).toEqual(['free', 'pro']);
    const pro = list.find((p) => p.id === 'pro');
    expect(pro.signalsPerDay).toBe(null);
    expect(pro.maxBots).toBe(null);
    expect(pro.backtestsPerDay).toBe(null);
  });
});
