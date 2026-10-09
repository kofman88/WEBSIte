/**
 * Versioned SQL migration runner.
 *
 * Semantics:
 *   • schema_migrations table stores (version INT PK, name TEXT, applied_at TS).
 *   • MIGRATIONS is a append-only list; each entry's version must match its
 *     index + 1 for a visual sanity check. New migrations go at the bottom.
 *   • run() walks the list; any row whose version > max(applied) executes
 *     inside a transaction, then logs to schema_migrations. On any error
 *     the whole migration rolls back and startup aborts — you want loud
 *     failures here, not a half-migrated DB in production.
 *
 * This coexists with the legacy CREATE TABLE IF NOT EXISTS + idempotent
 * ALTER blocks in database.js: the old blocks are still safe to run, but
 * every *new* schema change from now on goes through here so we have a
 * clean linear history and can roll back by inspection.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const engineSchema = require('./engineSchema');

// ── helpers ──────────────────────────────────────────────────────────────
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db, table, col) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info('${table}')`).all().some((c) => c.name === col);
}

function quiet() { return process.env.DB_QUIET === '1'; }

// Where migration v12 writes the legacy export. Next to the DB file
// (./data/backups, same place maintenanceService keeps its backups) unless
// LEGACY_BACKUP_DIR says otherwise (tests).
function legacyBackupDir(db) {
  if (process.env.LEGACY_BACKUP_DIR) return process.env.LEGACY_BACKUP_DIR;
  const file = db.name && db.name !== ':memory:' ? db.name : './data/chmup.db';
  return path.join(path.dirname(file), 'backups');
}

// Site timestamps are ISO strings (toISOString) or SQLite CURRENT_TIMESTAMP
// ('YYYY-MM-DD HH:MM:SS', UTC). → unix seconds, 0 when unparsable/empty.
function toUnixSeconds(value) {
  if (!value) return 0;
  let s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Export every legacy table (PLAN §2.1) and the retired users columns to
 * data/backups/legacy-<ts>.json. Returns {file, rows} — file is null when
 * there was nothing to export (fresh install).
 */
function exportLegacy(db) {
  const payload = {
    exported_at: new Date().toISOString(),
    migration: 'v12 retire_bots',
    tables: {},
    users_dropped_columns: { columns: [], rows: [] },
  };
  let total = 0;
  for (const t of engineSchema.LEGACY_TABLES) {
    if (!tableExists(db, t)) continue;
    const rows = db.prepare(`SELECT * FROM "${t}"`).all();
    payload.tables[t] = { rows: rows.length, data: rows };
    total += rows.length;
  }
  const cols = engineSchema.LEGACY_USER_COLUMNS.filter((c) => columnExists(db, 'users', c));
  if (cols.length) {
    payload.users_dropped_columns.columns = cols;
    payload.users_dropped_columns.rows = db.prepare(`SELECT id, ${cols.join(', ')} FROM users`).all();
  }
  if (total === 0) return { file: null, rows: 0 };
  const dir = legacyBackupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `legacy-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return { file, rows: total };
}

// ── Migration list — append only, never reorder ─────────────────────────
const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline',
    // No-op: everything that existed before the migrations framework is
    // considered the baseline. Deployed DBs that pre-date this file will
    // record version 1 on first boot without running anything.
    up(db) { /* intentionally empty */ },
  },
  {
    version: 2,
    name: 'users_paper_starting_balance',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('users')").all().map((c) => c.name);
      if (!cols.includes('paper_starting_balance')) {
        db.exec("ALTER TABLE users ADD COLUMN paper_starting_balance REAL NOT NULL DEFAULT 10000");
      }
    },
  },
  {
    version: 3,
    name: 'ref_rewards_kind',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('ref_rewards')").all().map((c) => c.name);
      if (!cols.includes('kind')) {
        db.exec("ALTER TABLE ref_rewards ADD COLUMN kind TEXT NOT NULL DEFAULT 'commission'");
      }
    },
  },
  {
    version: 4,
    name: 'copy_trading',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS copy_subscriptions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          follower_id INTEGER NOT NULL,
          leader_id   INTEGER NOT NULL,
          mode        TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
          risk_mult   REAL NOT NULL DEFAULT 1.0,
          is_active   INTEGER NOT NULL DEFAULT 1,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(follower_id, leader_id),
          FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (leader_id)   REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_copy_sub_follower ON copy_subscriptions(follower_id);
        CREATE INDEX IF NOT EXISTS idx_copy_sub_leader ON copy_subscriptions(leader_id, is_active);
      `);
    },
  },
  {
    version: 5,
    name: 'strategy_marketplace',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS published_strategies (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          author_id   INTEGER NOT NULL,
          slug        TEXT NOT NULL UNIQUE,
          title       TEXT NOT NULL,
          description TEXT,
          strategy    TEXT NOT NULL,
          timeframe   TEXT NOT NULL DEFAULT '1h',
          direction   TEXT NOT NULL DEFAULT 'both',
          config_json TEXT NOT NULL DEFAULT '{}',
          risk_json   TEXT NOT NULL DEFAULT '{}',
          installs    INTEGER NOT NULL DEFAULT 0,
          rating_sum  INTEGER NOT NULL DEFAULT 0,
          rating_cnt  INTEGER NOT NULL DEFAULT 0,
          is_public   INTEGER NOT NULL DEFAULT 1,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_strategies_author ON published_strategies(author_id);
        CREATE INDEX IF NOT EXISTS idx_strategies_public ON published_strategies(is_public, installs DESC);

        CREATE TABLE IF NOT EXISTS strategy_installs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL,
          strategy_id   INTEGER NOT NULL,
          bot_id        INTEGER,
          rating        INTEGER,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, strategy_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (strategy_id) REFERENCES published_strategies(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 6,
    name: 'strategy_marketplace_monetization',
    up(db) {
      // Paid marketplace scaffolding — column ALTERs are idempotent via
      // try/catch since SQLite has no ADD COLUMN IF NOT EXISTS.
      const addCol = (sql) => { try { db.exec(sql); } catch (_) { /* already exists */ } };
      addCol("ALTER TABLE published_strategies ADD COLUMN price_usd REAL NOT NULL DEFAULT 0");
      addCol("ALTER TABLE published_strategies ADD COLUMN platform_fee_pct REAL NOT NULL DEFAULT 20");
      addCol("ALTER TABLE strategy_installs ADD COLUMN price_paid_usd REAL NOT NULL DEFAULT 0");
      addCol("ALTER TABLE strategy_installs ADD COLUMN stripe_session_id TEXT");
      // Ledger for author payouts. Written on every successful paid install;
      // admin pays out periodically via a separate flow (not wired yet).
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategy_earnings (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          author_id     INTEGER NOT NULL,
          strategy_id   INTEGER NOT NULL,
          install_id    INTEGER,
          amount_usd    REAL NOT NULL,
          platform_fee_usd REAL NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | refunded
          paid_at       DATETIME,
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (strategy_id) REFERENCES published_strategies(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_earnings_author ON strategy_earnings(author_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_earnings_status ON strategy_earnings(status);
      `);
    },
  },
  {
    version: 7,
    name: 'email_outbox',
    up(db) {
      // Durable retry queue for high-importance emails (payment receipts,
      // verification, password reset). Fire-and-forget sends still use
      // emailService.send() directly; durable callers go through
      // emailService.sendDurable() which inserts here and returns
      // immediately. A worker tick (in emailService) drains the table
      // with exponential backoff: 1m, 2m, 4m, 8m, 16m, then DLQ.
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_outbox (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          to_addr         TEXT    NOT NULL,
          subject         TEXT    NOT NULL,
          html            TEXT,
          text            TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          max_attempts    INTEGER NOT NULL DEFAULT 5,
          status          TEXT    NOT NULL DEFAULT 'pending',
          last_error      TEXT,
          next_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          sent_at         DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_due
          ON email_outbox(status, next_attempt_at);
      `);
    },
  },
  {
    version: 8,
    name: 'impersonation_tokens',
    up(db) {
      // Per-token revocation registry for admin impersonation.
      // JWT itself is stateless (signed, can't be cancelled), so we
      // gate it server-side: every issued impersonation token gets a
      // unique jti, stored here. authMiddleware joins on jti and
      // rejects if revoked_at is set or the row is missing entirely.
      // This lets an admin be cut off mid-session — required for
      // support workflows where compromise is detected or the admin
      // is demoted while logged in elsewhere.
      db.exec(`
        CREATE TABLE IF NOT EXISTS impersonation_tokens (
          jti          TEXT PRIMARY KEY,
          admin_id     INTEGER NOT NULL,
          target_id    INTEGER NOT NULL,
          reason       TEXT,
          ip_address   TEXT,
          user_agent   TEXT,
          issued_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at   DATETIME NOT NULL,
          revoked_at   DATETIME,
          revoked_by   INTEGER,
          FOREIGN KEY (admin_id)  REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (target_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_imp_admin ON impersonation_tokens(admin_id, revoked_at);
        CREATE INDEX IF NOT EXISTS idx_imp_target ON impersonation_tokens(target_id, revoked_at);
        CREATE INDEX IF NOT EXISTS idx_imp_expiry ON impersonation_tokens(expires_at);
      `);
    },
  },
  {
    version: 9,
    name: 'system_signals_bot',
    up(db) {
      // Free-tier delivery vehicle. trading_bots.user_id is NOT NULL, so the
      // system bot is owned by a non-loginable system user; signalScanner
      // checks bot.is_system and inserts the signal with user_id=NULL so
      // signalService.listForUser's `(user_id IS NULL OR user_id = ?)`
      // clause surfaces it to every free user automatically.
      //
      // Retired by v12 (retire_bots): database.js no longer creates
      // trading_bots, so on a fresh install this migration is a no-op; on a
      // legacy DB it still runs as it always did and v12 exports + drops.
      if (!tableExists(db, 'trading_bots')) return;
      const cols = db.prepare("PRAGMA table_info('trading_bots')").all().map((c) => c.name);
      if (!cols.includes('is_system')) {
        db.exec("ALTER TABLE trading_bots ADD COLUMN is_system INTEGER DEFAULT 0");
      }

      const SYSTEM_EMAIL = 'system@chmup.top';
      let sysRow = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
      if (!sysRow) {
        // password_hash is set to a literal that bcrypt.compare can never
        // match, so the account is not loginable through any normal path.
        const crypto = require('crypto');
        const refCode = 'SYS' + crypto.randomBytes(3).toString('hex').toUpperCase();
        db.prepare(`
          INSERT INTO users (email, password_hash, display_name, referral_code, email_verified, is_active)
          VALUES (?, ?, ?, ?, 1, 1)
        `).run(SYSTEM_EMAIL, '!SYSTEM-NO-LOGIN!', 'CHM Signals', refCode);
        sysRow = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_EMAIL);
      }

      const existingBot = db.prepare('SELECT id FROM trading_bots WHERE is_system = 1').get();
      if (!existingBot) {
        const symbols = JSON.stringify(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'ADA/USDT']);
        db.prepare(`
          INSERT INTO trading_bots
            (user_id, name, exchange, symbols, strategy, timeframe, direction,
             leverage, risk_pct, max_open_trades, auto_trade, trading_mode,
             is_active, is_system)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sysRow.id, 'CHM Public Signals', 'bybit', symbols,
          'levels', '1h', 'both',
          1, 1.0, 5, 0, 'paper',
          1, 1
        );
      }
    },
  },
  {
    version: 10,
    name: 'engine_core',
    // The bot's per-user model under the site's names (PLAN §2.1):
    // trader_settings (bot users minus identity/keys/dead columns, dataclass
    // defaults), signal_trades (bot trades verbatim + 11 indexes), engine_kv
    // (bot kv), trade_events, plan_changes. Column lists: models/engineSchema.js.
    up(db) {
      db.exec(engineSchema.traderSettingsDDL());
      db.exec(engineSchema.signalTradesDDL());
      db.exec(engineSchema.ENGINE_KV_DDL);
      db.exec(engineSchema.TRADE_EVENTS_DDL);
      db.exec(engineSchema.PLAN_CHANGES_DDL);
    },
  },
  {
    version: 11,
    name: 'genome',
    // genome_population / genome_history / optimizer_params — verbatim
    // (genome-challenge-profiles.md §1.14).
    up(db) {
      db.exec(engineSchema.GENOME_DDL);
    },
  },
  {
    version: 12,
    name: 'retire_bots',
    // 1. export the per-bot product's tables + retired users columns to
    //    data/backups/legacy-<ts>.json (only when there is anything to export);
    // 2. DROP them (PLAN §2.1 list, children first);
    // 3. drop users.paper_starting_balance / users.public_profile;
    // 4. subscriptions → the two live plans (decision D1): elite/beginner → pro,
    //    starter → pro until its current expires_at (then the normal expiry
    //    check downgrades to free), expired/open-ended starter → free; each
    //    rewrite is logged in plan_changes. Pending payments and promo codes
    //    on a retired paid id become 'pro' (a grant is never downgraded);
    // 5. a default trader_settings row (onboarding_done = 0) for every user,
    //    with the sub_plan/sub_status/sub_expires mirror initialised from
    //    subscriptions (planService owns the mirror from here on).
    up(db) {
      const nowSec = Math.floor(Date.now() / 1000);

      // 1. export
      const exp = exportLegacy(db);
      if (!quiet()) logger.info('v12 legacy export', { file: exp.file, rows: exp.rows });

      // 2. drop legacy tables
      for (const t of engineSchema.LEGACY_TABLES) db.exec(`DROP TABLE IF EXISTS "${t}"`);

      // 3. retired users columns (SQLite ≥ 3.35 supports DROP COLUMN)
      for (const col of engineSchema.LEGACY_USER_COLUMNS) {
        if (columnExists(db, 'users', col)) db.exec(`ALTER TABLE users DROP COLUMN ${col}`);
      }

      // 4. subscriptions → free / pro (D1)
      const { normalizePlan } = require('../config/planFeatures');
      const logChange = db.prepare(`
        INSERT INTO plan_changes (ts, user_id, old_plan, new_plan, actor, reason)
        VALUES (?, ?, ?, ?, 'system:migration_v12', ?)
      `);
      const setPlan = db.prepare('UPDATE subscriptions SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const legacySubs = db.prepare(
        "SELECT id, user_id, plan, status, expires_at FROM subscriptions WHERE lower(plan) NOT IN ('free', 'pro')"
      ).all();
      for (const s of legacySubs) {
        const id = String(s.plan || '').trim().toLowerCase();
        let newPlan;
        let reason;
        if (id === 'starter') {
          const paidUntil = toUnixSeconds(s.expires_at);
          const live = s.status === 'active' && paidUntil > nowSec;
          newPlan = live ? 'pro' : 'free';
          reason = live
            ? 'D1: starter grandfathered to pro until expires_at'
            : 'D1: starter retired (not active or no expiry) → free';
        } else {
          newPlan = normalizePlan(id);   // elite / beginner → pro, unknown → free
          reason = `legacy plan id '${id}' → ${newPlan} (normalize_plan)`;
        }
        setPlan.run(newPlan, s.id);
        logChange.run(nowSec, s.user_id, s.plan, newPlan, reason);
      }
      if (tableExists(db, 'promo_codes')) {
        db.prepare("UPDATE promo_codes SET plan = 'pro' WHERE lower(plan) IN ('starter', 'elite', 'beginner')").run();
      }
      if (tableExists(db, 'payments')) {
        db.prepare("UPDATE payments SET plan = 'pro' WHERE status = 'pending' AND lower(plan) IN ('starter', 'elite', 'beginner')").run();
      }

      // 5. default trader_settings rows
      const users = db.prepare(`
        SELECT u.id, u.locale, s.plan, s.status, s.expires_at
        FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id
      `).all();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO trader_settings
          (user_id, created_at, updated_at, lang, sub_plan, sub_status, sub_expires, onboarding_done)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `);
      for (const u of users) {
        const plan = normalizePlan(u.plan);
        const until = toUnixSeconds(u.expires_at);
        const paid = plan === 'pro' && u.status === 'active' && until > nowSec;
        const lang = u.locale === 'en' ? 'en' : 'ru';
        if (paid) insert.run(u.id, nowSec, nowSec, lang, 'pro', 'active', until);
        else insert.run(u.id, nowSec, nowSec, lang, 'free', 'expired', 0);
      }
      if (!quiet()) {
        logger.info('v12 retire_bots applied', {
          subscriptionsRemapped: legacySubs.length, traderSettingsRows: users.length,
        });
      }
    },
  },
  {
    version: 13,
    name: 'public_track',
    // The landing's public paper track (GET /api/public/{stats,feed}): public_track (one row per
    // signal of the PUBLIC_TRACK_USER_IDS accounts: stage history, published state, change
    // counter) + public_track_meta (archive epoch, counter). services/publicTrack/store.js.
    up(db) {
      db.exec(engineSchema.PUBLIC_TRACK_DDL);
    },
  },
  {
    version: 14,
    name: 'trade_feedback',
    // The bot's trade_feedback table (db/schema.py) — the row every real result transition writes
    // (signalTradesRepo.setTradeResult → services/engine/tradeFeedback.js).
    up(db) {
      db.exec(engineSchema.TRADE_FEEDBACK_DDL);
    },
  },
];

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function currentVersion(db) {
  ensureTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row && row.v ? row.v : 0;
}

function run(db) {
  ensureTable(db);
  // Sanity: versions must be contiguous starting from 1
  for (let i = 0; i < MIGRATIONS.length; i += 1) {
    if (MIGRATIONS[i].version !== i + 1) {
      throw new Error('migration index ' + i + ' has version ' + MIGRATIONS[i].version + ', expected ' + (i + 1));
    }
  }
  const current = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (!pending.length) {
    if (process.env.DB_QUIET !== '1') logger.info('migrations up-to-date', { at: current });
    return { ran: 0, current };
  }
  for (const m of pending) {
    if (process.env.DB_QUIET !== '1') logger.info('running migration', { version: m.version, name: m.name });
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    try { tx(); }
    catch (e) {
      logger.error('migration failed', { version: m.version, name: m.name, err: e.message });
      throw e;
    }
  }
  return { ran: pending.length, current: pending[pending.length - 1].version };
}

module.exports = { run, currentVersion, MIGRATIONS, tableExists, columnExists, exportLegacy };
