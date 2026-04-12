/**
 * emailService.js — Premium Email Service for CHM Finance
 * Uses system sendmail (available on cPanel)
 * Sends from: no-reply@chmup.top
 */

const { execFile } = require('child_process');
const log = require('../utils/logger')('Email');

const FROM_EMAIL = 'no-reply@chmup.top';
const FROM_NAME = 'CHM Finance';
const SITE_URL = 'https://chmup.top';

/**
 * Send an email using sendmail
 */
function sendEmail(to, subject, htmlBody) {
  return new Promise((resolve, reject) => {
    const boundary = 'CHM_' + Date.now().toString(36) + '_boundary';
    const plainText = htmlBody
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/td>/gi, '  ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&middot;/g, '·')
      .replace(/&copy;/g, '©')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const htmlBase64 = Buffer.from(htmlBody, 'utf-8').toString('base64');
    // Split base64 into 76-char lines (RFC 2045)
    const htmlBase64Lines = htmlBase64.match(/.{1,76}/g).join('\n');

    const message = [
      `From: =?UTF-8?B?${Buffer.from(FROM_NAME).toString('base64')}?= <${FROM_EMAIL}>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      `X-Mailer: CHM Finance Platform`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(plainText, 'utf-8').toString('base64').match(/.{1,76}/g).join('\n'),
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      htmlBase64Lines,
      ``,
      `--${boundary}--`,
    ].join('\r\n');

    const sendmail = execFile('/sbin/sendmail', ['-t', '-f', FROM_EMAIL], { timeout: 15000 }, (err) => {
      if (err) {
        log.error(`Send failed to ${to}: ${err.message}`);
        reject(err);
      } else {
        log.info(`Email sent to ${to}: ${subject}`);
        resolve(true);
      }
    });
    sendmail.stdin.write(message);
    sendmail.stdin.end();
  });
}

/**
 * Send email verification link
 */
async function sendVerificationEmail(to, token) {
  const verifyUrl = `${SITE_URL}/api/auth/verify-email?token=${token}`;
  const html = _template({
    preheader: 'Подтвердите email для CHM Finance',
    title: 'Подтвердите email',
    body: `
      <p style="font-size:16px;color:#FFFFFF;margin-bottom:24px;">Добро пожаловать в <strong>CHM Finance</strong>!</p>
      <p style="color:#8E8E93;margin-bottom:24px;">Нажмите кнопку ниже, чтобы подтвердить ваш email и получить полный доступ к платформе.</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#C850C0,#FF6B35);color:#FFFFFF;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Подтвердить email</a>
      </div>
      <p style="color:#5E5E63;font-size:13px;">Или скопируйте ссылку:</p>
      <p style="background:#1A1A1E;border:1px solid #2C2C30;border-radius:8px;padding:12px;font-size:12px;color:#FF8C00;word-break:break-all;">${verifyUrl}</p>
      <p style="color:#5E5E63;font-size:13px;margin-top:24px;">Ссылка действительна 24 часа. Если вы не регистрировались на CHM Finance — просто проигнорируйте это письмо.</p>
    `,
  });
  return sendEmail(to, '✅ Подтвердите email — CHM Finance', html);
}

/**
 * Send password reset link
 */
async function sendPasswordResetEmail(to, token) {
  const resetUrl = `${SITE_URL}/?reset=${token}`;
  const html = _template({
    preheader: 'Сброс пароля CHM Finance',
    title: 'Сброс пароля',
    body: `
      <p style="color:#8E8E93;margin-bottom:24px;">Вы запросили сброс пароля для вашего аккаунта CHM Finance.</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${resetUrl}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#C850C0,#FF6B35);color:#FFFFFF;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Сбросить пароль</a>
      </div>
      <p style="color:#5E5E63;font-size:13px;">Ссылка действительна 1 час. Если вы не запрашивали сброс — проигнорируйте это письмо.</p>
    `,
  });
  return sendEmail(to, '🔑 Сброс пароля — CHM Finance', html);
}

/**
 * Send welcome email after verification
 */
async function sendWelcomeEmail(to) {
  const html = _template({
    preheader: 'Добро пожаловать в CHM Finance!',
    title: 'Добро пожаловать!',
    body: `
      <p style="font-size:16px;color:#FFFFFF;margin-bottom:16px;">Ваш email подтверждён! 🎉</p>
      <p style="color:#8E8E93;margin-bottom:24px;">Теперь вам доступны все функции платформы CHM Finance.</p>
      <div style="background:#1A1A1E;border:1px solid #2C2C30;border-radius:12px;padding:20px;margin-bottom:24px;">
        <p style="font-weight:700;color:#FFFFFF;margin-bottom:12px;">Что дальше:</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;color:#FF8C00;width:24px;">1.</td><td style="padding:6px 0;color:#8E8E93;">Подключите биржу (Bybit, Binance, BingX, OKX)</td></tr>
          <tr><td style="padding:6px 0;color:#FF8C00;width:24px;">2.</td><td style="padding:6px 0;color:#8E8E93;">Создайте бота с выбранной стратегией</td></tr>
          <tr><td style="padding:6px 0;color:#FF8C00;width:24px;">3.</td><td style="padding:6px 0;color:#8E8E93;">Следите за сигналами и результатами 24/7</td></tr>
        </table>
      </div>
      <div style="text-align:center;margin:32px 0;">
        <a href="${SITE_URL}/dashboard.html" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#C850C0,#FF6B35);color:#FFFFFF;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Открыть дашборд</a>
      </div>
    `,
  });
  return sendEmail(to, '🚀 Добро пожаловать в CHM Finance!', html);
}

/**
 * Send subscription activated email
 */
async function sendSubscriptionEmail(to, plan, expiresAt) {
  const planNames = { starter: 'Starter', pro: 'Pro', elite: 'Elite' };
  const planColors = { starter: '#00C853', pro: '#3B82F6', elite: '#FF8C00' };
  const html = _template({
    preheader: `Подписка ${planNames[plan] || plan} активирована`,
    title: 'Подписка активирована',
    body: `
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:${planColors[plan] || '#FF8C00'}15;border:2px solid ${planColors[plan] || '#FF8C00'}40;border-radius:16px;padding:24px 48px;">
          <p style="font-size:14px;color:${planColors[plan] || '#FF8C00'};font-weight:700;margin-bottom:4px;">${(planNames[plan] || plan).toUpperCase()} PLAN</p>
          <p style="font-size:32px;font-weight:800;color:#FFFFFF;margin:0;">Активирован ✅</p>
        </div>
      </div>
      <p style="color:#8E8E93;margin-bottom:24px;text-align:center;">Ваша подписка действует до: <strong style="color:#FFFFFF;">${expiresAt ? new Date(expiresAt).toLocaleDateString('ru') : 'бессрочно'}</strong></p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${SITE_URL}/dashboard.html" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#C850C0,#FF6B35);color:#FFFFFF;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;">Перейти к торговле</a>
      </div>
    `,
  });
  return sendEmail(to, `✨ Подписка ${planNames[plan] || plan} — CHM Finance`, html);
}

// ── Premium HTML email template ──────────────────────────────────────────

function _template({ preheader, title, body }) {
  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0D0D0F;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="display:none;font-size:1px;color:#0D0D0F;max-height:0;overflow:hidden;">${preheader}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D0D0F;">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <!-- Logo -->
        <tr><td style="padding:0 0 32px;text-align:center;">
          <span style="font-size:28px;font-weight:800;color:#FFFFFF;letter-spacing:0.05em;">CHM</span><span style="font-size:28px;font-weight:800;color:#FF8C00;">.</span>
        </td></tr>
        <!-- Card -->
        <tr><td style="background:#131316;border:1px solid #2C2C30;border-radius:16px;padding:40px;">
          <h1 style="font-size:24px;font-weight:800;color:#FFFFFF;margin:0 0 24px;text-align:center;">${title}</h1>
          ${body}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:32px 0 0;text-align:center;">
          <p style="font-size:12px;color:#5E5E63;margin:0 0 8px;">CHM Finance — AI-powered крипто-торговая платформа</p>
          <p style="font-size:11px;color:#3A3A3E;margin:0;">
            <a href="${SITE_URL}" style="color:#5E5E63;text-decoration:none;">chmup.top</a> &middot;
            <a href="https://t.me/crypto_chm" style="color:#5E5E63;text-decoration:none;">Telegram</a> &middot;
            <a href="${SITE_URL}/academy/" style="color:#5E5E63;text-decoration:none;">Академия</a>
          </p>
          <p style="font-size:10px;color:#2C2C30;margin:16px 0 0;">&copy; 2024-2026 CHM Finance. Все права защищены.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendSubscriptionEmail,
};
