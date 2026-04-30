/**
 * Subscription plans — feature matrix for gating.
 *
 * Tariff structure aligns with the published marketing inventory
 * (free / starter / pro / elite). Every code-enforced feature is a
 * boolean flag here; advisory / Telegram-bot-only features (smartTools,
 * aiPersonalLearner, polymarket, …) are advertised on the pricing page
 * but not gated in this codebase, so they are intentionally absent.
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
    signalsPerDay: 2,              // 1 утром + 1 вечером (per inventory)
    maxBots: 1,
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
    supportChannel: 'community',
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUsd: 29,
    signalsPerDay: Infinity,
    maxBots: 2,
    autoTrade: false,              // ручная торговля per inventory
    strategies: ['levels'],        // SMC moves up to Pro per inventory
    backtestsPerDay: 1,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 10,
    paperTradingOnly: true,
    multiExchange: false,
    marketScanner: false,
    multiStrategy: false,
    expertMode: true,
    marketplacePublish: true,
    prioritySupport: false,
    supportChannel: 'email',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 69,                  // was $79 — aligned with inventory
    signalsPerDay: Infinity,
    maxBots: 5,
    autoTrade: true,
    // SMC promoted up from Starter per inventory; DCA/Grid kept here as
    // utility strategies (not in the marketing inventory but functional
    // in the codebase, so we slot them at Pro alongside SMC).
    strategies: ['levels', 'smc', 'dca', 'grid'],
    backtestsPerDay: 10,
    optimizer: false,
    apiAccess: false,
    maxLeverage: 25,
    paperTradingOnly: false,
    multiExchange: true,           // Bybit + BingX + Binance + OKX per inventory
    marketScanner: false,
    multiStrategy: false,
    expertMode: true,
    marketplacePublish: true,
    prioritySupport: false,
    supportChannel: 'priority-email',
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    priceUsd: 149,
    signalsPerDay: Infinity,
    maxBots: Infinity,
    autoTrade: true,
    // All 4 marketing strategies (levels/smc/gerchik/scalping) plus the
    // utility ones (dca/grid). Gerchik is Elite-exclusive per inventory.
    strategies: ['levels', 'smc', 'gerchik', 'scalping', 'dca', 'grid'],
    backtestsPerDay: Infinity,
    optimizer: true,
    apiAccess: true,
    maxLeverage: 100,
    paperTradingOnly: false,
    multiExchange: true,
    marketScanner: true,           // scope='market' bot — already enforced
    multiStrategy: true,           // strategiesMulti with >1 entry
    expertMode: true,
    marketplacePublish: true,
    prioritySupport: true,
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
