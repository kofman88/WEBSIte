/**
 * traderSettingsService — the bot's `UserManager` + `UserSettings` row
 * lifecycle (user_manager.py, db/users.py) on the site's trader_settings
 * table (models/engineSchema.js, services/engine/README.md).
 *
 *   get / getOrCreate / save          — db_get_user / get_or_create / db_upsert_user
 *   fromDb / toDb                      — _from_db coercions (bool/int/float/json,
 *                                        strategy + sub_plan normalisation) / to_db
 *   getActiveUsers / allUsers          — db_get_active_users (SQL verbatim) /
 *                                        db_get_all_users, both behind the 30 s TTL cache
 *   resetSettings                      — db_reset_user_settings (_RESET_PRESERVE)
 *   checkAccess / can / planLimit / …  — UserSettings methods with the admin bypass
 *                                        resolved from users.is_admin
 *
 * A "user" here is a plain object with one property per trader_settings
 * column (+ user_id) — the shape every engine module takes.
 */

'use strict';

const db = require('../models/database');
const engineSchema = require('../models/engineSchema');
const pf = require('../config/planFeatures');
const access = require('./engine/userAccess');
const { pyJsonDumps } = require('./engine/pyjson');
const logger = require('../utils/logger');
const { pyLower, pyStrip } = require('../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const USERS_TTL_S = 30;                                    // user_manager._USERS_TTL
const STRATS = ['LEVELS', 'SMC', 'VOLUME'];

// ── column typing (UserSettings dataclass field types) ───────────────────
const BOOL_FIELDS = new Set([
  'active', 'trial_used', 'use_rsi', 'use_volume', 'use_pattern', 'use_htf', 'trend_only',
  'notify_signal', 'notify_breakout', 'long_active', 'short_active', 'smc_long_active',
  'smc_short_active', 'vol_long_active', 'vol_short_active', 'trial_reminder_sent',
  'expired_notified', 'auto_trade', 'bybit_demo', 'high_wr_mode', 'prop_mode', 'prop_trailing_dd',
  'prop_consistency', 'prop_unlocked', 'filters_all_off', 'sl_streak_enabled',
  'circuit_breaker_enabled', 'allow_low_notional_boost', 'prefer_market_entry', 'show_risk_preview',
  'correlation_cap_enabled', 'adaptive_sizing_enabled', 'hour_filter_enabled', 'trade_trending_only',
  'tilt_detector_enabled', 'hold_lock_enabled', 'auto_trailing_enabled', 'spread_check_enabled',
  'reminder_3d_sent', 'reminder_1d_sent', 'reminder_7d_after_sent', 'reminder_14d_after_sent',
  'reminder_30d_after_sent', 'reminders_optout', 'onboarding_done', 'optimizer_enabled',
  'genome_auto_apply', 'btc_correlation_block', 'allow_counter_trend', 'partial_tp_enabled',
  'send_chart_enabled', 'progress_notify_enabled', 'ai_show_confidence_score',
  'ai_adaptive_recommendations',
]);
const INT_FIELDS = new Set([
  'scan_interval', 'pivot_strength', 'max_level_age', 'max_retest_bars', 'ema_fast', 'ema_slow',
  'htf_ema_period', 'rsi_period', 'rsi_ob', 'rsi_os', 'vol_len', 'atr_period', 'min_quality',
  'cooldown_bars', 'max_level_tests', 'long_interval', 'short_interval', 'signals_received',
  'trade_leverage', 'max_trades_limit', 'prop_min_days', 'prop_max_days', 'prop_trading_days',
  'prop_last_trade_day', 'sl_streak_threshold', 'min_signal_quality',
  'levels_counter_trend_min_quality', 'smc_counter_trend_min_quality', 'at_stats_period',
  'max_coins_count', 'free_signals_today', 'free_missed_today', 'free_signals_morning',
  'free_signals_evening', 'free_signals_night', 'quiet_start', 'quiet_end', 'free_smc_preview_today',
]);
const FLOAT_FIELDS = new Set([
  'sub_expires', 'trial_started', 'zone_buffer', 'vol_mult', 'atr_mult', 'max_risk_pct', 'tp1_rr',
  'tp2_rr', 'tp3_rr', 'min_volume_usdt', 'zone_pct', 'max_dist_pct', 'min_rr', 'smc_max_sl_pct',
  'trade_risk_pct', 'prop_capital', 'prop_base_risk', 'prop_target', 'prop_max_dd',
  'prop_daily_limit', 'prop_start_balance', 'prop_start_date', 'prop_day_start_balance',
  'prop_peak_balance', 'circuit_breaker_threshold_r', 'correlation_cap_threshold',
  'hold_lock_min_rr', 'spread_max_pct', 'last_reminder_at', 'fixed_amount', 'partial_tp1_r',
  'partial_tp1_pct', 'partial_tp2_r', 'partial_tp2_pct', 'ptp_profit_pct1', 'ptp_profit_pct2',
  'created_at', 'updated_at',
]);
const JSON_FIELDS = new Set(['ai_filter_settings']);

const COLUMNS = engineSchema.TRADER_SETTINGS_COLUMNS.map((c) => c[0]);
const COLUMN_SET = new Set(COLUMNS);

function fieldType(name) {
  if (BOOL_FIELDS.has(name)) return 'bool';
  if (INT_FIELDS.has(name)) return 'int';
  if (FLOAT_FIELDS.has(name)) return 'float';
  if (JSON_FIELDS.has(name)) return 'json';
  return 'str';
}

function parseDefault(name, type, literal) {
  const t = fieldType(name);
  if (t === 'json') return JSON.parse(literal.slice(1, -1));
  if (type === 'TEXT') return literal.slice(1, -1);
  if (t === 'bool') return Boolean(Number(literal));
  return Number(literal);
}

// UserSettings dataclass defaults, column order (sanity-checked at load:
// every column must have a known type, so a schema change here is loud).
const DEFAULTS = Object.freeze(Object.fromEntries(
  engineSchema.TRADER_SETTINGS_COLUMNS.map(([name, type, dflt]) => {
    const ft = fieldType(name);
    if (ft === 'str' && type !== 'TEXT') throw new Error(`traderSettingsService: untyped column ${name}`);
    return [name, parseDefault(name, type, dflt)];
  }),
));

// AUDIT-FIX-C76 db/users._RESET_PRESERVE minus the columns that are not in
// trader_settings (username, API keys → exchange_keys).
const RESET_PRESERVE = Object.freeze([
  'user_id', 'lang', 'active',
  'sub_status', 'sub_plan', 'sub_expires', 'trial_started', 'trial_used',
  'trial_reminder_sent', 'expired_notified', 'reminder_3d_sent', 'reminder_1d_sent',
  'reminder_7d_after_sent', 'reminder_14d_after_sent', 'reminder_30d_after_sent',
  'last_reminder_at', 'reminders_optout', 'onboarding_done',
  'bybit_demo', 'trade_exchange',
  'prop_mode', 'prop_firm', 'prop_capital', 'prop_base_risk', 'prop_target', 'prop_max_dd',
  'prop_daily_limit', 'prop_min_days', 'prop_max_days', 'prop_trailing_dd', 'prop_consistency',
  'prop_start_balance', 'prop_start_date', 'prop_day_start_balance', 'prop_peak_balance',
  'prop_trading_days', 'prop_last_trade_day', 'prop_unlocked',
]);

const nowSec = () => Date.now() / 1000;

/** UserSettings(user_id=…) — a fresh object with the dataclass defaults. */
function defaults(userId) {
  const u = { user_id: Number(userId) };
  for (const name of COLUMNS) {
    const v = DEFAULTS[name];
    u[name] = v && typeof v === 'object' ? { ...v } : v;
  }
  return u;
}

/** _from_db(row) */
function fromDb(row) {
  const u = defaults(row.user_id);
  for (const name of COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(row, name) || row[name] === null || row[name] === undefined) continue;
    let v = row[name];
    if (name === 'strategy' && !STRATS.includes(v)) v = 'LEVELS';
    if (name === 'sub_plan') v = pf.normalizePlan(v);
    switch (fieldType(name)) {
      case 'json':
        if (typeof v === 'string' && pyStrip(v)) {
          try { v = JSON.parse(v); } catch (_e) { v = u[name]; }
        } else if (!v || typeof v !== 'object') {
          v = u[name];
        }
        break;
      case 'bool':
        v = Boolean(v);
        break;
      case 'int': {
        const n = Number(v);
        v = Number.isFinite(n) ? Math.trunc(n) : DEFAULTS[name];
        break;
      }
      case 'float': {
        const n = Number(v);
        v = Number.isFinite(n) ? n : DEFAULTS[name];
        break;
      }
      default:
        break;
    }
    u[name] = v;
  }
  return u;
}

/** to_db(): bools → 0/1, dict fields → json.dumps, everything else as is. */
function toDb(user) {
  const d = { user_id: Number(user.user_id) };
  for (const name of COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(user, name)) continue;
    const v = user[name];
    if (JSON_FIELDS.has(name) && v && typeof v === 'object') d[name] = pyJsonDumps(v);
    else if (typeof v === 'boolean' || BOOL_FIELDS.has(name)) d[name] = v ? 1 : 0;
    else d[name] = v;
  }
  return d;
}

// ── caches (user_manager._active_users_cache / _all_users_cache) ────────
let _activeCache = null;    // { list, expiresAt }
let _allCache = null;

function invalidateCache() {
  _activeCache = null;
  _allCache = null;
}

function _upsert(data, now) {
  data.updated_at = now;
  if (!data.created_at) data.created_at = now;          // db_upsert_user: created_at only on INSERT
  const cols = Object.keys(data).filter((c) => c === 'user_id' || COLUMN_SET.has(c));
  const updates = cols.filter((c) => c !== 'user_id' && c !== 'created_at').map((c) => `${c}=excluded.${c}`).join(', ');
  const sql = `INSERT INTO trader_settings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(user_id) DO UPDATE SET ${updates}`;
  db.prepare(sql).run(...cols.map((c) => data[c]));
}

/** UserManager.save(user) */
function save(user, { now = null } = {}) {
  _upsert(toDb(user), now === null || now === undefined ? nowSec() : now);
  invalidateCache();
  return user;
}

function getRow(userId) {
  return db.prepare('SELECT * FROM trader_settings WHERE user_id = ?').get(Number(userId)) || null;
}

/** UserManager.get(user_id) → user | null */
function get(userId) {
  const row = getRow(userId);
  return row ? fromDb(row) : null;
}

/**
 * UserManager.get_or_create: a new row gets the dataclass defaults, lang from
 * users.locale (bot: "ru" for ru/uk/be, else "en"). Unknown site user → 404.
 */
function getOrCreate(userId, { now = null } = {}) {
  const existing = get(userId);
  if (existing) return existing;
  const site = db.prepare('SELECT id, locale FROM users WHERE id = ?').get(Number(userId));
  if (!site) {
    const err = new Error('User not found');
    err.statusCode = 404; err.code = 'NO_USER';
    throw err;
  }
  const t = now === null || now === undefined ? nowSec() : now;
  const lang = ['ru', 'uk', 'be'].includes(pyLower(String(site.locale || 'ru'))) ? 'ru' : 'en';
  db.prepare('INSERT OR IGNORE INTO trader_settings (user_id, created_at, updated_at, lang) VALUES (?, ?, ?, ?)')
    .run(Number(userId), t, t, lang);
  invalidateCache();
  logger.info(`Новый пользователь: (${userId}) lang=${lang}`);
  return get(userId);
}

/** db_get_active_users (SQL verbatim on trader_settings) behind the 30 s cache. */
function getActiveUsers({ now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  if (_activeCache && t < _activeCache.expiresAt) return _activeCache.list;
  const rows = db.prepare(`
    SELECT * FROM trader_settings
    WHERE (sub_plan='free'
           OR (sub_status IN ('trial','active')
               AND sub_expires > ?))
    AND (active=1 OR long_active=1 OR short_active=1
         OR smc_long_active=1 OR smc_short_active=1
         OR vol_long_active=1 OR vol_short_active=1)
  `).all(t);
  const list = rows.map(fromDb);
  _activeCache = { list, expiresAt: t + USERS_TTL_S };
  return list;
}

/** db_get_all_users (ORDER BY created_at DESC) behind the 30 s cache. */
function allUsers({ now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  if (_allCache && t < _allCache.expiresAt) return _allCache.list;
  const list = db.prepare('SELECT * FROM trader_settings ORDER BY created_at DESC').all().map(fromDb);
  _allCache = { list, expiresAt: t + USERS_TTL_S };
  return list;
}

/**
 * db_reset_user_settings: factory reset — dataclass defaults, keeping the
 * _RESET_PRESERVE columns of the current row. false when the row is missing.
 */
function resetSettings(userId, { now = null } = {}) {
  const cur = getRow(userId);
  if (!cur) return false;
  const d = toDb(defaults(userId));
  for (const key of RESET_PRESERVE) {
    if (Object.prototype.hasOwnProperty.call(cur, key) && cur[key] !== null && cur[key] !== undefined) d[key] = cur[key];
  }
  d.user_id = Number(userId);
  _upsert(d, now === null || now === undefined ? nowSec() : now);
  invalidateCache();
  return true;
}

// ── plan / access helpers (admin bypass from users.is_admin) ─────────────
function isAdmin(userId) {
  const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(Number(userId));
  return Boolean(row && row.is_admin);
}

function adminOpt(user, opts = {}) {
  return { ...opts, admin: opts.admin === undefined ? isAdmin(user.user_id) : Boolean(opts.admin) };
}

const checkAccess = (user, opts) => access.checkAccess(user, adminOpt(user, opts));
const can = (user, feature, opts) => access.can(user, feature, adminOpt(user, opts));
const planLimit = (user, feature, opts) => access.planLimit(user, feature, adminOpt(user, opts));
const isMutualExclusionRequired = (user, opts) => access.isMutualExclusionRequired(user, adminOpt(user, opts));
const isPro = (user, opts) => access.isPro(user, adminOpt(user, opts));
const disableTierLockedFlags = (user, opts) => access.disableTierLockedFlags(user, adminOpt(user, opts));
const grantAccess = (user, days, opts) => access.grantAccess(user, days, opts);
const { anyActive, planLabel, timeLeftStr } = access;

module.exports = {
  USERS_TTL_S, COLUMNS, BOOL_FIELDS, INT_FIELDS, FLOAT_FIELDS, JSON_FIELDS, DEFAULTS, RESET_PRESERVE,
  fieldType, defaults, fromDb, toDb,
  get, getRow, getOrCreate, save, getActiveUsers, allUsers, invalidateCache, resetSettings,
  isAdmin, checkAccess, can, planLimit, isMutualExclusionRequired, isPro, disableTierLockedFlags,
  grantAccess, anyActive, planLabel, timeLeftStr,
};
