/**
 * appSettingsService — the Mini App's `GET/POST settings/all` contract
 * (miniapp_api.py `_SCHEMA` / `_TOP_SCHEMA` / `_coerce` / `_validate_sections`
 * / `_settings_all` / `_locked_keys` / `h_settings_all_post`,
 * ui-inventory.md §6.11–6.12, data-and-market.md §2.7) extended with the
 * sections decision D9 adds for everything the bot let a user change only
 * through its Telegram menus (handlers/settings.py, trading.py, smc.py,
 * partial_tp.py, volume.py, simple_mode.py):
 *
 *   levels.shared   — the shared TradeCfg fields the Mini App did not expose
 *                     (+ timeframe / scan_interval / high_wr_mode /
 *                     levels_counter_trend_min_quality)
 *   levels.long / levels.short — per-direction sparse overrides (every
 *                     TradeCfg field, `interval`, `reset`)
 *   smc.advanced    — the SMC fine settings + smc_counter_trend_min_quality
 *   ptp             — the partial-TP ladder
 *   risk.advanced   — spread / boost / risk preview / corr cap / adaptive
 *                     sizing / tilt / hold-lock / Profit Maximizer quality
 *   trading.{disabled_days, fixed_amount, vol_filter_mode, max_coins_count,
 *            at_stats_period, optimizer_enabled, optimizer_strategies}
 *   notifications.{notify_signal, notify_breakout}
 *
 * Validation of the D9 keys mirrors the Telegram handlers: radio menus accept
 * exactly the keyboard options (`choice`), explicit clamps become ranges
 * (`int` / `float`), free-text TP targets keep the handler's checks. Every
 * rejected key answers `bad_request "<section>.<key>"` like the Mini App.
 *
 * Plan gates (nothing saved on failure) are the Mini App's. QUIRK(D9): the
 * bot lets Free users change ptp / risk.advanced / levels.* / the new
 * `trading.*` keys (they live outside the auto-trade toggle), so the server
 * accepts them on Free while `options.locked` keeps the Mini App wildcards
 * (`trading.*` …) — same pattern as the documented LEVELS-timeframe quirk.
 */

'use strict';

const db = require('../models/database');
const pf = require('../config/planFeatures');
const ts = require('./traderSettingsService');
const tradeCfg = require('./engine/tradeCfg');
const smcUserCfg = require('./engine/smcUserCfg');
const quietHours = require('./engine/quietHours');
const volumeUserCfg = require('./volumeUserCfg');
const volumeCfg = require('./engine/volumeCfgShim');
const exchangeService = require('./exchangeService');
const { isClose, pyFloat } = require('./engine/pycoerce');
const logger = require('../utils/logger');

// ── constants (miniapp_api.py) ───────────────────────────────────────────
const TF_LEVELS = Object.freeze(['15m', '30m', '1h', '4h', '1d']);
const TF_SMC = Object.freeze(['15m', '1H', '4H']);
const TF_VOLUME = Object.freeze(['15m', '1h', '4h']);
const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const INTERVALS = Object.freeze([60, 180, 300, 900, 1800, 3600, 7200, 14400, 86400]);   // keyboards._interval_rows

const OPTIONS = Object.freeze({
  tf_levels: TF_LEVELS, tf_smc: TF_SMC, tf_volume: TF_VOLUME,
  exchanges: EXCHANGES, leverage: [1, 2, 3, 5, 10, 20],
  risk_pct: [0.25, 0.5, 1, 1.5, 2, 3], max_trades: [1, 2, 3, 5, 10],
  min_volume: [300000, 1000000, 5000000, 10000000, 25000000, 50000000],
});

// keyboards.py radio lists for the LEVELS fine parameters (shared / long / short).
const LEVELS_CHOICES = Object.freeze({
  pivot_strength: [3, 5, 7, 10, 15, 17, 20],
  max_level_age: [30, 50, 75, 100, 142, 150, 200, 250, 300],
  max_retest_bars: [10, 20, 30, 50],
  zone_buffer: [0.0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0],
  zone_pct: [0.2, 0.3, 0.5, 0.7, 1.0, 1.2, 1.35, 1.5, 2.0, 2.5, 3.0],
  max_dist_pct: [0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 7.0],
  max_level_tests: [1, 2, 3, 4, 5, 6, 7, 8, 10, 99],
  min_rr: [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
  ema_fast: [20, 50, 100],
  ema_slow: [100, 200, 500],
  htf_ema_period: [20, 50, 100, 200],
  rsi_period: [7, 14, 21],
  rsi_ob: [60, 65, 70, 75],
  rsi_os: [25, 30, 35, 40],
  vol_mult: [1.0, 1.2, 1.5, 2.0],
  min_quality: [1, 2, 3, 4, 5],
  cooldown_bars: [0, 1, 2, 3, 5, 8, 10, 15, 20],
  atr_period: [7, 14, 21],
  atr_mult: [0.5, 1.0, 1.5, 2.0],
  max_risk_pct: [0.5, 1.0, 1.5, 2.0, 3.0],
  min_volume_usdt: [100000, 300000, 1000000, 5000000, 10000000, 25000000, 50000000, 100000000],
});
const LEVELS_TOGGLES = Object.freeze(['use_rsi', 'use_volume', 'use_pattern', 'use_htf', 'trend_only']);
// TradeCfg fields that are NOT per-direction overrides (flat columns long_tf / long_interval).
const DIR_EXCLUDED = new Set(['timeframe', 'scan_interval']);

function directionSchema() {
  const s = {};
  for (const [k, list] of Object.entries(LEVELS_CHOICES)) s[k] = ['choice', list];
  for (const k of LEVELS_TOGGLES) s[k] = ['bool'];
  s.tp1_rr = ['float_any'];                 // save_long_tp1: float() only
  s.tp2_rr = ['float_any'];
  s.tp3_rr = ['float_any'];
  s.interval = ['choice', INTERVALS];       // set_long_interval_ → long_interval
  s.reset = ['bool'];                       // reset_long_cfg → long_cfg = "{}"
  return s;
}

// Mini App `levels` keys stay as they are; `levels.shared` exposes the rest.
const MINIAPP_LEVELS_KEYS = new Set(['long_tf', 'short_tf', 'min_quality', 'min_volume_usdt', 'min_rr',
  'max_dist_pct', 'zone_pct', 'use_rsi', 'use_volume', 'use_htf', 'trend_only', 'max_risk_pct']);

function sharedSchema() {
  const s = { timeframe: ['enum', TF_LEVELS], scan_interval: ['choice', INTERVALS] };
  for (const [k, list] of Object.entries(LEVELS_CHOICES)) if (!MINIAPP_LEVELS_KEYS.has(k)) s[k] = ['choice', list];
  s.use_pattern = ['bool'];
  s.tp1_rr = ['float_gt', 0, 100];          // save_tp1: 0 < v ≤ 100 (BUG-006)
  s.tp2_rr = ['float_any'];
  s.tp3_rr = ['float_any'];
  s.high_wr_mode = ['bool'];                // toggle_high_wr
  s.levels_counter_trend_min_quality = ['int', 0, 5];   // set_ct_minq_ (clamp 0..5)
  return s;
}

// ── schema: key → ("bool",) | ("enum", values) | ("int", lo, hi) | ("float", lo, hi) | D9 kinds ──
const SCHEMA = Object.freeze({
  levels: {
    long_tf: ['enum', TF_LEVELS], short_tf: ['enum', TF_LEVELS],
    min_quality: ['int', 0, 10], min_volume_usdt: ['float', 0, 1e10],
    min_rr: ['float', 0.5, 10], max_dist_pct: ['float', 0.1, 10],
    zone_pct: ['float', 0.1, 5], use_rsi: ['bool'], use_volume: ['bool'],
    use_htf: ['bool'], trend_only: ['bool'], max_risk_pct: ['float', 0.1, 5],
    // D9
    shared: ['section', sharedSchema()],
    long: ['section', directionSchema()],
    short: ['section', directionSchema()],
  },
  smc: {
    tf_key: ['enum', TF_SMC], direction: ['enum', ['BOTH', 'LONG', 'SHORT']],
    min_volume_usdt: ['float', 0, 1e10], max_sl_pct: ['float', 0, 20],
    scan_interval: ['int', 60, 86400],
    // D9 (handlers/smc.py)
    advanced: ['section', {
      min_confirmations: ['choice', [2, 3, 4, 5]],
      min_rr: ['choice', [1.5, 2.0, 2.5, 3.0]],
      sl_buffer_pct: ['choice', [0.1, 0.15, 0.25, 0.5]],
      fvg_enabled: ['bool'], choch_enabled: ['bool'], ob_use_breaker: ['bool'], sweep_close_req: ['bool'],
      ob_max_age: ['choice', [20, 30, 50, 100]],
      smc_conf_type: ['enum', ['BODY_CLOSE', 'WICK_TOUCH']],
      smc_pd_filter: ['bool'],
      smc_retrace_depth: ['float', 0.0, 1.0],           // smc_set_retrace_ clamp 0..1
      smc_mtf_check: ['bool'],
      smc_use_volume_filter: ['bool'],
      smc_vol_mult: ['float', 0.5, 5.0],                 // smc_set_vol_mult_ clamp 0.5..5
      smc_counter_trend_min_quality: ['int', 0, 5],      // set_smc_ct_minq_ clamp 0..5
    }],
  },
  volume: {
    timeframe: ['enum', TF_VOLUME], setup_cross: ['bool'], setup_turn: ['bool'],
    setup_bounce: ['bool'], setup_golden: ['bool'], setup_ribbon: ['bool'],
    ma_type: ['enum', ['sma', 'ema']], vol_mult: ['float', 0.5, 10],
    use_htf: ['bool'], min_quality: ['int', 1, 5],
  },
  trading: {
    auto_trade: ['bool'], auto_trade_mode: ['enum', ['auto', 'confirm']],
    trade_exchange: ['enum', EXCHANGES], trade_risk_pct: ['float', 0.1, 5],
    trade_leverage: ['int', 1, 50],
    // D9: the Mini App took 1..50; the bot's «✏️ Своё значение» (set_at_maxtr_custom)
    // accepts 0..9999 with 0 = unlimited, so the web takes the superset.
    max_trades_limit: ['int', 0, 9999],
    risk_mode: ['enum', ['risk', 'notional']], partial_tp_enabled: ['bool'],
    auto_trailing_enabled: ['bool'], prefer_market_entry: ['bool'],
    bybit_demo: ['bool'],
    // D9 (handlers/settings.py disabled_days / fixed_amount, trading.py vol mode / coins / period)
    disabled_days: ['days'],
    fixed_amount: ['choice', [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]],
    vol_filter_mode: ['enum', ['usdt', 'count', 'both', 'off']],
    max_coins_count: ['choice', [20, 30, 50, 100, 200]],
    at_stats_period: ['choice', [1, 7, 30]],
    // D9 (handlers/settings.py optimizer_menu: toggle_optimizer / optim_strat_<S>, decision D11)
    optimizer_enabled: ['bool'],
    optimizer_strategies: ['strats', ['LEVELS', 'SMC']],
  },
  // D9 (handlers/partial_tp.py)
  ptp: {
    ptp_mode: ['enum', ['R', 'PCT']],
    partial_tp1_r: ['choice', [0.5, 0.75, 1.0, 1.25, 1.5]],
    partial_tp2_r: ['choice', [1.0, 1.5, 2.0, 2.5, 3.0]],
    partial_tp1_pct: ['choice', [20, 30, 40, 50, 60]],
    partial_tp2_pct: ['choice', [15, 20, 25, 30, 40]],
    ptp_profit_pct1: ['choice', [15, 20, 30, 40, 50]],
    ptp_profit_pct2: ['choice', [30, 40, 50, 70, 100]],
  },
  risk: {
    sl_streak_enabled: ['bool'], sl_streak_threshold: ['int', 1, 20],
    circuit_breaker_enabled: ['bool'], circuit_breaker_threshold_r: ['float', 0, 100],
    allow_counter_trend: ['bool'], filters_all_off: ['bool'],
    btc_correlation_block: ['bool'], spread_check_enabled: ['bool'],
    trade_trending_only: ['bool'], hour_filter_enabled: ['bool'],
    // D9 (handlers/trading.py Risk Management menu)
    advanced: ['section', {
      spread_max_pct: ['choice', [0.1, 0.2, 0.3, 0.5, 1.0]],      // set_spread_max: also enables the check
      allow_low_notional_boost: ['bool'],
      show_risk_preview: ['bool'],
      correlation_cap_enabled: ['bool'],
      correlation_cap_threshold: ['float', 0.4, 0.95],            // set_corr_cap_thr: 0.4 ≤ v ≤ 0.95
      adaptive_sizing_enabled: ['bool'],
      adaptive_sizing_mode: ['enum', ['all', 'kelly', 'vol', 'dd', 'off']],
      tilt_detector_enabled: ['bool'],
      hold_lock_enabled: ['bool'],
      min_signal_quality: ['choice', [3, 4, 5]],                  // pm_cycle_quality
      reset_all_filters: ['bool'],                                 // reset_all_filters action
    }],
  },
  notifications: {
    progress_notify_enabled: ['bool'], send_chart_enabled: ['bool'],
    signal_format: ['enum', ['full', 'lite']],
    quiet_start: ['int', -1, 23], quiet_end: ['int', -1, 23],
    // D9 (toggle_notify_signal / toggle_notify_breakout)
    notify_signal: ['bool'], notify_breakout: ['bool'],
  },
});
const TOP_SCHEMA = Object.freeze({
  lang: ['enum', ['ru', 'en']], ui_mode: ['enum', ['simple', 'expert']], genome_auto_apply: ['bool'],
});
// QUIRK(D9): keys the bot lets Free users change although the Mini App locks `trading.*`.
const TRADING_FREE_KEYS = new Set(['disabled_days', 'fixed_amount', 'vol_filter_mode', 'max_coins_count', 'at_stats_period',
  'optimizer_enabled', 'optimizer_strategies']);

class BadRequest extends Error {
  constructor(key) { super(key); this.key = key; }
}

function toNumber(v) {
  // `float(v)` after the Mini App's own guards: bools and blank strings are rejected.
  if (typeof v === 'boolean') throw new BadRequest('bool');
  if (typeof v === 'string') {
    if (!v.trim()) throw new BadRequest('blank');
    try {
      return pyFloat(v);          // QUIRK: Python float() accepts "1_0" (PEP 515), "inf", "nan"
    } catch (_e) {
      throw new BadRequest('nan');
    }
  }
  if (typeof v !== 'number') throw new BadRequest('type');   // Python float(list) → TypeError
  return v;
}

/**
 * `_coerce(spec, v)`: bool ← bool | 0/1 | "true/false/1/0/on/off"; enum = exact
 * string; int/float reject bools and blank strings, require lo ≤ float(v) ≤ hi
 * and not NaN; int additionally integral. D9 kinds: choice (numeric option
 * list), float_gt (lo < v ≤ hi), float_any (finite), days (weekday list/CSV),
 * section (nested schema, handled by validate).
 */
function coerce(spec, v) {
  const kind = spec[0];
  if (kind === 'bool') {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number' && (v === 0 || v === 1)) return Boolean(v);
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (['true', 'false', '1', '0', 'on', 'off'].includes(t)) return ['true', '1', 'on'].includes(t);
    }
    throw new BadRequest('bool');
  }
  if (kind === 'enum') {
    if (typeof v === 'string' && spec[1].includes(v)) return v;
    throw new BadRequest('enum');
  }
  if (kind === 'days') {
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',').filter((x) => x.trim()) : null);
    if (!raw) throw new BadRequest('days');
    const out = new Set();
    for (const d of raw) {
      const n = toNumber(d);
      if (!Number.isInteger(n) || n < 0 || n > 6) throw new BadRequest('days');
      out.add(n);
    }
    return [...out].sort((a, b) => a - b);
  }
  if (kind === 'strats') {
    // optim_strat_<S>: strategy names (list or CSV), upper-cased, de-duplicated in the
    // given order like the handler's toggle list; empty → "LEVELS". Stored as CSV.
    const raw = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : null);
    if (!raw) throw new BadRequest('strats');
    const out = [];
    for (const s of raw) {
      if (typeof s !== 'string') throw new BadRequest('strats');
      const t = s.trim().toUpperCase();
      if (!t) continue;
      if (!spec[1].includes(t)) throw new BadRequest('strats');
      if (!out.includes(t)) out.push(t);
    }
    return out.length ? out.join(',') : 'LEVELS';
  }
  const num = toNumber(v);
  if (Number.isNaN(num)) throw new BadRequest('nan');
  if (kind === 'choice') {
    const hit = spec[1].find((x) => isClose(x, num, 1e-9, 1e-9));
    if (hit === undefined) throw new BadRequest('choice');
    return hit;
  }
  if (kind === 'float_any') {
    if (!Number.isFinite(num)) throw new BadRequest('range');
    return num;
  }
  if (kind === 'float_gt') {
    if (!(spec[1] < num && num <= spec[2])) throw new BadRequest('range');
    return num;
  }
  if (!(spec[1] <= num && num <= spec[2])) throw new BadRequest('range');
  if (kind === 'int') {
    if (Math.abs(num - Math.round(num)) > 1e-9) throw new BadRequest('int');
    return Math.round(num);
  }
  return num;
}

function validatePart(schema, part, path) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) throw new BadRequest(path);
  const out = {};
  for (const [k, spec] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(part, k)) continue;
    if (spec[0] === 'section') {
      out[k] = validatePart(spec[1], part[k], `${path}.${k}`);
      if (!Object.keys(out[k]).length) delete out[k];
      continue;
    }
    try {
      out[k] = coerce(spec, part[k]);
    } catch (_e) {
      throw new BadRequest(`${path}.${k}`);
    }
  }
  return out;
}

/**
 * `_validate_sections(body)` → {changes: {section: {key: value}}, top: {key: value}}
 * or throws BadRequest(key). Unknown keys are ignored; a section that is not
 * an object → bad_request "<section>".
 */
function validateSections(body) {
  const changes = {};
  for (const [section, schema] of Object.entries(SCHEMA)) {
    const part = body[section];
    if (part === null || part === undefined) continue;
    changes[section] = validatePart(schema, part, section);
    if (!Object.keys(changes[section]).length) delete changes[section];
  }
  const top = {};
  for (const [k, spec] of Object.entries(TOP_SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    try {
      top[k] = coerce(spec, body[k]);
    } catch (_e) {
      throw new BadRequest(k);
    }
  }
  return { changes, top };
}

// ── exchange keys (exchange_keys table instead of users.<ex>_api_key) ──
function keyHint(key) {
  const k = String(key || '');
  return k.length >= 6 ? `${k.slice(0, 4)}…${k.slice(-2)}` : (k ? '…' : '');
}

/** `_exchange_keys(user, ex)` → [key, secret, passphrase(okx only)] from exchange_keys. */
function exchangeKeys(userId, ex) {
  const row = db.prepare(`
    SELECT id FROM exchange_keys WHERE user_id = ? AND exchange = ?
    ORDER BY CASE WHEN label = 'default' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1
  `).get(Number(userId), ex);
  if (!row) return ['', '', ''];
  try {
    const c = exchangeService.getCredentials(row.id, Number(userId));
    return [c.apiKey || '', c.apiSecret || '', ex === 'okx' ? (c.passphrase || '') : ''];
  } catch (_e) {
    return ['', '', ''];
  }
}

function exchangesState(userId) {
  const out = {};
  for (const ex of EXCHANGES) {
    const [key, secret] = exchangeKeys(userId, ex);
    const ok = Boolean(key && secret);
    out[ex] = { connected: ok, key_hint: ok ? keyHint(key) : '' };
  }
  return out;
}

/** `_locked_keys(user)` — the Mini App list (client wildcard semantics). */
function lockedKeys(user, opts) {
  const out = [];
  if (!ts.can(user, 'smc', opts)) out.push('smc.*');
  if (!ts.can(user, 'volume', opts)) out.push('volume.*');
  if (!ts.can(user, 'auto_trade', opts)) out.push('trading.*');
  if (!ts.can(user, 'genome', opts)) out.push('genome_auto_apply');
  if (!ts.can(user, 'expert_mode', opts)) out.push('ui_mode.expert');
  if (!ts.can(user, 'all_timeframes', opts)) {
    out.push('levels.long_tf');
    out.push('levels.short_tf');
  }
  return out;
}

/** Dotted path → allowed values for every enum / choice key (for the web UI). */
function choices() {
  const out = {};
  const walk = (schema, prefix) => {
    for (const [k, spec] of Object.entries(schema)) {
      if (spec[0] === 'section') walk(spec[1], `${prefix}${k}.`);
      else if (spec[0] === 'enum' || spec[0] === 'choice' || spec[0] === 'strats') out[`${prefix}${k}`] = spec[1].slice();
    }
  };
  for (const [section, schema] of Object.entries(SCHEMA)) walk(schema, `${section}.`);
  walk(TOP_SCHEMA, '');
  return out;
}

function options(user, opts) {
  return { ...OPTIONS, locked: lockedKeys(user, opts), intervals: INTERVALS.slice(), choices: choices() };
}

function directionBlock(cfg, interval, rawJson) {
  const out = {};
  for (const name of tradeCfg.FIELD_NAMES) if (!DIR_EXCLUDED.has(name)) out[name] = cfg[name];
  out.interval = Number(interval);
  out.overrides = tradeCfg.overrideKeys(rawJson);
  return out;
}

const disabledDays = (user) => String(user.autotrade_disabled_days || '').split(',')
  .filter((d) => /^\d+$/.test(d.trim())).map((d) => parseInt(d, 10)).sort((a, b) => a - b);

/** `_settings_all(user)` + the D9 blocks. */
function settingsAll(user) {
  const cfg = tradeCfg.sharedCfg(user);
  const smc = smcUserCfg.getSmcCfg(user);
  const vcfg = volumeUserCfg.loadUserCfg(user.user_id);
  const g = (k, d = null) => (Object.prototype.hasOwnProperty.call(user, k) ? user[k] : d);
  const [qs, qe] = quietHours.window(user);
  const longCfg = tradeCfg.getLongCfg(user);
  const shortCfg = tradeCfg.getShortCfg(user);
  const shared = {
    timeframe: g('timeframe', '1h') || '1h', scan_interval: Number(cfg.scan_interval),
    pivot_strength: Number(cfg.pivot_strength), max_level_age: Number(cfg.max_level_age),
    max_retest_bars: Number(cfg.max_retest_bars), zone_buffer: Number(cfg.zone_buffer),
    max_level_tests: Number(cfg.max_level_tests), ema_fast: Number(cfg.ema_fast),
    ema_slow: Number(cfg.ema_slow), htf_ema_period: Number(cfg.htf_ema_period),
    use_pattern: Boolean(cfg.use_pattern), rsi_period: Number(cfg.rsi_period),
    rsi_ob: Number(cfg.rsi_ob), rsi_os: Number(cfg.rsi_os), vol_mult: Number(cfg.vol_mult),
    cooldown_bars: Number(cfg.cooldown_bars), atr_period: Number(cfg.atr_period),
    atr_mult: Number(cfg.atr_mult), tp1_rr: Number(cfg.tp1_rr), tp2_rr: Number(cfg.tp2_rr),
    tp3_rr: Number(cfg.tp3_rr), high_wr_mode: Boolean(g('high_wr_mode', false)),
    levels_counter_trend_min_quality: Math.trunc(Number(g('levels_counter_trend_min_quality', 4))),   // 0 = "any" is a valid value
  };
  return {
    lang: g('lang') === 'en' ? 'en' : 'ru',
    ui_mode: g('ui_mode') === 'expert' ? 'expert' : 'simple',
    levels: {
      long_tf: g('long_tf', '1h') || '1h', short_tf: g('short_tf', '1h') || '1h',
      min_quality: Number(cfg.min_quality), min_volume_usdt: Number(cfg.min_volume_usdt),
      min_rr: Number(cfg.min_rr), max_dist_pct: Number(cfg.max_dist_pct),
      zone_pct: Number(cfg.zone_pct), use_rsi: Boolean(cfg.use_rsi),
      use_volume: Boolean(cfg.use_volume), use_htf: Boolean(cfg.use_htf),
      trend_only: Boolean(cfg.trend_only), max_risk_pct: Number(cfg.max_risk_pct),
      shared,
      long: directionBlock(longCfg, g('long_interval', 3600), g('long_cfg', '{}')),
      short: directionBlock(shortCfg, g('short_interval', 3600), g('short_cfg', '{}')),
    },
    smc: {
      tf_key: TF_SMC.includes(smc.tf_key) ? smc.tf_key : '1H',
      direction: ['BOTH', 'LONG', 'SHORT'].includes(smc.direction) ? smc.direction : 'BOTH',
      min_volume_usdt: Number(smc.min_volume_usdt),
      max_sl_pct: Number(g('smc_max_sl_pct', 5.0) || 0.0),
      scan_interval: Math.trunc(Number(smc.scan_interval)),
      advanced: {
        min_confirmations: Number(smc.min_confirmations), min_rr: Number(smc.min_rr),
        sl_buffer_pct: Number(smc.sl_buffer_pct), fvg_enabled: Boolean(smc.fvg_enabled),
        choch_enabled: Boolean(smc.choch_enabled), ob_use_breaker: Boolean(smc.ob_use_breaker),
        sweep_close_req: Boolean(smc.sweep_close_req), ob_max_age: Number(smc.ob_max_age),
        smc_conf_type: smc.smc_conf_type === 'WICK_TOUCH' ? 'WICK_TOUCH' : 'BODY_CLOSE',
        smc_pd_filter: Boolean(smc.smc_pd_filter), smc_retrace_depth: Number(smc.smc_retrace_depth),
        smc_mtf_check: Boolean(smc.smc_mtf_check), smc_use_volume_filter: Boolean(smc.smc_use_volume_filter),
        smc_vol_mult: Number(smc.smc_vol_mult),
        smc_counter_trend_min_quality: Math.trunc(Number(g('smc_counter_trend_min_quality', 4))),
      },
    },
    volume: {
      timeframe: volumeUserCfg.userTf(user),
      setup_cross: Boolean(vcfg.setup_cross), setup_turn: Boolean(vcfg.setup_turn),
      setup_bounce: Boolean(vcfg.setup_bounce), setup_golden: Boolean(vcfg.setup_golden),
      setup_ribbon: Boolean(vcfg.setup_ribbon === undefined ? true : vcfg.setup_ribbon),
      ma_type: vcfg.ma_type, vol_mult: Number(vcfg.vol_mult),
      use_htf: Boolean(vcfg.use_htf), min_quality: Math.trunc(Number(vcfg.min_quality)),
    },
    trading: {
      auto_trade: Boolean(g('auto_trade', false)),
      auto_trade_mode: g('auto_trade_mode') === 'auto' ? 'auto' : 'confirm',
      trade_exchange: EXCHANGES.includes(g('trade_exchange')) ? g('trade_exchange') : 'bybit',
      trade_risk_pct: Number(g('trade_risk_pct', 1.0) || 0.0),
      trade_leverage: Math.trunc(Number(g('trade_leverage', 10) || 1)),
      max_trades_limit: Math.trunc(Number(g('max_trades_limit', 5) || 1)),
      risk_mode: g('risk_mode') === 'notional' ? 'notional' : 'risk',
      partial_tp_enabled: Boolean(g('partial_tp_enabled', true)),
      auto_trailing_enabled: Boolean(g('auto_trailing_enabled', true)),
      prefer_market_entry: Boolean(g('prefer_market_entry', false)),
      bybit_demo: Boolean(g('bybit_demo', false)),
      disabled_days: disabledDays(user),
      fixed_amount: Number(g('fixed_amount', 0.0) || 0.0),
      vol_filter_mode: ['usdt', 'count', 'both', 'off'].includes(g('vol_filter_mode')) ? g('vol_filter_mode') : 'usdt',
      max_coins_count: Math.trunc(Number(g('max_coins_count', 50) || 50)),
      at_stats_period: Math.trunc(Number(g('at_stats_period', 1) || 1)),
      optimizer_enabled: Boolean(g('optimizer_enabled', false)),
      optimizer_strategies: String(g('optimizer_strategies', 'LEVELS') || 'LEVELS'),     // kb_optimizer
    },
    ptp: {
      ptp_mode: g('ptp_mode') === 'PCT' ? 'PCT' : 'R',
      partial_tp1_r: Number(g('partial_tp1_r', 1.0)), partial_tp2_r: Number(g('partial_tp2_r', 1.5)),
      partial_tp1_pct: Number(g('partial_tp1_pct', 50.0)), partial_tp2_pct: Number(g('partial_tp2_pct', 40.0)),
      ptp_profit_pct1: Number(g('ptp_profit_pct1', 30.0)), ptp_profit_pct2: Number(g('ptp_profit_pct2', 50.0)),
    },
    risk: {
      sl_streak_enabled: Boolean(g('sl_streak_enabled', true)),
      sl_streak_threshold: Math.trunc(Number(g('sl_streak_threshold', 3) || 3)),
      circuit_breaker_enabled: Boolean(g('circuit_breaker_enabled', false)),
      circuit_breaker_threshold_r: Number(g('circuit_breaker_threshold_r', 0.0) || 0.0),
      allow_counter_trend: Boolean(g('allow_counter_trend', false)),
      filters_all_off: Boolean(g('filters_all_off', false)),
      btc_correlation_block: Boolean(g('btc_correlation_block', false)),
      spread_check_enabled: Boolean(g('spread_check_enabled', true)),
      trade_trending_only: Boolean(g('trade_trending_only', false)),
      hour_filter_enabled: Boolean(g('hour_filter_enabled', true)),
      advanced: {
        spread_max_pct: Number(g('spread_max_pct', 0.3) || 0.3),
        allow_low_notional_boost: Boolean(g('allow_low_notional_boost', false)),
        show_risk_preview: Boolean(g('show_risk_preview', true)),
        correlation_cap_enabled: Boolean(g('correlation_cap_enabled', false)),
        correlation_cap_threshold: Number(g('correlation_cap_threshold', 0.7) || 0.7),
        adaptive_sizing_enabled: Boolean(g('adaptive_sizing_enabled', false)),
        adaptive_sizing_mode: ['all', 'kelly', 'vol', 'dd', 'off'].includes(g('adaptive_sizing_mode')) ? g('adaptive_sizing_mode') : 'all',
        tilt_detector_enabled: Boolean(g('tilt_detector_enabled', true)),
        hold_lock_enabled: Boolean(g('hold_lock_enabled', false)),
        hold_lock_min_rr: Number(g('hold_lock_min_rr', 0.5) || 0.5),
        min_signal_quality: Math.trunc(Number(g('min_signal_quality', 3) || 3)),
      },
    },
    exchanges: exchangesState(user.user_id),
    notifications: {
      progress_notify_enabled: Boolean(g('progress_notify_enabled', true)),
      send_chart_enabled: Boolean(g('send_chart_enabled', true)),
      signal_format: g('signal_format') === 'lite' ? 'lite' : 'full',
      quiet_start: qs, quiet_end: qe,
      notify_signal: Boolean(g('notify_signal', true)),
      notify_breakout: Boolean(g('notify_breakout', false)),
    },
    genome_auto_apply: Boolean(g('genome_auto_apply', false)),
  };
}

/** `_update_shared(user, field, value)` (handlers._common._update_shared_field with the setattr fallback). */
function updateShared(user, field, value) {
  tradeCfg.updateSharedField(user, field, value);
}

const err = (error, extra) => ({ ok: false, error, ...(extra || {}) });

/**
 * `h_settings_all_post` steps 1–7 on an already-validated body. Returns the
 * Mini App response object ({ok:false,…} business errors included, nothing
 * saved on failure). `opts.admin` resolves the plan bypass.
 */
function applySettings(user, body, opts = {}) {
  let parsed;
  try {
    parsed = validateSections(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  } catch (e) {
    if (e instanceof BadRequest) return err('bad_request', { message: e.key });
    throw e;
  }
  const { changes, top } = parsed;
  if (!Object.keys(changes).length && !Object.keys(top).length) return err('bad_request', { message: 'empty' });

  // ── plan gates (nothing saved) ──
  if (changes.smc && !ts.can(user, 'smc', opts)) return err('pro_required');
  if (changes.volume && !ts.can(user, 'volume', opts)) return err('pro_required');
  const tr = changes.trading || {};
  if (Object.keys(tr).some((k) => !TRADING_FREE_KEYS.has(k)) && !ts.can(user, 'auto_trade', opts)) return err('pro_required');
  if (top.genome_auto_apply && !ts.can(user, 'genome', opts)) return err('pro_required');
  if (top.ui_mode === 'expert' && !ts.can(user, 'expert_mode', opts)) return err('pro_required');
  if (!ts.can(user, 'all_timeframes', opts)) {
    const allowedTf = pf.PLAN_FEATURES[pf.normalizePlan(user.sub_plan || 'free')].timeframes;
    const lv = changes.levels || {};
    for (const v of [lv.long_tf, lv.short_tf, lv.shared && lv.shared.timeframe]) {
      if (v !== undefined && v !== null && !allowedTf.includes(v)) return err('pro_required');
    }
  }

  // ── business checks before writing ──
  if (tr.auto_trade) {
    const ex = tr.trade_exchange || user.trade_exchange || 'bybit';
    const [key, secret, pp] = exchangeKeys(user.user_id, ex);
    if (!key || !secret || (ex === 'okx' && !pp)) {
      return err('bad_request', { message: `trading.auto_trade: no API keys for ${ex}` });
    }
  }
  const vol = changes.volume || {};
  const volCfgChanges = Object.fromEntries(Object.entries(vol).filter(([k]) => k !== 'timeframe'));
  let vcfgDict = null;
  if (Object.keys(volCfgChanges).length) {
    vcfgDict = { ...volumeCfg.impl().toDict(volumeUserCfg.loadUserCfg(user.user_id)), ...volCfgChanges };
    if (!volumeCfg.SETUP_KEYS.some((k) => vcfgDict[`setup_${k}`])) return err('bad_request', { message: 'volume.setup_*' });
  }

  // ── apply ──
  const lv = changes.levels || {};
  for (const [k, v] of Object.entries(lv)) {
    if (k === 'shared' || k === 'long' || k === 'short') continue;
    if (k === 'long_tf' || k === 'short_tf') user[k] = v;
    else updateShared(user, k, v);
  }
  for (const [k, v] of Object.entries(lv.shared || {})) updateShared(user, k, v);   // flat columns, long/short JSON untouched
  for (const dir of ['long', 'short']) {
    const part = lv[dir];
    if (!part) continue;
    const update = dir === 'long' ? tradeCfg.updateLongField : tradeCfg.updateShortField;
    if (part.reset) user[`${dir}_cfg`] = '{}';                       // reset_long_cfg / reset_short_cfg
    for (const [k, v] of Object.entries(part)) {
      if (k === 'reset') continue;
      if (k === 'interval') user[`${dir}_interval`] = v;             // set_long_interval_ / set_short_interval_
      else update(user, k, v);
    }
  }
  const smc = changes.smc || {};
  if (Object.keys(smc).length) {
    const cfg = smcUserCfg.getSmcCfg(user);
    for (const [k, v] of Object.entries(smc)) {
      if (k === 'advanced') continue;
      if (k === 'max_sl_pct') user.smc_max_sl_pct = v;
      else cfg[k] = v;
    }
    for (const [k, v] of Object.entries(smc.advanced || {})) {
      if (k === 'smc_counter_trend_min_quality') user.smc_counter_trend_min_quality = v;
      else cfg[k] = v;
    }
    smcUserCfg.setSmcCfg(user, cfg);
    if (Object.prototype.hasOwnProperty.call(smc, 'direction')) {        // like smc_set_dir: the scanner reads the flags
      const d = smc.direction;
      user.smc_long_active = d === 'LONG' || d === 'BOTH';
      user.smc_short_active = d === 'SHORT' || d === 'BOTH';
    }
  }
  if (Object.prototype.hasOwnProperty.call(vol, 'timeframe')) user.vol_timeframe = vol.timeframe;
  for (const [k, v] of Object.entries(tr)) {
    if (k === 'disabled_days') user.autotrade_disabled_days = v.join(',');
    else user[k] = v;
  }
  for (const [k, v] of Object.entries(changes.ptp || {})) user[k] = v;
  const risk = { ...(changes.risk || {}) };
  const riskAdv = risk.advanced || {};
  delete risk.advanced;
  if (Object.prototype.hasOwnProperty.call(risk, 'circuit_breaker_threshold_r') && risk.circuit_breaker_threshold_r > 0
      && !Object.prototype.hasOwnProperty.call(risk, 'circuit_breaker_enabled')) {
    risk.circuit_breaker_enabled = true;                                  // like set_cb_threshold
  }
  for (const [k, v] of Object.entries(risk)) user[k] = v;
  if (risk.circuit_breaker_enabled && Number(user.circuit_breaker_threshold_r || 0) <= 0) {
    user.circuit_breaker_threshold_r = 5.0;                               // like toggle_circuit_breaker
  }
  for (const [k, v] of Object.entries(riskAdv)) {
    if (k === 'reset_all_filters') {
      if (v) {                                                            // reset_all_filters
        user.filters_all_off = true;
        user.allow_counter_trend = true;
        user.btc_correlation_block = false;
        user.autotrade_disabled_days = '';
      }
    } else if (k === 'spread_max_pct') {
      user.spread_max_pct = v;
      user.spread_check_enabled = true;                                   // like set_spread_max
    } else {
      user[k] = v;
    }
  }
  const notif = { ...(changes.notifications || {}) };
  if (Object.prototype.hasOwnProperty.call(notif, 'quiet_start') || Object.prototype.hasOwnProperty.call(notif, 'quiet_end')) {
    const hasStart = Object.prototype.hasOwnProperty.call(notif, 'quiet_start');
    const qs = hasStart ? notif.quiet_start : user.quiet_start;
    const qe = Object.prototype.hasOwnProperty.call(notif, 'quiet_end') ? notif.quiet_end : (hasStart ? -1 : user.quiet_end);
    delete notif.quiet_start;
    delete notif.quiet_end;
    [user.quiet_start, user.quiet_end] = quietHours.normalize(qs, qe);    // QUIRK: only quiet_start → end = (start+9) % 24
  }
  for (const [k, v] of Object.entries(notif)) user[k] = v;
  for (const [k, v] of Object.entries(top)) user[k] = v;
  if (vcfgDict !== null) volumeUserCfg.saveUserCfg(user.user_id, vcfgDict);
  ts.save(user);

  // ── side effects as in the bot ──
  // HOOK(M13): `bybit_demo` in the payload with a Bybit key → invalidate the
  // cached Bybit session; `auto_trade` on → auto_trade.reset_auth_failures.
  const sideEffects = [];
  if (Object.prototype.hasOwnProperty.call(tr, 'bybit_demo') && exchangeKeys(user.user_id, 'bybit')[0]) sideEffects.push('invalidate_bybit_session');
  if (tr.auto_trade) sideEffects.push(`reset_auth_failures:${user.trade_exchange || 'bybit'}`);

  const summary = {};
  for (const [s, v] of Object.entries(changes)) summary[s] = Object.keys(v).sort();
  if (Object.keys(top).length) summary.top = Object.keys(top).sort();
  logger.info(`[MINIAPP] settings/all uid=${user.user_id} ${JSON.stringify(summary)}`);
  return { ok: true, settings: settingsAll(user), _side_effects: sideEffects };
}

module.exports = {
  TF_LEVELS, TF_SMC, TF_VOLUME, EXCHANGES, INTERVALS, OPTIONS, LEVELS_CHOICES, SCHEMA, TOP_SCHEMA,
  TRADING_FREE_KEYS, BadRequest,
  coerce, validateSections, keyHint, exchangeKeys, exchangesState, lockedKeys, choices, options,
  settingsAll, applySettings,
};
