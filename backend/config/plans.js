/**
 * Subscription plans — feature matrix for gating.
 *
 * Two tiers, the same as the Telegram bot: free and pro ($69). Starter and
 * Elite were retired when the site became a shell of the bot; their ids are
 * still accepted everywhere (normalizePlan) so old rows keep working.
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
    signalsPerDay: 2,              // 2 LEVELS + 1 SMC-превью в день — как в боте
    maxBots: 0,
    autoTrade: false,
    strategies: ['levels'],
    backtestsPerDay: 0,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 5,
    paperTradingOnly: true,
    multiExchange: false,
    marketScanner: false,
    multiStrategy: false,
    expertMode: false,
    marketplacePublish: false,
    prioritySupport: false,
    readOnly: true,
    supportChannel: 'community',
  },
  // Pro = everything (the former Elite). One paid tier, $69/mo, same as the bot.
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 69,
    signalsPerDay: Infinity,
    maxBots: Infinity,
    autoTrade: true,
    strategies: ['levels', 'smc', 'volume', 'dca', 'grid'],
    backtestsPerDay: Infinity,
    optimizer: true,
    apiAccess: true,
    maxLeverage: 100,
    paperTradingOnly: false,
    multiExchange: true,
    marketScanner: true,
    multiStrategy: true,
    expertMode: true,
    marketplacePublish: true,
    prioritySupport: true,
    readOnly: false,
    supportChannel: 'priority',
  },
});

// Legacy tiers still present in old subscriptions / promo rows map onto the
// two live ones: starter → free (was a paid "manual" tier, no longer sold),
// elite → pro (Pro now carries every Elite feature).
const LEGACY_PLANS = Object.freeze({ starter: 'free', elite: 'pro', beginner: 'pro' });

function normalizePlan(planId) {
  const id = String(planId || '').toLowerCase();
  if (PLANS[id]) return id;
  return LEGACY_PLANS[id] || 'free';
}

const PLAN_ORDER = ['free', 'pro'];

function getLimits(planId) {
  return PLANS[normalizePlan(planId)];
}

function getPlan(planId) {
  const id = String(planId || '').toLowerCase();
  if (PLANS[id]) return PLANS[id];
  return LEGACY_PLANS[id] ? PLANS[LEGACY_PLANS[id]] : null;
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
  const plan = getPlan(planId);
  if (!plan) return false;
  return Boolean(plan[feature]);
}

/**
 * Is the strategy allowed for the plan?
 */
function canUseStrategy(planId, strategy) {
  const plan = getPlan(planId);
  if (!plan) return false;
  return plan.strategies.includes(String(strategy || '').toLowerCase());
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
  const ai = PLAN_ORDER.indexOf(normalizePlan(a));
  const bi = PLAN_ORDER.indexOf(normalizePlan(b));
  if (ai < 0 || bi < 0) return 0;
  return Math.sign(ai - bi);
}

function isAtLeast(userPlan, requiredPlan) {
  return comparePlan(userPlan, requiredPlan) >= 0;
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  LEGACY_PLANS,
  normalizePlan,
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
