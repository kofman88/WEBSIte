/**
 * CHM Finance database — better-sqlite3 setup.
 *
 * All statements use CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS,
 * so running against a pre-existing schema is safe (but will NOT migrate
 * structure changes — for that use utils/db-reset.js in dev).
 *
 * Schema overview (19 tables):
 *   Core:      users, refresh_tokens, subscriptions, payments,
 *              promo_codes, promo_redemptions
 *   Trading:   exchange_keys, trading_bots, trades, trade_fills,
 *              signals, signal_registry, user_signal_prefs, signal_views
 *   Analytics: backtests, backtest_trades, optimizations, candles_cache
 *   Referral:  referrals, ref_rewards
 *   System:    audit_log, system_kv
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const dbDir = path.dirname(config.databasePath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ── CORE ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    email            TEXT UNIQUE NOT NULL,
    password_hash    TEXT NOT NULL,
    display_name     TEXT,
    avatar_url       TEXT,
    locale           TEXT DEFAULT 'ru',
    timezone         TEXT DEFAULT 'UTC',
    referral_code    TEXT UNIQUE NOT NULL,
    referred_by      INTEGER,
    email_verified   INTEGER DEFAULT 0,
    is_admin         INTEGER DEFAULT 0,
    is_active        INTEGER DEFAULT 1,
    last_login_at    DATETIME,
    telegram_chat_id    TEXT,
    telegram_username   TEXT,
    telegram_linked_at  DATETIME,
    notification_prefs  TEXT DEFAULT '{}',
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL
  );

  -- Idempotent column adds for upgrades from earlier schemas (ignore errors)
`);
(function migrateUsersColumns(){
  const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
  const adds = [
    ["telegram_chat_id",    "ALTER TABLE users ADD COLUMN telegram_chat_id TEXT"],
    ["telegram_username",   "ALTER TABLE users ADD COLUMN telegram_username TEXT"],
    ["telegram_linked_at",  "ALTER TABLE users ADD COLUMN telegram_linked_at DATETIME"],
    ["notification_prefs",  "ALTER TABLE users ADD COLUMN notification_prefs TEXT DEFAULT '{}'"],
    // ── OAuth / Social login (Google + Telegram Login Widget) ──
    //   google_id       Google subject (sub) — stable across sessions
    //   tg_id           Telegram user.id from Login Widget (separate from
    //                   telegram_chat_id which is for bot DMs)
    //   oauth_provider  Primary signup method: 'password' | 'google' | 'telegram'
    //   given_name      First name (from Google profile or register form)
    //   family_name     Last name (from Google profile or register form)
    //   avatar_url      Profile photo URL from the OAuth provider
    ["google_id",     "ALTER TABLE users ADD COLUMN google_id TEXT"],
    ["tg_id",         "ALTER TABLE users ADD COLUMN tg_id TEXT"],
    ["oauth_provider","ALTER TABLE users ADD COLUMN oauth_provider TEXT DEFAULT 'password'"],
    ["given_name",    "ALTER TABLE users ADD COLUMN given_name TEXT"],
    ["family_name",   "ALTER TABLE users ADD COLUMN family_name TEXT"],
    ["avatar_url",    "ALTER TABLE users ADD COLUMN avatar_url TEXT"],
  ];
  for (const [col, sql] of adds) if (!cols.includes(col)) { try { db.exec(sql); } catch(_){} }
  // Unique indexes on OAuth IDs — prevent two users from linking the same
  // Google/Telegram account. Partial index (WHERE col IS NOT NULL) so
  // password-only users don't clash on NULL.
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL"); } catch(_){}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg_id     ON users(tg_id)     WHERE tg_id     IS NOT NULL"); } catch(_){}
})();
// Phase C: trade journal — add `note` column to trades (idempotent)
(function migrateTradesNote(){
  try {
    const cols = db.prepare("PRAGMA table_info('trades')").all().map(c => c.name);
    if (!cols.includes('note')) db.exec("ALTER TABLE trades ADD COLUMN note TEXT");
  } catch(_){}
})();
// Phase D: TradingView webhook secret per-bot + manual-trade tag
(function migrateBotsWebhook(){
  try {
    const cols = db.prepare("PRAGMA table_info('trading_bots')").all().map(c => c.name);
    if (!cols.includes('tv_webhook_secret')) db.exec("ALTER TABLE trading_bots ADD COLUMN tv_webhook_secret TEXT");
    // Market Scanner (Elite-only feature):
    //   scope            'pair' (existing) | 'market' (scan entire universe)
    //   market_exchanges JSON array, e.g. ["bybit","binance"] — for scope='market'
    //   strategies_multi JSON array — Elite combo, e.g. ["smc","levels"]; null = use single `strategy`
    if (!cols.includes('scope'))            db.exec("ALTER TABLE trading_bots ADD COLUMN scope TEXT DEFAULT 'pair'");
    if (!cols.includes('market_exchanges')) db.exec("ALTER TABLE trading_bots ADD COLUMN market_exchanges TEXT");
    if (!cols.includes('strategies_multi')) db.exec("ALTER TABLE trading_bots ADD COLUMN strategies_multi TEXT");
  } catch(_){}
})();
// Phase E: public profile opt-in
(function migrateUsersPublic(){
  try {
    const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
    if (!cols.includes('public_profile')) db.exec("ALTER TABLE users ADD COLUMN public_profile INTEGER DEFAULT 0");
  } catch(_){}
})();
// Ops phase: admin sub-roles — superadmin / support / billing / viewer.
// NULL = not an admin. Legacy is_admin=1 is treated as 'superadmin' by the
// resolver until operators backfill explicit roles via /ops.
(function migrateAdminRoles(){
  try {
    const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
    if (!cols.includes('admin_role')) db.exec("ALTER TABLE users ADD COLUMN admin_role TEXT");
    // One-time backfill: any existing is_admin=1 without a role gets 'superadmin'
    db.exec("UPDATE users SET admin_role = 'superadmin' WHERE is_admin = 1 AND (admin_role IS NULL OR admin_role = '')");
  } catch(_){}
})();
// Phase F: support tickets
db.exec(`
  CREATE TABLE IF NOT EXISTS support_tickets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    subject      TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    priority     TEXT DEFAULT 'normal',
    assigned_to  INTEGER,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at    DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS support_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id    INTEGER NOT NULL,
    author_id    INTEGER NOT NULL,
    is_admin     INTEGER DEFAULT 0,
    body         TEXT NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON support_messages(ticket_id, created_at);

  -- Per-user risk limits.
`);
// Idempotent: add read-tracking columns to support_tickets for unread
// counts in the widget + ops inbox. user_read_at bumps when the user
// opens the thread, admin_read_at bumps when support opens the drawer.
(function migrateSupportReadAt(){
  try {
    const cols = db.prepare("PRAGMA table_info('support_tickets')").all().map((c) => c.name);
    if (!cols.includes('user_read_at'))  db.exec("ALTER TABLE support_tickets ADD COLUMN user_read_at DATETIME");
    if (!cols.includes('admin_read_at')) db.exec("ALTER TABLE support_tickets ADD COLUMN admin_read_at DATETIME");
  } catch (_) {}
})();
// Phase B of support: internal notes + canned-response templates +
// attachments for file uploads. All idempotent.
(function migrateSupportPhaseB(){
  try {
    const cols = db.prepare("PRAGMA table_info('support_messages')").all().map((c) => c.name);
    if (!cols.includes('is_internal')) db.exec("ALTER TABLE support_messages ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes('attachments')) db.exec("ALTER TABLE support_messages ADD COLUMN attachments TEXT");
  } catch (_) {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS support_templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        use_count   INTEGER NOT NULL DEFAULT 0,
        created_by  INTEGER,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_templates_slug ON support_templates(slug);
    `);
    // Seed a handful of default templates on first install — idempotent
    // via INSERT OR IGNORE on the unique slug column.
    const seeds = [
      ['welcome',       'Приветствие',        'Здравствуйте! Спасибо за обращение в CHM Finance. Сейчас разберусь с вашим вопросом.'],
      ['email-verify',  'Подтверждение email','Пожалуйста, подтвердите email — ссылка уже ушла на ваш адрес. Проверьте в том числе папку «Спам». Без подтверждения недоступна live-торговля и выплаты.'],
      ['exchange-key',  'Ключ биржи',         'Для подключения биржи: Настройки → Кошелёк → Добавить ключ. Нужен API-ключ с правом чтения + trading (без withdraw!). Подробная инструкция в Академии.'],
      ['paper-only',    'Почему paper',       'Для старта рекомендуем paper-режим — симуляция с виртуальными $10,000. Безопасный способ проверить стратегию перед переходом на live.'],
      ['refund',        'Возврат подписки',   'Оформим возврат в течение 3 рабочих дней. Средства придут тем же способом, которым вы оплачивали. Причину возврата, пожалуйста, опишите — нам это помогает улучшать продукт.'],
      ['closed',        'Закрытие тикета',    'Если вопрос решён — отлично! Закрываю тикет. При необходимости просто ответьте в эту беседу и я снова вернусь на связь.'],
    ];
    const ins = db.prepare(`INSERT OR IGNORE INTO support_templates (slug, title, body) VALUES (?, ?, ?)`);
    for (const s of seeds) ins.run(...s);
  } catch (_) {}
})();
db.exec(`
  -- Per-user risk limits (resume). One row per user, inserted lazily by
  -- riskLimitsService.get() with defaults. Read on every auto-trade
  -- execution to block runaway losses across all bots.
  CREATE TABLE IF NOT EXISTS user_risk_limits (
    user_id                INTEGER PRIMARY KEY,
    kill_switch_enabled    INTEGER NOT NULL DEFAULT 0,  -- emergency stop: blocks ALL auto-trade
    max_open_positions     INTEGER NOT NULL DEFAULT 20, -- global cap across all bots
    max_daily_loss_pct     REAL    NOT NULL DEFAULT 5,  -- stop new entries if today realised loss ≥ X% of equity
    blacklisted_symbols    TEXT    NOT NULL DEFAULT '[]', -- JSON array, exact symbol match
    updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Guest (unauthenticated) support inquiries — one-shot messages from the
  -- widget when no one is logged in. Reply goes to the provided email, not
  -- back through the widget. Separate table to keep the FK-backed tickets
  -- table clean (user_id is NOT NULL there).
  CREATE TABLE IF NOT EXISTS support_guest_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL,
    body         TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    handled_at   DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_guest_msgs_created ON support_guest_messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_guest_msgs_unhandled ON support_guest_messages(handled_at) WHERE handled_at IS NULL;
`);
db.exec(`
  -- placeholder to keep the multi-statement block working

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL UNIQUE,
    plan                 TEXT NOT NULL DEFAULT 'free',
    status               TEXT NOT NULL DEFAULT 'active',
    started_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at           DATETIME,
    payment_method       TEXT,
    payment_provider_id  TEXT,
    auto_renew           INTEGER DEFAULT 0,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    amount_usd       REAL NOT NULL,
    currency         TEXT DEFAULT 'USD',
    method           TEXT NOT NULL,
    provider_tx_id   TEXT,
    plan             TEXT,
    duration_days    INTEGER,
    status           TEXT NOT NULL,
    metadata         TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at     DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE NOT NULL,
    plan            TEXT NOT NULL,
    duration_days   INTEGER NOT NULL DEFAULT 30,
    discount_pct    INTEGER DEFAULT 100,
    max_uses        INTEGER DEFAULT 1,
    uses_count      INTEGER DEFAULT 0,
    is_active       INTEGER DEFAULT 1,
    created_by      INTEGER,
    expires_at      DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS promo_redemptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    promo_id     INTEGER NOT NULL,
    redeemed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (promo_id) REFERENCES promo_codes(id) ON DELETE CASCADE,
    UNIQUE(user_id, promo_id)
  );
`);

// ── TRADING ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS exchange_keys (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL,
    exchange             TEXT NOT NULL,
    api_key_encrypted    TEXT NOT NULL,
    api_secret_encrypted TEXT NOT NULL,
    passphrase_encrypted TEXT,
    is_testnet           INTEGER DEFAULT 0,
    label                TEXT,
    last_verified_at     DATETIME,
    last_error           TEXT,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, exchange, label)
  );

  CREATE TABLE IF NOT EXISTS trading_bots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    name             TEXT NOT NULL,
    exchange         TEXT NOT NULL,
    exchange_key_id  INTEGER,
    symbols          TEXT NOT NULL,
    strategy         TEXT NOT NULL,
    timeframe        TEXT NOT NULL DEFAULT '1h',
    direction        TEXT DEFAULT 'both',
    leverage         INTEGER DEFAULT 1,
    risk_pct         REAL DEFAULT 1.0,
    max_open_trades  INTEGER DEFAULT 3,
    auto_trade       INTEGER DEFAULT 0,
    trading_mode     TEXT DEFAULT 'paper',
    strategy_config  TEXT,
    risk_config      TEXT,
    is_active        INTEGER DEFAULT 0,
    last_run_at      DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (exchange_key_id) REFERENCES exchange_keys(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,
    bot_id              INTEGER,
    signal_id           INTEGER,
    exchange            TEXT NOT NULL,
    symbol              TEXT NOT NULL,
    side                TEXT NOT NULL,
    strategy            TEXT,
    timeframe           TEXT,
    entry_price         REAL NOT NULL,
    exit_price          REAL,
    quantity            REAL NOT NULL,
    leverage            INTEGER DEFAULT 1,
    margin_used         REAL,
    stop_loss           REAL,
    take_profit_1       REAL,
    take_profit_2       REAL,
    take_profit_3       REAL,
    realized_pnl        REAL DEFAULT 0,
    realized_pnl_pct    REAL DEFAULT 0,
    fees_paid           REAL DEFAULT 0,
    status              TEXT DEFAULT 'open',
    close_reason        TEXT,
    trading_mode        TEXT DEFAULT 'paper',
    exchange_order_ids  TEXT,
    opened_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at           DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS trade_fills (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id           INTEGER NOT NULL,
    event_type         TEXT NOT NULL,
    price              REAL NOT NULL,
    quantity           REAL NOT NULL,
    pnl                REAL DEFAULT 0,
    exchange_order_id  TEXT,
    executed_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS signals (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER,
    bot_id         INTEGER,
    exchange       TEXT NOT NULL,
    symbol         TEXT NOT NULL,
    strategy       TEXT NOT NULL,
    timeframe      TEXT NOT NULL,
    side           TEXT NOT NULL,
    entry_price    REAL NOT NULL,
    stop_loss      REAL NOT NULL,
    take_profit_1  REAL,
    take_profit_2  REAL,
    take_profit_3  REAL,
    risk_reward    REAL,
    confidence     INTEGER,
    quality        INTEGER,
    reason         TEXT,
    metadata       TEXT,
    result         TEXT DEFAULT 'pending',
    result_price   REAL,
    result_pnl_pct REAL,
    expires_at     DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at      DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (bot_id) REFERENCES trading_bots(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS signal_registry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint  TEXT UNIQUE NOT NULL,
    signal_id    INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at   DATETIME NOT NULL,
    FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_signal_prefs (
    user_id                 INTEGER PRIMARY KEY,
    enabled_strategies      TEXT DEFAULT '["levels"]',
    watched_symbols         TEXT DEFAULT '[]',
    blacklisted_symbols     TEXT DEFAULT '[]',
    min_confidence          INTEGER DEFAULT 60,
    min_rr                  REAL DEFAULT 1.5,
    timeframes              TEXT DEFAULT '["1h","4h"]',
    directions              TEXT DEFAULT '["long","short"]',
    notifications_web       INTEGER DEFAULT 1,
    notifications_email     INTEGER DEFAULT 0,
    notifications_telegram  INTEGER DEFAULT 0,
    telegram_chat_id        TEXT,
    created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS signal_views (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    signal_id  INTEGER NOT NULL,
    viewed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE CASCADE
  );
`);

// ── ANALYTICS (backtests + optimizer + market-data cache) ────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS backtests (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    name             TEXT NOT NULL,
    strategy         TEXT NOT NULL,
    exchange         TEXT NOT NULL,
    symbols          TEXT NOT NULL,
    timeframe        TEXT NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    initial_capital  REAL NOT NULL,
    strategy_config  TEXT,
    risk_config      TEXT,
    status           TEXT DEFAULT 'pending',
    progress_pct     REAL DEFAULT 0,
    results          TEXT,
    error_message    TEXT,
    duration_ms      INTEGER,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at       DATETIME,
    completed_at     DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS backtest_trades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    backtest_id    INTEGER NOT NULL,
    symbol         TEXT NOT NULL,
    side           TEXT NOT NULL,
    entry_time     DATETIME NOT NULL,
    entry_price    REAL NOT NULL,
    exit_time      DATETIME,
    exit_price     REAL,
    quantity       REAL,
    stop_loss      REAL,
    take_profit_1  REAL,
    take_profit_2  REAL,
    take_profit_3  REAL,
    pnl_pct        REAL,
    pnl_usd        REAL,
    close_reason   TEXT,
    equity_after   REAL,
    FOREIGN KEY (backtest_id) REFERENCES backtests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS optimizations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL,
    backtest_config    TEXT NOT NULL,
    param_space        TEXT NOT NULL,
    objective          TEXT NOT NULL,
    n_trials           INTEGER DEFAULT 50,
    trials_completed   INTEGER DEFAULT 0,
    best_params        TEXT,
    best_score         REAL,
    status             TEXT DEFAULT 'pending',
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at       DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS candles_cache (
    exchange   TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    timeframe  TEXT NOT NULL,
    open_time  INTEGER NOT NULL,
    open       REAL NOT NULL,
    high       REAL NOT NULL,
    low        REAL NOT NULL,
    close      REAL NOT NULL,
    volume     REAL NOT NULL,
    close_time INTEGER NOT NULL,
    PRIMARY KEY (exchange, symbol, timeframe, open_time)
  );
`);

// ── REFERRAL ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS referrals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id      INTEGER NOT NULL,
    referred_id      INTEGER NOT NULL UNIQUE,
    commission_pct   REAL DEFAULT 20,
    total_earned_usd REAL DEFAULT 0,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ref_rewards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id   INTEGER NOT NULL,
    referred_id   INTEGER NOT NULL,
    payment_id    INTEGER,
    amount_usd    REAL NOT NULL,
    status        TEXT DEFAULT 'pending',
    paid_at       DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL
  );
`);

// ── SYSTEM (audit + kv) ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER,
    action       TEXT NOT NULL,
    entity_type  TEXT,
    entity_id    INTEGER,
    ip_address   TEXT,
    user_agent   TEXT,
    metadata     TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS system_kv (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ── Security / Account (Phase A) ────────────────────────────────────
  CREATE TABLE IF NOT EXISTS email_verifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    token_hash   TEXT UNIQUE NOT NULL,
    expires_at   DATETIME NOT NULL,
    verified_at  DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    token_hash   TEXT UNIQUE NOT NULL,
    expires_at   DATETIME NOT NULL,
    used_at      DATETIME,
    ip_address   TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS two_factor_secrets (
    user_id               INTEGER PRIMARY KEY,
    secret_encrypted      TEXT NOT NULL,
    enabled               INTEGER DEFAULT 0,
    recovery_codes_hash   TEXT,
    enabled_at            DATETIME,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS login_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    ip_address   TEXT,
    user_agent   TEXT,
    success      INTEGER DEFAULT 1,
    failure_code TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    link         TEXT,
    read_at      DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id                INTEGER NOT NULL UNIQUE,
    address                TEXT NOT NULL,
    encrypted_private_key  TEXT NOT NULL,
    balance                REAL NOT NULL DEFAULT 0,
    created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS wallet_transactions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL,
    wallet_id            INTEGER NOT NULL,
    type                 TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
    amount               REAL NOT NULL,
    tx_hash              TEXT UNIQUE,
    destination_address  TEXT,
    status               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processing','completed','cancelled','failed')),
    notes                TEXT,
    created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
  );

  -- Stripe webhook idempotency — dedupe retries so a repeated
  -- checkout.session.completed can't trigger confirmPayment twice.
  CREATE TABLE IF NOT EXISTS stripe_webhooks (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Web Push subscriptions (VAPID). One user can have many subscriptions,
  -- one per browser-profile / device. endpoint is the unique key because
  -- it's what the push service uses.
  -- Email bounce log for deliverability monitoring + suppression list.
  CREATE TABLE IF NOT EXISTS email_bounces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('hard','soft','complaint')),
    smtp_code    TEXT,
    reason       TEXT,
    suppressed   INTEGER NOT NULL DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ── INDEXES ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_referral ON users(referral_code);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON subscriptions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);

  CREATE INDEX IF NOT EXISTS idx_exchange_keys_user ON exchange_keys(user_id);
  CREATE INDEX IF NOT EXISTS idx_trading_bots_user ON trading_bots(user_id);
  CREATE INDEX IF NOT EXISTS idx_trading_bots_active ON trading_bots(is_active, last_run_at);
  CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trades_user_status_closed ON trades(user_id, status, closed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status, opened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trade_fills_trade ON trade_fills(trade_id);
  CREATE INDEX IF NOT EXISTS idx_signals_user_created ON signals(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signals_pending ON signals(result, expires_at);

  CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id, verified_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_resets(user_id, used_at);
  CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_signal_registry_fp ON signal_registry(fingerprint);
  CREATE INDEX IF NOT EXISTS idx_signal_registry_expires ON signal_registry(expires_at);
  CREATE INDEX IF NOT EXISTS idx_signal_views_user ON signal_views(user_id, viewed_at DESC);

  CREATE INDEX IF NOT EXISTS idx_backtests_user ON backtests(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_backtest_trades_bt ON backtest_trades(backtest_id);
  CREATE INDEX IF NOT EXISTS idx_optimizations_user ON optimizations(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles_cache(exchange, symbol, timeframe, open_time DESC);

  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
  CREATE INDEX IF NOT EXISTS idx_ref_rewards_referrer ON ref_rewards(referrer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ref_rewards_status ON ref_rewards(status);

  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

  CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role) WHERE admin_role IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_wallet_tx_status ON wallet_transactions(status, type);
  CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
  CREATE INDEX IF NOT EXISTS idx_stripe_webhooks_processed ON stripe_webhooks(processed_at);
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_email_bounces_email ON email_bounces(email, suppressed);
`);

// Run versioned migrations AFTER the idempotent legacy schema has been
// applied. This way the migrations table only tracks changes authored
// since the framework was introduced; the legacy blocks stay as the
// baseline and remain safe on re-run.
try {
  const migrations = require('./migrations');
  migrations.run(db);
} catch (e) {
  // Loud failure — we don't want the app to come up with a half-migrated DB.
  // eslint-disable-next-line no-console
  console.error('[FATAL] migration failure:', e.message);
  throw e;
}

// ── audit_log append-only enforcement ───────────────────────────────────
// Block UPDATE/DELETE at the engine level for compliance/forensics.
// SKIP in tests: test setup needs to wipe tables between cases, and the
// app-level guarantee still holds because prod runs with triggers on.
// Old test DBs may have the triggers from earlier runs — drop them first.
const IS_TEST_DB = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
if (IS_TEST_DB) {
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_audit_log_no_update;
      DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
    `);
  } catch (_e) { /* noop */ }
} else {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(FAIL, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(FAIL, 'audit_log is append-only'); END;
  `);
}

// Graceful shutdown — make sure WAL is merged back
function close() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (e) {
    // ignore
  }
}

if (!process.env.DB_QUIET) {
  // eslint-disable-next-line no-console
  console.log('Database initialized:', config.databasePath);
}

module.exports = db;
module.exports.close = close;
