/**
 * PLAN_FEATURES — the bot's plan matrix, copied verbatim from
 * CHM_BREAKER_V4/config.py (PLAN_PRICES_USD, VALID_PLANS, normalize_plan,
 * PLAN_FEATURES, SCANNER_OWNERSHIP, parse_strategies, enabled_strategies,
 * strategy_enabled) and user_manager.py (UserSettings.can / plan_limit /
 * is_mutual_exclusion_required / plan_label).
 *
 * Specs: port/specs/signal-pipeline.md §1, data-and-market.md §3–4.
 *
 * This is the single source of truth for plan gating on the site.
 * config/plans.js (the site's catalogue: prices, names, camelCase flags)
 * and frontend/plan-gate.js are derived from / mirror this table.
 *
 * Representation notes (Python → JS):
 *   • Python `set` values (strategies, timeframes) are frozen arrays.
 *   • Python tuples (signal windows) are frozen 2-element arrays.
 *   • Every key is kept in snake_case exactly as the bot names it so the
 *     same feature strings can be grepped in both code bases.
 *   • The admin bypass (bot: uid ∈ Config.ADMIN_IDS) is an explicit
 *     `{ admin: true }` option on the helpers — the site decides who is an
 *     admin (users.is_admin), the matrix does not.
 */

'use strict';

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

// ── Prices / valid plans (config.py) ─────────────────────────────────────
const PLAN_PRICES_USD = Object.freeze({ free: 0.0, pro: 69.0 });
const VALID_PLANS = Object.freeze(['free', 'pro']);
const PRICE_PRO = '69$';              // Config.PRICE_PRO — display string
const PLAN_PERIOD_DAYS = 30;          // _PLAN_DAYS["pro"] = 30

/**
 * normalize_plan(plan): lower-cased, stripped string;
 * "pro" | "elite" | "beginner" → "pro"; anything else (incl. "", null,
 * unknown ids such as the site's retired "starter") → "free".
 */
function normalizePlan(plan) {
  const p = String(plan == null || plan === false ? '' : plan).trim().toLowerCase();
  if (p === 'pro' || p === 'elite' || p === 'beginner') return 'pro';
  return 'free';
}

// ── PLAN_FEATURES — verbatim ─────────────────────────────────────────────
const PLAN_FEATURES = deepFreeze({
  // FREE — попробовать бота
  free: {
    strategies:                 ['LEVELS'],
    // [FREE-MUTEX] Free выбирает LONG ИЛИ SHORT — одно направление.
    both_directions:            false,
    long_only:                  false,
    auto_trade:                 false,
    max_trades:                 0,
    signals_per_day:            2,            // 1 утром + 1 вечером
    min_signal_quality:         5,
    // Окна в UTC. Вне окон (21:00-06:00) — 0 сигналов.
    signal_window_morning_utc:  [6, 13],
    signal_window_evening_utc:  [13, 21],
    analyze_per_day:            1,
    symbols_limit:              5,
    timeframes:                 ['15m', '1h'],
    smc:                        false,
    volume:                     false,        // стратегия «Торговля по объёму»
    notifications:              'basic',
    optimizer:                  false,
    target_wr:                  false,
    genome:                     false,
    ai_explanations:            false,
    multi_exchange:             false,
    api_access:                 false,
    priority_support:           false,
    all_timeframes:             false,
    more_symbols:               false,
    unlimited_trades:           false,
    expert_mode:                false,
    strategies_extended:        false,
    ai_layer_market_regime:     false,
    ai_layer_news_monitor:      false,
    ai_layer_genome_engine:     false,
    ai_plus_tools:              false,
    challenge:                  false,        // [CHALLENGE 2026-10]
  },

  // PRO — $69/мес, все функции (бывший Elite)
  pro: {
    strategies:                 ['LEVELS', 'SMC', 'VOLUME'],
    both_directions:            true,
    long_only:                  false,
    auto_trade:                 true,
    max_trades:                 0,            // unlimited
    signals_per_day:            999,
    min_signal_quality:         3,
    analyze_per_day:            999,
    symbols_limit:              999,
    timeframes:                 ['15m', '30m', '1h', '4h', '1d'],   // [NO-5M]
    smc:                        true,
    volume:                     true,
    notifications:              'premium',
    optimizer:                  true,
    target_wr:                  true,
    genome:                     true,
    ai_explanations:            true,
    multi_exchange:             true,
    api_access:                 true,
    priority_support:           true,
    all_timeframes:             true,
    more_symbols:               true,
    unlimited_trades:           true,
    expert_mode:                true,
    strategies_extended:        true,
    ai_layer_market_regime:     true,
    ai_layer_news_monitor:      true,
    ai_layer_genome_engine:     true,
    ai_plus_tools:              true,
    challenge:                  true,
  },
});

// Default windows used by code that does `.get(key, (6, 13))` — pro has no
// window keys, but only free users are ever checked against them.
const DEFAULT_SIGNAL_WINDOWS = deepFreeze({ morning: [6, 13], evening: [13, 21] });

function signalWindows(plan) {
  const row = PLAN_FEATURES[normalizePlan(plan)];
  return {
    morning: row.signal_window_morning_utc || DEFAULT_SIGNAL_WINDOWS.morning,
    evening: row.signal_window_evening_utc || DEFAULT_SIGNAL_WINDOWS.evening,
  };
}

const PLAN_LABEL = Object.freeze({ free: '🆓 Free', pro: '⭐ Pro' });

function planLabel(plan) {
  return PLAN_LABEL[normalizePlan(plan)];
}

/**
 * UserSettings.can(feature) — admin → true; bool → itself; number → > 0;
 * set → non-empty; anything else → Boolean(val); unknown feature → false.
 */
function can(plan, feature, { admin = false } = {}) {
  if (admin) return true;
  const row = PLAN_FEATURES[normalizePlan(plan)];
  const val = row[feature];
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val > 0;
  if (Array.isArray(val)) return val.length > 0;
  return Boolean(val);
}

/**
 * UserSettings.plan_limit(feature) — admin → max(pro value, 999999) when the
 * value is numeric (QUIRK: Python `isinstance(True, int)` is True, so a bool
 * feature also becomes 999999 for admins), otherwise the pro value as is;
 * non-admin → the plan's value, 0 when the key is missing.
 */
function planLimit(plan, feature, { admin = false } = {}) {
  if (admin) {
    const val = Object.prototype.hasOwnProperty.call(PLAN_FEATURES.pro, feature)
      ? PLAN_FEATURES.pro[feature] : 0;
    if (typeof val === 'number' || typeof val === 'boolean') return Math.max(Number(val), 999999);
    return val;
  }
  const row = PLAN_FEATURES[normalizePlan(plan)];
  return Object.prototype.hasOwnProperty.call(row, feature) ? row[feature] : 0;
}

/**
 * UserSettings.is_mutual_exclusion_required() — [FREE-MUTEX]: free users may
 * run only one of LONG/SHORT. Admins exempt. Note the bot compares the RAW
 * `sub_plan or "free"` with "free" here (no normalize_plan), so an unknown
 * legacy id would NOT be mutex-gated by the bot; the site stores only
 * normalized ids in trader_settings.sub_plan, so both readings agree.
 */
function isMutualExclusionRequired(plan, { admin = false } = {}) {
  if (admin) return false;
  return (String(plan || '').trim().toLowerCase() || 'free') === 'free';
}

// ── Strategy ownership / multi-strategy (config.py) ──────────────────────
const SCANNER_OWNERSHIP = Object.freeze({
  LEVELS: 'scanner_mid',
  SMC:    'smc_scanner',
  VOLUME: 'volume_scanner',
});
const STRATEGY_ORDER = Object.freeze(Object.keys(SCANNER_OWNERSHIP));

function isOwnedBy(strategy, scannerName) {
  return SCANNER_OWNERSHIP[strategy] === scannerName;
}

/** parse_strategies(raw): CSV → known strategies, de-duplicated, ordered as SCANNER_OWNERSHIP. */
function parseStrategies(raw) {
  const items = new Set(
    String(raw == null ? '' : raw).split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
      .map((x) => x.toUpperCase())
  );
  return STRATEGY_ORDER.filter((s) => items.has(s));
}

/**
 * enabled_strategies(user) → ordered array (LEVELS, SMC, VOLUME order).
 * `user` is a trader_settings-shaped object: { strategy, extra_strategies, sub_plan }.
 *   1. primary = (user.strategy || "LEVELS").upper(); out = {primary} if known else ∅
 *   2. extras = parse_strategies(user.extra_strategies); empty → out
 *   3. allowed = all three for admins; else PLAN_FEATURES[plan].strategies,
 *      minus VOLUME when !can("volume")
 *   4. out ∪ (extras ∩ allowed)
 * QUIRK: the primary strategy is NOT plan-filtered (a free user whose primary
 * is SMC is "enabled" for SMC; the SMC scanner then only sends the free preview).
 */
function enabledStrategies(user, { admin = false } = {}) {
  const u = user || {};
  const primary = String(u.strategy || 'LEVELS').toUpperCase();
  const out = new Set(SCANNER_OWNERSHIP[primary] ? [primary] : []);
  const extras = parseStrategies(u.extra_strategies);
  if (!extras.length) return STRATEGY_ORDER.filter((s) => out.has(s));
  let allowed;
  try {
    if (admin) {
      allowed = new Set(STRATEGY_ORDER);
    } else {
      const plan = normalizePlan(u.sub_plan || 'free');
      allowed = new Set(PLAN_FEATURES[plan].strategies);
      if (allowed.has('VOLUME') && !can(plan, 'volume')) allowed.delete('VOLUME');
    }
  } catch (_e) {
    allowed = new Set();
  }
  for (const s of extras) if (allowed.has(s)) out.add(s);
  return STRATEGY_ORDER.filter((s) => out.has(s));
}

/** strategy_enabled(user, S): does the scanner of strategy S serve this user? */
function strategyEnabled(user, strategy, opts) {
  return enabledStrategies(user, opts).includes(String(strategy || '').toUpperCase());
}

/** signal_registry._is_multi(user) = len(enabled_strategies(user)) >= 2 */
function isMulti(user, opts) {
  return enabledStrategies(user, opts).length >= 2;
}

/** Timeframe allowed on the plan (Mini App `locked` logic). */
function timeframeAllowed(plan, tf, opts) {
  if (opts && opts.admin) return true;
  return PLAN_FEATURES[normalizePlan(plan)].timeframes.includes(String(tf || ''));
}

module.exports = {
  PLAN_PRICES_USD,
  VALID_PLANS,
  PRICE_PRO,
  PLAN_PERIOD_DAYS,
  PLAN_FEATURES,
  PLAN_LABEL,
  DEFAULT_SIGNAL_WINDOWS,
  SCANNER_OWNERSHIP,
  STRATEGY_ORDER,
  normalizePlan,
  planLabel,
  can,
  planLimit,
  signalWindows,
  isMutualExclusionRequired,
  isOwnedBy,
  parseStrategies,
  enabledStrategies,
  strategyEnabled,
  isMulti,
  timeframeAllowed,
};
