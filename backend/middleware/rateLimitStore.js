/**
 * An express-rate-limit store in the site's SQLite DB (table rate_limit_hits, migration v16).
 *
 * express-rate-limit's default MemoryStore counts per process. Production runs under Passenger,
 * which starts several processes and stops idle ones: an in-memory budget is multiplied by the
 * process count and reset by every restart. For the limiters that guard a secret (the 2FA code
 * checks, middleware/auth.js createTwoFactorLimiter) that matters, so they count here: one row per
 * key, one atomic UPSERT per hit (the window restarts when the stored one has ended), shared by
 * every process and kept across restarts.
 */

const db = require('../models/database');

class SqliteRateLimitStore {
  /** @param {{ prefix: string }} opts  a prefix per limiter (rows of different limiters never mix) */
  constructor({ prefix }) {
    if (!prefix) throw new Error('SqliteRateLimitStore needs a prefix');
    this.prefix = prefix;
    this.localKeys = false;
    this.windowMs = 60_000;
    this._hits = 0;
  }

  init(options) { this.windowMs = options.windowMs; }

  _key(key) { return this.prefix + key; }

  async get(key) {
    const r = db.prepare('SELECT hits, reset_at FROM rate_limit_hits WHERE key = ?').get(this._key(key));
    if (!r || r.reset_at <= Date.now()) return undefined;
    return { totalHits: r.hits, resetTime: new Date(r.reset_at) };
  }

  async increment(key) {
    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO rate_limit_hits (key, hits, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        hits     = CASE WHEN rate_limit_hits.reset_at <= ? THEN 1 ELSE rate_limit_hits.hits + 1 END,
        reset_at = CASE WHEN rate_limit_hits.reset_at <= ? THEN excluded.reset_at ELSE rate_limit_hits.reset_at END
      RETURNING hits, reset_at
    `).get(this._key(key), now + this.windowMs, now, now);
    this._hits += 1;
    if (this._hits % 500 === 0) db.prepare('DELETE FROM rate_limit_hits WHERE reset_at <= ?').run(now);
    return { totalHits: r.hits, resetTime: new Date(r.reset_at) };
  }

  async decrement(key) {
    db.prepare('UPDATE rate_limit_hits SET hits = MAX(hits - 1, 0) WHERE key = ?').run(this._key(key));
  }

  async resetKey(key) {
    db.prepare('DELETE FROM rate_limit_hits WHERE key = ?').run(this._key(key));
  }

  async resetAll() {
    db.prepare("DELETE FROM rate_limit_hits WHERE substr(key, 1, ?) = ?").run(this.prefix.length, this.prefix);
  }
}

module.exports = { SqliteRateLimitStore };
