/**
 * Web Push via VAPID — optional. Requires WEB_PUSH_PUBLIC_KEY +
 * WEB_PUSH_PRIVATE_KEY in env (generate once with `npx web-push
 * generate-vapid-keys` or /utils/generate-vapid.js). The public key
 * is served at GET /api/push/vapid-key so the browser can build its
 * subscription against it.
 *
 * Without the env vars / without @sentry/node-like optional
 * installation of web-push, this module degrades to no-ops.
 */

const db = require('../models/database');
const logger = require('../utils/logger');

let webpush = null;
let configured = false;

try {
  // eslint-disable-next-line global-require, import/no-unresolved
  webpush = require('web-push');
} catch (_e) { /* web-push not installed */ }

function _init() {
  if (configured) return true;
  if (!webpush) return false;
  const pub = process.env.WEB_PUSH_PUBLIC_KEY;
  const priv = process.env.WEB_PUSH_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT || ('mailto:' + (process.env.SMTP_FROM || 'security@chmup.top'));
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
    return true;
  } catch (e) {
    logger.warn('web-push init failed', { err: e.message });
    return false;
  }
}

function isEnabled() { return _init(); }
function publicKey() { return process.env.WEB_PUSH_PUBLIC_KEY || ''; }

function saveSubscription(userId, sub, userAgent) {
  if (!sub || !sub.endpoint || !sub.keys) { const e = new Error('invalid subscription'); e.statusCode = 400; throw e; }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
  `).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null);
  return { saved: true };
}

function removeSubscription(endpoint) {
  const info = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  return { removed: info.changes };
}

function listForUser(userId) {
  return db.prepare(`SELECT endpoint, user_agent, created_at, last_used_at FROM push_subscriptions WHERE user_id = ?`).all(userId);
}

async function sendToUser(userId, { title, body, url = null, tag = null } = {}) {
  if (!_init()) return { sent: 0, reason: 'not_configured' };
  const subs = db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`).all(userId);
  if (!subs.length) return { sent: 0 };
  const payload = JSON.stringify({ title, body: body || '', url: url || '/dashboard.html', tag: tag || 'chm' });
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 },
      );
      db.prepare(`UPDATE push_subscriptions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(s.id);
      ok += 1;
    } catch (e) {
      // 404 / 410 from push service = subscription expired, drop it.
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(s.id);
        logger.info('push subscription expired, removed', { id: s.id });
      } else {
        logger.warn('push send failed', { id: s.id, err: e.message, status: e.statusCode });
      }
    }
  }
  return { sent: ok, total: subs.length };
}

module.exports = { isEnabled, publicKey, saveSubscription, removeSubscription, listForUser, sendToUser };
