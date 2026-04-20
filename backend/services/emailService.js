/**
 * Email service — tries SMTP via nodemailer when configured, falls back
 * to logger output so dev / unconfigured environments never crash.
 *
 *   Enable SMTP by setting these in backend/.env:
 *     SMTP_HOST          smtp.yourprovider.com
 *     SMTP_PORT          587  (or 465 for TLS)
 *     SMTP_USER          your@email.com
 *     SMTP_PASS          app-password
 *     SMTP_FROM          CHM Finance <no-reply@chmup.top>
 *     APP_URL            https://chmup.top   (for building email links)
 *
 * Without these env vars the app still runs; calls to send*() log to
 * winston at INFO level with the full body so you can still follow flows.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

let _transport = null;
let _tried = false;

function transport() {
  if (_tried) return _transport;
  _tried = true;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER) {
    logger.info('emailService: SMTP not configured — running in log-only mode');
    return null;
  }
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const nodemailer = require('nodemailer');
    _transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    logger.info('emailService: SMTP configured', { host: SMTP_HOST });
    return _transport;
  } catch (err) {
    logger.warn('emailService: nodemailer not installed — install with `npm i nodemailer` to enable', { err: err.message });
    return null;
  }
}

function appUrl() { return (process.env.APP_URL || 'https://chmup.top').replace(/\/$/, ''); }

async function send({ to, subject, html, text }) {
  // Suppression check — don't bother SMTP for addresses that already
  // hard-bounced. Saves reputation + avoids Gmail blocklisting.
  try {
    const db = require('../models/database');
    const row = db.prepare(`SELECT 1 FROM email_bounces WHERE email = ? AND suppressed = 1 LIMIT 1`).get(to);
    if (row) {
      logger.info('email suppressed — prior bounce', { to, subject });
      return { delivered: false, suppressed: true };
    }
  } catch (_e) { /* table may not exist yet in early tests */ }

  const from = process.env.SMTP_FROM || 'CHM Finance <no-reply@chmup.top>';
  const t = transport();
  if (!t) {
    logger.info('[email-dryrun]', { to, subject, preview: (text || html || '').slice(0, 300) });
    return { delivered: false, dryRun: true };
  }
  try {
    const info = await t.sendMail({ from, to, subject, text, html });
    logger.info('email sent', { to, subject, messageId: info.messageId });
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    logger.error('email send failed', { to, subject, err: err.message });
    // Hard bounces look like 5xx SMTP codes; soft like 4xx.
    try {
      const code = (err.responseCode || err.code || '').toString();
      const kind = /^5/.test(code) ? 'hard' : /^4/.test(code) ? 'soft' : null;
      if (kind) {
        const db = require('../models/database');
        module.exports.logBounce({ email: to, kind, smtpCode: code, reason: err.message });
      }
    } catch (_e) {}
    return { delivered: false, error: err.message };
  }
}

// ── Templates ──────────────────────────────────────────────────────────
function baseHtml(title, body, cta) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:-apple-system,'Inter',sans-serif;color:#E5E5E5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#121626;border:1px solid #1f2937;border-radius:16px;padding:32px">
        <tr><td style="font-size:22px;font-weight:600;color:#fff;letter-spacing:-.02em">CHM<span style="color:#5C80E3">.</span></td></tr>
        <tr><td style="padding:20px 0 8px;font-size:22px;font-weight:600;color:#fff">${escape(title)}</td></tr>
        <tr><td style="padding:0 0 24px;font-size:14px;line-height:1.6;color:rgba(255,255,255,.78)">${body}</td></tr>
        ${cta ? `<tr><td style="padding:8px 0 24px"><a href="${escape(cta.url)}" style="display:inline-block;background:linear-gradient(180deg,#2A5BE8,#1D4ED8 60%,#143797);color:#fff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-size:14px;font-weight:500">${escape(cta.label)}</a></td></tr>` : ''}
        <tr><td style="padding:16px 0 0;border-top:1px solid #1f2937;font-size:11px;color:rgba(255,255,255,.4)">Это письмо отправлено автоматически. Если вы не ожидали его — просто проигнорируйте.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
function escape(s){return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}

function sendVerification(to, token, { displayName } = {}) {
  const templates = require('./emailTemplates');
  const t = templates.emailVerify({
    displayName,
    verifyUrl: `${appUrl()}/verify-email.html?token=${encodeURIComponent(token)}`,
  });
  return send({ to, subject: t.subject, text: t.text, html: t.html });
}

function sendPasswordReset(to, token, { displayName, ipAddress } = {}) {
  const templates = require('./emailTemplates');
  const t = templates.passwordReset({
    displayName, ipAddress,
    resetUrl: `${appUrl()}/?reset=${encodeURIComponent(token)}`,
  });
  return send({ to, subject: t.subject, text: t.text, html: t.html });
}

function sendTradeAlert(to, { symbol, side, pnl, status }) {
  return send({
    to, subject: `${status === 'open' ? 'Сделка открыта' : 'Сделка закрыта'} · ${symbol} ${side.toUpperCase()} · CHM Finance`,
    text: `${symbol} ${side} — ${status}. PnL: ${pnl || '—'}`,
    html: baseHtml(`${status === 'open' ? 'Сделка открыта' : 'Сделка закрыта'}`,
      `<b>${escape(symbol)}</b> · ${escape(side.toUpperCase())} · PnL: ${escape(String(pnl || '—'))}`,
      { url: `${appUrl()}/dashboard.html`, label: 'Открыть дашборд' }),
  });
}

// ── Token helper ───────────────────────────────────────────────────────
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashToken(tok) { return crypto.createHash('sha256').update(tok).digest('hex'); }

// ── Bounce / suppression list ────────────────────────────────────────────
// Called from nodemailer callback or inbox-parser cron when we detect a
// bounce. Hard bounces suppress the address permanently; soft bounces
// are only suppressed after 3 in 72h (handled in shouldSuppress logic).
function logBounce({ email, kind = 'soft', smtpCode = null, reason = null }) {
  if (!email) return;
  const db = require('../models/database');
  let suppress = 0;
  if (kind === 'hard' || kind === 'complaint') suppress = 1;
  else {
    const recent = db.prepare(`
      SELECT COUNT(*) AS n FROM email_bounces
      WHERE email = ? AND kind = 'soft' AND created_at >= datetime('now','-3 day')
    `).get(email).n;
    if (recent >= 3) suppress = 1;
  }
  db.prepare(`
    INSERT INTO email_bounces (email, kind, smtp_code, reason, suppressed)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, kind, smtpCode, reason, suppress);
}
function isSuppressed(email) {
  if (!email) return false;
  const db = require('../models/database');
  return Boolean(db.prepare(`SELECT 1 FROM email_bounces WHERE email = ? AND suppressed = 1 LIMIT 1`).get(email));
}

module.exports = {
  send, sendVerification, sendPasswordReset, sendTradeAlert,
  randomToken, hashToken, appUrl,
  logBounce, isSuppressed,
  _transport: () => transport(),
};
