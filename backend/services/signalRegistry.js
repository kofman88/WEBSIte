/**
 * Signal registry — prevents duplicate signal emissions.
 *
 * A "fingerprint" is a short hash of (exchange, symbol, strategy, side,
 * entry-bucket, timeframe). If a signal with the same fingerprint exists
 * in `signal_registry` and hasn't expired → the new one is rejected.
 *
 * Bucketing price: round entry to 0.1% of its magnitude (so micro-changes
 * in entry don't bypass the dedup).
 *
 * Used by signalScanner worker BEFORE inserting a new row into `signals`.
 */

const crypto = require('crypto');
const db = require('../models/database');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function bucketPrice(price) {
  if (!Number.isFinite(price) || price === 0) return 0;
  // 0.1% bucket: price ~100 → bucket 100, 1000 → 1000, 0.1 → 0.1 (smooth magnitude)
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(price))) - 3);
  return Math.round(price / magnitude) * magnitude;
}

/**
 * Compute a deterministic fingerprint.
 * @param {object} sig  Fields: exchange, symbol, strategy, side, entry, timeframe
 */
function fingerprint({ exchange, symbol, strategy, side, entry, timeframe }) {
  const bucket = bucketPrice(entry);
  const key = `${exchange}|${symbol}|${strategy}|${side}|${bucket}|${timeframe}`;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/**
 * Check whether a signal with this fingerprint is already registered and alive.
 * @returns {boolean} true if it's a duplicate (rejection).
 */
function isDuplicate(fp, now = Date.now()) {
  const row = db.prepare(
    `SELECT expires_at FROM signal_registry WHERE fingerprint = ?`
  ).get(fp);
  if (!row) return false;
  return new Date(row.expires_at).getTime() > now;
}

/**
 * Register a new signal fingerprint. Call AFTER inserting into `signals`.
 * Returns true on insert, false if a live duplicate already existed.
 */
function register(fp, signalId, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();

  // Atomic upsert: insert, or update if expired
  const existing = db.prepare(
    `SELECT id, expires_at FROM signal_registry WHERE fingerprint = ?`
  ).get(fp);

  if (!existing) {
    db.prepare(`
      INSERT INTO signal_registry (fingerprint, signal_id, expires_at)
      VALUES (?, ?, ?)
    `).run(fp, signalId, expiresAt);
    return true;
  }
  if (new Date(existing.expires_at).getTime() <= now) {
    // expired — take it over
    db.prepare(`
      UPDATE signal_registry SET signal_id = ?, created_at = CURRENT_TIMESTAMP, expires_at = ?
      WHERE fingerprint = ?
    `).run(signalId, expiresAt, fp);
    return true;
  }
  return false; // live duplicate
}

/**
 * Remove expired fingerprints. Call from cron (hourly).
 */
function cleanupExpired() {
  const result = db.prepare(
    `DELETE FROM signal_registry WHERE expires_at < CURRENT_TIMESTAMP`
  ).run();
  return result.changes;
}

module.exports = {
  fingerprint,
  isDuplicate,
  register,
  cleanupExpired,
  _bucketPrice: bucketPrice,
};
