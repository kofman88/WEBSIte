/**
 * Engine schema — the bot's tables under the site's names (PLAN §2.1).
 *
 *   trader_settings   ← bot `users` minus identity / API keys / dead columns
 *   signal_trades     ← bot `trades` (verbatim, 55 columns, 11 indexes)
 *   engine_kv         ← bot `kv`
 *   trade_events      ← bot `trade_events`
 *   plan_changes      ← bot `plan_changes`
 *   genome_population / genome_history / optimizer_params ← verbatim
 *
 * This module only *describes* the schema (column lists + DDL strings).
 * models/migrations.js applies it (v10 engine_core, v11 genome, v12
 * retire_bots); services/engine/README.md documents the mapping; tests pin
 * every column default against data-and-market.md §1.2 / §1.3.
 *
 * Column defaults of trader_settings are the bot's *dataclass* defaults
 * (UserSettings in user_manager.py) — "what new users actually get" — not
 * the bot's CREATE TABLE defaults where the two differ (scan_interval 300,
 * min_volume_usdt 300000, partial_tp_enabled 1, partial_tp1_pct 50,
 * partial_tp2_pct 40, sub_status 'expired', trial_used 1, ui_mode 'simple').
 */

'use strict';

// ── trader_settings ───────────────────────────────────────────────────
// [column, SQL type, SQL default literal, note]
// Order follows data-and-market.md §1.2 (CREATE TABLE, then the ALTER list).
const TRADER_SETTINGS_COLUMNS = Object.freeze([
  ['active',                'INTEGER', '0',        'legacy "scanner on" flag; any_active(), db_get_active_users'],
  ['sub_status',            'TEXT',    "'expired'", "mirror of subscriptions (planService): trial/active/expired/banned"],
  ['sub_expires',           'REAL',    '0',        'mirror: unix seconds when paid access ends'],
  ['trial_started',         'REAL',    '0',        'unused (no trial)'],
  ['trial_used',            'INTEGER', '1',        'always 1 (trial disabled)'],
  ['timeframe',             'TEXT',    "'1h'",     'shared LEVELS TF (legacy scan_mode=both job)'],
  ['scan_interval',         'INTEGER', '300',      'shared LEVELS scan interval (s)'],
  ['pivot_strength',        'INTEGER', '7',        'LEVELS shared cfg (TradeCfg)'],
  ['max_level_age',         'INTEGER', '100',      ''],
  ['max_retest_bars',       'INTEGER', '30',       ''],
  ['zone_buffer',           'REAL',    '0.3',      ''],
  ['ema_fast',              'INTEGER', '50',       ''],
  ['ema_slow',              'INTEGER', '200',      ''],
  ['htf_ema_period',        'INTEGER', '50',       ''],
  ['rsi_period',            'INTEGER', '14',       ''],
  ['rsi_ob',                'INTEGER', '65',       ''],
  ['rsi_os',                'INTEGER', '35',       ''],
  ['vol_mult',              'REAL',    '1.0',      ''],
  ['vol_len',               'INTEGER', '20',       'no UI'],
  ['use_rsi',               'INTEGER', '1',        ''],
  ['use_volume',            'INTEGER', '1',        ''],
  ['use_pattern',           'INTEGER', '0',        ''],
  ['use_htf',               'INTEGER', '0',        ''],
  ['atr_period',            'INTEGER', '14',       ''],
  ['atr_mult',              'REAL',    '1.0',      ''],
  ['max_risk_pct',          'REAL',    '1.5',      'also the hard cap for auto-trade risk'],
  ['tp1_rr',                'REAL',    '2.0',      ''],
  ['tp2_rr',                'REAL',    '3.0',      ''],
  ['tp3_rr',                'REAL',    '4.5',      ''],
  ['zone_pct',              'REAL',    '0.7',      ''],
  ['max_dist_pct',          'REAL',    '1.5',      ''],
  ['min_rr',                'REAL',    '2.0',      ''],
  ['max_level_tests',       'INTEGER', '4',        ''],
  ['min_volume_usdt',       'REAL',    '300000',   'per-user min 24h volume (LEVELS + VOLUME universes); dataclass 300_000, DB default was 1M'],
  ['min_quality',           'INTEGER', '3',        'LEVELS min quality (0..10)'],
  ['cooldown_bars',         'INTEGER', '5',        ''],
  ['notify_signal',         'INTEGER', '1',        'legacy toggle'],
  ['notify_breakout',       'INTEGER', '0',        'legacy toggle'],
  ['scan_mode',             'TEXT',    "'both'",   'legacy; both + active=1 creates a BOTH job'],
  ['long_tf',               'TEXT',    "'1h'",     'LEVELS LONG job TF'],
  ['long_interval',         'INTEGER', '3600',     ''],
  ['short_tf',              'TEXT',    "'1h'",     'LEVELS SHORT job TF'],
  ['short_interval',        'INTEGER', '3600',     ''],
  ['long_active',           'INTEGER', '0',        'LEVELS LONG scanner on'],
  ['short_active',          'INTEGER', '0',        'LEVELS SHORT scanner on'],
  ['smc_long_active',       'INTEGER', '0',        ''],
  ['smc_short_active',      'INTEGER', '0',        ''],
  ['vol_long_active',       'INTEGER', '0',        ''],
  ['vol_short_active',      'INTEGER', '0',        ''],
  ['vol_timeframe',         'TEXT',    "'1h'",     'VOLUME TF: 15m / 1h / 4h'],
  ['long_cfg',              'TEXT',    "'{}'",     'sparse JSON override for LONG (§2.3)'],
  ['short_cfg',             'TEXT',    "'{}'",     'sparse JSON override for SHORT'],
  ['smc_cfg',               'TEXT',    "'{}'",     'JSON of SMCUserCfg (§2.5)'],
  ['trend_only',            'INTEGER', '0',        ''],
  ['signals_received',      'INTEGER', '0',        'bumped by LEVELS scanner on delivery'],
  ['trial_reminder_sent',   'INTEGER', '0',        'legacy, unused'],
  ['expired_notified',      'INTEGER', '0',        '"subscription expired" message already sent'],
  ['created_at',            'REAL',    '0',        'unix seconds; never updated on conflict'],
  ['updated_at',            'REAL',    '0',        'unix seconds; set on every save'],
  ['strategy',              'TEXT',    "'LEVELS'", 'primary strategy LEVELS / SMC / VOLUME'],
  ['auto_trade',            'INTEGER', '0',        'auto-trade master switch'],
  ['auto_trade_mode',       'TEXT',    "'confirm'", 'auto / confirm'],
  ['trade_risk_pct',        'REAL',    '1.0',      '% of balance risked per trade'],
  ['trade_leverage',        'INTEGER', '10',       ''],
  ['max_trades_limit',      'INTEGER', '5',        '0 = unlimited'],
  ['trade_exchange',        'TEXT',    "'bybit'",  'bybit / bingx / binance / okx → selects exchange_keys row'],
  ['bybit_demo',            'INTEGER', '0',        'use api-demo.bybit.com'],
  ['at_stats_period',       'INTEGER', '1',        'stats period 1/7/30 days'],
  ['lang',                  'TEXT',    "'ru'",     'ru / en'],
  ['onboarding_done',       'INTEGER', '0',        ''],
  ['optimizer_enabled',     'INTEGER', '0',        ''],
  ['optimizer_strategies',  'TEXT',    "'LEVELS'", 'CSV'],
  ['fixed_amount',          'REAL',    '0.0',      'fixed $ per trade (0 = use risk %)'],
  ['autotrade_disabled_days', 'TEXT',  "''",       'CSV of weekday numbers 0..6'],
  ['genome_auto_apply',     'INTEGER', '0',        ''],
  ['vol_filter_mode',       'TEXT',    "'usdt'",   'usdt / count / both / off'],
  ['max_coins_count',       'INTEGER', '50',       ''],
  ['reminder_3d_sent',      'INTEGER', '0',        ''],
  ['reminder_1d_sent',      'INTEGER', '0',        ''],
  ['reminder_7d_after_sent', 'INTEGER', '0',       ''],
  ['reminder_14d_after_sent', 'INTEGER', '0',      ''],
  ['reminder_30d_after_sent', 'INTEGER', '0',      ''],
  ['last_reminder_at',      'REAL',    '0',        ''],
  ['reminders_optout',      'INTEGER', '0',        ''],
  ['btc_correlation_block', 'INTEGER', '0',        ''],
  ['partial_tp_enabled',    'INTEGER', '1',        'dataclass True (DB default was 0)'],
  ['partial_tp1_r',         'REAL',    '1.0',      ''],
  ['partial_tp1_pct',       'REAL',    '50.0',     'dataclass 50 (DB default was 40)'],
  ['partial_tp2_r',         'REAL',    '1.5',      ''],
  ['partial_tp2_pct',       'REAL',    '40.0',     'dataclass 40 (DB default was 30)'],
  ['risk_mode',             'TEXT',    "'risk'",   'risk / notional'],
  ['sub_plan',              'TEXT',    "'free'",   'mirror: free / pro (normalize_plan)'],
  ['high_wr_mode',          'INTEGER', '0',        ''],
  ['prop_mode',             'INTEGER', '0',        ''],
  ['prop_firm',             'TEXT',    "''",       ''],
  ['prop_capital',          'REAL',    '100000',   ''],
  ['prop_base_risk',        'REAL',    '1.0',      ''],
  ['prop_target',           'REAL',    '8.0',      ''],
  ['prop_max_dd',           'REAL',    '5.0',      ''],
  ['prop_daily_limit',      'REAL',    '4.0',      ''],
  ['prop_min_days',         'INTEGER', '1',        ''],
  ['prop_max_days',         'INTEGER', '30',       ''],
  ['prop_trailing_dd',      'INTEGER', '0',        ''],
  ['prop_consistency',      'INTEGER', '0',        ''],
  ['prop_start_balance',    'REAL',    '0',        ''],
  ['prop_start_date',       'REAL',    '0',        ''],
  ['prop_day_start_balance', 'REAL',   '0',        ''],
  ['prop_peak_balance',     'REAL',    '0',        'atomic UPDATE ... WHERE ? > COALESCE(prop_peak_balance,0)'],
  ['prop_trading_days',     'INTEGER', '0',        ''],
  ['prop_last_trade_day',   'INTEGER', '0',        'UTC ordinal day'],
  ['prop_unlocked',         'INTEGER', '0',        ''],
  ['allow_counter_trend',   'INTEGER', '0',        ''],
  ['filters_all_off',       'INTEGER', '0',        'kill-switch for signal filters'],
  ['sl_streak_enabled',     'INTEGER', '1',        ''],
  ['sl_streak_threshold',   'INTEGER', '3',        ''],
  ['circuit_breaker_enabled', 'INTEGER', '0',      ''],
  ['circuit_breaker_threshold_r', 'REAL', '0.0',   ''],
  ['allow_low_notional_boost', 'INTEGER', '0',     ''],
  ['prefer_market_entry',   'INTEGER', '0',        ''],
  ['show_risk_preview',     'INTEGER', '1',        ''],
  ['correlation_cap_enabled', 'INTEGER', '0',      ''],
  ['correlation_cap_threshold', 'REAL', '0.7',     '0.5..0.95'],
  ['adaptive_sizing_enabled', 'INTEGER', '0',      ''],
  ['adaptive_sizing_mode',  'TEXT',    "'all'",    'all / kelly / vol / dd'],
  ['tilt_detector_enabled', 'INTEGER', '1',        ''],
  ['hold_lock_enabled',     'INTEGER', '0',        ''],
  ['hold_lock_min_rr',      'REAL',    '0.5',      ''],
  ['hour_filter_enabled',   'INTEGER', '1',        ''],
  ['min_signal_quality',    'INTEGER', '3',        '3=B, 4=A, 5=A+'],
  ['trade_trending_only',   'INTEGER', '0',        ''],
  ['spread_check_enabled',  'INTEGER', '1',        ''],
  ['spread_max_pct',        'REAL',    '0.3',      ''],
  ['ptp_mode',              'TEXT',    "'R'",      'R / PCT'],
  ['ptp_profit_pct1',       'REAL',    '30.0',     ''],
  ['ptp_profit_pct2',       'REAL',    '50.0',     ''],
  ['free_signals_today',    'INTEGER', '0',        'legacy = morning+evening sum'],
  ['free_signals_date',     'TEXT',    "''",       'YYYY-MM-DD UTC'],
  ['free_missed_today',     'INTEGER', '0',        ''],
  ['free_smc_preview_today', 'INTEGER', '0',       ''],
  ['free_smc_preview_date', 'TEXT',    "''",       ''],
  ['smc_max_sl_pct',        'REAL',    '5.0',      '0 = off'],
  ['levels_counter_trend_min_quality', 'INTEGER', '4', '0..5 stars'],
  ['smc_counter_trend_min_quality', 'INTEGER', '4', '0..5'],
  ['ui_mode',               'TEXT',    "'simple'", 'dataclass simple (DB default was expert)'],
  ['free_signals_morning',  'INTEGER', '0',        ''],
  ['free_signals_evening',  'INTEGER', '0',        ''],
  ['free_signals_night',    'INTEGER', '0',        'always 0 now'],
  ['send_chart_enabled',    'INTEGER', '1',        ''],
  ['signal_format',         'TEXT',    "'full'",   'full / lite'],
  ['ai_filter_settings',    'TEXT',    "'{\"market_regime\": true, \"news_monitor\": true, \"genome_engine\": false}'", 'json.dumps of the dataclass default'],
  ['ai_filter_preset',      'TEXT',    "'balanced'", 'safe / balanced / aggressive / custom'],
  ['ai_show_confidence_score', 'INTEGER', '0',     ''],
  ['ai_adaptive_recommendations', 'INTEGER', '1',  ''],
  ['auto_trailing_enabled', 'INTEGER', '1',        ''],
  ['progress_notify_enabled', 'INTEGER', '1',      ''],
  ['quiet_start',           'INTEGER', '-1',       'quiet hours UTC, -1 = off'],
  ['quiet_end',             'INTEGER', '-1',       ''],
  ['extra_strategies',      'TEXT',    "''",       'CSV of additional strategies, e.g. SMC,VOLUME'],
]);

// Bot `users` columns deliberately NOT carried over (PLAN §2.1).
const TRADER_SETTINGS_EXCLUDED = Object.freeze({
  identity: ['username'],
  apiKeys: ['bybit_api_key', 'bybit_api_secret', 'bingx_api_key', 'bingx_api_secret',
    'binance_api_key', 'binance_api_secret', 'okx_api_key', 'okx_api_secret', 'okx_passphrase'],
  dead: ['watch_coin', 'min_position_usdt', 'math_levels_active', 'alert_liquidation',
    'alert_funding', 'alert_arbitrage', 'alert_whales', 'alert_regime', 'alert_swarm',
    'paper_trading', 'copy_public', 'copy_nickname', 'copy_bio', 'copy_followers',
    'news_alerts_enabled', 'news_alerts_filter', 'news_alerts_timing', 'welcome_bonus_pct',
    'last_applied_preset_name'],
});

function traderSettingsDDL() {
  const cols = TRADER_SETTINGS_COLUMNS
    .map(([name, type, dflt]) => `    ${name} ${type} NOT NULL DEFAULT ${dflt}`)
    .join(',\n');
  return `
  CREATE TABLE IF NOT EXISTS trader_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
${cols}
  );
  -- bot: idx_users_active / idx_users_tf / idx_users_subplan_status
  CREATE INDEX IF NOT EXISTS idx_trader_settings_active
    ON trader_settings(active, sub_status, sub_expires);
  CREATE INDEX IF NOT EXISTS idx_trader_settings_tf ON trader_settings(timeframe);
  CREATE INDEX IF NOT EXISTS idx_trader_settings_subplan_status
    ON trader_settings(sub_plan, sub_status, sub_expires);
  `;
}

// ── signal_trades (bot `trades`, verbatim) ────────────────────────────
// [column, type, default literal or null for NOT NULL-without-default]
const SIGNAL_TRADES_COLUMNS = Object.freeze([
  ['trade_id',           'TEXT',    null],        // PRIMARY KEY
  ['user_id',            'INTEGER', null],        // NOT NULL
  ['symbol',             'TEXT',    null],        // NOT NULL
  ['direction',          'TEXT',    null],        // NOT NULL
  ['entry',              'REAL',    null],        // NOT NULL
  ['sl',                 'REAL',    null],
  ['tp1',                'REAL',    null],
  ['tp2',                'REAL',    null],
  ['tp3',                'REAL',    null],
  ['tp1_rr',             'REAL',    '0.8'],
  ['tp2_rr',             'REAL',    '1.5'],
  ['tp3_rr',             'REAL',    '2.5'],
  ['quality',            'INTEGER', '1'],
  ['timeframe',          'TEXT',    "'1h'"],
  ['breakout_type',      'TEXT',    "''"],
  ['result',             'TEXT',    "''"],
  ['result_rr',          'REAL',    '0'],
  ['created_at',         'REAL',    '0'],
  ['trail_level',        'INTEGER', '0'],
  ['order_id',           'TEXT',    "''"],
  ['be_set',             'INTEGER', '0'],
  ['tp_placed',          'INTEGER', '0'],
  ['risk_pct',           'REAL',    '1.5'],
  ['pos_idx',            'INTEGER', '0'],
  ['leverage',           'INTEGER', '1'],
  ['strategy',           'TEXT',    "''"],        // schema.py default; ALTER on legacy DBs used 'LEVELS'
  ['copied_from',        'INTEGER', '0'],
  ['state',              'TEXT',    "'OPEN'"],
  ['state_changed_at',   'REAL',    '0'],
  ['placement_attempts', 'INTEGER', '0'],
  ['closed_pnl_usd',     'REAL',    'NULL'],
  ['qty',                'REAL',    '0'],
  ['original_sl',        'REAL',    'NULL'],
  ['order_link_id',      'TEXT',    "''"],
  ['signal_type',        'TEXT',    "''"],
  ['skip_reason',        'TEXT',    "''"],
  ['entry_lo',           'REAL',    '0'],
  ['entry_hi',           'REAL',    '0'],
  ['exchange',           'TEXT',    "'bybit'"],
  ['tp_retry_count',     'INTEGER', '0'],
  ['rsi',                'REAL',    '50.0'],
  ['volume_ratio',       'REAL',    '1.0'],
  ['is_counter_trend',   'INTEGER', '0'],
  ['mtf_aligned',        'INTEGER', '0'],
  ['trend_ctx',          'TEXT',    "''"],
  ['btc_corr',           'REAL',    '0.0'],
  ['session',            'TEXT',    "''"],
  ['preset_name',        'TEXT',    'NULL'],
  ['ai_filter_json',     'TEXT',    'NULL'],
  ['signal_msg_id',      'INTEGER', '0'],         // = notifications.id of the feed row (>0 = delivered)
  ['progress_stage',     'TEXT',    "''"],
  ['progress_ts',        'REAL',    '0'],
  ['signal_card_json',   'TEXT',    "''"],
  ['expire_rr',          'REAL',    'NULL'],
  ['user_note',          'TEXT',    "''"],
]);

// bot `_ALLOWED_TRADE_COLS` (db/trades.py) — insert/update whitelist.
const SIGNAL_TRADES_ALLOWED_COLS = Object.freeze([
  'trade_id', 'user_id', 'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3',
  'tp1_rr', 'tp2_rr', 'tp3_rr', 'quality', 'timeframe', 'breakout_type', 'result',
  'result_rr', 'created_at', 'trail_level', 'be_set', 'pos_idx', 'order_id', 'tp_placed',
  'entry_lo', 'entry_hi', 'exchange', 'strategy', 'rsi', 'volume_ratio', 'is_counter_trend',
  'btc_corr', 'session', 'mtf_aligned', 'trend_ctx', 'state', 'state_changed_at',
  'placement_attempts', 'order_link_id', 'original_sl', 'preset_name', 'signal_type',
  'skip_reason', 'qty', 'user_note',
]);

// [name, definition] — bot index names with the signal_trades prefix
// (SQLite index names are global; the legacy site `trades` table owns
// idx_trades_* until v12 drops it).
const SIGNAL_TRADES_INDEXES = Object.freeze([
  ['idx_signal_trades_user',            'signal_trades(user_id)'],
  ['idx_signal_trades_user_status',     'signal_trades(user_id, result)'],
  ['idx_signal_trades_user_created',    'signal_trades(user_id, created_at)'],
  ['idx_signal_trades_symbol',          'signal_trades(user_id, symbol, result)'],
  ['idx_signal_trades_user_open',       'signal_trades(user_id, result, created_at)'],
  ['idx_signal_trades_result_all',      'signal_trades(result, created_at)'],
  ['idx_signal_trades_result_created',  'signal_trades(result, created_at)'],
  ['idx_signal_trades_user_order',      'signal_trades(user_id, order_id)'],
  ['idx_signal_trades_open_orders',     "signal_trades(result, order_id) WHERE result=''"],
  ['idx_signal_trades_state',           'signal_trades(state, state_changed_at)'],
  ['idx_signal_trades_signal_progress', 'signal_trades(created_at) WHERE signal_msg_id > 0'],
]);

function signalTradesDDL() {
  const cols = SIGNAL_TRADES_COLUMNS.map(([name, type, dflt]) => {
    if (name === 'trade_id') return `    ${name} ${type} PRIMARY KEY`;
    if (dflt === null) return `    ${name} ${type} NOT NULL`;
    return `    ${name} ${type} DEFAULT ${dflt}`;
  }).join(',\n');
  const idx = SIGNAL_TRADES_INDEXES
    .map(([name, def]) => `  CREATE INDEX IF NOT EXISTS ${name} ON ${def};`)
    .join('\n');
  return `
  CREATE TABLE IF NOT EXISTS signal_trades (
${cols},
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
${idx}
  `;
}

// ── engine_kv / trade_events / plan_changes ───────────────────────────
const ENGINE_KV_DDL = `
  -- bot kv, verbatim namespace (volume_cfg_<uid>, challenge_<uid>, trend_state_v1,
  -- idemp_v1_*, zb_cooldown_*, analyze_count_<uid>_<day>, free_*, genome_*, …).
  -- Separate from system_kv so the bot's keys import 1:1.
  CREATE TABLE IF NOT EXISTS engine_kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
  );
`;

const TRADE_EVENTS_DDL = `
  -- [FORENSICS] append-only timeline per trade (bot trade_events, verbatim).
  CREATE TABLE IF NOT EXISTS trade_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id      TEXT    NOT NULL,
    ts            REAL    NOT NULL,
    event_type    TEXT    NOT NULL,
    payload_json  TEXT    DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_trade_events_trade_id ON trade_events(trade_id);
  CREATE INDEX IF NOT EXISTS idx_trade_events_ts ON trade_events(ts);
`;

const PLAN_CHANGES_DDL = `
  -- every sub_plan mutation (bot db/plan_audit.py, verbatim)
  CREATE TABLE IF NOT EXISTS plan_changes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    user_id   INTEGER NOT NULL,
    old_plan  TEXT    DEFAULT '',
    new_plan  TEXT    DEFAULT '',
    actor     TEXT    DEFAULT '',
    reason    TEXT    DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_plan_changes_ts ON plan_changes(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_plan_changes_uid ON plan_changes(user_id);
`;

// ── genome (v11) ──────────────────────────────────────────────────────
const GENOME_DDL = `
  -- Strategy Genome: current population (N genomes per strategy per TF)
  CREATE TABLE IF NOT EXISTS genome_population (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy      TEXT    NOT NULL,                -- 'LEVELS' | 'SMC' | 'VOLUME'
    timeframe     TEXT    NOT NULL DEFAULT '1h',
    generation    INTEGER NOT NULL,
    genome_json   TEXT    NOT NULL,
    fitness       REAL    DEFAULT 0,
    winrate       REAL    DEFAULT 0,
    profit_factor REAL    DEFAULT 0,
    trades        INTEGER DEFAULT 0,
    drawdown      REAL    DEFAULT 0,
    parent_a      INTEGER DEFAULT 0,
    parent_b      INTEGER DEFAULT 0,
    birth_type    TEXT    DEFAULT '',             -- random | elite | crossover | cross_strategy | bayesian_mut | mutation | random_inject
    created_at    REAL    DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_genome_strat_tf_gen ON genome_population(strategy, timeframe, generation);
  CREATE INDEX IF NOT EXISTS idx_genome_fitness ON genome_population(strategy, timeframe, fitness);

  -- Strategy Genome: history of generations
  CREATE TABLE IF NOT EXISTS genome_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy         TEXT    NOT NULL,
    timeframe        TEXT    NOT NULL DEFAULT '1h',
    generation       INTEGER NOT NULL,
    best_fitness     REAL    DEFAULT 0,
    avg_fitness      REAL    DEFAULT 0,
    best_wr          REAL    DEFAULT 0,
    best_pf          REAL    DEFAULT 0,
    best_genome_json TEXT    DEFAULT '',
    pop_size         INTEGER DEFAULT 0,
    created_at       REAL    DEFAULT 0,
    UNIQUE(strategy, timeframe, generation)
  );
  CREATE INDEX IF NOT EXISTS idx_genome_hist_strat ON genome_history(strategy, timeframe, generation);

  -- Adaptive optimizer / genome auto-apply parameters (per user, per strategy)
  CREATE TABLE IF NOT EXISTS optimizer_params (
    user_id    INTEGER NOT NULL,
    strategy   TEXT    NOT NULL DEFAULT 'LEVELS',
    params     TEXT    DEFAULT '{}',
    updated_at REAL    DEFAULT 0,
    PRIMARY KEY (user_id, strategy)
  );
`;

// ── trade_feedback (v14) ──────────────────────────────────────────────
// The bot's db/schema.py trade_feedback, verbatim: one row per (user, trade) written by every real
// result transition (db_set_trade_result → trade_feedback.record_feedback; services/engine/
// tradeFeedback.js). Read by the ML filter / adaptive optimizer of D11.
const TRADE_FEEDBACK_DDL = `
  CREATE TABLE IF NOT EXISTS trade_feedback (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    trade_id  TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    strategy  TEXT    NOT NULL DEFAULT 'LEVELS',
    direction TEXT    NOT NULL DEFAULT 'LONG',
    entry     REAL    NOT NULL DEFAULT 0,
    sl        REAL    NOT NULL DEFAULT 0,
    tp1       REAL    NOT NULL DEFAULT 0,
    result    TEXT    NOT NULL DEFAULT '',
    pnl_pct   REAL    DEFAULT 0,
    regime    TEXT    DEFAULT '',
    features  TEXT    DEFAULT '{}',
    ts        REAL    DEFAULT 0,
    UNIQUE(user_id, trade_id)
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_user_strat ON trade_feedback(user_id, strategy);
`;

// ── legacy site tables retired by v12 (PLAN §2.1) — children first ────
const LEGACY_TABLES = Object.freeze([
  'trade_fills',
  'signal_registry',
  'signal_views',
  'trades',
  'signals',
  'user_signal_prefs',
  'backtest_trades',
  'backtests',
  'optimizations',
  'copy_subscriptions',
  'strategy_earnings',
  'strategy_installs',
  'published_strategies',
  'wallet_transactions',
  'wallets',
  'trading_bots',
]);

// users columns of the retired paper book / public profile (PLAN §2.1)
const LEGACY_USER_COLUMNS = Object.freeze(['paper_starting_balance', 'public_profile']);

// The landing's public paper track archive (services/publicTrack/store.js; site only, the bot has no
// public endpoints): one row per track signal with its stage history and published state, plus the
// archive epoch and change counter of the feed cursor. Migration v13.
const PUBLIC_TRACK_DDL = `
  CREATE TABLE IF NOT EXISTS public_track (
    trade_id   TEXT PRIMARY KEY,
    pub_id     TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL,
    bot_id     TEXT NOT NULL,
    strategy   TEXT NOT NULL,
    pair       TEXT NOT NULL,
    side       TEXT NOT NULL,
    tf         TEXT NOT NULL,
    created_at REAL NOT NULL,
    stages     TEXT NOT NULL DEFAULT '[]',
    status     TEXT,
    path       TEXT,
    r          REAL,
    appear_seq INTEGER,
    seq        INTEGER,
    updated_at REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_track_seq ON public_track(seq);
  CREATE INDEX IF NOT EXISTS idx_public_track_created ON public_track(created_at);
  CREATE INDEX IF NOT EXISTS idx_public_track_user ON public_track(user_id, created_at);
  CREATE TABLE IF NOT EXISTS public_track_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

module.exports = {
  TRADER_SETTINGS_COLUMNS,
  TRADER_SETTINGS_EXCLUDED,
  traderSettingsDDL,
  SIGNAL_TRADES_COLUMNS,
  SIGNAL_TRADES_ALLOWED_COLS,
  SIGNAL_TRADES_INDEXES,
  signalTradesDDL,
  ENGINE_KV_DDL,
  TRADE_EVENTS_DDL,
  PLAN_CHANGES_DDL,
  GENOME_DDL,
  PUBLIC_TRACK_DDL,
  TRADE_FEEDBACK_DDL,
  LEGACY_TABLES,
  LEGACY_USER_COLUMNS,
};
