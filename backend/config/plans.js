/**
 * Subscription plans — the site's catalogue, derived from the bot's plan
 * matrix (config/planFeatures.js). Two tiers, exactly like the Telegram bot:
 *
 *   free — the bot's Free plan (LEVELS only, 2 signals/day, one direction)
 *   pro  — $69 / 30 days, everything (the former Elite); yearly = 12 × 0.8
 *
 * Starter / Elite / beginner are retired ids. They are still *accepted*
 * everywhere through normalizePlan (pro|elite|beginner → pro, anything
 * else → free, same as the bot's normalize_plan) so old rows, promo codes
 * and links keep working; migration v12 rewrites the stored rows (D1).
 *
 * Usage:
 *   const plans = require('./config/plans');
 *   const limits = plans.getLimits(user.subscription.plan);
 *   if (!plans.canUseFeature(plan, 'autoTrade')) return res.status(403)...
 *
 * canUseFeature accepts both the site's camelCase flags (autoTrade,
 * multiExchange, …) and the bot's snake_case keys (auto_trade, smc,
 * genome, challenge, …) — the latter go straight to planFeatures.can().
 */

const pf = require('./planFeatures');

const YEARLY_MULTIPLIER = 12 * 0.8;   // 20 % yearly discount (paymentService)
const round2 = (x) => Math.round(x * 100) / 100;

function build(id, name) {
  const f = pf.PLAN_FEATURES[id];
  return Object.freeze({
    id,
    name,
    priceUsd: pf.PLAN_PRICES_USD[id],
    periodDays: pf.PLAN_PERIOD_DAYS,
    yearlyPriceUsd: round2(pf.PLAN_PRICES_USD[id] * YEARLY_MULTIPLIER),
    // The bot matrix, verbatim (snake_case). Everything below is derived.
    features: f,
    // Engine vocabulary (lowercase for the site's enums; see validation.js)
    strategies: Object.freeze(f.strategies.map((s) => s.toLowerCase())),
    timeframes: f.timeframes,
    // Numeric limits
    signalsPerDay: f.signals_per_day,
    analyzePerDay: f.analyze_per_day,
    symbolsLimit: f.symbols_limit,
    minSignalQuality: f.min_signal_quality,
    maxTrades: f.max_trades,
    // Boolean gates used by the site
    bothDirections: f.both_directions,
    autoTrade: f.auto_trade,
    smc: f.smc,
    volume: f.volume,
    genome: f.genome,
    challenge: f.challenge,
    optimizer: f.optimizer,
    apiAccess: f.api_access,
    multiExchange: f.multi_exchange,
    expertMode: f.expert_mode,
    prioritySupport: f.priority_support,
    allTimeframes: f.all_timeframes,
    notifications: f.notifications,
    // Site-only presentation: the web "DEMO" is the signal feed without
    // auto-trade (PLAN §2.1) — there is no paper book any more.
    paperTradingOnly: !f.auto_trade,
    supportChannel: f.priority_support ? 'priority' : 'community',
  });
}

const PLANS = Object.freeze({
  free: build('free', 'Free'),
  pro: build('pro', 'Pro'),
});

const PLAN_ORDER = Object.freeze(['free', 'pro']);

// Retired ids that normalizePlan still understands (bot: elite/beginner →
// pro; the site's own "starter" has no bot equivalent → free at read time,
// grandfathered to pro until expires_at by migration v12, decision D1).
const LEGACY_PLAN_IDS = Object.freeze(['starter', 'elite', 'beginner']);
const LEGACY_PLANS = Object.freeze({ starter: 'free', elite: 'pro', beginner: 'pro' });

const normalizePlan = pf.normalizePlan;

function getLimits(planId) {
  return PLANS[normalizePlan(planId)];
}

/** Known id (live or legacy) → plan object; anything else → null. */
function getPlan(planId) {
  const id = String(planId || '').trim().toLowerCase();
  if (PLANS[id]) return PLANS[id];
  if (LEGACY_PLAN_IDS.includes(id)) return PLANS[normalizePlan(id)];
  return null;
}

function listPlans() {
  return PLAN_ORDER.map((id) => ({ ...PLANS[id] }));
}

// camelCase site flag → bot feature key
const FLAG_TO_FEATURE = Object.freeze({
  autoTrade: 'auto_trade',
  bothDirections: 'both_directions',
  multiExchange: 'multi_exchange',
  apiAccess: 'api_access',
  prioritySupport: 'priority_support',
  allTimeframes: 'all_timeframes',
  expertMode: 'expert_mode',
  moreSymbols: 'more_symbols',
  unlimitedTrades: 'unlimited_trades',
  aiExplanations: 'ai_explanations',
  targetWr: 'target_wr',
});

/**
 * Does the plan include the feature? Accepts camelCase site flags and the
 * bot's snake_case keys. Unknown plan ids normalise like the bot (→ free).
 */
function canUseFeature(planId, feature) {
  const plan = getLimits(planId);
  if (feature === 'paperTradingOnly') return plan.paperTradingOnly;
  const key = FLAG_TO_FEATURE[feature] || feature;
  return pf.can(plan.id, key);
}

/** Is the strategy (any case: 'smc' / 'SMC') allowed on the plan? */
function canUseStrategy(planId, strategy) {
  return getLimits(planId).strategies.includes(String(strategy || '').toLowerCase());
}

function canUseTimeframe(planId, tf) {
  return pf.timeframeAllowed(getLimits(planId).id, tf);
}

/** Minimum plan that grants `feature`, e.g. requiredPlanFor('autoTrade') → 'pro'. */
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

/** Compare plans: -1 if a < b, 0 if equal, 1 if a > b (legacy ids normalised). */
function comparePlan(a, b) {
  const ai = PLAN_ORDER.indexOf(normalizePlan(a));
  const bi = PLAN_ORDER.indexOf(normalizePlan(b));
  return Math.sign(ai - bi);
}

function isAtLeast(userPlan, requiredPlan) {
  return comparePlan(userPlan, requiredPlan) >= 0;
}

module.exports = {
  PLANS,
  PLAN_ORDER,
  LEGACY_PLAN_IDS,
  LEGACY_PLANS,
  YEARLY_MULTIPLIER,
  normalizePlan,
  getLimits,
  getPlan,
  listPlans,
  canUseFeature,
  canUseStrategy,
  canUseTimeframe,
  requiredPlanFor,
  requiredPlanForStrategy,
  comparePlan,
  isAtLeast,
};
