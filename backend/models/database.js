const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Create database directory if it doesn't exist
const dbDir = path.dirname(config.databasePath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.databasePath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Core tables ────────────────────────────────────────────────────────
db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    telegram_id TEXT,
    referral_code TEXT UNIQUE,
    email_verified BOOLEAN DEFAULT 0,
    email_verify_token TEXT,
    reset_token TEXT,
    reset_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
  );

  -- Exchange API keys
  CREATE TABLE IF NOT EXISTS exchange_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    exchange_name TEXT NOT NULL,
    api_key TEXT NOT NULL,
    api_secret_encrypted TEXT NOT NULL,
    is_testnet BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, exchange_name)
  );

  -- Trading bots
  CREATE TABLE IF NOT EXISTS trading_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    exchange_name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT NOT NULL,
    leverage INTEGER DEFAULT 1,
    position_size_usd REAL NOT NULL,
    stop_loss_pct REAL,
    take_profit_pct REAL,
    trailing_stop BOOLEAN DEFAULT 0,
    is_active BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Backtests
  CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    exchange_name TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    initial_capital REAL NOT NULL,
    strategy_config TEXT,
    status TEXT DEFAULT 'pending',
    results TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Bot trade history
  CREATE TABLE IF NOT EXISTS bot_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    trade_type TEXT NOT NULL,
    entry_price REAL,
    exit_price REAL,
    quantity REAL,
    pnl REAL,
    pnl_pct REAL,
    opened_at DATETIME,
    closed_at DATETIME,
    status TEXT DEFAULT 'open',
    FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE CASCADE
  );

  -- Legacy signals table (kept for backward compat)
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    exchange_name TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL,
    target_price REAL,
    stop_loss REAL,
    confidence REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );
`);

// ── Subscription tables ────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    payment_method TEXT,
    payment_tx TEXT,
    auto_renew BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL,
    duration_days INTEGER NOT NULL DEFAULT 30,
    discount_pct INTEGER DEFAULT 100,
    max_uses INTEGER DEFAULT 1,
    uses_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS promo_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    promo_id INTEGER NOT NULL,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (promo_id) REFERENCES promo_codes(id) ON DELETE CASCADE,
    UNIQUE(user_id, promo_id)
  );
`);

// ── Signal tables ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS signal_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('long', 'short')),
    entry_price REAL NOT NULL,
    stop_loss REAL NOT NULL,
    take_profit_1 REAL,
    take_profit_2 REAL,
    take_profit_3 REAL,
    strategy TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    confidence INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
    result TEXT DEFAULT 'pending',
    pnl_pct REAL,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS user_signals_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    strategies_enabled TEXT DEFAULT '["scalping","smc","gerchik"]',
    pairs_filter TEXT DEFAULT '[]',
    min_confidence INTEGER DEFAULT 60,
    notifications_enabled BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_signal_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    signal_id INTEGER NOT NULL,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (signal_id) REFERENCES signal_history(id) ON DELETE CASCADE
  );
`);

// ── Wallet tables ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    address TEXT NOT NULL UNIQUE,
    encrypted_private_key TEXT NOT NULL,
    balance REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    wallet_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal', 'fee', 'reward', 'refund')),
    amount REAL NOT NULL,
    tx_hash TEXT,
    destination_address TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
  );
`);

// ── Referral tables ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER NOT NULL,
    referred_id INTEGER NOT NULL UNIQUE,
    commission_pct REAL DEFAULT 10,
    total_earned REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── Indexes ────────────────────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
  CREATE INDEX IF NOT EXISTS idx_exchange_keys_user ON exchange_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_trading_bots_user ON trading_bots(user_id);
  CREATE INDEX IF NOT EXISTS idx_backtests_user ON backtests(user_id);
  CREATE INDEX IF NOT EXISTS idx_bot_trades_bot ON bot_trades(bot_id);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
  CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);

  CREATE INDEX IF NOT EXISTS idx_signal_history_symbol ON signal_history(symbol);
  CREATE INDEX IF NOT EXISTS idx_signal_history_strategy ON signal_history(strategy);
  CREATE INDEX IF NOT EXISTS idx_signal_history_created ON signal_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_user_signals_config_user ON user_signals_config(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_signal_usage_user ON user_signal_usage(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_signal_usage_date ON user_signal_usage(viewed_at);

  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);
  CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status);

  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
`);

// ── Migrations (safe for existing DBs) ────────────────────────────────
const migrations = [
  'ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT 0',
  'ALTER TABLE users ADD COLUMN email_verify_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_token TEXT',
  'ALTER TABLE users ADD COLUMN reset_expires DATETIME',

  // Trading bots — enhanced columns
  "ALTER TABLE trading_bots ADD COLUMN strategy_config TEXT DEFAULT '{}'",
  'ALTER TABLE trading_bots ADD COLUMN total_signals INTEGER DEFAULT 0',
  'ALTER TABLE trading_bots ADD COLUMN total_trades INTEGER DEFAULT 0',
  'ALTER TABLE trading_bots ADD COLUMN total_pnl REAL DEFAULT 0',
  'ALTER TABLE trading_bots ADD COLUMN win_rate REAL DEFAULT 0',
  'ALTER TABLE trading_bots ADD COLUMN last_signal_at DATETIME',
  "ALTER TABLE trading_bots ADD COLUMN timeframe TEXT DEFAULT '1H'",
  "ALTER TABLE trading_bots ADD COLUMN direction TEXT DEFAULT 'both'",

  // Bot trades — enhanced columns
  'ALTER TABLE bot_trades ADD COLUMN signal_id INTEGER',
  'ALTER TABLE bot_trades ADD COLUMN strategy TEXT',
  'ALTER TABLE bot_trades ADD COLUMN timeframe TEXT',
  'ALTER TABLE bot_trades ADD COLUMN stop_loss REAL',
  'ALTER TABLE bot_trades ADD COLUMN take_profit REAL',
  "ALTER TABLE bot_trades ADD COLUMN result TEXT DEFAULT ''",
  'ALTER TABLE bot_trades ADD COLUMN duration_sec INTEGER',
  'ALTER TABLE bot_trades ADD COLUMN rr_ratio REAL',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

console.log('Database initialized:', config.databasePath);

module.exports = db;
