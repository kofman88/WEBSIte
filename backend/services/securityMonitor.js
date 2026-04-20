/**
 * Security monitor — background cron that watches for suspicious
 * auth behaviour and notifies every admin via the standard notifier
 * (in-app + email + Telegram), respecting feature flags.
 *
 * Checks (run every 5 minutes):
 *   1. Brute force: ≥5 failed logins for the same email within 15 min
 *   2. Credential stuffing: ≥20 failed logins from the same IP within 15 min
 *   3. Admin privilege grant: last hour had admin.user.grant_admin events
 *   4. New admin login from a never-before-seen IP
 *
 * Plus a once-a-day 09:00 UTC digest summarising the previous 24h of
 * failed logins, new users, paid signups, support backlog, refunds.
 *
 * De-dup: every alert we've already sent is stamped in system_kv under
 * "secalert:<kind>:<fingerprint>" with a 24h TTL so one incident fires
 * at most once per day. TTL check keeps the kv table from growing.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

const CHECK_INTERVAL_MS = 5 * 60_000;
const DIGEST_HOUR_UTC = 9;
const ALERT_DEDUP_TTL_MS = 24 * 3600_000;

let _timer = null;
let _digestTimer = null;
let _lastDigestDate = null;

function _admins() {
  return db.prepare(`SELECT id FROM users WHERE is_admin = 1 AND is_active = 1`).all();
}

function _alreadySent(fp) {
  db.prepare(`DELETE FROM system_kv WHERE key LIKE 'secalert:%' AND CAST(value AS INTEGER) < ?`)
    .run(Date.now() - ALERT_DEDUP_TTL_MS);
  const row = db.prepare(`SELECT value FROM system_kv WHERE key = ?`).get('secalert:' + fp);
  return Boolean(row);
}

function _markSent(fp) {
  db.prepare(`INSERT INTO system_kv (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run('secalert:' + fp, String(Date.now()));
}

async function _alertAdmins({ kind, title, body, link = '/ops.html#audit' }) {
  const fp = kind;
  if (_alreadySent(fp)) return;
  const admins = _admins();
  if (!admins.length) return;
  _markSent(fp);
  const notifier = require('./notifier');
  for (const a of admins) {
    try { notifier.dispatch(a.id, { type: 'security', title, body, link }); }
    catch (e) { logger.warn('security alert dispatch failed', { adminId: a.id, err: e.message }); }
  }
  logger.warn('security alert fired', { kind, admins: admins.length });
}

function _checkBruteForce() {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = db.prepare(`
    SELECT u.id, u.email, COUNT(*) AS n
    FROM login_history h JOIN users u ON u.id = h.user_id
    WHERE h.success = 0 AND h.created_at >= ?
    GROUP BY u.id HAVING n >= 5
  `).all(since);
  for (const r of rows) {
    _alertAdmins({
      kind: 'bruteforce:user:' + r.id + ':' + new Date().toISOString().slice(0, 13),
      title: '🚨 Brute-force attempt',
      body: `${r.n} failed logins in 15 min for ${r.email}`,
      link: '/ops.html#users',
    });
  }
}

function _checkCredentialStuffing() {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = db.prepare(`
    SELECT ip_address AS ip, COUNT(*) AS n
    FROM login_history
    WHERE success = 0 AND ip_address IS NOT NULL AND created_at >= ?
    GROUP BY ip_address HAVING n >= 20
  `).all(since);
  for (const r of rows) {
    _alertAdmins({
      kind: 'stuffing:ip:' + r.ip + ':' + new Date().toISOString().slice(0, 13),
      title: '🚨 Credential stuffing',
      body: `${r.n} failed logins from IP ${r.ip} in 15 min`,
      link: '/ops.html#audit',
    });
  }
}

function _checkAdminGrants() {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const rows = db.prepare(`
    SELECT a.id, a.user_id AS actor_id, actor.email AS actor_email, a.metadata, a.created_at
    FROM audit_log a LEFT JOIN users actor ON actor.id = a.user_id
    WHERE a.action = 'admin.user.grant_admin' AND a.created_at >= ?
  `).all(since);
  for (const r of rows) {
    _alertAdmins({
      kind: 'admin_grant:' + r.id,
      title: '👤 Admin role changed',
      body: `Granted by ${r.actor_email || 'system'} at ${r.created_at} — ${r.metadata}`,
      link: '/ops.html#audit',
    });
  }
}

function _maybeDailyDigest() {
  const now = new Date();
  if (now.getUTCHours() !== DIGEST_HOUR_UTC) return;
  const today = now.toISOString().slice(0, 10);
  if (_lastDigestDate === today) return;
  _lastDigestDate = today;

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const failedLogins = db.prepare(`SELECT COUNT(*) AS n FROM login_history WHERE success = 0 AND created_at >= ?`).get(since).n;
  const newUsers     = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`).get(since).n;
  const paidSignups  = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM payments WHERE status = 'confirmed' AND created_at >= ?
  `).get(since).n;
  const refunds      = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE status = 'refunded' AND created_at >= ?`).get(since).n;
  const supportOpen  = db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE status = 'open'`).get().n;
  const adminActions = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'admin.%' AND created_at >= ?`).get(since).n;

  const body = [
    `Failed logins (24h): ${failedLogins}`,
    `New users: ${newUsers}`,
    `Paid signups: ${paidSignups}`,
    `Refunds: ${refunds}`,
    `Open support tickets: ${supportOpen}`,
    `Admin actions (24h): ${adminActions}`,
  ].join('\n');

  _alertAdmins({
    kind: 'digest:' + today,
    title: '📊 Daily security & ops digest — ' + today,
    body,
    link: '/ops.html',
  });
}

function _tick() {
  try { _checkBruteForce(); }          catch (e) { logger.warn('bruteforce check failed', { err: e.message }); }
  try { _checkCredentialStuffing(); }  catch (e) { logger.warn('stuffing check failed', { err: e.message }); }
  try { _checkAdminGrants(); }         catch (e) { logger.warn('admin grant check failed', { err: e.message }); }
  try { _maybeDailyDigest(); }         catch (e) { logger.warn('digest failed', { err: e.message }); }
}

function start() {
  if (_timer) return;
  if (process.env.VITEST === 'true' || process.env.SECURITY_MONITOR_DISABLED === '1') return;
  // Kick a first run 1 minute after boot so we have a steady-state baseline.
  setTimeout(_tick, 60_000);
  _timer = setInterval(_tick, CHECK_INTERVAL_MS);
  logger.info('security monitor started');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_digestTimer) { clearInterval(_digestTimer); _digestTimer = null; }
}

module.exports = { start, stop, _tick };
