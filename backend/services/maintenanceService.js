/**
 * Maintenance — daily SQLite backup + periodic data retention cleanup.
 *
 * Runs as an in-process cron via setInterval (not a separate worker). On
 * boot we schedule both jobs and run them once after a short delay to
 * catch up if the server was down when the wall-clock tick would have
 * fired.
 *
 * Backups: `sqlite3 .backup` via better-sqlite3's backup() API — atomic,
 * WAL-safe. Stored in ./data/backups/chmup-YYYYMMDD.db, 30 files kept.
 *
 * Retention: delete rows older than N days from tables that grow
 * unbounded (audit_log, signals, notifications, login_history).
 * Leaves trades/payments alone (those are business records).
 */

const fs = require('fs');
const path = require('path');
const db = require('../models/database');
const config = require('../config');
const logger = require('../utils/logger');

const BACKUP_DIR = path.join(path.dirname(config.databasePath || './data/chmup.db'), 'backups');
const BACKUP_RETENTION_DAYS = 30;
const DATA_RETENTION = {
  audit_log: 90,
  signals: 60,
  notifications: 60,
  login_history: 180,
  email_verifications: 30,
  password_resets: 30,
};

let _backupTimer = null;
let _retentionTimer = null;

function _ensureDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (_e) {}
}

function _fmtDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

async function runBackup() {
  _ensureDir();
  const dest = path.join(BACKUP_DIR, 'chmup-' + _fmtDate(new Date()) + '.db');
  try {
    await db.backup(dest);
    logger.info('db backup ok', { dest });
  } catch (e) {
    logger.error('db backup failed', { err: e.message });
    return;
  }
  // Prune old backups
  try {
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86_400_000;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (!/^chmup-\d{8}\.db$/.test(f)) continue;
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) { fs.unlinkSync(full); logger.info('pruned old backup', { file: f }); }
    }
  } catch (e) { logger.warn('backup prune failed', { err: e.message }); }
}

function runRetention() {
  for (const [table, days] of Object.entries(DATA_RETENTION)) {
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      // Different tables use different column names — probe both.
      const info = db.prepare("SELECT name FROM pragma_table_info(?)").all(table);
      const cols = new Set(info.map((c) => c.name));
      const tsCol = cols.has('created_at') ? 'created_at' : cols.has('expires_at') ? 'expires_at' : null;
      if (!tsCol) continue;
      const r = db.prepare(`DELETE FROM ${table} WHERE ${tsCol} < ?`).run(cutoff);
      if (r.changes > 0) logger.info('retention: purged rows', { table, changes: r.changes, olderThanDays: days });
    } catch (e) {
      logger.warn('retention table skipped', { table, err: e.message });
    }
  }
  // Also vacuum periodically so the DB file doesn't keep ballooning.
  try { db.exec('PRAGMA incremental_vacuum'); } catch (_e) {}
}

function start() {
  if (process.env.MAINTENANCE_DISABLED === '1' || process.env.VITEST === 'true') {
    logger.info('maintenance disabled');
    return;
  }
  // Kick once shortly after boot, then on a 24h cadence.
  setTimeout(() => { runBackup().catch(() => {}); runRetention(); }, 60_000);
  _backupTimer = setInterval(() => { runBackup().catch(() => {}); }, 24 * 60 * 60 * 1000);
  _retentionTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
  logger.info('maintenance started', { backupDir: BACKUP_DIR });
}

function stop() {
  if (_backupTimer) { clearInterval(_backupTimer); _backupTimer = null; }
  if (_retentionTimer) { clearInterval(_retentionTimer); _retentionTimer = null; }
}

module.exports = { start, stop, runBackup, runRetention };
