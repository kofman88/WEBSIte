/**
 * userAccess — the subscription / plan methods of the bot's `UserSettings`
 * (user_manager.py): check_access, _disable_tier_locked_flags, grant_access,
 * can, plan_limit, is_mutual_exclusion_required, plan_label, any_active,
 * time_left_str, and the Mini App's `_is_pro`.
 *
 * Pure functions over a trader_settings-shaped object. The bot's admin
 * bypass (`uid in Config.ADMIN_IDS`) is the `admin` option — the caller
 * (traderSettingsService) resolves it from users.is_admin. `now` is unix
 * seconds (default: the clock).
 */

'use strict';

const pf = require('../../config/planFeatures');

const nowSec = () => Date.now() / 1000;

function can(user, feature, { admin = false } = {}) {
  return pf.can(user.sub_plan, feature, { admin });
}

function planLimit(user, feature, { admin = false } = {}) {
  return pf.planLimit(user.sub_plan, feature, { admin });
}

/** [FREE-MUTEX] free users may run only one of LONG/SHORT; admins exempt. */
function isMutualExclusionRequired(user, { admin = false } = {}) {
  if (admin) return false;
  return (user.sub_plan || 'free') === 'free';
}

function planLabel(user) {
  return pf.planLabel(user.sub_plan);
}

/** UserSettings.any_active() */
function anyActive(user) {
  return Boolean(user.long_active || user.short_active || (user.active && user.scan_mode === 'both'));
}

/**
 * [TIER-DOWNGRADE-DISABLE] force-disable flags the plan does not allow.
 * Returns the list of disabled flag names. Admins keep everything.
 */
function disableTierLockedFlags(user, { admin = false } = {}) {
  if (admin) return [];
  const disabled = [];
  if (!can(user, 'volume', { admin })) {
    for (const flag of ['vol_long_active', 'vol_short_active']) {
      if (user[flag]) {
        user[flag] = false;
        disabled.push(flag);
      }
    }
    if (user.strategy === 'VOLUME') {
      user.strategy = 'LEVELS';
      disabled.push('strategy');
    }
  }
  return disabled;
}

function _downgradeInMemory(user, opts) {
  user.sub_status = 'active';
  user.sub_plan = 'free';
  if (!user.long_active && !user.short_active) user.long_active = true;
  disableTierLockedFlags(user, opts);
}

/**
 * UserSettings.check_access() → [ok, reason]. MUTATES the object (expired
 * paid → free active + LONG); the caller decides whether to save.
 */
function checkAccess(user, { admin = false, now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  if (user.sub_status === 'banned') return [false, 'banned'];
  if (user.sub_plan === 'free') return [true, 'free'];
  if (user.sub_status === 'trial' || user.sub_status === 'active') {
    if (t < Number(user.sub_expires || 0)) return [true, user.sub_status];
    _downgradeInMemory(user, { admin });
    return [true, 'free'];
  }
  if (user.sub_status === 'expired') {
    _downgradeInMemory(user, { admin });
    return [true, 'free'];
  }
  return [false, 'unknown'];
}

/** miniapp_api._is_pro: check_access()[0] and normalize_plan(sub_plan) == "pro" (any exception → False). */
function isPro(user, opts = {}) {
  try {
    const [ok] = checkAccess(user, opts);
    return ok && pf.normalizePlan(user.sub_plan) === 'pro';
  } catch (_e) {
    return false;
  }
}

/**
 * UserSettings.grant_access(days) → bool (False = banned). Extends from the
 * current expiry only when already on a live paid plan; from `now` otherwise.
 * The caller sets `sub_plan` afterwards (and logs plan_changes).
 */
function grantAccess(user, days, { now = null } = {}) {
  if (user.sub_status === 'banned') return false;
  const t = now === null || now === undefined ? nowSec() : now;
  const paidActive = user.sub_status === 'active' && pf.normalizePlan(user.sub_plan) !== 'free';
  const base = paidActive ? Math.max(Number(user.sub_expires || 0), t) : t;
  user.sub_expires = base + days * 86400;
  user.sub_status = 'active';
  user.expired_notified = false;
  user.reminder_3d_sent = false;
  user.reminder_1d_sent = false;
  return true;
}

/** UserSettings.time_left_str(lang) */
function timeLeftStr(user, lang = 'ru', now = null) {
  const t = now === null || now === undefined ? nowSec() : now;
  const left = Number(user.sub_expires || 0) - t;
  const ru = lang === 'ru';
  if (left <= 0) return ru ? 'истёк' : 'expired';
  if (left < 3600) {
    const mins = Math.floor(left / 60);
    return ru ? `${mins} мин.` : `${mins} min`;
  }
  if (left < 86400) {
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    return ru ? `${h}ч ${m}м` : `${h}h ${m}m`;
  }
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  return ru ? `${d}д ${h}ч` : `${d}d ${h}h`;
}

module.exports = {
  can, planLimit, isMutualExclusionRequired, planLabel, anyActive,
  disableTierLockedFlags, checkAccess, isPro, grantAccess, timeLeftStr,
};
