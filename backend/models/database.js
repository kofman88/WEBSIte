/**
 * CHM Finance database — better-sqlite3 setup.
 *
 * All statements use CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS,
 * so running against a pre-existing schema is safe (but will NOT migrate
 * structure changes — for that use utils/db-reset.js in dev).
 *
 * Schema overview:
 *   Core:      users, refresh_tokens, subscriptions, payments,
 *              promo_codes, promo_redemptions
 *   Trading:   exchange_keys, candles_cache
 *   Engine:    trader_settings, signal_trades, engine_kv, trade_events,
 *              plan_changes, genome_population, genome_history,
 *              optimizer_params  (migrations v10–v11, models/engineSchema.js)
 *   Referral:  referrals, ref_rewards
 *   System:    audit_log, system_kv, email_*, password_resets,
 *              two_factor_secrets, login_history, notifications,
 *              impersonation_tokens, stripe_webhooks, push_subscriptions,
 *              support_*
 *
 * The per-bot product's tables (trading_bots, trades, trade_fills, signals,
 * signal_registry, signal_views, user_signal_prefs, backtests,
 * backtest_trades, optimizations, copy_subscriptions, published_strategies,
 * strategy_installs, strategy_earnings, wallets, wallet_transactions) are
 * exported and dropped by migration v12 (retire_bots) and are no longer
 * created here.
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
// 5s wasn't enough under maintenance backup — VACUUM INTO holds an
// exclusive lock for the duration of the copy and the scanner worker
// timed out with "database is locked" every time backup ran (twice in
// the last 5 hours of prod logs). 15s gives backup + any slow query
// breathing room without hiding a genuine hang for too long.
db.pragma('busy_timeout = 15000');

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
`);

// ── MARKET DATA (persistent candle store; genome/backtester history, M8) ─
db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications(user_id, verified_at);
  CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_resets(user_id, used_at);
  CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles_cache(exchange, symbol, timeframe, open_time DESC);

  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
  CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
  CREATE INDEX IF NOT EXISTS idx_ref_rewards_referrer ON ref_rewards(referrer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_ref_rewards_status ON ref_rewards(status);

  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

  CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role) WHERE admin_role IS NOT NULL;
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
