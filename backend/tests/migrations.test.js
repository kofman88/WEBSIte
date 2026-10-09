import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-migrations-fresh.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const FRESH_BACKUPS = path.join(process.cwd(), 'data', 'test-migrations-backups-fresh');
const LEGACY_BACKUPS = path.join(process.cwd(), 'data', 'test-migrations-backups-legacy');
const LEGACY_DB = path.join(process.cwd(), 'data', 'test-migrations-legacy.db');

function rmDb(p) { ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} }); }
function rmDir(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_e) {} }

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
const cols = (db, t) => db.prepare(`PRAGMA table_info('${t}')`).all();
const colNames = (db, t) => cols(db, t).map((c) => c.name);
const indexes = (db, t) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(t).map((r) => r.name);

const LEGACY_TABLES = [
  'trading_bots', 'trades', 'trade_fills', 'signals', 'signal_registry', 'signal_views',
  'user_signal_prefs', 'backtests', 'backtest_trades', 'optimizations', 'copy_subscriptions',
  'published_strategies', 'strategy_installs', 'strategy_earnings', 'wallets', 'wallet_transactions',
];
const ENGINE_TABLES = [
  'trader_settings', 'signal_trades', 'engine_kv', 'trade_events', 'plan_changes',
  'genome_population', 'genome_history', 'optimizer_params',
];

// data-and-market.md §1.2 — dataclass ("Code default") column, incl. every
// column where the bot's CREATE TABLE default differs from the dataclass.
const TRADER_SETTINGS_SPEC = {
  active: 0, sub_status: "'expired'", sub_expires: 0, trial_started: 0, trial_used: 1,
  timeframe: "'1h'", scan_interval: 300, pivot_strength: 7, max_level_age: 100, max_retest_bars: 30,
  zone_buffer: 0.3, ema_fast: 50, ema_slow: 200, htf_ema_period: 50, rsi_period: 14, rsi_ob: 65,
  rsi_os: 35, vol_mult: 1.0, vol_len: 20, use_rsi: 1, use_volume: 1, use_pattern: 0, use_htf: 0,
  atr_period: 14, atr_mult: 1.0, max_risk_pct: 1.5, tp1_rr: 2.0, tp2_rr: 3.0, tp3_rr: 4.5,
  zone_pct: 0.7, max_dist_pct: 1.5, min_rr: 2.0, max_level_tests: 4, min_volume_usdt: 300000,
  min_quality: 3, cooldown_bars: 5, notify_signal: 1, notify_breakout: 0, scan_mode: "'both'",
  long_tf: "'1h'", long_interval: 3600, short_tf: "'1h'", short_interval: 3600, long_active: 0,
  short_active: 0, smc_long_active: 0, smc_short_active: 0, vol_long_active: 0, vol_short_active: 0,
  vol_timeframe: "'1h'", long_cfg: "'{}'", short_cfg: "'{}'", smc_cfg: "'{}'", trend_only: 0,
  signals_received: 0, trial_reminder_sent: 0, expired_notified: 0, created_at: 0, updated_at: 0,
  strategy: "'LEVELS'", auto_trade: 0, auto_trade_mode: "'confirm'", trade_risk_pct: 1.0,
  trade_leverage: 10, max_trades_limit: 5, trade_exchange: "'bybit'", bybit_demo: 0, at_stats_period: 1,
  lang: "'ru'", onboarding_done: 0, optimizer_enabled: 0, optimizer_strategies: "'LEVELS'",
  fixed_amount: 0.0, autotrade_disabled_days: "''", genome_auto_apply: 0, vol_filter_mode: "'usdt'",
  max_coins_count: 50, reminder_3d_sent: 0, reminder_1d_sent: 0, reminder_7d_after_sent: 0,
  reminder_14d_after_sent: 0, reminder_30d_after_sent: 0, last_reminder_at: 0, reminders_optout: 0,
  btc_correlation_block: 0, partial_tp_enabled: 1, partial_tp1_r: 1.0, partial_tp1_pct: 50.0,
  partial_tp2_r: 1.5, partial_tp2_pct: 40.0, risk_mode: "'risk'", sub_plan: "'free'", high_wr_mode: 0,
  prop_mode: 0, prop_firm: "''", prop_capital: 100000, prop_base_risk: 1.0, prop_target: 8.0,
  prop_max_dd: 5.0, prop_daily_limit: 4.0, prop_min_days: 1, prop_max_days: 30, prop_trailing_dd: 0,
  prop_consistency: 0, prop_start_balance: 0, prop_start_date: 0, prop_day_start_balance: 0,
  prop_peak_balance: 0, prop_trading_days: 0, prop_last_trade_day: 0, prop_unlocked: 0,
  allow_counter_trend: 0, filters_all_off: 0, sl_streak_enabled: 1, sl_streak_threshold: 3,
  circuit_breaker_enabled: 0, circuit_breaker_threshold_r: 0.0, allow_low_notional_boost: 0,
  prefer_market_entry: 0, show_risk_preview: 1, correlation_cap_enabled: 0, correlation_cap_threshold: 0.7,
  adaptive_sizing_enabled: 0, adaptive_sizing_mode: "'all'", tilt_detector_enabled: 1, hold_lock_enabled: 0,
  hold_lock_min_rr: 0.5, hour_filter_enabled: 1, min_signal_quality: 3, trade_trending_only: 0,
  spread_check_enabled: 1, spread_max_pct: 0.3, ptp_mode: "'R'", ptp_profit_pct1: 30.0, ptp_profit_pct2: 50.0,
  free_signals_today: 0, free_signals_date: "''", free_missed_today: 0, free_smc_preview_today: 0,
  free_smc_preview_date: "''", smc_max_sl_pct: 5.0, levels_counter_trend_min_quality: 4,
  smc_counter_trend_min_quality: 4, ui_mode: "'simple'", free_signals_morning: 0, free_signals_evening: 0,
  free_signals_night: 0, send_chart_enabled: 1, signal_format: "'full'",
  ai_filter_settings: '\'{"market_regime": true, "news_monitor": true, "genome_engine": false}\'',
  ai_filter_preset: "'balanced'", ai_show_confidence_score: 0, ai_adaptive_recommendations: 1,
  auto_trailing_enabled: 1, progress_notify_enabled: 1, quiet_start: -1, quiet_end: -1, extra_strategies: "''",
};
const TRADER_SETTINGS_EXCLUDED = [
  'username', 'bybit_api_key', 'bybit_api_secret', 'bingx_api_key', 'bingx_api_secret',
  'binance_api_key', 'binance_api_secret', 'okx_api_key', 'okx_api_secret', 'okx_passphrase',
  'watch_coin', 'min_position_usdt', 'math_levels_active', 'alert_liquidation', 'alert_funding',
  'alert_arbitrage', 'alert_whales', 'alert_regime', 'alert_swarm', 'paper_trading', 'copy_public',
  'copy_nickname', 'copy_bio', 'copy_followers', 'news_alerts_enabled', 'news_alerts_filter',
  'news_alerts_timing', 'welcome_bonus_pct', 'last_applied_preset_name',
];

// data-and-market.md §1.3 — bot `trades` columns in order
const SIGNAL_TRADES_SPEC = [
  'trade_id', 'user_id', 'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3',
  'tp1_rr', 'tp2_rr', 'tp3_rr', 'quality', 'timeframe', 'breakout_type', 'result', 'result_rr',
  'created_at', 'trail_level', 'order_id', 'be_set', 'tp_placed', 'risk_pct', 'pos_idx', 'leverage',
  'strategy', 'copied_from', 'state', 'state_changed_at', 'placement_attempts', 'closed_pnl_usd', 'qty',
  'original_sl', 'order_link_id', 'signal_type', 'skip_reason', 'entry_lo', 'entry_hi', 'exchange',
  'tp_retry_count', 'rsi', 'volume_ratio', 'is_counter_trend', 'mtf_aligned', 'trend_ctx', 'btc_corr',
  'session', 'preset_name', 'ai_filter_json', 'signal_msg_id', 'progress_stage', 'progress_ts',
  'signal_card_json', 'expire_rr', 'user_note',
];
const SIGNAL_TRADES_INDEX_SPEC = [
  'idx_signal_trades_open_orders', 'idx_signal_trades_result_all', 'idx_signal_trades_result_created',
  'idx_signal_trades_signal_progress', 'idx_signal_trades_state', 'idx_signal_trades_symbol',
  'idx_signal_trades_user', 'idx_signal_trades_user_created', 'idx_signal_trades_user_open',
  'idx_signal_trades_user_order', 'idx_signal_trades_user_status',
];

// SQL default literal vs spec value: numbers compare numerically ('1.0' ≡ 1 —
// the exact literal is pinned against engineSchema below), strings verbatim.
const sameDefault = (actual, expected) => (typeof expected === 'number'
  ? /^-?\d/.test(String(actual)) && Number(actual) === expected
  : actual === expected);

let db, migrations, engineSchema;

beforeAll(async () => {
  rmDb(process.env.DATABASE_PATH);
  rmDir(FRESH_BACKUPS);
  rmDir(LEGACY_BACKUPS);
  process.env.LEGACY_BACKUP_DIR = FRESH_BACKUPS;
  db = (await import('../models/database.js')).default;
  migrations = await import('../models/migrations.js');
  engineSchema = await import('../models/engineSchema.js');
});

afterAll(() => {
  rmDir(FRESH_BACKUPS);
  rmDir(LEGACY_BACKUPS);
  rmDb(LEGACY_DB);
});

// ── (a) fresh DB ──────────────────────────────────────────────────────
describe('fresh DB → v13', () => {
  it('is at version 13, re-running is a no-op', () => {
    expect(migrations.currentVersion(db)).toBe(13);
    expect(migrations.MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(migrations.MIGRATIONS.slice(9).map((m) => m.name)).toEqual(['engine_core', 'genome', 'retire_bots', 'public_track']);
    expect(migrations.run(db)).toEqual({ ran: 0, current: 13 });
  });

  it('v13 creates the public track archive (services/publicTrack/store.js re-runs the same DDL as a no-op)', () => {
    const t = tables(db);
    expect(t).toContain('public_track');
    expect(t).toContain('public_track_meta');
    const cols = db.prepare("PRAGMA table_info('public_track')").all().map((c) => c.name);
    expect(cols).toEqual(['trade_id', 'pub_id', 'user_id', 'bot_id', 'strategy', 'pair', 'side', 'tf', 'created_at',
      'stages', 'status', 'path', 'r', 'appear_seq', 'seq', 'updated_at']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'public_track' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => r.name);
    expect(idx).toEqual(['idx_public_track_created', 'idx_public_track_seq', 'idx_public_track_user']);
    const { createStore } = createRequire(import.meta.url)('../services/publicTrack/store.js');
    const st = createStore(db);
    expect(st.seq()).toBe(0);
    expect(typeof st.epoch()).toBe('string');
  });

  it('creates the engine tables and no legacy table', () => {
    const t = tables(db);
    for (const name of ENGINE_TABLES) expect(t, name).toContain(name);
    for (const name of LEGACY_TABLES) expect(t, name).not.toContain(name);
    expect(t).toContain('users');
    expect(t).toContain('exchange_keys');
    expect(t).toContain('candles_cache');
  });

  it('nothing was exported on a fresh install', () => {
    expect(fs.existsSync(FRESH_BACKUPS)).toBe(false);
  });

  it('users lost paper_starting_balance / public_profile, kept everything else', () => {
    const c = colNames(db, 'users');
    expect(c).not.toContain('paper_starting_balance');
    expect(c).not.toContain('public_profile');
    for (const keep of ['id', 'email', 'tg_id', 'google_id', 'admin_role', 'notification_prefs', 'locale']) expect(c).toContain(keep);
  });

  it('trader_settings: PK user_id → users, every §1.2 column with the dataclass default, none of the excluded ones', () => {
    const info = cols(db, 'trader_settings');
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(byName.user_id.pk).toBe(1);
    const fk = db.prepare("PRAGMA foreign_key_list('trader_settings')").all();
    expect(fk.some((f) => f.table === 'users' && f.from === 'user_id' && f.on_delete === 'CASCADE')).toBe(true);

    for (const [name, expected] of Object.entries(TRADER_SETTINGS_SPEC)) {
      expect(byName[name], `missing column ${name}`).toBeTruthy();
      expect(sameDefault(byName[name].dflt_value, expected), `default of ${name}: ${byName[name].dflt_value} vs ${expected}`).toBe(true);
      expect(byName[name].notnull, `${name} NOT NULL`).toBe(1);
    }
    expect(info.length).toBe(Object.keys(TRADER_SETTINGS_SPEC).length + 1);   // + user_id
    for (const name of TRADER_SETTINGS_EXCLUDED) expect(byName[name], `excluded ${name}`).toBeUndefined();

    // engineSchema (the reference the README and M7 use) == what the DB has
    expect(engineSchema.TRADER_SETTINGS_COLUMNS.map((c) => c[0])).toEqual(info.slice(1).map((c) => c.name));
    for (const [name, , d] of engineSchema.TRADER_SETTINGS_COLUMNS) expect(byName[name].dflt_value).toBe(d);
    expect(indexes(db, 'trader_settings')).toEqual([
      'idx_trader_settings_active', 'idx_trader_settings_subplan_status', 'idx_trader_settings_tf',
    ]);
  });

  it('trader_settings: inserting only user_id yields the bot defaults', () => {
    const uid = db.prepare("INSERT INTO users (email, password_hash, referral_code) VALUES ('fresh@x.com', 'x', 'RFRESH')").run().lastInsertRowid;
    db.prepare('INSERT INTO trader_settings (user_id) VALUES (?)').run(uid);
    const r = db.prepare('SELECT * FROM trader_settings WHERE user_id = ?').get(uid);
    expect(r.sub_plan).toBe('free');
    expect(r.sub_status).toBe('expired');
    expect(r.trial_used).toBe(1);
    expect(r.scan_interval).toBe(300);
    expect(r.min_volume_usdt).toBe(300000);
    expect(r.partial_tp_enabled).toBe(1);
    expect(r.partial_tp1_pct).toBe(50);
    expect(r.partial_tp2_pct).toBe(40);
    expect(r.ui_mode).toBe('simple');
    expect(r.strategy).toBe('LEVELS');
    expect(r.trade_exchange).toBe('bybit');
    expect(r.quiet_start).toBe(-1);
    expect(JSON.parse(r.ai_filter_settings)).toEqual({ market_regime: true, news_monitor: true, genome_engine: false });
    expect(r.extra_strategies).toBe('');
    // FK cascade
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trader_settings WHERE user_id = ?').get(uid).n).toBe(0);
  });

  it('signal_trades: the 55 bot trades columns in order, NOT NULL core, defaults, 11 indexes', () => {
    const info = cols(db, 'signal_trades');
    expect(info.map((c) => c.name)).toEqual(SIGNAL_TRADES_SPEC);
    expect(engineSchema.SIGNAL_TRADES_COLUMNS.map((c) => c[0])).toEqual(SIGNAL_TRADES_SPEC);
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));
    expect(byName.trade_id.pk).toBe(1);
    for (const n of ['user_id', 'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3']) expect(byName[n].notnull, n).toBe(1);
    expect(byName.tp1_rr.dflt_value).toBe('0.8');
    expect(byName.tp2_rr.dflt_value).toBe('1.5');
    expect(byName.tp3_rr.dflt_value).toBe('2.5');
    expect(byName.quality.dflt_value).toBe('1');
    expect(byName.timeframe.dflt_value).toBe("'1h'");
    expect(byName.risk_pct.dflt_value).toBe('1.5');
    expect(byName.leverage.dflt_value).toBe('1');
    expect(byName.state.dflt_value).toBe("'OPEN'");
    expect(byName.exchange.dflt_value).toBe("'bybit'");
    expect(byName.rsi.dflt_value).toBe('50.0');
    expect(byName.volume_ratio.dflt_value).toBe('1.0');
    expect(byName.closed_pnl_usd.dflt_value).toBe('NULL');
    expect(byName.original_sl.dflt_value).toBe('NULL');
    expect(byName.expire_rr.dflt_value).toBe('NULL');
    expect(byName.signal_msg_id.dflt_value).toBe('0');
    expect(indexes(db, 'signal_trades')).toEqual(SIGNAL_TRADES_INDEX_SPEC);
    expect(engineSchema.SIGNAL_TRADES_ALLOWED_COLS).toHaveLength(44);
  });

  it('signal_trades: a minimal insert gets the bot defaults and the FK holds', () => {
    const uid = db.prepare("INSERT INTO users (email, password_hash, referral_code) VALUES ('st@x.com', 'x', 'RST')").run().lastInsertRowid;
    db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3)
                VALUES ('t1', ?, 'BTC-USDT-SWAP', 'LONG', 100, 99, 101, 102, 103)`).run(uid);
    const r = db.prepare("SELECT * FROM signal_trades WHERE trade_id = 't1'").get();
    expect(r.result).toBe('');
    expect(r.state).toBe('OPEN');
    expect(r.order_id).toBe('');
    expect(r.strategy).toBe('');
    expect(r.quality).toBe(1);
    expect(r.closed_pnl_usd).toBe(null);
    expect(r.signal_msg_id).toBe(0);
    expect(() => db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3)
                              VALUES ('t2', 999999, 'X', 'LONG', 1, 1, 1, 1, 1)`).run()).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_trades').get().n).toBe(0);
  });

  it('engine_kv / trade_events / plan_changes / genome tables match the bot DDL', () => {
    expect(colNames(db, 'engine_kv')).toEqual(['key', 'value', 'updated_at']);
    expect(colNames(db, 'trade_events')).toEqual(['id', 'trade_id', 'ts', 'event_type', 'payload_json']);
    expect(indexes(db, 'trade_events')).toEqual(['idx_trade_events_trade_id', 'idx_trade_events_ts']);
    expect(colNames(db, 'plan_changes')).toEqual(['id', 'ts', 'user_id', 'old_plan', 'new_plan', 'actor', 'reason']);
    expect(indexes(db, 'plan_changes')).toEqual(['idx_plan_changes_ts', 'idx_plan_changes_uid']);
    expect(colNames(db, 'genome_population')).toEqual(['id', 'strategy', 'timeframe', 'generation', 'genome_json',
      'fitness', 'winrate', 'profit_factor', 'trades', 'drawdown', 'parent_a', 'parent_b', 'birth_type', 'created_at']);
    expect(indexes(db, 'genome_population')).toEqual(['idx_genome_fitness', 'idx_genome_strat_tf_gen']);
    expect(colNames(db, 'genome_history')).toEqual(['id', 'strategy', 'timeframe', 'generation', 'best_fitness',
      'avg_fitness', 'best_wr', 'best_pf', 'best_genome_json', 'pop_size', 'created_at']);
    expect(indexes(db, 'genome_history')).toContain('idx_genome_hist_strat');
    // UNIQUE(strategy, timeframe, generation)
    db.prepare("INSERT INTO genome_history (strategy, timeframe, generation) VALUES ('SMC', '1h', 1)").run();
    expect(() => db.prepare("INSERT INTO genome_history (strategy, timeframe, generation) VALUES ('SMC', '1h', 1)").run()).toThrow(/UNIQUE/);
    expect(colNames(db, 'optimizer_params')).toEqual(['user_id', 'strategy', 'params', 'updated_at']);
    const op = cols(db, 'optimizer_params');
    expect(op.find((c) => c.name === 'strategy').dflt_value).toBe("'LEVELS'");
    expect(op.find((c) => c.name === 'params').dflt_value).toBe("'{}'");
    expect(op.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['user_id', 'strategy']);
    db.prepare("INSERT INTO engine_kv (key, value) VALUES ('volume_cfg_1', '{}')").run();
    expect(db.prepare("SELECT value FROM engine_kv WHERE key = 'volume_cfg_1'").get().value).toBe('{}');
  });
});

// ── (b) legacy DB seeded with the per-bot product ─────────────────────
function buildLegacyDb(file) {
  rmDb(file);
  const legacy = new Database(file);
  legacy.pragma('journal_mode = WAL');
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name TEXT, avatar_url TEXT, locale TEXT DEFAULT 'ru', timezone TEXT DEFAULT 'UTC',
      referral_code TEXT UNIQUE NOT NULL, referred_by INTEGER, email_verified INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, last_login_at DATETIME,
      telegram_chat_id TEXT, telegram_username TEXT, telegram_linked_at DATETIME,
      notification_prefs TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, google_id TEXT, tg_id TEXT,
      oauth_provider TEXT DEFAULT 'password', given_name TEXT, family_name TEXT, admin_role TEXT,
      public_profile INTEGER DEFAULT 0
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free', status TEXT NOT NULL DEFAULT 'active',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME, payment_method TEXT,
      payment_provider_id TEXT, auto_renew INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount_usd REAL NOT NULL,
      currency TEXT DEFAULT 'USD', method TEXT NOT NULL, provider_tx_id TEXT, plan TEXT,
      duration_days INTEGER, status TEXT NOT NULL, metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, confirmed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, plan TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30, discount_pct INTEGER DEFAULT 100, max_uses INTEGER DEFAULT 1,
      uses_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_by INTEGER, expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ref_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER NOT NULL, referred_id INTEGER NOT NULL,
      payment_id INTEGER, amount_usd REAL NOT NULL, status TEXT DEFAULT 'pending', paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE exchange_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, exchange TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL, api_secret_encrypted TEXT NOT NULL, passphrase_encrypted TEXT,
      is_testnet INTEGER DEFAULT 0, label TEXT, last_verified_at DATETIME, last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE trading_bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, exchange TEXT NOT NULL,
      exchange_key_id INTEGER, symbols TEXT NOT NULL, strategy TEXT NOT NULL, timeframe TEXT NOT NULL DEFAULT '1h',
      direction TEXT DEFAULT 'both', leverage INTEGER DEFAULT 1, risk_pct REAL DEFAULT 1.0,
      max_open_trades INTEGER DEFAULT 3, auto_trade INTEGER DEFAULT 0, trading_mode TEXT DEFAULT 'paper',
      strategy_config TEXT, risk_config TEXT, is_active INTEGER DEFAULT 0, last_run_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      tv_webhook_secret TEXT, scope TEXT DEFAULT 'pair', market_exchanges TEXT, strategies_multi TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (exchange_key_id) REFERENCES exchange_keys(id) ON DELETE SET NULL
    );
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, bot_id INTEGER, signal_id INTEGER,
      exchange TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, strategy TEXT, timeframe TEXT,
      entry_price REAL NOT NULL, exit_price REAL, quantity REAL NOT NULL, leverage INTEGER DEFAULT 1,
      status TEXT DEFAULT 'open', trading_mode TEXT DEFAULT 'paper', note TEXT,
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP, closed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL
    );
    CREATE TABLE trade_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      price REAL NOT NULL, quantity REAL NOT NULL, pnl REAL DEFAULT 0,
      FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
    );
    CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bot_id INTEGER, exchange TEXT NOT NULL,
      symbol TEXT NOT NULL, strategy TEXT NOT NULL, timeframe TEXT NOT NULL, side TEXT NOT NULL,
      entry_price REAL NOT NULL, stop_loss REAL NOT NULL, result TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL
    );
    CREATE TABLE signal_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, signal_id INTEGER NOT NULL,
      FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
    );
    CREATE TABLE user_signal_prefs (user_id INTEGER PRIMARY KEY, enabled_strategies TEXT DEFAULT '["levels"]');
    CREATE TABLE wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, address TEXT NOT NULL,
      encrypted_private_key TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, wallet_id INTEGER NOT NULL,
      type TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, entity_type TEXT,
      entity_id INTEGER, metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const user = legacy.prepare('INSERT INTO users (email, password_hash, referral_code, locale) VALUES (?, ?, ?, ?)');
  const sub = legacy.prepare('INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (?, ?, ?, ?)');
  const future = new Date(Date.now() + 20 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const alice = user.run('alice@x.com', 'x', 'RALICE', 'en').lastInsertRowid;   // elite, active
  const bob = user.run('bob@x.com', 'x', 'RBOB', 'ru').lastInsertRowid;         // starter, active, paid until future
  const carol = user.run('carol@x.com', 'x', 'RCAROL', 'de').lastInsertRowid;   // starter, expired
  const dave = user.run('dave@x.com', 'x', 'RDAVE', 'ru').lastInsertRowid;      // free
  const eve = user.run('eve@x.com', 'x', 'REVE', 'ru').lastInsertRowid;         // pro, active
  const frank = user.run('frank@x.com', 'x', 'RFRANK', 'ru').lastInsertRowid;   // starter, active, no expiry
  const grace = user.run('grace@x.com', 'x', 'RGRACE', 'ru').lastInsertRowid;   // no subscription row at all
  sub.run(alice, 'elite', 'active', future);
  sub.run(bob, 'starter', 'active', future);
  sub.run(carol, 'starter', 'expired', past);
  sub.run(dave, 'free', 'active', null);
  sub.run(eve, 'pro', 'active', future);
  sub.run(frank, 'starter', 'active', null);
  legacy.prepare("INSERT INTO promo_codes (code, plan) VALUES ('OLDELITE', 'elite'), ('OLDSTART', 'starter'), ('PRO30', 'pro')").run();
  legacy.prepare("INSERT INTO payments (user_id, amount_usd, method, plan, status) VALUES (?, 29, 'usdt_bep20', 'starter', 'pending'), (?, 149, 'stripe', 'elite', 'confirmed')").run(bob, alice);
  const bot1 = legacy.prepare("INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy) VALUES (?, 'b1', 'bybit', '[\"BTC/USDT\"]', 'levels')").run(alice).lastInsertRowid;
  legacy.prepare("INSERT INTO trading_bots (user_id, name, exchange, symbols, strategy) VALUES (?, 'b2', 'bybit', '[\"ETH/USDT\"]', 'smc')").run(bob);
  const t1 = legacy.prepare("INSERT INTO trades (user_id, bot_id, exchange, symbol, side, entry_price, quantity) VALUES (?, ?, 'bybit', 'BTC/USDT', 'long', 100, 1)").run(alice, bot1).lastInsertRowid;
  legacy.prepare("INSERT INTO trade_fills (trade_id, event_type, price, quantity) VALUES (?, 'entry', 100, 1)").run(t1);
  const s1 = legacy.prepare("INSERT INTO signals (user_id, bot_id, exchange, symbol, strategy, timeframe, side, entry_price, stop_loss) VALUES (?, ?, 'bybit', 'BTC/USDT', 'levels', '1h', 'long', 100, 99)").run(alice, bot1).lastInsertRowid;
  legacy.prepare('INSERT INTO signal_views (user_id, signal_id) VALUES (?, ?)').run(dave, s1);
  legacy.prepare('INSERT INTO user_signal_prefs (user_id) VALUES (?)').run(dave);
  const w1 = legacy.prepare("INSERT INTO wallets (user_id, address, encrypted_private_key, balance) VALUES (?, '0xabc', 'enc', 12.5)").run(alice).lastInsertRowid;
  legacy.prepare("INSERT INTO wallet_transactions (user_id, wallet_id, type, amount) VALUES (?, ?, 'deposit', 12.5)").run(alice, w1);
  legacy.prepare('UPDATE users SET public_profile = 1 WHERE id = ?').run(alice);
  return { legacy, ids: { alice, bob, carol, dave, eve, frank, grace } };
}

describe('legacy DB (per-bot product) → v13', () => {
  let legacy, ids, exportFile, exported;

  beforeAll(() => {
    process.env.LEGACY_BACKUP_DIR = LEGACY_BACKUPS;
    ({ legacy, ids } = buildLegacyDb(LEGACY_DB));
    const out = migrations.run(legacy);
    expect(out).toEqual({ ran: 13, current: 13 });
    const files = fs.readdirSync(LEGACY_BACKUPS).filter((f) => /^legacy-.*\.json$/.test(f));
    expect(files).toHaveLength(1);
    exportFile = path.join(LEGACY_BACKUPS, files[0]);
    exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  });

  afterAll(() => { try { legacy.close(); } catch (_e) {} });

  it('runs the whole chain (v9 still seeded the system bot on the legacy schema)', () => {
    expect(migrations.currentVersion(legacy)).toBe(13);
    expect(migrations.run(legacy)).toEqual({ ran: 0, current: 13 });
    expect(exported.tables.trading_bots.rows).toBe(3);   // b1, b2 + v9 "CHM Public Signals"
    expect(exported.tables.trading_bots.data.some((b) => b.is_system === 1 && b.name === 'CHM Public Signals')).toBe(true);
  });

  it('exported every legacy table with its rows and the retired users columns', () => {
    expect(exported.migration).toBe('v12 retire_bots');
    expect(exported.tables.trades.rows).toBe(1);
    expect(exported.tables.trades.data[0]).toMatchObject({ symbol: 'BTC/USDT', side: 'long', entry_price: 100 });
    expect(exported.tables.trade_fills.rows).toBe(1);
    expect(exported.tables.signals.rows).toBe(1);
    expect(exported.tables.signal_views.rows).toBe(1);
    expect(exported.tables.user_signal_prefs.rows).toBe(1);
    expect(exported.tables.wallets.data[0]).toMatchObject({ address: '0xabc', balance: 12.5 });
    expect(exported.tables.wallet_transactions.rows).toBe(1);
    // created by v4–v6 on the way up, empty
    for (const t of ['copy_subscriptions', 'published_strategies', 'strategy_installs', 'strategy_earnings']) {
      expect(exported.tables[t].rows, t).toBe(0);
    }
    expect(exported.users_dropped_columns.columns).toEqual(['paper_starting_balance', 'public_profile']);
    const aliceRow = exported.users_dropped_columns.rows.find((r) => r.id === ids.alice);
    expect(aliceRow).toMatchObject({ paper_starting_balance: 10000, public_profile: 1 });
  });

  it('dropped the legacy tables and users columns, kept the platform tables', () => {
    const t = tables(legacy);
    for (const name of LEGACY_TABLES) expect(t, name).not.toContain(name);
    for (const name of ['users', 'subscriptions', 'payments', 'promo_codes', 'exchange_keys', 'audit_log', 'ref_rewards']) expect(t).toContain(name);
    for (const name of ENGINE_TABLES) expect(t, name).toContain(name);
    const c = colNames(legacy, 'users');
    expect(c).not.toContain('paper_starting_balance');
    expect(c).not.toContain('public_profile');
    expect(legacy.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(8);   // 7 + v9 system user
  });

  it('D1: elite → pro; active starter → pro until expires_at; expired / open-ended starter → free; free & pro untouched', () => {
    const plan = (uid) => legacy.prepare('SELECT plan, status, expires_at FROM subscriptions WHERE user_id = ?').get(uid);
    expect(plan(ids.alice)).toMatchObject({ plan: 'pro', status: 'active' });
    expect(plan(ids.bob)).toMatchObject({ plan: 'pro', status: 'active' });
    expect(plan(ids.bob).expires_at).toBeTruthy();
    expect(plan(ids.carol)).toMatchObject({ plan: 'free', status: 'expired' });
    expect(plan(ids.dave)).toMatchObject({ plan: 'free', status: 'active' });
    expect(plan(ids.eve)).toMatchObject({ plan: 'pro', status: 'active' });
    expect(plan(ids.frank)).toMatchObject({ plan: 'free', status: 'active' });
    expect(legacy.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE plan NOT IN ('free', 'pro')").get().n).toBe(0);
  });

  it('logs every remap in plan_changes', () => {
    const rows = legacy.prepare('SELECT user_id, old_plan, new_plan, actor, reason FROM plan_changes ORDER BY user_id').all();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.actor === 'system:migration_v12')).toBe(true);
    expect(rows.find((r) => r.user_id === ids.alice)).toMatchObject({ old_plan: 'elite', new_plan: 'pro' });
    expect(rows.find((r) => r.user_id === ids.bob)).toMatchObject({ old_plan: 'starter', new_plan: 'pro' });
    expect(rows.find((r) => r.user_id === ids.bob).reason).toMatch(/grandfathered/);
    expect(rows.find((r) => r.user_id === ids.carol)).toMatchObject({ old_plan: 'starter', new_plan: 'free' });
    expect(rows.find((r) => r.user_id === ids.frank)).toMatchObject({ old_plan: 'starter', new_plan: 'free' });
  });

  it('promo codes and pending payments on retired paid ids become pro; confirmed payments are history', () => {
    const promo = Object.fromEntries(legacy.prepare('SELECT code, plan FROM promo_codes').all().map((r) => [r.code, r.plan]));
    expect(promo).toEqual({ OLDELITE: 'pro', OLDSTART: 'pro', PRO30: 'pro' });
    const pay = legacy.prepare('SELECT plan, status FROM payments ORDER BY id').all();
    expect(pay).toEqual([{ plan: 'pro', status: 'pending' }, { plan: 'elite', status: 'confirmed' }]);
  });

  it('every user got a default trader_settings row (onboarding_done = 0) with the plan mirror + lang', () => {
    const n = legacy.prepare('SELECT COUNT(*) AS n FROM trader_settings').get().n;
    expect(n).toBe(legacy.prepare('SELECT COUNT(*) AS n FROM users').get().n);
    const ts = (uid) => legacy.prepare('SELECT * FROM trader_settings WHERE user_id = ?').get(uid);
    expect(ts(ids.alice)).toMatchObject({ onboarding_done: 0, sub_plan: 'pro', sub_status: 'active', lang: 'en', strategy: 'LEVELS', auto_trade: 0 });
    expect(ts(ids.alice).sub_expires).toBeGreaterThan(Date.now() / 1000);
    expect(ts(ids.bob)).toMatchObject({ sub_plan: 'pro', sub_status: 'active', lang: 'ru' });
    expect(ts(ids.carol)).toMatchObject({ sub_plan: 'free', sub_status: 'expired', sub_expires: 0, lang: 'ru' });
    expect(ts(ids.dave)).toMatchObject({ sub_plan: 'free', sub_status: 'expired', sub_expires: 0 });
    expect(ts(ids.eve)).toMatchObject({ sub_plan: 'pro', sub_status: 'active' });
    expect(ts(ids.frank)).toMatchObject({ sub_plan: 'free' });
    expect(ts(ids.grace)).toMatchObject({ sub_plan: 'free', sub_status: 'expired', onboarding_done: 0 });
    expect(ts(ids.grace).created_at).toBeGreaterThan(0);
    expect(ts(ids.grace).min_volume_usdt).toBe(300000);
  });
});
