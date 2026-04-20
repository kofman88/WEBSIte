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

const logger = require('../utils/logger');

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
      // 'commission' = existing 20%-of-payment row, 'signup_bonus' = new
      // fixed-$ pay-per-signup row unlocked by this block.
      if (!cols.includes('kind')) {
        db.exec("ALTER TABLE ref_rewards ADD COLUMN kind TEXT NOT NULL DEFAULT 'commission'");
      }
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

module.exports = { run, currentVersion, MIGRATIONS };
