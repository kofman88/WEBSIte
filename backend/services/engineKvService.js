/**
 * engineKvService — the bot's `kv` table (db_kv_get / db_kv_set /
 * db_kv_delete and the atomic per-day counter of miniapp_api._kv_incr_day)
 * on the site's `engine_kv` table (models/engineSchema.js). Keys are the
 * bot's verbatim namespace: volume_cfg_<uid>, challenge_<uid>,
 * analyze_count_<uid>_<day>, miniapp_feedback_<uid>_<day>, …
 */

'use strict';

const db = require('../models/database');

const nowSec = () => Date.now() / 1000;

function get(key) {
  const row = db.prepare('SELECT value FROM engine_kv WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

function set(key, value, { now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  db.prepare(`
    INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), String(value), t);
}

function del(key) {
  return db.prepare('DELETE FROM engine_kv WHERE key = ?').run(String(key)).changes;
}

function has(key) {
  return Boolean(db.prepare('SELECT 1 FROM engine_kv WHERE key = ?').get(String(key)));
}

/**
 * miniapp_api._kv_incr_day(prefix, uid): atomic daily counter
 * `<prefix>_<uid>_<unix day>` → new value (1 when the read fails).
 */
function incrDay(prefix, userId, { now = null } = {}) {
  const t = now === null || now === undefined ? nowSec() : now;
  const key = `${prefix}_${userId}_${Math.floor(t / 86400)}`;
  db.prepare(`
    INSERT INTO engine_kv (key, value, updated_at) VALUES (?, '1', ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
  `).run(key, t);
  const row = db.prepare('SELECT value FROM engine_kv WHERE key = ?').get(key);
  const n = row ? parseInt(row.value, 10) : 1;
  return Number.isFinite(n) ? n : 1;
}

module.exports = { get, set, del, has, incrDay };
