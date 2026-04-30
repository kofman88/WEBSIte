import { describe, it, expect } from 'vitest';
import plans from '../config/plans.js';

describe('plans.getLimits', () => {
  it('returns all 4 plans correctly', () => {
    expect(plans.getLimits('free').priceUsd).toBe(0);
    expect(plans.getLimits('starter').priceUsd).toBe(29);
    expect(plans.getLimits('pro').priceUsd).toBe(69);
    expect(plans.getLimits('elite').priceUsd).toBe(149);
  });
  it('falls back to free for unknown plan', () => {
    expect(plans.getLimits('nonsense').id).toBe('free');
  });
});

describe('plans.canUseFeature', () => {
  it('auto-trade requires pro or above', () => {
    expect(plans.canUseFeature('free', 'autoTrade')).toBe(false);
    expect(plans.canUseFeature('starter', 'autoTrade')).toBe(false);
    expect(plans.canUseFeature('pro', 'autoTrade')).toBe(true);
    expect(plans.canUseFeature('elite', 'autoTrade')).toBe(true);
  });
  it('optimizer is elite only', () => {
    expect(plans.canUseFeature('pro', 'optimizer')).toBe(false);
    expect(plans.canUseFeature('elite', 'optimizer')).toBe(true);
  });
  it('apiAccess is elite only', () => {
    expect(plans.canUseFeature('pro', 'apiAccess')).toBe(false);
    expect(plans.canUseFeature('elite', 'apiAccess')).toBe(true);
  });
  it('paperTradingOnly is true for free and starter', () => {
    expect(plans.canUseFeature('free', 'paperTradingOnly')).toBe(true);
    expect(plans.canUseFeature('starter', 'paperTradingOnly')).toBe(true);
    expect(plans.canUseFeature('pro', 'paperTradingOnly')).toBe(false);
    expect(plans.canUseFeature('elite', 'paperTradingOnly')).toBe(false);
  });
});

describe('plans.canUseStrategy', () => {
  it('free only allows levels', () => {
    expect(plans.canUseStrategy('free', 'levels')).toBe(true);
    expect(plans.canUseStrategy('free', 'smc')).toBe(false);
    expect(plans.canUseStrategy('free', 'gerchik')).toBe(false);
    expect(plans.canUseStrategy('free', 'scalping')).toBe(false);
  });
  it('starter only allows levels (SMC moved to Pro per inventory)', () => {
    expect(plans.canUseStrategy('starter', 'levels')).toBe(true);
    expect(plans.canUseStrategy('starter', 'smc')).toBe(false);
    expect(plans.canUseStrategy('starter', 'gerchik')).toBe(false);
  });
  it('pro adds smc + dca + grid (gerchik+scalping are Elite-only)', () => {
    expect(plans.canUseStrategy('pro', 'smc')).toBe(true);
    expect(plans.canUseStrategy('pro', 'dca')).toBe(true);
    expect(plans.canUseStrategy('pro', 'grid')).toBe(true);
    expect(plans.canUseStrategy('pro', 'gerchik')).toBe(false);
    expect(plans.canUseStrategy('pro', 'scalping')).toBe(false);
  });
  it('elite has all', () => {
    expect(plans.canUseStrategy('elite', 'gerchik')).toBe(true);
    expect(plans.canUseStrategy('elite', 'scalping')).toBe(true);
    expect(plans.canUseStrategy('elite', 'levels')).toBe(true);
  });
});

describe('plans.requiredPlanFor', () => {
  it('finds minimum plan for feature', () => {
    expect(plans.requiredPlanFor('autoTrade')).toBe('pro');
    expect(plans.requiredPlanFor('optimizer')).toBe('elite');
    expect(plans.requiredPlanFor('apiAccess')).toBe('elite');
    expect(plans.requiredPlanFor('marketScanner')).toBe('elite');
    expect(plans.requiredPlanFor('multiExchange')).toBe('pro');
    expect(plans.requiredPlanFor('expertMode')).toBe('starter');
  });
  it('finds minimum plan for strategy', () => {
    expect(plans.requiredPlanForStrategy('levels')).toBe('free');
    expect(plans.requiredPlanForStrategy('smc')).toBe('pro');
    expect(plans.requiredPlanForStrategy('gerchik')).toBe('elite');
    expect(plans.requiredPlanForStrategy('scalping')).toBe('elite');
  });
});

describe('plans.comparePlan / isAtLeast', () => {
  it('ordering works', () => {
    expect(plans.comparePlan('free', 'pro')).toBe(-1);
    expect(plans.comparePlan('pro', 'free')).toBe(1);
    expect(plans.comparePlan('pro', 'pro')).toBe(0);
  });
  it('isAtLeast gates correctly', () => {
    expect(plans.isAtLeast('elite', 'pro')).toBe(true);
    expect(plans.isAtLeast('pro', 'pro')).toBe(true);
    expect(plans.isAtLeast('starter', 'pro')).toBe(false);
  });
});

describe('plans.listPlans', () => {
  it('converts Infinity to null for JSON', () => {
    const list = plans.listPlans();
    const elite = list.find((p) => p.id === 'elite');
    expect(elite.signalsPerDay).toBe(null);
    expect(elite.maxBots).toBe(null);
    expect(elite.backtestsPerDay).toBe(null);
  });
  it('returns plans in canonical order', () => {
    const ids = plans.listPlans().map((p) => p.id);
    expect(ids).toEqual(['free', 'starter', 'pro', 'elite']);
  });
});
