/**
 * Subscription plans — feature matrix for gating.
 *
 * Usage:
 *   const plans = require('./config/plans');
 *   const limits = plans.getLimits(user.subscription.plan);
 *   if (!plans.canUseFeature(plan, 'autoTrade')) return res.status(403)...
 */

const PLANS = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    signalsPerDay: 3,              // cherry-picked by quality DESC
    maxBots: 1,
    autoTrade: false,
    strategies: ['levels'],
    backtestsPerDay: 0,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 5,
    paperTradingOnly: true,
    supportChannel: 'community',
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUsd: 29,
    signalsPerDay: Infinity,
    maxBots: 2,
    autoTrade: false,
    strategies: ['levels', 'smc'],
    backtestsPerDay: 0,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 10,
    paperTradingOnly: true,
    supportChannel: 'email',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 79,
    signalsPerDay: Infinity,
    maxBots: 5,
    autoTrade: true,
    strategies: ['levels', 'smc', 'gerchik'],
    backtestsPerDay: 10,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 25,
    paperTradingOnly: false,
    supportChannel: 'priority-email',
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    priceUsd: 149,
    signalsPerDay: Infinity,
    maxBots: Infinity,
    autoTrade: true,
    strategies: ['levels', 'smc', 'gerchik', 'scalping'],
    backtestsPerDay: Infinity,
    optimizer: true,
    apiAccess: true,
    maxLeverage: 100,
    paperTradingOnly: false,
    supportChannel: 'dedicated-manager',
  },
});

const PLAN_ORDER = ['free', 'starter', 'pro', 'elite'];

function getLimits(planId) {
  const plan = PLANS[planId] || PLANS.free;
  return plan;
}

function getPlan(planId) {
  return PLANS[planId] || null;
}

function listPlans() {
  return PLAN_ORDER.map((id) => {
    const p = PLANS[id];
    return {
      ...p,
      // Convert Infinity to null for JSON serialization
      signalsPerDay: p.signalsPerDay === Infinity ? null : p.signalsPerDay,
      maxBots: p.maxBots === Infinity ? null : p.maxBots,
      backtestsPerDay: p.backtestsPerDay === Infinity ? null : p.backtestsPerDay,
    };
  });
}

/**
 * Does plan include the given boolean feature?
 * @param {string} planId
 * @param {string} feature  one of: autoTrade, optimizer, apiAccess, paperTradingOnly
 */
function canUseFeature(planId, feature) {
  const plan = PLANS[planId];
  if (!plan) return false;
  return Boolean(plan[feature]);
}

/**
 * Is the strategy allowed for the plan?
 */
function canUseStrategy(planId, strategy) {
  const plan = PLANS[planId];
  if (!plan) return false;
  return plan.strategies.includes(strategy);
}

/**
 * Returns the minimum plan that grants access to `feature`.
 * e.g. requiredPlanFor('autoTrade') → 'pro'
 */
function requiredPlanFor(feature) {
  for (const id of PLAN_ORDER) {
    if (canUseFeature(id, feature)) return id;
  }
  return null;
}

function requiredPlanForStrategy(strategy) {
  for (const id of PLAN_ORDER) {
    if (canUseStrategy(id, strategy)) return id;
  }
  return null;
}

/**
 * Compare plans: returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function comparePlan(a, b) {
  const ai = PLAN_ORDER.indexOf(a);
  const bi = PLAN_ORDER.indexOf(b);
  if (ai < 0 || bi < 0) return 0;
  return Math.sign(ai - bi);
}

function isAtLeast(userPlan, requiredPlan) {
  return comparePlan(userPlan, requiredPlan) >= 0;
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  getLimits,
  getPlan,
  listPlans,
  canUseFeature,
  canUseStrategy,
  requiredPlanFor,
  requiredPlanForStrategy,
  comparePlan,
  isAtLeast,
};
