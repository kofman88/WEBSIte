/**
 * strategySet — which strategies a user runs and how the Mini App toggles
 * them: config.parse_strategies / enabled_strategies / strategy_enabled
 * (re-exported from config/planFeatures), miniapp_api `_FLAGS`, `_primary_on`,
 * `_apply_multi` (the [MULTI-STRATEGY] truth table), `_strategy_locked` and
 * `_strategies` (the `GET me` strategies block).
 *
 * Pure functions over a trader_settings-shaped object. `admin` = bot
 * ADMIN_IDS bypass, resolved by the caller.
 */

'use strict';

const pf = require('../../config/planFeatures');
const access = require('./userAccess');

const STRATS = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const FLAGS = Object.freeze({
  LEVELS: ['long_active', 'short_active'],
  SMC: ['smc_long_active', 'smc_short_active'],
  VOLUME: ['vol_long_active', 'vol_short_active'],
});

const { parseStrategies, enabledStrategies, strategyEnabled, isMulti } = pf;

/** _primary_on(user): the primary strategy has either direction flag on. */
function primaryOn(user) {
  const flags = FLAGS[user.strategy || ''];
  if (!flags) return false;
  return Boolean(user[flags[0]] || user[flags[1]]);
}

/**
 * _apply_multi(user, s, on): turning S on when S ≠ primary → extra (if the
 * primary runs) or S becomes primary; turning off → drop from extras, or if S
 * is the primary and extras exist → first extra becomes primary. Writes the
 * canonical CSV back (LEVELS, SMC, VOLUME order, deduped).
 */
function applyMulti(user, s, on) {
  const primary = user.strategy || 'LEVELS';
  let extras = parseStrategies(user.extra_strategies).filter((x) => x !== primary);
  if (on) {
    if (s !== primary) {
      const otherOn = Boolean(FLAGS[primary]) && primaryOn(user);
      if (otherOn) {
        if (!extras.includes(s)) extras.push(s);
      } else {
        user.strategy = s;
        extras = extras.filter((x) => x !== s);
      }
    }
  } else if (extras.includes(s)) {
    extras = extras.filter((x) => x !== s);
  } else if (s === primary && extras.length) {
    user.strategy = extras.shift();
  }
  user.extra_strategies = parseStrategies(extras.join(',')).join(',');
}

/**
 * _strategy_locked(user, s): admin → False; S ∉ PLAN_FEATURES[plan].strategies
 * → True (plan = normalized sub_plan when _is_pro else "free"); VOLUME without
 * can("volume") → True. Any exception → s != "LEVELS".
 * NOTE: `_is_pro` runs check_access, which may downgrade `user` in memory.
 */
function strategyLocked(user, strategy, { admin = false, now = null } = {}) {
  try {
    if (admin) return false;
    const plan = access.isPro(user, { admin, now }) ? pf.normalizePlan(user.sub_plan) : 'free';
    const allowed = pf.PLAN_FEATURES[plan].strategies;
    if (!allowed.includes(strategy)) return true;
    if (strategy === 'VOLUME' && !access.can(user, 'volume', { admin })) return true;
    return false;
  } catch (_e) {
    return strategy !== 'LEVELS';
  }
}

/** _strategies(user): {S: {long, short, locked, primary, enabled}} */
function strategiesState(user, opts = {}) {
  let on;
  try {
    on = enabledStrategies(user, { admin: Boolean(opts.admin) });
  } catch (_e) {
    on = [user.strategy || 'LEVELS'];
  }
  const out = {};
  for (const s of STRATS) {
    const [lf, sf] = FLAGS[s];
    const lo = Boolean(user[lf]);
    const sh = Boolean(user[sf]);
    out[s] = {
      long: lo,
      short: sh,
      locked: strategyLocked(user, s, opts),
      primary: s === (user.strategy || ''),
      enabled: on.includes(s) && (lo || sh),
    };
  }
  return out;
}

module.exports = {
  STRATS, FLAGS,
  parseStrategies, enabledStrategies, strategyEnabled, isMulti,
  primaryOn, applyMulti, strategyLocked, strategiesState,
};
