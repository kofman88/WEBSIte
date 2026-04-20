/**
 * notifier — one entrypoint for "tell this user something happened".
 *
 * Fans out to the three delivery channels based on user preferences:
 *   1. In-app (always written to notifications table so bell-icon counts)
 *   2. Email (if user.email_verified + prefs.email[type] !== false)
 *   3. Telegram (if telegram_chat_id set + prefs.telegram[type] !== false)
 *
 * Preferences live as JSON in users.notification_prefs:
 *   {
 *     email:    { trade_opened: true, trade_closed: true, signal: false, payment: true, referral: true, weekly_digest: true },
 *     telegram: { trade_opened: true, trade_closed: true, signal: true,  payment: true, referral: true }
 *   }
 * Missing keys default to `true`. Users can opt out per type in Settings.
 */

const db = require('../models/database');
const notifications = require('./notificationsService');
const emailService = require('./emailService');
const telegramService = require('./telegramService');
const logger = require('../utils/logger');

const DEFAULT_PREFS = {
  email:    { trade_opened: true, trade_closed: true, signal: false, payment: true, referral: true, security: true, weekly_digest: true },
  telegram: { trade_opened: true, trade_closed: true, signal: true,  payment: true, referral: true, security: true },
};

function getPrefs(userId) {
  const row = db.prepare('SELECT notification_prefs FROM users WHERE id = ?').get(userId);
  if (!row || !row.notification_prefs) return DEFAULT_PREFS;
  try {
    const p = JSON.parse(row.notification_prefs);
    return {
      email:    { ...DEFAULT_PREFS.email,    ...(p.email    || {}) },
      telegram: { ...DEFAULT_PREFS.telegram, ...(p.telegram || {}) },
    };
  } catch (_e) { return DEFAULT_PREFS; }
}

function savePrefs(userId, prefs) {
  const merged = {
    email:    { ...DEFAULT_PREFS.email,    ...((prefs && prefs.email)    || {}) },
    telegram: { ...DEFAULT_PREFS.telegram, ...((prefs && prefs.telegram) || {}) },
  };
  db.prepare('UPDATE users SET notification_prefs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(merged), userId);
  return merged;
}

function defaults() { return DEFAULT_PREFS; }

/**
 * Dispatch a notification to all enabled channels.
 *
 * @param {number} userId
 * @param {Object} opts
 * @param {string} opts.type      — stable key ('trade_opened', 'payment', …)
 * @param {string} opts.title     — short in-app + email subject
 * @param {string} [opts.body]    — longer description
 * @param {string} [opts.link]    — relative URL for in-app click
 * @param {string} [opts.emailHtml] — optional full HTML body for email
 * @param {string} [opts.tgText]  — optional HTML for Telegram (uses title+body if absent)
 */
async function dispatch(userId, opts) {
  const { type, title, body = null, link = null, emailHtml = null, tgText = null } = opts;
  if (!userId || !type || !title) return { error: 'invalid_args' };

  const user = db.prepare('SELECT email, email_verified FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user) return { error: 'user_not_found' };
  const prefs = getPrefs(userId);

  // 1. In-app (always)
  try { notifications.create(userId, { type, title, body, link }); }
  catch (err) { logger.warn('in-app notification failed', { userId, type, err: err.message }); }

  // 2. Email (verified + not opted out)
  if (user.email_verified && prefs.email[type] !== false) {
    emailService.send({
      to: user.email,
      subject: title,
      text: body || title,
      html: emailHtml || fallbackEmailHtml(title, body, link),
    }).catch((err) => logger.warn('email dispatch failed', { userId, type, err: err.message }));
  }

  // 3. Telegram (linked + not opted out)
  if (prefs.telegram[type] !== false) {
    const text = tgText || `<b>${escapeHtml(title)}</b>${body ? '\n' + escapeHtml(body) : ''}`;
    telegramService.send(userId, text, { parseMode: 'HTML' })
      .catch((err) => logger.warn('telegram dispatch failed', { userId, type, err: err.message }));
  }

  return { dispatched: true };
}

function fallbackEmailHtml(title, body, link) {
  const cta = link ? `<p style="margin:24px 0"><a href="${escapeAttr(link.startsWith('http') ? link : (process.env.APP_URL || 'https://chmup.top') + link)}" style="background:linear-gradient(180deg,#2A5BE8,#1D4ED8 60%,#143797);color:#fff;padding:12px 24px;border-radius:9999px;text-decoration:none;font-weight:500">Открыть</a></p>` : '';
  return `<div style="font-family:-apple-system,'Inter',sans-serif;color:#E5E5E5;background:#0A0A0A;padding:32px">
    <div style="max-width:560px;margin:0 auto;background:#121626;border-radius:16px;padding:32px;border:1px solid #1f2937">
      <div style="font-size:22px;font-weight:600;color:#fff">CHM<span style="color:#5C80E3">.</span></div>
      <h2 style="font-size:20px;margin:16px 0 8px;color:#fff">${escapeHtml(title)}</h2>
      ${body ? `<p style="color:rgba(255,255,255,.78);line-height:1.6">${escapeHtml(body)}</p>` : ''}
      ${cta}
      <p style="font-size:11px;color:rgba(255,255,255,.4);margin-top:24px;border-top:1px solid #1f2937;padding-top:16px">Отключить такие письма можно в Settings → Уведомления.</p>
    </div>
  </div>`;
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

module.exports = { dispatch, getPrefs, savePrefs, defaults };
