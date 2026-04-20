/**
 * Email templates — dark-themed branded HTML with CHM palette.
 *
 * Each template exports both { subject, html, text }. Plaintext fallback
 * is derived from the HTML body (no HTML tags) so mail clients that
 * block remote images still see the content.
 *
 * Inlined styles only — most mail clients (Outlook / Yahoo / old iOS)
 * ignore <style> blocks entirely. Kept to a single table for Outlook.
 *
 * No remote images — any logo is rendered as text to stay embed-free
 * and avoid spam-filter "contains tracking pixel" heuristics.
 */

const APP_URL = () => (process.env.APP_URL || 'https://chmup.top').replace(/\/$/, '');

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(s) { return escHtml(s); }

function toPlaintext(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/p>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

function shell(title, bodyHtml, opts = {}) {
  const preheader = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px">${escHtml(opts.preheader)}</div>` : '';
  const unsubHint = opts.showUnsub === false ? '' : `<p style="margin:24px 0 0;font-size:11px;color:#64748b;line-height:1.5">Эти письма отправляются о безопасности и статусе вашего аккаунта. Настроить каналы уведомлений — в <a href="${APP_URL()}/settings.html" style="color:#5C80E3;text-decoration:none">Настройках</a>.</p>`;
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#0A0A0A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,sans-serif;color:#E5E5E5">
${preheader}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0A0A0A"><tr><td align="center" style="padding:40px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#111114;border:1px solid #1e1e24;border-radius:14px;overflow:hidden">
    <tr><td style="padding:28px 32px 20px;border-bottom:1px solid #1e1e24">
      <div style="font-size:20px;font-weight:700;letter-spacing:-.02em;color:#fff">CHM<span style="color:#5C80E3">.</span></div>
      <div style="font-size:11px;color:#64748b;letter-spacing:.15em;text-transform:uppercase;margin-top:2px">CHM Finance</div>
    </td></tr>
    <tr><td style="padding:28px 32px;color:#E5E5E5;font-size:14px;line-height:1.65">
      ${bodyHtml}
      ${unsubHint}
    </td></tr>
    <tr><td style="padding:20px 32px;background:#0d0d11;border-top:1px solid #1e1e24;font-size:11px;color:#64748b;line-height:1.6">
      CHM Finance · алгоритмическая крипто-торговля<br>
      <a href="${APP_URL()}" style="color:#5C80E3;text-decoration:none">chmup.top</a> · <a href="${APP_URL()}/terms.html" style="color:#5C80E3;text-decoration:none">Terms</a> · <a href="${APP_URL()}/privacy.html" style="color:#5C80E3;text-decoration:none">Privacy</a> · <a href="${APP_URL()}/risk.html" style="color:#5C80E3;text-decoration:none">Risk disclosure</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function cta(label, href) {
  return `<p style="margin:28px 0"><a href="${escAttr(href)}" style="display:inline-block;background:#1D4ED8;background:linear-gradient(180deg,#2A5BE8 0%,#1D4ED8 60%,#143797 100%);color:#fff;padding:13px 28px;border-radius:9999px;text-decoration:none;font-weight:600;font-size:14px">${escHtml(label)}</a></p>`;
}
function mutedP(text) { return `<p style="margin:0 0 12px;color:#94a3b8;font-size:13px;line-height:1.6">${escHtml(text)}</p>`; }
function absolute(link) { return /^https?:\/\//.test(link) ? link : APP_URL() + (link.startsWith('/') ? link : '/' + link); }

// ── Specific templates ─────────────────────────────────────────────────

function emailVerify({ displayName, verifyUrl }) {
  const subject = 'Подтвердите email · CHM Finance';
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fff;letter-spacing:-.015em">Подтвердите адрес почты</h2>
    <p style="margin:0 0 16px">Привет${displayName ? ', ' + escHtml(displayName) : ''}! Чтобы защитить аккаунт и иметь возможность восстанавливать пароль, подтвердите email. Ссылка действует 24 часа.</p>
    ${cta('Подтвердить email →', verifyUrl)}
    ${mutedP('Если кнопка не работает, скопируйте ссылку в адресную строку:')}
    <p style="margin:0 0 14px;font-family:monospace;font-size:12px;word-break:break-all;color:#5C80E3">${escHtml(verifyUrl)}</p>
    ${mutedP('Если вы не регистрировались — просто проигнорируйте это письмо.')}
  `, { preheader: 'Подтвердите email для вашего аккаунта CHM Finance' });
  return { subject, html, text: toPlaintext(html) };
}

function passwordReset({ displayName, resetUrl, ipAddress }) {
  const subject = 'Сброс пароля · CHM Finance';
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fff;letter-spacing:-.015em">Сброс пароля</h2>
    <p style="margin:0 0 16px">Привет${displayName ? ', ' + escHtml(displayName) : ''}. По вашему запросу можно установить новый пароль. Ссылка действительна 1 час.</p>
    ${cta('Задать новый пароль →', resetUrl)}
    ${ipAddress ? mutedP('Запрос пришёл с IP ' + ipAddress + '.') : ''}
    ${mutedP('Если вы не запрашивали сброс — проигнорируйте письмо, пароль не изменится. Если таких писем много — возможно, кто-то пытается войти. Срочно включите 2FA в настройках.')}
  `, { preheader: 'Ссылка для сброса пароля CHM Finance' });
  return { subject, html, text: toPlaintext(html) };
}

function paymentConfirmed({ displayName, plan, amountUsd, expiresAt }) {
  const subject = 'Оплата получена · ' + plan.toUpperCase();
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fff;letter-spacing:-.015em">✓ Оплата получена</h2>
    <p style="margin:0 0 16px">Привет${displayName ? ', ' + escHtml(displayName) : ''}! Подписка <strong style="color:#5C80E3">${escHtml(plan.toUpperCase())}</strong> активна.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d0d11;border:1px solid #1e1e24;border-radius:10px;margin:14px 0"><tr><td style="padding:18px 20px">
      <div style="font-size:11px;color:#64748b;letter-spacing:.12em;text-transform:uppercase;margin-bottom:6px">Детали</div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">План</span><span style="color:#fff;font-weight:600">${escHtml(plan.toUpperCase())}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">Сумма</span><span style="color:#fff;font-family:monospace">$${Number(amountUsd).toFixed(2)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">Действует до</span><span style="color:#fff">${expiresAt ? escHtml(new Date(expiresAt).toLocaleDateString('ru-RU')) : '—'}</span></div>
    </td></tr></table>
    ${cta('Открыть дашборд →', APP_URL() + '/dashboard.html')}
    ${mutedP('Подписка продлевается автоматически. Отключить авто-продление и посмотреть квитанции можно в Настройках → Подписка.')}
  `, { preheader: 'Подписка ' + plan.toUpperCase() + ' активирована' });
  return { subject, html, text: toPlaintext(html) };
}

function paymentRefunded({ displayName, amountUsd, reason }) {
  const subject = 'Возврат платежа · CHM Finance';
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fff;letter-spacing:-.015em">Возврат оформлен</h2>
    <p style="margin:0 0 16px">Привет${displayName ? ', ' + escHtml(displayName) : ''}. Мы оформили возврат $${Number(amountUsd).toFixed(2)}. Деньги вернутся на тот же способ оплаты в течение 3–10 рабочих дней.</p>
    ${reason ? `<p style="margin:0 0 16px;padding:12px 14px;background:#0d0d11;border-left:3px solid #ef4444;border-radius:4px;font-size:13px;color:#cbd5e1"><strong>Причина:</strong> ${escHtml(reason)}</p>` : ''}
    ${mutedP('Подписка переведена на Free-план, если не было других оплаченных платежей. Боты сверх бесплатного лимита автоматически остановлены.')}
    ${cta('Открыть настройки →', APP_URL() + '/settings.html')}
  `, { preheader: 'Возврат платежа оформлен' });
  return { subject, html, text: toPlaintext(html) };
}

function securityAlert({ displayName, title, message, link, ipAddress }) {
  const subject = '🚨 ' + title + ' · CHM Finance';
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fca5a5;letter-spacing:-.015em">⚠ ${escHtml(title)}</h2>
    ${displayName ? mutedP('Привет, ' + displayName + '.') : ''}
    <p style="margin:0 0 16px;padding:14px 16px;background:#0d0d11;border:1px solid rgba(239,68,68,.25);border-radius:10px;font-size:13px;color:#fff;line-height:1.65">${escHtml(message)}</p>
    ${ipAddress ? mutedP('IP: ' + ipAddress) : ''}
    ${link ? cta('Посмотреть подробности →', absolute(link)) : ''}
    ${mutedP('Если это не вы — немедленно смените пароль и включите 2FA, а также отзовите все активные сессии в Настройках → Безопасность.')}
  `, { preheader: 'Событие безопасности в вашем аккаунте' });
  return { subject, html, text: toPlaintext(html) };
}

function tradeClosed({ displayName, symbol, side, pnlPct, pnlUsd, result }) {
  const win = Number(pnlUsd) > 0;
  const subject = (win ? '✓ ' : '✗ ') + symbol + ' ' + side.toUpperCase() + ' · ' + (Number(pnlPct) >= 0 ? '+' : '') + Number(pnlPct).toFixed(2) + '%';
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:18px;font-weight:600;color:${win ? '#4ade80' : '#f87171'};letter-spacing:-.015em">${win ? 'Сделка закрыта с профитом' : 'Сделка закрыта в минус'}</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d0d11;border:1px solid #1e1e24;border-radius:10px;margin:14px 0"><tr><td style="padding:18px 20px">
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">Пара</span><span style="color:#fff;font-weight:600">${escHtml(symbol)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">Сторона</span><span style="color:${side === 'long' ? '#4ade80' : '#f87171'}">${escHtml(side.toUpperCase())}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">Результат</span><span style="color:#fff">${escHtml(result || '—')}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px"><span style="color:#94a3b8">P&amp;L</span><span style="color:${win ? '#4ade80' : '#f87171'};font-family:monospace">${Number(pnlUsd) >= 0 ? '+' : ''}$${Number(pnlUsd).toFixed(2)} (${Number(pnlPct).toFixed(2)}%)</span></div>
    </td></tr></table>
    ${cta('Открыть дашборд →', APP_URL() + '/dashboard.html')}
  `, { preheader: symbol + ' ' + side + ' закрыта с ' + (win ? 'профитом' : 'убытком') });
  return { subject, html, text: toPlaintext(html) };
}

function signalFired({ displayName, symbol, side, strategy, entry, tp, sl }) {
  const subject = '📡 ' + symbol + ' ' + side.toUpperCase() + ' · ' + strategy;
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:18px;font-weight:600;color:#fff;letter-spacing:-.015em">Новый сигнал</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0d0d11;border:1px solid #1e1e24;border-radius:10px;margin:14px 0"><tr><td style="padding:18px 20px;font-family:monospace;font-size:13px">
      <div style="color:#94a3b8;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px;font-family:-apple-system,sans-serif">${escHtml(strategy)}</div>
      <div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:#94a3b8">Pair</span><span style="color:#fff">${escHtml(symbol)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:#94a3b8">Side</span><span style="color:${side === 'long' ? '#4ade80' : '#f87171'}">${escHtml(side.toUpperCase())}</span></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:#94a3b8">Entry</span><span style="color:#fff">${escHtml(entry)}</span></div>
      ${tp ? `<div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:#94a3b8">TP</span><span style="color:#4ade80">${escHtml(tp)}</span></div>` : ''}
      ${sl ? `<div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:#94a3b8">SL</span><span style="color:#f87171">${escHtml(sl)}</span></div>` : ''}
    </td></tr></table>
    ${cta('Открыть дашборд →', APP_URL() + '/dashboard.html')}
    ${mutedP('Сигнал сгенерирован автоматически и не является инвестиционной рекомендацией. Торговля крипто-деривативами — высокий риск. См. Risk disclosure.')}
  `, { preheader: 'Новый торговый сигнал ' + symbol });
  return { subject, html, text: toPlaintext(html) };
}

/** Generic fallback — used by notifier for any `type` not matched above. */
function generic({ title, body, link }) {
  const subject = title;
  const html = shell(subject, `
    <h2 style="margin:0 0 14px;font-size:20px;font-weight:600;color:#fff;letter-spacing:-.015em">${escHtml(title)}</h2>
    ${body ? `<p style="margin:0 0 16px">${escHtml(body)}</p>` : ''}
    ${link ? cta('Открыть →', absolute(link)) : ''}
  `);
  return { subject, html, text: toPlaintext(html) };
}

module.exports = {
  emailVerify, passwordReset,
  paymentConfirmed, paymentRefunded,
  securityAlert, tradeClosed, signalFired,
  generic,
  _toPlaintext: toPlaintext, _shell: shell,
};
